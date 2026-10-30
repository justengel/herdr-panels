use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context};
use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderValue, Response, StatusCode, Uri};
use axum::response::IntoResponse;
use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};

use crate::server::AppState;

const MAX_FILE: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AddressBar {
    pub show: bool,
    pub modify: bool,
    pub replace: bool,
}

impl Default for AddressBar {
    fn default() -> Self {
        Self {
            show: true,
            modify: false,
            replace: false,
        }
    }
}

impl<'de> Deserialize<'de> for AddressBar {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        match value {
            serde_json::Value::Bool(show) => Ok(AddressBar {
                show,
                modify: false,
                replace: false,
            }),
            serde_json::Value::Object(map) => {
                let replace = match map.get("replace") {
                    Some(serde_json::Value::Bool(replace)) => *replace,
                    Some(_) => {
                        return Err(de::Error::custom("addressBar.replace must be a boolean"))
                    }
                    None => false,
                };
                let show = match map.get("show") {
                    Some(serde_json::Value::Bool(show)) => *show && !replace,
                    Some(_) => return Err(de::Error::custom("addressBar.show must be a boolean")),
                    None => !replace,
                };
                let modify = match map.get("modify") {
                    Some(serde_json::Value::Bool(modify)) => *modify,
                    Some(_) => {
                        return Err(de::Error::custom("addressBar.modify must be a boolean"))
                    }
                    None => false,
                };
                Ok(AddressBar {
                    show,
                    modify,
                    replace,
                })
            }
            _ => Err(de::Error::custom(
                "addressBar must be a boolean or an object",
            )),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ViewOpen {
    File,
    Markdown,
    Html,
    Directory,
    Url,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PluginView {
    pub id: String,
    pub title: String,
    pub opens: Vec<ViewOpen>,
}

/// Host plugin API. Bump when open/config messages or opens kinds change incompatibly.
pub const PLUGIN_API_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PluginManifest {
    pub id: String,
    pub title: String,
    #[serde(default = "default_entry")]
    pub entry: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default = "default_api_version", rename = "apiVersion")]
    pub api_version: u32,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default, rename = "addressBar")]
    pub address_bar: AddressBar,
    pub views: Vec<PluginView>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub files: Vec<std::path::PathBuf>,
    #[serde(default)]
    pub commands: Vec<String>,
    /// When set, a panel of this plugin opens with Herdr control on.
    #[serde(default, rename = "controlDefault", skip_serializing_if = "is_false")]
    pub control_default: bool,
}

fn is_false(value: &bool) -> bool {
    !value
}

#[derive(Deserialize)]
struct ManifestDraft {
    id: String,
    title: String,
    #[serde(default = "default_entry")]
    entry: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default = "default_api_version", rename = "apiVersion")]
    api_version: u32,
    #[serde(default)]
    version: Option<String>,
    #[serde(default, rename = "addressBar")]
    address_bar: AddressBar,
    views: Option<Vec<ViewDraft>>,
    #[serde(default)]
    permissions: Vec<String>,
    #[serde(default)]
    files: Vec<String>,
    #[serde(default)]
    commands: Vec<String>,
    #[serde(default)]
    control: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct ViewDraft {
    #[serde(default)]
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    opens: Vec<String>,
}

fn default_entry() -> String {
    "index.html".into()
}

fn default_api_version() -> u32 {
    PLUGIN_API_VERSION
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
    let draft: ManifestDraft =
        serde_json::from_str(text).context("plugin.json is not valid JSON")?;
    validate_plugin_id(&draft.id)?;
    if draft.title.trim().is_empty() || draft.title.chars().count() > 80 {
        bail!("plugin title must be 1 to 80 characters");
    }
    if !is_relative_file(&draft.entry) {
        bail!("plugin entry must be a file inside the plugin directory");
    }
    if draft.api_version != PLUGIN_API_VERSION {
        bail!(
            "plugin {} needs apiVersion {}; desk is {}",
            draft.id,
            draft.api_version,
            PLUGIN_API_VERSION
        );
    }
    if draft
        .version
        .as_ref()
        .is_some_and(|value| value.chars().count() > 32)
    {
        bail!("plugin version is limited to 32 characters");
    }
    let views = normalize_views(&draft.id, &draft.title, draft.views)?;
    let grants =
        crate::plugin_grant::parse_grants(draft.permissions, draft.files, draft.commands)?;
    let control_default = control_default(draft.control, &grants.permissions)?;
    Ok(PluginManifest {
        id: draft.id,
        title: draft.title,
        entry: draft.entry,
        description: draft.description,
        api_version: draft.api_version,
        version: draft.version,
        address_bar: draft.address_bar,
        views,
        permissions: grants.permissions,
        files: grants.files,
        commands: grants.commands,
        control_default,
    })
}

