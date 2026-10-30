use crate::layout::{Direction, GridCell, HerdrScope, LayoutNode, PanelConfig};

pub struct PanelInfo {
    pub id: String,
    pub title: Option<String>,
    pub panel: PanelConfig,
    pub collapsed: bool,
}

pub fn list_panels(node: &LayoutNode) -> Vec<PanelInfo> {
    let mut panels = Vec::new();
    walk(node, &mut panels);
    panels
}

pub fn contains(node: &LayoutNode, id: &str) -> bool {
    list_panels(node).iter().any(|panel| panel.id == id)
}

pub fn fresh_id(node: &LayoutNode) -> String {
    let used: Vec<String> = list_panels(node)
        .into_iter()
        .map(|panel| panel.id)
        .collect();
    for index in 1..500 {
        let id = format!("panel-{index}");
        if !used.iter().any(|existing| existing == &id) {
            return id;
        }
    }
    format!("panel-{}", used.len() + 1)
}

pub fn split_panel(
    node: LayoutNode,
    id: &str,
    direction: Direction,
    created: LayoutNode,
) -> Result<LayoutNode, &'static str> {
    let (next, hit) = split_rec(node, id, direction, created);
    if hit {
        Ok(next)
    } else {
        Err("panel was not found")
    }
}

pub fn close_panel(node: LayoutNode, id: &str) -> Result<LayoutNode, &'static str> {
    if !contains(&node, id) {
        return Err("panel was not found");
    }
    match close_rec(node, id) {
        Close::Gone => Err("at least one panel stays open"),
        Close::Missing => Err("panel was not found"),
        Close::Same(node) | Close::Node(node) => Ok(node),
    }
}

pub fn update_panel(
    node: LayoutNode,
    id: &str,
    title: Option<Option<String>>,
    panel: Option<PanelConfig>,
) -> Result<LayoutNode, &'static str> {
    let (next, hit) = update_rec(node, id, title, panel);
    if hit {
        Ok(next)
    } else {
        Err("panel was not found")
    }
}

/// `share` is the fraction of the parent split occupied by the panel's side.
pub fn resize_panel(node: LayoutNode, id: &str, share: f64) -> Result<LayoutNode, &'static str> {
    if !share.is_finite() {
        return Err("ratio must be a finite number");
    }
    let share = share.clamp(0.12, 0.88);
    let (next, hit) = resize_rec(node, id, share);
    if hit {
        Ok(next)
    } else {
        Err("panel has no divider to resize")
    }
}

/// Open a document beside `anchor_id`. A document already on that side is reused
/// when `reuse_neighbor` is set. Terminals, spaces, and agents are left in place.
pub fn open_panel(
    node: LayoutNode,
    anchor_id: &str,
    direction: Direction,
    panel: PanelConfig,
    title: Option<String>,
    reuse_neighbor: bool,
) -> Result<(LayoutNode, String), &'static str> {
    if !contains(&node, anchor_id) {
        return Err("panel was not found");
    }
    let title = title.filter(|value| !value.trim().is_empty());
    if reuse_neighbor {
        if let Some(neighbor) = direct_neighbor(&node, anchor_id, direction) {
            let next = update_panel(node, &neighbor, Some(title), Some(panel))?;
            return Ok((next, neighbor));
        }
    }
    let id = fresh_id(&node);
    let created = LayoutNode::Panel {
        id: id.clone(),
        title,
        panel,
        collapsed: false,
    };
    let next = split_panel(node, anchor_id, direction, created)?;
    Ok((next, id))
}

fn direct_neighbor(node: &LayoutNode, id: &str, direction: Direction) -> Option<String> {
    match node {
        LayoutNode::Split {
            direction: split_dir,
            first,
            second,
            ..
        } => {
            if *split_dir == direction {
                if panel_id(first) == Some(id) {
                    return document_id(second);
                }
                if panel_id(second) == Some(id) {
                    return None;
                }
            }
            direct_neighbor(first, id, direction).or_else(|| direct_neighbor(second, id, direction))
        }
        LayoutNode::Grid { cells, .. } => cells.iter().find_map(|cell| {
            cell.node
                .as_ref()
                .and_then(|child| direct_neighbor(child, id, direction))
        }),
        LayoutNode::Panel { .. } => None,
    }
}

fn panel_id(node: &LayoutNode) -> Option<&str> {
    match node {
        LayoutNode::Panel { id, .. } => Some(id.as_str()),
        _ => None,
    }
}

