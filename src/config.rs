use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Context;

use crate::paths::{app_config_dir, bundled_examples};
use crate::store::Settings;

pub fn prepare_config_dir(flag: Option<PathBuf>) -> anyhow::Result<PathBuf> {
    let dir = match flag {
        Some(path) => path,
        None => app_config_dir()?,
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
        copy_tree(&examples, &dir)?;
    }
    if !dir.join("settings.json").is_file() {
        let settings = Settings::default();
        crate::store::save_settings(&dir, &settings)?;
    }
    Ok(dir)
}

fn copy_tree(src: &Path, dst: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src).with_context(|| format!("reading {}", src.display()))? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_tree(&entry.path(), &to)?;
        } else if kind.is_file() && !to.exists() {
            fs::copy(entry.path(), &to)
                .with_context(|| format!("copying {}", entry.path().display()))?;
        }
    }
    Ok(())
}
