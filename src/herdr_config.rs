use std::env;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tokio::process::Command;

struct Field {
    section: &'static str,
    key: &'static str,
    id: &'static str,
    group: &'static str,
    label: &'static str,
    kind: &'static str,
    default: &'static str,
    options: &'static [&'static str],
}

const THEMES: &[&str] = &[
    "catppuccin",
    "catppuccin-latte",
    "terminal",
    "tokyo-night",
    "tokyo-night-day",
    "dracula",
    "nord",
    "gruvbox",
    "gruvbox-light",
    "one-dark",
    "one-light",
    "solarized",
    "solarized-light",
    "kanagawa",
    "kanagawa-lotus",
    "rose-pine",
    "rose-pine-dawn",
    "vesper",
];

const FIELDS: &[Field] = &[
    Field { section: "terminal", key: "default_shell", id: "default_shell", group: "other", label: "Default shell", kind: "string", default: "", options: &[] },
    Field { section: "terminal", key: "shell_mode", id: "shell_mode", group: "other", label: "Shell mode", kind: "enum", default: "auto", options: &["auto", "login", "non_login"] },
    Field { section: "terminal", key: "new_cwd", id: "new_cwd", group: "other", label: "New pane directory", kind: "string", default: "follow", options: &[] },
    Field { section: "update", key: "channel", id: "channel", group: "other", label: "Update channel", kind: "enum", default: "stable", options: &["stable", "preview"] },
    Field { section: "update", key: "version_check", id: "version_check", group: "other", label: "Check for updates", kind: "bool", default: "true", options: &[] },
    Field { section: "server", key: "headless_cols", id: "headless_cols", group: "other", label: "Headless columns", kind: "int", default: "120", options: &[] },
    Field { section: "server", key: "headless_rows", id: "headless_rows", group: "other", label: "Headless rows", kind: "int", default: "40", options: &[] },
    Field { section: "ui", key: "accent", id: "accent", group: "other", label: "Accent", kind: "string", default: "cyan", options: &[] },
    Field { section: "ui", key: "confirm_close", id: "confirm_close", group: "other", label: "Confirm before closing a space", kind: "bool", default: "true", options: &[] },
    Field { section: "ui", key: "prompt_new_tab_name", id: "prompt_new_tab_name", group: "other", label: "Ask for a tab name", kind: "bool", default: "true", options: &[] },
    Field { section: "ui", key: "prompt_new_workspace_name", id: "prompt_new_workspace_name", group: "other", label: "Ask for a space name", kind: "bool", default: "false", options: &[] },
    Field { section: "ui", key: "pane_borders", id: "pane_borders", group: "other", label: "Pane borders", kind: "bool", default: "true", options: &[] },
    Field { section: "ui", key: "pane_outer_borders", id: "pane_outer_borders", group: "other", label: "Outer pane borders", kind: "bool", default: "true", options: &[] },
    Field { section: "ui", key: "pane_gaps", id: "pane_gaps", group: "other", label: "Gaps between panes", kind: "bool", default: "true", options: &[] },
    Field { section: "ui", key: "pane_scrollbars", id: "pane_scrollbars", group: "other", label: "Pane scrollbars", kind: "bool", default: "true", options: &[] },
    Field { section: "ui", key: "hide_tab_bar_when_single_tab", id: "hide_tab_bar_when_single_tab", group: "other", label: "Hide the tab bar when there is one tab", kind: "bool", default: "false", options: &[] },
    Field { section: "ui", key: "tab_bar_position", id: "tab_bar_position", group: "other", label: "Tab bar", kind: "enum", default: "top", options: &["top", "bottom"] },
    Field { section: "ui", key: "agent_panel_sort", id: "agent_panel_sort", group: "other", label: "Agent order", kind: "enum", default: "spaces", options: &["spaces", "priority"] },
    Field { section: "ui", key: "status_indicators", id: "status_indicators", group: "indicators", label: "Agent status indicators", kind: "enum", default: "dots", options: &["dots", "symbols"] },
    Field { section: "ui", key: "mouse_capture", id: "mouse_capture", group: "other", label: "Capture the mouse", kind: "bool", default: "true", options: &[] },
    Field { section: "ui", key: "copy_on_select", id: "copy_on_select", group: "other", label: "Copy on select", kind: "bool", default: "true", options: &[] },
    Field { section: "ui", key: "sidebar_start_collapsed", id: "sidebar_start_collapsed", group: "other", label: "Start with the sidebar collapsed", kind: "bool", default: "false", options: &[] },
    Field { section: "ui", key: "show_agent_labels_on_pane_borders", id: "pane_labels", group: "pane-labels", label: "Agent border labels", kind: "bool", default: "false", options: &[] },
    Field { section: "ui.sound", key: "enabled", id: "sound_enabled", group: "sound", label: "Sound alerts", kind: "bool", default: "true", options: &[] },
    Field { section: "ui.sound", key: "path", id: "sound_path", group: "sound", label: "Sound file", kind: "string", default: "", options: &[] },
    Field { section: "ui.sound", key: "done_path", id: "sound_done_path", group: "sound", label: "Finished sound", kind: "string", default: "", options: &[] },
    Field { section: "ui.sound", key: "request_path", id: "sound_request_path", group: "sound", label: "Needs-attention sound", kind: "string", default: "", options: &[] },
    Field { section: "ui.toast", key: "delivery", id: "toast_delivery", group: "toasts", label: "Notification popups", kind: "enum", default: "off", options: &["off", "herdr", "terminal", "system"] },
    Field { section: "ui.toast", key: "delay_seconds", id: "toast_delay_seconds", group: "toasts", label: "Delay", kind: "int", default: "1", options: &[] },
    Field { section: "ui.toast.herdr", key: "position", id: "toast_position", group: "toasts", label: "In-app position", kind: "enum", default: "bottom-right", options: &["top-left", "top-right", "bottom-left", "bottom-right"] },
    Field { section: "ui.toast.clipboard", key: "enabled", id: "toast_clipboard", group: "toasts", label: "Clipboard toasts", kind: "bool", default: "true", options: &[] },
    Field { section: "session", key: "resume_agents_on_restore", id: "resume_agents_on_restore", group: "integrations", label: "Resume agents after a restart", kind: "bool", default: "true", options: &[] },
];

