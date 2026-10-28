//! Server-side file watches for a plugin frame.
//!
//! The frame asks over postMessage. The host forwards that on a websocket.
//! This module reads the file and notices changes. The frame never polls.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, UNIX_EPOCH};

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedReceiver;

use crate::plugin_grant::{resolve_read, ReadPath};

pub const MAX_WATCHES: usize = 8;
pub const MAX_BYTES: usize = 1_000_000;
pub const MAX_PUSHES_PER_SEC: u32 = 8;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileNotice {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn notice_message(notice: &FileNotice) -> Value {
    let mut value = serde_json::to_value(notice).unwrap_or_else(|_| json!({}));
    if let Some(map) = value.as_object_mut() {
        map.insert("type".into(), json!("file"));
    }
    value
}

struct ActiveWatch {
    raw: String,
    absolute: PathBuf,
    parent: PathBuf,
    armed: Option<PathBuf>,
    last: Option<FileNotice>,
}

struct PushGate {
    start: Instant,
    sent: u32,
}

impl PushGate {
    fn new() -> Self {
        Self {
            start: Instant::now(),
            sent: 0,
        }
    }

    fn admit(&mut self, now: Instant, count: u32) -> bool {
        if now.saturating_duration_since(self.start) >= Duration::from_secs(1) {
            self.start = now;
            self.sent = 0;
        }
        if self.sent.saturating_add(count) > MAX_PUSHES_PER_SEC {
            return false;
        }
        self.sent += count;
        true
    }

    fn reset_in(&self, now: Instant) -> Duration {
        Duration::from_secs(1).saturating_sub(now.saturating_duration_since(self.start))
    }
}

pub struct FileFeed {
    allow_files: bool,
    files: Vec<PathBuf>,
    config_dir: Option<PathBuf>,
    plugin_id: Option<String>,
    watcher: RecommendedWatcher,
    events: UnboundedReceiver<PathBuf>,
    watches: Vec<ActiveWatch>,
    armed: HashSet<PathBuf>,
    gate: PushGate,
}

impl FileFeed {
    pub fn open(allow_files: bool, files: Vec<PathBuf>) -> anyhow::Result<Self> {
        let (tx, events) = tokio::sync::mpsc::unbounded_channel();
        let watcher =
            notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
                let Ok(event) = result else {
                    return;
                };
                if event.paths.is_empty() {
                    let _ = tx.send(PathBuf::new());
                    return;
                }
                for path in event.paths {
                    let _ = tx.send(path);
                }
            })?;
        Ok(Self {
            allow_files,
            files,
            config_dir: None,
            plugin_id: None,
            watcher,
            events,
            watches: Vec::new(),
            armed: HashSet::new(),
            gate: PushGate::new(),
        })
    }

    pub fn start(config_dir: PathBuf, plugin_id: String) -> anyhow::Result<Self> {
        let mut feed = Self::open(false, Vec::new())?;
        feed.config_dir = Some(config_dir);
        feed.plugin_id = Some(plugin_id);
        Ok(feed)
    }

    pub fn watch_count(&self) -> usize {
        self.watches.len()
    }

    pub fn watch(&mut self, raw: &str) -> FileNotice {
        let (allow, files) = self.grants();
        if !allow {
            return error_notice(raw, "denied");
        }
        let resolved = match resolve_read(&files, raw) {
            Ok(path) => path,
            Err(code) => return error_notice(raw, code),
        };
        let absolute = resolved.path().to_path_buf();
        if let Some(index) = self
            .watches
            .iter()
            .position(|watch| watch.raw == raw || watch.absolute == absolute)
        {
            let notice = read_resolved(raw, &resolved);
            self.watches[index].last = Some(notice.clone());
            self.watches[index].raw = raw.to_string();
            return notice;
        }
        if self.watches.len() >= MAX_WATCHES {
            return error_notice(raw, "watch_limit");
        }
        let notice = read_resolved(raw, &resolved);
        let parent = absolute
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| absolute.clone());
        let armed = self.arm(&parent);
        self.watches.push(ActiveWatch {
            raw: raw.to_string(),
            absolute,
            parent,
            armed,
            last: Some(notice.clone()),
        });
        notice
    }

    pub fn unwatch(&mut self, raw: &str) {
        let files = self.grants().1;
        let absolute = resolve_read(&files, raw)
            .ok()
            .map(|path| path.path().to_path_buf());
        self.watches
            .retain(|watch| watch.raw != raw && absolute.as_ref() != Some(&watch.absolute));
        self.disarm_unused();
    }

    pub async fn recv(&mut self) -> Option<Vec<FileNotice>> {
        loop {
            self.events.recv().await?;
            tokio::time::sleep(Duration::from_millis(70)).await;
            while self.events.try_recv().is_ok() {}
            let changed = self.reread();
            if changed.is_empty() {
                continue;
            }
            return Some(self.emit(changed).await);
        }
    }

    async fn emit(&mut self, notices: Vec<FileNotice>) -> Vec<FileNotice> {
        if notices.is_empty() {
            return notices;
        }
        if self.gate.admit(Instant::now(), notices.len() as u32) {
            self.commit(&notices);
            return notices;
        }
        tokio::time::sleep(self.gate.reset_in(Instant::now())).await;
        while self.events.try_recv().is_ok() {}
        let fresh = self.reread();
        let notices = if fresh.is_empty() { notices } else { fresh };
        let _ = self.gate.admit(Instant::now(), notices.len() as u32);
        self.commit(&notices);
        notices
    }

    fn reread(&mut self) -> Vec<FileNotice> {
        let (allow, files) = self.grants();
        let current: Vec<(String, Option<FileNotice>)> = self
            .watches
            .iter()
            .map(|watch| (watch.raw.clone(), watch.last.clone()))
            .collect();
        let mut planned = Vec::new();
        for (raw, last) in current {
            let notice = if !allow {
                error_notice(&raw, "denied")
            } else {
                match resolve_read(&files, &raw) {
                    Ok(path) => read_resolved(&raw, &path),
                    Err(code) => error_notice(&raw, code),
                }
            };
            if last.as_ref() != Some(&notice) {
                planned.push(notice);
            }
        }
        let parents: Vec<PathBuf> = self
            .watches
            .iter()
            .map(|watch| watch.parent.clone())
            .collect();
        for parent in parents {
            let armed = self.arm(&parent);
            if let Some(watch) = self.watches.iter_mut().find(|watch| watch.parent == parent) {
                if watch.armed.is_none() {
                    watch.armed = armed;
                }
            }
        }
        planned
    }

    fn commit(&mut self, notices: &[FileNotice]) {
        for notice in notices {
            if let Some(watch) = self
                .watches
                .iter_mut()
                .find(|watch| watch.raw == notice.path)
            {
                watch.last = Some(notice.clone());
            }
        }
    }

    fn grants(&self) -> (bool, Vec<PathBuf>) {
        if let (Some(dir), Some(id)) = (&self.config_dir, &self.plugin_id) {
            return match crate::plugins::load_installed(dir, id) {
                Ok(manifest) => (
                    crate::plugin_grant::allows_files(&manifest.permissions),
                    manifest.files,
                ),
                Err(_) => (false, Vec::new()),
            };
        }
        (self.allow_files, self.files.clone())
    }

    fn arm(&mut self, parent: &Path) -> Option<PathBuf> {
        let target = nearest_existing(parent);
        if too_broad(&target) || !target.is_dir() {
            return None;
        }
        if self.armed.insert(target.clone())
            && self
                .watcher
                .watch(&target, RecursiveMode::NonRecursive)
                .is_err()
        {
            self.armed.remove(&target);
            return None;
        }
        Some(target)
    }

    fn disarm_unused(&mut self) {
        let needed: HashSet<PathBuf> = self
            .watches
            .iter()
            .filter_map(|watch| watch.armed.clone())
            .collect();
        let stale: Vec<PathBuf> = self.armed.difference(&needed).cloned().collect();
        for path in stale {
            let _ = self.watcher.unwatch(&path);
            self.armed.remove(&path);
        }
    }
}

