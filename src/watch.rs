use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tokio::sync::{broadcast, Mutex};

#[derive(Clone)]
pub struct WatchHub {
    tx: broadcast::Sender<PathBuf>,
    _watcher: Arc<Mutex<notify::RecommendedWatcher>>,
}

impl WatchHub {
    pub fn start(paths: &[PathBuf]) -> anyhow::Result<Self> {
        let (tx, _rx) = broadcast::channel(128);
        let emit = tx.clone();
        let mut watcher: RecommendedWatcher =
            notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
                if let Ok(event) = result {
                    for path in event.paths {
                        let _ = emit.send(path);
                    }
                }
            })?;
        for path in paths {
            if path.exists() {
                watcher.watch(path, RecursiveMode::Recursive)?;
            }
        }
        Ok(Self {
            tx,
            _watcher: Arc::new(Mutex::new(watcher)),
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<PathBuf> {
        self.tx.subscribe()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ContentEvent {
    r#type: &'static str,
    path: String,
    text: String,
    missing: bool,
}

pub async fn drive(
    config_dir: Arc<PathBuf>,
    roots: Vec<PathBuf>,
    path: String,
    socket: WebSocket,
    mut events: broadcast::Receiver<PathBuf>,
) {
    let (mut sink, mut stream) = socket.split();
    if let Err(message) = push_file(&config_dir, &roots, &path, &mut sink).await {
        let _ = send_text(
            &mut sink,
            serde_json::json!({"type": "error", "message": message}).to_string(),
        )
        .await;
    }
    loop {
        tokio::select! {
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Ping(payload))) => {
                        if sink.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                }
            }
            event = events.recv() => {
                match event {
                    Ok(changed) => {
                        if !event_matches(&config_dir, &roots, &path, &changed) {
                            continue;
                        }
                        tokio::time::sleep(Duration::from_millis(70)).await;
                        while events.try_recv().is_ok() {}
                        if push_file(&config_dir, &roots, &path, &mut sink).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        }
    }
}

fn event_matches(config_dir: &Path, roots: &[PathBuf], requested: &str, event: &Path) -> bool {
    let Ok(target) = crate::paths::resolve_content(config_dir, roots, requested) else {
        return false;
    };
    if event == target {
        return true;
    }
    match event.canonicalize() {
        Ok(canonical) => canonical == target || target.starts_with(&canonical),
        Err(_) => false,
    }
}

async fn push_file(
    config_dir: &Path,
    roots: &[PathBuf],
    requested: &str,
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
) -> Result<(), String> {
    let event = match crate::paths::resolve_content(config_dir, roots, requested) {
        Ok(path) => match tokio::fs::read(&path).await {
            Ok(bytes) if bytes.len() > 1_000_000 => {
                return send_text(
                    sink,
                    serde_json::json!({"type":"error","message":"file is larger than 1 MB"})
                        .to_string(),
                )
                .await
                .map_err(|_| "socket closed".to_string());
            }
            Ok(bytes) => ContentEvent {
                r#type: "content",
                path: requested.to_string(),
                text: String::from_utf8_lossy(&bytes).into_owned(),
                missing: false,
            },
            Err(_) => missing(requested),
        },
        Err(_) => missing(requested),
    };
    let payload = serde_json::to_string(&event).map_err(|err| err.to_string())?;
    send_text(sink, payload)
        .await
        .map_err(|_| "socket closed".to_string())
}

fn missing(path: &str) -> ContentEvent {
    ContentEvent {
        r#type: "content",
        path: path.to_string(),
        text: String::new(),
        missing: true,
    }
}

async fn send_text(
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    text: String,
) -> Result<(), axum::Error> {
    sink.send(Message::Text(text.into())).await
}