fn control_default(
    value: Option<serde_json::Value>,
    permissions: &[String],
) -> anyhow::Result<bool> {
    match value {
        None | Some(serde_json::Value::Null) => Ok(false),
        Some(serde_json::Value::String(text)) if text == "default" => {
            if !permissions
                .iter()
                .any(|name| name == crate::plugin_grant::CONTROL)
            {
                bail!("\"control\": \"default\" requires the herdr:control permission");
            }
            Ok(true)
        }
        Some(_) => bail!("plugin control must be \"default\""),
    }
}

impl PluginManifest {
    pub fn wants_bridge(&self) -> bool {
        crate::plugin_grant::wants_bridge(&self.permissions)
    }
}

pub fn read_manifest_file(path: &Path) -> anyhow::Result<PluginManifest> {
    let text = fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    parse_manifest(&text)
}

pub fn load_installed(config_dir: &Path, id: &str) -> anyhow::Result<PluginManifest> {
    read_manifest_file(&plugins_dir(config_dir).join(id).join("plugin.json"))
}

pub fn bundled_welcome_manifest() -> anyhow::Result<PluginManifest> {
    if let Some(examples) = crate::paths::bundled_examples() {
        let path = examples.join("plugins").join("welcome").join("plugin.json");
        if path.is_file() {
            return read_manifest_file(&path);
        }
    }
    parse_manifest(crate::bundle::welcome_manifest()?)
}

/// Inject the prefix relay into every HTML entry, and the Herdr bridge when the plugin declared it.
pub fn prepare_entry(manifest: &PluginManifest, relative: &str, bytes: &[u8]) -> Vec<u8> {
    if relative != manifest.entry {
        return bytes.to_vec();
    }
    let ext = Path::new(relative).extension().and_then(|ext| ext.to_str());
    if ext != Some("html") && ext != Some("htm") {
        return bytes.to_vec();
    }
    let html = crate::content::inject_frame_keys(&String::from_utf8_lossy(bytes));
    if !manifest.wants_bridge() {
        return html.into_bytes();
    }
    crate::content::inject_bridge(&html).into_bytes()
}

fn normalize_views(
    plugin_id: &str,
    plugin_title: &str,
    views: Option<Vec<ViewDraft>>,
) -> anyhow::Result<Vec<PluginView>> {
    let Some(views) = views else {
        return Ok(vec![PluginView {
            id: plugin_id.to_string(),
            title: plugin_title.to_string(),
            opens: Vec::new(),
        }]);
    };
    if views.is_empty() {
        bail!("views must list at least one view");
    }
    let mut seen = Vec::new();
    let mut normalized = Vec::new();
    for draft in &views {
        let id = if draft.id.trim().is_empty() {
            if views.len() != 1 {
                bail!("each view needs an id");
            }
            plugin_id.to_string()
        } else {
            draft.id.clone()
        };
        validate_plugin_id(&id).map_err(|err| anyhow::anyhow!("view id: {err}"))?;
        if seen.contains(&id) {
            bail!("view id {id} is used more than once");
        }
        seen.push(id.clone());
        let title = if draft.title.trim().is_empty() {
            plugin_title.to_string()
        } else {
            draft.title.clone()
        };
        if title.trim().is_empty() || title.chars().count() > 80 {
            bail!("view title must be 1 to 80 characters");
        }
        let mut opens = Vec::new();
        for name in &draft.opens {
            let open = parse_open(name)?;
            if !opens.contains(&open) {
                opens.push(open);
            }
        }
        normalized.push(PluginView { id, title, opens });
    }
    Ok(normalized)
}

