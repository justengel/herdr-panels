//! How the viewer is supposed to behave.
//!
//! Each test starts a real server against a temporary config directory and a
//! Herdr socket that is not running. The cases are the product rules, not
//! checks of private helpers.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use axum::{routing::get, Router};
use herdr_panels::build_app;
use serde_json::{json, Value};
use tokio::net::TcpListener;

struct Desk {
    base: String,
    token: String,
    root: PathBuf,
    workspace: PathBuf,
    http: reqwest::Client,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for Desk {
    fn drop(&mut self) {
        self.server.abort();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

async fn desk() -> Desk {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!("hwp-blueprint-{}-{id}", std::process::id()));
    let workspace = root.join("workspace");
    std::fs::create_dir_all(workspace.join("notes")).unwrap();
    std::fs::write(workspace.join("notes").join("welcome.md"), "# Hello\n").unwrap();
    std::fs::create_dir_all(workspace.join("projects")).unwrap();
    std::fs::create_dir_all(root.join("plugins").join("welcome")).unwrap();
    std::fs::write(
        root.join("plugins").join("welcome").join("plugin.json"),
        r#"{"id":"welcome","title":"Welcome","entry":"index.html"}"#,
    )
    .unwrap();
    std::fs::write(
        root.join("plugins").join("welcome").join("index.html"),
        "<p>Welcome</p>",
    )
    .unwrap();
    let layout = json!({
        "id": "desk",
        "title": "Desk",
        "root": {
            "type": "split",
            "direction": "row",
            "ratio": 0.5,
            "first": {
                "type": "panel",
                "id": "shell",
                "title": "Shell",
                "panel": {"type": "herdr", "paneId": null}
            },
            "second": {
                "type": "panel",
                "id": "notes",
                "title": "Notes",
                "panel": {"type": "markdown", "path": "notes/welcome.md"}
            }
        }
    });
    std::fs::create_dir_all(root.join("layouts")).unwrap();
    std::fs::write(
        root.join("layouts").join("desk.json"),
        serde_json::to_vec_pretty(&layout).unwrap(),
    )
    .unwrap();
    std::fs::write(
        root.join("settings.json"),
        serde_json::to_vec_pretty(&json!({
            "activeLayout": "desk",
            "contentRoots": [workspace.display().to_string()],
        }))
        .unwrap(),
    )
    .unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = build_app(root.clone(), root.join("missing-herdr.sock"), port).unwrap();
    let token = herdr_panels::auth::session_token(&root).unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Desk {
        base: format!("http://127.0.0.1:{port}"),
        token,
        root,
        workspace,
        http: reqwest::Client::new(),
        server,
    }
}

impl Desk {
    async fn call(&self, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        self.exchange(method, path, body, None, true, &[]).await
    }

    async fn call_anonymous(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        self.exchange(method, path, body, None, false, &[]).await
    }

    async fn call_origin(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        origin: Option<&str>,
    ) -> (StatusCode, Value) {
        self.exchange(method, path, body, origin, true, &[]).await
    }

    async fn exchange(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        origin: Option<&str>,
        authenticate: bool,
        headers: &[(&str, &str)],
    ) -> (StatusCode, Value) {
        let mut request = self
            .http
            .request(method.parse().unwrap(), format!("{}{path}", self.base));
        if authenticate {
            request = request.header("authorization", format!("Bearer {}", self.token));
        }
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        if let Some(body) = body {
            request = request
                .header("content-type", "application/json")
                .body(body.to_string());
        }
        let response = request.send().await.unwrap();
        let status = response.status();
        let text = response.text().await.unwrap();
        let value = if text.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or_else(|_| json!({ "raw": text }))
        };
        (status, value)
    }

    fn panel<'a>(&self, workspace: &'a Value, title: &str) -> &'a Value {
        workspace["panels"]
            .as_array()
            .unwrap()
            .iter()
            .find(|panel| panel["title"] == title)
            .unwrap_or_else(|| panic!("no panel titled {title} in {workspace}"))
    }
}