fn error_notice(path: &str, error: &str) -> FileNotice {
    FileNotice {
        path: path.to_string(),
        content: None,
        mtime: None,
        error: Some(error.to_string()),
    }
}

fn read_resolved(raw: &str, resolved: &ReadPath) -> FileNotice {
    match resolved {
        ReadPath::Missing(_) => error_notice(raw, "not_found"),
        ReadPath::File(path) => read_file(raw, path),
    }
}

fn read_file(raw: &str, path: &Path) -> FileNotice {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return error_notice(raw, "not_found"),
    };
    if bytes.len() > MAX_BYTES {
        return error_notice(raw, "too_large");
    }
    if bytes.contains(&0) {
        return error_notice(raw, "not_text");
    }
    match String::from_utf8(bytes) {
        Ok(content) => FileNotice {
            path: raw.to_string(),
            content: Some(content),
            mtime: mtime_ms(path),
            error: None,
        },
        Err(_) => error_notice(raw, "not_text"),
    }
}

fn mtime_ms(path: &Path) -> Option<u64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(
        modified
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_millis()
            .min(u128::from(u64::MAX)) as u64,
    )
}

fn nearest_existing(path: &Path) -> PathBuf {
    let mut cursor = path.to_path_buf();
    loop {
        if cursor.exists() {
            return cursor;
        }
        if !cursor.pop() {
            return cursor;
        }
    }
}

