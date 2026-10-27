use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};

use crate::layout::{Direction, LayoutNode, PanelConfig};
use crate::layout_ops;
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

pub fn space_key(workspace_id: &str) -> String {
    let lower = workspace_id.trim().to_ascii_lowercase();
    let mut raw = String::new();
    let mut dash = false;
    for ch in lower.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' {
            dash = false;
            raw.push(ch);
        } else if !dash {
            dash = true;
            raw.push('-');
        }
    }
    let sliced: String = raw.trim_matches('-').chars().take(40).collect();
    if sliced.is_empty() {
        "space".into()
    } else {
        sliced
    }
}

fn pin_applies(pin: &DeskPin, workspace_id: &str) -> bool {
    match pin.mode {
        DeskPinMode::All => !pin.spaces.iter().any(|id| id == workspace_id),
        DeskPinMode::Chosen => pin.spaces.iter().any(|id| id == workspace_id),
    }
}

fn is_native(panel: &PanelConfig) -> bool {
    matches!(
        panel,
        PanelConfig::Files | PanelConfig::Agents | PanelConfig::Herdr { .. }
    )
}

fn named_panel(id: &str, title: &str, panel: PanelConfig) -> LayoutNode {
    LayoutNode::Panel {
        id: id.into(),
        title: Some(title.into()),
        panel,
        collapsed: false,
    }
}

fn seed_space() -> LayoutNode {
    let sidebar = LayoutNode::Split {
        direction: Direction::Column,
        ratio: 0.62,
        first: Box::new(named_panel("spaces", "Spaces", PanelConfig::Files)),
        second: Box::new(named_panel("agents", "Agents", PanelConfig::Agents)),
    };
    LayoutNode::Split {
        direction: Direction::Row,
        ratio: 0.22,
        first: Box::new(sidebar),
        second: Box::new(named_panel(
            "terminal",
            "Terminal",
            PanelConfig::Herdr {
                pane_id: None,
                source: None,
                lines: None,
            },
        )),
    }
}

fn stack_column(nodes: &[LayoutNode]) -> LayoutNode {
    let Some(first) = nodes.first() else {
        return seed_space();
    };
    if nodes.len() == 1 {
        return first.clone();
    }
    LayoutNode::Split {
        direction: Direction::Column,
        ratio: 1.0 / nodes.len() as f64,
        first: Box::new(first.clone()),
        second: Box::new(stack_column(&nodes[1..])),
    }
}

fn drop_foreign(root: LayoutNode, desk: &DeskDocument, workspace_id: &str) -> LayoutNode {
    let mut next = root;
    for pin in &desk.pins {
        if matches!(pin.panel, PanelConfig::Herdr { .. }) || pin_applies(pin, workspace_id) {
            continue;
        }
        if let Ok(closed) = layout_ops::close_panel(next.clone(), &pin.id) {
            next = closed;
        }
    }
    next
}

/// The tree for one workspace: the saved space, or the Spaces, Agents, and Terminal seed, plus pins that belong there.
pub fn open_space(desk: &DeskDocument, workspace_id: &str) -> LayoutNode {
    let stored = desk
        .spaces
        .get(&space_key(workspace_id))
        .cloned()
        .unwrap_or_else(seed_space);
    let mut root = drop_foreign(stored, desk, workspace_id);
    let mut pins = desk.pins.clone();
    pins.sort_by(|left, right| left.id.cmp(&right.id));
    let mut missing = Vec::new();
    for pin in pins {
        if !pin_applies(&pin, workspace_id) || matches!(pin.panel, PanelConfig::Herdr { .. }) {
            continue;
        }
        if layout_ops::contains(&root, &pin.id) {
            if let Ok(updated) = layout_ops::update_panel(
                root.clone(),
                &pin.id,
                Some(Some(pin.title.clone())),
                Some(pin.panel.clone()),
            ) {
                root = updated;
            }
        } else {
            missing.push(named_panel(&pin.id, &pin.title, pin.panel));
        }
    }
    if missing.is_empty() {
        return root;
    }
    LayoutNode::Split {
        direction: Direction::Row,
        ratio: 0.28,
        first: Box::new(stack_column(&missing)),
        second: Box::new(root),
    }
}

/// Writes one space and keeps pins in step: a missing all-spaces panel is excluded here, and a chosen pin with nowhere left is removed.
pub fn store_space(desk: &DeskDocument, workspace_id: &str, root: LayoutNode) -> DeskDocument {
    let mut next = desk.clone();
    let mut removed = Vec::new();
    next.pins.retain_mut(|pin| {
        if let Some(info) = layout_ops::list_panels(&root)
            .into_iter()
            .find(|panel| panel.id == pin.id)
        {
            if !matches!(pin.panel, PanelConfig::Herdr { .. }) {
                pin.title = info.title.unwrap_or_else(|| pin.title.clone());
                pin.panel = info.panel;
            }
            return true;
        }
        if !pin_applies(pin, workspace_id) {
            return true;
        }
        match pin.mode {
            DeskPinMode::All => {
                if !workspace_id.is_empty() && !pin.spaces.iter().any(|id| id == workspace_id) {
                    pin.spaces.push(workspace_id.to_string());
                }
                true
            }
            DeskPinMode::Chosen => {
                pin.spaces.retain(|id| id != workspace_id);
                if pin.spaces.is_empty() {
                    removed.push(pin.clone());
                    false
                } else {
                    true
                }
            }
        }
    });
    for pin in removed {
        if is_native(&pin.panel) {
            continue;
        }
        for tree in next.spaces.values_mut() {
            if let Ok(closed) = layout_ops::close_panel(tree.clone(), &pin.id) {
                *tree = closed;
            }
        }
    }
    next.spaces.insert(space_key(workspace_id), root);
    next
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

    fn panel_titles(node: &LayoutNode) -> Vec<String> {
        crate::layout_ops::list_panels(node)
            .into_iter()
            .map(|panel| panel.title.unwrap_or(panel.id))
            .collect()
    }

    #[test]
    fn the_open_space_includes_pins_and_stores_an_exclusion() {
        assert_eq!(space_key("wG"), "wg");
        assert_eq!(space_key(" My  Space "), "my-space");
        let pin = DeskPin {
            id: "notes".into(),
            title: "Notes".into(),
            panel: PanelConfig::Markdown {
                path: "a.md".into(),
                address_bar: None,
                raw: false,
            },
            mode: DeskPinMode::All,
            spaces: vec!["wH".into()],
        };
        let desk = DeskDocument {
            pins: vec![pin],
            ..DeskDocument::default()
        };
        let shown = open_space(&desk, "wG");
        assert!(panel_titles(&shown).contains(&"Notes".into()));
        assert!(!panel_titles(&open_space(&desk, "wH")).contains(&"Notes".into()));
        let stored = store_space(&desk, "wG", terminal());
        assert!(stored.spaces.contains_key("wg"));
        assert_eq!(
            stored.pins[0].spaces,
            vec!["wH".to_string(), "wG".to_string()]
        );
        let chosen = DeskDocument {
            pins: vec![DeskPin {
                mode: DeskPinMode::Chosen,
                spaces: vec!["wG".into()],
                ..desk.pins[0].clone()
            }],
            ..DeskDocument::default()
        };
        assert!(store_space(&chosen, "wG", terminal()).pins.is_empty());
    }
}
