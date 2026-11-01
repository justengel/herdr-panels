use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::paths::transport_name;

#[derive(Debug, Error)]
pub enum HerdrError {
    #[error("Herdr is not reachable ({0})")]
    Offline(String),
    #[error("timed out waiting for Herdr")]
    Timeout,
    #[error("{message}")]
    Api { code: String, message: String },
    #[error("protocol error: {0}")]
    Protocol(String),
}

#[derive(Clone)]
pub struct HerdrClient {
    target: Arc<std::sync::Mutex<Target>>,
    ids: Arc<AtomicU64>,
}

struct Target {
    logical_socket: String,
    transport: String,
}

#[derive(Debug, Clone)]
pub struct PaneScreen {
    pub text: String,
    pub truncated: bool,
    pub revision: u64,
}

/// Lines above the live screen, and how far that scrollback goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScrollMetrics {
    pub offset_from_bottom: u64,
    pub max_offset_from_bottom: u64,
    pub viewport_rows: u64,
}

impl HerdrClient {
    pub fn new(logical_socket: PathBuf) -> Self {
        Self {
            target: Arc::new(std::sync::Mutex::new(target_for(logical_socket))),
            ids: Arc::new(AtomicU64::new(1)),
        }
    }

    pub fn retarget(&self, logical_socket: PathBuf) {
        if let Ok(mut target) = self.target.lock() {
            *target = target_for(logical_socket);
        }
    }

    pub fn logical_socket(&self) -> String {
        self.target
            .lock()
            .map(|target| target.logical_socket.clone())
            .unwrap_or_default()
    }

    fn transport(&self) -> String {
        self.target
            .lock()
            .map(|target| target.transport.clone())
            .unwrap_or_default()
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value, HerdrError> {
        if !params.is_object() {
            return Err(HerdrError::Protocol("params must be a JSON object".into()));
        }
        let id = self.ids.fetch_add(1, Ordering::Relaxed);
        let line = serde_json::to_string(&json!({
            "id": format!("hwp-{id}"),
            "method": method,
            "params": params,
        }))
        .map_err(|err| HerdrError::Protocol(err.to_string()))?;

        let response = tokio::time::timeout(Duration::from_secs(4), self.roundtrip(&line))
            .await
            .map_err(|_| HerdrError::Timeout)??;
        let value: Value = serde_json::from_str(response.trim())
            .map_err(|err| HerdrError::Protocol(err.to_string()))?;
        if let Some(error) = value.get("error") {
            return Err(HerdrError::Api {
                code: error
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("error")
                    .to_string(),
                message: error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("request failed")
                    .to_string(),
            });
        }
        value
            .get("result")
            .cloned()
            .ok_or_else(|| HerdrError::Protocol("response has no result".into()))
    }

    pub async fn read_pane(
        &self,
        pane_id: &str,
        source: &str,
        lines: Option<u32>,
    ) -> Result<PaneScreen, HerdrError> {
        let mut params = json!({
            "pane_id": pane_id,
            "source": source,
            "format": "ansi",
            "strip_ansi": false,
        });
        if let Some(lines) = lines {
            params["lines"] = json!(lines);
        }
        let result = self.call("pane.read", params).await?;
        let read = result.get("read").cloned().unwrap_or(Value::Null);
        Ok(PaneScreen {
            text: read
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            truncated: read
                .get("truncated")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            revision: read.get("revision").and_then(Value::as_u64).unwrap_or(0),
        })
    }

    pub async fn send_text(&self, pane_id: &str, text: &str) -> Result<(), HerdrError> {
        self.call("pane.send_text", json!({"pane_id": pane_id, "text": text}))
            .await
            .map(|_| ())
    }

    pub async fn scroll_metrics(&self, pane_id: &str) -> Result<Option<ScrollMetrics>, HerdrError> {
        let result = self.call("pane.get", json!({ "pane_id": pane_id })).await?;
        Ok(parse_scroll_metrics(&result))
    }

    pub async fn send_keys(&self, pane_id: &str, keys: &[String]) -> Result<(), HerdrError> {
        self.call("pane.send_keys", json!({"pane_id": pane_id, "keys": keys}))
            .await
            .map(|_| ())
    }

    pub async fn split_pane(&self, pane_id: &str, direction: &str) -> Result<String, HerdrError> {
        let result = self
            .call(
                "pane.split",
                json!({
                    "target_pane_id": pane_id,
                    "direction": direction,
                    "ratio": 0.5,
                    "focus": false,
                }),
            )
            .await?;
        result
            .pointer("/pane/pane_id")
            .and_then(Value::as_str)
            .or_else(|| result.get("pane_id").and_then(Value::as_str))
            .map(str::to_string)
            .ok_or_else(|| HerdrError::Protocol("split response did not include a pane id".into()))
    }

    async fn roundtrip(&self, line: &str) -> Result<String, HerdrError> {
        let stream = connect(&self.transport()).await?;
        exchange(stream, line).await
    }
}

/// `pane.get` returns this on `result.pane.scroll`. Offset is clamped to the length.
pub fn parse_scroll_metrics(result: &Value) -> Option<ScrollMetrics> {
    let scroll = result.pointer("/pane/scroll")?;
    let max_offset_from_bottom = scroll.get("max_offset_from_bottom")?.as_u64()?;
    let offset_from_bottom = scroll
        .get("offset_from_bottom")?
        .as_u64()?
        .min(max_offset_from_bottom);
    let viewport_rows = scroll
        .get("viewport_rows")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    Some(ScrollMetrics {
        offset_from_bottom,
        max_offset_from_bottom,
        viewport_rows,
    })
}

pub fn scroll_metrics_message(metrics: ScrollMetrics) -> String {
    json!({
        "type": "scrollMetrics",
        "offset": metrics.offset_from_bottom,
        "max": metrics.max_offset_from_bottom,
        "rows": metrics.viewport_rows,
    })
    .to_string()
}

fn target_for(logical_socket: PathBuf) -> Target {
    let transport = transport_name(&logical_socket);
    Target {
        logical_socket: logical_socket.display().to_string(),
        transport,
    }
}

async fn exchange<S>(mut stream: S, line: &str) -> Result<String, HerdrError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    stream
        .write_all(line.as_bytes())
        .await
        .map_err(classify_io)?;
    stream.write_all(b"\n").await.map_err(classify_io)?;
    stream.flush().await.map_err(classify_io)?;
    let mut reader = BufReader::new(stream);
    let mut buf = String::new();
    let read = reader.read_line(&mut buf).await.map_err(classify_io)?;
    if read == 0 {
        return Err(HerdrError::Offline(
            "connection closed before a response".into(),
        ));
    }
    Ok(buf)
}

