use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::herdr::HerdrClient;
use crate::keys::{is_terminal_key, map_key, ClientInput, KeyAction};
use crate::layout::{is_pane_id, HerdrSource};
use crate::server::AppState;
use crate::session::PaneView;

pub async fn drive(
    state: AppState,
    pane_id: String,
    _source: String,
    _lines: Option<u32>,
    socket: WebSocket,
) {
    let Some(viewer) = state.controls.retain(&pane_id).await else {
        return;
    };
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<String>(32);
    let mut frames = state.controls.subscribe(&pane_id).await;
    let mut roles = state.controls.subscribe_roles(&pane_id).await;
    let backlog = state.controls.backlog(&pane_id).await;
    let mut seen_generation = 0u64;
    let mut seen_seq = 0u64;
    let mut frames_closed = false;
    let mut paused = false;
    let poller = {
        let state = state.clone();
        let pane_id = pane_id.clone();
        tokio::spawn(async move {
            poll_loop(state, pane_id, tx).await;
        })
    };
    if send_frames(&mut sink, &backlog, &mut seen_generation, &mut seen_seq)
        .await
        .is_err()
    {
        poller.abort();
        state.controls.release(&pane_id, viewer).await;
        return;
    }

    loop {
        tokio::select! {
            outgoing = rx.recv() => {
                let Some(text) = outgoing else { break };
                if paused {
                    continue;
                }
                if sink.send(Message::Text(text.into())).await.is_err() {
                    break;
                }
            }
            role = roles.recv() => {
                match role {
                    Ok(note) if note.viewer == viewer => {
                        let payload = role_message(note.own);
                        if sink.send(Message::Text(payload.into())).await.is_err() {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let own = state.controls.allows_resize(&pane_id, viewer).await;
                        let payload = role_message(own);
                        if sink.send(Message::Text(payload.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            frame = async {
                if paused || frames_closed {
                    std::future::pending().await
                } else {
                    frames.recv().await
                }
            } => {
                match frame {
                    Ok(frame) => {
                        if frame.generation < seen_generation
                            || (frame.generation == seen_generation && frame.seq <= seen_seq)
                        {
                            continue;
                        }
                        seen_generation = frame.generation;
                        seen_seq = frame.seq;
                        if sink.send(Message::Text(frame.body.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => frames_closed = true,
                }
            }
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        match handle_client(&state, &pane_id, viewer, text.as_ref()).await {
                            Ok(Outcome::None) => {}
                            Ok(Outcome::Text(notice)) => {
                                if sink.send(Message::Text(notice.into())).await.is_err() {
                                    break;
                                }
                            }
                            Ok(Outcome::Paused(idle)) => {
                                paused = idle;
                                if !idle {
                                    let caught_up = state.controls.backlog(&pane_id).await;
                                    if send_frames(
                                        &mut sink,
                                        &caught_up,
                                        &mut seen_generation,
                                        &mut seen_seq,
                                    )
                                    .await
                                    .is_err()
                                    {
                                        break;
                                    }
                                }
                            }
                            Err(fault) => {
                                let payload = json!({
                                    "type": fault.kind(),
                                    "message": fault.message(),
                                })
                                .to_string();
                                if sink.send(Message::Text(payload.into())).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if sink.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                }
            }
        }
    }
    poller.abort();
    state.controls.release(&pane_id, viewer).await;
}

async fn send_frames(
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    frames: &[crate::terminal_size::LiveFrame],
    seen_generation: &mut u64,
    seen_seq: &mut u64,
) -> Result<(), ()> {
    for frame in frames {
        *seen_generation = frame.generation;
        *seen_seq = frame.seq;
        if sink.send(Message::Text(frame.body.clone().into())).await.is_err() {
            return Err(());
        }
    }
    Ok(())
}

fn role_message(own: bool) -> String {
    json!({
        "type": "terminalRole",
        "role": if own { "own" } else { "watch" },
    })
    .to_string()
}

enum Outcome {
    None,
    Text(String),
    /// True while this view is hidden and should not be sent frames.
    Paused(bool),
}

async fn handle_client(
    state: &AppState,
    pane_id: &str,
    viewer: u64,
    text: &str,
) -> Result<Outcome, Fault> {
    let value: Value = serde_json::from_str(text).map_err(|err| Fault::Input(err.to_string()))?;
    let kind = value.get("type").and_then(Value::as_str);
    if kind == Some("presence") {
        let active = value
            .get("active")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        state.controls.set_presence(pane_id, viewer, active).await;
        return Ok(Outcome::Paused(!active));
    }
    if kind == Some("claim") {
        state.controls.claim(pane_id, viewer).await;
        return Ok(Outcome::None);
    }
    if kind == Some("resize") {
        if !state.controls.allows_resize(pane_id, viewer).await {
            return Ok(Outcome::Text(role_message(false)));
        }
        let cols =
            dimension(&value, "cols").ok_or_else(|| Fault::Size("cols must be a number".into()))?;
        let rows =
            dimension(&value, "rows").ok_or_else(|| Fault::Size("rows must be a number".into()))?;
        state
            .controls
            .fit(pane_id, cols, rows)
            .await
            .map_err(Fault::Size)?;
        return Ok(Outcome::Text(
            json!({"type": "resized", "cols": cols, "rows": rows}).to_string(),
        ));
    }
    if kind == Some("scroll") {
        state.controls.claim(pane_id, viewer).await;
        let direction = value.get("direction").and_then(Value::as_str).unwrap_or("");
        let source = value
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("wheel");
        let lines = dimension(&value, "lines")
            .ok_or_else(|| Fault::Size("lines must be a number".into()))?;
        state
            .controls
            .scroll(pane_id, direction, lines, source)
            .await
            .map_err(Fault::Size)?;
        return Ok(Outcome::None);
    }
    if kind == Some("mouse") {
        let action = value.get("action").and_then(Value::as_str).unwrap_or("");
        if action != "move" {
            state.controls.claim(pane_id, viewer).await;
        }
        let button = value
            .get("button")
            .and_then(Value::as_str)
            .unwrap_or("left");
        let column = dimension(&value, "column")
            .ok_or_else(|| Fault::Size("column must be a number".into()))?;
        let row =
            dimension(&value, "row").ok_or_else(|| Fault::Size("row must be a number".into()))?;
        let modifiers = value
            .get("modifiers")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(255) as u8;
        state
            .controls
            .mouse(pane_id, action, button, column, row, modifiers)
            .await
            .map_err(Fault::Size)?;
        return Ok(Outcome::None);
    }
    if matches!(kind, Some("key" | "text" | "keys")) {
        state.controls.claim(pane_id, viewer).await;
    }
    let client = state.runtime.client().clone();
    apply_text(&client, pane_id, text)
        .await
        .map_err(Fault::Input)?;
    Ok(Outcome::None)
}

enum Fault {
    Size(String),
    Input(String),
}

impl Fault {
    fn kind(&self) -> &'static str {
        match self {
            Fault::Size(_) => "sizeError",
            Fault::Input(_) => "inputError",
        }
    }

    fn message(&self) -> &str {
        match self {
            Fault::Size(message) | Fault::Input(message) => message,
        }
    }
}

fn dimension(value: &Value, key: &str) -> Option<u16> {
    let number = value.get(key)?;
    let raw = number.as_u64().or_else(|| {
        number
            .as_f64()
            .and_then(|value| (value.is_finite() && value >= 0.0).then_some(value.floor() as u64))
    })?;
    u16::try_from(raw).ok()
}

async fn poll_loop(state: AppState, pane_id: String, tx: mpsc::Sender<String>) {
    let mut ticker = tokio::time::interval(Duration::from_millis(150));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_meta = String::new();

    loop {
        ticker.tick().await;
        let runtime = state.runtime.snapshot().await;
        let pane = runtime
            .panes
            .iter()
            .find(|pane| pane.pane_id == pane_id)
            .cloned();
        let meta = meta_signature(pane.as_ref());
        if meta != last_meta {
            last_meta = meta;
            if tx
                .send(meta_message(pane.as_ref(), runtime.connected))
                .await
                .is_err()
            {
                return;
            }
        }
    }
}

fn meta_signature(pane: Option<&PaneView>) -> String {
    match pane {
        Some(pane) => format!(
            "{}|{}|{}|{}|{}|{}|{}",
            pane.agent_status,
            pane.agent.as_deref().unwrap_or(""),
            pane.agent_name.as_deref().unwrap_or(""),
            pane.title.as_deref().unwrap_or(""),
            pane.label.as_deref().unwrap_or(""),
            pane.cwd.as_deref().unwrap_or(""),
            pane.focused
        ),
        None => "missing".into(),
    }
}

fn meta_message(pane: Option<&PaneView>, connected: bool) -> String {
    match pane {
        Some(pane) => json!({
            "type": "meta",
            "connected": connected,
            "present": true,
            "paneId": pane.pane_id,
            "agentStatus": pane.agent_status,
            "agent": pane.agent,
            "agentName": pane.agent_name,
            "title": pane.title,
            "label": pane.label,
            "cwd": pane.cwd,
            "focused": pane.focused,
            "cols": pane.cols,
            "rows": pane.rows,
        })
        .to_string(),
        None => json!({
            "type": "meta",
            "connected": connected,
            "present": false,
        })
        .to_string(),
    }
}

pub async fn apply_text(client: &HerdrClient, pane_id: &str, text: &str) -> Result<(), String> {
    if !is_pane_id(pane_id) {
        return Err("invalid pane id".into());
    }
    let input: ClientInput = serde_json::from_str(text).map_err(|err| err.to_string())?;
    dispatch(client, pane_id, input).await
}

pub async fn dispatch(
    client: &HerdrClient,
    pane_id: &str,
    input: ClientInput,
) -> Result<(), String> {
    match input {
        ClientInput::Text { text } => send_text(client, pane_id, &text).await,
        ClientInput::Keys { keys } => send_keys(client, pane_id, &keys).await,
        ClientInput::Key {
            key,
            ctrl,
            alt,
            shift,
            meta,
        } => match map_key(&key, ctrl, alt, shift, meta) {
            KeyAction::Ignore => Ok(()),
            KeyAction::Text(text) => send_text(client, pane_id, &text).await,
            KeyAction::Keys(keys) => send_keys(client, pane_id, &keys).await,
        },
    }
}

async fn send_text(client: &HerdrClient, pane_id: &str, text: &str) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }
    if text.len() > 16_000 {
        return Err("input is too large".into());
    }
    client
        .send_text(pane_id, text)
        .await
        .map_err(|err| err.to_string())
}

async fn send_keys(client: &HerdrClient, pane_id: &str, keys: &[String]) -> Result<(), String> {
    if keys.is_empty() {
        return Ok(());
    }
    if keys.len() > 8 || keys.iter().any(|key| !is_terminal_key(key)) {
        return Err("unsupported key".into());
    }
    client
        .send_keys(pane_id, keys)
        .await
        .map_err(|err| err.to_string())
}

pub fn screen_source(source: Option<&str>) -> Result<&'static str, String> {
    match source.unwrap_or("visible") {
        "visible" => Ok(HerdrSource::Visible.as_api()),
        "recent" => Ok(HerdrSource::Recent.as_api()),
        _ => Err("source must be visible or recent".into()),
    }
}
