//! Fixed scripts the host evals into a browser panel. The plugin cannot pass JavaScript.
//! A reply is one loopback post for an id this process just created.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{oneshot, Mutex};

use crate::panel_lock;
use crate::plugin_grant::{self, ReadPath};

pub const REMOTE_TAB: &str = "a remote page in a browser tab cannot be scripted";
pub const CROSS_ORIGIN_FRAME: &str = "a cross-origin frame inside that page cannot be scripted";

#[derive(Clone)]
pub struct Mailbox {
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
}

impl Default for Mailbox {
    fn default() -> Self {
        Self::new()
    }
}

impl Mailbox {
    pub fn new() -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn open(&self) -> (String, oneshot::Receiver<Value>) {
        let id = fresh_id();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);
        (id, rx)
    }

    /// The first post for an id wins. A second post, or an unknown id, is ignored.
    pub async fn finish(&self, id: &str, body: Value) -> bool {
        let Some(tx) = self.pending.lock().await.remove(id) else {
            return false;
        };
        tx.send(body).is_ok()
    }

    pub async fn cancel(&self, id: &str) {
        self.pending.lock().await.remove(id);
    }
}

pub async fn ask(
    mailbox: &Mailbox,
    port: u16,
    session: &str,
    panel_id: &str,
    call: &DriveCall,
    viewers: usize,
    publish: impl Fn(&Value),
) -> Result<Value, String> {
    if viewers == 0 {
        return Err("the desk is not open".into());
    }
    let (id, rx) = mailbox.open().await;
    let reply = format!("http://127.0.0.1:{port}/api/browser-reply");
    let script = drive_script(&reply, &id, call);
    publish(&json!({
        "type": "browser-drive",
        "session": session,
        "requestId": id,
        "panelId": panel_id,
        "op": call.op,
        "script": script,
        "selector": call.selector,
        "text": call.text,
        "value": call.value,
        "key": call.key,
        "dx": call.dx,
        "dy": call.dy,
        "timeoutMs": call.timeout_ms,
        "reply": reply,
    }));
    let limit = call.timeout_ms.saturating_add(2000).clamp(2_000, 35_000);
    let result = wait_reply(rx, Duration::from_millis(limit)).await;
    if result.is_err() {
        mailbox.cancel(&id).await;
    }
    result
}

pub async fn wait_reply(rx: oneshot::Receiver<Value>, timeout: Duration) -> Result<Value, String> {
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_)) => Err("the browser reply was dropped".into()),
        Err(_) => Err("the browser panel did not answer in time".into()),
    }
}

pub fn png_bytes(body: &Value) -> Result<Option<Vec<u8>>, String> {
    let Some(encoded) = body
        .get("png")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let bytes = decode_base64(encoded).map_err(|_| "the screenshot is not a PNG".to_string())?;
    if bytes.len() < 8 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("the screenshot is not a PNG".into());
    }
    Ok(Some(bytes))
}

