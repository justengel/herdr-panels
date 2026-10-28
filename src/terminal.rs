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
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<String>(32);
    state.controls.retain(&pane_id).await;
    let mut frames = state.controls.subscribe(&pane_id).await;
    let backlog = state.controls.backlog(&pane_id).await;
    let mut seen_generation = 0u64;
    let mut seen_seq = 0u64;
    let mut frames_closed = false;
    let poller = {
        let state = state.clone();
        let pane_id = pane_id.clone();
        tokio::spawn(async move {
            poll_loop(state, pane_id, tx).await;
        })
    };
    for frame in backlog {
        seen_generation = frame.generation;
        seen_seq = frame.seq;
        if sink.send(Message::Text(frame.body.into())).await.is_err() {
            poller.abort();
            state.controls.release(&pane_id).await;
            return;
        }
    }

    loop {
        tokio::select! {
            outgoing = rx.recv() => {
                let Some(text) = outgoing else { break };
                if sink.send(Message::Text(text.into())).await.is_err() {
                    break;
                }
            }
            frame = async {
                if frames_closed {
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
                        match handle_client(&state, &pane_id, text.as_ref()).await {
                            Ok(Some(notice)) => {
                                if sink.send(Message::Text(notice.into())).await.is_err() {
                                    break;
                                }
                            }
                            Ok(None) => {}
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
    state.controls.release(&pane_id).await;
}

async fn handle_client(
    state: &AppState,
    pane_id: &str,
    text: &str,
) -> Result<Option<String>, Fault> {
    let value: Value = serde_json::from_str(text).map_err(|err| Fault::Input(err.to_string()))?;
    if value.get("type").and_then(Value::as_str) == Some("resize") {
        let cols =
            dimension(&value, "cols").ok_or_else(|| Fault::Size("cols must be a number".into()))?;
        let rows =
            dimension(&value, "rows").ok_or_else(|| Fault::Size("rows must be a number".into()))?;
        state
            .controls
            .fit(pane_id, cols, rows)
            .await
            .map_err(Fault::Size)?;
        return Ok(Some(
            json!({"type": "resized", "cols": cols, "rows": rows}).to_string(),
        ));
    }
    if value.get("type").and_then(Value::as_str) == Some("scroll") {
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
        return Ok(None);
    }
    if value.get("type").and_then(Value::as_str) == Some("mouse") {
        let action = value.get("action").and_then(Value::as_str).unwrap_or("");
        let button = value.get("button").and_then(Value::as_str).unwrap_or("left");
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
        return Ok(None);
    }
    let client = state.runtime.client().clone();
    apply_text(&client, pane_id, text)
        .await
        .map_err(Fault::Input)?;
    Ok(None)
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
