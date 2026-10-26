use std::env;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use serde_json::{json, Value};
use tokio::process::Command;

#[derive(Clone)]
struct Choice {
    value: String,
    detail: String,
}

#[derive(Clone)]
struct Spec {
    section: String,
    key: String,
    id: String,
    group: String,
    label: String,
    help: String,
    kind: String,
    default_value: String,
    default_raw: String,
    options: Vec<String>,
    choices: Vec<Choice>,
}

#[derive(Clone)]
struct Catalog {
    fields: Vec<Spec>,
    themes: Vec<String>,
    default_theme: String,
}

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
    let catalog = catalog();
    let theme = read_value(&text, "theme", "name").unwrap_or_else(|| catalog.default_theme.clone());
    let mut themes = catalog.themes.clone();
    if !themes.iter().any(|name| name == &theme) {
        themes.insert(0, theme.clone());
    }
    let settings = catalog
        .fields
        .iter()
        .filter(|field| field.section != "keys" && !tui_only(&field.section, &field.key))
        .map(|field| field_json(&text, field))
        .collect::<Vec<_>>();
    let keys = catalog
        .fields
        .iter()
        .filter(|field| field.section == "keys" && !tui_key(&field.key))
        .map(|field| field_json(&text, field))
        .collect::<Vec<_>>();
    json!({
        "path": config_path().display().to_string(),
        "theme": theme,
        "themes": themes,
        "settings": settings,
        "keys": keys,
        "spaceRows": space_rows(&text, &catalog),
    })
}

