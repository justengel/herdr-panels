use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{broadcast, mpsc, Mutex};

use crate::layout::is_pane_id;

/// Keeps a `herdr terminal session control` process for each pane a browser
/// is showing, and tells Herdr the column and row count that fits that panel.
#[derive(Clone)]
pub struct PaneControls {
    inner: Arc<Mutex<HashMap<String, Slot>>>,
    session: Arc<Mutex<Option<String>>>,
}

struct Slot {
    users: usize,
    applied_cols: u16,
    applied_rows: u16,
    want_cols: u16,
    want_rows: u16,
    spawning: bool,
    frames: broadcast::Sender<LiveFrame>,
    replay: Arc<Mutex<Replay>>,
    io: Option<Io>,
}

/// One decoded terminal frame, in the order Herdr produced it.
#[derive(Clone)]
pub struct LiveFrame {
    pub generation: u64,
    pub seq: u64,
    pub body: String,
}

struct Replay {
    generation: u64,
    next_seq: u64,
    anchored: bool,
    frames: VecDeque<StoredFrame>,
}

struct StoredFrame {
    seq: u64,
    body: String,
}

struct Io {
    tx: mpsc::Sender<String>,
    child: Child,
}

impl PaneControls {
    pub fn new(session: Option<String>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            session: Arc::new(Mutex::new(session)),
        }
    }

    pub async fn use_session(&self, session: Option<String>) {
        *self.session.lock().await = session;
        self.inner.lock().await.clear();
    }

    pub async fn retain(&self, pane_id: &str) {
        if !is_pane_id(pane_id) {
            return;
        }
        let mut map = self.inner.lock().await;
        map.entry(pane_id.to_string())
            .or_insert_with(empty_slot)
            .users += 1;
    }

    pub async fn subscribe(&self, pane_id: &str) -> broadcast::Receiver<LiveFrame> {
        let mut map = self.inner.lock().await;
        map.entry(pane_id.to_string())
            .or_insert_with(empty_slot)
            .frames
            .subscribe()
    }

    /// Frames a new viewer needs in order to show the screen it missed.
    /// Subscribe first, then read this, and skip live frames at or below the
    /// last sequence returned here.
    pub async fn backlog(&self, pane_id: &str) -> Vec<LiveFrame> {
        let map = self.inner.lock().await;
        let Some(slot) = map.get(pane_id) else {
            return Vec::new();
        };
        let replay = slot.replay.lock().await;
        replay
            .frames
            .iter()
            .map(|frame| LiveFrame {
                generation: replay.generation,
                seq: frame.seq,
                body: frame.body.clone(),
            })
            .collect()
    }

    pub async fn release(&self, pane_id: &str) {
        let mut map = self.inner.lock().await;
        let Some(slot) = map.get_mut(pane_id) else {
            return;
        };
        slot.users = slot.users.saturating_sub(1);
        if slot.users == 0 {
            map.remove(pane_id);
        }
    }

    pub async fn fit(&self, pane_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        if !is_pane_id(pane_id) {
            return Err("invalid pane id".into());
        }
        let cols = cols.clamp(MIN_COLS, MAX_COLS);
        let rows = rows.clamp(MIN_ROWS, MAX_ROWS);
        enum Step {
            Current(mpsc::Sender<String>),
            Spawn,
            Wait,
        }
        let step = {
            let mut map = self.inner.lock().await;
            let Some(slot) = map.get_mut(pane_id) else {
                return Ok(());
            };
            if slot.users == 0 {
                return Ok(());
            }
            slot.want_cols = cols;
            slot.want_rows = rows;
            if io_alive(slot) && slot.applied_cols == cols && slot.applied_rows == rows {
                return Ok(());
            }
            if io_alive(slot) {
                slot.applied_cols = cols;
                slot.applied_rows = rows;
                let Some(tx) = slot.io.as_ref().map(|io| io.tx.clone()) else {
                    return Ok(());
                };
                Step::Current(tx)
            } else if slot.spawning {
                Step::Wait
            } else {
                slot.spawning = true;
                Step::Spawn
            }
        };
        match step {
            Step::Current(tx) => match tx.send(resize_command(cols, rows)).await {
                Ok(()) => Ok(()),
                Err(_) => {
                    let mut map = self.inner.lock().await;
                    if let Some(slot) = map.get_mut(pane_id) {
                        slot.io = None;
                    }
                    Err("terminal size controller closed".into())
                }
            },
            Step::Spawn => self.spawn_into(pane_id, cols, rows).await,
            Step::Wait => Ok(()),
        }
    }

    async fn spawn_into(&self, pane_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let (frames, replay) = {
            let map = self.inner.lock().await;
            let Some(slot) = map.get(pane_id) else {
                return Err("terminal is not open".into());
            };
            (slot.frames.clone(), slot.replay.clone())
        };
        let generation = replay.lock().await.bump();
        let session = self.session.lock().await.clone();
        let spawned = spawn_control(
            session.as_deref(),
            pane_id,
            cols,
            rows,
            frames,
            replay,
            generation,
        )
        .await;
        let mut map = self.inner.lock().await;
        let Some(slot) = map.get_mut(pane_id) else {
            return spawned.map(|_| ());
        };
        slot.spawning = false;
        let io = match spawned {
            Ok(io) => io,
            Err(err) => return Err(err),
        };
        if slot.users == 0 {
            return Ok(());
        }
        let tx = io.tx.clone();
        slot.io = Some(io);
        slot.applied_cols = cols;
        slot.applied_rows = rows;
        if slot.want_cols != cols || slot.want_rows != rows {
            let want_cols = slot.want_cols;
            let want_rows = slot.want_rows;
            slot.applied_cols = want_cols;
            slot.applied_rows = want_rows;
            let _ = tx.try_send(resize_command(want_cols, want_rows));
        }
        Ok(())
    }
}

