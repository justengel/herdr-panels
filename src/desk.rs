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
    seed_space_bound(None)
}

fn seed_space_bound(pane_id: Option<String>) -> LayoutNode {
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
                pane_id,
                source: None,
                lines: None,
            },
        )),
    }
}

pub struct LiveWorkspace {
    pub id: String,
    pub root_pane: Option<String>,
}

/// Add a layout for each workspace that does not have one yet, with Terminal
/// bound to that workspace's root pane, and drop layouts for workspaces that
/// are gone. An empty list leaves the desk alone.
pub fn reconcile_spaces(desk: &DeskDocument, workspaces: &[LiveWorkspace]) -> DeskDocument {
    if workspaces.is_empty() {
        return desk.clone();
    }
    let mut next = desk.clone();
    let live_keys: std::collections::BTreeSet<String> = workspaces
        .iter()
        .map(|workspace| space_key(&workspace.id))
        .collect();
    next.spaces.retain(|key, _| live_keys.contains(key));
    next.pins.retain_mut(|pin| {
        pin.spaces
            .retain(|id| workspaces.iter().any(|workspace| workspace.id == *id));
        !matches!(pin.mode, DeskPinMode::Chosen) || !pin.spaces.is_empty()
    });
    for workspace in workspaces {
        let key = space_key(&workspace.id);
        if let Some(root) = next.spaces.get(&key).cloned() {
            if let Some(pane_id) = workspace.root_pane.as_deref() {
                if let Some(bound) = bind_seed_terminal(root, pane_id) {
                    next.spaces.insert(key, bound);
                }
            }
            continue;
        }
        next.spaces
            .insert(key, seed_space_bound(workspace.root_pane.clone()));
    }
    next
}

/// The seed Terminal starts unbound. Once the workspace's root pane is known, bind that panel and leave every other pane choice alone.
fn bind_seed_terminal(root: LayoutNode, pane_id: &str) -> Option<LayoutNode> {
    let terminal = layout_ops::list_panels(&root)
        .into_iter()
        .find(|panel| panel.id == "terminal")?;
    let PanelConfig::Herdr {
        pane_id: None,
        source,
        lines,
    } = terminal.panel
    else {
        return None;
    };
    layout_ops::update_panel(
        root,
        "terminal",
        None,
        Some(PanelConfig::Herdr {
            pane_id: Some(pane_id.to_string()),
            source,
            lines,
        }),
    )
    .ok()
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

pub struct VisitSpace<'a> {
    pub id: &'a str,
    pub label: &'a str,
    pub root: &'a LayoutNode,
    pub current: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VisitArrange {
    Row,
    Column,
    Grid,
}

impl VisitArrange {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Row => "row",
            Self::Column => "column",
            Self::Grid => "grid",
        }
    }
}