fn document_id(node: &LayoutNode) -> Option<String> {
    match node {
        LayoutNode::Panel { id, panel, .. } if is_document(panel) => Some(id.clone()),
        _ => None,
    }
}

pub fn is_document(panel: &PanelConfig) -> bool {
    matches!(
        panel,
        PanelConfig::Markdown { .. }
            | PanelConfig::Html { .. }
            | PanelConfig::File { .. }
            | PanelConfig::Iframe { .. }
    )
}

pub fn markdown_blocks(text: &str) -> Vec<(String, String, String)> {
    let mut blocks = Vec::new();
    let mut paragraph = String::new();
    let mut paragraph_index = 0;
    let flush = |paragraph: &mut String,
                 paragraph_index: &mut u32,
                 blocks: &mut Vec<(String, String, String)>| {
        let body = paragraph.split_whitespace().collect::<Vec<_>>().join(" ");
        if !body.is_empty() && blocks.len() < 40 {
            *paragraph_index += 1;
            blocks.push(("p".into(), format!("p-{paragraph_index}"), body));
        }
        paragraph.clear();
    };
    for line in text.lines() {
        if blocks.len() >= 40 {
            break;
        }
        let trimmed = line.trim();
        let hashes = trimmed.chars().take_while(|ch| *ch == '#').count();
        if (1..=6).contains(&hashes) && trimmed.chars().nth(hashes) == Some(' ') {
            flush(&mut paragraph, &mut paragraph_index, &mut blocks);
            let heading = trimmed[hashes + 1..].trim();
            if !heading.is_empty() {
                blocks.push((
                    format!("h{hashes}"),
                    format!("h{hashes}-{}", blocks.len() + 1),
                    heading.to_string(),
                ));
            }
            continue;
        }
        if trimmed.is_empty() {
            flush(&mut paragraph, &mut paragraph_index, &mut blocks);
            continue;
        }
        if let Some(item) = list_item(trimmed) {
            flush(&mut paragraph, &mut paragraph_index, &mut blocks);
            if blocks.len() < 40 {
                blocks.push((
                    "li".into(),
                    format!("li-{}", blocks.len() + 1),
                    item.to_string(),
                ));
            }
            continue;
        }
        if !trimmed.starts_with("```") {
            if !paragraph.is_empty() {
                paragraph.push(' ');
            }
            paragraph.push_str(trimmed);
        }
    }
    flush(&mut paragraph, &mut paragraph_index, &mut blocks);
    blocks
}

fn list_item(trimmed: &str) -> Option<&str> {
    if let Some(item) = trimmed
        .strip_prefix("- ")
        .or_else(|| trimmed.strip_prefix("* "))
    {
        return Some(item.trim());
    }
    let digits = trimmed.chars().take_while(|ch| ch.is_ascii_digit()).count();
    if digits > 0 && trimmed[digits..].starts_with(". ") {
        return Some(trimmed[digits + 2..].trim());
    }
    None
}

fn walk(node: &LayoutNode, panels: &mut Vec<PanelInfo>) {
    match node {
        LayoutNode::Panel {
            id,
            title,
            panel,
            collapsed,
        } => panels.push(PanelInfo {
            id: id.clone(),
            title: title.clone(),
            panel: panel.clone(),
            collapsed: *collapsed,
        }),
        LayoutNode::Split { first, second, .. } => {
            walk(first, panels);
            walk(second, panels);
        }
        LayoutNode::Grid { cells, .. } => {
            for cell in cells {
                walk(&cell_node(cell), panels);
            }
        }
    }
}

fn cell_node(cell: &GridCell) -> LayoutNode {
    if let Some(node) = &cell.node {
        return node.clone();
    }
    LayoutNode::Panel {
        id: cell.id.clone(),
        title: cell.title.clone(),
        panel: cell.panel.clone().unwrap_or(PanelConfig::Herdr {
            pane_id: None,
            source: None,
            lines: None,
            scope: None,
        }),
        collapsed: false,
    }
}

fn split_rec(
    node: LayoutNode,
    id: &str,
    direction: Direction,
    created: LayoutNode,
) -> (LayoutNode, bool) {
    match try_split(node, id, direction, created) {
        Ok(node) => (node, true),
        Err(missed) => (missed.node, false),
    }
}

struct SplitMiss {
    node: LayoutNode,
    created: LayoutNode,
}

