use std::net::SocketAddr;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Extension, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, Request, StatusCode, Uri};
use axum::middleware::{from_fn_with_state, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{any, get, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde::Serialize;
use serde_json::{json, Value};

use crate::agent::AgentHub;
use crate::herdr::HerdrClient;
use crate::keys::ClientInput;
use crate::layout::{is_layout_id, is_pane_id, LayoutDocument};
use crate::paths::{find_dist_dir, session_name_from_socket};
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
    pub token: String,
    pub port: u16,
    pub passes: crate::frame_pass::FramePasses,
}

pub struct ServerConfig {
    pub host: std::net::IpAddr,
    pub port: u16,
    pub config_dir: PathBuf,
    pub herdr_socket: PathBuf,
    pub open_browser: bool,
    pub open_desktop: bool,
    pub url: String,
}

pub fn build_app(config_dir: PathBuf, herdr_socket: PathBuf, port: u16) -> anyhow::Result<Router> {
    let token = crate::auth::session_token(&config_dir)?;
    let settings = store::load_settings(&config_dir)?;
    let mut watch_paths = vec![config_dir.clone()];
    watch_paths.extend(settings.content_roots.iter().cloned());
    let watch = WatchHub::start(&watch_paths)?;
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .no_proxy()
        .build()?;
    let dist_dir = find_dist_dir().map(Arc::new);
    let state = AppState {
        config_dir: Arc::new(config_dir),
        runtime: RuntimeCache::new(HerdrClient::new(herdr_socket.clone())),
        http,
        dist_dir: dist_dir.clone(),
        watch,
        agent: AgentHub::new(),
        controls: PaneControls::new(session_name_from_socket(&herdr_socket)),
        token,
        port,
        passes: crate::frame_pass::FramePasses::new(),
    };
    let guard_state = state.clone();

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
        .route("/api/frame-pass", post(issue_frame_pass))
        .route("/api/session/focus", post(focus_session))
        .route(
            "/api/sessions",
            get(list_sessions).put(use_session).post(create_session),
        )
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
        .route("/gate/{*path}", any(gate_entry));

    router = if dist_dir.is_some() {
        router.fallback(get(frontend))
    } else {
        router.fallback(get(setup_page))
    };

    Ok(router
        .layer(axum::extract::DefaultBodyLimit::max(20 * 1024 * 1024))
        .layer(from_fn_with_state(guard_state, guard))
        .with_state(state))
}

pub async fn serve(config: ServerConfig) -> anyhow::Result<()> {
    let app = build_app(
        config.config_dir.clone(),
        config.herdr_socket.clone(),
        config.port,
    )?;
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
    if config.open_desktop {
        match crate::cli::spawn_desktop() {
            Ok(()) => tracing::info!("opened the desktop window"),
            Err(err) => {
                tracing::warn!("desktop window: {err:#}");
                crate::cli::open_browser(&config.url);
            }
        }
    } else if config.open_browser {
        crate::cli::open_browser(&config.url);
    }

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

async fn guard(State(state): State<AppState>, req: Request<Body>, next: Next) -> Response {
    let origin = header_text(&req, "origin");
    if let Some(origin) = origin.as_deref() {
        if origin != "null" && !crate::auth::origin_allowed(origin, state.port) {
            return deny(StatusCode::FORBIDDEN, "origin is not allowed");
        }
    }
    let path = req.uri().path().to_string();
    if is_shell_document(&path) && origin.as_deref() == Some("null") {
        return deny(StatusCode::FORBIDDEN, "origin is not allowed");
    }
    if path == "/gate" || path.starts_with("/gate/") {
        return serve_gate(state, req, &path, next).await;
    }
    if !is_page_asset(&path) {
        let presented = presented_token(&req, &path);
        let ok = presented
            .as_deref()
            .is_some_and(|value| crate::auth::tokens_match(&state.token, value));
        if !ok && !frame_load_allowed(&req, &path) {
            return deny(StatusCode::UNAUTHORIZED, "viewer token is required");
        }
    }
    let mut response = next.run(req).await;
    stamp(&mut response);
    response
}

async fn gate_entry(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    gate: Option<Extension<crate::frame_pass::ActiveGate>>,
    body: Bytes,
) -> Response {
    if uri.path().starts_with("/content/") && (method == Method::GET || method == Method::HEAD) {
        return crate::content::handle(State(state), uri).await;
    }
    if uri.path().starts_with("/proxy/") {
        return crate::proxy::handle(State(state), method, uri, headers, gate, body).await;
    }
    deny(StatusCode::UNAUTHORIZED, "viewer token is required")
}

async fn serve_gate(state: AppState, mut req: Request<Body>, path: &str, next: Next) -> Response {
    let Some(gate) = crate::frame_pass::parse_gate(path) else {
        return deny(StatusCode::UNAUTHORIZED, "viewer token is required");
    };
    if !state.passes.authorize(&gate.secret, &gate.path, req.method()) {
        return deny(StatusCode::UNAUTHORIZED, "viewer token is required");
    }
    let mut rewritten = gate.path;
    if let Some(query) = req.uri().query() {
        rewritten.push('?');
        rewritten.push_str(query);
    }
    let Ok(uri) = rewritten.parse::<Uri>() else {
        return deny(StatusCode::BAD_REQUEST, "path is invalid");
    };
    *req.uri_mut() = uri;
    req.extensions_mut()
        .insert(crate::frame_pass::ActiveGate { secret: gate.secret });
    let mut response = next.run(req).await;
    stamp(&mut response);
    response
}

fn deny(status: StatusCode, error: &str) -> Response {
    let mut response = (status, Json(json!({"error": error}))).into_response();
    stamp(&mut response);
    response
}

fn stamp(response: &mut Response) {
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response.headers_mut().insert(
        header::HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
}

fn header_text(req: &Request<Body>, name: &str) -> Option<String> {
    req.headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn is_shell_document(path: &str) -> bool {
    path == "/" || path == "/index.html"
}

fn is_framed_path(path: &str) -> bool {
    path == "/content"
        || path.starts_with("/content/")
        || path == "/plugins"
        || path.starts_with("/plugins/")
        || path == "/proxy"
        || path.starts_with("/proxy/")
}

fn is_page_asset(path: &str) -> bool {
    path != "/api"
        && !path.starts_with("/api/")
        && path != "/ws"
        && !path.starts_with("/ws/")
        && path != "/gate"
        && !path.starts_with("/gate/")
        && !is_framed_path(path)
}

fn presented_token(req: &Request<Body>, path: &str) -> Option<String> {
    if let Some(token) = bearer_token(req) {
        return Some(token);
    }
    if path == "/ws" || path.starts_with("/ws/") {
        return query_token(req.uri());
    }
    None
}

fn bearer_token(req: &Request<Body>) -> Option<String> {
    let value = header_text(req, "authorization")?;
    let (scheme, rest) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = rest.trim();
    if token.is_empty() || token.contains(' ') {
        return None;
    }
    Some(token.to_string())
}

fn query_token(uri: &Uri) -> Option<String> {
    let query = uri.query()?;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if percent_decode(key) == "token" {
            return Some(percent_decode(value));
        }
    }
    None
}

fn frame_load_allowed(req: &Request<Body>, path: &str) -> bool {
    if req.method() != Method::GET && req.method() != Method::HEAD {
        return false;
    }
    if path != "/plugins" && !path.starts_with("/plugins/") {
        return false;
    }
    let site = header_text(req, "sec-fetch-site");
    if matches!(site.as_deref(), Some("same-origin") | Some("none")) {
        return true;
    }
    let dest = header_text(req, "sec-fetch-dest");
    header_text(req, "origin").as_deref() == Some("null")
        && matches!(
            dest.as_deref(),
            Some("script")
                | Some("style")
                | Some("image")
                | Some("font")
                | Some("empty")
                | Some("audio")
                | Some("video")
                | Some("worker")
        )
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (from_hex(bytes[index + 1]), from_hex(bytes[index + 2])) {
                out.push((hi << 4) | lo);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn from_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

async fn frontend(State(state): State<AppState>, uri: Uri) -> Response {
    let Some(dist) = state.dist_dir.clone() else {
        return setup_page().await.into_response();
    };
    let path = uri.path();
    if is_shell_document(path) {
        return match tokio::fs::read_to_string(dist.join("index.html")).await {
            Ok(html) => html_document(&html, &state.token),
            Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
        };
    }
    if let Some(file) = safe_asset(&dist, path) {
        return serve_file(file).await;
    }
    (StatusCode::NOT_FOUND, "not found").into_response()
}

fn html_document(html: &str, token: &str) -> Response {
    let mut response = Response::new(Body::from(inject_token(html, token)));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn inject_token(html: &str, token: &str) -> String {
    let literal = serde_json::to_string(token).unwrap_or_else(|_| "\"\"".to_string());
    let tag = format!("<script>window.__HERDR_PANELS_TOKEN__={literal}</script>");
    match html.find("</head>") {
        Some(at) => {
            let mut out = String::with_capacity(html.len() + tag.len());
            out.push_str(&html[..at]);
            out.push_str(&tag);
            out.push_str(&html[at..]);
            out
        }
        None => format!("{tag}{html}"),
    }
}

fn safe_asset(dist: &Path, request_path: &str) -> Option<PathBuf> {
    let decoded = percent_decode(request_path.trim_start_matches('/'));
    if decoded.is_empty() || decoded.contains('\\') || decoded.contains('\0') {
        return None;
    }
    let relative = Path::new(&decoded);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return None;
    }
    let root = dist.canonicalize().ok()?;
    let file = dist.join(relative).canonicalize().ok()?;
    if file.is_file() && file.starts_with(&root) {
        Some(file)
    } else {
        None
    }
}

async fn serve_file(path: PathBuf) -> Response {
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(_) => return (StatusCode::NOT_FOUND, "not found").into_response(),
    };
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    let mut response = Response::new(Body::from(bytes));
    if let Ok(value) = HeaderValue::from_str(mime.as_ref()) {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    }
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

async fn tree(Query(query): Query<TreeQuery>) -> Result<Json<Value>, ApiError> {
    let entries = crate::files::list_children(std::path::Path::new(&query.path))
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
    let original = url::Url::parse(url).ok()?;
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
            if next.scheme() != "http" && next.scheme() != "https" || !same_site(&original, &next) {
                return Some("this site redirected to another host");
            }
            current = next.to_string();
            continue;
        }
        let pairs = response
            .headers()
            .iter()
            .filter_map(|(key, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|text| (key.as_str().to_string(), text.to_string()))
            })
            .collect::<Vec<_>>();
        let borrowed = pairs
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect::<Vec<_>>();
        return crate::open_target::embedding_refusal(&borrowed);
    }
    None
}

fn same_site(left: &url::Url, right: &url::Url) -> bool {
    left.scheme() == right.scheme()
        && left.host() == right.host()
        && left.port_or_known_default() == right.port_or_known_default()
}

#[derive(Deserialize)]
struct FramePassBody {
    path: String,
}

async fn issue_frame_pass(
    State(state): State<AppState>,
    Json(body): Json<FramePassBody>,
) -> Result<Json<Value>, ApiError> {
    let src = state.passes.issue(&body.path).map_err(ApiError::bad)?;
    Ok(Json(json!({ "src": src })))
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

async fn herdr_config(State(state): State<AppState>) -> Json<Value> {
    let doc = tokio::task::spawn_blocking(crate::herdr_config::document)
        .await
        .unwrap_or_else(|_| json!({}));
    Json(with_integrations(&state, doc).await)
}

async fn put_herdr_config(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    if let Some(spec) = body.get("integration") {
        let target = spec.get("target").and_then(Value::as_str).unwrap_or("");
        let action = spec.get("action").and_then(Value::as_str).unwrap_or("");
        if !integration_target(target) {
            return Err(ApiError::bad("unknown integration"));
        }
        let method = match action {
            "install" => "integration.install",
            "uninstall" => "integration.uninstall",
            _ => return Err(ApiError::bad("unknown integration action")),
        };
        state
            .runtime
            .client()
            .call(method, json!({ "target": target }))
            .await
            .map_err(|err| ApiError::bad(err.to_string()))?;
    }
    let touches = body.get("theme").is_some()
        || body.get("settings").is_some()
        || body.get("keys").is_some()
        || body.get("reload").and_then(Value::as_bool).unwrap_or(false);
    let doc = if touches {
        let socket = state.runtime.client().logical_socket();
        let session = crate::paths::session_name_from_socket(std::path::Path::new(&socket));
        crate::herdr_config::apply(&body, session.as_deref())
            .await
            .map_err(ApiError::bad)?
    } else {
        tokio::task::spawn_blocking(crate::herdr_config::document)
            .await
            .map_err(|_| ApiError::bad("could not read Herdr config"))?
    };
    Ok(Json(with_integrations(&state, doc).await))
}

fn integration_target(target: &str) -> bool {
    let mut chars = target.chars();
    matches!(chars.next(), Some(ch) if ch.is_ascii_lowercase())
        && target.len() <= 40
        && target
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-')
}

async fn with_integrations(state: &AppState, mut doc: Value) -> Value {
    match state
        .runtime
        .client()
        .call("integration.list", json!({}))
        .await
    {
        Ok(result) => {
            doc["integrations"] = result.get("integrations").cloned().unwrap_or(json!([]));
        }
        Err(err) => {
            doc["integrations"] = json!([]);
            doc["integrationError"] = json!(err.to_string());
        }
    }
    doc
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
            let label = required(
                body.label.filter(|label| !label.trim().is_empty()),
                "a name",
            )?;
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
            client
                .call("pane.close", json!({ "pane_id": pane_id }))
                .await
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_websocket_query_token_is_percent_decoded() {
        let uri: Uri = "http://127.0.0.1/ws/agent?path=notes%2Fwelcome.md&token=abc%2B%2F%3D"
            .parse()
            .unwrap();
        assert_eq!(query_token(&uri).as_deref(), Some("abc+/="));
    }
}