pub async fn apply(body: &Value, session: Option<&str>) -> Result<Value, String> {
    if let Some(theme) = body.get("theme").and_then(Value::as_str) {
        if !theme_ok(theme) {
            return Err("unknown theme".into());
        }
    }
    let path = config_path();
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    let catalog = catalog();
    let mut next = current.clone();
    if let Some(theme) = body.get("theme").and_then(Value::as_str) {
        next = assign(
            &next,
            "theme",
            "name",
            if theme == catalog.default_theme {
                None
            } else {
                Some(format!("name = \"{theme}\""))
            },
        );
    }
    if let Some(settings) = body.get("settings").and_then(Value::as_object) {
        for field in catalog.fields.iter().filter(|field| field.section != "keys") {
            let Some(value) = settings.get(&field.id) else {
                continue;
            };
            next = assign(&next, &field.section, &field.key, assignment(field, value)?);
        }
    }
    if let Some(keys) = body.get("keys").and_then(Value::as_object) {
        for field in catalog.fields.iter().filter(|field| field.section == "keys") {
            let Some(value) = keys.get(&field.id).and_then(Value::as_str) else {
                continue;
            };
            if value.chars().count() > 80 || value.contains('\n') || value.contains('"') {
                return Err(format!("{} is not a valid key binding", field.label));
            }
            next = assign(
                &next,
                "keys",
                &field.key,
                if value == field.default_value {
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

fn catalog() -> Arc<Catalog> {
    static CACHED: OnceLock<Arc<Catalog>> = OnceLock::new();
    CACHED
        .get_or_init(|| Arc::new(parse_catalog(&default_config_text())))
        .clone()
}

fn default_config_text() -> String {
    match std::process::Command::new("herdr")
        .arg("--default-config")
        .output()
    {
        Ok(output) if output.status.success() => String::from_utf8_lossy(&output.stdout).into_owned(),
        _ => String::new(),
    }
}

fn parse_catalog(text: &str) -> Catalog {
    let mut section = String::new();
    let mut comments: Vec<String> = Vec::new();
    let mut fields = Vec::new();
    let mut themes = Vec::new();
    let mut theme_lines = false;
    let mut builtin_buf: Option<String> = None;
    let mut token_options: Vec<String> = Vec::new();

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            comments.clear();
            theme_lines = false;
            continue;
        }
        let uncommented = trimmed.strip_prefix('#').map(str::trim).unwrap_or(trimmed);
        if uncommented.is_empty() {
            continue;
        }
        if let Some(buf) = builtin_buf.as_mut() {
            buf.push(' ');
            buf.push_str(uncommented);
            comments.push(uncommented.to_string());
            if !uncommented.trim_end().ends_with(',') {
                token_options = builtin_names(buf);
                builtin_buf = None;
            }
            continue;
        }
        if uncommented.starts_with("[[") {
            section = format!("skip:{uncommented}");
            comments.clear();
            continue;
        }
        if let Some(name) = table_name(uncommented) {
            section = name;
            comments.clear();
            theme_lines = false;
            continue;
        }
        if let Some((key, raw)) = split_assignment(uncommented) {
            let literal = strip_inline_comment(raw);
            if is_literal(literal) && !section.starts_with("skip:") && !skipped_section(&section) {
                if key == "rows" && literal.starts_with('[') {
                    let options = token_options.clone();
                    token_options.clear();
                    if !options.is_empty() {
                        fields.push(rows_field(&section, literal, &options, &comments));
                    }
                    comments.clear();
                    continue;
                }
                if !literal.starts_with('[') && !literal.starts_with('{') {
                    let default_value = unquote(literal);
                    if section == "theme" && matches!(key, "name" | "dark_name" | "light_name") {
                        push_theme(&mut themes, &default_value);
                    }
                    let help_lines: Vec<String> = comments
                        .iter()
                        .filter(|line| choice_line(line).is_none())
                        .cloned()
                        .collect();
                    if theme_lines {
                        for line in &help_lines {
                            push_theme_list(&mut themes, line);
                        }
                    }
                    let help = help_text(&help_lines);
                    let (kind, options, choices) = classify(&section, &help, &comments, &default_value, literal);
                    fields.push(Spec {
                        section: section.clone(),
                        key: key.to_string(),
                        id: key.to_string(),
                        group: group_for(&section, key),
                        label: label_for(key),
                        help,
                        kind,
                        default_value,
                        default_raw: literal.to_string(),
                        options,
                        choices,
                    });
                    comments.clear();
                    theme_lines = false;
                    continue;
                }
            }
        }
        if uncommented.to_ascii_lowercase().contains("built-in themes:") {
            theme_lines = true;
            push_theme_list(&mut themes, uncommented);
        } else if theme_lines && !uncommented.contains('=') {
            push_theme_list(&mut themes, uncommented);
        } else if uncommented.contains('=') {
            theme_lines = false;
        }
        if uncommented.contains("Built-ins are") {
            if uncommented.trim_end().ends_with(',') {
                builtin_buf = Some(uncommented.to_string());
            } else {
                token_options = builtin_names(uncommented);
            }
        }
        comments.push(uncommented.to_string());
    }
    finish_ids(&mut fields);
    let default_theme = fields
        .iter()
        .find(|field| field.section == "theme" && field.key == "name")
        .map(|field| field.default_value.clone())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "catppuccin".into());
    fields.retain(|field| !(field.section == "theme" && field.key == "name"));
    Catalog {
        fields,
        themes,
        default_theme,
    }
}

fn rows_field(section: &str, literal: &str, options: &[String], comments: &[String]) -> Spec {
    let label = if section.contains("agent") {
        "Agent rows".into()
    } else if section.contains("space") {
        "Space rows".into()
    } else {
        "Rows".into()
    };
    let help_lines: Vec<&String> = comments.iter().filter(|line| choice_line(line).is_none()).collect();
    Spec {
        section: section.to_string(),
        key: "rows".into(),
        id: "rows".into(),
        group: group_for(section, "rows"),
        label,
        help: help_text(&help_lines.into_iter().cloned().collect::<Vec<_>>()),
        kind: "tokens".into(),
        default_value: selected_tokens(literal, options),
        default_raw: literal.to_string(),
        options: options.to_vec(),
        choices: Vec::new(),
    }
}

fn finish_ids(fields: &mut [Spec]) {
    let mut counts = std::collections::HashMap::<String, usize>::new();
    for field in fields.iter() {
        *counts.entry(field.key.clone()).or_insert(0) += 1;
    }
    for field in fields {
        if counts.get(&field.key).copied().unwrap_or(1) > 1 {
            field.id = format!("{}.{}", field.section, field.key);
            if field.kind == "tokens" {
                continue;
            }
            let tail = field
                .section
                .split('.')
                .next_back()
                .unwrap_or(&field.section)
                .replace('_', " ");
            if !tail.is_empty() {
                field.label = format!("{} {}", capitalize(&tail), field.label.to_lowercase());
            }
        }
    }
}

fn classify(
    section: &str,
    help: &str,
    comments: &[String],
    default_value: &str,
    literal: &str,
) -> (String, Vec<String>, Vec<Choice>) {
    if section == "keys" {
        return ("string".into(), Vec::new(), Vec::new());
    }
    if literal == "true" || literal == "false" {
        return ("bool".into(), Vec::new(), Vec::new());
    }
    if is_int(literal) {
        return ("int".into(), Vec::new(), Vec::new());
    }
    let choices: Vec<Choice> = comments.iter().filter_map(|line| choice_line(line)).collect();
    if choices.len() >= 2 && choices.iter().any(|choice| choice.value == default_value) {
        let options = choices.iter().map(|choice| choice.value.clone()).collect();
        return ("enum".into(), options, choices);
    }
    let quoted = quoted_words(help);
    if (2..=8).contains(&quoted.len())
        && quoted.iter().any(|word| word == default_value)
        && !help.to_ascii_lowercase().contains("path")
    {
        let choices = quoted
            .iter()
            .map(|word| Choice {
                value: word.clone(),
                detail: String::new(),
            })
            .collect();
        return ("enum".into(), quoted, choices);
    }
    let pipes = pipe_words(help);
    if pipes.len() >= 2 && pipes.iter().any(|word| word == default_value) {
        let choices = pipes
            .iter()
            .map(|word| Choice {
                value: word.clone(),
                detail: String::new(),
            })
            .collect();
        return ("enum".into(), pipes, choices);
    }
    ("string".into(), Vec::new(), Vec::new())
}

/// Settings that only change the Herdr terminal. Herdr Panels replaces that
/// terminal, so these stay in Herdr's file and out of this dialog. A new Herdr
/// key is shown until it is added here.
const TUI_KEYS: &[&str] = &[
    "accent",
    "allow_nested",
    "auto_switch",
    "cjk_ime_agents",
    "cjk_ime_cursor_shape",
    "confirm_close",
    "copy_on_select",
    "dark_name",
    "headless_cols",
    "headless_rows",
    "hide_tab_bar_when_single_tab",
    "host_cursor",
    "kitty_graphics",
    "light_name",
    "mobile_width_threshold",
    "mouse_capture",
    "mouse_scroll_lines",
    "onboarding",
    "pane_borders",
    "pane_gaps",
    "pane_outer_borders",
    "pane_scrollbars",
    "prompt_new_tab_name",
    "prompt_new_workspace_name",
    "redraw_on_focus_gained",
    "reveal_hidden_cursor_for_cjk_ime",
    "right_click_passthrough_modifier",
    "row_gap",
    "show_agent_labels_on_pane_borders",
    "sidebar_collapsed_mode",
    "sidebar_max_width",
    "sidebar_min_width",
    "sidebar_start_collapsed",
    "sidebar_width",
    "switch_ascii_input_source_in_prefix",
    "tab_bar_position",
    "tab_bar_right",
    "tab_bar_right_separator",
    "window_title",
];

/// Whole tables that draw inside the Herdr terminal.
const TUI_SECTIONS: &[&str] = &["ui.toast.herdr", "ui.toast.clipboard"];

/// Key bindings that only the Herdr terminal handles. Bindings this window
/// runs are kept, because they are stored in the same Herdr file.
const TUI_KEYBINDS: &[&str] = &[
    "clear_pane",
    "cycle_pane_next",
    "cycle_pane_previous",
    "detach",
    "edit_scrollback",
    "focus_agent",
    "goto",
    "help",
    "last_pane",
    "move_tab_next",
    "move_tab_previous",
    "navigate_pane_down",
    "navigate_pane_left",
    "navigate_pane_right",
    "navigate_pane_up",
    "navigate_workspace_down",
    "navigate_workspace_up",
    "new_worktree",
    "next_agent",
    "open_notification_target",
    "open_worktree",
    "previous_agent",
    "remote_image_paste",
    "remove_worktree",
    "rename_pane",
    "rename_tab",
    "resize_mode",
    "resize_pane_down",
    "resize_pane_left",
    "resize_pane_right",
    "resize_pane_up",
    "toggle_sidebar",
    "type",
    "workspace_picker",
    "zoom",
];

fn tui_only(section: &str, key: &str) -> bool {
    TUI_SECTIONS.iter().any(|prefix| section == *prefix || section.starts_with(&format!("{prefix}.")))
        || TUI_KEYS.binary_search(&key).is_ok()
}

fn tui_key(key: &str) -> bool {
    TUI_KEYBINDS.binary_search(&key).is_ok()
}

/// "both" changes this window and Herdr. Everything else still shown belongs to Herdr.
fn audience(section: &str, key: &str) -> &'static str {
    const SHARED: &[(&str, &str)] = &[
        ("ui", "status_indicators"),
        ("ui", "agent_panel_sort"),
        ("ui.sidebar.spaces", "rows"),
        ("ui.sidebar.agents", "rows"),
    ];
    if section == "keys" || SHARED.contains(&(section, key)) {
        "both"
    } else {
        "herdr"
    }
}

fn group_for(section: &str, key: &str) -> String {
    if key == "status_indicators" || key == "agent_panel_sort" {
        return "indicators".into();
    }
    if section == "ui.sound" || section.starts_with("ui.sound.") {
        return "sound".into();
    }
    if section == "ui.toast" || section.starts_with("ui.toast.") {
        return "toasts".into();
    }
    if key == "show_agent_labels_on_pane_borders" || section.starts_with("ui.sidebar") {
        return "pane-labels".into();
    }
    if section == "theme" {
        return "theme".into();
    }
    if section.is_empty() {
        return "general".into();
    }
    let top = section.split('.').next().unwrap_or(section);
    if top == "ui" {
        "interface".into()
    } else {
        top.into()
    }
}

fn skipped_section(section: &str) -> bool {
    section.starts_with("theme.custom") || section.starts_with("keys.command") || section == "keys.indexed"
}

fn field_json(text: &str, field: &Spec) -> Value {
    let stored = read_value(text, &field.section, &field.key);
    let mut options = field.options.clone();
    let mut choices = field.choices.clone();
    let value = match field.kind.as_str() {
        "tokens" => stored
            .as_deref()
            .map(|raw| selected_tokens(raw, &field.options))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| field.default_value.clone()),
        _ => stored.unwrap_or_else(|| field.default_value.clone()),
    };
    if field.kind == "enum" && !options.iter().any(|option| option == &value) && !value.is_empty() {
        options.insert(0, value.clone());
        choices.insert(
            0,
            Choice {
                value: value.clone(),
                detail: String::new(),
            },
        );
    }
    json!({
        "section": field.section,
        "key": field.id,
        "name": field.key,
        "group": field.group,
        "label": field.label,
        "help": field.help,
        "kind": field.kind,
        "audience": audience(&field.section, &field.key),
        "value": json_value(&field.kind, &value),
        "options": options,
        "choices": choices.into_iter().map(|choice| json!({"value": choice.value, "detail": choice.detail})).collect::<Vec<_>>(),
    })
}

