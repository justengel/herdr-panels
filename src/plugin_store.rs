//! The permission set install accepted, stored outside the plugin folder.
//! A copied plugin directory does not grant anything until install writes this file.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

pub const FILE_NAME: &str = "plugin-grants.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredGrant {
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub files: Vec<PathBuf>,
    #[serde(default)]
    pub commands: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct GrantFile {
    #[serde(default)]
    plugins: BTreeMap<String, StoredGrant>,
}

pub fn grant_path(config_dir: &Path) -> PathBuf {
    config_dir.join(FILE_NAME)
}

pub fn load(config_dir: &Path) -> Result<BTreeMap<String, StoredGrant>> {
    let path = grant_path(config_dir);
    if !path.is_file() {
        return Ok(BTreeMap::new());
    }
    let text = fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    let file: GrantFile =
        serde_json::from_str(&text).context("plugin grants are not valid JSON")?;
    Ok(file.plugins)
}

pub fn get(config_dir: &Path, id: &str) -> Result<Option<StoredGrant>> {
    Ok(load(config_dir)?.get(id).cloned())
}

pub fn record(config_dir: &Path, id: &str, grant: StoredGrant) -> Result<()> {
    let mut plugins = load(config_dir).unwrap_or_default();
    plugins.insert(id.to_string(), grant);
    write_all(config_dir, &plugins)
}

pub fn remove(config_dir: &Path, id: &str) -> Result<()> {
    let mut plugins = load(config_dir).unwrap_or_default();
    plugins.remove(id);
    write_all(config_dir, &plugins)
}

/// A call is allowed only when both the stored grant and the live manifest allow it.
pub fn overlap(
    granted: &StoredGrant,
    permissions: &[String],
    files: &[PathBuf],
    commands: &[String],
) -> StoredGrant {
    StoredGrant {
        permissions: permissions
            .iter()
            .filter(|name| granted.permissions.iter().any(|have| have == *name))
            .cloned()
            .collect(),
        files: files
            .iter()
            .filter(|path| granted.files.iter().any(|have| have == *path))
            .cloned()
            .collect(),
        commands: commands
            .iter()
            .filter(|name| granted.commands.iter().any(|have| have == *name))
            .cloned()
            .collect(),
    }
}

fn write_all(config_dir: &Path, plugins: &BTreeMap<String, StoredGrant>) -> Result<()> {
    fs::create_dir_all(config_dir)?;
    let path = grant_path(config_dir);
    let body = serde_json::to_vec_pretty(&GrantFile {
        plugins: plugins.clone(),
    })
    .context("plugin grants could not be encoded")?;
    let tmp = path.with_extension("json.tmp");
    {
        let mut file =
            fs::File::create(&tmp).with_context(|| format!("writing {}", tmp.display()))?;
        file.write_all(&body)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, &path).with_context(|| format!("replacing {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_copied_manifest_gains_only_what_install_recorded() {
        let dir = std::env::temp_dir().join(format!(
            "herdr-grants-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert!(get(&dir, "demo").unwrap().is_none());
        record(
            &dir,
            "demo",
            StoredGrant {
                permissions: vec!["browser:read".into(), "files:read".into()],
                files: vec![PathBuf::from("/tmp/shots")],
                commands: vec!["ai-diff".into()],
            },
        )
        .unwrap();
        let granted = get(&dir, "demo").unwrap().unwrap();
        let live_permissions = vec![
            "browser:read".into(),
            "browser:control".into(),
            "files:read".into(),
        ];
        let live_files = vec![PathBuf::from("/tmp/shots"), PathBuf::from("/tmp/other")];
        let live_commands = vec!["ai-diff".into(), "rm".into()];
        let allowed = overlap(&granted, &live_permissions, &live_files, &live_commands);
        assert_eq!(
            allowed.permissions,
            vec!["browser:read".to_string(), "files:read".to_string()]
        );
        assert_eq!(allowed.files, vec![PathBuf::from("/tmp/shots")]);
        assert_eq!(allowed.commands, vec!["ai-diff".to_string()]);
        remove(&dir, "demo").unwrap();
        assert!(get(&dir, "demo").unwrap().is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
