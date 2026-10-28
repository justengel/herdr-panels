use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Path, State, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{broadcast, oneshot, Mutex};

use crate::chats::{self, ChatMessage};
use crate::desk;
use crate::keys::ClientInput;
use crate::layout::{is_pane_id, Direction, LayoutDocument, LayoutNode, PanelConfig};
use crate::layout_ops::{self, list_panels};
use crate::paths::{is_loopback_url, resolve_content};
use crate::server::AppState;
use crate::store;
use crate::terminal::dispatch;

struct InspectSlot {
    id: String,
    sender: oneshot::Sender<Value>,
}

#[derive(Clone)]
pub struct AgentHub {
    events: broadcast::Sender<String>,
    pending: Arc<Mutex<Vec<InspectSlot>>>,
    viewers: Arc<AtomicUsize>,
    ids: Arc<AtomicUsize>,
}

impl Default for AgentHub {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentHub {
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(256);
        Self {
            events,
            pending: Arc::new(Mutex::new(Vec::new())),
            viewers: Arc::new(AtomicUsize::new(0)),
            ids: Arc::new(AtomicUsize::new(1)),
        }
    }

    pub fn viewers(&self) -> usize {
        self.viewers.load(Ordering::Relaxed)
    }

    pub fn publish(&self, value: &Value) {
        if let Ok(text) = serde_json::to_string(value) {
            let _ = self.events.send(text);
        }
    }

    pub async fn inspect(
        &self,
        panel_id: &str,
        selector: Option<&str>,
        text: Option<&str>,
    ) -> Option<Value> {
        if self.viewers() == 0 {
            return None;
        }
        let request_id = format!("i{}", self.ids.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.push(InspectSlot {
            id: request_id.clone(),
            sender: tx,
        });
        self.publish(&json!({
            "type": "inspect",
            "requestId": request_id,
            "panelId": panel_id,
            "selector": selector,
            "text": text,
        }));
        match tokio::time::timeout(Duration::from_millis(900), rx).await {
            Ok(Ok(value)) => Some(value),
            _ => {
                self.pending
                    .lock()
                    .await
                    .retain(|slot| slot.id != request_id);
                None
            }
        }
    }

    async fn resolve(&self, request_id: &str, value: Value) {
        let mut pending = self.pending.lock().await;
        if let Some(index) = pending.iter().position(|slot| slot.id == request_id) {
            let slot = pending.remove(index);
            let _ = slot.sender.send(value);
        }
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/agent", get(index))
        .route("/api/agent/workspace", get(workspace))
        .route("/api/agent/split", post(split))
        .route("/api/agent/close", post(close))
        .route("/api/agent/resize", post(resize))
        .route("/api/agent/update", post(update_panel))
        .route("/api/agent/move", post(move_panel))
        .route("/api/agent/zoom", post(zoom))
        .route("/api/agent/visit", post(visit))
        .route("/api/agent/spaces", get(spaces))
        .route("/api/agent/open", post(open_target))
        .route("/api/agent/resolve", post(resolve_target))
        .route("/api/agent/say", post(say))
        .route("/api/agent/panels/{id}", get(read_panel))
        .route("/api/agent/panels/{id}/write", post(write_panel))
        .route("/api/agent/panels/{id}/select", post(select_panel))
        .route("/ws/agent", get(agent_ws))
}

async fn index(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "viewer": state.agent.viewers() > 0,
        "workspace": "GET /api/agent/workspace",
        "split": "POST /api/agent/split {panelId, direction: right|down, title?, panel?, herdr?}",
        "close": "POST /api/agent/close {panelId}",
        "resize": "POST /api/agent/resize {panelId, ratio}",
        "update": "POST /api/agent/update {panelId, title?, panel?}",
        "move": "POST /api/agent/move {panelId, target, place?: swap|right|below}",
        "zoom": "POST /api/agent/zoom {panelId?}",
        "visit": "POST /api/agent/visit {panelId} -> {panelId, title, spaceId, space}",
        "spaces": "GET /api/agent/spaces",
        "open": "POST /api/agent/open {target, panelId?, from?, direction?: right|down, reuse?: bool, title?}",
        "resolve": "POST /api/agent/resolve {target}",
        "read": "GET /api/agent/panels/{id}?selector=&text=",
        "write": "POST /api/agent/panels/{id}/write {text?, keys?}",
        "select": "POST /api/agent/panels/{id}/select {selector?, text?}",
        "say": "POST /api/agent/say {to: panel name, id, or *, text, from?}",
        "names": "panelId and {id} accept a panel id or its unique name"
    }))
}