const KEYS: &[Field] = &[
    Field { section: "keys", key: "prefix", id: "prefix", group: "keys", label: "Prefix", kind: "string", default: "ctrl+b", options: &[] },
    Field { section: "keys", key: "help", id: "help", group: "keys", label: "Help", kind: "string", default: "prefix+?", options: &[] },
    Field { section: "keys", key: "settings", id: "settings", group: "keys", label: "Settings", kind: "string", default: "prefix+s", options: &[] },
    Field { section: "keys", key: "detach", id: "detach", group: "keys", label: "Detach", kind: "string", default: "prefix+q", options: &[] },
    Field { section: "keys", key: "reload_config", id: "reload_config", group: "keys", label: "Reload config", kind: "string", default: "prefix+shift+r", options: &[] },
    Field { section: "keys", key: "new_workspace", id: "new_workspace", group: "keys", label: "New space", kind: "string", default: "prefix+shift+n", options: &[] },
    Field { section: "keys", key: "rename_workspace", id: "rename_workspace", group: "keys", label: "Rename space", kind: "string", default: "prefix+shift+w", options: &[] },
    Field { section: "keys", key: "close_workspace", id: "close_workspace", group: "keys", label: "Close space", kind: "string", default: "prefix+shift+d", options: &[] },
    Field { section: "keys", key: "previous_workspace", id: "previous_workspace", group: "keys", label: "Previous space", kind: "string", default: "", options: &[] },
    Field { section: "keys", key: "next_workspace", id: "next_workspace", group: "keys", label: "Next space", kind: "string", default: "", options: &[] },
    Field { section: "keys", key: "switch_workspace", id: "switch_workspace", group: "keys", label: "Switch space", kind: "string", default: "", options: &[] },
    Field { section: "keys", key: "workspace_picker", id: "workspace_picker", group: "keys", label: "Space picker", kind: "string", default: "prefix+w", options: &[] },
    Field { section: "keys", key: "new_tab", id: "new_tab", group: "keys", label: "New tab", kind: "string", default: "prefix+c", options: &[] },
    Field { section: "keys", key: "rename_tab", id: "rename_tab", group: "keys", label: "Rename tab", kind: "string", default: "prefix+shift+t", options: &[] },
    Field { section: "keys", key: "previous_tab", id: "previous_tab", group: "keys", label: "Previous tab", kind: "string", default: "prefix+p", options: &[] },
    Field { section: "keys", key: "next_tab", id: "next_tab", group: "keys", label: "Next tab", kind: "string", default: "prefix+n", options: &[] },
    Field { section: "keys", key: "switch_tab", id: "switch_tab", group: "keys", label: "Switch tab", kind: "string", default: "prefix+1..9", options: &[] },
    Field { section: "keys", key: "close_tab", id: "close_tab", group: "keys", label: "Close tab", kind: "string", default: "prefix+shift+x", options: &[] },
    Field { section: "keys", key: "focus_pane_left", id: "focus_pane_left", group: "keys", label: "Focus pane left", kind: "string", default: "prefix+h", options: &[] },
    Field { section: "keys", key: "focus_pane_down", id: "focus_pane_down", group: "keys", label: "Focus pane down", kind: "string", default: "prefix+j", options: &[] },
    Field { section: "keys", key: "focus_pane_up", id: "focus_pane_up", group: "keys", label: "Focus pane up", kind: "string", default: "prefix+k", options: &[] },
    Field { section: "keys", key: "focus_pane_right", id: "focus_pane_right", group: "keys", label: "Focus pane right", kind: "string", default: "prefix+l", options: &[] },
    Field { section: "keys", key: "split_vertical", id: "split_vertical", group: "keys", label: "Split vertical", kind: "string", default: "prefix+v", options: &[] },
    Field { section: "keys", key: "split_horizontal", id: "split_horizontal", group: "keys", label: "Split horizontal", kind: "string", default: "prefix+minus", options: &[] },
    Field { section: "keys", key: "close_pane", id: "close_pane", group: "keys", label: "Close pane", kind: "string", default: "prefix+x", options: &[] },
    Field { section: "keys", key: "zoom", id: "zoom", group: "keys", label: "Zoom pane", kind: "string", default: "prefix+z", options: &[] },
    Field { section: "keys", key: "rename_pane", id: "rename_pane", group: "keys", label: "Rename pane", kind: "string", default: "prefix+shift+p", options: &[] },
    Field { section: "keys", key: "cycle_pane_next", id: "cycle_pane_next", group: "keys", label: "Next pane", kind: "string", default: "prefix+tab", options: &[] },
    Field { section: "keys", key: "cycle_pane_previous", id: "cycle_pane_previous", group: "keys", label: "Previous pane", kind: "string", default: "prefix+shift+tab", options: &[] },
    Field { section: "keys", key: "last_pane", id: "last_pane", group: "keys", label: "Last pane", kind: "string", default: "", options: &[] },
    Field { section: "keys", key: "resize_mode", id: "resize_mode", group: "keys", label: "Resize mode", kind: "string", default: "prefix+r", options: &[] },
    Field { section: "keys", key: "toggle_sidebar", id: "toggle_sidebar", group: "keys", label: "Toggle sidebar", kind: "string", default: "prefix+b", options: &[] },
    Field { section: "keys", key: "goto", id: "goto", group: "keys", label: "Go to", kind: "string", default: "prefix+g", options: &[] },
    Field { section: "keys", key: "edit_scrollback", id: "edit_scrollback", group: "keys", label: "Edit scrollback", kind: "string", default: "prefix+e", options: &[] },
    Field { section: "keys", key: "new_worktree", id: "new_worktree", group: "keys", label: "New worktree", kind: "string", default: "prefix+shift+g", options: &[] },
    Field { section: "keys", key: "previous_agent", id: "previous_agent", group: "keys", label: "Previous agent", kind: "string", default: "", options: &[] },
    Field { section: "keys", key: "next_agent", id: "next_agent", group: "keys", label: "Next agent", kind: "string", default: "", options: &[] },
];

