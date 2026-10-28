use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyAction {
    Text(String),
    Keys(Vec<String>),
    Ignore,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientInput {
    Key {
        key: String,
        #[serde(default)]
        ctrl: bool,
        #[serde(default)]
        alt: bool,
        #[serde(default)]
        shift: bool,
        #[serde(default)]
        meta: bool,
    },
    Text {
        text: String,
    },
    Keys {
        keys: Vec<String>,
    },
}

pub fn map_key(key: &str, ctrl: bool, alt: bool, shift: bool, meta: bool) -> KeyAction {
    if key.is_empty() || key == "Unidentified" || key == "Dead" || key == "Process" {
        return KeyAction::Ignore;
    }
    // Plain F12 stays with the browser. A modifier makes it a program key.
    if key == "F12" && !ctrl && !alt && !shift && !meta {
        return KeyAction::Ignore;
    }
    if let Some(named) = named_key(key) {
        return chord_action(ctrl, alt, shift, meta, named);
    }
    if let Some(sequence) = navigation_sequence(key, ctrl, alt, shift, meta) {
        return KeyAction::Text(sequence);
    }
    if key.chars().count() == 1 {
        let ch = key.chars().next().unwrap();
        if ctrl || alt || meta {
            if let Some(name) = chord_name(ch) {
                return chord_action(ctrl, alt, shift, meta, &name);
            }
            return KeyAction::Ignore;
        }
        if !ch.is_control() {
            return KeyAction::Text(ch.to_string());
        }
    }
    KeyAction::Ignore
}

/// A pane chord Herdr can parse: modifiers plus a key, including punctuation
/// such as `ctrl+[`. Layout keybinds stay on the tighter `is_safe_key` check.
pub fn is_terminal_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 40 && key.bytes().all(|byte| byte.is_ascii_graphic())
}

fn named_key(key: &str) -> Option<&'static str> {
    Some(match key {
        "Enter" => "enter",
        "Escape" => "esc",
        "Backspace" => "backspace",
        "Tab" => "tab",
        "ArrowUp" => "up",
        "ArrowDown" => "down",
        "ArrowLeft" => "left",
        "ArrowRight" => "right",
        " " => "space",
        "F1" => "f1",
        "F2" => "f2",
        "F3" => "f3",
        "F4" => "f4",
        "F5" => "f5",
        "F6" => "f6",
        "F7" => "f7",
        "F8" => "f8",
        "F9" => "f9",
        "F10" => "f10",
        "F11" => "f11",
        "F12" => "f12",
        _ => return None,
    })
}

fn chord_name(ch: char) -> Option<String> {
    if ch == ' ' {
        return Some("space".to_string());
    }
    // `+` is the chord separator, so Herdr's name is the word.
    if ch == '+' {
        return Some("plus".to_string());
    }
    if ch.is_ascii_alphanumeric() {
        return Some(ch.to_ascii_lowercase().to_string());
    }
    if ch.is_ascii_graphic() {
        return Some(ch.to_string());
    }
    None
}

fn chord_action(ctrl: bool, alt: bool, shift: bool, meta: bool, name: &str) -> KeyAction {
    if !(ctrl || alt || shift || meta) {
        return KeyAction::Keys(vec![name.to_string()]);
    }
    let chord = chord(ctrl, alt, shift, meta, name);
    if is_terminal_key(&chord) {
        KeyAction::Keys(vec![chord])
    } else {
        KeyAction::Ignore
    }
}

/// Keys Herdr's `pane.send_keys` does not name. A modifier uses the xterm
/// parameter (1 + shift + 2*alt + 4*ctrl + 8*meta) so the chord stays distinct.
fn navigation_sequence(
    key: &str,
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
) -> Option<String> {
    let (param, suffix, plain) = match key {
        "Home" => ("1", "H", "\u{1b}[H"),
        "End" => ("1", "F", "\u{1b}[F"),
        "Delete" => ("3", "~", "\u{1b}[3~"),
        "PageUp" => ("5", "~", "\u{1b}[5~"),
        "PageDown" => ("6", "~", "\u{1b}[6~"),
        "Insert" => ("2", "~", "\u{1b}[2~"),
        _ => return None,
    };
    let bits = usize::from(shift)
        + 2 * usize::from(alt)
        + 4 * usize::from(ctrl)
        + 8 * usize::from(meta);
    if bits == 0 {
        return Some(plain.to_string());
    }
    Some(format!("\u{1b}[{param};{}{suffix}", bits + 1))
}