async fn local_page(deny_frames: bool) -> (String, tokio::task::JoinHandle<()>) {
    let app = Router::new().route(
        "/page",
        get(move || async move {
            let mut response = (StatusCode::OK, "pong").into_response();
            if deny_frames {
                response.headers_mut().insert(
                    header::HeaderName::from_static("x-frame-options"),
                    HeaderValue::from_static("DENY"),
                );
            }
            response
                .headers_mut()
                .insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain"));
            response
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{addr}/page"), server)
}

#[tokio::test]
async fn the_viewer_stays_up_when_herdr_is_offline() {
    let desk = desk().await;
    let (status, health) = desk.call("GET", "/api/health", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(health["ok"], true);

    let (status, runtime) = desk.call("GET", "/api/runtime", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(runtime["connected"], false);

    let (status, workspace) = desk.call("GET", "/api/agent/workspace", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(workspace["panels"].as_array().unwrap().len(), 2);
    assert_eq!(desk.panel(&workspace, "Shell")["type"], "herdr");
    assert_eq!(desk.panel(&workspace, "Notes")["type"], "markdown");
}

#[tokio::test]
async fn a_panel_can_be_named_and_a_shared_name_cannot_be_used() {
    let desk = desk().await;
    let (status, workspace) = desk
        .call(
            "POST",
            "/api/agent/update",
            Some(json!({"panelId": "shell", "title": "Notes"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{workspace}");
    assert_eq!(workspace["panels"].as_array().unwrap().len(), 2);

    let (status, error) = desk
        .call(
            "POST",
            "/api/agent/close",
            Some(json!({"panelId": "Notes"})),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["error"], "more than one panel has that name");

    let (status, by_id) = desk
        .call(
            "POST",
            "/api/agent/close",
            Some(json!({"panelId": "shell"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{by_id}");
    assert_eq!(by_id["panels"].as_array().unwrap().len(), 1);
    assert_eq!(by_id["panels"][0]["id"], "notes");
}

#[tokio::test]
async fn splitting_adds_a_neighbor_and_the_last_panel_stays() {
    let desk = desk().await;
    let (status, workspace) = desk
        .call(
            "POST",
            "/api/agent/split",
            Some(json!({
                "panelId": "Shell",
                "direction": "down",
                "title": "Beside",
                "panel": {"type": "iframe", "url": "https://example.com", "proxy": false}
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{workspace}");
    let workspace = &workspace["workspace"];
    assert_eq!(workspace["panels"].as_array().unwrap().len(), 3);
    assert_eq!(
        desk.panel(workspace, "Beside")["summary"],
        "https://example.com"
    );

    let (status, closed) = desk
        .call(
            "POST",
            "/api/agent/close",
            Some(json!({"panelId": "Beside"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{closed}");
    assert_eq!(closed["panels"].as_array().unwrap().len(), 2);

    let (status, _) = desk
        .call(
            "POST",
            "/api/agent/close",
            Some(json!({"panelId": "Shell"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, refused) = desk
        .call(
            "POST",
            "/api/agent/close",
            Some(json!({"panelId": "Notes"})),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(refused["error"], "at least one panel stays open");
    let (_, workspace) = desk.call("GET", "/api/agent/workspace", None).await;
    assert_eq!(workspace["panels"][0]["title"], "Notes");
}

#[tokio::test]
async fn a_divider_stays_inside_the_usable_range() {
    let desk = desk().await;
    let (status, _) = desk
        .call(
            "POST",
            "/api/agent/resize",
            Some(json!({"panelId": "Notes", "ratio": 0.99})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, layout) = desk.call("GET", "/api/layouts/desk", None).await;
    assert_eq!(status, StatusCode::OK);
    let ratio = layout["root"]["ratio"].as_f64().unwrap();
    assert!(
        (0.12..=0.88).contains(&ratio),
        "ratio {ratio} left the usable range"
    );
    assert!(
        (ratio - 0.12).abs() < 0.001,
        "the second panel was not clamped, ratio {ratio}"
    );
}

#[tokio::test]
async fn the_address_bar_chooses_what_a_panel_shows() {
    let desk = desk().await;
    let note = desk.workspace.join("notes").join("welcome.md");
    let projects = desk.workspace.join("projects");

    let (status, resolved) = desk
        .call(
            "POST",
            "/api/agent/resolve",
            Some(json!({"target": note.display().to_string()})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{resolved}");
    assert_eq!(resolved["panel"]["type"], "markdown");

    let (status, resolved) = desk
        .call(
            "POST",
            "/api/agent/resolve",
            Some(json!({"target": projects.display().to_string()})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{resolved}");
    assert_eq!(resolved["panel"]["type"], "explorer");

    let (status, resolved) = desk
        .call(
            "POST",
            "/api/agent/resolve",
            Some(json!({"target": "example.com"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{resolved}");
    assert_eq!(resolved["panel"]["type"], "iframe");
    assert_eq!(resolved["panel"]["url"], "https://example.com");
    assert_eq!(resolved["panel"]["proxy"], false);

    let (status, resolved) = desk
        .call(
            "POST",
            "/api/agent/resolve",
            Some(json!({"target": "127.0.0.1:9"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{resolved}");
    assert_eq!(resolved["panel"]["url"], "http://127.0.0.1:9");
    assert_eq!(resolved["panel"]["proxy"], true);

    let (status, resolved) = desk
        .call(
            "POST",
            "/api/agent/resolve",
            Some(json!({"target": "plugin:welcome"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{resolved}");
    assert_eq!(resolved["panel"]["type"], "plugin");
    assert_eq!(resolved["panel"]["plugin"], "welcome");

    let (status, missing_plugin) = desk
        .call(
            "POST",
            "/api/agent/resolve",
            Some(json!({"target": "plugin:missing"})),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        missing_plugin["error"]
            .as_str()
            .unwrap()
            .contains("not installed"),
        "{missing_plugin}"
    );

    let (status, missing_file) = desk
        .call(
            "POST",
            "/api/agent/resolve",
            Some(json!({"target": "notes/missing.md"})),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        missing_file["error"]
            .as_str()
            .unwrap()
            .contains("was not found"),
        "{missing_file}"
    );
    let (_, workspace) = desk.call("GET", "/api/agent/workspace", None).await;
    assert_eq!(workspace["panels"].as_array().unwrap().len(), 2);

    let (status, rejected) = desk
        .call(
            "POST",
            "/api/agent/resolve",
            Some(json!({"target": "javascript:alert(1)"})),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(rejected["error"], "url must be http or https");
}

#[tokio::test]
async fn ordinary_sites_are_not_proxied_and_may_refuse_to_be_framed() {
    let desk = desk().await;
    let (status, refused) = desk.call("GET", "/proxy/https/example.com/", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        refused["error"].as_str().unwrap().contains("localhost"),
        "{refused}"
    );

    let (open_url, open_server) = local_page(false).await;
    let (status, allowed) = desk
        .call("GET", &format!("/api/frame?{}", query_url(&open_url)), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{allowed}");
    assert_eq!(allowed["allowed"], true);
    let port = open_url
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap();
    let (status, proxied) = desk
        .call("GET", &format!("/proxy/http/{port}/page"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{proxied}");
    assert_eq!(proxied["raw"], "pong");
    open_server.abort();

    let (closed_url, closed_server) = local_page(true).await;
    let (status, framed) = desk
        .call(
            "GET",
            &format!("/api/frame?{}", query_url(&closed_url)),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{framed}");
    assert_eq!(framed["allowed"], false);
    assert_eq!(framed["reason"], "This site refused to be embedded.");
    closed_server.abort();
}

#[tokio::test]
async fn frame_redirects_stay_on_the_original_host() {
    let desk = desk().await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let home = Router::new()
        .route(
            "/page",
            get(|| async {
                let mut response = (StatusCode::OK, "pong").into_response();
                response
                    .headers_mut()
                    .insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain"));
                response
            }),
        )
        .route(
            "/go",
            get(move || async move {
                let mut response = (StatusCode::FOUND, "").into_response();
                response.headers_mut().insert(
                    header::LOCATION,
                    HeaderValue::from_str(&format!("http://{addr}/page")).unwrap(),
                );
                response
            }),
        );
    let home_server = tokio::spawn(async move {
        axum::serve(listener, home).await.unwrap();
    });
    let (status, same) = desk
        .call(
            "GET",
            &format!("/api/frame?{}", query_url(&format!("http://{addr}/go"))),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{same}");
    assert_eq!(same["allowed"], true, "{same}");

    let (other_url, other_server) = local_page(false).await;
    let app = Router::new().route(
        "/leave",
        get(move || {
            let other_url = other_url.clone();
            async move {
                let mut response = (StatusCode::FOUND, "").into_response();
                response
                    .headers_mut()
                    .insert(header::LOCATION, HeaderValue::from_str(&other_url).unwrap());
                response
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let leave = listener.local_addr().unwrap();
    let leave_server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let (status, left) = desk
        .call(
            "GET",
            &format!("/api/frame?{}", query_url(&format!("http://{leave}/leave"))),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{left}");
    assert_eq!(left["allowed"], false, "{left}");
    assert!(
        left["reason"]
            .as_str()
            .unwrap_or("")
            .contains("another host"),
        "{left}"
    );
    home_server.abort();
    other_server.abort();
    leave_server.abort();
}

#[tokio::test]
async fn a_tab_group_can_hold_several_panels_and_cannot_contain_another_group() {
    let desk = desk().await;
    let (status, layout) = desk.call("GET", "/api/layouts/desk", None).await;
    assert_eq!(status, StatusCode::OK);
    let mut grouped = layout.clone();
    grouped["root"]["second"]["panel"] = json!({
        "type": "tabs",
        "edge": "top",
        "active": "tab-1",
        "tabs": [
            {"id": "tab-1", "title": "Notes", "panel": {"type": "markdown", "path": "notes/welcome.md"}},
            {"id": "tab-2", "title": "Terminal", "panel": {"type": "herdr", "paneId": null}}
        ]
    });
    let (status, saved) = desk
        .call("PUT", "/api/layouts/desk", Some(grouped.clone()))
        .await;
    assert_eq!(status, StatusCode::OK, "{saved}");

    grouped["root"]["second"]["panel"]["tabs"][1]["panel"] = json!({
        "type": "tabs",
        "tabs": [{"id": "inner", "title": "Inner", "panel": {"type": "iframe", "url": "https://example.com"}}]
    });
    let (status, rejected) = desk.call("PUT", "/api/layouts/desk", Some(grouped)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        rejected["error"]
            .as_str()
            .unwrap()
            .contains("cannot be nested"),
        "{rejected}"
    );
}

#[tokio::test]
async fn the_default_herdr_session_cannot_be_closed_from_the_viewer() {
    let desk = desk().await;
    let (status, error) = desk
        .call(
            "POST",
            "/api/sessions/close",
            Some(json!({"name": "default"})),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        error["error"].as_str().unwrap().contains("default session"),
        "{error}"
    );
}

#[test]
fn the_default_theme_is_stored_by_leaving_its_name_unset() {
    let original = "onboarding = false\n\n[ui]\nagent_panel_sort = \"spaces\"\n";
    let chosen = herdr_panels::herdr_config::assign(
        original,
        "theme",
        "name",
        Some("name = \"tokyo-night\"".into()),
    );
    assert!(chosen.contains("[theme]"));
    assert!(chosen.contains("name = \"tokyo-night\""));
    assert!(chosen.contains("agent_panel_sort = \"spaces\""));

    let restored = herdr_panels::herdr_config::assign(&chosen, "theme", "name", None);
    assert!(!restored.contains("[theme]"));
    assert!(!restored.contains("tokyo-night"));
    assert!(restored.contains("agent_panel_sort = \"spaces\""));
}

#[tokio::test]
async fn the_control_api_requires_the_viewer_token() {
    let desk = desk().await;
    let token = desk.token.clone();
    let (status, denied) = desk.call_anonymous("GET", "/api/health", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{denied}");
    assert!(
        denied["error"].as_str().unwrap_or("").contains("token"),
        "{denied}"
    );

    let (status, _) = desk
        .call_anonymous("GET", &format!("/api/health?token={token}"), None)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, _) = desk
        .exchange(
            "GET",
            "/api/health",
            None,
            None,
            false,
            &[("authorization", "Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, health) = desk.call("GET", "/api/health", None).await;
    assert_eq!(status, StatusCode::OK, "{health}");
    assert_eq!(health["ok"], true);

    let (status, _) = desk.call_anonymous("GET", "/ws/agent", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = desk
        .call_anonymous("GET", &format!("/ws/agent?token={token}"), None)
        .await;
    assert_ne!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = desk
        .call_anonymous(
            "GET",
            "/ws/agent?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            None,
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn only_the_viewer_origin_can_call_the_api() {
    let desk = desk().await;
    let origin = desk.base.clone();
    let (status, _) = desk
        .call_origin("GET", "/api/health", None, Some("https://example.com"))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = desk
        .exchange(
            "GET",
            "/api/health",
            None,
            Some("https://example.com"),
            false,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = desk
        .call_origin("GET", "/api/health", None, Some("http://127.0.0.1:9"))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, health) = desk
        .call_origin("GET", "/api/health", None, Some(&origin))
        .await;
    assert_eq!(status, StatusCode::OK, "{health}");
    assert_eq!(health["ok"], true);
    let (status, dev) = desk
        .call_origin("GET", "/api/health", None, Some("http://127.0.0.1:5173"))
        .await;
    assert_eq!(status, StatusCode::OK, "{dev}");
    let (status, _) = desk
        .exchange(
            "GET",
            "/api/health",
            None,
            Some("http://127.0.0.1:5173"),
            false,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = desk
        .exchange(
            "GET",
            "/",
            None,
            Some("null"),
            false,
            &[("sec-fetch-dest", "document")],
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn framed_files_load_without_a_token_in_the_url() {
    let desk = desk().await;
    let (status, page) = desk
        .exchange(
            "GET",
            "/plugins/welcome/index.html",
            None,
            None,
            false,
            &[("sec-fetch-site", "same-origin")],
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(
        page["raw"].as_str().unwrap_or("").contains("Welcome"),
        "{page}"
    );

    let (status, script) = desk
        .exchange(
            "GET",
            "/plugins/welcome/index.html",
            None,
            Some("null"),
            false,
            &[("sec-fetch-dest", "script")],
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{script}");

    let (status, _) = desk
        .exchange(
            "GET",
            "/plugins/welcome/index.html",
            None,
            None,
            false,
            &[("sec-fetch-site", "same-site")],
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = desk
        .exchange(
            "GET",
            "/plugins/welcome/index.html",
            None,
            Some("null"),
            false,
            &[("sec-fetch-dest", "document")],
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = desk
        .exchange(
            "POST",
            "/plugins/welcome/index.html",
            None,
            None,
            false,
            &[("sec-fetch-site", "same-origin")],
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = desk
        .exchange(
            "GET",
            "/api/health",
            None,
            Some("null"),
            false,
            &[("sec-fetch-dest", "empty")],
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = desk
        .exchange(
            "GET",
            "/api/health",
            None,
            None,
            false,
            &[("sec-fetch-site", "same-origin")],
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (open_url, open_server) = local_page(false).await;
    let port = open_url
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap();
    let (status, proxied) = desk
        .exchange(
            "GET",
            &format!("/proxy/http/{port}/page"),
            None,
            None,
            false,
            &[("sec-fetch-site", "same-origin")],
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{proxied}");
    let (status, _) = desk
        .exchange(
            "GET",
            &format!("/proxy/http/{port}/page"),
            None,
            None,
            false,
            &[("sec-fetch-site", "same-site")],
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    open_server.abort();
}

#[tokio::test]
async fn content_and_proxy_require_a_credential() {
    let desk = desk().await;
    std::fs::write(desk.workspace.join("secret.txt"), "top secret").unwrap();
    std::fs::create_dir_all(desk.workspace.join("panels")).unwrap();
    std::fs::write(
        desk.workspace.join("panels").join("page.html"),
        "<p>Chart</p>",
    )
    .unwrap();

    let (status, open) = desk
        .exchange(
            "GET",
            "/content/notes/welcome.md",
            None,
            None,
            false,
            &[("sec-fetch-site", "same-origin")],
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{open}");

    let (status, file) = desk.call("GET", "/content/notes/welcome.md", None).await;
    assert_eq!(status, StatusCode::OK, "{file}");
    assert!(
        file["raw"].as_str().unwrap_or("").contains("Hello"),
        "{file}"
    );

    let (status, _) = desk
        .call_anonymous(
            "POST",
            "/api/frame-pass",
            Some(json!({"path": "/content/notes/welcome.md"})),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, minted) = desk
        .call(
            "POST",
            "/api/frame-pass",
            Some(json!({"path": "/content/panels/page.html?bridge=1"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{minted}");
    let src = minted["src"].as_str().unwrap().to_string();
    assert!(src.starts_with("/gate/"), "{src}");
    assert!(src.contains("/content/panels/page.html?bridge=1"), "{src}");
    let secret = src
        .trim_start_matches("/gate/")
        .split('/')
        .next()
        .unwrap()
        .to_string();

    let (status, page) = desk.call_anonymous("GET", &src, None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(
        page["raw"].as_str().unwrap_or("").contains("Chart"),
        "{page}"
    );
    assert!(
        page["raw"].as_str().unwrap_or("").contains("hwp-bridge"),
        "{page}"
    );

    let (status, leaked) = desk
        .call_anonymous("GET", &format!("/gate/{secret}/content/secret.txt"), None)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{leaked}");

    std::fs::write(desk.workspace.join("root.html"), "<p>Root</p>").unwrap();
    let (status, minted) = desk
        .call(
            "POST",
            "/api/frame-pass",
            Some(json!({"path": "/content/root.html"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{minted}");
    let root_src = minted["src"].as_str().unwrap().to_string();
    let (status, root_page) = desk.call_anonymous("GET", &root_src, None).await;
    assert_eq!(status, StatusCode::OK, "{root_page}");
    assert!(
        root_page["raw"].as_str().unwrap_or("").contains("Root"),
        "{root_page}"
    );
    let (status, _) = desk
        .call_anonymous(
            "GET",
            &root_src.replace("/content/root.html", "/content/secret.txt"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, api) = desk
        .call_anonymous("GET", &format!("/gate/{secret}/api/health"), None)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{api}");
    let (status, _) = desk
        .exchange(
            "GET",
            "/api/health",
            None,
            None,
            false,
            &[("authorization", &format!("Bearer {secret}"))],
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, posted) = desk
        .call_anonymous(
            "POST",
            &format!("/gate/{secret}/content/panels/page.html"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{posted}");

    let (status, broad) = desk
        .call(
            "POST",
            "/api/frame-pass",
            Some(json!({"path": "/content/"})),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{broad}");
    let (status, foreign) = desk
        .call(
            "POST",
            "/api/frame-pass",
            Some(json!({"path": "/proxy/http/example.com/page"})),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{foreign}");

    let (open_url, open_server) = local_page(false).await;
    let port = open_url
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap();
    let (status, bare) = desk
        .exchange(
            "GET",
            &format!("/proxy/http/{port}/page"),
            None,
            None,
            false,
            &[("sec-fetch-site", "same-origin")],
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{bare}");

    let (status, minted) = desk
        .call(
            "POST",
            "/api/frame-pass",
            Some(json!({"path": format!("/proxy/http/{port}/page")})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{minted}");
    let proxy_src = minted["src"].as_str().unwrap().to_string();
    let (status, proxied) = desk.call_anonymous("GET", &proxy_src, None).await;
    assert_eq!(status, StatusCode::OK, "{proxied}");
    assert_eq!(proxied["raw"], "pong");

    let other = proxy_src.replace(port, "127.0.0.1:1");
    let (status, _) = desk.call_anonymous("GET", &other, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, authed) = desk
        .call("GET", &format!("/proxy/http/{port}/page"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{authed}");
    assert_eq!(authed["raw"], "pong");
    open_server.abort();

    let html_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let html_addr = html_listener.local_addr().unwrap();
    let html_app = Router::new().route(
        "/page",
        get(|| async {
            let mut response = (
                StatusCode::OK,
                "<html><head></head><body><img src=\"chart.png\"></body></html>",
            )
                .into_response();
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/html; charset=utf-8"),
            );
            response
        }),
    );
    let html_server = tokio::spawn(async move {
        axum::serve(html_listener, html_app).await.unwrap();
    });
    let (status, minted) = desk
        .call(
            "POST",
            "/api/frame-pass",
            Some(json!({"path": format!("/proxy/http/{html_addr}/page")})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{minted}");
    let html_src = minted["src"].as_str().unwrap();
    let (status, html) = desk.call_anonymous("GET", html_src, None).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let raw = html["raw"].as_str().unwrap_or("");
    assert!(
        raw.contains(&format!("/gate/")) && raw.contains(&format!("/proxy/http/{html_addr}/")),
        "{raw}"
    );
    html_server.abort();
}

#[tokio::test]
async fn the_proxy_does_not_forward_viewer_credentials() {
    let desk = desk().await;
    let upstream = Router::new().route(
        "/page",
        get(|headers: HeaderMap| async move {
            let body = format!(
                "cookie={} auth={}",
                headers.get("cookie").is_some(),
                headers.get(header::AUTHORIZATION).is_some()
            );
            let mut response = (StatusCode::OK, body).into_response();
            response
                .headers_mut()
                .insert(header::SET_COOKIE, HeaderValue::from_static("upstream=1"));
            response
                .headers_mut()
                .insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain"));
            response
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, upstream).await.unwrap();
    });
    let response = desk
        .http
        .get(format!("{}/proxy/http/{addr}/page", desk.base))
        .header("authorization", format!("Bearer {}", desk.token))
        .header("cookie", "session=secret")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers().get(header::SET_COOKIE).is_none());
    let text = response.text().await.unwrap();
    assert_eq!(text, "cookie=false auth=false");
    server.abort();
}

#[tokio::test]
async fn the_shell_page_keeps_the_token_out_of_other_origins() {
    let desk = desk().await;
    let (status, page) = desk.call_anonymous("GET", "/", None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    if herdr_panels::paths::find_dist_dir().is_some() {
        let html = page["raw"].as_str().unwrap_or("");
        assert!(html.contains("__HERDR_PANELS_TOKEN__"), "{html}");
        assert!(html.contains(&desk.token));
    }
}

fn query_url(url: &str) -> String {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("url", url);
    query.finish()
}
