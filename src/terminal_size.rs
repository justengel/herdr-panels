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
    next_viewer: u64,
    lease: PaneLease,
    applied_cols: u16,
    applied_rows: u16,
    want_cols: u16,
    want_rows: u16,
    spawning: bool,
    frames: broadcast::Sender<LiveFrame>,
    roles: broadcast::Sender<LeaseNotice>,
    replay: Arc<Mutex<Replay>>,
    io: Option<Io>,
}

/// One connected view of a pane. `own` means that view is allowed to resize it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaseNotice {
    pub viewer: u64,
    pub own: bool,
}

/// Which connected view may change the pane's size.
///
/// The shell has one size. The view that is in use owns it. A second tab or
/// the desktop can show the same frames, and it does not resize the pane until
/// someone types, clicks, or scrolls there. A hidden owner hands the pane to
/// another visible view.
#[derive(Debug, Default, Clone)]
pub struct PaneLease {
    owner: Option<u64>,
    active: Vec<u64>,
}

impl PaneLease {
    pub fn allows_resize(&self, viewer: u64) -> bool {
        self.owner == Some(viewer)
    }

    pub fn owner(&self) -> Option<u64> {
        self.owner
    }

    /// A view became visible or hidden. The first visible view owns the pane.
    /// Hiding the owner gives it to another visible view.
    pub fn set_active(&mut self, viewer: u64, active: bool) -> Vec<LeaseNotice> {
        let before = self.owner;
        if active {
            if !self.active.contains(&viewer) {
                self.active.push(viewer);
            }
            if self.owner.is_none() {
                self.owner = Some(viewer);
            }
        } else {
            self.active.retain(|id| *id != viewer);
            if self.owner == Some(viewer) {
                self.owner = self.active.first().copied();
            }
        }
        self.handoff(before)
    }

    /// The person typed, clicked, or scrolled in this view.
    pub fn claim(&mut self, viewer: u64) -> Vec<LeaseNotice> {
        let before = self.owner;
        if !self.active.contains(&viewer) {
            self.active.push(viewer);
        }
        self.owner = Some(viewer);
        self.handoff(before)
    }

    pub fn leave(&mut self, viewer: u64) -> Vec<LeaseNotice> {
        let before = self.owner;
        self.active.retain(|id| *id != viewer);
        if self.owner == Some(viewer) {
            self.owner = self.active.first().copied();
        }
        self.handoff(before)
    }

    fn handoff(&self, before: Option<u64>) -> Vec<LeaseNotice> {
        if before == self.owner {
            return Vec::new();
        }
        let mut notes = Vec::new();
        if let Some(old) = before {
            notes.push(LeaseNotice {
                viewer: old,
                own: false,
            });
        }
        if let Some(new) = self.owner {
            notes.push(LeaseNotice {
                viewer: new,
                own: true,
            });
        }
        notes
    }
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

    pub async fn retain(&self, pane_id: &str) -> Option<u64> {
        if !is_pane_id(pane_id) {
            return None;
        }
        let mut map = self.inner.lock().await;
        let slot = map.entry(pane_id.to_string()).or_insert_with(empty_slot);
        slot.users += 1;
        slot.next_viewer = slot.next_viewer.saturating_add(1);
        Some(slot.next_viewer)
    }

    pub async fn subscribe_roles(&self, pane_id: &str) -> broadcast::Receiver<LeaseNotice> {
        let mut map = self.inner.lock().await;
        map.entry(pane_id.to_string())
            .or_insert_with(empty_slot)
            .roles
            .subscribe()
    }

    pub async fn set_presence(&self, pane_id: &str, viewer: u64, active: bool) {
        self.touch(pane_id, |lease| lease.set_active(viewer, active))
            .await;
    }

    pub async fn claim(&self, pane_id: &str, viewer: u64) {
        self.touch(pane_id, |lease| lease.claim(viewer)).await;
    }

    pub async fn allows_resize(&self, pane_id: &str, viewer: u64) -> bool {
        let map = self.inner.lock().await;
        map.get(pane_id)
            .is_some_and(|slot| slot.lease.allows_resize(viewer))
    }

