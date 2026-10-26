use std::fs;
use std::path::{Path, PathBuf};

use anyhow::bail;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TreeEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
}

pub fn list_children(requested: &Path) -> anyhow::Result<Vec<TreeEntry>> {
    if requested.as_os_str().is_empty() {
        bail!("directory path is empty");
    }
    let requested = canonicalize_existing(requested)?;
    if !requested.is_dir() {
        bail!("directory was not found");
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(&requested)? {
        let entry = entry?;
        let kind = match entry.file_type() {
            Ok(kind) if kind.is_dir() => "dir",
            Ok(kind) if kind.is_file() => "file",
            _ => continue,
        };
        entries.push(TreeEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: plain_path(&entry.path()),
            kind: kind.to_string(),
        });
        if entries.len() == 400 {
            break;
        }
    }
    entries.sort_by(|left, right| {
        let rank = |kind: &str| if kind == "dir" { 0 } else { 1 };
        rank(&left.kind)
            .cmp(&rank(&right.kind))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(entries)
}

pub(crate) fn plain_path(path: &Path) -> String {
    let text = path.display().to_string();
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

fn canonicalize_existing(path: &Path) -> anyhow::Result<PathBuf> {
    fs::canonicalize(path).map_err(|_| anyhow::anyhow!("directory was not found"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_a_directory_and_its_parent() {
        let parent = std::env::temp_dir().join(format!("hwp-tree-parent-{}", std::process::id()));
        let root = parent.join("project");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("readme.txt"), "hi").unwrap();
        let listed = list_children(&root).unwrap();
        assert!(listed
            .iter()
            .any(|entry| entry.name == "src" && entry.kind == "dir"));
        assert!(listed
            .iter()
            .any(|entry| entry.name == "readme.txt" && entry.kind == "file"));
        let above = list_children(&parent).unwrap();
        assert!(above
            .iter()
            .any(|entry| entry.name == "project" && entry.kind == "dir"));
        assert!(list_children(Path::new("")).is_err());
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn verbatim_prefix_strips() {
        let canonical = std::env::temp_dir().canonicalize().unwrap();
        let stripped = plain_path(&canonical);
        assert!(!stripped.starts_with(r"\\?\"));
        assert_eq!(plain_path(Path::new(r"\\?\C:\work")), r"C:\work");
    }
}
