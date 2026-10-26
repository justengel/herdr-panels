use std::collections::HashSet;

use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LayoutDocument {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    pub root: LayoutNode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LayoutNode {
    Split {
        direction: Direction,
        ratio: f64,
        first: Box<LayoutNode>,
        second: Box<LayoutNode>,
    },
    Grid {
        columns: Vec<f64>,
        rows: Vec<f64>,
        cells: Vec<GridCell>,
    },
    Panel {
        id: String,
        #[serde(default)]
        title: Option<String>,
        panel: PanelConfig,
        #[serde(default, skip_serializing_if = "is_false")]
        collapsed: bool,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Row,
    Column,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GridCell {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    pub column: u32,
    pub row: u32,
    #[serde(default = "default_span")]
    pub col_span: u32,
    #[serde(default = "default_span")]
    pub row_span: u32,
    /// Legacy cells store a panel directly. Nested splits live in `node`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panel: Option<PanelConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<LayoutNode>,
}

fn default_span() -> u32 {
    1
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum TabEdge {
    #[default]
    Top,
    Bottom,
    Left,
    Right,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PanelTab {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub panel: PanelConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PanelConfig {
    Herdr {
        #[serde(default, rename = "paneId")]
        pane_id: Option<String>,
        #[serde(default)]
        source: Option<HerdrSource>,
        #[serde(default)]
        lines: Option<u32>,
    },
    Markdown {
        path: String,
        #[serde(
            default,
            rename = "addressBar",
            skip_serializing_if = "Option::is_none"
        )]
        address_bar: Option<bool>,
        /// Show the file text instead of the rendered note.
        #[serde(default, skip_serializing_if = "is_false")]
        raw: bool,
    },
    Iframe {
        url: String,
        #[serde(default)]
        proxy: bool,
        #[serde(
            default,
            rename = "addressBar",
            skip_serializing_if = "Option::is_none"
        )]
        address_bar: Option<bool>,
    },
    Html {
        #[serde(default)]
        path: Option<String>,
        #[serde(default)]
        inline: Option<String>,
        /// When set, the panel may type into a Herdr pane. Off unless chosen.
        #[serde(default, skip_serializing_if = "is_false")]
        control: bool,
        #[serde(
            default,
            rename = "addressBar",
            skip_serializing_if = "Option::is_none"
        )]
        address_bar: Option<bool>,
        /// Show the file text instead of the rendered page.
        #[serde(default, skip_serializing_if = "is_false")]
        raw: bool,
    },
    Plugin {
        plugin: String,
        #[serde(default)]
        config: serde_json::Value,
        /// Which declared view is showing. Empty means the plugin's own panel.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        view: Option<String>,
        /// File or directory this view is showing.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        /// Page this view is showing.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        /// The path is a directory.
        #[serde(default, skip_serializing_if = "is_false")]
        directory: bool,
        #[serde(
            default,
            rename = "addressBar",
            skip_serializing_if = "Option::is_none"
        )]
        address_bar: Option<bool>,
    },
    Files,
    Agents,
    Explorer {
        #[serde(default)]
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        focus: Option<String>,
        #[serde(
            default,
            rename = "addressBar",
            skip_serializing_if = "Option::is_none"
        )]
        address_bar: Option<bool>,
    },
    Blank,
    File {
        path: String,
        #[serde(
            default,
            rename = "addressBar",
            skip_serializing_if = "Option::is_none"
        )]
        address_bar: Option<bool>,
    },
    Tabs {
        #[serde(default)]
        edge: TabEdge,
        #[serde(default)]
        active: String,
        tabs: Vec<PanelTab>,
    },
    Chat {
        #[serde(default, rename = "paneId")]
        pane_id: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HerdrSource {
    Visible,
    Recent,
}

impl HerdrSource {
    pub fn as_api(self) -> &'static str {
        match self {
            Self::Visible => "visible",
            Self::Recent => "recent",
        }
    }
}

impl LayoutDocument {
    pub fn parse(text: &str) -> anyhow::Result<Self> {
        let doc: Self = serde_json::from_str(text).context("layout is not valid JSON")?;
        doc.validate()?;
        Ok(doc)
    }

    pub fn validate(&self) -> anyhow::Result<()> {
        validate_id(&self.id)?;
        if self.title.trim().is_empty() || self.title.chars().count() > 80 {
            bail!("layout title must be 1 to 80 characters");
        }
        if let Some(description) = &self.description {
            if description.chars().count() > 240 {
                bail!("layout description is too long");
            }
        }
        let mut ids = HashSet::new();
        validate_node(&self.root, &mut ids)?;
        if ids.is_empty() {
            bail!("layout has no panels");
        }
        Ok(())
    }
}