fn parse_open(name: &str) -> anyhow::Result<ViewOpen> {
    match name {
        "file" => Ok(ViewOpen::File),
        "markdown" => Ok(ViewOpen::Markdown),
        "html" => Ok(ViewOpen::Html),
        "directory" => Ok(ViewOpen::Directory),
        "url" => Ok(ViewOpen::Url),
        other => bail!("unknown view kind {other}. use file, markdown, html, directory, or url"),
    }
}

pub fn install_example_plugin(
    config_dir: &Path,
    examples: &Path,
    replace: bool,
) -> anyhow::Result<PluginManifest> {
    let source = examples.join("plugins").join("welcome");
    if !source.join("plugin.json").is_file() {
        bail!("the example plugin was not found");
    }
    install_plugin(config_dir, &source, replace)
}

pub fn install_bundled_example(config_dir: &Path, replace: bool) -> anyhow::Result<PluginManifest> {
    if let Some(examples) = crate::paths::bundled_examples() {
        return install_example_plugin(config_dir, &examples, replace);
    }
    let scratch = std::env::temp_dir().join(format!(
        "herdr-panels-welcome-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0)
    ));
    let result = (|| {
        crate::bundle::extract_example_plugin(&scratch)?;
        install_plugin(config_dir, &scratch, replace)
    })();
    let _ = fs::remove_dir_all(&scratch);
    result
}