fn json_value(kind: &str, value: &str) -> Value {
    match kind {
        "bool" => json!(value == "true"),
        "int" => json!(value.parse::<i64>().unwrap_or(0)),
        _ => json!(value),
    }
}

fn assignment(field: &Spec, value: &Value) -> Result<Option<String>, String> {
    let rendered = match field.kind.as_str() {
        "bool" => {
            let flag = value
                .as_bool()
                .ok_or_else(|| format!("{} needs a boolean", field.label))?;
            if flag == (field.default_value == "true") {
                return Ok(None);
            }
            flag.to_string()
        }
        "int" => {
            let number = value
                .as_i64()
                .ok_or_else(|| format!("{} needs a number", field.label))?;
            if number.to_string() == field.default_value {
                return Ok(None);
            }
            number.to_string()
        }
        "enum" => {
            let text = value.as_str().unwrap_or("");
            if !field.options.iter().any(|option| option == text) {
                return Err(format!("{} is not a valid choice", field.label));
            }
            if text == field.default_value {
                return Ok(None);
            }
            format!("\"{text}\"")
        }
        "tokens" => {
            let text = value.as_str().unwrap_or("");
            let enabled = normalize_tokens(&field.options, text);
            let default_tokens = normalize_tokens(&field.options, &field.default_value);
            if enabled == default_tokens {
                return Ok(None);
            }
            render_token_rows(&field.default_raw, &field.options, &enabled)
        }
        _ => {
            let text = value.as_str().unwrap_or("");
            if text.chars().count() > 400 || text.contains('\n') || text.contains('\r') || text.contains('"') {
                return Err(format!("{} contains unsupported characters", field.label));
            }
            if text == field.default_value {
                return Ok(None);
            }
            format!("\"{text}\"")
        }
    };
    Ok(Some(format!("{} = {rendered}", field.key)))
}