/// Two panels sit side by side. Three or more use a grid unless the caller chose a direction.
pub fn choose_arrange(count: usize, requested: Option<&str>) -> Result<VisitArrange, &'static str> {
    if count > 6 {
        return Err("a visit can show at most 6 panels");
    }
    match requested.map(str::trim).filter(|value| !value.is_empty()) {
        None => Ok(if count >= 3 {
            VisitArrange::Grid
        } else {
            VisitArrange::Row
        }),
        Some("row") => Ok(VisitArrange::Row),
        Some("column") => Ok(VisitArrange::Column),
        Some("grid") => Ok(VisitArrange::Grid),
        Some(_) => Err("arrange is row, column, or grid"),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct VisitWeights {
    pub sizes: Vec<f64>,
    pub columns: Vec<f64>,
    pub rows: Vec<f64>,
}

/// Weights are shares. A row or column has one per panel. A grid has one per column and one per row.
pub fn visit_weights(
    count: usize,
    arrange: VisitArrange,
    sizes: &[f64],
    columns: &[f64],
    rows: &[f64],
) -> Result<VisitWeights, &'static str> {
    if count <= 1 {
        if !sizes.is_empty() || !columns.is_empty() || !rows.is_empty() {
            return Err("a single panel has no size");
        }
        return Ok(VisitWeights {
            sizes: Vec::new(),
            columns: Vec::new(),
            rows: Vec::new(),
        });
    }
    match arrange {
        VisitArrange::Row | VisitArrange::Column => {
            if !columns.is_empty() || !rows.is_empty() {
                return Err("columns and rows are for a grid");
            }
            let sizes = if sizes.is_empty() {
                vec![1.0; count]
            } else if sizes.len() != count {
                return Err("size has one weight per panel");
            } else {
                sizes.to_vec()
            };
            positive(&sizes)?;
            Ok(VisitWeights {
                sizes,
                columns: Vec::new(),
                rows: Vec::new(),
            })
        }
        VisitArrange::Grid => {
            if !sizes.is_empty() {
                return Err("size is for a row or a column");
            }
            let column_count = if count <= 4 { 2 } else { 3 };
            let row_count = count.div_ceil(column_count);
            let columns = if columns.is_empty() {
                vec![1.0; column_count]
            } else if columns.len() != column_count {
                return Err("columns has one weight per column");
            } else {
                columns.to_vec()
            };
            let rows = if rows.is_empty() {
                vec![1.0; row_count]
            } else if rows.len() != row_count {
                return Err("rows has one weight per row");
            } else {
                rows.to_vec()
            };
            positive(&columns)?;
            positive(&rows)?;
            Ok(VisitWeights {
                sizes: Vec::new(),
                columns,
                rows,
            })
        }
    }
}

fn positive(values: &[f64]) -> Result<(), &'static str> {
    if values
        .iter()
        .any(|value| !value.is_finite() || *value <= 0.0)
    {
        Err("a weight must be a positive number")
    } else {
        Ok(())
    }
}

#[derive(Debug)]
pub struct VisitTarget {
    pub panel_id: String,
    pub title: String,
    pub space_id: String,
    pub space_label: String,
}

