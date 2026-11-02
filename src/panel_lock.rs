//! One lock per panel, stored beside the desk. Layout JSON cannot set it.
//! A terminal lock follows the Herdr pane, so a new panel on that pane stays locked.
//! While this process is running, the lock list in memory wins. Rewriting the file does not unlock a panel.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::auth;
use crate::plugin_store;

pub const FILE_NAME: &str = "panel-locks.json";

static DIALOG_OPEN: AtomicBool = AtomicBool::new(false);
static BOOKS: Mutex<Option<HashMap<PathBuf, LockFile>>> = Mutex::new(None);

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
struct LockFile {
    #[serde(default)]
    panes: Vec<String>,
    #[serde(default)]
    panels: Vec<String>,
    /// The file could not be read. Every panel stays locked, and this is not written back.
    #[serde(skip)]
    sealed: bool,
}

pub fn lock_path(config_dir: &Path) -> PathBuf {
    config_dir.join(FILE_NAME)
}

pub fn panel_key(session: &str, space: &str, panel_id: &str) -> String {
    format!("{session}\u{1f}{space}\u{1f}{panel_id}")
}

pub fn is_locked(
    config_dir: &Path,
    session: &str,
    space: &str,
    panel_id: &str,
    pane_id: Option<&str>,
) -> bool {
    let file = read_book(config_dir);
    if file.sealed {
        return true;
    }
    if pane_id.is_some_and(|pane| file.panes.iter().any(|have| have == pane)) {
        return true;
    }
    let key = panel_key(session, space, panel_id);
    file.panels.iter().any(|have| have == &key)
}

/// Panel locks for this session. `None` means the file could not be read, so every panel stays locked.
pub fn session_panels(config_dir: &Path, session: &str) -> Option<Vec<(String, String)>> {
    let file = read_book(config_dir);
    if file.sealed {
        return None;
    }
    let prefix = format!("{session}\u{1f}");
    let mut found = Vec::new();
    for key in &file.panels {
        let Some(rest) = key.strip_prefix(&prefix) else {
            continue;
        };
        let Some((space, id)) = rest.split_once('\u{1f}') else {
            continue;
        };
        if !space.is_empty() && !id.is_empty() {
            found.push((space.to_string(), id.to_string()));
        }
    }
    Some(found)
}

pub fn pane_locked(config_dir: &Path, pane_id: &str) -> bool {
    let file = read_book(config_dir);
    file.sealed || file.panes.iter().any(|have| have == pane_id)
}

/// `pane_id` set means the lock follows that Herdr pane. Otherwise it follows this panel.
pub fn set_locked(
    config_dir: &Path,
    session: &str,
    space: &str,
    panel_id: &str,
    pane_id: Option<&str>,
    locked: bool,
) -> Result<()> {
    let mut next = read_book(config_dir);
    if next.sealed {
        anyhow::bail!("panel locks could not be read");
    }
    if let Some(pane_id) = pane_id.map(str::trim).filter(|pane| !pane.is_empty()) {
        if locked {
            push_unique(&mut next.panes, pane_id);
        } else {
            next.panes.retain(|have| have != pane_id);
        }
    } else if locked {
        push_unique(&mut next.panels, &panel_key(session, space, panel_id));
    } else {
        let key = panel_key(session, space, panel_id);
        next.panels.retain(|have| have != &key);
    }
    write_all(config_dir, &next)?;
    let mut guard = books();
    let map = guard.get_or_insert_with(HashMap::new);
    map.insert(config_dir.to_path_buf(), next);
    Ok(())
}

/// Drop a lock field from a layout write. The stored lock is unchanged.
pub fn drop_lock_keys(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.remove("locked");
            for child in map.values_mut() {
                drop_lock_keys(child);
            }
        }
        Value::Array(items) => {
            for child in items {
                drop_lock_keys(child);
            }
        }
        _ => {}
    }
}

pub fn refuse_protected_file(path: &Path, config_dir: &Path) -> Result<(), &'static str> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if name == auth::FILE_NAME
        || name == plugin_store::FILE_NAME
        || name == FILE_NAME
        || name == "server.json"
    {
        return Err("that file cannot be replaced");
    }
    let desks = config_dir.join("desks");
    if path.starts_with(&desks) && name.ends_with(".json") {
        return Err("that file cannot be replaced");
    }
    let settings = config_dir.join("settings.json");
    if path == settings {
        return Err("that file cannot be replaced");
    }
    Ok(())
}

/// One unlock question at a time. Locking does not use this.
pub fn begin_confirm() -> bool {
    DIALOG_OPEN
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

pub fn end_confirm() {
    DIALOG_OPEN.store(false, Ordering::SeqCst);
}

fn books() -> std::sync::MutexGuard<'static, Option<HashMap<PathBuf, LockFile>>> {
    BOOKS.lock().unwrap_or_else(|err| err.into_inner())
}