fn decode_base64(input: &str) -> Result<Vec<u8>, ()> {
    let cleaned: String = input.chars().filter(|ch| !ch.is_whitespace()).collect();
    if cleaned.len() % 4 == 1 {
        return Err(());
    }
    fn val(byte: u8) -> Result<u8, ()> {
        match byte {
            b'A'..=b'Z' => Ok(byte - b'A'),
            b'a'..=b'z' => Ok(byte - b'a' + 26),
            b'0'..=b'9' => Ok(byte - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(()),
        }
    }
    let bytes = cleaned.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    let mut index = 0;
    while index < bytes.len() {
        let remaining = bytes.len() - index;
        if remaining < 2 {
            return Err(());
        }
        let a = val(bytes[index])?;
        let b = val(bytes[index + 1])?;
        let c = if remaining > 2 && bytes[index + 2] != b'=' {
            Some(val(bytes[index + 2])?)
        } else {
            None
        };
        let d = if remaining > 3 && bytes[index + 3] != b'=' {
            Some(val(bytes[index + 3])?)
        } else {
            None
        };
        out.push((a << 2) | (b >> 4));
        if let Some(c) = c {
            out.push((b << 4) | (c >> 2));
            if let Some(d) = d {
                out.push((c << 6) | d);
            }
        }
        index += 4;
    }
    Ok(out)
}

#[derive(Debug, Clone)]
pub struct DriveCall {
    pub op: String,
    pub selector: Option<String>,
    pub text: Option<String>,
    pub value: Option<String>,
    pub key: Option<String>,
    pub dx: f64,
    pub dy: f64,
    pub timeout_ms: u64,
    pub url: Option<String>,
}

/// One JSON value, so a selector or a fill string cannot become script.
pub fn drive_script(reply_url: &str, id: &str, call: &DriveCall) -> String {
    let spec = json!({
        "id": id,
        "reply": reply_url,
        "op": call.op,
        "selector": call.selector,
        "text": call.text,
        "value": call.value,
        "key": call.key,
        "dx": call.dx,
        "dy": call.dy,
        "timeoutMs": call.timeout_ms,
        "url": call.url,
    });
    format!("window.__hwpDrive({spec})")
}

pub fn shot_path_for_plugin(
    grants: &[std::path::PathBuf],
    requested: &str,
) -> Result<std::path::PathBuf, String> {
    if requested.trim().is_empty() {
        return Err("a screenshot file needs a directory from the files list".into());
    }
    match plugin_grant::resolve_read(grants, requested) {
        Ok(ReadPath::File(path) | ReadPath::Missing(path)) => Ok(path),
        Err("outside") => Err("the screenshot path is outside the granted files".into()),
        Err("not_a_file") => Err("the screenshot path is a directory".into()),
        Err(_) => Err("the screenshot path is invalid".into()),
    }
}

pub fn agent_shot_path(requested: &str, config_dir: &Path) -> Result<std::path::PathBuf, String> {
    let requested = requested.trim();
    if requested.is_empty() {
        return Err("png path is required".into());
    }
    let path = Path::new(requested);
    if !path.is_absolute() {
        return Err("png path must be absolute".into());
    }
    panel_lock::refuse_protected_file(path, config_dir).map_err(str::to_string)?;
    Ok(path.to_path_buf())
}

fn fresh_id() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        let seed = std::process::id().to_ne_bytes();
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = seed[index % seed.len()];
        }
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_script_is_json_and_a_second_reply_is_ignored() {
        let call = DriveCall {
            op: "fill".into(),
            selector: Some("input[name=\"q\"]".into()),
            text: None,
            value: Some("a</script>".into()),
            key: None,
            dx: 0.0,
            dy: 0.0,
            timeout_ms: 1000,
            url: None,
        };
        let script = drive_script("http://127.0.0.1:4737/api/browser-reply", "abc", &call);
        assert!(script.starts_with("window.__hwpDrive("));
        assert!(script.contains("a</script>"));
        assert!(!script.contains("a</script><script>"));
        let parsed: Value = serde_json::from_str(
            script
                .trim_start_matches("window.__hwpDrive(")
                .trim_end_matches(')'),
        )
        .unwrap();
        assert_eq!(parsed["value"], "a</script>");
        assert_eq!(parsed["selector"], "input[name=\"q\"]");

        let mailbox = Mailbox::new();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let (id, rx) = mailbox.open().await;
            assert!(mailbox.finish(&id, json!({"text": "Hi"})).await);
            assert!(!mailbox.finish(&id, json!({"text": "again"})).await);
            assert!(!mailbox.finish("nope", json!({})).await);
            let body = rx.await.unwrap();
            assert_eq!(body["text"], "Hi");
        });
    }

    #[test]
    fn a_plugin_png_stays_inside_a_granted_directory() {
        let root = std::env::temp_dir().join("herdr-shots-grant");
        let file = root.join("card.png");
        let grants = vec![root.clone()];
        let ok = shot_path_for_plugin(&grants, &file.display().to_string()).unwrap();
        assert_eq!(ok, file);
        let other = std::env::temp_dir()
            .join("herdr-shots-other")
            .join("card.png");
        assert!(shot_path_for_plugin(&grants, &other.display().to_string()).is_err());
        assert!(shot_path_for_plugin(&[], &file.display().to_string()).is_err());
    }
}
