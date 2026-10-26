use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context};
use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderValue, Response, StatusCode, Uri};
use axum::response::IntoResponse;
use serde::{Deserialize, Serialize};

use crate::server::AppState;

const MAX_FILE: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PluginManifest {
    pub id: String,
    pub title: String,
    #[serde(default = "default_entry")]
    pub entry: String,
    #[serde(default)]
    pub description: Option<String>,
}

fn default_entry() -> String {
    "index.html".into()
}

pub fn plugins_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("plugins")
}

pub fn validate_plugin_id(id: &str) -> anyhow::Result<()> {
    if id.is_empty() || id.len() > 64 {
        bail!("plugin id must be 1 to 64 characters");
    }
    if id.starts_with('-') || id.ends_with('-') {
        bail!("plugin id cannot start or end with a hyphen");
    }
    if !id
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
    {
        bail!("plugin id uses lowercase letters, digits, and hyphens");
    }
    Ok(())
}

fn is_relative_file(value: &str) -> bool {
    let value = value.trim();
    if value.is_empty() || value.contains('\0') || value.starts_with('/') || value.starts_with('\\')
    {
        return false;
    }
    if let Some((prefix, _)) = value.split_once(':') {
        if prefix.len() == 1 && prefix.chars().all(|ch| ch.is_ascii_alphabetic()) {
            return false;
        }
    }
    !value.split(['/', '\\']).any(|part| part == "..")
}

pub fn list_plugins(config_dir: &Path) -> anyhow::Result<Vec<PluginManifest>> {
    let root = plugins_dir(config_dir);
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut plugins = Vec::new();
    for entry in fs::read_dir(&root).with_context(|| format!("reading {}", root.display()))? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let manifest_path = entry.path().join("plugin.json");
        if !manifest_path.is_file() {
            continue;
        }
        let text = fs::read_to_string(&manifest_path)
            .with_context(|| format!("reading {}", manifest_path.display()))?;
        let manifest = parse_manifest(&text)?;
        if manifest.id != entry.file_name().to_string_lossy() {
            bail!(
                "plugin {} is in a directory named {}",
                manifest.id,
                entry.file_name().to_string_lossy()
            );
        }
        plugins.push(manifest);
    }
    plugins.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(plugins)
}

pub fn parse_manifest(text: &str) -> anyhow::Result<PluginManifest> {
    let manifest: PluginManifest =
        serde_json::from_str(text).context("plugin.json is not valid JSON")?;
    validate_plugin_id(&manifest.id)?;
    if manifest.title.trim().is_empty() || manifest.title.chars().count() > 80 {
        bail!("plugin title must be 1 to 80 characters");
    }
    if !is_relative_file(&manifest.entry) {
        bail!("plugin entry must be a file inside the plugin directory");
    }
    Ok(manifest)
}

pub fn install_plugin(
    config_dir: &Path,
    source: &Path,
    replace: bool,
) -> anyhow::Result<PluginManifest> {
    let manifest_path = source.join("plugin.json");
    let text = fs::read_to_string(&manifest_path)
        .with_context(|| format!("reading {}", manifest_path.display()))?;
    let manifest = parse_manifest(&text)?;
    let destination = plugins_dir(config_dir).join(&manifest.id);
    if destination.exists() {
        if !replace {
            bail!(
                "plugin {} is already installed. Pass --replace to overwrite it",
                manifest.id
            );
        }
        fs::remove_dir_all(&destination)
            .with_context(|| format!("removing {}", destination.display()))?;
    }
    copy_tree(source, &destination)?;
    Ok(manifest)
}

fn copy_tree(src: &Path, dst: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src).with_context(|| format!("reading {}", src.display()))? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_tree(&entry.path(), &to)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &to)
                .with_context(|| format!("copying {}", entry.path().display()))?;
        }
    }
    Ok(())
}

pub fn plugin_file(config_dir: &Path, id: &str, relative: &str) -> anyhow::Result<PathBuf> {
    validate_plugin_id(id)?;
    if !is_relative_file(relative) {
        bail!("plugin file path is invalid");
    }
    let root = plugins_dir(config_dir)
        .join(id)
        .canonicalize()
        .context("plugin was not found")?;
    let path = root
        .join(relative)
        .canonicalize()
        .context("plugin file was not found")?;
    if !path.starts_with(&root) {
        bail!("plugin file path is invalid");
    }
    if !path.is_file() {
        bail!("plugin file was not found");
    }
    Ok(path)
}

pub async fn handle(State(state): State<AppState>, uri: Uri) -> Response<Body> {
    let Some(requested) = uri.path().strip_prefix("/plugins/") else {
        return (StatusCode::NOT_FOUND, "missing plugin path").into_response();
    };
    let requested = percent_decode(requested);
    let (id, relative) = match requested.split_once('/') {
        Some((id, rest)) if !rest.is_empty() => (id, rest.to_string()),
        Some((id, _)) => match entry_for(&state.config_dir, id) {
            Ok(entry) => (id, entry),
            Err(err) => return (StatusCode::NOT_FOUND, err.to_string()).into_response(),
        },
        None => match entry_for(&state.config_dir, &requested) {
            Ok(entry) => (requested.as_str(), entry),
            Err(err) => return (StatusCode::NOT_FOUND, err.to_string()).into_response(),
        },
    };
    let path = match plugin_file(&state.config_dir, id, &relative) {
        Ok(path) => path,
        Err(err) => {
            let status = if err.to_string().contains("not found") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::BAD_REQUEST
            };
            return (status, err.to_string()).into_response();
        }
    };
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) if bytes.len() > MAX_FILE => {
            return (StatusCode::PAYLOAD_TOO_LARGE, "file is larger than 8 MB").into_response();
        }
        Ok(bytes) => bytes,
        Err(err) => return (StatusCode::NOT_FOUND, err.to_string()).into_response(),
    };
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    let mut response = Response::new(Body::from(bytes));
    if let Ok(value) = HeaderValue::from_str(mime.essence_str()) {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    response
}

fn entry_for(config_dir: &Path, id: &str) -> anyhow::Result<String> {
    let text = fs::read_to_string(plugins_dir(config_dir).join(id).join("plugin.json"))
        .context("plugin was not found")?;
    Ok(parse_manifest(&text)?.entry)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_requires_a_safe_id_and_entry() {
        let manifest =
            parse_manifest(r#"{"id":"welcome","title":"Welcome","entry":"index.html"}"#).unwrap();
        assert_eq!(manifest.id, "welcome");
        assert!(parse_manifest(r#"{"id":"../x","title":"Bad"}"#).is_err());
        assert!(parse_manifest(r#"{"id":"ok","title":"Ok","entry":"../secret"}"#).is_err());
    }

    #[test]
    fn a_plugin_file_cannot_leave_its_directory() {
        let root = std::env::temp_dir().join(format!("hwp-plugin-escape-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let plugin = root.join("plugins").join("welcome");
        let outside = root.join("outside");
        std::fs::create_dir_all(&plugin).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(plugin.join("index.html"), "ok").unwrap();
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        let link = plugin.join("escape");
        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd")
                .args([
                    "/c",
                    "mklink",
                    "/J",
                    &link.display().to_string(),
                    &outside.display().to_string(),
                ])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .expect("creating a junction");
            assert!(status.success(), "creating a junction");
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).expect("creating a symlink");
        let err = plugin_file(&root, "welcome", "escape/secret.txt").unwrap_err();
        let message = err.to_string();
        assert!(
            message.contains("invalid") || message.contains("not found"),
            "{message}"
        );
        assert!(plugin_file(&root, "welcome", "index.html").is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }
}