fn empty_slot() -> Slot {
    let (frames, _) = broadcast::channel(64);
    Slot {
        users: 0,
        applied_cols: 0,
        applied_rows: 0,
        want_cols: 0,
        want_rows: 0,
        spawning: false,
        frames,
        replay: Arc::new(Mutex::new(Replay {
            generation: 0,
            next_seq: 0,
            anchored: false,
            frames: VecDeque::new(),
        })),
        io: None,
    }
}

impl Replay {
    fn bump(&mut self) -> u64 {
        self.generation += 1;
        self.frames.clear();
        self.anchored = false;
        self.generation
    }

    fn push(&mut self, generation: u64, full: bool, body: String) -> Option<LiveFrame> {
        if generation != self.generation {
            return None;
        }
        self.next_seq += 1;
        let seq = self.next_seq;
        if full {
            self.frames.clear();
            self.anchored = true;
        }
        self.frames.push_back(StoredFrame {
            seq,
            body: body.clone(),
        });
        while self.frames.len() > 64 {
            if self.anchored && self.frames.len() > 1 {
                self.frames.remove(1);
            } else {
                self.frames.pop_front();
                self.anchored = false;
            }
        }
        Some(LiveFrame {
            generation,
            seq,
            body,
        })
    }
}

fn io_alive(slot: &mut Slot) -> bool {
    let Some(io) = slot.io.as_mut() else {
        return false;
    };
    if io.tx.is_closed() {
        slot.io = None;
        return false;
    }
    match io.child.try_wait() {
        Ok(None) => true,
        _ => {
            slot.io = None;
            false
        }
    }
}

async fn spawn_control(
    session: Option<&str>,
    pane_id: &str,
    cols: u16,
    rows: u16,
    frames: broadcast::Sender<LiveFrame>,
    replay: Arc<Mutex<Replay>>,
    generation: u64,
) -> Result<Io, String> {
    let mut command = Command::new("herdr");
    command.kill_on_drop(true);
    if let Some(session) = session {
        command.arg("--session").arg(session);
        command.env("HERDR_SESSION", session);
    } else {
        command.env_remove("HERDR_SESSION");
    }
    command
        .args(control_args(pane_id, cols, rows))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|err| format!("could not start herdr to size the shell: {err}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "herdr size controller has no stdin".to_string())?;
    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(read_frames(stdout, frames, replay, generation));
    }
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(_)) = lines.next_line().await {}
        });
    }
    let (tx, rx) = mpsc::channel(8);
    tokio::spawn(write_commands(stdin, rx));
    Ok(Io { tx, child })
}

async fn read_frames(
    reader: impl tokio::io::AsyncRead + Unpin,
    frames: broadcast::Sender<LiveFrame>,
    replay: Arc<Mutex<Replay>>,
    generation: u64,
) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Some((body, full)) = frame_message(&line) else {
            continue;
        };
        let message = {
            let mut replay = replay.lock().await;
            replay.push(generation, full, body)
        };
        let Some(message) = message else {
            return;
        };
        let _ = frames.send(message);
    }
}