/// Find a panel on any space. The same id on several spaces prefers one that is not current.
pub fn find_visit(spaces: &[VisitSpace<'_>], query: &str) -> Result<VisitTarget, &'static str> {
    let needle = query.trim();
    if needle.is_empty() {
        return Err("panel was not found");
    }
    let mut hits: Vec<(usize, String, String)> = Vec::new();
    for (index, space) in spaces.iter().enumerate() {
        for panel in layout_ops::list_panels(space.root) {
            let title = panel.title.unwrap_or_default();
            let titled = title.trim();
            let id_match = panel.id == needle;
            let title_match = !titled.is_empty() && titled.eq_ignore_ascii_case(needle);
            if id_match || title_match {
                hits.push((index, panel.id, titled.to_string()));
            }
        }
    }
    let by_id: Vec<_> = hits.iter().filter(|hit| hit.1 == needle).cloned().collect();
    let chosen = if !by_id.is_empty() {
        by_id
    } else {
        let mut ids = std::collections::BTreeSet::new();
        for hit in &hits {
            if hit.2.eq_ignore_ascii_case(needle) {
                ids.insert(hit.1.clone());
            }
        }
        if ids.len() > 1 {
            return Err("more than one panel has that name");
        }
        if ids.is_empty() {
            return Err("panel was not found");
        }
        hits
    };
    let pick = chosen
        .iter()
        .find(|hit| !spaces[hit.0].current)
        .unwrap_or(&chosen[0]);
    let space = &spaces[pick.0];
    Ok(VisitTarget {
        panel_id: pick.1.clone(),
        title: if pick.2.is_empty() {
            pick.1.clone()
        } else {
            pick.2.clone()
        },
        space_id: space.id.to_string(),
        space_label: if space.label.is_empty() {
            space.id.to_string()
        } else {
            space.label.to_string()
        },
    })
}

/// Resolve every name before a visit opens. One failure rejects the whole list.
pub fn find_visits(
    spaces: &[VisitSpace<'_>],
    queries: &[&str],
) -> Result<Vec<VisitTarget>, String> {
    if queries.is_empty() {
        return Err("panelId is required".into());
    }
    let mut found = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for query in queries {
        let visit = find_visit(spaces, query).map_err(|err| {
            if queries.len() == 1 {
                err.to_string()
            } else if err == "panel was not found" {
                format!("panel was not found: {}", query.trim())
            } else if err == "more than one panel has that name" {
                format!("more than one panel has that name: {}", query.trim())
            } else {
                err.to_string()
            }
        })?;
        if !seen.insert(visit.panel_id.clone()) {
            return Err("a visit lists that panel more than once".into());
        }
        found.push(visit);
    }
    Ok(found)
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

    fn iframe(id: &str, title: &str, url: &str) -> LayoutNode {
        LayoutNode::Panel {
            id: id.into(),
            title: Some(title.into()),
            panel: PanelConfig::Iframe {
                url: url.into(),
                proxy: false,
                address_bar: None,
            },
            collapsed: false,
        }
    }

    #[test]
    fn a_visit_finds_a_panel_on_another_space_and_names_a_miss() {
        let chief = terminal();
        let google = iframe("panel-1", "google", "https://google.com");
        let spaces = [
            VisitSpace {
                id: "wJ",
                label: "herdr-panels",
                root: &chief,
                current: true,
            },
            VisitSpace {
                id: "wH",
                label: "my_sixth_grimoire",
                root: &google,
                current: false,
            },
        ];
        let found = find_visit(&spaces, "google").unwrap();
        assert_eq!(found.panel_id, "panel-1");
        assert_eq!(found.title, "google");
        assert_eq!(found.space_id, "wH");
        assert_eq!(found.space_label, "my_sixth_grimoire");
        assert_eq!(
            find_visit(&spaces, "missing").unwrap_err(),
            "panel was not found"
        );
        assert_eq!(
            find_visit(&spaces, "  ").unwrap_err(),
            "panel was not found"
        );
        let duplicate = iframe("panel-2", "google", "https://example.com");
        let both = [
            VisitSpace {
                id: "wJ",
                label: "herdr-panels",
                root: &google,
                current: true,
            },
            VisitSpace {
                id: "wH",
                label: "my_sixth_grimoire",
                root: &duplicate,
                current: false,
            },
        ];
        assert_eq!(
            find_visit(&both, "google").unwrap_err(),
            "more than one panel has that name"
        );
        let same = [
            VisitSpace {
                id: "wJ",
                label: "herdr-panels",
                root: &google,
                current: true,
            },
            VisitSpace {
                id: "wH",
                label: "my_sixth_grimoire",
                root: &google,
                current: false,
            },
        ];
        assert_eq!(find_visit(&same, "panel-1").unwrap().space_id, "wH");
    }

    #[test]
    fn a_visit_of_several_panels_names_the_one_that_failed() {
        let notes = LayoutNode::Panel {
            id: "notes".into(),
            title: Some("Notes".into()),
            panel: PanelConfig::Markdown {
                path: "a.md".into(),
                address_bar: None,
                raw: false,
            },
            collapsed: false,
        };
        let google = iframe("panel-1", "google", "https://google.com");
        let spaces = [
            VisitSpace {
                id: "wJ",
                label: "herdr-panels",
                root: &notes,
                current: true,
            },
            VisitSpace {
                id: "wH",
                label: "my_sixth_grimoire",
                root: &google,
                current: false,
            },
        ];
        let found = find_visits(&spaces, &["google", "Notes"]).unwrap();
        assert_eq!(found[0].panel_id, "panel-1");
        assert_eq!(found[1].panel_id, "notes");
        assert_eq!(
            find_visits(&spaces, &["google", "Missing"]).unwrap_err(),
            "panel was not found: Missing"
        );
        assert_eq!(
            find_visits(&spaces, &["google", "google"]).unwrap_err(),
            "a visit lists that panel more than once"
        );
        assert_eq!(choose_arrange(2, None).unwrap(), VisitArrange::Row);
        assert_eq!(choose_arrange(4, None).unwrap(), VisitArrange::Grid);
        assert_eq!(
            choose_arrange(3, Some("column")).unwrap(),
            VisitArrange::Column
        );
        assert_eq!(
            choose_arrange(7, None).unwrap_err(),
            "a visit can show at most 6 panels"
        );
        assert_eq!(
            choose_arrange(2, Some("diagonal")).unwrap_err(),
            "arrange is row, column, or grid"
        );
    }

    #[test]
    fn a_visit_size_is_one_weight_per_panel() {
        let row = visit_weights(3, VisitArrange::Row, &[2.0, 1.0, 1.0], &[], &[]).unwrap();
        assert_eq!(row.sizes, vec![2.0, 1.0, 1.0]);
        assert!(row.columns.is_empty());
        let even = visit_weights(2, VisitArrange::Row, &[], &[], &[]).unwrap();
        assert_eq!(even.sizes, vec![1.0, 1.0]);
        let grid = visit_weights(4, VisitArrange::Grid, &[], &[2.0, 1.0], &[1.0, 3.0]).unwrap();
        assert_eq!(grid.columns, vec![2.0, 1.0]);
        assert_eq!(grid.rows, vec![1.0, 3.0]);
        assert_eq!(
            visit_weights(2, VisitArrange::Row, &[2.0], &[], &[]).unwrap_err(),
            "size has one weight per panel"
        );
        assert_eq!(
            visit_weights(4, VisitArrange::Grid, &[2.0, 1.0], &[], &[]).unwrap_err(),
            "size is for a row or a column"
        );
        assert_eq!(
            visit_weights(2, VisitArrange::Row, &[0.0, 1.0], &[], &[]).unwrap_err(),
            "a weight must be a positive number"
        );
        assert_eq!(
            visit_weights(1, VisitArrange::Row, &[2.0], &[], &[]).unwrap_err(),
            "a single panel has no size"
        );
        assert_eq!(
            visit_weights(2, VisitArrange::Column, &[], &[2.0], &[]).unwrap_err(),
            "columns and rows are for a grid"
        );
    }

    fn terminal_pane(node: &LayoutNode) -> Option<String> {
        crate::layout_ops::list_panels(node).into_iter().find_map(|panel| {
            if panel.id != "terminal" {
                return None;
            }
            match panel.panel {
                PanelConfig::Herdr { pane_id, .. } => pane_id,
                _ => None,
            }
        })
    }

    #[test]
    fn a_new_workspace_is_saved_bound_to_its_root_pane_and_a_closed_one_is_dropped() {
        let mut kept = terminal();
        if let LayoutNode::Panel { panel, .. } = &mut kept {
            *panel = PanelConfig::Herdr {
                pane_id: Some("w1:p9".into()),
                source: None,
                lines: None,
            };
        }
        let mut spaces = BTreeMap::new();
        spaces.insert("w1".into(), kept);
        spaces.insert("w4".into(), seed_space());
        spaces.insert("w12".into(), seed_space());
        let desk = DeskDocument {
            pins: vec![DeskPin {
                id: "notes".into(),
                title: "Notes".into(),
                panel: PanelConfig::Markdown {
                    path: "a.md".into(),
                    address_bar: None,
                    raw: false,
                },
                mode: DeskPinMode::Chosen,
                spaces: vec!["w12".into(), "w1".into()],
            }],
            spaces,
            ..DeskDocument::default()
        };
        let next = reconcile_spaces(
            &desk,
            &[
                LiveWorkspace {
                    id: "w1".into(),
                    root_pane: Some("w1:p1".into()),
                },
                LiveWorkspace {
                    id: "w3".into(),
                    root_pane: Some("w3:p1".into()),
                },
                LiveWorkspace {
                    id: "w4".into(),
                    root_pane: Some("w4:p1".into()),
                },
            ],
        );
        assert!(!next.spaces.contains_key("w12"));
        assert_eq!(
            terminal_pane(next.spaces.get("w1").unwrap()).as_deref(),
            Some("w1:p9")
        );
        assert_eq!(
            terminal_pane(next.spaces.get("w3").unwrap()).as_deref(),
            Some("w3:p1")
        );
        assert_eq!(
            terminal_pane(next.spaces.get("w4").unwrap()).as_deref(),
            Some("w4:p1")
        );
        assert_eq!(next.pins[0].spaces, vec!["w1".to_string()]);
        let again = reconcile_spaces(&next, &[]);
        assert_eq!(again.spaces.len(), next.spaces.len());
    }
}
