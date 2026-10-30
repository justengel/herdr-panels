//! Permissions a view plugin declares, and the checks the server applies
//! when that plugin asks to read a file or call the Herdr bridge.

use std::path::{Path, PathBuf};

use anyhow::bail;

use crate::desk::DeskDocument;
use crate::layout::{is_herdr_pane_id, LayoutNode, PanelConfig};

pub const READ: &str = "herdr:read";
pub const CONTROL: &str = "herdr:control";
pub const FILES: &str = "files:read";
pub const PANELS_READ: &str = "panels:read";
pub const PANELS_CONTROL: &str = "panels:control";
pub const LINKS: &str = "links:open";
pub const COMMANDS: &str = "commands:run";

/// Reply when the plugin declared control but this panel's layout has it off.
/// Keep in step with `CONTROL_OFF_MESSAGE` in `web/src/controlHint.ts`.
pub const CONTROL_OFF: &str =
    "This panel cannot type into a pane. Turn on \"control\" in the design bar.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginGrants {
    pub permissions: Vec<String>,
    pub files: Vec<PathBuf>,
    pub commands: Vec<String>,
}

pub fn parse_permissions(
    permissions: Vec<String>,
    files: Vec<String>,
) -> anyhow::Result<PluginGrants> {
    parse_grants(permissions, files, Vec::new())
}

pub fn parse_grants(
    permissions: Vec<String>,
    files: Vec<String>,
    commands: Vec<String>,
) -> anyhow::Result<PluginGrants> {
    let mut kept = Vec::new();
    for name in permissions {
        if !known(&name) {
            bail!(
                "unknown permission \"{name}\". use herdr:read, herdr:control, files:read, panels:read, panels:control, links:open, or commands:run"
            );
        }
        if !kept.iter().any(|have: &String| have == &name) {
            kept.push(name);
        }
    }
    if files.is_empty() && kept.iter().any(|name| name == FILES) {
        bail!("files:read requires a files list of absolute paths");
    }
    if !files.is_empty() && !kept.iter().any(|name| name == FILES) {
        bail!("files is set without the files:read permission");
    }
    if commands.is_empty() && kept.iter().any(|name| name == COMMANDS) {
        bail!("commands:run requires a commands list of program names");
    }
    if !commands.is_empty() && !kept.iter().any(|name| name == COMMANDS) {
        bail!("commands is set without the commands:run permission");
    }
    let mut programs = Vec::new();
    for command in commands {
        let command = command.trim();
        if !crate::plugin_command::valid_command_name(command) {
            bail!("command name is not a program name: {command}");
        }
        let command = command.to_string();
        if !programs.contains(&command) {
            programs.push(command);
        }
    }
    let mut grants = Vec::new();
    for file in files {
        let path = grant_path(&file)?;
        if !grants.iter().any(|have: &PathBuf| have == &path) {
            grants.push(path);
        }
    }
    Ok(PluginGrants {
        permissions: kept,
        files: grants,
        commands: programs,
    })
}

fn known(name: &str) -> bool {
    matches!(
        name,
        READ | CONTROL | FILES | PANELS_READ | PANELS_CONTROL | LINKS | COMMANDS
    )
}

pub fn grant_path(path: &str) -> anyhow::Result<PathBuf> {
    let path = path.trim();
    if path.is_empty() || path.contains('\0') {
        bail!("plugin file path is empty");
    }
    if path
        .split(['/', '\\'])
        .any(|part| part == ".." || part == ".")
    {
        bail!("plugin file path cannot contain ..: {path}");
    }
    let trimmed = trim_slash(path);
    let native = Path::new(trimmed);
    if native.is_absolute() || posix_absolute(trimmed) {
        return Ok(PathBuf::from(trimmed));
    }
    bail!("plugin file path must be absolute: {path}");
}

fn trim_slash(path: &str) -> &str {
    let trimmed = path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        path
    } else {
        trimmed
    }
}

fn posix_absolute(path: &str) -> bool {
    path.starts_with('/') && !path.starts_with("//")
}

