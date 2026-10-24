use serde::Deserialize;

use crate::layout::is_safe_key;

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
    if meta
        || key.is_empty()
        || key == "F12"
        || key == "Unidentified"
        || key == "Dead"
        || key == "Process"
    {
        return KeyAction::Ignore;
    }
    if let Some(named) = named_key(key) {
        if named == "tab" && shift && !ctrl && !alt {
            return KeyAction::Keys(vec!["shift+tab".into()]);
        }
        if ctrl || alt {
            let chord = chord(ctrl, alt, shift, named);
            if is_safe_key(&chord) {
                return KeyAction::Keys(vec![chord]);
            }
        }
        return KeyAction::Keys(vec![named.into()]);
    }
    if let Some(sequence) = navigation_sequence(key) {
        return KeyAction::Text(sequence.into());
    }
    if key.chars().count() == 1 {
        let ch = key.chars().next().unwrap();
        if ctrl || alt {
            if ch.is_ascii_alphanumeric() || ch == ' ' {
                let name = if ch == ' ' {
                    "space".to_string()
                } else {
                    ch.to_ascii_lowercase().to_string()
                };
                let chord = chord(ctrl, alt, shift, &name);
                if is_safe_key(&chord) {
                    return KeyAction::Keys(vec![chord]);
                }
            }
            return KeyAction::Ignore;
        }
        if !ch.is_control() {
            return KeyAction::Text(ch.to_string());
        }
    }
    KeyAction::Ignore
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
        _ => return None,
    })
}

/// Keys Herdr 0.8's `pane.send_keys` does not name. These sequences are written
/// to the pane as literal input, which PowerShell and typical Unix line editors accept.
fn navigation_sequence(key: &str) -> Option<&'static str> {
    Some(match key {
        "Home" => "\u{1b}[H",
        "End" => "\u{1b}[F",
        "Delete" => "\u{1b}[3~",
        "PageUp" => "\u{1b}[5~",
        "PageDown" => "\u{1b}[6~",
        _ => return None,
    })
}

fn chord(ctrl: bool, alt: bool, shift: bool, key: &str) -> String {
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
            map_key("F12", false, false, false, false),
            KeyAction::Ignore
        );
        assert_eq!(map_key("l", false, false, false, true), KeyAction::Ignore);
    }
}
