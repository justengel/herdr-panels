use std::ffi::OsStr;
use std::fs;
use std::path::{Component, Path};

use anyhow::Context;
use include_dir::{include_dir, Dir};

static EXAMPLES: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/examples");

#[cfg(embedded_dist)]
static DIST: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/web/dist");

pub fn has_packaged_page() -> bool {
    packaged_asset("index.html").is_some()
}

/// Bytes of a file from the page that was packaged into this binary.
pub fn packaged_asset(path: &str) -> Option<&'static [u8]> {
    if !is_packaged_path(path) {
        return None;
    }
    #[cfg(embedded_dist)]
    {
        return DIST.get_file(path).map(|file| file.contents());
    }
    #[cfg(not(embedded_dist))]
    {
        let _ = path;
        None
    }
}

/// Copy the packaged examples into a config directory.
/// A directory that contains `plugin.json` is a plugin and is left out.
pub fn seed_examples(dir: &Path) -> anyhow::Result<()> {
    write_tree(&EXAMPLES, dir, true)
}

/// Write the packaged Welcome plugin into `dir`, which will contain `plugin.json`.
pub fn extract_example_plugin(dir: &Path) -> anyhow::Result<()> {
    let welcome = EXAMPLES
        .get_dir("plugins/welcome")
        .context("the packaged example plugin was not found")?;
    write_tree(welcome, dir, false)
}

fn write_tree(dir: &Dir<'static>, dst: &Path, skip_plugins: bool) -> anyhow::Result<()> {
    fs::create_dir_all(dst).with_context(|| format!("creating {}", dst.display()))?;
    for file in dir.files() {
        let name = file
            .path()
            .file_name()
            .context("packaged file has no name")?;
        let to = dst.join(name);
        if skip_plugins && to.exists() {
            continue;
        }
        fs::write(&to, file.contents()).with_context(|| format!("writing {}", to.display()))?;
    }
    for child in dir.dirs() {
        if skip_plugins && is_plugin_dir(child) {
            continue;
        }
        let name = child
            .path()
            .file_name()
            .context("packaged directory has no name")?;
        write_tree(child, &dst.join(name), skip_plugins)?;
    }
    Ok(())
}

fn is_plugin_dir(dir: &Dir<'static>) -> bool {
    dir.files()
        .any(|file| file.path().file_name() == Some(OsStr::new("plugin.json")))
}

fn is_packaged_path(path: &str) -> bool {
    if path.is_empty() || path.contains('\\') || path.contains('\0') {
        return false;
    }
    let relative = Path::new(path);
    !relative.is_absolute()
        && relative
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_built_page_is_packaged_in_the_binary() {
        let html = packaged_asset("index.html").expect("index.html");
        let text = std::str::from_utf8(html).unwrap();
        assert!(text.contains("id=\"root\""));
        assert!(text.contains("/assets/"));
        assert!(packaged_asset("../Cargo.toml").is_none());
        assert!(packaged_asset(r"assets\..\..\Cargo.toml").is_none());
    }
}
