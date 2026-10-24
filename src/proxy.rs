use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, Method, Response, StatusCode, Uri};
use serde_json::json;

use crate::paths::is_loopback_authority;
use crate::server::AppState;

const MAX_BODY: usize = 20 * 1024 * 1024;

struct Target {
    scheme: String,
    authority: String,
    tail: String,
}

pub async fn handle(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response<Body> {
    if !matches!(
        method.as_str(),
        "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE"
    ) {
        return text(StatusCode::METHOD_NOT_ALLOWED, "method is not proxied");
    }
    let Some(target) = parse_proxy_path(uri.path()) else {
        return text(
            StatusCode::BAD_REQUEST,
            "proxy only forwards http(s) to localhost",
        );
    };
    if body.len() > MAX_BODY {
        return text(StatusCode::PAYLOAD_TOO_LARGE, "request body is too large");
    }

    let upstream = upstream_url(&target, uri.query());
    let Ok(req_method) = reqwest::Method::from_bytes(method.as_str().as_bytes()) else {
        return text(StatusCode::METHOD_NOT_ALLOWED, "method is not proxied");
    };
    let mut builder = state.http.request(req_method, &upstream);
    for name in [
        "accept",
        "accept-language",
        "content-type",
        "cookie",
        "authorization",
        "range",
    ] {
        if let Some(value) = headers.get(name) {
            builder = builder.header(name, value);
        }
    }
    if !body.is_empty() && method != Method::GET && method != Method::HEAD {
        builder = builder.body(body.to_vec());
    }

    let response = match builder.send().await {
        Ok(response) => response,
        Err(err) => {
            return text(
                StatusCode::BAD_GATEWAY,
                &format!("upstream unreachable: {err}"),
            )
        }
    };
    let status =
        StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let upstream_headers = response.headers().clone();
    let bytes = match response.bytes().await {
        Ok(bytes) if bytes.len() > MAX_BODY => {
            return text(StatusCode::BAD_GATEWAY, "upstream response is too large");
        }
        Ok(bytes) => bytes,
        Err(err) => {
            return text(
                StatusCode::BAD_GATEWAY,
                &format!("upstream read failed: {err}"),
            )
        }
    };

    let content_type = upstream_headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let prefix = format!("/proxy/{}/{}", target.scheme, target.authority);
    let origin = format!("{}://{}", target.scheme, target.authority);
    let body_bytes = if content_type.starts_with("text/html") {
        inject_base(&bytes, &prefix, &target.tail)
    } else {
        bytes.to_vec()
    };

    let mut response = Response::builder().status(status);
    if let Some(headers_mut) = response.headers_mut() {
        copy_header(&upstream_headers, headers_mut, header::CONTENT_TYPE);
        copy_header(&upstream_headers, headers_mut, header::CACHE_CONTROL);
        copy_header(&upstream_headers, headers_mut, header::ETAG);
        copy_header(&upstream_headers, headers_mut, header::ACCEPT_RANGES);
        if let Some(location) = upstream_headers
            .get(header::LOCATION)
            .and_then(|v| v.to_str().ok())
        {
            let rewritten = rewrite_location(location, &origin, &prefix);
            if let Ok(value) = HeaderValue::from_str(&rewritten) {
                headers_mut.insert(header::LOCATION, value);
            }
        }
        if let Some(set_cookie) = upstream_headers.get(header::SET_COOKIE) {
            headers_mut.insert(header::SET_COOKIE, set_cookie.clone());
        }
    }
    response
        .body(Body::from(body_bytes))
        .unwrap_or_else(|_| text(StatusCode::INTERNAL_SERVER_ERROR, "proxy response failed"))
}

fn parse_proxy_path(path: &str) -> Option<Target> {
    let rest = path.strip_prefix("/proxy/")?;
    if rest.is_empty() {
        return None;
    }
    let mut parts = rest.splitn(3, '/');
    let scheme = parts.next()?.to_ascii_lowercase();
    let authority = parts.next()?.to_string();
    let tail = parts.next().unwrap_or("").to_string();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    if authority.is_empty() || !is_loopback_authority(&authority) {
        return None;
    }
    if tail.contains('\\') || tail.contains('\0') {
        return None;
    }
    Some(Target {
        scheme,
        authority,
        tail,
    })
}

fn upstream_url(target: &Target, query: Option<&str>) -> String {
    let path = if target.tail.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", target.tail)
    };
    let mut url = format!("{}://{}{}", target.scheme, target.authority, path);
    if let Some(query) = query {
        if !query.is_empty() {
            url.push('?');
            url.push_str(query);
        }
    }
    url
}

fn rewrite_location(location: &str, origin: &str, prefix: &str) -> String {
    if let Some(rest) = location.strip_prefix(origin) {
        if rest.is_empty() {
            return format!("{prefix}/");
        }
        return format!("{prefix}{rest}");
    }
    location.to_string()
}

fn inject_base(bytes: &[u8], prefix: &str, tail: &str) -> Vec<u8> {
    let Ok(html) = std::str::from_utf8(bytes) else {
        return bytes.to_vec();
    };
    if html.to_ascii_lowercase().contains("<base") {
        return html.as_bytes().to_vec();
    }
    let base = format!("<base href=\"{}\">", base_href(prefix, tail));
    let lower = html.to_ascii_lowercase();
    if let Some(start) = lower.find("<head") {
        if let Some(end) = lower[start..].find('>') {
            let at = start + end + 1;
            let mut out = String::with_capacity(html.len() + base.len());
            out.push_str(&html[..at]);
            out.push_str(&base);
            out.push_str(&html[at..]);
            return out.into_bytes();
        }
    }
    format!("{base}{html}").into_bytes()
}

fn base_href(prefix: &str, tail: &str) -> String {
    if tail.is_empty() || tail.ends_with('/') {
        format!("{prefix}/{tail}")
    } else {
        match tail.rfind('/') {
            Some(index) => format!("{prefix}/{}/", tail[..=index].trim_end_matches('/')),
            None => format!("{prefix}/"),
        }
    }
}

fn copy_header(from: &HeaderMap, to: &mut HeaderMap, name: header::HeaderName) {
    if let Some(value) = from.get(&name) {
        to.insert(name, value.clone());
    }
}

fn text(status: StatusCode, message: &str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({"error": message}).to_string()))
        .expect("proxy error response")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_loopback_targets() {
        assert!(parse_proxy_path("/proxy/http/127.0.0.1:3000/index.html").is_some());
        assert!(parse_proxy_path("/proxy/http/localhost:8080/").is_some());
        assert!(parse_proxy_path("/proxy/https/example.com/").is_none());
        assert!(parse_proxy_path("/proxy/file/127.0.0.1/secret").is_none());
    }

    #[test]
    fn rewrites_redirects_and_base() {
        assert_eq!(
            rewrite_location(
                "http://127.0.0.1:3000/assets/app.js",
                "http://127.0.0.1:3000",
                "/proxy/http/127.0.0.1:3000"
            ),
            "/proxy/http/127.0.0.1:3000/assets/app.js"
        );
        let html = inject_base(
            b"<html><head><title>x</title></head><body></body></html>",
            "/proxy/http/127.0.0.1:3000",
            "",
        );
        let text = String::from_utf8(html).unwrap();
        assert!(text.contains("<base href=\"/proxy/http/127.0.0.1:3000/\">"));
    }
}