fn space_rows(text: &str, catalog: &Catalog) -> Vec<Vec<String>> {
    let raw = read_value(text, "ui.sidebar.spaces", "rows").or_else(|| {
        catalog
            .fields
            .iter()
            .find(|field| field.section == "ui.sidebar.spaces" && field.key == "rows")
            .map(|field| field.default_raw.clone())
    });
    let rows = raw.map(|raw| parse_rows(&raw)).unwrap_or_default();
    if rows.is_empty() {
        vec![
            vec!["state_icon".into(), "workspace".into()],
            vec!["branch".into(), "git_status".into()],
        ]
    } else {
        rows
    }
}

fn parse_rows(raw: &str) -> Vec<Vec<String>> {
    raw.split("],")
        .map(quoted_words)
        .filter(|row| !row.is_empty())
        .collect()
}

fn selected_tokens(raw: &str, options: &[String]) -> String {
    let present = quoted_words(raw);
    options
        .iter()
        .filter(|option| present.iter().any(|token| token == *option))
        .cloned()
        .collect::<Vec<_>>()
        .join(",")
}

fn normalize_tokens(options: &[String], value: &str) -> Vec<String> {
    let enabled: Vec<&str> = value.split(',').map(str::trim).filter(|item| !item.is_empty()).collect();
    options
        .iter()
        .filter(|option| enabled.iter().any(|item| item == option))
        .cloned()
        .collect()
}