pub fn uninstall_plugin(config_dir: &Path, id: &str) -> anyhow::Result<PluginManifest> {
    validate_plugin_id(id)?;
    let destination = plugins_dir(config_dir).join(id);
    if !destination.join("plugin.json").is_file() {
        bail!("plugin {id} is not installed");
    }
    let manifest = load_installed(config_dir, id)?;
    let root = plugins_dir(config_dir)
        .canonicalize()
        .context("plugins directory was not found")?;
    let resolved = destination
        .canonicalize()
        .with_context(|| format!("plugin {id} is not installed"))?;
    if resolved.parent() != Some(root.as_path()) {
        bail!("plugin {id} is not inside the plugins directory");
    }
    fs::remove_dir_all(&resolved).with_context(|| format!("removing {}", resolved.display()))?;
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
    let bytes = match load_installed(&state.config_dir, id) {
        Ok(manifest) => prepare_entry(&manifest, &relative, &bytes),
        Err(_) => bytes,
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
    fn address_bar_can_be_shown_and_modified() {
        let plain = parse_manifest(r#"{"id":"welcome","title":"Welcome"}"#).unwrap();
        assert!(plain.address_bar.show);
        assert!(!plain.address_bar.modify);

        let hidden =
            parse_manifest(r#"{"id":"welcome","title":"Welcome","addressBar":false}"#).unwrap();
        assert!(!hidden.address_bar.show);
        assert!(!hidden.address_bar.modify);

        let shown =
            parse_manifest(r#"{"id":"welcome","title":"Welcome","addressBar":true}"#).unwrap();
        assert!(shown.address_bar.show);
        assert!(!shown.address_bar.modify);

        let both = parse_manifest(
            r#"{"id":"welcome","title":"Welcome","addressBar":{"show":true,"modify":true}}"#,
        )
        .unwrap();
        assert!(both.address_bar.show);
        assert!(both.address_bar.modify);

        let hidden_until_asked =
            parse_manifest(r#"{"id":"welcome","title":"Welcome","addressBar":{"modify":true}}"#)
                .unwrap();
        assert!(hidden_until_asked.address_bar.show);
        assert!(hidden_until_asked.address_bar.modify);
        assert!(!plain.address_bar.replace);

        let own =
            parse_manifest(r#"{"id":"welcome","title":"Welcome","addressBar":{"replace":true}}"#)
                .unwrap();
        assert!(!own.address_bar.show);
        assert!(!own.address_bar.modify);
        assert!(own.address_bar.replace);

        let own_and_modify = parse_manifest(
            r#"{"id":"welcome","title":"Welcome","addressBar":{"show":true,"modify":true,"replace":true}}"#,
        )
        .unwrap();
        assert!(!own_and_modify.address_bar.show);
        assert!(own_and_modify.address_bar.modify);
        assert!(own_and_modify.address_bar.replace);

        assert!(
            parse_manifest(r#"{"id":"welcome","title":"Welcome","addressBar":"yes"}"#).is_err()
        );
        assert!(parse_manifest(
            r#"{"id":"welcome","title":"Welcome","addressBar":{"show":"yes"}}"#
        )
        .is_err());
        assert!(parse_manifest(
            r#"{"id":"welcome","title":"Welcome","addressBar":{"replace":"yes"}}"#
        )
        .is_err());
    }

    #[test]
    fn the_packaged_sample_plugin_installs_from_the_binary() {
        let root = std::env::temp_dir().join(format!("hwp-packaged-plugin-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let source = root.join("welcome");
        crate::bundle::extract_example_plugin(&source).unwrap();
        let manifest = install_plugin(&root.join("config"), &source, false).unwrap();
        assert_eq!(manifest.id, "welcome");
        assert!(root
            .join("config")
            .join("plugins")
            .join("welcome")
            .join("index.html")
            .is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn uninstall_removes_that_plugin_and_leaves_the_guide() {
        let root =
            std::env::temp_dir().join(format!("hwp-uninstall-plugin-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let config = root.join("config");
        let source = root.join("welcome");
        fs::create_dir_all(&source).unwrap();
        fs::write(
            source.join("plugin.json"),
            r#"{"id":"welcome","title":"Welcome","entry":"index.html"}"#,
        )
        .unwrap();
        fs::write(source.join("index.html"), "<p>Welcome</p>").unwrap();
        install_plugin(&config, &source, false).unwrap();
        let plugins = config.join("plugins");
        fs::write(plugins.join("README.md"), "guide").unwrap();
        fs::create_dir_all(plugins.join("other")).unwrap();
        fs::write(plugins.join("other").join("keep.txt"), "stay").unwrap();

        let manifest = uninstall_plugin(&config, "welcome").unwrap();
        assert_eq!(manifest.id, "welcome");
        assert_eq!(manifest.title, "Welcome");
        assert!(!plugins.join("welcome").exists());
        assert_eq!(
            fs::read_to_string(plugins.join("README.md")).unwrap(),
            "guide"
        );
        assert_eq!(
            fs::read_to_string(plugins.join("other").join("keep.txt")).unwrap(),
            "stay"
        );

        let missing = uninstall_plugin(&config, "welcome")
            .unwrap_err()
            .to_string();
        assert!(missing.contains("not installed"), "{missing}");
        let escaped = uninstall_plugin(&config, "../welcome")
            .unwrap_err()
            .to_string();
        assert!(
            escaped.contains("plugin id") || escaped.contains("lowercase"),
            "{escaped}"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_checkin_report_example_declares_file_and_control_permission() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("examples/plugins/checkin-report/plugin.json");
        let manifest = read_manifest_file(&path).unwrap();
        assert_eq!(manifest.id, "checkin-report");
        assert_eq!(
            manifest.permissions,
            vec!["files:read".to_string(), "herdr:control".to_string()]
        );
        assert_eq!(
            manifest.files,
            vec![PathBuf::from("/home/engel/projects/checkin/state")]
        );
        assert!(manifest.wants_bridge());
        assert!(!manifest.control_default);
    }

    #[test]
    fn control_default_opens_with_control_and_still_requires_the_permission() {
        let manifest = parse_manifest(
            r#"{"id":"checkin-report","title":"Check-in report","permissions":["herdr:control"],"control":"default"}"#,
        )
        .unwrap();
        assert!(manifest.control_default);
        let missing = parse_manifest(
            r#"{"id":"checkin-report","title":"Check-in report","control":"default"}"#,
        )
        .unwrap_err();
        assert!(missing.to_string().contains("herdr:control"));
        let other = parse_manifest(
            r#"{"id":"checkin-report","title":"Check-in report","permissions":["herdr:control"],"control":true}"#,
        )
        .unwrap_err();
        assert!(other.to_string().contains("default"));
    }

    #[test]
    fn the_desk_sample_asks_for_the_desk_and_for_external_links() {
        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("examples/plugins/desk-sample/plugin.json");
        let manifest = read_manifest_file(&path).unwrap();
        assert_eq!(manifest.id, "desk-sample");
        assert_eq!(
            manifest.permissions,
            vec![
                "panels:read".to_string(),
                "panels:control".to_string(),
                "links:open".to_string()
            ]
        );
        assert!(manifest.files.is_empty());
        let page = fs::read_to_string(path.parent().unwrap().join("index.html")).unwrap();
        assert!(page.contains("openPanel"));
        assert!(page.contains("openExternal"));
        assert!(page.contains("fillPanel"));
        assert!(page.contains("showDesk"));
        assert!(page.contains("setZoom"));
        assert!(page.contains("panel.summary"));
        assert!(!page.contains("sampleId"));
        assert!(!page.contains("scrollPane"));
        assert!(!page.contains("listPanes"));
        assert!(!page.contains("readPane"));
        assert!(!page.contains("sendText"));
        assert!(!page.contains("/home"));
    }

    #[test]
    fn permissions_are_rejected_when_the_manifest_is_wrong() {
        let plain = parse_manifest(r#"{"id":"welcome","title":"Welcome"}"#).unwrap();
        assert!(plain.permissions.is_empty());
        assert!(!plain.wants_bridge());
        let html = b"<html><head></head><body>Hi</body></html>";
        let plain_page = String::from_utf8(prepare_entry(&plain, "index.html", html)).unwrap();
        assert!(plain_page.contains("/* hwp-frame-keys */"));
        assert!(!plain_page.contains("herdrPanels"));

        let powered =
            parse_manifest(r#"{"id":"board","title":"Board","permissions":["herdr:read"]}"#)
                .unwrap();
        assert!(powered.wants_bridge());
        let served = String::from_utf8(prepare_entry(&powered, "index.html", html)).unwrap();
        assert!(served.contains("herdrPanels"));
        assert!(served.contains("focusPane"));
        assert!(served.contains("/* hwp-frame-keys */"));
        assert_eq!(served.matches("/* hwp-frame-keys */").count(), 1);
        assert_eq!(prepare_entry(&powered, "app.js", b"var x"), b"var x");

        let err = parse_manifest(r#"{"id":"board","title":"Board","permissions":["shell"]}"#)
            .unwrap_err();
        assert!(err.to_string().contains("unknown permission"));
    }

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

    #[test]
    fn a_plugin_view_declares_what_it_opens() {
        let plain = parse_manifest(r#"{"id":"welcome","title":"Welcome"}"#).unwrap();
        assert_eq!(plain.api_version, PLUGIN_API_VERSION);
        assert_eq!(plain.views.len(), 1);
        assert_eq!(plain.views[0].id, "welcome");
        assert!(plain.views[0].opens.is_empty());

        let named = parse_manifest(
            r#"{"id":"vim","title":"Vim","views":[{"title":"Vim","opens":["file","file"]}]}"#,
        )
        .unwrap();
        assert_eq!(named.views[0].id, "vim");
        assert_eq!(named.views[0].opens, vec![ViewOpen::File]);

        let docs = parse_manifest(
            r#"{"id":"docs","title":"Docs","views":[{"id":"read","opens":["markdown","directory"]},{"id":"home","title":"Library"}]}"#,
        )
        .unwrap();
        assert_eq!(
            docs.views[0].opens,
            vec![ViewOpen::Markdown, ViewOpen::Directory]
        );
        assert_eq!(docs.views[1].title, "Library");
        assert!(docs.views[1].opens.is_empty());

        assert!(parse_manifest(r#"{"id":"vim","title":"Vim","views":[]}"#).is_err());
        assert!(
            parse_manifest(r#"{"id":"vim","title":"Vim","views":[{"opens":["page"]}]}"#).is_err()
        );
        assert!(parse_manifest(
            r#"{"id":"docs","title":"Docs","views":[{"title":"A"},{"title":"B"}]}"#
        )
        .is_err());
    }

    #[test]
    fn the_example_plugin_is_installed_only_when_asked() {
        let root = std::env::temp_dir().join(format!("hwp-example-plugin-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let examples = root.join("examples");
        let source = examples.join("plugins").join("welcome");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(
            source.join("plugin.json"),
            r#"{"id":"welcome","title":"Welcome","entry":"index.html"}"#,
        )
        .unwrap();
        std::fs::write(source.join("index.html"), "<p>Welcome</p>").unwrap();
        let config = root.join("config");
        std::fs::create_dir_all(&config).unwrap();
        let manifest = install_example_plugin(&config, &examples, false).unwrap();
        assert_eq!(manifest.id, "welcome");
        assert_eq!(
            std::fs::read_to_string(config.join("plugins").join("welcome").join("index.html"))
                .unwrap(),
            "<p>Welcome</p>"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