/// Snapshot the lock file before the server accepts requests.
/// A later rewrite of the file does not change this process.
pub fn remember(config_dir: &Path) {
    let _ = read_book(config_dir);
}

/// This process is the viewer, so its lock list is the one that counts.
pub fn authoritative(config_dir: &Path) -> bool {
    books()
        .as_ref()
        .is_some_and(|map| map.contains_key(config_dir))
}

fn read_book(config_dir: &Path) -> LockFile {
    let mut books = books();
    let map = books.get_or_insert_with(HashMap::new);
    if let Some(file) = map.get(config_dir) {
        return file.clone();
    }
    match load(config_dir) {
        Ok(file) => {
            map.insert(config_dir.to_path_buf(), file.clone());
            file
        }
        // An unreadable file must not become "nothing is locked", and a later
        // rewrite in this process must not clear that.
        Err(_) => {
            let file = LockFile {
                panes: Vec::new(),
                panels: Vec::new(),
                sealed: true,
            };
            map.insert(config_dir.to_path_buf(), file.clone());
            file
        }
    }
}

fn push_unique(list: &mut Vec<String>, value: &str) {
    if !list.iter().any(|have| have == value) {
        list.push(value.to_string());
    }
}

fn load(config_dir: &Path) -> Result<LockFile> {
    let path = lock_path(config_dir);
    if !path.is_file() {
        return Ok(LockFile::default());
    }
    let text = fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    serde_json::from_str(&text).context("panel locks are not valid JSON")
}

fn write_all(config_dir: &Path, file: &LockFile) -> Result<()> {
    fs::create_dir_all(config_dir)?;
    let path = lock_path(config_dir);
    let body = serde_json::to_vec_pretty(file).context("panel locks could not be encoded")?;
    let tmp = path.with_extension("json.tmp");
    {
        let mut out =
            fs::File::create(&tmp).with_context(|| format!("writing {}", tmp.display()))?;
        out.write_all(&body)?;
        out.write_all(b"\n")?;
        out.sync_all()?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, &path).with_context(|| format!("replacing {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "herdr-locks-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn one_unlock_confirmation_at_a_time() {
        assert!(begin_confirm());
        assert!(!begin_confirm());
        end_confirm();
        assert!(begin_confirm());
        end_confirm();
    }

    #[test]
    fn a_terminal_lock_follows_the_pane_and_a_layout_write_cannot_set_it() {
        let dir = dir();
        assert!(!is_locked(&dir, "default", "chief", "term", Some("w1:p1")));
        set_locked(&dir, "default", "chief", "term", Some("w1:p1"), true).unwrap();
        assert!(is_locked(&dir, "default", "other", "fresh", Some("w1:p1")));
        assert!(pane_locked(&dir, "w1:p1"));
        assert!(!is_locked(&dir, "default", "chief", "browser", None));
        set_locked(&dir, "default", "chief", "browser", None, true).unwrap();
        assert!(is_locked(&dir, "default", "chief", "browser", None));
        assert!(!is_locked(&dir, "default", "api", "browser", None));
        let mut body =
            serde_json::json!({"type": "iframe", "url": "https://example.com", "locked": true});
        drop_lock_keys(&mut body);
        assert!(body.get("locked").is_none());
        assert!(is_locked(&dir, "default", "chief", "browser", None));
        set_locked(&dir, "default", "chief", "term", Some("w1:p1"), false).unwrap();
        assert!(!pane_locked(&dir, "w1:p1"));
        assert_eq!(
            refuse_protected_file(&dir.join(auth::FILE_NAME), &dir),
            Err("that file cannot be replaced")
        );
        assert_eq!(
            refuse_protected_file(&dir.join("desks").join("default.json"), &dir),
            Err("that file cannot be replaced")
        );
        assert!(refuse_protected_file(&dir.join("shots").join("card.png"), &dir).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rewriting_the_lock_file_does_not_unlock_a_panel() {
        let dir = dir();
        set_locked(&dir, "default", "chief", "browser", None, true).unwrap();
        fs::write(lock_path(&dir), "{}\n").unwrap();
        assert!(is_locked(&dir, "default", "chief", "browser", None));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreadable_lock_file_stays_locked() {
        let dir = dir();
        fs::write(lock_path(&dir), "not json").unwrap();
        assert!(is_locked(&dir, "default", "chief", "browser", None));
        assert!(pane_locked(&dir, "w1:p1"));
        fs::write(lock_path(&dir), "{}\n").unwrap();
        assert!(is_locked(&dir, "default", "chief", "browser", None));
        assert!(set_locked(&dir, "default", "chief", "browser", None, false).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