pub fn config_path() -> PathBuf {
    if let Some(path) = env::var_os("HERDR_CONFIG_PATH") {
        return PathBuf::from(path);
    }
    crate::paths::herdr_config_dir()
        .unwrap_or_else(|_| PathBuf::from("herdr"))
        .join("config.toml")
}

pub fn document() -> Value {
    let text = std::fs::read_to_string(config_path()).unwrap_or_default();
    let theme = read_value(&text, "theme", "name").unwrap_or_else(|| "catppuccin".into());
    let settings = FIELDS
        .iter()
        .map(|field| field_json(&text, field))
        .collect::<Vec<_>>();
    let keys = KEYS.iter().map(|field| field_json(&text, field)).collect::<Vec<_>>();
    json!({
        "path": config_path().display().to_string(),
        "theme": theme,
        "themes": THEMES,
        "settings": settings,
        "keys": keys,
    })
}

pub async fn apply(body: &Value, session: Option<&str>) -> Result<Value, String> {
    if let Some(theme) = body.get("theme").and_then(Value::as_str) {
        if !THEMES.contains(&theme) {
            return Err("unknown theme".into());
        }
    }
    let path = config_path();
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    let mut next = current.clone();
    if let Some(theme) = body.get("theme").and_then(Value::as_str) {
        next = assign(&next, "theme", "name", theme_assignment(theme));
    }
    if let Some(settings) = body.get("settings").and_then(Value::as_object) {
        for field in FIELDS {
            let Some(value) = settings.get(field.id) else {
                continue;
            };
            next = assign(&next, field.section, field.key, assignment(field, value)?);
        }
    }
    if let Some(keys) = body.get("keys").and_then(Value::as_object) {
        for field in KEYS {
            let Some(value) = keys.get(field.id).and_then(Value::as_str) else {
                continue;
            };
            if value.chars().count() > 80 || value.contains('\n') || value.contains('"') {
                return Err(format!("{} is not a valid key binding", field.label));
            }
            next = assign(
                &next,
                "keys",
                field.key,
                if value == field.default {
                    None
                } else {
                    Some(format!("{} = \"{}\"", field.key, value))
                },
            );
        }
    }
    let reload_requested = body.get("reload").and_then(Value::as_bool).unwrap_or(false);
    if next != current {
        write_config(&path, &next)?;
        reload(session).await?;
    } else if reload_requested {
        reload(session).await?;
    }
    Ok(document())
}

