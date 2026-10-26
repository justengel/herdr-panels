//! A pass that lets one frame read its own files.
//!
//! The viewer token stays in the parent page. A sandboxed frame cannot send
//! it, and putting it in the frame URL would hand it to that page. The parent
//! mints a pass for one content directory or one loopback proxy target. The
//! frame's address is `/gate/<pass>/...`, so relative files keep the pass.
//! The pass cannot call the API.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::http::Method;

const MAX_PASSES: usize = 256;
const PASS_TTL: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone)]
pub struct FramePasses {
    inner: Arc<Mutex<Vec<StoredPass>>>,
}

struct StoredPass {
    secret: String,
    scope: String,
    exact: bool,
    created: Instant,
}

#[derive(Clone)]
pub struct ActiveGate {
    pub secret: String,
}

pub struct GatePath {
    pub secret: String,
    pub path: String,
}

impl FramePasses {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn issue(&self, resource: &str) -> Result<String, &'static str> {
        let scoped = scope_resource(resource)?;
        let secret = crate::auth::random_secret().map_err(|_| "could not create a pass")?;
        let mut passes = self.inner.lock().unwrap_or_else(|err| err.into_inner());
        let now = Instant::now();
        passes.retain(|pass| now.saturating_duration_since(pass.created) < PASS_TTL);
        if passes.len() >= MAX_PASSES {
            let extra = passes.len() + 1 - MAX_PASSES;
            passes.drain(0..extra);
        }
        passes.push(StoredPass {
            secret: secret.clone(),
            scope: scoped.scope,
            exact: scoped.exact,
            created: now,
        });
        let mut src = format!("/gate/{secret}{}", scoped.raw_path);
        if !scoped.query.is_empty() {
            src.push('?');
            src.push_str(&scoped.query);
        }
        Ok(src)
    }

    pub fn authorize(&self, secret: &str, path: &str, method: &Method) -> bool {
        if method != Method::GET && method != Method::HEAD {
            return false;
        }
        let normalized = normalize_path(path);
        if !path_is_safe(&normalized) {
            return false;
        }
        let passes = self.inner.lock().unwrap_or_else(|err| err.into_inner());
        let now = Instant::now();
        let mut matched = None;
        for pass in passes.iter() {
            if crate::auth::tokens_match(&pass.secret, secret) {
                matched = Some((pass.scope.clone(), pass.exact, pass.created));
            }
        }
        let Some((scope, exact, created)) = matched else {
            return false;
        };
        if now.saturating_duration_since(created) >= PASS_TTL {
            return false;
        }
        covers(&scope, exact, &normalized)
    }
}

struct Scoped {
    scope: String,
    exact: bool,
    raw_path: String,
    query: String,
}

fn scope_resource(resource: &str) -> Result<Scoped, &'static str> {
    let resource = resource.trim();
    if resource.is_empty()
        || !resource.starts_with('/')
        || resource.len() > 2048
        || resource.contains('\\')
        || resource.contains('\0')
        || resource.chars().any(|ch| ch.is_control())
    {
        return Err("path is invalid");
    }
    let (raw_path, query) = match resource.split_once('?') {
        Some((path, query)) => (path, query),
        None => (resource, ""),
    };
    let raw_path = raw_path.split('#').next().unwrap_or(raw_path);
    if raw_path.contains("//") || !path_is_safe(raw_path) {
        return Err("path is invalid");
    }
    let decoded = percent_decode(raw_path);
    if !path_is_safe(&decoded) {
        return Err("path is invalid");
    }
    let normalized = normalize_path(&decoded);
    if normalized.starts_with("/proxy/") {
        let scope = proxy_scope(&normalized)?;
        return Ok(Scoped {
            scope,
            exact: false,
            raw_path: raw_path.to_string(),
            query: query.to_string(),
        });
    }
    if normalized.starts_with("/content/") {
        let (scope, exact) = content_scope(&normalized)?;
        return Ok(Scoped {
            scope,
            exact,
            raw_path: raw_path.to_string(),
            query: query.to_string(),
        });
    }
    Err("a pass only covers content and proxy")
}

fn content_scope(path: &str) -> Result<(String, bool), &'static str> {
    let rest = path
        .strip_prefix("/content/")
        .ok_or("content path is invalid")?;
    if rest.is_empty() || rest.ends_with('/') {
        return Err("content path is invalid");
    }
    let Some(index) = path.rfind('/') else {
        return Err("content path is invalid");
    };
    if index <= "/content".len() {
        return Ok((path.to_string(), true));
    }
    Ok((format!("{}/", &path[..index]), false))
}

fn proxy_scope(path: &str) -> Result<String, &'static str> {
    let rest = path
        .strip_prefix("/proxy/")
        .ok_or("proxy path is invalid")?;
    let mut parts = rest.splitn(3, '/');
    let scheme = parts.next().unwrap_or("");
    let host = parts.next().unwrap_or("");
    if (scheme != "http" && scheme != "https")
        || host.is_empty()
        || !crate::paths::is_loopback_authority(host)
    {
        return Err("proxy path is invalid");
    }
    Ok(format!("/proxy/{scheme}/{host}/"))
}

fn covers(scope: &str, exact: bool, path: &str) -> bool {
    if exact {
        return path == scope;
    }
    path == scope.trim_end_matches('/') || path.starts_with(scope)
}

fn path_is_safe(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && !path.contains('\0')
        && !path.split('/').any(|part| part == "..")
}

fn normalize_path(path: &str) -> String {
    let decoded = percent_decode(path);
    let Some(rest) = decoded.strip_prefix("/proxy/") else {
        return decoded;
    };
    let mut parts = rest.splitn(3, '/');
    let scheme = parts.next().unwrap_or("").to_ascii_lowercase();
    let host = parts.next().unwrap_or("").to_ascii_lowercase();
    match parts.next() {
        Some(tail) => format!("/proxy/{scheme}/{host}/{tail}"),
        None if decoded.ends_with('/') => format!("/proxy/{scheme}/{host}/"),
        None => format!("/proxy/{scheme}/{host}"),
    }
}

pub fn parse_gate(path: &str) -> Option<GatePath> {
    let rest = path.strip_prefix("/gate/")?;
    let (secret, tail) = rest.split_once('/')?;
    if secret.len() != 64 || !secret.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    if !(tail.starts_with("content/") || tail.starts_with("proxy/")) || !path_is_safe(tail) {
        return None;
    }
    Some(GatePath {
        secret: secret.to_string(),
        path: format!("/{tail}"),
    })
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