    async fn touch(&self, pane_id: &str, change: impl FnOnce(&mut PaneLease) -> Vec<LeaseNotice>) {
        let mut map = self.inner.lock().await;
        let Some(slot) = map.get_mut(pane_id) else {
            return;
        };
        let notes = change(&mut slot.lease);
        let roles = slot.roles.clone();
        drop(map);
        for note in notes {
            let _ = roles.send(note);
        }
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

    pub async fn release(&self, pane_id: &str, viewer: u64) {
        let mut map = self.inner.lock().await;
        let Some(slot) = map.get_mut(pane_id) else {
            return;
        };
        let notes = slot.lease.leave(viewer);
        let roles = slot.roles.clone();
        slot.users = slot.users.saturating_sub(1);
        if slot.users == 0 {
            map.remove(pane_id);
            return;
        }
        drop(map);
        for note in notes {
            let _ = roles.send(note);
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
            Step::Current(tx) => {
                match tx.send(resize_command(cols, rows)).await {
                    Ok(()) => Ok(()),
                    Err(_) => {
                        let mut map = self.inner.lock().await;
                        if let Some(slot) = map.get_mut(pane_id) {
                            slot.io = None;
                            slot.spawning = true;
                        }
                        drop(map);
                        self.spawn_into(pane_id, cols, rows).await
                    }
                }
            }
            Step::Spawn => self.spawn_into(pane_id, cols, rows).await,
            Step::Wait => Ok(()),
        }
    }

    /// Ask Herdr to move the pane's viewport. The live frame that comes back is the scrolled screen.
    pub async fn scroll(
        &self,
        pane_id: &str,
        direction: &str,
        lines: u16,
        source: &str,
    ) -> Result<(), String> {
        if direction != "up" && direction != "down" {
            return Err("scroll direction must be up or down".into());
        }
        if source != "wheel" && source != "page_key" {
            return Err("scroll source must be wheel or page_key".into());
        }
        if !is_pane_id(pane_id) {
            return Err("invalid pane id".into());
        }
        let lines = lines.clamp(1, 200);
        let tx = {
            let map = self.inner.lock().await;
            let Some(slot) = map.get(pane_id) else {
                return Ok(());
            };
            slot.io.as_ref().map(|io| io.tx.clone())
        };
        let Some(tx) = tx else {
            return self
                .replace_controller(pane_id, scroll_command(direction, lines, source))
                .await;
        };
        if tx
            .send(scroll_command(direction, lines, source))
            .await
            .is_ok()
        {
            return Ok(());
        }
        self.replace_controller(pane_id, scroll_command(direction, lines, source))
            .await
    }

    /// Forward a click or drag. Herdr delivers it only when the program asked for the mouse.
    pub async fn mouse(
        &self,
        pane_id: &str,
        action: &str,
        button: &str,
        column: u16,
        row: u16,
        modifiers: u8,
    ) -> Result<(), String> {
        if !matches!(action, "down" | "up" | "drag" | "move") {
            return Err("mouse action must be down, up, drag, or move".into());
        }
        if !matches!(button, "left" | "right" | "middle") {
            return Err("mouse button must be left, right, or middle".into());
        }
        if !is_pane_id(pane_id) {
            return Err("invalid pane id".into());
        }
        let tx = {
            let map = self.inner.lock().await;
            let Some(slot) = map.get(pane_id) else {
                return Ok(());
            };
            slot.io.as_ref().map(|io| io.tx.clone())
        };
        let line = mouse_command(action, button, column, row, modifiers);
        let Some(tx) = tx else {
            return self.replace_controller(pane_id, line).await;
        };
        if tx.send(line.clone()).await.is_ok() {
            return Ok(());
        }
        self.replace_controller(pane_id, line).await
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

    /// The size controller is exclusive. Start another when the previous one was taken over.
    async fn replace_controller(&self, pane_id: &str, line: String) -> Result<(), String> {
        let (cols, rows) = {
            let mut map = self.inner.lock().await;
            let Some(slot) = map.get_mut(pane_id) else {
                return Ok(());
            };
            if slot.users == 0 {
                return Ok(());
            }
            slot.io = None;
            if slot.spawning || slot.want_cols == 0 || slot.want_rows == 0 {
                return Ok(());
            }
            slot.spawning = true;
            (slot.want_cols, slot.want_rows)
        };
        self.spawn_into(pane_id, cols, rows).await?;
        let tx = {
            let map = self.inner.lock().await;
            map.get(pane_id)
                .and_then(|slot| slot.io.as_ref().map(|io| io.tx.clone()))
        };
        let Some(tx) = tx else {
            return Err("terminal size controller closed".into());
        };
        tx.send(line)
            .await
            .map_err(|_| "terminal size controller closed".to_string())
    }
}

fn empty_slot() -> Slot {
    let (frames, _) = broadcast::channel(64);
    let (roles, _) = broadcast::channel(16);
    Slot {
        users: 0,
        next_viewer: 0,
        lease: PaneLease::default(),
        applied_cols: 0,
        applied_rows: 0,
        want_cols: 0,
        want_rows: 0,
        spawning: false,
        frames,
        roles,
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
    let mut child = spawn_herdr(session, &control_args(pane_id, cols, rows))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "herdr size controller has no stdin".to_string())?;
    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(read_frames(stdout, frames, replay, generation));
    }
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(discard(stderr));
    }
    let (tx, rx) = mpsc::channel(8);
    tokio::spawn(write_commands(stdin, rx));
    Ok(Io { tx, child })
}

fn spawn_herdr(session: Option<&str>, args: &[String]) -> Result<Child, String> {
    let mut command = Command::new("herdr");
    command.kill_on_drop(true);
    if let Some(session) = session {
        command.arg("--session").arg(session);
        command.env("HERDR_SESSION", session);
    } else {
        command.env_remove("HERDR_SESSION");
    }
    command
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    crate::quiet_process::quiet_async(&mut command);
    command
        .spawn()
        .map_err(|err| format!("could not start herdr to size the shell: {err}"))
}

