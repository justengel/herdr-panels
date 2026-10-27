use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Context;

use crate::paths::{app_config_dir, bundled_examples};
use crate::store::Settings;

pub fn prepare_config_dir(flag: Option<PathBuf>) -> anyhow::Result<PathBuf> {
    let dir = match flag {
        Some(path) => path,
        None => match std::env::var_os("HERDR_PANELS_CONFIG") {
            Some(value) if !value.is_empty() => PathBuf::from(value),
            _ => app_config_dir()?,
        },
    };
    fs::create_dir_all(dir.join("layouts"))
        .with_context(|| format!("creating {}", dir.display()))?;

    let layouts = dir.join("layouts");
    let empty = fs::read_dir(&layouts)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(true);
    if let Some(examples) = bundled_examples() {
        if empty {
            tracing::info!("seeding config from {}", examples.display());
        }
        seed_examples(&examples, &dir)?;
    }
    if !dir.join("settings.json").is_file() {
        let settings = Settings::default();
        crate::store::save_settings(&dir, &settings)?;
    }
    Ok(dir)
}

pub fn seed_examples(examples: &Path, dir: &Path) -> anyhow::Result<()> {
    copy_tree(examples, dir)
}

fn copy_tree(src: &Path, dst: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src).with_context(|| format!("reading {}", src.display()))? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            if entry.path().join("plugin.json").is_file() {
                continue;
            }
            copy_tree(&entry.path(), &to)?;
        } else if kind.is_file() && !to.exists() {
            fs::copy(entry.path(), &to)
                .with_context(|| format!("copying {}", entry.path().display()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeding_copies_layouts_and_leaves_the_example_plugin_out() {
        let root = std::env::temp_dir().join(format!("hwp-seed-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let examples = root.join("examples");
        fs::create_dir_all(examples.join("layouts")).unwrap();
        fs::write(examples.join("layouts").join("desk.json"), "{}").unwrap();
        fs::create_dir_all(examples.join("plugins").join("welcome")).unwrap();
        fs::write(examples.join("plugins").join("README.md"), "guide").unwrap();
        fs::write(
            examples.join("plugins").join("welcome").join("plugin.json"),
            r#"{"id":"welcome","title":"Welcome"}"#,
        )
        .unwrap();
        fs::write(
            examples.join("plugins").join("welcome").join("index.html"),
            "<p>Hi</p>",
        )
        .unwrap();
        let config = root.join("config");
        seed_examples(&examples, &config).unwrap();
        assert!(config.join("layouts").join("desk.json").is_file());
        assert_eq!(
            fs::read_to_string(config.join("plugins").join("README.md")).unwrap(),
            "guide"
        );
        assert!(!config.join("plugins").join("welcome").exists());
        let _ = fs::remove_dir_all(&root);
    }
}