fn try_split(
    node: LayoutNode,
    id: &str,
    direction: Direction,
    created: LayoutNode,
) -> Result<LayoutNode, Box<SplitMiss>> {
    match node {
        LayoutNode::Panel {
            id: panel_id,
            title,
            panel,
            collapsed,
        } if panel_id == id => Ok(LayoutNode::Split {
            direction,
            ratio: 0.5,
            first: Box::new(LayoutNode::Panel {
                id: panel_id,
                title,
                panel,
                collapsed,
            }),
            second: Box::new(created),
        }),
        LayoutNode::Panel {
            id,
            title,
            panel,
            collapsed,
        } => Err(Box::new(SplitMiss {
            node: LayoutNode::Panel {
                id,
                title,
                panel,
                collapsed,
            },
            created,
        })),
        LayoutNode::Split {
            direction: existing,
            ratio,
            first,
            second,
        } => match try_split(*first, id, direction, created) {
            Ok(first) => Ok(LayoutNode::Split {
                direction: existing,
                ratio,
                first: Box::new(first),
                second,
            }),
            Err(missed) => match try_split(*second, id, direction, missed.created) {
                Ok(second) => Ok(LayoutNode::Split {
                    direction: existing,
                    ratio,
                    first: Box::new(missed.node),
                    second: Box::new(second),
                }),
                Err(second_miss) => Err(Box::new(SplitMiss {
                    node: LayoutNode::Split {
                        direction: existing,
                        ratio,
                        first: Box::new(missed.node),
                        second: Box::new(second_miss.node),
                    },
                    created: second_miss.created,
                })),
            },
        },
        LayoutNode::Grid {
            columns,
            rows,
            cells,
        } => {
            let mut created = Some(created);
            let mut hit = false;
            let mut next = Vec::with_capacity(cells.len());
            for cell in cells {
                if hit {
                    next.push(cell);
                    continue;
                }
                let pending = created.take().expect("created panel");
                match try_split(cell_node(&cell), id, direction, pending) {
                    Ok(node) => {
                        hit = true;
                        next.push(GridCell {
                            node: Some(node),
                            panel: None,
                            ..cell
                        });
                    }
                    Err(missed) => {
                        created = Some(missed.created);
                        next.push(GridCell {
                            node: Some(missed.node),
                            panel: None,
                            ..cell
                        });
                    }
                }
            }
            let grid = LayoutNode::Grid {
                columns,
                rows,
                cells: next,
            };
            if hit {
                Ok(grid)
            } else {
                Err(Box::new(SplitMiss {
                    node: grid,
                    created: created.expect("created panel is returned on a miss"),
                }))
            }
        }
    }
}

enum Close {
    Missing,
    Gone,
    Same(LayoutNode),
    Node(LayoutNode),
}

fn close_rec(node: LayoutNode, id: &str) -> Close {
    match node {
        LayoutNode::Panel { id: panel_id, .. } if panel_id == id => Close::Gone,
        LayoutNode::Panel {
            id,
            title,
            panel,
            collapsed,
        } => Close::Same(LayoutNode::Panel {
            id,
            title,
            panel,
            collapsed,
        }),
        LayoutNode::Split {
            direction,
            ratio,
            first,
            second,
        } => match close_rec(*first, id) {
            Close::Gone => Close::Node(*second),
            Close::Node(first) => Close::Node(LayoutNode::Split {
                direction,
                ratio,
                first: Box::new(first),
                second,
            }),
            Close::Missing => Close::Missing,
            Close::Same(first) => match close_rec(*second, id) {
                Close::Gone => Close::Node(first),
                Close::Node(second) => Close::Node(LayoutNode::Split {
                    direction,
                    ratio,
                    first: Box::new(first),
                    second: Box::new(second),
                }),
                Close::Same(second) => Close::Same(LayoutNode::Split {
                    direction,
                    ratio,
                    first: Box::new(first),
                    second: Box::new(second),
                }),
                Close::Missing => Close::Missing,
            },
        },
        LayoutNode::Grid {
            columns,
            rows,
            cells,
        } => {
            let mut changed = false;
            let mut missing = true;
            let mut next = Vec::new();
            for cell in cells {
                if changed {
                    next.push(cell);
                    continue;
                }
                match close_rec(cell_node(&cell), id) {
                    Close::Gone => {
                        changed = true;
                        missing = false;
                    }
                    Close::Node(node) => {
                        changed = true;
                        missing = false;
                        next.push(GridCell {
                            node: Some(node),
                            panel: None,
                            ..cell
                        });
                    }
                    Close::Same(node) => {
                        missing = false;
                        next.push(GridCell {
                            node: Some(node),
                            panel: None,
                            ..cell
                        });
                    }
                    Close::Missing => next.push(cell),
                }
            }
            if missing && !changed {
                return Close::Missing;
            }
            if !changed {
                return Close::Same(LayoutNode::Grid {
                    columns,
                    rows,
                    cells: next,
                });
            }
            if next.is_empty() {
                return Close::Gone;
            }
            if next.len() == 1 {
                if let Some(node) = next.pop().and_then(|cell| cell.node) {
                    return Close::Node(node);
                }
            }
            Close::Node(LayoutNode::Grid {
                columns,
                rows,
                cells: next,
            })
        }
    }
}