fn field_json(text: &str, field: &Field) -> Value {
    let stored = read_value(text, field.section, field.key);
    let value = stored.unwrap_or_else(|| field.default.into());
    json!({
        "section": field.section,
        "key": field.id,
        "group": field.group,
        "label": field.label,
        "kind": field.kind,
        "value": json_value(field.kind, &value),
        "options": field.options,
    })
}

fn json_value(kind: &str, value: &str) -> Value {
    match kind {
        "bool" => json!(value == "true"),
        "int" => json!(value.parse::<i64>().unwrap_or(0)),
        _ => json!(value),
    }
}

fn assignment(field: &Field, value: &Value) -> Result<Option<String>, String> {
    let rendered = match field.kind {
        "bool" => {
            let flag = value.as_bool().ok_or_else(|| format!("{} needs a boolean", field.label))?;
            if flag == (field.default == "true") {
                return Ok(None);
            }
            flag.to_string()
        }
        "int" => {
            let number = value.as_i64().ok_or_else(|| format!("{} needs a number", field.label))?;
            if number < 1 || number > 500 {
                return Err(format!("{} is out of range", field.label));
            }
            if number.to_string() == field.default {
                return Ok(None);
            }
            number.to_string()
        }
        "enum" => {
            let text = value.as_str().unwrap_or("");
            if !field.options.contains(&text) {
                return Err(format!("{} is not a valid choice", field.label));
            }
            if text == field.default {
                return Ok(None);
            }
            format!("\"{text}\"")
        }
        _ => {
            let text = value.as_str().unwrap_or("");
            if text.chars().count() > 240 || text.contains('\n') || text.contains('"') {
                return Err(format!("{} contains unsupported characters", field.label));
            }
            if text == field.default {
                return Ok(None);
            }
            format!("\"{text}\"")
        }
    };
    Ok(Some(format!("{} = {rendered}", field.key)))
}

fn theme_assignment(theme: &str) -> Option<String> {
    if theme == "catppuccin" {
        None
    } else {
        Some(format!("name = \"{theme}\""))
    }
}

fn read_value(text: &str, section: &str, key: &str) -> Option<String> {
    let mut current = String::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(name) = table_name(trimmed) {
            current = name;
            continue;
        }
        if current != section || trimmed.starts_with('#') {
            continue;
        }
        let Some((found, raw)) = split_assignment(trimmed) else {
            continue;
        };
        if found == key {
            return Some(unquote(raw));
        }
    }
    None
}