pub fn frame_message(line: &str) -> Option<(String, bool)> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("type").and_then(serde_json::Value::as_str) != Some("terminal.frame") {
        return None;
    }
    let encoded = value.get("bytes").and_then(serde_json::Value::as_str)?;
    let raw = decode_base64(encoded)?;
    let text = String::from_utf8_lossy(&raw);
    let full = value
        .get("full")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    Some((
        json!({
            "type": "frame",
            "text": text,
            "cols": value.get("width").and_then(serde_json::Value::as_u64),
            "rows": value.get("height").and_then(serde_json::Value::as_u64),
            "full": full,
        })
        .to_string(),
        full,
    ))
}

fn decode_base64(input: &str) -> Option<Vec<u8>> {
    fn value(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let bytes: Vec<u8> = input
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect();
    if bytes.is_empty() || !bytes.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        let pad = usize::from(chunk[2] == b'=') + usize::from(chunk[3] == b'=');
        if pad == 2 && chunk[2] != b'=' {
            return None;
        }
        let a = value(chunk[0])?;
        let b = value(chunk[1])?;
        let c = if chunk[2] == b'=' {
            0
        } else {
            value(chunk[2])?
        };
        let d = if chunk[3] == b'=' {
            0
        } else {
            value(chunk[3])?
        };
        let packed =
            (u32::from(a) << 18) | (u32::from(b) << 12) | (u32::from(c) << 6) | u32::from(d);
        out.push((packed >> 16) as u8);
        if pad < 2 {
            out.push((packed >> 8) as u8);
        }
        if pad < 1 {
            out.push(packed as u8);
        }
    }
    Some(out)
}

async fn write_commands(mut stdin: ChildStdin, mut rx: mpsc::Receiver<String>) {
    while let Some(line) = rx.recv().await {
        if stdin.write_all(line.as_bytes()).await.is_err() {
            break;
        }
        if stdin.write_all(b"\n").await.is_err() {
            break;
        }
        if stdin.flush().await.is_err() {
            break;
        }
    }
}

pub fn resize_command(cols: u16, rows: u16) -> String {
    json!({
        "type": "terminal.resize",
        "cols": cols,
        "rows": rows,
    })
    .to_string()
}

pub fn control_args(pane_id: &str, cols: u16, rows: u16) -> Vec<String> {
    vec![
        "terminal".into(),
        "session".into(),
        "control".into(),
        pane_id.into(),
        "--cols".into(),
        cols.to_string(),
        "--rows".into(),
        rows.to_string(),
        "--takeover".into(),
    ]
}

const MIN_COLS: u16 = 2;
const MAX_COLS: u16 = 500;
const MIN_ROWS: u16 = 1;
const MAX_ROWS: u16 = 200;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resize_command_is_one_json_object() {
        let value: serde_json::Value = serde_json::from_str(&resize_command(80, 24)).unwrap();
        assert_eq!(value["type"], "terminal.resize");
        assert_eq!(value["cols"], 80);
        assert_eq!(value["rows"], 24);
    }

    #[test]
    fn frame_message_decodes_ansi() {
        let line =
            r#"{"type":"terminal.frame","bytes":"G1sxOzFI","width":80,"height":24,"full":true}"#;
        let (message, full) = frame_message(line).expect("frame");
        let value: serde_json::Value = serde_json::from_str(&message).unwrap();
        assert!(full);
        assert_eq!(value["type"], "frame");
        assert_eq!(value["full"], true);
        assert_eq!(value["text"], "\u{1b}[1;1H");
        assert_eq!(value["cols"], 80);
        assert_eq!(value["rows"], 24);
    }

    #[test]
    fn replay_keeps_the_latest_full_screen_for_a_new_viewer() {
        let mut replay = Replay {
            generation: 1,
            next_seq: 0,
            anchored: false,
            frames: VecDeque::new(),
        };
        let first = replay
            .push(1, true, "full-1".into())
            .expect("same generation");
        replay.push(1, false, "diff".into());
        let replacement = replay.push(1, true, "full-2".into()).expect("replacement");
        assert_eq!(first.seq, 1);
        assert_eq!(replacement.body, "full-2");
        assert_eq!(replay.frames.len(), 1);
        assert_eq!(replay.frames[0].body, "full-2");
        assert!(replay.push(0, true, "stale".into()).is_none());
        assert_eq!(replay.bump(), 2);
        assert!(replay.frames.is_empty());
    }

    #[test]
    fn control_args_name_the_pane_and_size() {
        let args = control_args("w1:p1", 70, 40);
        assert_eq!(
            args.join(" "),
            "terminal session control w1:p1 --cols 70 --rows 40 --takeover"
        );
    }
}