pub fn wants_bridge(permissions: &[String]) -> bool {
    permissions.iter().any(|name| {
        name == READ
            || name == CONTROL
            || name == PANELS_READ
            || name == PANELS_CONTROL
            || name == LINKS
            || name == COMMANDS
    })
}

pub fn allows_files(permissions: &[String]) -> bool {
    permissions.iter().any(|name| name == FILES)
}

pub fn permission_summary(permissions: &[String]) -> String {
    if permissions.is_empty() {
        "-".into()
    } else {
        permissions.join(", ")
    }
}

pub fn needs_consent(permissions: &[String]) -> bool {
    !permissions.is_empty()
}

pub fn consent_answer(line: &str) -> bool {
    matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes")
}

pub fn grant_label(path: &Path) -> String {
    let shown = path.display().to_string();
    match path.canonicalize() {
        Ok(canon) if !same_place(path, &canon) => {
            format!("{shown} (resolves to {})", display_path(&canon))
        }
        _ => shown,
    }
}

pub fn consent_text(
    id: &str,
    title: &str,
    permissions: &[String],
    files: &[PathBuf],
    commands: &[String],
) -> String {
    let mut lines = vec![
        format!("{id} ({title}) asks for permission to:"),
        String::new(),
    ];
    for permission in permissions {
        match permission.as_str() {
            READ => lines.push(
                "- List Herdr panes, read their status, and read a pane's screen.".into(),
            ),
            CONTROL => lines.push(
                "- Type into a Herdr pane, focus one, and scroll one. A panel still needs \"control\": true in the layout.".into(),
            ),
            FILES => {
                lines.push("- Read these files, and update when they change:".into());
                for file in files {
                    lines.push(format!("  {}", grant_label(file)));
                }
            }
            PANELS_READ => {
                lines.push("- List the panels on this desk.".into());
            }
            PANELS_CONTROL => lines.push(
                "- Open, update, close, move, and resize panels on this desk. Fill the screen with one panel, show the whole desk again, or visit a panel from another space without changing that space. Set this panel's zoom. This does not type into a Herdr pane.".into(),
            ),
            LINKS => lines.push(
                "- Open http and https links in the browser. Other links are refused.".into(),
            ),
            COMMANDS => {
                lines.push(
                    "- Run these programs from PATH, with no shell, and only in a directory that is already an open project:"
                        .into(),
                );
                for command in commands {
                    lines.push(format!("  {command}"));
                }
            }
            _ => {}
        }
    }
    lines.push(String::new());
    lines.join("\n")
}

/// Install text. The permission list stays, and a plugin that opens with control says so.
pub fn install_notice(
    id: &str,
    title: &str,
    permissions: &[String],
    files: &[PathBuf],
    commands: &[String],
    control_default: bool,
) -> String {
    let mut text = consent_text(id, title, permissions, files, commands);
    if control_default {
        if !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str("Panels of this plugin open with control on.\n");
    }
    text
}

/// `File` is a readable file inside a grant. `Missing` is allowed, but not on disk yet.
#[derive(Debug, PartialEq, Eq)]
pub enum ReadPath {
    File(PathBuf),
    Missing(PathBuf),
}

impl ReadPath {
    pub fn path(&self) -> &Path {
        match self {
            Self::File(path) | Self::Missing(path) => path,
        }
    }
}

pub fn resolve_read(grants: &[PathBuf], requested: &str) -> Result<ReadPath, &'static str> {
    let requested_path = absolute_request(requested)?;
    let mut saw_grant = false;
    let mut reason = "outside";
    for grant in grants {
        match resolve_one(grant, &requested_path) {
            Ok(path) => return Ok(path),
            Err("outside") => {}
            Err(err) => {
                saw_grant = true;
                reason = err;
            }
        }
    }
    if saw_grant {
        Err(reason)
    } else {
        Err("outside")
    }
}

