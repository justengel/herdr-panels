use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};

use crate::layout::{LayoutNode, PanelConfig};
use crate::paths::valid_session_name;
use crate::store;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DeskPinMode {
    All,
    Chosen,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeskPin {
    pub id: String,
    pub title: String,
    pub panel: PanelConfig,
    pub mode: DeskPinMode,
    pub spaces: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeskDocument {
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub pins: Vec<DeskPin>,
    #[serde(default)]
    pub spaces: BTreeMap<String, LayoutNode>,
}

impl Default for DeskDocument {
    fn default() -> Self {
        Self {
            revision: 0,
            pins: Vec::new(),
            spaces: BTreeMap::new(),
        }
    }
}

pub enum DeskSave {
    Stored(DeskDocument),
    Conflict(DeskDocument),
}

pub fn load_desk(config_dir: &Path, session: &str) -> anyhow::Result<DeskDocument> {
    check_session(session)?;
    let path = desk_path(config_dir, session);
    if !path.is_file() {
        return Ok(DeskDocument::default());
    }
    let text = fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))
}

pub fn save_desk(
    config_dir: &Path,
    session: &str,
    incoming: &DeskDocument,
    adopt: bool,
) -> anyhow::Result<DeskSave> {
    check_session(session)?;
    validate_desk(incoming)?;
    let current = load_desk(config_dir, session)?;
    if !adopt && incoming.revision != current.revision {
        return Ok(DeskSave::Conflict(current));
    }
    let stored = DeskDocument {
        revision: current.revision.saturating_add(1),
        pins: incoming.pins.clone(),
        spaces: incoming.spaces.clone(),
    };
    let path = desk_path(config_dir, session);
    let bytes = serde_json::to_vec_pretty(&stored).context("encoding desk")?;
    store::write_atomic(&path, &with_newline(bytes))
        .with_context(|| format!("writing {}", path.display()))?;
    Ok(DeskSave::Stored(stored))
}

pub fn rename_desk(config_dir: &Path, from: &str, to: &str) -> anyhow::Result<()> {
    check_session(from)?;
    check_session(to)?;
    if from == to {
        return Ok(());
    }
    let source = desk_path(config_dir, from);
    if !source.is_file() {
        return Ok(());
    }
    let dest = desk_path(config_dir, to);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    if fs::rename(&source, &dest).is_err() {
        fs::copy(&source, &dest).with_context(|| format!("copying {}", source.display()))?;
        fs::remove_file(&source)?;
    }
    Ok(())
}

fn validate_desk(desk: &DeskDocument) -> anyhow::Result<()> {
    if desk.pins.len() > 200 {
        bail!("a desk can hold at most 200 pins");
    }
    if desk.spaces.len() > 100 {
        bail!("a desk can hold at most 100 spaces");
    }
    for pin in &desk.pins {
        if pin.id.trim().is_empty() || pin.id.len() > 80 {
            bail!("pin id is empty or too long");
        }
        if pin.title.chars().count() > 200 {
            bail!("pin title is too long");
        }
        if pin.spaces.len() > 200 {
            bail!("a pin lists too many spaces");
        }
    }
    for key in desk.spaces.keys() {
        if key.is_empty()
            || key.len() > 80
            || key.contains('/')
            || key.contains('\\')
            || key.contains("..")
        {
            bail!("invalid space key");
        }
    }
    Ok(())
}

fn with_newline(mut bytes: Vec<u8>) -> Vec<u8> {
    if !bytes.ends_with(b"\n") {
        bytes.push(b'\n');
    }
    bytes
}

fn check_session(session: &str) -> anyhow::Result<()> {
    if session == "default" || valid_session_name(session) {
        return Ok(());
    }
    bail!("invalid Herdr session name");
}

fn desk_path(config_dir: &Path, session: &str) -> PathBuf {
    config_dir.join("desks").join(format!("{session}.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "hwp-desk-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn terminal() -> LayoutNode {
        LayoutNode::Panel {
            id: "terminal".into(),
            title: Some("Terminal".into()),
            panel: PanelConfig::Herdr {
                pane_id: None,
                source: None,
                lines: None,
            },
            collapsed: false,
        }
    }

    #[test]
    fn a_session_desk_round_trips_and_stays_separate_from_other_sessions() {
        let dir = temp_dir();
        let mut spaces = BTreeMap::new();
        spaces.insert("wg".into(), terminal());
        let desk = DeskDocument {
            revision: 0,
            pins: vec![DeskPin {
                id: "notes".into(),
                title: "Notes".into(),
                panel: PanelConfig::Markdown {
                    path: "a.md".into(),
                    address_bar: None,
                    raw: false,
                },
                mode: DeskPinMode::All,
                spaces: vec!["wH".into()],
            }],
            spaces,
        };
        match save_desk(&dir, "default", &desk, true).unwrap() {
            DeskSave::Stored(saved) => {
                assert_eq!(saved.revision, 1);
                assert_eq!(load_desk(&dir, "default").unwrap(), saved);
            }
            DeskSave::Conflict(_) => panic!("adopt should store the desk"),
        }
        assert!(load_desk(&dir, "other").unwrap().spaces.is_empty());
        let again = DeskDocument {
            revision: 0,
            ..desk
        };
        assert!(matches!(
            save_desk(&dir, "default", &again, false).unwrap(),
            DeskSave::Conflict(_)
        ));
        rename_desk(&dir, "default", "other").unwrap();
        assert!(load_desk(&dir, "default").unwrap().spaces.is_empty());
        assert_eq!(load_desk(&dir, "other").unwrap().pins[0].title, "Notes");
        let _ = fs::remove_dir_all(&dir);
    }
}
