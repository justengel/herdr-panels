use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

use crate::herdr::HerdrClient;

#[derive(Clone)]
pub struct RuntimeCache {
    herdr: HerdrClient,
    inner: Arc<Mutex<Slot>>,
}

struct Slot {
    at: Instant,
    value: Option<RuntimeSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub connected: bool,
    pub error: Option<String>,
    pub version: Option<String>,
    pub protocol: Option<u64>,
    pub socket: String,
    pub session: String,
    pub focused_pane_id: Option<String>,
    pub focused_tab_id: Option<String>,
    pub focused_workspace_id: Option<String>,
    pub workspaces: Vec<WorkspaceView>,
    pub tabs: Vec<TabView>,
    pub panes: Vec<PaneView>,
    pub agents: Vec<AgentView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceView {
    pub workspace_id: String,
    pub label: String,
    pub focused: bool,
    /// Tab this workspace returns to. Herdr keeps one per workspace.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_tab_id: Option<String>,
    pub root: Option<String>,
    pub branch: Option<String>,
    pub dirty: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabView {
    pub tab_id: String,
    pub workspace_id: String,
    pub label: String,
    pub focused: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneView {
    pub pane_id: String,
    pub workspace_id: String,
    pub tab_id: String,
    pub label: Option<String>,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub agent_status: String,
    pub agent: Option<String>,
    pub agent_name: Option<String>,
    pub focused: bool,
    pub x: Option<u16>,
    pub y: Option<u16>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentView {
    pub pane_id: String,
    pub name: Option<String>,
    pub agent: Option<String>,
    pub agent_status: String,
    pub title: Option<String>,
}

impl RuntimeCache {
    pub fn new(herdr: HerdrClient) -> Self {
        Self {
            herdr,
            inner: Arc::new(Mutex::new(Slot {
                at: Instant::now() - Duration::from_secs(60),
                value: None,
            })),
        }
    }

    pub fn client(&self) -> &HerdrClient {
        &self.herdr
    }

    pub fn invalidate(&self) {
        if let Ok(mut slot) = self.inner.lock() {
            slot.value = None;
            slot.at = Instant::now() - Duration::from_secs(60);
        }
    }

    pub async fn snapshot(&self) -> RuntimeSnapshot {
        if let Some(cached) = self.fresh() {
            return cached;
        }
        let loaded = self.fetch().await;
        if let Ok(mut slot) = self.inner.lock() {
            slot.at = Instant::now();
            slot.value = Some(loaded.clone());
        }
        loaded
    }

    fn fresh(&self) -> Option<RuntimeSnapshot> {
        let slot = self.inner.lock().ok()?;
        let value = slot.value.clone()?;
        let ttl = if value.connected {
            Duration::from_millis(500)
        } else {
            Duration::from_millis(400)
        };
        (slot.at.elapsed() < ttl).then_some(value)
    }

    async fn fetch(&self) -> RuntimeSnapshot {
        match self.herdr.call("session.snapshot", json!({})).await {
            Ok(result) => match map_snapshot(&self.herdr.logical_socket(), &result) {
                Ok(mut snapshot) => {
                    attach_branches(&mut snapshot).await;
                    snapshot
                }
                Err(err) => disconnected(&self.herdr.logical_socket(), err),
            },
            Err(err) => disconnected(&self.herdr.logical_socket(), err.to_string()),
        }
    }
}

pub fn map_snapshot(socket: &str, result: &Value) -> Result<RuntimeSnapshot, String> {
    let snapshot = result
        .get("snapshot")
        .ok_or_else(|| "snapshot missing".to_string())?;
    let mut panes = snapshot
        .get("panes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|pane| pane_view(&pane))
        .collect::<Vec<_>>();
    let layouts = snapshot
        .get("layouts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for pane in &mut panes {
        if let Some(rect) = geometry_for(&layouts, &pane.pane_id) {
            pane.x = Some(rect.x);
            pane.y = Some(rect.y);
            pane.cols = Some(rect.cols);
            pane.rows = Some(rect.rows);
        }
    }
    let tabs = snapshot
        .get("tabs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|tab| tab_view(&tab))
        .collect();
    let agents = snapshot
        .get("agents")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|agent| agent_view(&agent))
        .collect::<Vec<_>>();
    for pane in &mut panes {
        if let Some(agent) = agents.iter().find(|agent| agent.pane_id == pane.pane_id) {
            pane.agent = pane.agent.clone().or(agent.agent.clone());
            pane.agent_name = pane.agent_name.clone().or(agent.name.clone());
            if pane.agent_status == "unknown" && agent.agent_status != "unknown" {
                pane.agent_status = agent.agent_status.clone();
            }
            pane.title = pane.title.clone().or(agent.title.clone());
        }
    }
    let workspaces = snapshot
        .get("workspaces")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|workspace| {
            Some(WorkspaceView {
                workspace_id: text(&workspace, "workspace_id")?,
                label: text(&workspace, "label").unwrap_or_else(|| "workspace".into()),
                focused: workspace
                    .get("focused")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                active_tab_id: text(&workspace, "active_tab_id"),
                root: workspace.get("worktree").and_then(|worktree| {
                    text(worktree, "checkout_path").or_else(|| text(worktree, "repo_root"))
                }),
                branch: None,
                dirty: false,
            })
        })
        .collect();
    Ok(RuntimeSnapshot {
        connected: true,
        error: None,
        version: snapshot
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_string),
        protocol: snapshot.get("protocol").and_then(Value::as_u64),
        socket: socket.to_string(),
        session: crate::paths::session_label(std::path::Path::new(socket)),
        focused_pane_id: snapshot
            .get("focused_pane_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        focused_tab_id: text(snapshot, "focused_tab_id"),
        focused_workspace_id: text(snapshot, "focused_workspace_id"),
        workspaces,
        tabs,
        panes,
        agents,
    })
}

fn pane_view(pane: &Value) -> Option<PaneView> {
    let rows = pane
        .get("scroll")
        .and_then(|scroll| scroll.get("viewport_rows"))
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok());
    Some(PaneView {
        pane_id: text(pane, "pane_id")?,
        workspace_id: text(pane, "workspace_id").unwrap_or_default(),
        tab_id: text(pane, "tab_id").unwrap_or_default(),
        label: text(pane, "label"),
        title: text(pane, "title").or_else(|| text(pane, "terminal_title_stripped")),
        cwd: text(pane, "cwd").or_else(|| text(pane, "foreground_cwd")),
        agent_status: text(pane, "agent_status").unwrap_or_else(|| "unknown".into()),
        agent: text(pane, "agent").or_else(|| text(pane, "display_agent")),
        agent_name: None,
        focused: pane
            .get("focused")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        x: None,
        y: None,
        cols: None,
        rows,
    })
}

fn tab_view(tab: &Value) -> Option<TabView> {
    Some(TabView {
        tab_id: text(tab, "tab_id")?,
        workspace_id: text(tab, "workspace_id").unwrap_or_default(),
        label: text(tab, "label").unwrap_or_else(|| "1".into()),
        focused: tab.get("focused").and_then(Value::as_bool).unwrap_or(false),
    })
}

fn agent_view(agent: &Value) -> Option<AgentView> {
    Some(AgentView {
        pane_id: text(agent, "pane_id")?,
        name: text(agent, "name"),
        agent: text(agent, "agent").or_else(|| text(agent, "display_agent")),
        agent_status: text(agent, "agent_status").unwrap_or_else(|| "unknown".into()),
        title: text(agent, "title"),
    })
}

struct PaneRect {
    x: u16,
    y: u16,
    cols: u16,
    rows: u16,
}

fn geometry_for(layouts: &[Value], pane_id: &str) -> Option<PaneRect> {
    for layout in layouts {
        let panes = layout.get("panes")?.as_array()?;
        for pane in panes {
            if pane.get("pane_id").and_then(Value::as_str) != Some(pane_id) {
                continue;
            }
            let rect = pane.get("rect")?;
            let cols = u16::try_from(rect.get("width").and_then(Value::as_u64)?).ok()?;
            let rows = u16::try_from(rect.get("height").and_then(Value::as_u64)?).ok()?;
            if cols == 0 || rows == 0 {
                continue;
            }
            let x = u16::try_from(rect.get("x").and_then(Value::as_u64).unwrap_or(0)).ok()?;
            let y = u16::try_from(rect.get("y").and_then(Value::as_u64).unwrap_or(0)).ok()?;
            return Some(PaneRect { x, y, cols, rows });
        }
    }
    None
}

/// Pane a new workspace's Terminal panel should show.
/// A workspace is created with one pane, and that pane is its root pane.
pub fn root_pane_id(snapshot: &RuntimeSnapshot, workspace_id: &str) -> Option<String> {
    let active_tab = snapshot
        .workspaces
        .iter()
        .find(|space| space.workspace_id == workspace_id)
        .and_then(|space| space.active_tab_id.as_deref());
    let on_tab: Vec<&PaneView> = snapshot
        .panes
        .iter()
        .filter(|pane| pane.workspace_id == workspace_id)
        .filter(|pane| match active_tab {
            Some(tab) => pane.tab_id == tab,
            None => true,
        })
        .collect();
    let panes = if on_tab.is_empty() {
        snapshot
            .panes
            .iter()
            .filter(|pane| pane.workspace_id == workspace_id)
            .collect::<Vec<_>>()
    } else {
        on_tab
    };
    panes.first().map(|pane| pane.pane_id.clone())
}

fn fill_workspace_roots(snapshot: &mut RuntimeSnapshot) {
    let dirs: Vec<(String, String)> = snapshot
        .workspaces
        .iter()
        .filter_map(|workspace| {
            if workspace
                .root
                .as_ref()
                .filter(|root| !root.is_empty())
                .is_some()
            {
                return None;
            }
            workspace_dir(snapshot, workspace).map(|dir| (workspace.workspace_id.clone(), dir))
        })
        .collect();
    for (id, dir) in dirs {
        if let Some(workspace) = snapshot
            .workspaces
            .iter_mut()
            .find(|workspace| workspace.workspace_id == id)
        {
            workspace.root = Some(dir);
        }
    }
}

async fn attach_branches(snapshot: &mut RuntimeSnapshot) {
    fill_workspace_roots(snapshot);
    let jobs: Vec<(String, String)> = snapshot
        .workspaces
        .iter()
        .filter_map(|workspace| {
            workspace_dir(snapshot, workspace).map(|dir| (workspace.workspace_id.clone(), dir))
        })
        .collect();
    if jobs.is_empty() {
        return;
    }
    let faces = tokio::task::spawn_blocking(move || {
        jobs.into_iter()
            .map(|(id, dir)| {
                let (branch, dirty) = git_face(&dir);
                (id, branch, dirty)
            })
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default();
    for (id, branch, dirty) in faces {
        if let Some(workspace) = snapshot
            .workspaces
            .iter_mut()
            .find(|workspace| workspace.workspace_id == id)
        {
            workspace.branch = branch;
            workspace.dirty = dirty;
        }
    }
}

fn workspace_dir(snapshot: &RuntimeSnapshot, workspace: &WorkspaceView) -> Option<String> {
    if let Some(root) = workspace.root.as_ref().filter(|root| !root.is_empty()) {
        return Some(root.clone());
    }
    let mut fallback = None;
    for pane in snapshot
        .panes
        .iter()
        .filter(|pane| pane.workspace_id == workspace.workspace_id)
    {
        let Some(cwd) = pane.cwd.as_ref().filter(|cwd| !cwd.is_empty()) else {
            continue;
        };
        if pane.focused {
            return Some(cwd.clone());
        }
        if fallback.is_none() {
            fallback = Some(cwd.clone());
        }
    }
    fallback
}

fn git_face(dir: &str) -> (Option<String>, bool) {
    let now = Instant::now();
    if let Ok(cache) = git_cache().lock() {
        if let Some(hit) = cache
            .iter()
            .find(|hit| hit.dir == dir && now.duration_since(hit.at) < Duration::from_secs(5))
        {
            return (hit.branch.clone(), hit.dirty);
        }
    }
    let face = git_face_uncached(dir);
    if let Ok(mut cache) = git_cache().lock() {
        cache.retain(|hit| hit.dir != dir);
        if cache.len() > 32 {
            cache.remove(0);
        }
        cache.push(GitFace {
            at: now,
            dir: dir.to_string(),
            branch: face.0.clone(),
            dirty: face.1,
        });
    }
    face
}

struct GitFace {
    at: Instant,
    dir: String,
    branch: Option<String>,
    dirty: bool,
}

fn git_cache() -> &'static std::sync::Mutex<Vec<GitFace>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<Vec<GitFace>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

fn git_face_uncached(dir: &str) -> (Option<String>, bool) {
    let mut command = std::process::Command::new("git");
    command
        .args([
            "-C",
            dir,
            "status",
            "--porcelain=v1",
            "-b",
            "--untracked-files=no",
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    crate::quiet_process::quiet(&mut command);
    let output = command.output();
    let Ok(output) = output else {
        return (None, false);
    };
    if !output.status.success() {
        return (None, false);
    }
    parse_branch_status(&String::from_utf8_lossy(&output.stdout))
}

pub(crate) fn parse_branch_status(text: &str) -> (Option<String>, bool) {
    let mut lines = text.lines();
    let Some(header) = lines.next() else {
        return (None, false);
    };
    let Some(rest) = header.trim().strip_prefix("## ") else {
        return (None, false);
    };
    let name = if let Some(on) = rest.strip_prefix("No commits yet on ") {
        on.split([' ', '.']).next().unwrap_or("").trim()
    } else {
        rest.split([' ', '.']).next().unwrap_or("").trim()
    };
    let branch = if name.is_empty() || name == "HEAD" {
        Some("detached".to_string())
    } else {
        Some(name.to_string())
    };
    let dirty = lines.any(|line| !line.trim().is_empty());
    (branch, dirty)
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn disconnected(socket: &str, error: String) -> RuntimeSnapshot {
    RuntimeSnapshot {
        connected: false,
        error: Some(error),
        version: None,
        protocol: None,
        socket: socket.to_string(),
        session: crate::paths::session_label(std::path::Path::new(socket)),
        focused_pane_id: None,
        focused_tab_id: None,
        focused_workspace_id: None,
        workspaces: Vec::new(),
        tabs: Vec::new(),
        panes: Vec::new(),
        agents: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_geometry_from_snapshot() {
        let raw = r#"{
          "type": "session_snapshot",
          "snapshot": {
            "version": "0.8.2",
            "protocol": 20,
            "focused_pane_id": "w1:p1",
            "workspaces": [{"workspace_id": "w1", "label": "probe", "focused": true}],
            "panes": [{
              "pane_id": "w1:p1",
              "workspace_id": "w1",
              "tab_id": "w1:t1",
              "focused": true,
              "cwd": "/repo",
              "agent_status": "unknown",
              "scroll": {"viewport_rows": 39}
            }],
            "layouts": [{
              "panes": [{"pane_id": "w1:p1", "rect": {"x": 0, "y": 0, "width": 94, "height": 39}}]
            }],
            "agents": []
          }
        }"#;
        let value = serde_json::from_str(raw).unwrap();
        let runtime = map_snapshot("sock", &value).unwrap();
        assert!(runtime.connected);
        assert_eq!(runtime.panes[0].cols, Some(94));
        assert_eq!(runtime.panes[0].rows, Some(39));
        assert_eq!(runtime.workspaces[0].label, "probe");
        assert_eq!(runtime.session, "default");
    }

    #[test]
    fn reads_tabs_and_pane_origin() {
        let raw = r#"{
          "snapshot": {
            "focused_pane_id": "w4:p2",
            "focused_tab_id": "w4:t2",
            "focused_workspace_id": "w4",
            "workspaces": [{"workspace_id": "w4", "label": "projects", "focused": true, "active_tab_id": "w4:t2"}],
            "tabs": [
              {"tab_id": "w4:t1", "workspace_id": "w4", "label": "1", "focused": false},
              {"tab_id": "w4:t2", "workspace_id": "w4", "label": "2", "focused": true}
            ],
            "panes": [{
              "pane_id": "w4:p2",
              "workspace_id": "w4",
              "tab_id": "w4:t2",
              "focused": true,
              "agent_status": "idle"
            }],
            "layouts": [{
              "tab_id": "w4:t2",
              "panes": [{"pane_id": "w4:p2", "rect": {"x": 26, "y": 1, "width": 94, "height": 29}}]
            }],
            "agents": []
          }
        }"#;
        let value = serde_json::from_str(raw).unwrap();
        let runtime = map_snapshot("sock", &value).unwrap();
        assert_eq!(runtime.focused_tab_id.as_deref(), Some("w4:t2"));
        assert_eq!(runtime.focused_workspace_id.as_deref(), Some("w4"));
        assert_eq!(runtime.workspaces[0].active_tab_id.as_deref(), Some("w4:t2"));
        assert_eq!(runtime.tabs.len(), 2);
        assert_eq!(runtime.tabs[1].label, "2");
        assert!(runtime.tabs[1].focused);
        assert_eq!(runtime.panes[0].x, Some(26));
        assert_eq!(runtime.panes[0].y, Some(1));
    }

    #[test]
    fn missing_workspace_root_uses_the_focused_pane_directory() {
        let mut snapshot = RuntimeSnapshot {
            connected: true,
            error: None,
            version: None,
            protocol: None,
            socket: "sock".to_string(),
            session: "default".to_string(),
            focused_pane_id: Some("w1:p1".to_string()),
            focused_tab_id: None,
            focused_workspace_id: Some("w1".to_string()),
            workspaces: vec![WorkspaceView {
                workspace_id: "w1".to_string(),
                label: "proj".to_string(),
                focused: true,
                active_tab_id: None,
                root: None,
                branch: None,
                dirty: false,
            }],
            tabs: Vec::new(),
            panes: vec![PaneView {
                pane_id: "w1:p1".to_string(),
                workspace_id: "w1".to_string(),
                tab_id: "w1:t1".to_string(),
                label: None,
                title: None,
                cwd: Some("C:/Users/me/proj".to_string()),
                agent_status: "unknown".to_string(),
                agent: None,
                agent_name: None,
                focused: true,
                x: None,
                y: None,
                cols: None,
                rows: None,
            }],
            agents: Vec::new(),
        };
        fill_workspace_roots(&mut snapshot);
        assert_eq!(
            snapshot.workspaces[0].root.as_deref(),
            Some("C:/Users/me/proj")
        );
    }

    #[test]
    fn a_new_workspace_root_pane_is_the_pane_on_its_active_tab() {
        let snapshot = RuntimeSnapshot {
            connected: true,
            error: None,
            version: None,
            protocol: None,
            socket: "sock".into(),
            session: "default".into(),
            focused_pane_id: Some("w1:p1".into()),
            focused_tab_id: Some("w1:t1".into()),
            focused_workspace_id: Some("w1".into()),
            workspaces: vec![
                WorkspaceView {
                    workspace_id: "w1".into(),
                    label: "here".into(),
                    focused: true,
                    active_tab_id: Some("w1:t1".into()),
                    root: None,
                    branch: None,
                    dirty: false,
                },
                WorkspaceView {
                    workspace_id: "w3".into(),
                    label: "next".into(),
                    focused: false,
                    active_tab_id: Some("w3:t1".into()),
                    root: None,
                    branch: None,
                    dirty: false,
                },
            ],
            tabs: Vec::new(),
            panes: vec![
                PaneView {
                    pane_id: "w1:p1".into(),
                    workspace_id: "w1".into(),
                    tab_id: "w1:t1".into(),
                    label: None,
                    title: None,
                    cwd: None,
                    agent_status: "unknown".into(),
                    agent: None,
                    agent_name: None,
                    focused: true,
                    x: None,
                    y: None,
                    cols: None,
                    rows: None,
                },
                PaneView {
                    pane_id: "w3:p1".into(),
                    workspace_id: "w3".into(),
                    tab_id: "w3:t1".into(),
                    label: None,
                    title: None,
                    cwd: None,
                    agent_status: "unknown".into(),
                    agent: None,
                    agent_name: None,
                    focused: false,
                    x: None,
                    y: None,
                    cols: None,
                    rows: None,
                },
            ],
            agents: Vec::new(),
        };
        assert_eq!(root_pane_id(&snapshot, "w3").as_deref(), Some("w3:p1"));
        assert_eq!(root_pane_id(&snapshot, "w9"), None);
    }

    #[test]
    fn branch_status_reads_the_name_and_a_dirty_mark() {
        let (branch, dirty) = parse_branch_status("## master...origin/master\n");
        assert_eq!(branch.as_deref(), Some("master"));
        assert!(!dirty);
        let (branch, dirty) =
            parse_branch_status("## feature/one...origin/feature/one\n M src/main.rs\n");
        assert_eq!(branch.as_deref(), Some("feature/one"));
        assert!(dirty);
        let (branch, _) = parse_branch_status("## HEAD (no branch)\n");
        assert_eq!(branch.as_deref(), Some("detached"));
    }
}