async fn discard(reader: impl tokio::io::AsyncRead + Unpin) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(_)) = lines.next_line().await {}
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

pub fn mouse_command(action: &str, button: &str, column: u16, row: u16, modifiers: u8) -> String {
    json!({
        "type": "terminal.mouse",
        "action": action,
        "button": button,
        "column": column,
        "row": row,
        "modifiers": modifiers,
    })
    .to_string()
}

pub fn scroll_command(direction: &str, lines: u16, source: &str) -> String {
    json!({
        "type": "terminal.scroll",
        "direction": direction,
        "lines": lines,
        "source": source,
    })
    .to_string()
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

/// Read the pane without replacing another viewer's size controller.
pub fn observe_args(pane_id: &str, cols: u16, rows: u16) -> Vec<String> {
    vec![
        "terminal".into(),
        "session".into(),
        "observe".into(),
        pane_id.into(),
        "--cols".into(),
        cols.to_string(),
        "--rows".into(),
        rows.to_string(),
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
    fn the_visible_viewer_owns_the_pane_until_someone_uses_another() {
        let mut lease = PaneLease::default();
        let desktop = lease.set_active(1, true);
        assert_eq!(
            desktop,
            vec![LeaseNotice {
                viewer: 1,
                own: true
            }]
        );
        assert!(lease.allows_resize(1));
        assert!(lease.set_active(2, true).is_empty());
        assert!(!lease.allows_resize(2));

        assert_eq!(
            lease.claim(2),
            vec![
                LeaseNotice {
                    viewer: 1,
                    own: false
                },
                LeaseNotice {
                    viewer: 2,
                    own: true
                },
            ]
        );
        assert!(lease.allows_resize(2));
        assert!(!lease.allows_resize(1));
    }

    #[test]
    fn hiding_the_owner_hands_the_pane_to_the_other_visible_viewer() {
        let mut lease = PaneLease::default();
        lease.set_active(1, true);
        lease.set_active(2, true);
        assert_eq!(
            lease.set_active(1, false),
            vec![
                LeaseNotice {
                    viewer: 1,
                    own: false
                },
                LeaseNotice {
                    viewer: 2,
                    own: true
                },
            ]
        );
        assert_eq!(lease.owner(), Some(2));
        assert!(lease.set_active(3, false).is_empty());
        assert_eq!(lease.owner(), Some(2));
    }

    #[test]
    fn closing_the_owner_hands_the_pane_to_a_remaining_viewer() {
        let mut lease = PaneLease::default();
        lease.set_active(1, true);
        lease.set_active(2, true);
        assert_eq!(lease.leave(2), Vec::new());
        assert_eq!(lease.owner(), Some(1));

        let mut lease = PaneLease::default();
        lease.set_active(1, true);
        lease.set_active(2, true);
        assert_eq!(
            lease.leave(1),
            vec![
                LeaseNotice {
                    viewer: 1,
                    own: false
                },
                LeaseNotice {
                    viewer: 2,
                    own: true
                },
            ]
        );
        assert_eq!(
            lease.leave(2),
            vec![LeaseNotice {
                viewer: 2,
                own: false
            }]
        );
        assert_eq!(lease.owner(), None);
    }

    #[test]
    fn mouse_command_uses_herdr_names() {
        let value: serde_json::Value =
            serde_json::from_str(&mouse_command("down", "left", 10, 5, 0)).unwrap();
        assert_eq!(value["type"], "terminal.mouse");
        assert_eq!(value["action"], "down");
        assert_eq!(value["button"], "left");
        assert_eq!(value["column"], 10);
        assert_eq!(value["row"], 5);
        assert_eq!(value["modifiers"], 0);
    }

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
    fn scroll_command_names_the_direction_and_source() {
        let value: serde_json::Value =
            serde_json::from_str(&scroll_command("up", 3, "wheel")).unwrap();
        assert_eq!(value["type"], "terminal.scroll");
        assert_eq!(value["direction"], "up");
        assert_eq!(value["lines"], 3);
        assert_eq!(value["source"], "wheel");
        let page: serde_json::Value =
            serde_json::from_str(&scroll_command("down", 24, "page_key")).unwrap();
        assert_eq!(page["source"], "page_key");
        assert_eq!(page["direction"], "down");
        assert_eq!(page["lines"], 24);
    }

    #[test]
    fn control_args_name_the_pane_and_size() {
        let args = control_args("w1:p1", 70, 40);
        assert_eq!(
            args.join(" "),
            "terminal session control w1:p1 --cols 70 --rows 40 --takeover"
        );
    }

    #[test]
    fn observe_args_watch_the_pane_without_taking_it_over() {
        let args = observe_args("w1:p1", 70, 40);
        assert_eq!(
            args.join(" "),
            "terminal session observe w1:p1 --cols 70 --rows 40"
        );
        assert!(!args.iter().any(|arg| arg == "--takeover"));
    }
}