fn validate_node(node: &LayoutNode, ids: &mut HashSet<String>) -> anyhow::Result<()> {
    match node {
        LayoutNode::Split {
            ratio,
            first,
            second,
            ..
        } => {
            if !ratio.is_finite() || !(0.05..=0.95).contains(ratio) {
                bail!("split ratio must be between 0.05 and 0.95");
            }
            validate_node(first, ids)?;
            validate_node(second, ids)?;
        }
        LayoutNode::Grid {
            columns,
            rows,
            cells,
        } => {
            if columns.is_empty() || rows.is_empty() {
                bail!("grid needs at least one column and one row");
            }
            if columns.len() > 12 || rows.len() > 12 {
                bail!("grid is limited to 12 tracks");
            }
            for weight in columns.iter().chain(rows.iter()) {
                if !weight.is_finite() || *weight < 0.05 || *weight > 100.0 {
                    bail!("grid track weights must be between 0.05 and 100");
                }
            }
            let mut occupied = HashSet::new();
            let mut slots = HashSet::new();
            for cell in cells {
                validate_panel_id(&cell.id)?;
                if !slots.insert(cell.id.clone()) {
                    bail!("duplicate panel id {}", cell.id);
                }
                if cell.col_span == 0 || cell.row_span == 0 {
                    bail!("panel {} has an empty span", cell.id);
                }
                let col_end = cell
                    .column
                    .checked_add(cell.col_span)
                    .context("column span overflow")?;
                let row_end = cell
                    .row
                    .checked_add(cell.row_span)
                    .context("row span overflow")?;
                if col_end as usize > columns.len() || row_end as usize > rows.len() {
                    bail!("panel {} extends outside the grid", cell.id);
                }
                for row in cell.row..row_end {
                    for column in cell.column..col_end {
                        if !occupied.insert((row, column)) {
                            bail!("panel {} overlaps another cell", cell.id);
                        }
                    }
                }
                match (&cell.node, &cell.panel) {
                    (Some(node), None) => validate_node(node, ids)?,
                    (None, Some(panel)) => {
                        if !ids.insert(cell.id.clone()) {
                            bail!("duplicate panel id {}", cell.id);
                        }
                        validate_panel(panel)?;
                    }
                    _ => bail!("panel {} needs a panel or a nested layout", cell.id),
                }
            }
        }
        LayoutNode::Panel {
            id, title, panel, ..
        } => {
            validate_panel_id(id)?;
            if !ids.insert(id.clone()) {
                bail!("duplicate panel id {id}");
            }
            if let Some(title) = title {
                if title.chars().count() > 80 {
                    bail!("panel title is too long");
                }
            }
            validate_panel(panel)?;
        }
    }
    Ok(())
}