fn too_broad(path: &Path) -> bool {
    path.components().count() <= 2
}

pub async fn drive(config_dir: PathBuf, plugin_id: String, socket: WebSocket) {
    let Ok(mut feed) = FileFeed::start(config_dir, plugin_id) else {
        return;
    };
    let (mut sink, mut stream) = socket.split();
    loop {
        tokio::select! {
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Ping(payload))) => {
                        if sink.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        if text.len() > 8192 {
                            continue;
                        }
                        let notice = command(&mut feed, text.as_str());
                        if let Some(notice) = notice {
                            if send_notice(&mut sink, &notice).await.is_err() {
                                break;
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                }
            }
            event = feed.events.recv() => {
                if event.is_none() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(70)).await;
                while feed.events.try_recv().is_ok() {}
                let changed = feed.reread();
                if changed.is_empty() {
                    continue;
                }
                let notices = feed.emit(changed).await;
                if send_notices(&mut sink, &notices).await.is_err() {
                    break;
                }
            }
        }
    }
}

fn command(feed: &mut FileFeed, text: &str) -> Option<FileNotice> {
    let value: Value = serde_json::from_str(text).ok()?;
    let path = value.get("path").and_then(Value::as_str).unwrap_or("");
    match value.get("type").and_then(Value::as_str) {
        Some("watch") => Some(feed.watch(path)),
        Some("unwatch") => {
            feed.unwatch(path);
            None
        }
        _ => None,
    }
}

async fn send_notices(
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    notices: &[FileNotice],
) -> Result<(), ()> {
    for notice in notices {
        send_notice(sink, notice).await?;
    }
    Ok(())
}