fn chord(ctrl: bool, alt: bool, shift: bool, meta: bool, key: &str) -> String {
    let mut parts = Vec::new();
    if ctrl {
        parts.push("ctrl");
    }
    if alt {
        parts.push("alt");
    }
    if shift {
        parts.push("shift");
    }
    if meta {
        parts.push("super");
    }
    parts.push(key);
    parts.join("+")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_typing_and_chords() {
        assert_eq!(
            map_key("a", false, false, false, false),
            KeyAction::Text("a".into())
        );
        assert_eq!(
            map_key("A", false, false, true, false),
            KeyAction::Text("A".into())
        );
        assert_eq!(
            map_key("c", true, false, false, false),
            KeyAction::Keys(vec!["ctrl+c".into()])
        );
        assert_eq!(
            map_key("ArrowUp", false, false, false, false),
            KeyAction::Keys(vec!["up".into()])
        );
        assert_eq!(
            map_key("Tab", false, false, true, false),
            KeyAction::Keys(vec!["shift+tab".into()])
        );
        assert_eq!(
            map_key("Home", false, false, false, false),
            KeyAction::Text("\u{1b}[H".into())
        );
        assert_eq!(
            map_key("Enter", false, false, true, false),
            KeyAction::Keys(vec!["shift+enter".into()])
        );
        assert_eq!(
            map_key("Enter", true, false, false, false),
            KeyAction::Keys(vec!["ctrl+enter".into()])
        );
        assert_eq!(
            map_key("Enter", true, false, true, false),
            KeyAction::Keys(vec!["ctrl+shift+enter".into()])
        );
        assert_eq!(
            map_key("[", true, false, false, false),
            KeyAction::Keys(vec!["ctrl+[".into()])
        );
        assert_eq!(
            map_key(".", false, true, false, false),
            KeyAction::Keys(vec!["alt+.".into()])
        );
        assert_eq!(
            map_key("-", true, false, true, false),
            KeyAction::Keys(vec!["ctrl+shift+-".into()])
        );
        assert_eq!(
            map_key("+", true, false, false, false),
            KeyAction::Keys(vec!["ctrl+plus".into()])
        );
        assert_eq!(
            map_key("A", true, false, true, false),
            KeyAction::Keys(vec!["ctrl+shift+a".into()])
        );
        assert_eq!(
            map_key("l", false, false, false, true),
            KeyAction::Keys(vec!["super+l".into()])
        );
        assert_eq!(
            map_key("Enter", false, false, false, true),
            KeyAction::Keys(vec!["super+enter".into()])
        );
        assert_eq!(
            map_key("ArrowLeft", false, false, true, false),
            KeyAction::Keys(vec!["shift+left".into()])
        );
        assert_eq!(
            map_key("ArrowLeft", true, false, true, false),
            KeyAction::Keys(vec!["ctrl+shift+left".into()])
        );
        assert_eq!(
            map_key("Home", true, false, true, false),
            KeyAction::Text("\u{1b}[1;6H".into())
        );
        assert_eq!(
            map_key("End", false, false, true, false),
            KeyAction::Text("\u{1b}[1;2F".into())
        );
        assert_eq!(
            map_key("F12", false, false, false, false),
            KeyAction::Ignore
        );
        assert_eq!(
            map_key("F12", true, false, false, false),
            KeyAction::Keys(vec!["ctrl+f12".into()])
        );
        assert_eq!(
            map_key("Home", false, false, false, true),
            KeyAction::Text("\u{1b}[1;9H".into())
        );
        assert_eq!(
            map_key("Insert", true, false, false, false),
            KeyAction::Text("\u{1b}[2;5~".into())
        );
        assert!(is_terminal_key("ctrl+["));
        assert!(!is_terminal_key("ctrl+\n"));
    }
}