fn update_rec(
    node: LayoutNode,
    id: &str,
    title: Option<Option<String>>,
    panel: Option<PanelConfig>,
) -> (LayoutNode, bool) {
    match node {
        LayoutNode::Panel {
            id: panel_id,
            title: current_title,
            panel: current_panel,
            collapsed,
        } if panel_id == id => (
            LayoutNode::Panel {
                id: panel_id,
                title: title.unwrap_or(current_title),
                panel: panel.unwrap_or(current_panel),
                collapsed,
            },
            true,
        ),
        LayoutNode::Panel {
            id,
            title,
            panel,
            collapsed,
        } => (
            LayoutNode::Panel {
                id,
                title,
                panel,
                collapsed,
            },
            false,
        ),
        LayoutNode::Split {
            direction,
            ratio,
            first,
            second,
        } => {
            let (first, hit) = update_rec(*first, id, title.clone(), panel.clone());
            if hit {
                return (
                    LayoutNode::Split {
                        direction,
                        ratio,
                        first: Box::new(first),
                        second,
                    },
                    true,
                );
            }
            let (second, hit) = update_rec(*second, id, title, panel);
            (
                LayoutNode::Split {
                    direction,
                    ratio,
                    first: Box::new(first),
                    second: Box::new(second),
                },
                hit,
            )
        }
        LayoutNode::Grid {
            columns,
            rows,
            cells,
        } => {
            let mut hit = false;
            let cells = cells
                .into_iter()
                .map(|cell| {
                    if hit {
                        return cell;
                    }
                    let (node, found) =
                        update_rec(cell_node(&cell), id, title.clone(), panel.clone());
                    hit = found;
                    GridCell {
                        node: Some(node),
                        panel: None,
                        ..cell
                    }
                })
                .collect();
            (
                LayoutNode::Grid {
                    columns,
                    rows,
                    cells,
                },
                hit,
            )
        }
    }
}

fn resize_rec(node: LayoutNode, id: &str, share: f64) -> (LayoutNode, bool) {
    match node {
        LayoutNode::Panel {
            id,
            title,
            panel,
            collapsed,
        } => (
            LayoutNode::Panel {
                id,
                title,
                panel,
                collapsed,
            },
            false,
        ),
        LayoutNode::Split {
            direction,
            ratio,
            first,
            second,
        } => {
            let first_direct =
                matches!(first.as_ref(), LayoutNode::Panel { id: panel_id, .. } if panel_id == id);
            let second_direct =
                matches!(second.as_ref(), LayoutNode::Panel { id: panel_id, .. } if panel_id == id);
            if first_direct {
                return (
                    LayoutNode::Split {
                        direction,
                        ratio: share,
                        first,
                        second,
                    },
                    true,
                );
            }
            if second_direct {
                return (
                    LayoutNode::Split {
                        direction,
                        ratio: (1.0 - share).clamp(0.12, 0.88),
                        first,
                        second,
                    },
                    true,
                );
            }
            if contains(&first, id) {
                let (first, hit) = resize_rec(*first, id, share);
                return (
                    LayoutNode::Split {
                        direction,
                        ratio,
                        first: Box::new(first),
                        second,
                    },
                    hit,
                );
            }
            if contains(&second, id) {
                let (second, hit) = resize_rec(*second, id, share);
                return (
                    LayoutNode::Split {
                        direction,
                        ratio,
                        first,
                        second: Box::new(second),
                    },
                    hit,
                );
            }
            (
                LayoutNode::Split {
                    direction,
                    ratio,
                    first,
                    second,
                },
                false,
            )
        }
        LayoutNode::Grid {
            columns,
            rows,
            cells,
        } => {
            let mut hit = false;
            let cells = cells
                .into_iter()
                .map(|cell| {
                    if hit {
                        return cell;
                    }
                    let (node, found) = resize_rec(cell_node(&cell), id, share);
                    hit = found;
                    GridCell {
                        node: Some(node),
                        panel: None,
                        ..cell
                    }
                })
                .collect();
            (
                LayoutNode::Grid {
                    columns,
                    rows,
                    cells,
                },
                hit,
            )
        }
    }
}