async fn send_notice(
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    notice: &FileNotice,
) -> Result<(), ()> {
    let payload = notice_message(notice).to_string();
    sink.send(Message::Text(payload.into()))
        .await
        .map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static N: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn a_push_gate_holds_the_ninth_update_in_the_same_second() {
        let mut gate = PushGate::new();
        let now = Instant::now();
        for _ in 0..MAX_PUSHES_PER_SEC {
            assert!(gate.admit(now, 1));
        }
        assert!(!gate.admit(now, 1));
        assert!(gate.admit(now + Duration::from_secs(1), 1));
    }

    #[test]
    fn an_error_notice_has_no_content() {
        let notice = error_notice("/tmp/report.json", "denied");
        let message = notice_message(&notice);
        assert_eq!(message["type"], "file");
        assert_eq!(message["error"], "denied");
        assert!(message.get("content").is_none());
    }

    #[tokio::test]
    async fn a_plugin_without_files_read_gets_no_file_and_no_watch() {
        let root = scratch("deny");
        let state = root.join("state");
        let outside = root.join("outside");
        fs::create_dir_all(&state).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let report = state.join("report.json");
        let secret = outside.join("secret.txt");
        fs::write(&report, "secret").unwrap();
        fs::write(&secret, "no").unwrap();
        let mut feed = FileFeed::open(false, vec![state.clone()]).unwrap();
        let notice = feed.watch(&report.display().to_string());
        assert_eq!(notice.error.as_deref(), Some("denied"));
        assert!(notice.content.is_none());
        assert_eq!(feed.watch_count(), 0);
        let mut allowed = FileFeed::open(true, vec![state]).unwrap();
        let notice = allowed.watch(&secret.display().to_string());
        assert_eq!(notice.error.as_deref(), Some("outside"));
        assert!(notice.content.is_none());
        assert_eq!(allowed.watch_count(), 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn the_feed_pushes_the_file_and_follows_rewrites() {
        let dir = scratch("feed");
        let report = dir.join("report.json");
        fs::write(&report, "one").unwrap();
        let mut feed = FileFeed::open(true, vec![dir.clone()]).unwrap();
        let path = report.display().to_string();
        let first = feed.watch(&path);
        assert_eq!(first.content.as_deref(), Some("one"));
        assert!(first.error.is_none());
        assert!(first.mtime.is_some());

        fs::write(&report, "two").unwrap();
        let next = wait_for(&mut feed, |notice| notice.content.as_deref() == Some("two")).await;
        assert_eq!(next.path, path);

        let tmp = dir.join("report.json.tmp");
        fs::write(&tmp, "three").unwrap();
        replace_file(&tmp, &report);
        let next = wait_for(&mut feed, |notice| {
            notice.content.as_deref() == Some("three")
        })
        .await;
        assert!(next.error.is_none());

        let huge = vec![b'a'; MAX_BYTES + 1];
        fs::write(&report, &huge).unwrap();
        let next = wait_for(&mut feed, |notice| {
            notice.error.as_deref() == Some("too_large")
        })
        .await;
        assert!(next.content.is_none());
        fs::write(&report, "small").unwrap();
        let next = wait_for(&mut feed, |notice| {
            notice.content.as_deref() == Some("small")
        })
        .await;
        assert!(next.error.is_none());

        feed.unwatch(&path);
        fs::write(&report, "after").unwrap();
        let late = tokio::time::timeout(Duration::from_millis(800), async {
            loop {
                let notices = feed.recv().await.expect("watcher closed");
                if notices
                    .iter()
                    .any(|notice| notice.content.as_deref() == Some("after"))
                {
                    return;
                }
            }
        })
        .await;
        assert!(late.is_err(), "unwatch still delivered the new file");
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_missing_file_is_watched_until_it_appears() {
        let dir = scratch("missing");
        let report = dir.join("report.json");
        let mut feed = FileFeed::open(true, vec![dir.clone()]).unwrap();
        let path = report.display().to_string();
        let first = feed.watch(&path);
        assert_eq!(first.error.as_deref(), Some("not_found"));
        assert!(first.content.is_none());
        assert_eq!(feed.watch_count(), 1);
        fs::write(&report, "{\"ok\":true}").unwrap();
        let next = wait_for(&mut feed, |notice| {
            notice.content.as_deref() == Some("{\"ok\":true}")
        })
        .await;
        assert!(next.error.is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn the_ninth_watch_is_refused() {
        let dir = scratch("limit");
        let mut feed = FileFeed::open(true, vec![dir.clone()]).unwrap();
        for index in 0..MAX_WATCHES {
            let path = dir.join(format!("f{index}.txt"));
            fs::write(&path, "x").unwrap();
            let notice = feed.watch(&path.display().to_string());
            assert!(notice.error.is_none(), "{notice:?}");
        }
        let extra = dir.join("extra.txt");
        fs::write(&extra, "x").unwrap();
        let notice = feed.watch(&extra.display().to_string());
        assert_eq!(notice.error.as_deref(), Some("watch_limit"));
        assert!(notice.content.is_none());
        assert_eq!(feed.watch_count(), MAX_WATCHES);
        let _ = fs::remove_dir_all(&dir);
    }

    async fn wait_for(feed: &mut FileFeed, pred: impl Fn(&FileNotice) -> bool) -> FileNotice {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            if left.is_zero() {
                panic!("timed out waiting for a file update");
            }
            let notices = tokio::time::timeout(left, feed.recv())
                .await
                .expect("timed out waiting for a file update")
                .expect("watcher closed");
            if let Some(notice) = notices.into_iter().find(|notice| pred(notice)) {
                return notice;
            }
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("hwp-feed-{name}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn replace_file(from: &Path, to: &Path) {
        if fs::rename(from, to).is_ok() {
            return;
        }
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            let existing: Vec<u16> = from
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let new: Vec<u16> = to
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let ok = unsafe { MoveFileExW(existing.as_ptr(), new.as_ptr(), 1) };
            assert!(ok != 0, "replacing {}", to.display());
            return;
        }
        #[cfg(not(windows))]
        panic!("rename {} over {} failed", from.display(), to.display());
    }

    #[cfg(windows)]
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
}