fn render_token_rows(default_raw: &str, options: &[String], enabled: &[String]) -> String {
    let mut rows = parse_rows(default_raw);
    if rows.is_empty() {
        rows.push(Vec::new());
    }
    for row in &mut rows {
        row.retain(|token| enabled.iter().any(|item| item == token));
    }
    let extras: Vec<String> = options
        .iter()
        .filter(|option| enabled.iter().any(|item| item == *option))
        .filter(|option| !rows.iter().flatten().any(|token| token == *option))
        .cloned()
        .collect();
    if let Some(last) = rows.last_mut() {
        last.extend(extras);
    }
    rows.retain(|row| !row.is_empty());
    let body = rows
        .iter()
        .map(|row| {
            let items = row
                .iter()
                .map(|token| format!("\"{token}\""))
                .collect::<Vec<_>>()
                .join(", ");
            format!("[{items}]")
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!("[{body}]")
}

fn theme_ok(theme: &str) -> bool {
    let mut chars = theme.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    theme.len() <= 40
        && (first.is_ascii_lowercase() || first.is_ascii_digit())
        && theme
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
}

fn push_theme(themes: &mut Vec<String>, name: &str) {
    if theme_ok(name) && !themes.iter().any(|theme| theme == name) {
        themes.push(name.to_string());
    }
}

fn push_theme_list(themes: &mut Vec<String>, text: &str) {
    let text = text.split_once(':').map(|(_, rest)| rest).unwrap_or(text);
    for part in text.split(',') {
        push_theme(themes, part.trim().trim_matches('.'));
    }
}

fn builtin_names(text: &str) -> Vec<String> {
    let Some((_, rest)) = text.split_once("Built-ins are") else {
        return Vec::new();
    };
    let mut names = Vec::new();
    for part in rest.split(',') {
        for piece in part.split(" and ") {
            let token = piece.trim().trim_end_matches('.').trim();
            if !token.is_empty() && token.chars().all(|ch| ch.is_ascii_lowercase() || ch == '_') {
                names.push(token.to_string());
            }
        }
    }
    names
}

fn choice_line(line: &str) -> Option<Choice> {
    let (key, raw) = split_assignment(line)?;
    let literal = strip_inline_comment(raw);
    if is_literal(literal) {
        return None;
    }
    if !key
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-')
    {
        return None;
    }
    Some(Choice {
        value: key.to_string(),
        detail: literal.trim().to_string(),
    })
}

fn quoted_words(text: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find('"') {
        let after = &rest[start + 1..];
        let Some(end) = after.find('"') else {
            break;
        };
        let word = &after[..end];
        if !word.is_empty()
            && word.len() <= 40
            && word
                .chars()
                .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-')
            && !words.iter().any(|found: &String| found == word)
        {
            words.push(word.to_string());
        }
        rest = &after[end + 1..];
    }
    words
}

fn pipe_words(text: &str) -> Vec<String> {
    if !text.contains('|') {
        return Vec::new();
    }
    text.split('|')
        .filter_map(|part| {
            let word = part.split_whitespace().next_back()?.trim_matches(|ch: char| {
                !ch.is_ascii_lowercase() && ch != '_' && !ch.is_ascii_digit()
            });
            if word.is_empty() || word.len() > 20 {
                None
            } else {
                Some(word.to_string())
            }
        })
        .collect()
}

fn is_literal(raw: &str) -> bool {
    let raw = raw.trim();
    raw == "true" || raw == "false" || is_int(raw) || raw.starts_with('"') || raw.starts_with('[') || raw.starts_with('{')
}

fn is_int(raw: &str) -> bool {
    let raw = raw.trim().strip_prefix('-').unwrap_or(raw.trim());
    !raw.is_empty() && raw.chars().all(|ch| ch.is_ascii_digit())
}

fn strip_inline_comment(raw: &str) -> &str {
    let raw = raw.trim();
    if let Some(rest) = raw.strip_prefix('"') {
        if let Some(end) = rest.find('"') {
            return raw[..=end + 1].trim();
        }
    }
    raw.split('#').next().unwrap_or(raw).trim()
}

fn help_text(lines: &[String]) -> String {
    let text = lines.join(" ");
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    text.chars().take(500).collect()
}

fn label_for(key: &str) -> String {
    capitalize(&key.replace('_', " "))
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    first.to_uppercase().collect::<String>() + chars.as_str()
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
            return Some(unquote(strip_inline_comment(raw)));
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
    if header > 0
        && rows
            .get(header - 1)
            .is_some_and(|row| row.trim().is_empty())
    {
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

    const SAMPLE: &str = r#"
# onboarding = true

[theme]
# Built-in themes: catppuccin, terminal, tokyo-night,
#                  dracula, vesper
# name = "catppuccin"
# light_name = "catppuccin-latte"

[keys]
# Examples: "ctrl+b", "f12", "esc"
# prefix = "ctrl+b"

[ui]
# Agent status indicators: "dots" preserves the compact color marks; "symbols" uses
# distinct static glyphs for blocked, working, done, idle, and unknown states.
# status_indicators = "dots"
# Agent panel ordering: "spaces" or "priority".
# "workspaces" is accepted as an alias for "spaces".
# agent_panel_sort = "spaces"
# show_agent_labels_on_pane_borders = false

# Expanded agent rows. Built-ins are state_icon, state_text, machine, workspace, tab,
# pane, agent, terminal_title, and terminal_title_stripped.
[ui.sidebar.agents]
# row_gap = 0
# rows = [["state_icon", "machine", "workspace", "tab"], ["agent"]]

# Expanded space rows. Built-ins are state_icon, state_text, workspace, branch, and git_status.
[ui.sidebar.spaces]
# rows = [["state_icon", "workspace"], ["branch", "git_status"]]

[ui.toast]
# off = disable pop-up notifications
# herdr = show in-app toasts
# terminal = ask the outer terminal to show a desktop notification
# system = ask the OS notification service directly
# delivery = "off"
# delay_seconds = 1

[ui.sound]
# enabled = true
# path = ""
"#;

    #[test]
    fn catalog_follows_the_default_config_text() {
        let catalog = parse_catalog(SAMPLE);
        let indicators = catalog
            .fields
            .iter()
            .find(|field| field.key == "status_indicators")
            .unwrap();
        assert_eq!(indicators.group, "indicators");
        assert_eq!(indicators.kind, "enum");
        assert_eq!(indicators.options, ["dots", "symbols"]);
        let delivery = catalog.fields.iter().find(|field| field.key == "delivery").unwrap();
        assert_eq!(delivery.group, "toasts");
        assert_eq!(
            delivery.options,
            ["off", "herdr", "terminal", "system"]
        );
        assert!(delivery.choices.iter().any(|choice| choice.value == "system" && choice.detail.contains("OS")));
        let prefix = catalog.fields.iter().find(|field| field.key == "prefix").unwrap();
        assert_eq!(prefix.kind, "string");
        assert!(catalog.themes.iter().any(|theme| theme == "catppuccin"));
        assert!(catalog.themes.iter().any(|theme| theme == "catppuccin-latte"));
        assert!(catalog.themes.iter().any(|theme| theme == "vesper"));
        let spaces = catalog
            .fields
            .iter()
            .find(|field| field.section == "ui.sidebar.spaces" && field.key == "rows")
            .unwrap();
        assert_eq!(spaces.kind, "tokens");
        assert!(spaces.options.iter().any(|token| token == "branch"));
        assert!(spaces.default_value.split(',').any(|token| token == "branch"));
        let agents = catalog
            .fields
            .iter()
            .find(|field| field.section == "ui.sidebar.agents" && field.key == "rows")
            .unwrap();
        assert!(agents.options.iter().any(|token| token == "terminal_title_stripped"));
        assert_ne!(spaces.id, agents.id);
        let enabled = catalog
            .fields
            .iter()
            .filter(|field| field.key == "enabled")
            .collect::<Vec<_>>();
        assert_eq!(enabled.len(), 1);
        assert_eq!(enabled[0].kind, "bool");
    }

    #[test]
    fn installed_herdr_exposes_its_dialog_fields() {
        let text = default_config_text();
        if text.is_empty() {
            return;
        }
        let catalog = parse_catalog(&text);
        let indicators = catalog.fields.iter().find(|field| field.key == "status_indicators").unwrap();
        assert_eq!(indicators.options, ["dots", "symbols"]);
        let delivery = catalog.fields.iter().find(|field| field.key == "delivery").unwrap();
        assert_eq!(delivery.options, ["off", "herdr", "terminal", "system"]);
        let spaces = catalog
            .fields
            .iter()
            .find(|field| field.section == "ui.sidebar.spaces" && field.key == "rows")
            .unwrap();
        assert!(spaces.options.iter().any(|token| token == "branch"));
        assert!(spaces.options.iter().any(|token| token == "git_status"));
        let prefix = catalog.fields.iter().find(|field| field.section == "keys" && field.key == "prefix").unwrap();
        assert_eq!(prefix.kind, "string");
        assert!(catalog.themes.len() >= 8, "themes: {:?}", catalog.themes);
        assert!(catalog.fields.iter().any(|field| field.kind == "bool" && field.group == "sound"));
    }

    #[test]
    fn token_rows_keep_their_shape_when_a_token_is_removed() {
        let raw = r#"[["state_icon", "workspace"], ["branch", "git_status"]]"#;
        let options = ["state_icon", "workspace", "branch", "git_status"]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>();
        let rendered = render_token_rows(raw, &options, &["state_icon".into(), "workspace".into(), "branch".into()]);
        assert_eq!(rendered, r#"[["state_icon", "workspace"], ["branch"]]"#);
    }

    #[test]
    fn assignment_replaces_a_value_and_drops_back_to_the_default() {
        let text = "onboarding = false\n\n[theme]\nname = \"dracula\"\n";
        let updated = assign(text, "theme", "name", Some("name = \"nord\"".into()));
        assert!(updated.contains("name = \"nord\""));
        let cleared = assign(&updated, "theme", "name", None);
        assert!(!cleared.contains("[theme]"));
        assert!(!cleared
            .lines()
            .any(|line| line.trim_start().starts_with("name")));
        assert!(cleared.contains("onboarding = false"));
    }

    #[test]
    fn exclusion_lists_are_sorted_and_split_the_terminal_from_the_server() {
        let mut keys = TUI_KEYS.to_vec();
        keys.sort_unstable();
        assert_eq!(keys, TUI_KEYS);
        let mut binds = TUI_KEYBINDS.to_vec();
        binds.sort_unstable();
        assert_eq!(binds, TUI_KEYBINDS);
        assert!(tui_only("ui", "mouse_capture"));
        assert!(tui_only("ui", "pane_borders"));
        assert!(tui_only("theme", "auto_switch"));
        assert!(tui_only("ui.toast.herdr", "position"));
        assert!(tui_only("ui.toast.clipboard", "enabled"));
        assert!(!tui_only("ui", "status_indicators"));
        assert!(!tui_only("ui", "agent_panel_sort"));
        assert!(!tui_only("ui.sidebar.spaces", "rows"));
        assert!(!tui_only("ui.sidebar.agents", "rows"));
        assert!(!tui_only("terminal", "default_shell"));
        assert!(!tui_only("session", "resume_agents_on_restore"));
        assert!(!tui_only("ui.sound", "enabled"));
        assert!(tui_key("zoom"));
        assert!(tui_key("toggle_sidebar"));
        assert!(tui_key("type"));
        assert!(!tui_key("prefix"));
        assert!(!tui_key("new_workspace"));
        assert!(!tui_key("split_vertical"));
        assert_eq!(audience("ui", "status_indicators"), "both");
        assert_eq!(audience("ui.sidebar.spaces", "rows"), "both");
        assert_eq!(audience("keys", "prefix"), "both");
        assert_eq!(audience("session", "resume_agents_on_restore"), "herdr");
        assert_eq!(audience("ui.toast", "delivery"), "herdr");
    }

    #[test]
    fn assignment_creates_a_missing_table() {
        let updated = assign(
            "onboarding = false\n",
            "keys",
            "prefix",
            Some("prefix = \"f12\"".into()),
        );
        assert!(updated.contains("[keys]"));
        assert!(updated.contains("prefix = \"f12\""));
        assert_eq!(
            read_value(&updated, "keys", "prefix").as_deref(),
            Some("f12")
        );
    }
}