fn validate_panel(panel: &PanelConfig) -> anyhow::Result<()> {
    match panel {
        PanelConfig::Herdr { pane_id, lines, .. } => {
            if let Some(pane_id) = pane_id {
                if !is_pane_id(pane_id) {
                    bail!("invalid Herdr pane id");
                }
            }
            if let Some(lines) = lines {
                if *lines == 0 || *lines > 2_000 {
                    bail!("herdr line count must be between 1 and 2000");
                }
            }
        }
        PanelConfig::Markdown { path, .. } => validate_relative_or_rooted(path)?,
        PanelConfig::Iframe { url, proxy, .. } => {
            if url.is_empty() {
                if *proxy {
                    bail!("proxy is only for absolute loopback URLs");
                }
                return Ok(());
            }
            if url.starts_with('/') && !url.starts_with("//") {
                if *proxy {
                    bail!("proxy is only for absolute loopback URLs");
                }
                return Ok(());
            }
            let parsed = url::Url::parse(url).context("iframe url is invalid")?;
            if parsed.scheme() != "http" && parsed.scheme() != "https" {
                bail!("iframe url must be http, https, or a root-relative path");
            }
            if *proxy && !crate::paths::is_loopback_url(url) {
                bail!("proxied iframes must target localhost");
            }
        }
        PanelConfig::Html { path, inline, .. } => match (path, inline) {
            (None, None) => bail!("html panel needs a path or inline markup"),
            (Some(_), Some(_)) => bail!("html panel takes a path or inline markup, not both"),
            (Some(path), None) => validate_relative_or_rooted(path)?,
            (None, Some(inline)) => {
                if inline.len() > 200_000 {
                    bail!("inline html is limited to 200 KB");
                }
            }
        },
        PanelConfig::Plugin {
            plugin,
            config,
            view,
            path,
            url,
            ..
        } => {
            crate::plugins::validate_plugin_id(plugin)?;
            if let Some(view) = view.as_deref().filter(|view| !view.is_empty()) {
                crate::plugins::validate_plugin_id(view).context("plugin view")?;
            }
            if let Some(path) = path.as_deref().filter(|path| !path.is_empty()) {
                validate_relative_or_rooted(path)?;
            }
            if let Some(url) = url.as_deref().filter(|url| !url.is_empty()) {
                if !(url.starts_with('/') && !url.starts_with("//")) {
                    let parsed = url::Url::parse(url).context("plugin url is invalid")?;
                    if parsed.scheme() != "http" && parsed.scheme() != "https" {
                        bail!("plugin url must be http, https, or a root-relative path");
                    }
                }
            }
            if serde_json::to_string(config)
                .map(|text| text.len())
                .unwrap_or(0)
                > 32_000
            {
                bail!("plugin config is limited to 32 KB");
            }
        }
        PanelConfig::Files | PanelConfig::Agents | PanelConfig::Blank => {}
        PanelConfig::Explorer { path, focus, .. } => {
            if !path.is_empty() {
                validate_relative_or_rooted(path)?;
            }
            if let Some(focus) = focus {
                if !focus.is_empty() {
                    validate_relative_or_rooted(focus)?;
                }
            }
        }
        PanelConfig::File { path, .. } => validate_relative_or_rooted(path)?,
        PanelConfig::Tabs { active, tabs, .. } => {
            if tabs.is_empty() || tabs.len() > 24 {
                bail!("a tab group needs 1 to 24 tabs");
            }
            let mut seen = HashSet::new();
            for tab in tabs {
                validate_panel_id(&tab.id)?;
                if !seen.insert(tab.id.clone()) {
                    bail!("duplicate tab id {}", tab.id);
                }
                if tab.title.trim().is_empty() || tab.title.chars().count() > 80 {
                    bail!("tab title must be 1 to 80 characters");
                }
                if tab
                    .icon
                    .as_ref()
                    .is_some_and(|icon| icon.chars().count() > 8)
                {
                    bail!("tab icon is too long");
                }
                if matches!(tab.panel, PanelConfig::Tabs { .. }) {
                    bail!("tab groups cannot be nested");
                }
                validate_panel(&tab.panel)?;
            }
            if !active.is_empty() && !tabs.iter().any(|tab| tab.id == *active) {
                bail!("active tab does not exist");
            }
        }
        PanelConfig::Chat { pane_id } => {
            if let Some(pane_id) = pane_id {
                if !is_pane_id(pane_id) {
                    bail!("invalid Herdr pane id");
                }
            }
        }
    }
    Ok(())
}

fn validate_relative_or_rooted(path: &str) -> anyhow::Result<()> {
    if path.trim().is_empty() || path.len() > 512 || path.contains('\0') {
        bail!("content path is empty or too long");
    }
    if path.contains("..") {
        bail!("content path cannot contain ..");
    }
    Ok(())
}

fn validate_id(id: &str) -> anyhow::Result<()> {
    if !is_layout_id(id) {
        bail!("layout id must be lowercase letters, digits, and hyphens");
    }
    Ok(())
}

fn validate_panel_id(id: &str) -> anyhow::Result<()> {
    let mut chars = id.chars();
    let Some(first) = chars.next() else {
        bail!("panel id is empty");
    };
    if !first.is_ascii_alphanumeric()
        || id.len() > 49
        || !id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        bail!("panel id {id} is invalid");
    }
    Ok(())
}

pub fn is_layout_id(id: &str) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_lowercase() || first.is_ascii_digit())
        && id.len() <= 49
        && id
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
}

pub fn is_pane_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, ':' | '_' | '-'))
}