/// A saved name. Automatic labels such as Panes or Files count as unnamed.
/// Clear names the desk wrote by itself. A name someone typed stays.
pub fn blank_generated_panel_titles(node: &mut LayoutNode) -> bool {
    match node {
        LayoutNode::Split { first, second, .. } => {
            let left = blank_generated_panel_titles(first);
            blank_generated_panel_titles(second) || left
        }
        LayoutNode::Grid { cells, .. } => {
            let mut changed = false;
            for cell in cells.iter_mut() {
                if let Some(child) = cell.node.as_mut() {
                    changed = blank_generated_panel_titles(child) || changed;
                }
            }
            changed
        }
        LayoutNode::Panel { title, .. } => {
            if title.as_deref().is_some_and(is_generated_title) {
                *title = None;
                true
            } else {
                false
            }
        }
    }
}

pub fn stored_name(title: Option<&str>) -> Option<String> {
    let value = title?.trim();
    if value.is_empty() || is_generated_title(value) {
        None
    } else {
        Some(value.to_string())
    }
}

pub fn is_generated_title(title: &str) -> bool {
    matches!(
        title.trim().to_ascii_lowercase().as_str(),
        "panel"
            | "new panel"
            | "new tab"
            | "panes"
            | "terminal"
            | "files"
            | "spaces"
            | "agents"
            | "browser"
            | "html"
            | "plugin"
            | "file"
            | "tabs"
            | "chat"
            | "directories"
    )
}

/// The type chip. A plugin uses its manifest title when that title is known.
pub fn panel_kind(panel: &PanelConfig, plugin_label: &str) -> String {
    match panel {
        PanelConfig::Herdr {
            scope: Some(HerdrScope::Pane),
            ..
        } => "Terminal".into(),
        PanelConfig::Herdr { .. } => "Panes".into(),
        PanelConfig::Markdown { raw: true, .. } => "Text".into(),
        PanelConfig::Markdown { .. } => "Markdown".into(),
        PanelConfig::Html { raw: true, .. } => "Text".into(),
        PanelConfig::Html { .. } | PanelConfig::Iframe { .. } => "Browser".into(),
        PanelConfig::File { .. } => "Text".into(),
        PanelConfig::Explorer { .. } => "Files".into(),
        PanelConfig::Plugin { plugin, view, .. } => {
            let label = plugin_label.trim();
            if !label.is_empty() {
                label.to_string()
            } else if let Some(view) = view
                .as_deref()
                .map(str::trim)
                .filter(|view| !view.is_empty())
            {
                view.to_string()
            } else {
                plugin.clone()
            }
        }
        PanelConfig::Files => "Spaces".into(),
        PanelConfig::Agents => "Agents".into(),
        PanelConfig::Chat { .. } => "Chat".into(),
        PanelConfig::Blank => "Panel".into(),
        PanelConfig::Tabs { tabs, active, .. } => tabs
            .iter()
            .find(|tab| tab.id == *active)
            .or_else(|| tabs.first())
            .map(|tab| panel_kind(&tab.panel, plugin_label))
            .unwrap_or_else(|| "Tabs".into()),
    }
}

/// The title bar. A saved name wins. Otherwise the file, folder, or site, then the type.
pub fn panel_display(title: Option<&str>, panel: &PanelConfig, plugin_label: &str) -> String {
    if let Some(name) = stored_name(title) {
        return name;
    }
    if matches!(panel, PanelConfig::Tabs { .. }) {
        return "Tabs".into();
    }
    let address = address_label(panel);
    if !address.is_empty() {
        return address;
    }
    panel_kind(panel, plugin_label)
}

