use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};

use crate::layout::{is_layout_id, LayoutDocument};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub active_layout: String,
    #[serde(default)]
    pub content_roots: Vec<PathBuf>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            active_layout: "side-by-side".into(),
            content_roots: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutSummary {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
}

pub fn layouts_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("layouts")
}

pub fn load_settings(config_dir: &Path) -> anyhow::Result<Settings> {
    let path = config_dir.join("settings.json");
    if !path.is_file() {
        return Ok(Settings::default());
    }
    let text = fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    let settings: Settings = serde_json::from_str(&text).context("settings.json is invalid")?;
    if !is_layout_id(&settings.active_layout) {
        bail!("settings activeLayout is invalid");
    }
    Ok(settings)
}

pub fn save_settings(config_dir: &Path, settings: &Settings) -> anyhow::Result<()> {
    if !is_layout_id(&settings.active_layout) {
        bail!("settings activeLayout is invalid");
    }
    let bytes = serde_json::to_vec_pretty(settings).context("encoding settings")?;
    write_atomic(&config_dir.join("settings.json"), &with_newline(bytes))
        .context("writing settings.json")
}

pub fn list_layouts(config_dir: &Path) -> anyhow::Result<Vec<LayoutSummary>> {
    let dir = layouts_dir(config_dir);
    let mut summaries = Vec::new();
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(summaries),
        Err(err) => return Err(err).context("reading layouts"),
    };
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let text =
            fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
        let doc =
            LayoutDocument::parse(&text).with_context(|| format!("parsing {}", path.display()))?;
        let stem = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or_default();
        if doc.id != stem {
            bail!("{} id is {}, expected {stem}", path.display(), doc.id);
        }
        summaries.push(LayoutSummary {
            id: doc.id,
            title: doc.title,
            description: doc.description,
        });
    }
    summaries.sort_by(|a, b| a.title.cmp(&b.title).then(a.id.cmp(&b.id)));
    Ok(summaries)
}

pub fn load_layout(config_dir: &Path, id: &str) -> anyhow::Result<LayoutDocument> {
    if !is_layout_id(id) {
        bail!("invalid layout id");
    }
    let path = layouts_dir(config_dir).join(format!("{id}.json"));
    let text = fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    let doc = LayoutDocument::parse(&text)?;
    if doc.id != id {
        bail!("layout file {id}.json declares id {}", doc.id);
    }
    Ok(doc)
}

pub fn save_layout(config_dir: &Path, doc: &LayoutDocument) -> anyhow::Result<()> {
    doc.validate()?;
    let path = layouts_dir(config_dir).join(format!("{}.json", doc.id));
    let bytes = serde_json::to_vec_pretty(doc).context("encoding layout")?;
    write_atomic(&path, &with_newline(bytes)).with_context(|| format!("writing {}", path.display()))
}

fn with_newline(mut bytes: Vec<u8>) -> Vec<u8> {
    if !bytes.ends_with(b"\n") {
        bytes.push(b'\n');
    }
    bytes
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    if fs::rename(&tmp, path).is_ok() {
        return Ok(());
    }
    let _ = fs::remove_file(path);
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = fs::remove_file(&tmp);
            Err(err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_layout() {
        let dir = std::env::temp_dir().join(format!(
            "hwp-store-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(dir.join("layouts")).unwrap();
        let doc = LayoutDocument::parse(
            r#"{
              "id": "side-by-side",
              "title": "Side by side",
              "root": {
                "type": "split",
                "direction": "row",
                "ratio": 0.5,
                "first": {"type": "panel", "id": "term", "panel": {"type": "herdr"}},
                "second": {"type": "panel", "id": "notes", "panel": {"type": "markdown", "path": "notes/welcome.md"}}
              }
            }"#,
        )
        .unwrap();
        save_layout(&dir, &doc).unwrap();
        let loaded = load_layout(&dir, "side-by-side").unwrap();
        assert_eq!(loaded, doc);
        let _ = fs::remove_dir_all(&dir);
    }
}
