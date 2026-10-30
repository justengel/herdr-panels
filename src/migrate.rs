use std::fs;
use std::path::Path;

use anyhow::Context;

use crate::desk;
use crate::store;

/// Current config file format. Add a step in `migrate_config` when a later
/// version has to rewrite desks or layouts, then bump this number.
pub const SCHEMA: u32 = 1;

/// Rewrite saved desks and layouts for this install. Installed plugins are left
/// as they are. A desk copied in later is still updated the next time it is read.
pub fn migrate_config(dir: &Path) -> anyhow::Result<()> {
    let mut settings = store::load_settings(dir)?;
    migrate_desks(dir)?;
    if settings.schema < SCHEMA {
        migrate_layouts(dir)?;
        settings.schema = SCHEMA;
        store::save_settings(dir, &settings)?;
    }
    Ok(())
}

fn migrate_desks(dir: &Path) -> anyhow::Result<()> {
    let desks = dir.join("desks");
    if !desks.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(&desks).with_context(|| format!("reading {}", desks.display()))? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Some(session) = path.file_stem().and_then(|name| name.to_str()) else {
            continue;
        };
        if session != "default" && !crate::paths::valid_session_name(session) {
            continue;
        }
        desk::load_desk(dir, session)?;
    }
    Ok(())
}

fn migrate_layouts(dir: &Path) -> anyhow::Result<()> {
    let layouts = dir.join("layouts");
    if !layouts.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(&layouts).with_context(|| format!("reading {}", layouts.display()))? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|name| name.to_str()) else {
            continue;
        };
        if crate::layout::is_layout_id(id) {
            store::load_layout(dir, id)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_update_clears_automatic_names_and_leaves_plugins_alone() {
        let dir = std::env::temp_dir().join(format!(
            "hwp-migrate-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(dir.join("desks")).unwrap();
        fs::create_dir_all(dir.join("layouts")).unwrap();
        fs::create_dir_all(dir.join("plugins").join("welcome")).unwrap();
        let plugin = dir.join("plugins").join("welcome").join("plugin.json");
        fs::write(&plugin, r#"{"id":"welcome","title":"Welcome"}"#).unwrap();
        fs::write(
            dir.join("settings.json"),
            r#"{"activeLayout":"side-by-side","contentRoots":[]}"#,
        )
        .unwrap();
        fs::write(
            dir.join("desks").join("default.json"),
            r#"{
              "revision": 4,
              "pins": [
                {"id":"notes","title":"Notes","panel":{"type":"markdown","path":"a.md"},"mode":"all","spaces":[]},
                {"id":"old","title":"Panes","panel":{"type":"herdr"},"mode":"all","spaces":[]}
              ],
              "spaces": {
                "w1": {
                  "type": "split",
                  "direction": "row",
                  "ratio": 0.5,
                  "first": {"type":"panel","id":"files","title":"Panes","panel":{"type":"explorer","path":"/home/me/pkg"}},
                  "second": {"type":"panel","id":"term","title":"Terminal","panel":{"type":"herdr","scope":"pane"}}
                }
              }
            }"#,
        )
        .unwrap();
        fs::write(
            dir.join("layouts").join("side-by-side.json"),
            r#"{
              "id": "side-by-side",
              "title": "Side by side",
              "root": {
                "type": "panel",
                "id": "notes",
                "title": "Files",
                "panel": {"type": "markdown", "path": "notes/welcome.md"}
              }
            }"#,
        )
        .unwrap();

        migrate_config(&dir).unwrap();

        let desk = desk::load_desk(&dir, "default").unwrap();
        assert_eq!(desk.version, SCHEMA);
        assert_eq!(desk.revision, 4);
        assert_eq!(desk.pins[0].title, "Notes");
        assert_eq!(desk.pins[1].title, "");
        let files = match desk.spaces.get("w1") {
            Some(crate::layout::LayoutNode::Split { first, .. }) => first.as_ref(),
            other => panic!("expected a split, got {other:?}"),
        };
        match files {
            crate::layout::LayoutNode::Panel { title, .. } => assert_eq!(*title, None),
            other => panic!("expected a panel, got {other:?}"),
        }
        let layout = store::load_layout(&dir, "side-by-side").unwrap();
        match layout.root {
            crate::layout::LayoutNode::Panel { title, .. } => assert_eq!(title, None),
            other => panic!("expected a panel, got {other:?}"),
        }
        let settings = store::load_settings(&dir).unwrap();
        assert_eq!(settings.schema, SCHEMA);
        assert_eq!(
            fs::read_to_string(&plugin).unwrap(),
            r#"{"id":"welcome","title":"Welcome"}"#
        );

        migrate_config(&dir).unwrap();
        assert_eq!(desk::load_desk(&dir, "default").unwrap().revision, 4);
        let _ = fs::remove_dir_all(&dir);
    }
}