fn address_label(panel: &PanelConfig) -> String {
    match panel {
        PanelConfig::Iframe { url, .. } => host_of(url),
        PanelConfig::Html { path, .. } => path.as_deref().map(base_name).unwrap_or_default(),
        PanelConfig::Markdown { path, .. }
        | PanelConfig::File { path, .. }
        | PanelConfig::Explorer { path, .. } => base_name(path),
        PanelConfig::Plugin { path, url, .. } => {
            let file = path.as_deref().map(base_name).unwrap_or_default();
            if !file.is_empty() {
                file
            } else {
                url.as_deref().map(host_of).unwrap_or_default()
            }
        }
        _ => String::new(),
    }
}

fn base_name(path: &str) -> String {
    crate::paths::path_leaf(path)
}

fn host_of(url: &str) -> String {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    url::Url::parse(&with_scheme)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string))
        .unwrap_or_default()
}

fn panel_aliases(panel: &PanelInfo, plugin_label: &impl Fn(&str) -> String) -> Vec<String> {
    let label = match &panel.panel {
        PanelConfig::Plugin { plugin, .. } => plugin_label(plugin),
        _ => String::new(),
    };
    let mut names = Vec::new();
    if let Some(name) = stored_name(panel.title.as_deref()) {
        names.push(name);
    }
    let display = panel_display(panel.title.as_deref(), &panel.panel, &label);
    let kind = panel_kind(&panel.panel, &label);
    if !display.is_empty() && !names.iter().any(|name| name.eq_ignore_ascii_case(&display)) {
        names.push(display);
    }
    if !kind.is_empty() && !names.iter().any(|name| name.eq_ignore_ascii_case(&kind)) {
        names.push(kind);
    }
    names
}

pub fn resolve_panel_id(node: &LayoutNode, key: &str) -> Result<String, &'static str> {
    resolve_panel_id_with(node, key, |_| String::new())
}

pub fn resolve_panel_id_with(
    node: &LayoutNode,
    key: &str,
    plugin_label: impl Fn(&str) -> String,
) -> Result<String, &'static str> {
    let panels = list_panels(node);
    if panels.iter().any(|panel| panel.id == key) {
        return Ok(key.to_string());
    }
    let needle = key.trim();
    if needle.is_empty() {
        return Err("panel was not found");
    }
    let matches: Vec<&PanelInfo> = panels
        .iter()
        .filter(|panel| {
            panel_aliases(panel, &plugin_label)
                .iter()
                .any(|alias| alias.eq_ignore_ascii_case(needle))
        })
        .collect();
    match matches.as_slice() {
        [panel] => Ok(panel.id.clone()),
        [] => Err("panel was not found"),
        _ => Err("more than one panel has that name"),
    }
}

pub fn swap_panels(
    node: LayoutNode,
    source_id: &str,
    target_id: &str,
) -> Result<LayoutNode, &'static str> {
    if source_id == target_id {
        return Ok(node);
    }
    let (source, target) = {
        let panels = list_panels(&node);
        let source = copy_info(
            panels
                .iter()
                .find(|panel| panel.id == source_id)
                .ok_or("panel was not found")?,
        );
        let target = copy_info(
            panels
                .iter()
                .find(|panel| panel.id == target_id)
                .ok_or("panel was not found")?,
        );
        (source, target)
    };
    Ok(replace_two(node, &source, &target))
}

pub fn move_panel(
    node: LayoutNode,
    source_id: &str,
    target_id: &str,
    place: &str,
) -> Result<LayoutNode, &'static str> {
    if source_id == target_id {
        return Err("a panel cannot move beside itself");
    }
    let moved = {
        let panels = list_panels(&node);
        let source = panels
            .iter()
            .find(|panel| panel.id == source_id)
            .ok_or("panel was not found")?;
        if !panels.iter().any(|panel| panel.id == target_id) {
            return Err("panel was not found");
        }
        LayoutNode::Panel {
            id: source.id.clone(),
            title: source.title.clone(),
            panel: source.panel.clone(),
            collapsed: source.collapsed,
        }
    };
    match place {
        "swap" => swap_panels(node, source_id, target_id),
        "right" | "below" => {
            let closed = close_panel(node, source_id)?;
            let direction = if place == "right" {
                Direction::Row
            } else {
                Direction::Column
            };
            split_panel(closed, target_id, direction, moved)
        }
        _ => Err("place must be swap, right, or below"),
    }
}

fn copy_info(info: &PanelInfo) -> PanelInfo {
    PanelInfo {
        id: info.id.clone(),
        title: info.title.clone(),
        panel: info.panel.clone(),
        collapsed: info.collapsed,
    }
}

