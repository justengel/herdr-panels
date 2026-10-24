use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Query, State};
use axum::http::{header, HeaderValue, Request, StatusCode};
use axum::middleware::{from_fn, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{any, get, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde::Serialize;
use serde_json::{json, Value};
use tower_http::services::ServeDir;

use crate::agent::AgentHub;
use crate::herdr::HerdrClient;
use crate::keys::ClientInput;
use crate::layout::{is_layout_id, is_pane_id, LayoutDocument};
use crate::paths::{find_dist_dir, origin_is_local, session_name_from_socket};
use crate::session::RuntimeCache;
use crate::store::{self, LayoutSummary, Settings};
use crate::terminal::screen_source;
use crate::terminal_size::PaneControls;
use crate::watch::WatchHub;

#[derive(Clone)]
pub struct AppState {
    pub config_dir: Arc<PathBuf>,
    pub runtime: RuntimeCache,
    pub http: reqwest::Client,
    pub dist_dir: Option<Arc<PathBuf>>,
    pub watch: WatchHub,
    pub agent: AgentHub,
    pub controls: PaneControls,
}

pub struct ServerConfig {
    pub host: std::net::IpAddr,
    pub port: u16,
    pub config_dir: PathBuf,
    pub herdr_socket: PathBuf,
    pub open_browser: bool,
    pub url: String,
}

pub async fn serve(config: ServerConfig) -> anyhow::Result<()> {
    let settings = store::load_settings(&config.config_dir)?;
    let mut watch_paths = vec![config.config_dir.clone()];
    watch_paths.extend(settings.content_roots.iter().cloned());
    let watch = WatchHub::start(&watch_paths)?;
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .no_proxy()
        .build()?;
    let dist_dir = find_dist_dir().map(Arc::new);
    let state = AppState {
        config_dir: Arc::new(config.config_dir.clone()),
        runtime: RuntimeCache::new(HerdrClient::new(config.herdr_socket.clone())),
        http,
        dist_dir: dist_dir.clone(),
        watch,
        agent: AgentHub::new(),
        controls: PaneControls::new(session_name_from_socket(&config.herdr_socket)),
    };

    let mut router = Router::new()
        .merge(crate::agent::router())
        .route("/api/health", get(health))
        .route("/api/bootstrap", get(bootstrap))
        .route("/api/runtime", get(runtime))
        .route("/api/layouts", get(layouts))
        .route("/api/layouts/{id}", get(layout_one).put(put_layout))
        .route("/api/active", put(set_active))
        .route("/api/tree", get(tree))
        .route("/api/frame", get(frame_policy))
        .route("/api/session/focus", post(focus_session))
        .route("/api/sessions", get(list_sessions).put(use_session).post(create_session))
        .route("/api/sessions/rename", post(rename_session))
        .route("/api/sessions/close", post(close_session))
        .route("/api/plugins", get(list_plugins))
        .route("/api/herdr/config", get(herdr_config).put(put_herdr_config))
        .route("/api/herdr/action", post(herdr_action))
        .route("/api/terminal/input", post(terminal_input))
        .route("/api/terminal/split", post(terminal_split))
        .route("/api/terminal/{pane_id}/screen", get(terminal_screen))
        .route("/api/chats/{id}", get(chat_get).put(chat_put))
        .route("/ws/terminal", get(terminal_ws))
        .route("/ws/watch", get(watch_ws))
        .route("/content/{*path}", get(crate::content::handle))
        .route("/plugins/{*path}", get(crate::plugins::handle))
        .route("/proxy/{*path}", any(crate::proxy::handle))
        .with_state(state);

    router = if let Some(dist) = dist_dir {
        router.fallback_service(ServeDir::new(dist.as_ref()))
    } else {
        router.fallback(get(setup_page))
    };

    let app = router
        .layer(axum::extract::DefaultBodyLimit::max(20 * 1024 * 1024))
        .layer(from_fn(guard));

    let addr = SocketAddr::from((config.host, config.port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    crate::client::record_server(&config.config_dir, &config.url)?;
    tracing::info!("listening on {}", config.url);
    tracing::info!("config directory {}", config.config_dir.display());
    tracing::info!("herdr socket {}", config.herdr_socket.display());
    if find_dist_dir().is_some() {
        tracing::info!("serving the built UI");
    } else {
        tracing::info!("UI bundle not found; run `npm run dev` in web/ or `npm run build`");
    }
    if config.open_browser {
        crate::cli::open_browser(&config.url);
    }

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

async fn guard(req: Request<axum::body::Body>, next: Next) -> Response {
    if let Some(origin) = req.headers().get(header::ORIGIN) {
        match origin.to_str() {
            Ok(origin) if origin_is_local(origin) => {}
            _ => {
                return (
                    StatusCode::FORBIDDEN,
                    Json(json!({"error": "origin is not local"})),
                )
                    .into_response();
            }
        }
    }
    let mut response = next.run(req).await;
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response.headers_mut().insert(
        header::HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
    response
}

async fn setup_page() -> Html<&'static str> {
    Html(include_str!("../assets/setup.html"))
}

async fn health() -> Json<Value> {
    Json(json!({"ok": true}))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
    config_dir: String,
    settings: Settings,
    layouts: Vec<LayoutSummary>,
    layout: LayoutDocument,
    runtime: crate::session::RuntimeSnapshot,
}

async fn bootstrap(State(state): State<AppState>) -> Result<Json<Bootstrap>, ApiError> {
    let (settings, layout, layouts) = active_layout(&state)?;
    let runtime = state.runtime.snapshot().await;
    Ok(Json(Bootstrap {
        config_dir: state.config_dir.display().to_string(),
        settings,
        layouts,
        layout,
        runtime,
    }))
}

async fn runtime(State(state): State<AppState>) -> Json<crate::session::RuntimeSnapshot> {
    Json(state.runtime.snapshot().await)
}

async fn layouts(State(state): State<AppState>) -> Result<Json<Vec<LayoutSummary>>, ApiError> {
    store::list_layouts(&state.config_dir)
        .map(Json)
        .map_err(ApiError::bad)
}

async fn layout_one(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<LayoutDocument>, ApiError> {
    load_existing(&state, &id).map(Json)
}

async fn put_layout(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(doc): Json<LayoutDocument>,
) -> Result<Json<LayoutDocument>, ApiError> {
    if doc.id != id {
        return Err(ApiError::bad("layout id does not match the URL"));
    }
    store::save_layout(&state.config_dir, &doc).map_err(ApiError::bad)?;
    Ok(Json(doc))
}

#[derive(Deserialize)]
struct ActiveBody {
    id: String,
}

#[derive(Serialize)]
struct ActiveResponse {
    settings: Settings,
    layout: LayoutDocument,
}

async fn set_active(
    State(state): State<AppState>,
    Json(body): Json<ActiveBody>,
) -> Result<Json<ActiveResponse>, ApiError> {
    if !is_layout_id(&body.id) {
        return Err(ApiError::bad("invalid layout id"));
    }
    let layout = load_existing(&state, &body.id)?;
    let mut settings = store::load_settings(&state.config_dir).map_err(ApiError::bad)?;
    settings.active_layout = body.id;
    store::save_settings(&state.config_dir, &settings).map_err(ApiError::bad)?;
    Ok(Json(ActiveResponse { settings, layout }))
}

#[derive(Deserialize)]
struct TreeQuery {
    path: String,
}

pub async fn allowed_roots(state: &AppState) -> Vec<PathBuf> {
    let mut roots = store::load_settings(&state.config_dir)
        .map(|settings| settings.content_roots)
        .unwrap_or_default();
    let snapshot = state.runtime.snapshot().await;
    for workspace in &snapshot.workspaces {
        if let Some(root) = &workspace.root {
            roots.push(PathBuf::from(root));
        }
    }
    for pane in &snapshot.panes {
        if let Some(cwd) = &pane.cwd {
            roots.push(PathBuf::from(cwd));
        }
    }
    roots
}

async fn tree(
    State(state): State<AppState>,
    Query(query): Query<TreeQuery>,
) -> Result<Json<Value>, ApiError> {
    let roots = allowed_roots(&state).await;
    let entries = crate::files::list_children(&roots, std::path::Path::new(&query.path))
        .map_err(ApiError::bad)?;
    Ok(Json(json!({ "path": query.path, "entries": entries })))
}

#[derive(Deserialize)]
struct FrameQuery {
    url: String,
}

async fn frame_policy(
    State(state): State<AppState>,
    Query(query): Query<FrameQuery>,
) -> Result<Json<Value>, ApiError> {
    let url = query.url.trim();
    let parsed = url::Url::parse(url).map_err(|_| ApiError::bad("url is invalid"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(ApiError::bad("url must be http or https"));
    }
    match inspect_frame(&state, url).await {
        Some(reason) => Ok(Json(json!({ "allowed": false, "reason": reason }))),
        None => Ok(Json(json!({ "allowed": true }))),
    }
}

async fn inspect_frame(state: &AppState, url: &str) -> Option<&'static str> {
    let mut current = url.to_string();
    for _ in 0..4 {
        let response = match state
            .http
            .get(&current)
            .timeout(Duration::from_secs(4))
            .send()
            .await
        {
            Ok(response) => response,
            Err(_) => return None,
        };
        let status = response.status();
        if status.is_redirection() {
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            let Some(location) = location else {
                return None;
            };
            let Some(next) = url::Url::parse(&current)
                .ok()
                .and_then(|base| base.join(&location).ok())
            else {
                return None;
            };
            if next.scheme() != "http" && next.scheme() != "https" {
                return None;
            }
            current = next.to_string();
            continue;
        }
        let pairs = response
            .headers()
            .iter()
            .filter_map(|(key, value)| value.to_str().ok().map(|text| (key.as_str().to_string(), text.to_string())))
            .collect::<Vec<_>>();
        let borrowed = pairs
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect::<Vec<_>>();
        return crate::open_target::embedding_refusal(&borrowed);
    }
    None
}

async fn list_sessions() -> Result<Json<Value>, ApiError> {
    let sessions = crate::paths::list_herdr_sessions().map_err(ApiError::bad)?;
    Ok(Json(json!({
        "sessions": sessions.into_iter().map(|(name, _)| json!({ "name": name })).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
struct SessionBody {
    name: String,
}

async fn use_session(
    State(state): State<AppState>,
    Json(body): Json<SessionBody>,
) -> Result<Json<Value>, ApiError> {
    let socket = crate::paths::session_socket(&body.name).map_err(ApiError::bad)?;
    attach_session(&state, &body.name, socket).await
}

async fn create_session(
    State(state): State<AppState>,
    Json(body): Json<SessionBody>,
) -> Result<Json<Value>, ApiError> {
    let socket = crate::session_proc::start_session(&body.name)
        .await
        .map_err(ApiError::bad)?;
    attach_session(&state, &body.name, socket).await
}

#[derive(Deserialize)]
struct RenameSessionBody {
    name: String,
    to: String,
}

async fn rename_session(
    State(state): State<AppState>,
    Json(body): Json<RenameSessionBody>,
) -> Result<Json<Value>, ApiError> {
    let socket = crate::session_proc::rename_session(&body.name, &body.to)
        .await
        .map_err(ApiError::bad)?;
    attach_session(&state, &body.to, socket).await
}

async fn attach_session(
    state: &AppState,
    name: &str,
    socket: PathBuf,
) -> Result<Json<Value>, ApiError> {
    state.runtime.client().retarget(socket.clone());
    state.runtime.invalidate();
    state
        .controls
        .use_session(session_name_from_socket(&socket))
        .await;
    let runtime = state.runtime.snapshot().await;
    Ok(Json(json!({ "name": name, "runtime": runtime })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FocusBody {
    #[serde(default)]
    pane_id: Option<String>,
    #[serde(default)]
    workspace_id: Option<String>,
    #[serde(default)]
    tab_id: Option<String>,
}

async fn focus_session(
    State(state): State<AppState>,
    Json(body): Json<FocusBody>,
) -> Result<StatusCode, ApiError> {
    let client = state.runtime.client().clone();
    if let Some(pane_id) = body.pane_id {
        if !is_pane_id(&pane_id) {
            return Err(ApiError::bad("invalid pane id"));
        }
        client
            .call("pane.focus", json!({ "pane_id": pane_id }))
            .await
            .map_err(|err| ApiError::upstream(err.to_string()))?;
        return Ok(StatusCode::NO_CONTENT);
    }
    if let Some(workspace_id) = body.workspace_id {
        if workspace_id.is_empty() || workspace_id.len() > 80 {
            return Err(ApiError::bad("invalid workspace id"));
        }
        client
            .call("workspace.focus", json!({ "workspace_id": workspace_id }))
            .await
            .map_err(|err| ApiError::upstream(err.to_string()))?;
        return Ok(StatusCode::NO_CONTENT);
    }
    if let Some(tab_id) = body.tab_id {
        if !is_pane_id(&tab_id) {
            return Err(ApiError::bad("invalid tab id"));
        }
        client
            .call("tab.focus", json!({ "tab_id": tab_id }))
            .await
            .map_err(|err| ApiError::upstream(err.to_string()))?;
        state.runtime.invalidate();
        return Ok(StatusCode::NO_CONTENT);
    }
    Err(ApiError::bad("focus needs a pane, a tab, or a workspace"))
}

async fn close_session(
    State(state): State<AppState>,
    Json(body): Json<SessionBody>,
) -> Result<Json<Value>, ApiError> {
    let current = crate::paths::session_label(std::path::Path::new(
        &state.runtime.client().logical_socket(),
    ));
    crate::session_proc::close_session(&body.name)
        .await
        .map_err(ApiError::bad)?;
    if current == body.name {
        let socket = crate::paths::session_socket("default").map_err(ApiError::bad)?;
        return attach_session(&state, "default", socket).await;
    }
    let runtime = state.runtime.snapshot().await;
    Ok(Json(json!({ "name": current, "runtime": runtime })))
}

async fn list_plugins(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let plugins = crate::plugins::list_plugins(&state.config_dir).map_err(ApiError::bad)?;
    Ok(Json(json!({ "plugins": plugins })))
}

async fn herdr_config() -> Json<Value> {
    Json(crate::herdr_config::document())
}

async fn put_herdr_config(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let socket = state.runtime.client().logical_socket();
    let session = crate::paths::session_name_from_socket(std::path::Path::new(&socket));
    let doc = crate::herdr_config::apply(&body, session.as_deref())
        .await
        .map_err(ApiError::bad)?;
    Ok(Json(doc))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HerdrAction {
    action: String,
    #[serde(default)]
    workspace_id: Option<String>,
    #[serde(default)]
    tab_id: Option<String>,
    #[serde(default)]
    pane_id: Option<String>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    direction: Option<String>,
}

async fn herdr_action(
    State(state): State<AppState>,
    Json(body): Json<HerdrAction>,
) -> Result<Json<Value>, ApiError> {
    let client = state.runtime.client();
    let result = match body.action.as_str() {
        "workspace.create" => {
            let mut params = json!({ "focus": true });
            if let Some(label) = body.label.filter(|label| !label.trim().is_empty()) {
                params["label"] = json!(label.trim());
            }
            client.call("workspace.create", params).await
        }
        "workspace.rename" => {
            let workspace_id = required(body.workspace_id, "a space")?;
            let label = required(body.label.filter(|label| !label.trim().is_empty()), "a name")?;
            client
                .call(
                    "workspace.rename",
                    json!({ "workspace_id": workspace_id, "label": label.trim() }),
                )
                .await
        }
        "workspace.close" => {
            let workspace_id = required(body.workspace_id, "a space")?;
            client
                .call("workspace.close", json!({ "workspace_id": workspace_id }))
                .await
        }
        "tab.create" => {
            let mut params = json!({ "focus": true });
            if let Some(workspace_id) = body.workspace_id {
                params["workspace_id"] = json!(workspace_id);
            }
            if let Some(label) = body.label.filter(|label| !label.trim().is_empty()) {
                params["label"] = json!(label.trim());
            }
            client.call("tab.create", params).await
        }
        "tab.close" => {
            let tab_id = required(body.tab_id, "a tab")?;
            client.call("tab.close", json!({ "tab_id": tab_id })).await
        }
        "pane.focus_direction" => {
            let direction = required(body.direction, "a direction")?;
            if !matches!(direction.as_str(), "left" | "right" | "up" | "down") {
                return Err(ApiError::bad("direction must be left, right, up, or down"));
            }
            let mut params = json!({ "direction": direction });
            if let Some(pane_id) = body.pane_id {
                params["pane_id"] = json!(pane_id);
            }
            client.call("pane.focus_direction", params).await
        }
        "pane.split" => {
            let direction = required(body.direction, "a direction")?;
            if !matches!(direction.as_str(), "right" | "down") {
                return Err(ApiError::bad("split direction must be right or down"));
            }
            let mut params = json!({ "direction": direction, "ratio": 0.5, "focus": true });
            if let Some(pane_id) = body.pane_id {
                params["target_pane_id"] = json!(pane_id);
            }
            client.call("pane.split", params).await
        }
        "pane.close" => {
            let pane_id = required(body.pane_id, "a pane")?;
            client.call("pane.close", json!({ "pane_id": pane_id })).await
        }
        _ => return Err(ApiError::bad("unknown action")),
    };
    match result {
        Ok(value) => {
            state.runtime.invalidate();
            Ok(Json(json!({ "ok": true, "result": value })))
        }
        Err(err) => Err(ApiError::bad(err.to_string())),
    }
}

fn required(value: Option<String>, name: &str) -> Result<String, ApiError> {
    value
        .filter(|item| !item.trim().is_empty())
        .ok_or_else(|| ApiError::bad(format!("needs {name}")))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InputBody {
    pane_id: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    keys: Option<Vec<String>>,
}

async fn terminal_input(
    State(state): State<AppState>,
    Json(body): Json<InputBody>,
) -> Result<StatusCode, ApiError> {
    if !is_pane_id(&body.pane_id) {
        return Err(ApiError::bad("invalid pane id"));
    }
    let client = state.runtime.client().clone();
    if let Some(text) = body.text {
        crate::terminal::dispatch(&client, &body.pane_id, ClientInput::Text { text })
            .await
            .map_err(ApiError::upstream)?;
    }
    if let Some(keys) = body.keys {
        crate::terminal::dispatch(&client, &body.pane_id, ClientInput::Keys { keys })
            .await
            .map_err(ApiError::upstream)?;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SplitBody {
    pane_id: String,
    direction: String,
}

async fn terminal_split(
    State(state): State<AppState>,
    Json(body): Json<SplitBody>,
) -> Result<Json<Value>, ApiError> {
    if !is_pane_id(&body.pane_id) {
        return Err(ApiError::bad("invalid pane id"));
    }
    if body.direction != "right" && body.direction != "down" {
        return Err(ApiError::bad("direction must be right or down"));
    }
    let client = state.runtime.client().clone();
    let pane_id = client
        .split_pane(&body.pane_id, &body.direction)
        .await
        .map_err(ApiError::upstream)?;
    Ok(Json(json!({ "paneId": pane_id })))
}

async fn chat_get(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<crate::chats::Transcript>, ApiError> {
    crate::chats::load(&state.config_dir, &id)
        .map(Json)
        .map_err(ApiError::bad)
}

async fn chat_put(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<crate::chats::Transcript>,
) -> Result<StatusCode, ApiError> {
    crate::chats::save(&state.config_dir, &id, &body).map_err(ApiError::bad)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ScreenQuery {
    source: Option<String>,
    lines: Option<u32>,
}

async fn terminal_screen(
    State(state): State<AppState>,
    axum::extract::Path(pane_id): axum::extract::Path<String>,
    Query(query): Query<ScreenQuery>,
) -> Result<Json<Value>, ApiError> {
    if !is_pane_id(&pane_id) {
        return Err(ApiError::bad("invalid pane id"));
    }
    let source = screen_source(query.source.as_deref()).map_err(ApiError::bad)?;
    validate_lines(query.lines)?;
    let screen = state
        .runtime
        .client()
        .read_pane(&pane_id, source, query.lines)
        .await
        .map_err(ApiError::upstream)?;
    Ok(Json(json!({
        "text": screen.text,
        "truncated": screen.truncated,
        "revision": screen.revision,
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalQuery {
    pane_id: String,
    source: Option<String>,
    lines: Option<u32>,
}

async fn terminal_ws(
    ws: WebSocketUpgrade,
    Query(query): Query<TerminalQuery>,
    State(state): State<AppState>,
) -> Response {
    if !is_pane_id(&query.pane_id) {
        return ApiError::bad("invalid pane id").into_response();
    }
    let source = match screen_source(query.source.as_deref()) {
        Ok(source) => source.to_string(),
        Err(err) => return ApiError::bad(err).into_response(),
    };
    if let Err(err) = validate_lines(query.lines) {
        return err.into_response();
    }
    ws.on_upgrade(move |socket| {
        crate::terminal::drive(state, query.pane_id, source, query.lines, socket)
    })
}

#[derive(Deserialize)]
struct WatchQuery {
    path: String,
}

async fn watch_ws(
    ws: WebSocketUpgrade,
    Query(query): Query<WatchQuery>,
    State(state): State<AppState>,
) -> Response {
    if query.path.is_empty()
        || query.path.len() > 512
        || query.path.contains('\0')
        || query.path.contains("..")
    {
        return ApiError::bad("invalid content path").into_response();
    }
    let config_dir = Arc::clone(&state.config_dir);
    let roots = allowed_roots(&state).await;
    let events = state.watch.subscribe();
    let path = query.path;
    ws.on_upgrade(move |socket| crate::watch::drive(config_dir, roots, path, socket, events))
}

fn validate_lines(lines: Option<u32>) -> Result<(), ApiError> {
    if let Some(lines) = lines {
        if lines == 0 || lines > 2_000 {
            return Err(ApiError::bad("line count must be between 1 and 2000"));
        }
    }
    Ok(())
}

fn active_layout(
    state: &AppState,
) -> Result<(Settings, LayoutDocument, Vec<LayoutSummary>), ApiError> {
    let layouts = store::list_layouts(&state.config_dir).map_err(ApiError::bad)?;
    if layouts.is_empty() {
        return Err(ApiError::bad(
            "no layouts found; add a JSON file under the layouts directory",
        ));
    }
    let mut settings = store::load_settings(&state.config_dir).map_err(ApiError::bad)?;
    if !layouts
        .iter()
        .any(|layout| layout.id == settings.active_layout)
    {
        settings.active_layout = layouts[0].id.clone();
        store::save_settings(&state.config_dir, &settings).map_err(ApiError::bad)?;
    }
    let layout = load_existing(state, &settings.active_layout)?;
    Ok((settings, layout, layouts))
}

fn load_existing(state: &AppState, id: &str) -> Result<LayoutDocument, ApiError> {
    if !is_layout_id(id) {
        return Err(ApiError::bad("invalid layout id"));
    }
    let path = store::layouts_dir(&state.config_dir).join(format!("{id}.json"));
    if !path.is_file() {
        return Err(ApiError::missing(format!("layout {id} was not found")));
    }
    store::load_layout(&state.config_dir, id).map_err(ApiError::bad)
}

struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn bad(err: impl ToString) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: err.to_string(),
        }
    }

    fn missing(message: String) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message,
        }
    }

    fn upstream(err: impl ToString) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            message: err.to_string(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({"error": self.message}))).into_response()
    }
}
