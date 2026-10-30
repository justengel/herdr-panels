use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, Response, StatusCode, Uri};
use axum::response::IntoResponse;

use crate::server::AppState;

const FRAME_KEYS: &str = include_str!("../assets/frame-keys.js");
const FRAME_SELECT: &str = include_str!("../assets/frame-select.js");
const BRIDGE: &str = include_str!("../assets/panel-bridge.js");
const MAX_FILE: usize = 8 * 1024 * 1024;

pub async fn handle(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response<Body> {
    let Some(requested) = uri.path().strip_prefix("/content/") else {
        return (StatusCode::NOT_FOUND, "missing content path").into_response();
    };
    let requested = percent_decode(requested);
    if requested.is_empty() {
        return (StatusCode::BAD_REQUEST, "missing content path").into_response();
    }
    let requested_session = headers
        .get("x-herdr-session")
        .and_then(|value| value.to_str().ok());
    let link = match state.sessions.open(requested_session) {
        Ok(link) => link,
        Err(err) => return (StatusCode::BAD_REQUEST, err).into_response(),
    };
    let roots = crate::server::allowed_roots(&state, &link).await;
    let path = match crate::paths::resolve_content(&state.config_dir, &roots, &requested) {
        Ok(path) => path,
        Err(err) => {
            let status = if err.contains("not found") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::BAD_REQUEST
            };
            return (status, err).into_response();
        }
    };
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) if bytes.len() > MAX_FILE => {
            return (StatusCode::PAYLOAD_TOO_LARGE, "file is larger than 8 MB").into_response();
        }
        Ok(bytes) => bytes,
        Err(err) => return (StatusCode::NOT_FOUND, err.to_string()).into_response(),
    };

    let inject = uri.query().is_some_and(|query| {
        query.split('&').any(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            percent_decode(key) == "bridge" && percent_decode(value) == "1"
        })
    });
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    let is_html = mime.essence_str() == "text/html"
        || path.extension().and_then(|ext| ext.to_str()) == Some("html");
    if inject && !is_html {
        return (
            StatusCode::BAD_REQUEST,
            "bridge injection is only for html files",
        )
            .into_response();
    }

    let (body, content_type) = if inject {
        let html = String::from_utf8_lossy(&bytes);
        (
            inject_bridge(&html).into_bytes(),
            "text/html; charset=utf-8".to_string(),
        )
    } else {
        (bytes, mime.to_string())
    };

    let mut response = Response::new(Body::from(body));
    if let Ok(value) = HeaderValue::from_str(&content_type) {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

/// Let a plugin or HTML panel report the prefix key. The page still receives every other key.
pub fn inject_frame_keys(html: &str) -> String {
    if html.contains("/* hwp-frame-keys */") {
        return html.to_string();
    }
    insert_script(html, &format!("<script>{FRAME_KEYS}</script>"))
}

pub fn inject_bridge(html: &str) -> String {
    let html = inject_frame_keys(html);
    if html.contains("/* hwp-bridge */") {
        return html;
    }
    let script = format!("<script>{FRAME_SELECT}\n{BRIDGE}</script>");
    insert_script(&html, &script)
}

fn insert_script(html: &str, script: &str) -> String {
    let lower = html.to_ascii_lowercase();
    if let Some(start) = lower.find("<head") {
        if let Some(end) = lower[start..].find('>') {
            let at = start + end + 1;
            let mut out = String::with_capacity(html.len() + script.len());
            out.push_str(&html[..at]);
            out.push_str(script);
            out.push_str(&html[at..]);
            return out;
        }
    }
    format!("{script}{html}")
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                if let Ok(byte) = u8::from_str_radix(
                    std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or(""),
                    16,
                ) {
                    out.push(byte);
                    index += 3;
                    continue;
                }
                out.push(b'%');
                index += 1;
            }
            b'+' => {
                out.push(b'+');
                index += 1;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}