fn replace_two(node: LayoutNode, source: &PanelInfo, target: &PanelInfo) -> LayoutNode {
    match node {
        LayoutNode::Panel {
            id,
            title,
            panel,
            collapsed,
        } => {
            let info = if id == source.id {
                Some(target)
            } else if id == target.id {
                Some(source)
            } else {
                None
            };
            match info {
                Some(info) => LayoutNode::Panel {
                    id: info.id.clone(),
                    title: info.title.clone(),
                    panel: info.panel.clone(),
                    collapsed: info.collapsed,
                },
                None => LayoutNode::Panel {
                    id,
                    title,
                    panel,
                    collapsed,
                },
            }
        }
        LayoutNode::Split {
            direction,
            ratio,
            first,
            second,
        } => LayoutNode::Split {
            direction,
            ratio,
            first: Box::new(replace_two(*first, source, target)),
            second: Box::new(replace_two(*second, source, target)),
        },
        LayoutNode::Grid {
            columns,
            rows,
            cells,
        } => LayoutNode::Grid {
            columns,
            rows,
            cells: cells
                .into_iter()
                .map(|cell| {
                    let node = replace_two(cell_node(&cell), source, target);
                    GridCell {
                        node: Some(node),
                        panel: None,
                        ..cell
                    }
                })
                .collect(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::LayoutDocument;

    fn sample() -> LayoutNode {
        LayoutDocument::parse(
            r#"{
              "id": "desk",
              "title": "Desk",
              "root": {
                "type": "split",
                "direction": "row",
                "ratio": 0.6,
                "first": {"type": "panel", "id": "term", "panel": {"type": "herdr", "paneId": "w1:p1"}},
                "second": {"type": "panel", "id": "notes", "title": "Notes", "panel": {"type": "markdown", "path": "notes/welcome.md"}}
              }
            }"#,
        )
        .unwrap()
        .root
    }

    #[test]
    fn opening_reuses_a_document_and_splits_past_the_far_side() {
        let (reused, id) = open_panel(
            sample(),
            "term",
            Direction::Row,
            PanelConfig::File {
                path: "src/main.rs".into(),
                address_bar: None,
            },
            Some("main.rs".into()),
            true,
        )
        .unwrap();
        assert_eq!(id, "notes");
        let notes = list_panels(&reused)
            .into_iter()
            .find(|panel| panel.id == "notes")
            .unwrap();
        assert_eq!(notes.title.as_deref(), Some("main.rs"));
        assert!(matches!(notes.panel, PanelConfig::File { .. }));

        let (created, id) = open_panel(
            sample(),
            "notes",
            Direction::Row,
            PanelConfig::Markdown {
                path: "a.md".into(),
                address_bar: None,
                raw: false,
            },
            Some("a.md".into()),
            true,
        )
        .unwrap();
        assert_ne!(id, "notes");
        assert!(list_panels(&created).iter().any(|panel| panel.id == id));
    }

    #[test]
    fn splits_resizes_and_closes() {
        let created = LayoutNode::Panel {
            id: "chat".into(),
            title: Some("Chat".into()),
            panel: PanelConfig::Chat { pane_id: None },
            collapsed: false,
        };
        let split = split_panel(sample(), "notes", Direction::Column, created).unwrap();
        assert!(contains(&split, "chat"));
        let resized = resize_panel(split, "chat", 0.3).unwrap();
        let closed = close_panel(resized, "chat").unwrap();
        assert!(!contains(&closed, "chat"));
        assert!(contains(&closed, "notes"));
    }

    #[test]
    fn names_resolve_and_panels_move() {
        let root = sample();
        assert_eq!(resolve_panel_id(&root, "notes").unwrap(), "notes");
        assert_eq!(resolve_panel_id(&root, "Notes").unwrap(), "notes");
        assert_eq!(
            resolve_panel_id(&root, "missing").unwrap_err(),
            "panel was not found"
        );

        let swapped = move_panel(sample(), "term", "notes", "swap").unwrap();
        match swapped {
            LayoutNode::Split { first, second, .. } => {
                assert!(matches!(first.as_ref(), LayoutNode::Panel { id, .. } if id == "notes"));
                assert!(matches!(second.as_ref(), LayoutNode::Panel { id, .. } if id == "term"));
            }
            _ => panic!("expected a split"),
        }

        let moved = move_panel(sample(), "term", "notes", "below").unwrap();
        match moved {
            LayoutNode::Split {
                direction,
                first,
                second,
                ..
            } => {
                assert_eq!(direction, Direction::Column);
                assert!(matches!(first.as_ref(), LayoutNode::Panel { id, .. } if id == "notes"));
                assert!(matches!(second.as_ref(), LayoutNode::Panel { id, .. } if id == "term"));
            }
            _ => panic!("expected a split"),
        }
    }

    #[test]
    fn reads_markdown_blocks() {
        let blocks =
            markdown_blocks("# Title\n\nHello there.\n\n## Next\n\n- First item\n- Second item\n");
        assert_eq!(blocks[0].0, "h1");
        assert_eq!(blocks[0].2, "Title");
        assert_eq!(blocks[1].0, "p");
        assert_eq!(blocks[2].0, "h2");
        assert_eq!(blocks[3].0, "li");
        assert_eq!(blocks[3].2, "First item");
        assert_eq!(blocks[4].2, "Second item");
    }

    #[test]
    fn blanking_a_generated_name_leaves_the_tab_label() {
        let mut root = LayoutDocument::parse(
            r#"{
              "id": "desk",
              "title": "Desk",
              "root": {
                "type": "panel",
                "id": "group",
                "title": "Panes",
                "panel": {
                  "type": "tabs",
                  "active": "t1",
                  "tabs": [{"id": "t1", "title": "Terminal", "panel": {"type": "herdr"}}]
                }
              }
            }"#,
        )
        .unwrap()
        .root;
        assert!(blank_generated_panel_titles(&mut root));
        match &root {
            LayoutNode::Panel { title, panel, .. } => {
                assert_eq!(*title, None);
                match panel {
                    PanelConfig::Tabs { tabs, .. } => assert_eq!(tabs[0].title, "Terminal"),
                    other => panic!("expected tabs, got {other:?}"),
                }
            }
            other => panic!("expected a panel, got {other:?}"),
        }
        assert!(!blank_generated_panel_titles(&mut root));
    }

    #[test]
    fn an_unnamed_panel_is_addressed_by_what_the_window_shows() {
        let files = LayoutNode::Panel {
            id: "files".into(),
            title: Some("Panes".into()),
            panel: PanelConfig::Explorer {
                path: r"C:\work\pkg".into(),
                focus: None,
                address_bar: None,
            },
            collapsed: false,
        };
        assert_eq!(stored_name(Some("Panes")), None);
        assert_eq!(stored_name(Some("Notes")).as_deref(), Some("Notes"));
        assert_eq!(
            panel_display(Some("Panes"), &files_panel(&files), ""),
            "pkg"
        );
        assert_eq!(resolve_panel_id(&files, "pkg").unwrap(), "files");
        assert_eq!(resolve_panel_id(&files, "Files").unwrap(), "files");
        assert!(resolve_panel_id(&files, "Panes").is_err());

        let panes = LayoutNode::Panel {
            id: "terminal".into(),
            title: None,
            panel: PanelConfig::Herdr {
                pane_id: None,
                source: None,
                lines: None,
                scope: None,
            },
            collapsed: false,
        };
        let root = LayoutNode::Split {
            direction: Direction::Row,
            ratio: 0.5,
            first: Box::new(files),
            second: Box::new(panes),
        };
        assert_eq!(resolve_panel_id(&root, "Panes").unwrap(), "terminal");
        assert_eq!(resolve_panel_id(&root, "Files").unwrap(), "files");
        let other = LayoutNode::Panel {
            id: "other".into(),
            title: None,
            panel: PanelConfig::Explorer {
                path: r"C:\work\other".into(),
                focus: None,
                address_bar: None,
            },
            collapsed: false,
        };
        let crowded = LayoutNode::Split {
            direction: Direction::Row,
            ratio: 0.5,
            first: Box::new(root),
            second: Box::new(other),
        };
        assert_eq!(
            resolve_panel_id(&crowded, "Files").unwrap_err(),
            "more than one panel has that name"
        );
        assert_eq!(resolve_panel_id(&crowded, "pkg").unwrap(), "files");
    }

    fn files_panel(node: &LayoutNode) -> PanelConfig {
        match node {
            LayoutNode::Panel { panel, .. } => panel.clone(),
            _ => panic!("expected a panel"),
        }
    }
}