async fn workspace(State(state): State<AppState>) -> Result<Json<Value>, AgentError> {
    let doc = load_active(&state).await?;
    Ok(Json(workspace_json(&state, &doc)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SplitBody {
    panel_id: String,
    direction: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    panel: Option<PanelConfig>,
    #[serde(default)]
    herdr: bool,
}

async fn split(
    State(state): State<AppState>,
    Json(body): Json<SplitBody>,
) -> Result<Json<Value>, AgentError> {
    let direction = match body.direction.as_str() {
        "right" => Direction::Row,
        "down" => Direction::Column,
        _ => return Err(AgentError::bad("direction must be right or down")),
    };
    let mut doc = load_active(&state).await?;
    let source_id = resolve_key(&doc.root, &body.panel_id)?;
    let source = list_panels(&doc.root)
        .into_iter()
        .find(|panel| panel.id == source_id)
        .ok_or_else(|| AgentError::missing("panel was not found"))?;
    if body.herdr && herdr_pane(&source.panel).is_none() {
        return Err(AgentError::bad(
            "herdr split needs a terminal panel with a pane",
        ));
    }
    let created_panel = if body.herdr {
        PanelConfig::Herdr {
            pane_id: None,
            source: None,
            lines: None,
        }
    } else {
        body.panel.unwrap_or(PanelConfig::Herdr {
            pane_id: None,
            source: None,
            lines: None,
        })
    };
    let created_id = layout_ops::fresh_id(&doc.root);
    let title = body
        .title
        .map(|title| title.chars().take(80).collect::<String>())
        .filter(|title| !title.trim().is_empty())
        .or_else(|| Some(default_title(&created_panel).into()));
    let created = LayoutNode::Panel {
        id: created_id.clone(),
        title,
        panel: created_panel,
        collapsed: false,
    };
    doc.root = layout_ops::split_panel(doc.root, &source_id, direction, created)
        .map_err(AgentError::bad)?;
    if body.herdr {
        let pane_id = herdr_pane(&source.panel)
            .ok_or_else(|| AgentError::bad("herdr split needs a terminal panel with a pane"))?;
        let client = state.runtime.client().clone();
        let new_pane = client
            .split_pane(pane_id, herdr_direction(direction))
            .await
            .map_err(|err| AgentError::upstream(err.to_string()))?;
        doc.root = layout_ops::update_panel(
            doc.root,
            &created_id,
            None,
            Some(PanelConfig::Herdr {
                pane_id: Some(new_pane),
                source: None,
                lines: None,
            }),
        )
        .map_err(AgentError::bad)?;
    }
    let doc = save_active(&state, doc).await?;
    Ok(Json(json!({
        "panelId": created_id,
        "workspace": workspace_json(&state, &doc),
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PanelBody {
    panel_id: String,
}

async fn close(
    State(state): State<AppState>,
    Json(body): Json<PanelBody>,
) -> Result<Json<Value>, AgentError> {
    close_desk(&state, &body.panel_id).await.map(Json)
}

pub(crate) async fn close_desk(state: &AppState, panel_id: &str) -> Result<Value, AgentError> {
    let mut doc = load_active(state).await?;
    let panel_id = resolve_key(&doc.root, panel_id)?;
    doc.root = layout_ops::close_panel(doc.root, &panel_id).map_err(AgentError::bad)?;
    let doc = save_active(state, doc).await?;
    Ok(workspace_json(state, &doc))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResizeBody {
    panel_id: String,
    ratio: f64,
}

async fn resize(
    State(state): State<AppState>,
    Json(body): Json<ResizeBody>,
) -> Result<Json<Value>, AgentError> {
    resize_desk(&state, &body.panel_id, body.ratio)
        .await
        .map(Json)
}

pub(crate) async fn resize_desk(
    state: &AppState,
    panel_id: &str,
    ratio: f64,
) -> Result<Value, AgentError> {
    let mut doc = load_active(state).await?;
    let panel_id = resolve_key(&doc.root, panel_id)?;
    doc.root = layout_ops::resize_panel(doc.root, &panel_id, ratio).map_err(AgentError::bad)?;
    let doc = save_active(state, doc).await?;
    Ok(workspace_json(state, &doc))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateBody {
    panel_id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    panel: Option<PanelConfig>,
    #[serde(default)]
    clear_title: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenBody {
    target: String,
    #[serde(default)]
    panel_id: Option<String>,
    #[serde(default)]
    from: Option<String>,
    #[serde(default = "open_direction")]
    direction: String,
    #[serde(default)]
    reuse: bool,
    #[serde(default)]
    title: Option<String>,
}

fn open_direction() -> String {
    "right".into()
}

async fn open_target(
    State(state): State<AppState>,
    Json(body): Json<OpenBody>,
) -> Result<Json<Value>, AgentError> {
    open_desk(
        &state,
        DeskOpen {
            target: body.target,
            panel_id: body.panel_id,
            from: body.from,
            direction: body.direction,
            reuse: body.reuse,
            title: body.title,
        },
    )
    .await
    .map(Json)
}

pub(crate) struct DeskOpen {
    pub target: String,
    pub panel_id: Option<String>,
    pub from: Option<String>,
    pub direction: String,
    pub reuse: bool,
    pub title: Option<String>,
}

pub(crate) async fn open_desk(state: &AppState, body: DeskOpen) -> Result<Value, AgentError> {
    let direction = match body.direction.as_str() {
        "right" => Direction::Row,
        "down" => Direction::Column,
        _ => return Err(AgentError::bad("direction must be right or down")),
    };
    let roots = crate::server::allowed_roots(state).await;
    let located = locate_target(&body.target, &roots);
    let kind = crate::open_target::classify_target(&located, |path| file_kind(path))
        .map_err(AgentError::bad)?;
    let panel = kind_to_panel(&kind);
    let title = body
        .title
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| crate::open_target::open_title(&kind));
    let mut doc = load_active(state).await?;
    let (root, panel_id, created) = if let Some(panel_id) = body.panel_id.as_deref() {
        let panel_id = resolve_key(&doc.root, panel_id)?;
        let root = layout_ops::update_panel(doc.root, &panel_id, Some(Some(title)), Some(panel))
            .map_err(AgentError::bad)?;
        (root, panel_id, false)
    } else {
        let anchor = match body.from.as_deref() {
            Some(from) => resolve_key(&doc.root, from)?,
            None => {
                default_anchor(&doc.root).ok_or_else(|| AgentError::bad("layout has no panels"))?
            }
        };
        let before = list_panels(&doc.root).len();
        let (root, panel_id) =
            layout_ops::open_panel(doc.root, &anchor, direction, panel, Some(title), body.reuse)
                .map_err(AgentError::bad)?;
        let created = list_panels(&root).len() > before;
        (root, panel_id, created)
    };
    doc.root = root;
    let doc = save_active(state, doc).await?;
    Ok(json!({
        "panelId": panel_id,
        "created": created,
        "workspace": workspace_json(state, &doc),
    }))
}

fn locate_target(target: &str, roots: &[std::path::PathBuf]) -> String {
    let trimmed = crate::files::plain_path(std::path::Path::new(target.trim()));
    if trimmed.contains("://") || trimmed.contains(':') && !looks_like_windows_path(&trimmed) {
        return trimmed;
    }
    let path = std::path::Path::new(&trimmed);
    let candidates = if path.is_absolute() {
        vec![path.to_path_buf()]
    } else {
        roots.iter().map(|root| root.join(path)).collect::<Vec<_>>()
    };
    for candidate in candidates {
        if let Ok(canonical) = candidate.canonicalize() {
            return crate::files::plain_path(&canonical);
        }
    }
    trimmed.to_string()
}

fn looks_like_windows_path(target: &str) -> bool {
    let mut chars = target.chars();
    matches!(
        (chars.next(), chars.next(), chars.next()),
        (Some(drive), Some(':'), Some('\\') | Some('/')) if drive.is_ascii_alphabetic()
    )
}

fn file_kind(path: &str) -> Option<crate::open_target::FsKind> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.is_dir() {
        Some(crate::open_target::FsKind::Dir)
    } else if meta.is_file() {
        Some(crate::open_target::FsKind::File)
    } else {
        None
    }
}

fn kind_to_panel(kind: &crate::open_target::OpenKind) -> PanelConfig {
    match kind {
        crate::open_target::OpenKind::Browser { url, proxy } => PanelConfig::Iframe {
            url: url.clone(),
            proxy: *proxy,
            address_bar: None,
        },
        crate::open_target::OpenKind::Markdown { path } => PanelConfig::Markdown {
            path: path.clone(),
            address_bar: None,
            raw: false,
        },
        crate::open_target::OpenKind::Html { path } => PanelConfig::Html {
            path: Some(path.clone()),
            inline: None,
            control: false,
            address_bar: None,
            raw: false,
        },
        crate::open_target::OpenKind::Text { path } => PanelConfig::File {
            path: path.clone(),
            address_bar: None,
        },
        crate::open_target::OpenKind::Explorer { path } => PanelConfig::Explorer {
            path: path.clone(),
            focus: None,
            address_bar: None,
        },
        crate::open_target::OpenKind::Plugin { id } => PanelConfig::Plugin {
            plugin: id.clone(),
            config: serde_json::Value::Null,
            view: None,
            path: None,
            url: None,
            directory: false,
            address_bar: None,
            control: false,
        },
    }
}

#[derive(Deserialize)]
struct ResolveBody {
    target: String,
}

async fn resolve_target(
    State(state): State<AppState>,
    Json(body): Json<ResolveBody>,
) -> Result<Json<Value>, AgentError> {
    let roots = crate::server::allowed_roots(&state).await;
    let located = locate_target(&body.target, &roots);
    let kind = crate::open_target::address_target(&located, |path| file_kind(path))
        .map_err(AgentError::bad)?;
    if let crate::open_target::OpenKind::Plugin { id } = &kind {
        let plugins = crate::plugins::list_plugins(&state.config_dir).map_err(AgentError::bad)?;
        if !plugins.iter().any(|plugin| plugin.id == *id) {
            return Err(AgentError::bad(format!("plugin {id} is not installed")));
        }
    }
    Ok(Json(json!({ "panel": kind_to_panel(&kind) })))
}

fn default_anchor(root: &LayoutNode) -> Option<String> {
    let panels = list_panels(root);
    panels
        .iter()
        .rev()
        .find(|panel| !matches!(panel.panel, PanelConfig::Files | PanelConfig::Agents))
        .or_else(|| panels.last())
        .map(|panel| panel.id.clone())
}

async fn update_panel(
    State(state): State<AppState>,
    Json(body): Json<UpdateBody>,
) -> Result<Json<Value>, AgentError> {
    let title = if body.clear_title {
        Some(None)
    } else {
        body.title.map(Some)
    };
    update_desk(&state, &body.panel_id, title, body.panel)
        .await
        .map(Json)
}

pub(crate) async fn update_desk(
    state: &AppState,
    panel_id: &str,
    title: Option<Option<String>>,
    panel: Option<PanelConfig>,
) -> Result<Value, AgentError> {
    let mut doc = load_active(state).await?;
    let panel_id = resolve_key(&doc.root, panel_id)?;
    doc.root =
        layout_ops::update_panel(doc.root, &panel_id, title, panel).map_err(AgentError::bad)?;
    let doc = save_active(state, doc).await?;
    Ok(workspace_json(state, &doc))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveBody {
    panel_id: String,
    target: String,
    #[serde(default = "swap_place")]
    place: String,
}

fn swap_place() -> String {
    "swap".into()
}

async fn move_panel(
    State(state): State<AppState>,
    Json(body): Json<MoveBody>,
) -> Result<Json<Value>, AgentError> {
    move_desk(&state, &body.panel_id, &body.target, &body.place)
        .await
        .map(Json)
}

pub(crate) async fn move_desk(
    state: &AppState,
    panel_id: &str,
    target: &str,
    place: &str,
) -> Result<Value, AgentError> {
    let mut doc = load_active(state).await?;
    let source = resolve_key(&doc.root, panel_id)?;
    let target = resolve_key(&doc.root, target)?;
    doc.root = layout_ops::move_panel(doc.root, &source, &target, place).map_err(|err| {
        if err == "panel was not found" {
            AgentError::missing(err)
        } else {
            AgentError::bad(err)
        }
    })?;
    let doc = save_active(state, doc).await?;
    Ok(workspace_json(state, &doc))
}

pub(crate) async fn list_desk(state: &AppState) -> Result<Value, AgentError> {
    let doc = load_active(state).await?;
    Ok(json!({ "panels": panel_rows(&doc.root) }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ZoomBody {
    #[serde(default)]
    panel_id: Option<String>,
}

async fn zoom(
    State(state): State<AppState>,
    Json(body): Json<ZoomBody>,
) -> Result<Json<Value>, AgentError> {
    zoom_desk(&state, body.panel_id.as_deref()).await.map(Json)
}

/// Fill the screen with one panel, or pass `None` to show the whole desk again.
pub(crate) async fn zoom_desk(
    state: &AppState,
    panel_id: Option<&str>,
) -> Result<Value, AgentError> {
    let panel_id = match panel_id {
        Some(panel_id) => {
            let doc = load_active(state).await?;
            Some(resolve_key(&doc.root, panel_id)?)
        }
        None => None,
    };
    state.agent.publish(&json!({
        "type": "zoom",
        "panelId": panel_id,
    }));
    Ok(json!({"ok": true, "viewer": state.agent.viewers() > 0}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VisitBody {
    panel_id: String,
}

async fn visit(
    State(state): State<AppState>,
    Json(body): Json<VisitBody>,
) -> Result<Json<Value>, AgentError> {
    visit_desk(&state, &body.panel_id).await.map(Json)
}

async fn spaces(State(state): State<AppState>) -> Result<Json<Value>, AgentError> {
    list_spaces(&state).await.map(Json)
}

struct OwnedSpace {
    id: String,
    label: String,
    root: LayoutNode,
    current: bool,
}

async fn visit_spaces(state: &AppState) -> Result<Vec<OwnedSpace>, AgentError> {
    let snapshot = state.runtime.snapshot().await;
    let session = session_name(&snapshot);
    let stored = desk::load_desk(&state.config_dir, &session).map_err(AgentError::bad)?;
    let focused = focused_workspace(&snapshot);
    if stored.spaces.is_empty() {
        let settings = store::load_settings(&state.config_dir).map_err(AgentError::bad)?;
        let doc = store::load_layout(&state.config_dir, &settings.active_layout)
            .map_err(AgentError::bad)?;
        let label = doc.title.trim();
        return Ok(vec![OwnedSpace {
            id: doc.id,
            label: if label.is_empty() {
                "Desk".into()
            } else {
                label.to_string()
            },
            root: doc.root,
            current: true,
        }]);
    }
    let mut spaces = Vec::new();
    for key in stored.spaces.keys() {
        let workspace = snapshot
            .workspaces
            .iter()
            .find(|space| desk::space_key(&space.workspace_id) == key.as_str());
        let id = workspace
            .map(|space| space.workspace_id.clone())
            .unwrap_or_else(|| workspace_id_for_key(&stored, key));
        let label = workspace
            .map(|space| {
                let label = space.label.trim();
                if label.is_empty() {
                    id.clone()
                } else {
                    label.to_string()
                }
            })
            .unwrap_or_else(|| id.clone());
        let current = focused
            .as_deref()
            .is_some_and(|focus| desk::space_key(focus) == key.as_str());
        spaces.push(OwnedSpace {
            label,
            root: desk::open_space(&stored, &id),
            current,
            id,
        });
    }
    Ok(spaces)
}

/// Show a panel from any saved space. A missing name is an error, and the reply names the space.
pub(crate) async fn visit_desk(state: &AppState, panel_id: &str) -> Result<Value, AgentError> {
    let panel_id = panel_id.trim();
    if panel_id.is_empty() || panel_id.chars().count() > 200 {
        return Err(AgentError::bad("panelId is required"));
    }
    let owned = visit_spaces(state).await?;
    let views: Vec<desk::VisitSpace<'_>> = owned
        .iter()
        .map(|space| desk::VisitSpace {
            id: &space.id,
            label: &space.label,
            root: &space.root,
            current: space.current,
        })
        .collect();
    let found = desk::find_visit(&views, panel_id).map_err(|err| {
        if err == "panel was not found" {
            AgentError::missing(err)
        } else {
            AgentError::bad(err)
        }
    })?;
    state.agent.publish(&json!({
        "type": "visit",
        "panelId": found.panel_id,
        "spaceId": found.space_id,
    }));
    Ok(json!({
        "ok": true,
        "viewer": state.agent.viewers() > 0,
        "panelId": found.panel_id,
        "title": found.title,
        "spaceId": found.space_id,
        "space": found.space_label,
    }))
}

pub(crate) async fn list_spaces(state: &AppState) -> Result<Value, AgentError> {
    let owned = visit_spaces(state).await?;
    let spaces: Vec<Value> = owned
        .iter()
        .map(|space| {
            json!({
                "id": space.id,
                "label": space.label,
                "current": space.current,
                "panels": panel_rows(&space.root),
            })
        })
        .collect();
    Ok(json!({
        "viewer": state.agent.viewers() > 0,
        "spaces": spaces,
    }))
}

#[derive(Deserialize)]
struct SayBody {
    #[serde(default)]
    from: Option<String>,
    to: String,
    text: String,
}

async fn say(
    State(state): State<AppState>,
    Json(body): Json<SayBody>,
) -> Result<Json<Value>, AgentError> {
    let spoken = body.text.trim();
    if spoken.is_empty() || spoken.chars().count() > 8_000 {
        return Err(AgentError::bad("text must be 1 to 8000 characters"));
    }
    let doc = load_active(&state).await?;
    let target = if body.to == "*" {
        None
    } else {
        Some(resolve_key(&doc.root, &body.to)?)
    };
    let chats: Vec<_> = list_panels(&doc.root)
        .into_iter()
        .filter(|panel| {
            matches!(panel.panel, PanelConfig::Chat { .. })
                && target.as_ref().is_none_or(|id| panel.id == *id)
        })
        .collect();
    if chats.is_empty() {
        return Err(AgentError::missing("chat panel was not found"));
    }
    let from: String = body
        .from
        .unwrap_or_else(|| "agent".into())
        .chars()
        .take(40)
        .collect();
    let mut posted = Vec::new();
    for chat in &chats {
        let chat_id = post_chat(&state, &doc.id, chat, &from, spoken).await?;
        posted.push(chat_id);
    }
    Ok(Json(json!({"ok": true, "chats": posted})))
}

async fn post_chat(
    state: &AppState,
    layout_id: &str,
    chat: &layout_ops::PanelInfo,
    from: &str,
    spoken: &str,
) -> Result<String, AgentError> {
    let prefix = format!("[{from}] ");
    let room = 8_000usize.saturating_sub(prefix.chars().count());
    let body: String = spoken.chars().take(room).collect();
    let text = format!("{prefix}{body}");
    let chat_id = chats::chat_id(layout_id, &chat.id);
    let mut transcript = chats::load(&state.config_dir, &chat_id).map_err(AgentError::bad)?;
    transcript.messages.push(ChatMessage {
        id: format!("a{}", state.agent.ids.fetch_add(1, Ordering::Relaxed)),
        role: "agent".into(),
        text,
        attachments: Vec::new(),
        at: chrono_stamp(),
    });
    transcript.messages.truncate_front(200);
    chats::save(&state.config_dir, &chat_id, &transcript).map_err(AgentError::bad)?;
    if let PanelConfig::Chat {
        pane_id: Some(pane_id),
    } = &chat.panel
    {
        if is_pane_id(pane_id) {
            let client = state.runtime.client().clone();
            dispatch(&client, pane_id, ClientInput::Text { text: body })
                .await
                .map_err(AgentError::upstream)?;
            dispatch(
                &client,
                pane_id,
                ClientInput::Keys {
                    keys: vec!["enter".into()],
                },
            )
            .await
            .map_err(AgentError::upstream)?;
        }
    }
    state
        .agent
        .publish(&json!({"type": "chat", "panelId": chat.id, "chatId": chat_id}));
    Ok(chat_id)
}

#[derive(Deserialize)]
struct ReadQuery {
    selector: Option<String>,
    text: Option<String>,
}

async fn read_panel(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<ReadQuery>,
) -> Result<Json<Value>, AgentError> {
    let doc = load_active(&state).await?;
    let id = resolve_key(&doc.root, &id)?;
    let panel = list_panels(&doc.root)
        .into_iter()
        .find(|panel| panel.id == id)
        .ok_or_else(|| AgentError::missing("panel was not found"))?;
    let (text, blocks) = read_static(&state, &doc.id, &panel.id, &panel.panel).await?;
    let matched = filter_blocks(&blocks, query.selector.as_deref(), query.text.as_deref());
    let live = state
        .agent
        .inspect(&panel.id, query.selector.as_deref(), query.text.as_deref())
        .await;
    Ok(Json(json!({
        "id": panel.id,
        "title": panel.title,
        "type": panel_type(&panel.panel),
        "summary": panel_summary(&panel.panel),
        "text": text,
        "blocks": blocks,
        "matches": matched,
        "live": live,
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteBody {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    keys: Option<Vec<String>>,
}

async fn write_panel(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<WriteBody>,
) -> Result<Json<Value>, AgentError> {
    let doc = load_active(&state).await?;
    let id = resolve_key(&doc.root, &id)?;
    let panel = list_panels(&doc.root)
        .into_iter()
        .find(|panel| panel.id == id)
        .ok_or_else(|| AgentError::missing("panel was not found"))?;
    let Some(pane_id) = herdr_pane(&panel.panel).map(str::to_string) else {
        return Err(AgentError::bad("only a terminal panel can be written"));
    };
    let client = state.runtime.client().clone();
    if let Some(text) = body.text {
        if text.len() > 16_000 {
            return Err(AgentError::bad("text is limited to 16 KB"));
        }
        dispatch(&client, &pane_id, ClientInput::Text { text })
            .await
            .map_err(AgentError::upstream)?;
    }
    if let Some(keys) = body.keys {
        dispatch(&client, &pane_id, ClientInput::Keys { keys })
            .await
            .map_err(AgentError::upstream)?;
    }
    Ok(Json(json!({"ok": true, "paneId": pane_id})))
}

#[derive(Deserialize)]
struct SelectBody {
    #[serde(default)]
    selector: Option<String>,
    #[serde(default)]
    text: Option<String>,
}

async fn select_panel(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<SelectBody>,
) -> Result<Json<Value>, AgentError> {
    let doc = load_active(&state).await?;
    let id = resolve_key(&doc.root, &id)?;
    if !layout_ops::contains(&doc.root, &id) {
        return Err(AgentError::missing("panel was not found"));
    }
    state.agent.publish(&json!({
        "type": "select",
        "panelId": id,
        "selector": body.selector,
        "text": body.text,
    }));
    let live = state
        .agent
        .inspect(&id, body.selector.as_deref(), body.text.as_deref())
        .await;
    Ok(Json(
        json!({"ok": true, "viewer": state.agent.viewers() > 0, "live": live}),
    ))
}

async fn agent_ws(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    let hub = state.agent.clone();
    ws.on_upgrade(move |socket| drive(socket, hub))
}

async fn drive(mut socket: WebSocket, hub: AgentHub) {
    hub.viewers.fetch_add(1, Ordering::Relaxed);
    let mut events = hub.events.subscribe();
    loop {
        tokio::select! {
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(value) = serde_json::from_str::<Value>(&text) {
                            if value.get("type").and_then(Value::as_str) == Some("inspect-result") {
                                if let Some(request_id) = value.get("requestId").and_then(Value::as_str) {
                                    hub.resolve(request_id, value.get("result").cloned().unwrap_or(Value::Null)).await;
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
            event = events.recv() => {
                match event {
                    Ok(text) => {
                        if socket.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        }
    }
    hub.viewers.fetch_sub(1, Ordering::Relaxed);
}

fn resolve_key(root: &LayoutNode, key: &str) -> Result<String, AgentError> {
    layout_ops::resolve_panel_id(root, key).map_err(|err| {
        if err == "panel was not found" {
            AgentError::missing(err)
        } else {
            AgentError::bad(err)
        }
    })
}

enum ActiveSource {
    Space {
        session: String,
        workspace_id: String,
    },
    Layout,
}

fn session_name(snapshot: &crate::session::RuntimeSnapshot) -> String {
    if snapshot.session.is_empty() {
        "default".into()
    } else {
        snapshot.session.clone()
    }
}

fn focused_workspace(snapshot: &crate::session::RuntimeSnapshot) -> Option<String> {
    snapshot
        .focused_workspace_id
        .clone()
        .filter(|id| !id.is_empty())
        .or_else(|| {
            snapshot
                .workspaces
                .iter()
                .find(|space| space.focused)
                .map(|space| space.workspace_id.clone())
        })
}

fn workspace_id_for_key(desk: &desk::DeskDocument, key: &str) -> String {
    for pin in &desk.pins {
        for id in &pin.spaces {
            if desk::space_key(id) == key {
                return id.clone();
            }
        }
    }
    key.to_string()
}

async fn active_source(state: &AppState) -> Result<ActiveSource, AgentError> {
    let snapshot = state.runtime.snapshot().await;
    let session = session_name(&snapshot);
    if snapshot.connected {
        if let Some(workspace_id) = focused_workspace(&snapshot) {
            return Ok(ActiveSource::Space {
                session,
                workspace_id,
            });
        }
    }
    let stored = desk::load_desk(&state.config_dir, &session).map_err(AgentError::bad)?;
    if stored.spaces.len() == 1 {
        let key = stored.spaces.keys().next().cloned().unwrap_or_default();
        return Ok(ActiveSource::Space {
            workspace_id: workspace_id_for_key(&stored, &key),
            session,
        });
    }
    if stored.spaces.len() > 1 {
        return Err(AgentError::bad(
            "Herdr is not focused on a space, so there is no desk to edit",
        ));
    }
    Ok(ActiveSource::Layout)
}

async fn load_active(state: &AppState) -> Result<LayoutDocument, AgentError> {
    match active_source(state).await? {
        ActiveSource::Space {
            session,
            workspace_id,
        } => {
            let stored = desk::load_desk(&state.config_dir, &session).map_err(AgentError::bad)?;
            let root = desk::open_space(&stored, &workspace_id);
            let settings = store::load_settings(&state.config_dir).map_err(AgentError::bad)?;
            let mut doc = store::load_layout(&state.config_dir, &settings.active_layout).unwrap_or(
                LayoutDocument {
                    id: settings.active_layout.clone(),
                    title: "Desk".into(),
                    description: None,
                    root: root.clone(),
                },
            );
            doc.root = root;
            Ok(doc)
        }
        ActiveSource::Layout => {
            let settings = store::load_settings(&state.config_dir).map_err(AgentError::bad)?;
            store::load_layout(&state.config_dir, &settings.active_layout).map_err(AgentError::bad)
        }
    }
}

async fn save_active(state: &AppState, doc: LayoutDocument) -> Result<LayoutDocument, AgentError> {
    doc.validate().map_err(AgentError::bad)?;
    match active_source(state).await? {
        ActiveSource::Space {
            session,
            workspace_id,
        } => {
            let current = desk::load_desk(&state.config_dir, &session).map_err(AgentError::bad)?;
            let next = desk::store_space(&current, &workspace_id, doc.root.clone());
            let stored = match desk::save_desk(&state.config_dir, &session, &next, true)
                .map_err(AgentError::bad)?
            {
                desk::DeskSave::Stored(saved) | desk::DeskSave::Conflict(saved) => saved,
            };
            state
                .agent
                .publish(&json!({"type": "desk", "desk": stored}));
            Ok(doc)
        }
        ActiveSource::Layout => {
            store::save_layout(&state.config_dir, &doc).map_err(AgentError::bad)?;
            state
                .agent
                .publish(&json!({"type": "layout", "layout": &doc}));
            Ok(doc)
        }
    }
}

fn workspace_json(state: &AppState, doc: &LayoutDocument) -> Value {
    json!({
        "layoutId": doc.id,
        "title": doc.title,
        "viewer": state.agent.viewers() > 0,
        "panels": panel_rows(&doc.root),
    })
}

fn panel_rows(root: &LayoutNode) -> Vec<Value> {
    list_panels(root)
        .into_iter()
        .map(|panel| {
            json!({
                "id": panel.id,
                "title": panel.title,
                "type": panel_type(&panel.panel),
                "summary": panel_summary(&panel.panel),
            })
        })
        .collect()
}

/// A panel a plugin may place on the desk. The Herdr `control` flag stays off.
pub(crate) fn panel_from_kind(
    kind: &str,
    path: Option<String>,
    page: Option<String>,
    plugin: Option<String>,
    pane: Option<String>,
) -> Result<PanelConfig, String> {
    let path = path.filter(|value| !value.trim().is_empty());
    let page = page.filter(|value| !value.trim().is_empty());
    let plugin = plugin.filter(|value| !value.trim().is_empty());
    let pane = pane.filter(|value| !value.trim().is_empty());
    if let Some(pane_id) = pane.as_deref() {
        if !is_pane_id(pane_id) {
            return Err("invalid pane id".into());
        }
    }
    Ok(match kind {
        "herdr" => PanelConfig::Herdr {
            pane_id: pane,
            source: None,
            lines: None,
        },
        "markdown" => PanelConfig::Markdown {
            path: path.unwrap_or_else(|| "notes/welcome.md".into()),
            address_bar: None,
            raw: false,
        },
        "html" => PanelConfig::Html {
            path: Some(path.unwrap_or_else(|| "panels/session-board.html".into())),
            inline: None,
            control: false,
            address_bar: None,
            raw: false,
        },
        "iframe" => PanelConfig::Iframe {
            url: page.ok_or_else(|| "page is required for an iframe panel".to_string())?,
            proxy: false,
            address_bar: None,
        },
        "plugin" => {
            let plugin =
                plugin.ok_or_else(|| "plugin is required for a plugin panel".to_string())?;
            crate::plugins::validate_plugin_id(&plugin).map_err(|err| err.to_string())?;
            PanelConfig::Plugin {
                plugin,
                config: Value::Null,
                view: None,
                path: None,
                url: None,
                directory: false,
                address_bar: None,
                control: false,
            }
        }
        "files" => PanelConfig::Files,
        "agents" => PanelConfig::Agents,
        other => return Err(format!("unknown panel kind {other}")),
    })
}

async fn read_static(
    state: &AppState,
    layout_id: &str,
    panel_id: &str,
    panel: &PanelConfig,
) -> Result<(String, Vec<Value>), AgentError> {
    match panel {
        PanelConfig::Herdr {
            pane_id: Some(pane_id),
            source,
            lines,
            ..
        } => {
            let source = source
                .as_ref()
                .copied()
                .unwrap_or(crate::layout::HerdrSource::Visible)
                .as_api();
            let screen = state
                .runtime
                .client()
                .read_pane(pane_id, source, *lines)
                .await
                .map_err(|err| AgentError::upstream(err.to_string()))?;
            Ok((truncate(&screen.text, 48_000), Vec::new()))
        }
        PanelConfig::Herdr { pane_id: None, .. } => Ok(("No pane selected".into(), Vec::new())),
        PanelConfig::Markdown { path, .. } => {
            let text = read_content(state, path).await?;
            let blocks = layout_ops::markdown_blocks(&text)
                .into_iter()
                .map(|(tag, id, text)| json!({"tag": tag, "id": id, "text": text}))
                .collect();
            Ok((truncate(&text, 48_000), blocks))
        }
        PanelConfig::Html {
            path: Some(path), ..
        } => {
            let text = read_content(state, path).await?;
            Ok((truncate(&text, 48_000), Vec::new()))
        }
        PanelConfig::Html {
            inline: Some(inline),
            ..
        } => Ok((truncate(inline, 48_000), Vec::new())),
        PanelConfig::Html { .. } => Ok((String::new(), Vec::new())),
        PanelConfig::Iframe { url, .. } => {
            let text = fetch_frame(state, url).await.unwrap_or_default();
            Ok((truncate(&text, 48_000), Vec::new()))
        }
        PanelConfig::Chat { .. } => {
            let transcript = chats::load(&state.config_dir, &chats::chat_id(layout_id, panel_id))
                .map_err(AgentError::bad)?;
            let text = transcript
                .messages
                .iter()
                .map(|message| format!("{}: {}", message.role, message.text))
                .collect::<Vec<_>>()
                .join("\n");
            Ok((truncate(&text, 48_000), Vec::new()))
        }
        PanelConfig::Plugin { plugin, .. } => Ok((format!("plugin {plugin}"), Vec::new())),
        PanelConfig::Files => Ok(("spaces".into(), Vec::new())),
        PanelConfig::Agents => Ok(("agents".into(), Vec::new())),
        PanelConfig::Blank => Ok(("blank".into(), Vec::new())),
        PanelConfig::Explorer { path, .. } => {
            let listed =
                crate::files::list_children(std::path::Path::new(path)).map_err(AgentError::bad)?;
            let text = listed
                .iter()
                .map(|entry| format!("{}\t{}", entry.kind, entry.path))
                .collect::<Vec<_>>()
                .join("\n");
            Ok((truncate(&text, 48_000), Vec::new()))
        }
        PanelConfig::File { path, .. } => {
            let text = read_content(state, path).await?;
            Ok((truncate(&text, 48_000), Vec::new()))
        }
        PanelConfig::Tabs { active, tabs, .. } => {
            let tab = tabs
                .iter()
                .find(|tab| tab.id == *active)
                .or_else(|| tabs.first());
            match tab {
                Some(tab) => Ok((
                    format!("{}: {}", tab.title, panel_summary(&tab.panel)),
                    Vec::new(),
                )),
                None => Ok(("No tabs".into(), Vec::new())),
            }
        }
    }
}

async fn read_content(state: &AppState, path: &str) -> Result<String, AgentError> {
    let roots = crate::server::allowed_roots(state).await;
    let file = resolve_content(&state.config_dir, &roots, path).map_err(AgentError::bad)?;
    tokio::fs::read_to_string(&file)
        .await
        .map_err(|err| AgentError::bad(err.to_string()))
}

async fn fetch_frame(state: &AppState, url: &str) -> Option<String> {
    if let Some(path) = url.strip_prefix("/content/") {
        return read_content(state, path).await.ok();
    }
    if !is_loopback_url(url) {
        return None;
    }
    let response = state.http.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let bytes = response.bytes().await.ok()?;
    let end = bytes.len().min(48_000);
    Some(String::from_utf8_lossy(&bytes[..end]).into_owned())
}

fn filter_blocks(blocks: &[Value], selector: Option<&str>, text: Option<&str>) -> Vec<Value> {
    blocks
        .iter()
        .filter(|block| {
            let tag = block.get("tag").and_then(Value::as_str).unwrap_or("");
            let id = block.get("id").and_then(Value::as_str).unwrap_or("");
            let body = block.get("text").and_then(Value::as_str).unwrap_or("");
            let selector_ok = selector
                .map(|selector| selector == tag || selector == id)
                .unwrap_or(true);
            let text_ok = text
                .map(|text| body.to_lowercase().contains(&text.to_lowercase()))
                .unwrap_or(true);
            selector_ok && text_ok
        })
        .cloned()
        .collect()
}

fn herdr_pane(panel: &PanelConfig) -> Option<&str> {
    match panel {
        PanelConfig::Herdr {
            pane_id: Some(pane_id),
            ..
        } => Some(pane_id.as_str()),
        _ => None,
    }
}

fn herdr_direction(direction: Direction) -> &'static str {
    match direction {
        Direction::Row => "right",
        Direction::Column => "down",
    }
}

fn panel_type(panel: &PanelConfig) -> &'static str {
    match panel {
        PanelConfig::Herdr { .. } => "herdr",
        PanelConfig::Markdown { .. } => "markdown",
        PanelConfig::Iframe { .. } => "iframe",
        PanelConfig::Html { .. } => "html",
        PanelConfig::Plugin { .. } => "plugin",
        PanelConfig::Files => "files",
        PanelConfig::Agents => "agents",
        PanelConfig::Explorer { .. } => "explorer",
        PanelConfig::File { .. } => "file",
        PanelConfig::Tabs { .. } => "tabs",
        PanelConfig::Chat { .. } => "chat",
        PanelConfig::Blank => "blank",
    }
}

fn panel_summary(panel: &PanelConfig) -> String {
    match panel {
        PanelConfig::Herdr { pane_id, .. } => pane_id.clone().unwrap_or_else(|| "unbound".into()),
        PanelConfig::Markdown { path, .. } => path.clone(),
        PanelConfig::Iframe { url, .. } => url.clone(),
        PanelConfig::Html { path, inline, .. } => path.clone().unwrap_or_else(|| {
            if inline.is_some() {
                "inline".into()
            } else {
                "html".into()
            }
        }),
        PanelConfig::Plugin { plugin, .. } => plugin.clone(),
        PanelConfig::Files => "spaces".into(),
        PanelConfig::Agents => "agents".into(),
        PanelConfig::Explorer { path, focus, .. } => focus.clone().unwrap_or_else(|| path.clone()),
        PanelConfig::File { path, .. } => path.clone(),
        PanelConfig::Tabs { tabs, active, .. } => tabs
            .iter()
            .find(|tab| tab.id == *active)
            .or_else(|| tabs.first())
            .map(|tab| tab.title.clone())
            .unwrap_or_else(|| "tabs".into()),
        PanelConfig::Chat { pane_id } => pane_id.clone().unwrap_or_else(|| "local".into()),
        PanelConfig::Blank => "blank".into(),
    }
}

fn default_title(panel: &PanelConfig) -> &'static str {
    match panel {
        PanelConfig::Herdr { .. } => "Terminal",
        PanelConfig::Markdown { .. } => "Notes",
        PanelConfig::Iframe { .. } => "Browser",
        PanelConfig::Html { .. } => "HTML",
        PanelConfig::Plugin { .. } => "Plugin",
        PanelConfig::Files => "spaces",
        PanelConfig::Agents => "agents",
        PanelConfig::Explorer { .. } => "Files",
        PanelConfig::File { .. } => "File",
        PanelConfig::Tabs { .. } => "Tabs",
        PanelConfig::Chat { .. } => "Chat",
        PanelConfig::Blank => "",
    }
}

fn truncate(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

fn chrono_stamp() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!("{millis}")
}

trait TruncateFront {
    fn truncate_front(&mut self, max: usize);
}

impl TruncateFront for Vec<ChatMessage> {
    fn truncate_front(&mut self, max: usize) {
        if self.len() > max {
            let extra = self.len() - max;
            self.drain(0..extra);
        }
    }
}

pub(crate) struct AgentError {
    pub(crate) status: StatusCode,
    pub(crate) message: String,
}

impl AgentError {
    fn bad(err: impl ToString) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: err.to_string(),
        }
    }

    fn missing(message: impl ToString) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.to_string(),
        }
    }

    fn upstream(message: impl ToString) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            message: message.to_string(),
        }
    }
}

impl IntoResponse for AgentError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({"error": self.message}))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plugin_desk_edit_cannot_turn_on_herdr_control() {
        let html = panel_from_kind("html", None, None, None, None).unwrap();
        assert!(matches!(
            html,
            PanelConfig::Html {
                control: false,
                inline: None,
                ..
            }
        ));
        let plugin = panel_from_kind("plugin", None, None, Some("welcome".into()), None).unwrap();
        assert!(matches!(plugin, PanelConfig::Plugin { control: false, .. }));
        assert!(panel_from_kind("iframe", None, None, None, None).is_err());
    }
}