fn absolute_request(requested: &str) -> Result<PathBuf, &'static str> {
    if requested.is_empty()
        || requested.len() > 4096
        || requested.contains('\0')
        || requested
            .split(['/', '\\'])
            .any(|part| part == ".." || part == ".")
    {
        return Err("invalid");
    }
    let trimmed = trim_slash(requested.trim());
    let path = PathBuf::from(trimmed);
    if path.is_absolute() || posix_absolute(trimmed) {
        Ok(path)
    } else {
        Err("invalid")
    }
}

fn resolve_one(grant: &Path, requested: &Path) -> Result<ReadPath, &'static str> {
    if !requested.starts_with(grant) {
        return Err("outside");
    }
    let child = requested != grant;
    if foreign_posix(grant) || foreign_posix(requested) {
        return Ok(ReadPath::Missing(requested.to_path_buf()));
    }
    if !grant.exists() {
        ancestor_stays(grant, requested)?;
        return Ok(ReadPath::Missing(requested.to_path_buf()));
    }
    if grant.is_file() && child {
        return Err("outside");
    }
    let root = grant_root(grant)?;
    if requested.exists() {
        let file = requested.canonicalize().map_err(|_| "outside")?;
        if !file.starts_with(&root) {
            return Err("outside");
        }
        if file.is_dir() || (grant.is_dir() && file == root) {
            return Err("not_a_file");
        }
        if !file.is_file() {
            return Err("not_a_file");
        }
        if grant.is_file() && file != root {
            return Err("outside");
        }
        return Ok(ReadPath::File(file));
    }
    match deepest_existing(requested) {
        Some(ancestor) => {
            let canon = ancestor.canonicalize().map_err(|_| "outside")?;
            if !canon.starts_with(&root) && canon != root {
                return Err("outside");
            }
        }
        None => return Err("outside"),
    }
    if grant.is_dir() && !child {
        return Err("not_a_file");
    }
    Ok(ReadPath::Missing(requested.to_path_buf()))
}

fn foreign_posix(path: &Path) -> bool {
    cfg!(windows) && posix_absolute(&path.to_string_lossy())
}

/// A grant that is itself a symlink out of its parent is not a usable root.
fn grant_root(grant: &Path) -> Result<PathBuf, &'static str> {
    let canon = grant.canonicalize().map_err(|_| "outside")?;
    if let Some(parent) = grant.parent() {
        if parent.as_os_str().is_empty() {
            return Ok(canon);
        }
        if parent.exists() {
            let parent_canon = parent.canonicalize().map_err(|_| "outside")?;
            if !canon.starts_with(&parent_canon) {
                return Err("outside");
            }
        }
    }
    Ok(canon)
}

fn ancestor_stays(grant: &Path, requested: &Path) -> Result<(), &'static str> {
    let resolved = resolve_existing_prefix(requested)?;
    let grant_resolved = resolve_existing_prefix(grant)?;
    if resolved.starts_with(&grant_resolved) {
        Ok(())
    } else {
        Err("outside")
    }
}

/// Keep the part of `path` that is already on disk, in canonical form, and put
/// the missing tail back on. macOS firmlinks make `/home` or `/Users` canonicalize
/// somewhere else; the missing file is still inside the grant.
fn resolve_existing_prefix(path: &Path) -> Result<PathBuf, &'static str> {
    let Some(ancestor) = deepest_existing(path) else {
        return Ok(path.to_path_buf());
    };
    let canon = ancestor.canonicalize().map_err(|_| "outside")?;
    let rest = path.strip_prefix(&ancestor).map_err(|_| "outside")?;
    Ok(canon.join(rest))
}

fn deepest_existing(path: &Path) -> Option<PathBuf> {
    let mut cursor = path.to_path_buf();
    loop {
        if cursor.exists() {
            return Some(cursor);
        }
        if !cursor.pop() {
            return None;
        }
    }
}

fn same_place(path: &Path, canon: &Path) -> bool {
    #[cfg(windows)]
    {
        strip_verbatim(path).eq_ignore_ascii_case(&strip_verbatim(canon))
    }
    #[cfg(not(windows))]
    {
        path == canon
    }
}