#[cfg(windows)]
async fn connect(
    transport: &str,
) -> Result<tokio::net::windows::named_pipe::NamedPipeClient, HerdrError> {
    use tokio::net::windows::named_pipe::ClientOptions;

    let mut last = None;
    for _ in 0..25 {
        match ClientOptions::new().open(transport) {
            Ok(client) => return Ok(client),
            Err(err) if err.raw_os_error() == Some(231) => {
                last = Some(err);
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(err) => return Err(classify_io(err)),
        }
    }
    Err(classify_io(last.unwrap_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::TimedOut, "named pipe is busy")
    })))
}

#[cfg(unix)]
async fn connect(transport: &str) -> Result<tokio::net::UnixStream, HerdrError> {
    tokio::net::UnixStream::connect(transport)
        .await
        .map_err(classify_io)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn reads_scroll_metrics_from_pane_get() {
        let raw = r#"{"type":"pane_info","pane":{"pane_id":"w1:p1","scroll":{"offset_from_bottom":12,"max_offset_from_bottom":240,"viewport_rows":30}}}"#;
        let value: Value = serde_json::from_str(raw).unwrap();
        let metrics = parse_scroll_metrics(&value).unwrap();
        assert_eq!(metrics.offset_from_bottom, 12);
        assert_eq!(metrics.max_offset_from_bottom, 240);
        assert_eq!(metrics.viewport_rows, 30);
        let message: Value = serde_json::from_str(&scroll_metrics_message(metrics)).unwrap();
        assert_eq!(message["type"], "scrollMetrics");
        assert_eq!(message["offset"], 12);
        assert_eq!(message["max"], 240);
        assert_eq!(message["rows"], 30);
    }

    #[test]
    fn missing_scroll_metrics_are_absent() {
        let value = json!({"type":"pane_info","pane":{"pane_id":"w1:p1"}});
        assert!(parse_scroll_metrics(&value).is_none());
    }

    #[test]
    fn scroll_offset_cannot_exceed_the_length() {
        let value = json!({
            "pane": {"scroll": {"offset_from_bottom": 50, "max_offset_from_bottom": 40, "viewport_rows": 10}}
        });
        let metrics = parse_scroll_metrics(&value).unwrap();
        assert_eq!(metrics.offset_from_bottom, 40);
        assert_eq!(metrics.max_offset_from_bottom, 40);
    }
}

fn classify_io(err: std::io::Error) -> HerdrError {
    let offline = matches!(
        err.kind(),
        std::io::ErrorKind::NotFound
            | std::io::ErrorKind::ConnectionRefused
            | std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::BrokenPipe
            | std::io::ErrorKind::TimedOut
    ) || matches!(err.raw_os_error(), Some(2 | 3 | 231 | 232 | 233));
    if offline {
        HerdrError::Offline(err.to_string())
    } else {
        HerdrError::Protocol(err.to_string())
    }
}