pub fn assign(text: &str, section: &str, key: &str, line: Option<String>) -> String {
    let mut rows: Vec<String> = text.lines().map(str::to_string).collect();
    let mut current = String::new();
    let mut section_at = None;
    let mut found = None;
    let mut section_end = rows.len();
    for (index, row) in rows.iter().enumerate() {
        let trimmed = row.trim();
        if let Some(name) = table_name(trimmed) {
            if current == section {
                section_end = index;
                break;
            }
            current = name;
            if current == section {
                section_at = Some(index);
                section_end = rows.len();
            }
            continue;
        }
        if current != section || trimmed.starts_with('#') {
            continue;
        }
        if let Some((found_key, _)) = split_assignment(trimmed) {
            if found_key == key {
                found = Some(index);
            }
        }
    }
    if let Some(index) = found {
        match line {
            Some(line) => rows[index] = line,
            None => {
                rows.remove(index);
                drop_empty_table(&mut rows, section);
            }
        }
    } else if let Some(line) = line {
        let at = section_at.map(|index| index + 1).unwrap_or(0);
        if section_at.is_none() && !section.is_empty() {
            if !rows.is_empty() && !rows.last().is_some_and(|row| row.is_empty()) {
                rows.push(String::new());
            }
            rows.push(format!("[{section}]"));
            rows.push(line);
        } else if section.is_empty() {
            rows.insert(section_end.min(at), line);
        } else {
            rows.insert(at, line);
        }
    }
    let mut out = rows.join("\n");
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

fn drop_empty_table(rows: &mut Vec<String>, section: &str) {
    if section.is_empty() {
        return;
    }
    let mut current = String::new();
    let mut header = None;
    let mut end = rows.len();
    let mut has_content = false;
    for (index, row) in rows.iter().enumerate() {
        let trimmed = row.trim();
        if let Some(name) = table_name(trimmed) {
            if current == section {
                end = index;
                break;
            }
            current = name;
            if current == section {
                header = Some(index);
            }
            continue;
        }
        if current == section && !trimmed.is_empty() {
            has_content = true;
        }
    }
    let Some(header) = header else {
        return;
    };
    if has_content {
        return;
    }
    rows.drain(header..end);
    if header > 0 && rows.get(header - 1).is_some_and(|row| row.trim().is_empty()) {
        let next_is_blank = rows.get(header).is_none_or(|row| row.trim().is_empty());
        if next_is_blank {
            rows.remove(header - 1);
        }
    }
}

fn table_name(line: &str) -> Option<String> {
    let line = line.trim();
    if line.starts_with('[') && line.ends_with(']') && !line.starts_with("[[") {
        Some(line[1..line.len() - 1].trim().to_string())
    } else {
        None
    }
}

fn split_assignment(line: &str) -> Option<(&str, &str)> {
    let (key, value) = line.split_once('=')?;
    let key = key.trim();
    if key.is_empty() || key.contains(' ') || key.contains('#') {
        return None;
    }
    Some((key, value.trim()))
}

fn unquote(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2 && value.starts_with('"') {
        let end = value.rfind('"').unwrap_or(value.len());
        if end > 0 {
            return value[1..end].to_string();
        }
    }
    value.split('#').next().unwrap_or(value).trim().to_string()
}

fn write_config(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    std::fs::write(path, text).map_err(|err| err.to_string())
}

async fn reload(session: Option<&str>) -> Result<(), String> {
    let mut command = Command::new("herdr");
    command.kill_on_drop(false);
    if let Some(session) = session {
        command.arg("--session").arg(session);
        command.env("HERDR_SESSION", session);
    } else {
        command.env_remove("HERDR_SESSION");
    }
    command.env_remove("HERDR_SOCKET_PATH");
    command.args(["server", "reload-config"]);
    let output = command.output().await.map_err(|err| err.to_string())?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr);
    let detail = detail.trim();
    if detail.is_empty() {
        Err("Herdr did not reload its config".into())
    } else {
        Err(detail.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assignment_replaces_a_value_and_drops_back_to_the_default() {
        let text = "onboarding = false\n\n[theme]\nname = \"dracula\"\n";
        let updated = assign(text, "theme", "name", Some("name = \"nord\"".into()));
        assert!(updated.contains("name = \"nord\""));
        let cleared = assign(&updated, "theme", "name", None);
        assert!(!cleared.contains("[theme]"));
        assert!(!cleared.lines().any(|line| line.trim_start().starts_with("name")));
        assert!(cleared.contains("onboarding = false"));
    }

    #[test]
    fn assignment_creates_a_missing_table() {
        let updated = assign("onboarding = false\n", "keys", "prefix", Some("prefix = \"f12\"".into()));
        assert!(updated.contains("[keys]"));
        assert!(updated.contains("prefix = \"f12\""));
        assert_eq!(read_value(&updated, "keys", "prefix").as_deref(), Some("f12"));
    }
}