fn display_path(path: &Path) -> String {
    #[cfg(windows)]
    {
        strip_verbatim(path)
    }
    #[cfg(not(windows))]
    {
        path.display().to_string()
    }
}

#[cfg(windows)]
fn strip_verbatim(path: &Path) -> String {
    let text = path.display().to_string();
    let text = text.strip_prefix(r"\\?\").unwrap_or(&text);
    text.strip_prefix(r"UNC\")
        .unwrap_or(text)
        .replace('/', "\\")
        .trim_end_matches(['\\', '/'])
        .to_string()
}

pub fn bridge_allowed(
    permissions: &[String],
    desk: &DeskDocument,
    plugin_id: &str,
    panel_id: &str,
    method: &str,
) -> Result<(), String> {
    decide(
        permissions,
        method,
        plugin_panel_control(desk, panel_id, plugin_id),
    )
}

/// Same check as [`bridge_allowed`], for the active layout. That file is the
/// desk the page shows when Herdr is offline and no space has been saved yet.
pub fn bridge_allowed_in_layout(
    permissions: &[String],
    root: &LayoutNode,
    plugin_id: &str,
    panel_id: &str,
    method: &str,
) -> Result<(), String> {
    let flag = search_node(root, panel_id, plugin_id).unwrap_or(Err("panel was not found".into()));
    decide(permissions, method, flag)
}

fn decide(permissions: &[String], method: &str, flag: Result<bool, String>) -> Result<(), String> {
    let control_method = matches!(method, "sendText" | "sendKeys" | "focusPane" | "scrollPane");
    let read_method = matches!(method, "status" | "listPanes" | "readPane");
    let panels_read = method == "listPanels";
    let panels_control = matches!(
        method,
        "openPanel"
            | "updatePanel"
            | "closePanel"
            | "movePanel"
            | "resizePanel"
            | "fillPanel"
            | "showDesk"
            | "visitPanel"
            | "setZoom"
    );
    let links = method == "openExternal";
    let run = method == "run";
    if !control_method && !read_method && !panels_read && !panels_control && !links && !run {
        return Err(format!("Unknown bridge method: {method}"));
    }
    let flag = flag?;
    if links {
        if !permissions.iter().any(|name| name == LINKS) {
            return Err("This plugin does not have links:open".into());
        }
        return Ok(());
    }
    if run {
        if !permissions.iter().any(|name| name == COMMANDS) {
            return Err("This plugin does not have commands:run".into());
        }
        return Ok(());
    }
    if panels_read {
        if !permissions.iter().any(|name| name == PANELS_READ) {
            return Err("This plugin does not have panels:read".into());
        }
        return Ok(());
    }
    if panels_control {
        if !permissions.iter().any(|name| name == PANELS_CONTROL) {
            return Err("This plugin does not have panels:control".into());
        }
        return Ok(());
    }
    if control_method {
        if !permissions.iter().any(|name| name == CONTROL) {
            return Err("This plugin does not have herdr:control".into());
        }
        if !flag {
            return Err(CONTROL_OFF.into());
        }
        return Ok(());
    }
    if !permissions.iter().any(|name| name == READ) {
        return Err("This plugin does not have herdr:read".into());
    }
    Ok(())
}

pub fn plugin_panel_control(
    desk: &DeskDocument,
    panel_id: &str,
    plugin_id: &str,
) -> Result<bool, String> {
    for node in desk.spaces.values() {
        if let Some(found) = search_node(node, panel_id, plugin_id) {
            return found;
        }
    }
    for pin in &desk.pins {
        if pin.id == panel_id {
            return control_of(&pin.panel, plugin_id);
        }
    }
    Err("panel was not found".into())
}

fn search_node(node: &LayoutNode, panel_id: &str, plugin_id: &str) -> Option<Result<bool, String>> {
    match node {
        LayoutNode::Panel { id, panel, .. } => {
            if id == panel_id {
                Some(control_of(panel, plugin_id))
            } else {
                None
            }
        }
        LayoutNode::Split { first, second, .. } => search_node(first, panel_id, plugin_id)
            .or_else(|| search_node(second, panel_id, plugin_id)),
        LayoutNode::Grid { cells, .. } => {
            for cell in cells {
                if let Some(found) = cell
                    .node
                    .as_ref()
                    .and_then(|node| search_node(node, panel_id, plugin_id))
                {
                    return Some(found);
                }
                if cell.id == panel_id {
                    if let Some(panel) = &cell.panel {
                        return Some(control_of(panel, plugin_id));
                    }
                }
            }
            None
        }
    }
}

fn control_of(panel: &PanelConfig, plugin_id: &str) -> Result<bool, String> {
    let panel = shown(panel);
    match panel {
        PanelConfig::Plugin {
            plugin, control, ..
        } if plugin == plugin_id => Ok(*control),
        _ => Err("panel is not this plugin".into()),
    }
}

fn shown(panel: &PanelConfig) -> &PanelConfig {
    let PanelConfig::Tabs { tabs, active, .. } = panel else {
        return panel;
    };
    tabs.iter()
        .find(|tab| &tab.id == active)
        .or_else(|| tabs.first())
        .map(|tab| &tab.panel)
        .unwrap_or(panel)
}

pub fn require_pane(panes: &[&str], id: &str) -> Result<(), String> {
    if !is_herdr_pane_id(id) {
        return Err("invalid pane id".into());
    }
    if panes.contains(&id) {
        Ok(())
    } else {
        Err("pane was not found".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::fs;

    #[test]
    fn permissions_accept_the_known_names_and_reject_the_rest() {
        let grants = parse_permissions(
            vec![FILES.into(), CONTROL.into(), FILES.into()],
            vec!["/home/engel/projects/checkin/state".into()],
        )
        .unwrap();
        assert_eq!(grants.permissions, vec![FILES, CONTROL]);
        assert_eq!(
            grants.files,
            vec![PathBuf::from("/home/engel/projects/checkin/state")]
        );

        let plain = parse_permissions(Vec::new(), Vec::new()).unwrap();
        assert!(plain.permissions.is_empty());
        assert!(plain.files.is_empty());
        assert!(!needs_consent(&plain.permissions));

        let missing = parse_permissions(vec![FILES.into()], Vec::new()).unwrap_err();
        assert!(missing.to_string().contains("files list"));

        let unused = parse_permissions(Vec::new(), vec!["/tmp/state".into()]).unwrap_err();
        assert!(unused.to_string().contains("without the files:read"));

        let unknown = parse_permissions(vec!["herdr:write".into()], Vec::new()).unwrap_err();
        assert!(unknown.to_string().contains("unknown permission"));
        assert!(unknown.to_string().contains("herdr:write"));

        let relative =
            parse_permissions(vec![FILES.into()], vec!["state/report.json".into()]).unwrap_err();
        assert!(relative.to_string().contains("absolute"));

        let parent =
            parse_permissions(vec![FILES.into()], vec!["/tmp/state/../secret".into()]).unwrap_err();
        assert!(parent.to_string().contains(".."));

        let empty = parse_permissions(vec![FILES.into()], vec!["  ".into()]).unwrap_err();
        assert!(empty.to_string().contains("empty"));
    }

    #[test]
    fn consent_names_each_permission_and_the_file_paths() {
        let text = consent_text(
            "checkin-report",
            "Check-in report",
            &[FILES.into(), CONTROL.into()],
            &[PathBuf::from("/home/engel/projects/checkin/state")],
            &[],
        );
        assert!(text.contains("checkin-report"));
        assert!(text.contains("/home/engel/projects/checkin/state"));
        assert!(text.contains("control"));
        assert!(text.contains("Read these files"));
        assert!(consent_answer("y"));
        assert!(consent_answer(" YES "));
        assert!(!consent_answer(""));
        assert!(!consent_answer("n"));
        assert_eq!(permission_summary(&[]), "-");
        assert_eq!(
            permission_summary(&[CONTROL.into(), FILES.into()]),
            "herdr:control, files:read"
        );
    }

    #[test]
    fn a_declared_path_accepts_a_file_inside_and_rejects_escape() {
        let root = scratch("grant");
        let state = root.join("state");
        let outside = root.join("outside");
        fs::create_dir_all(&state).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let report = state.join("report.json");
        fs::write(&report, "one").unwrap();
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        let grants = [state.clone()];

        match resolve_read(&grants, &report.display().to_string()).unwrap() {
            ReadPath::File(path) => assert_eq!(fs::read_to_string(path).unwrap(), "one"),
            other => panic!("expected a file, got {other:?}"),
        }
        assert_eq!(
            resolve_read(&grants, &state.display().to_string()),
            Err("not_a_file")
        );
        assert_eq!(
            resolve_read(&grants, &outside.join("secret.txt").display().to_string()),
            Err("outside")
        );
        assert_eq!(resolve_read(&grants, "report.json"), Err("invalid"));
        assert_eq!(
            resolve_read(
                &grants,
                &root
                    .join("state")
                    .join("..")
                    .join("outside")
                    .display()
                    .to_string()
            ),
            Err("invalid")
        );

        let file_grant = [report.clone()];
        assert!(matches!(
            resolve_read(&file_grant, &report.display().to_string()),
            Ok(ReadPath::File(_))
        ));
        let neighbor = state.join("other.json");
        fs::write(&neighbor, "no").unwrap();
        assert_eq!(
            resolve_read(&file_grant, &neighbor.display().to_string()),
            Err("outside")
        );

        let missing = state.join("later.json");
        assert!(matches!(
            resolve_read(&grants, &missing.display().to_string()),
            Ok(ReadPath::Missing(_))
        ));

        let link = state.join("escape");
        link_dir(&link, &outside);
        let escaped = link.join("secret.txt");
        assert_eq!(
            resolve_read(&grants, &escaped.display().to_string()),
            Err("outside")
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_posix_grant_covers_its_file_and_not_a_neighbor() {
        let grants = [PathBuf::from("/home/engel/projects/checkin/state")];
        assert!(matches!(
            resolve_read(&grants, "/home/engel/projects/checkin/state/report.json"),
            Ok(ReadPath::Missing(_))
        ));
        assert_eq!(
            resolve_read(&grants, "/home/engel/projects/checkin/state2/report.json"),
            Err("outside")
        );
        assert_eq!(resolve_read(&grants, "/etc/passwd"), Err("outside"));
    }

    #[test]
    fn control_methods_need_the_permission_and_the_panel_flag() {
        let quiet = desk(false);
        let live = desk(true);
        let read_only = vec![READ.to_string()];
        let control = vec![CONTROL.to_string()];
        for method in ["sendText", "focusPane", "sendKeys", "scrollPane"] {
            let err =
                bridge_allowed(&read_only, &quiet, "checkin-report", "report", method).unwrap_err();
            assert_eq!(err, "This plugin does not have herdr:control");
            let err =
                bridge_allowed(&control, &quiet, "checkin-report", "report", method).unwrap_err();
            assert_eq!(
                err,
                "This panel cannot type into a pane. Turn on \"control\" in the design bar."
            );
            assert!(bridge_allowed(&control, &live, "checkin-report", "report", method).is_ok());
        }
        assert_eq!(
            bridge_allowed(&control, &live, "checkin-report", "report", "listPanes").unwrap_err(),
            "This plugin does not have herdr:read"
        );
        assert!(bridge_allowed(&read_only, &quiet, "checkin-report", "report", "readPane").is_ok());
        assert!(bridge_allowed(&read_only, &quiet, "checkin-report", "report", "status").is_ok());
        assert_eq!(
            bridge_allowed(&control, &live, "other", "report", "focusPane").unwrap_err(),
            "panel is not this plugin"
        );
        assert_eq!(
            bridge_allowed(&control, &live, "checkin-report", "missing", "focusPane").unwrap_err(),
            "panel was not found"
        );
    }

    #[test]
    fn desk_methods_are_separate_from_herdr_control() {
        let quiet = desk(false);
        let live = desk(true);
        let panels_read = vec![PANELS_READ.to_string()];
        let panels_control = vec![PANELS_CONTROL.to_string()];
        let herdr = vec![CONTROL.to_string()];
        assert!(bridge_allowed(
            &panels_read,
            &quiet,
            "checkin-report",
            "report",
            "listPanels"
        )
        .is_ok());
        assert_eq!(
            bridge_allowed(&herdr, &live, "checkin-report", "report", "listPanels").unwrap_err(),
            "This plugin does not have panels:read"
        );
        for method in [
            "openPanel",
            "updatePanel",
            "closePanel",
            "movePanel",
            "resizePanel",
            "fillPanel",
            "showDesk",
            "visitPanel",
            "setZoom",
        ] {
            assert_eq!(
                bridge_allowed(&panels_read, &quiet, "checkin-report", "report", method)
                    .unwrap_err(),
                "This plugin does not have panels:control"
            );
            assert!(
                bridge_allowed(&panels_control, &quiet, "checkin-report", "report", method).is_ok(),
                "{method} works without the Herdr control flag"
            );
        }
        assert_eq!(
            bridge_allowed(
                &panels_control,
                &live,
                "checkin-report",
                "report",
                "sendText"
            )
            .unwrap_err(),
            "This plugin does not have herdr:control"
        );
        assert_eq!(
            bridge_allowed(
                &panels_control,
                &live,
                "checkin-report",
                "report",
                "scrollPane"
            )
            .unwrap_err(),
            "This plugin does not have herdr:control"
        );
        assert_eq!(
            bridge_allowed(&herdr, &live, "checkin-report", "report", "closePanel").unwrap_err(),
            "This plugin does not have panels:control"
        );
        assert_eq!(
            bridge_allowed(&herdr, &live, "checkin-report", "report", "setZoom").unwrap_err(),
            "This plugin does not have panels:control"
        );
        assert!(wants_bridge(&[PANELS_READ.into()]));
        assert!(wants_bridge(&[PANELS_CONTROL.into()]));
        let text = consent_text(
            "desk",
            "Desk",
            &[PANELS_READ.into(), PANELS_CONTROL.into()],
            &[],
            &[],
        );
        assert!(text.contains("List the panels on this desk"));
        assert!(text.contains("does not type into a Herdr pane"));
        assert!(text.contains("Set this panel's zoom"));
        let typing = consent_text("report", "Report", &[CONTROL.into()], &[], &[]);
        assert!(typing.contains("scroll one"));
        let notice = install_notice("report", "Report", &[CONTROL.into()], &[], &[], true);
        assert!(notice.contains("scroll one"));
        assert!(notice.contains("open with control on"));
    }

    #[test]
    fn opening_a_link_needs_links_open_and_nothing_else() {
        let quiet = desk(false);
        let links = vec![LINKS.to_string()];
        let panels = vec![PANELS_CONTROL.to_string()];
        assert!(wants_bridge(&links));
        assert!(bridge_allowed(&links, &quiet, "checkin-report", "report", "openExternal").is_ok());
        assert_eq!(
            bridge_allowed(&panels, &quiet, "checkin-report", "report", "openExternal")
                .unwrap_err(),
            "This plugin does not have links:open"
        );
        assert_eq!(
            bridge_allowed(&links, &quiet, "checkin-report", "report", "openPanel").unwrap_err(),
            "This plugin does not have panels:control"
        );
        assert_eq!(
            bridge_allowed(&links, &quiet, "checkin-report", "report", "listPanes").unwrap_err(),
            "This plugin does not have herdr:read"
        );
        let text = consent_text("report", "Report", &links, &[], &[]);
        assert!(text.contains("Open http and https links in the browser"));
        assert!(text.contains("Other links are refused"));
        let grants = parse_permissions(vec![LINKS.into(), LINKS.into()], Vec::new()).unwrap();
        assert_eq!(grants.permissions, vec![LINKS]);
    }

    #[test]
    fn running_a_program_needs_commands_run_and_a_program_name() {
        let quiet = desk(false);
        let run = vec![COMMANDS.to_string()];
        assert!(wants_bridge(&run));
        assert!(bridge_allowed(&run, &quiet, "checkin-report", "report", "run").is_ok());
        assert_eq!(
            bridge_allowed(&run, &quiet, "checkin-report", "report", "sendText").unwrap_err(),
            "This plugin does not have herdr:control"
        );
        let missing = parse_grants(vec![COMMANDS.into()], Vec::new(), Vec::new()).unwrap_err();
        assert!(missing.to_string().contains("commands list"), "{missing}");
        let path = parse_grants(
            vec![COMMANDS.into()],
            Vec::new(),
            vec![r"C:\Windows\system32\cmd.exe".into()],
        )
        .unwrap_err();
        assert!(path.to_string().contains("program name"), "{path}");
        let grants = parse_grants(
            vec![COMMANDS.into(), READ.into()],
            Vec::new(),
            vec!["ai-diff".into(), "ai-diff".into()],
        )
        .unwrap();
        assert_eq!(grants.commands, vec!["ai-diff".to_string()]);
        let text = consent_text("ai-diff", "AI diff", &run, &[], &grants.commands);
        assert!(text.contains("no shell"));
        assert!(text.contains("ai-diff"));
    }

    #[test]
    fn an_offline_layout_still_gates_control() {
        let control = vec![CONTROL.to_string()];
        assert_eq!(
            bridge_allowed(
                &control,
                &DeskDocument::default(),
                "checkin-report",
                "report",
                "focusPane"
            )
            .unwrap_err(),
            "panel was not found"
        );
        let live = desk(true).spaces.into_values().next().unwrap();
        assert!(
            bridge_allowed_in_layout(&control, &live, "checkin-report", "report", "focusPane")
                .is_ok()
        );
        let quiet = desk(false).spaces.into_values().next().unwrap();
        assert_eq!(
            bridge_allowed_in_layout(&control, &quiet, "checkin-report", "report", "focusPane")
                .unwrap_err(),
            "This panel cannot type into a pane. Turn on \"control\" in the design bar."
        );
    }

    #[test]
    fn focus_requires_a_pane_id_that_exists() {
        assert_eq!(require_pane(&["w8:pG"], "w8:pG"), Ok(()));
        assert_eq!(
            require_pane(&["w1:p1"], "w8:pG").unwrap_err(),
            "pane was not found"
        );
        assert_eq!(
            require_pane(&["w8:pG"], "not a pane").unwrap_err(),
            "invalid pane id"
        );
        assert_eq!(
            require_pane(&["w8:pG"], "../w8:pG").unwrap_err(),
            "invalid pane id"
        );
        assert!(is_herdr_pane_id("wK:p1"));
        assert!(!is_herdr_pane_id("p1"));
    }

    fn desk(control: bool) -> DeskDocument {
        let mut spaces = BTreeMap::new();
        spaces.insert(
            "main".into(),
            LayoutNode::Panel {
                id: "report".into(),
                title: None,
                collapsed: false,
                panel: PanelConfig::Plugin {
                    plugin: "checkin-report".into(),
                    config: serde_json::Value::Null,
                    view: None,
                    path: None,
                    url: None,
                    directory: false,
                    address_bar: None,
                    control,
                },
            },
        );
        DeskDocument {
            revision: 1,
            pins: Vec::new(),
            spaces,
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "hwp-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn link_dir(link: &Path, target: &Path) {
        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd")
                .args([
                    "/c",
                    "mklink",
                    "/J",
                    &link.display().to_string(),
                    &target.display().to_string(),
                ])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .expect("creating a junction");
            assert!(status.success(), "creating a junction");
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).expect("creating a symlink");
    }
}