pub fn is_safe_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 40
        && key.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'+' | b'_' | b'-')
        })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    #[test]
    fn parses_example_layouts() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("examples")
            .join("layouts");
        for name in ["side-by-side.json", "studio.json", "desk.json"] {
            let text = std::fs::read_to_string(root.join(name)).unwrap();
            let doc = LayoutDocument::parse(&text).unwrap();
            assert!(!doc.title.is_empty());
        }
    }

    #[test]
    fn rejects_overlapping_grid() {
        let text = r#"{
          "id": "bad",
          "title": "Bad",
          "root": {
            "type": "grid",
            "columns": [1, 1],
            "rows": [1],
            "cells": [
              {"id": "a", "column": 0, "row": 0, "panel": {"type": "markdown", "path": "notes/a.md"}},
              {"id": "b", "column": 0, "row": 0, "panel": {"type": "markdown", "path": "notes/b.md"}}
            ]
          }
        }"#;
        assert!(LayoutDocument::parse(text).is_err());
    }

    #[test]
    fn accepts_a_nested_cell_and_a_chat() {
        let text = r#"{
          "id": "nested",
          "title": "Nested",
          "root": {
            "type": "grid",
            "columns": [1],
            "rows": [1],
            "cells": [{
              "id": "slot",
              "column": 0,
              "row": 0,
              "node": {
                "type": "split",
                "direction": "column",
                "ratio": 0.5,
                "first": {"type": "panel", "id": "term", "panel": {"type": "herdr", "paneId": "w1:p1"}},
                "second": {"type": "panel", "id": "chat", "panel": {"type": "chat"}}
              }
            }]
          }
        }"#;
        assert!(LayoutDocument::parse(text).is_ok());
    }

    #[test]
    fn accepts_a_tab_group_and_rejects_a_nested_one() {
        let text = r#"{
          "id": "tabs",
          "title": "Tabs",
          "root": {
            "type": "panel",
            "id": "group",
            "panel": {
              "type": "tabs",
              "edge": "left",
              "active": "one",
              "tabs": [{
                "id": "one",
                "title": "Notes",
                "icon": "N",
                "panel": {"type": "markdown", "path": "notes/a.md"}
              }]
            }
          }
        }"#;
        assert!(LayoutDocument::parse(text).is_ok());
        let nested = text.replace(
            r#"{"type": "markdown", "path": "notes/a.md"}"#,
            r#"{"type": "tabs", "tabs": [{"id": "inner", "title": "Inner", "panel": {"type": "iframe", "url": "https://example.com"}}]}"#,
        );
        assert!(LayoutDocument::parse(&nested).is_err());
    }

    #[test]
    fn a_panel_remembers_whether_its_address_bar_is_shown() {
        let text = r#"{
          "id": "bar",
          "title": "Bar",
          "root": {
            "type": "panel",
            "id": "files",
            "panel": {"type": "explorer", "path": "C:/work", "addressBar": false}
          }
        }"#;
        let doc = LayoutDocument::parse(text).unwrap();
        let saved = serde_json::to_value(&doc).unwrap();
        assert_eq!(saved["root"]["panel"]["addressBar"], false);

        let again = LayoutDocument::parse(&serde_json::to_string(&doc).unwrap()).unwrap();
        match again.root {
            LayoutNode::Panel { panel, .. } => match panel {
                PanelConfig::Explorer {
                    path, address_bar, ..
                } => {
                    assert_eq!(path, "C:/work");
                    assert_eq!(address_bar, Some(false));
                }
                other => panic!("expected explorer, got {other:?}"),
            },
            other => panic!("expected panel, got {other:?}"),
        }
    }

    #[test]
    fn a_rendered_file_can_be_shown_as_raw_text() {
        let text = r#"{
          "id": "bar",
          "title": "Bar",
          "root": {
            "type": "panel",
            "id": "notes",
            "panel": {"type": "markdown", "path": "notes/a.md", "raw": true}
          }
        }"#;
        let doc = LayoutDocument::parse(text).unwrap();
        let saved = serde_json::to_value(&doc).unwrap();
        assert_eq!(saved["root"]["panel"]["raw"], true);

        let plain = r#"{
          "id": "bar",
          "title": "Bar",
          "root": {
            "type": "panel",
            "id": "page",
            "panel": {"type": "html", "path": "panels/charts.html"}
          }
        }"#;
        let doc = LayoutDocument::parse(plain).unwrap();
        let saved = serde_json::to_value(&doc).unwrap();
        assert!(saved["root"]["panel"].get("raw").is_none());
    }

    #[test]
    fn a_plugin_view_keeps_the_file_it_opened() {
        let text = r#"{
          "id": "bar",
          "title": "Bar",
          "root": {
            "type": "panel",
            "id": "notes",
            "panel": {"type": "plugin", "plugin": "vim", "view": "edit", "path": "notes/a.md"}
          }
        }"#;
        let doc = LayoutDocument::parse(text).unwrap();
        let saved = serde_json::to_value(&doc).unwrap();
        assert_eq!(saved["root"]["panel"]["view"], "edit");
        assert_eq!(saved["root"]["panel"]["path"], "notes/a.md");
        assert!(saved["root"]["panel"].get("directory").is_none());
    }
}
