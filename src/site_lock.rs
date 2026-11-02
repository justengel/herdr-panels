//! A locked browser panel locks its site for the panels API.
//! `mail.google.com` and `accounts.google.com` are one site. `youtube.com` is another.
//! The locked panel may keep browsing. Every other panel is refused that site.

use std::fs;
use std::path::Path;

use psl::{List, Psl};

use crate::desk::DeskDocument;
use crate::layout::LayoutNode;
use crate::layout_ops::list_panels;
use crate::panel_lock;

pub const LOCKED: &str = "this site is locked";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hold {
    pub panel_id: String,
    pub site: String,
}

/// Registrable site for an http(s) URL. An IP address stays the address.
pub fn site_of(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url.trim()).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    let host = parsed
        .host_str()?
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    if parsed
        .host()
        .is_some_and(|host| matches!(host, url::Host::Ipv4(_) | url::Host::Ipv6(_)))
    {
        return Some(host);
    }
    match List.domain(host.as_bytes()) {
        Some(domain) => std::str::from_utf8(domain.as_bytes())
            .ok()
            .map(str::to_string),
        None => Some(host),
    }
}

pub fn holds(config_dir: &Path, session: &str, desk: &DeskDocument) -> Vec<Hold> {
    let locked = panel_lock::session_panels(config_dir, session);
    let mut found = Vec::new();
    for (key, root) in &desk.spaces {
        collect(root, key, &locked, &mut found);
    }
    found
}

fn collect(
    root: &LayoutNode,
    space_key: &str,
    locked: &Option<Vec<(String, String)>>,
    found: &mut Vec<Hold>,
) {
    for panel in list_panels(root) {
        for url in panel.panel.browser_urls() {
            let Some(site) = site_of(url) else {
                continue;
            };
            let held = match locked {
                None => true,
                Some(list) => list.iter().any(|(space, id)| {
                    id == &panel.id
                        && (space == space_key || crate::desk::space_key(space) == space_key)
                }),
            };
            if held {
                found.push(Hold {
                    panel_id: panel.id.clone(),
                    site,
                });
            }
        }
    }
}

pub fn blocked(url: &str, holds: &[Hold]) -> bool {
    let Some(site) = site_of(url) else {
        return false;
    };
    holds.iter().any(|hold| hold.site == site)
}

/// The panel that holds the site may navigate. Every other panel may not.
pub fn navigation_allowed(panel_id: &str, url: &str, holds: &[Hold]) -> bool {
    let Some(site) = site_of(url) else {
        return true;
    };
    if !holds.iter().any(|hold| hold.site == site) {
        return true;
    }
    holds
        .iter()
        .any(|hold| hold.panel_id == panel_id && hold.site == site)
}

pub fn any_desk_blocks(config_dir: &Path, url: &str) -> bool {
    desks(config_dir)
        .iter()
        .any(|(session, desk)| blocked(url, &holds(config_dir, session, desk)))
}

pub fn navigation_allowed_anywhere(config_dir: &Path, panel_id: &str, url: &str) -> bool {
    let Some(site) = site_of(url) else {
        return true;
    };
    let mut blocked_somewhere = false;
    let mut this_panel_holds = false;
    for (session, desk) in desks(config_dir) {
        let held = holds(config_dir, &session, &desk);
        if held.iter().any(|hold| hold.site == site) {
            blocked_somewhere = true;
        }
        if held
            .iter()
            .any(|hold| hold.panel_id == panel_id && hold.site == site)
        {
            this_panel_holds = true;
        }
    }
    !blocked_somewhere || this_panel_holds
}

fn desks(config_dir: &Path) -> Vec<(String, DeskDocument)> {
    let Ok(entries) = fs::read_dir(config_dir.join("desks")) else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name();
            let name = name.to_str()?;
            let session = name.strip_suffix(".json")?;
            let desk = crate::desk::load_desk(config_dir, session).ok()?;
            Some((session.to_string(), desk))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::{LayoutNode, PanelConfig};
    use std::collections::BTreeMap;

    fn browser(id: &str, url: &str) -> LayoutNode {
        LayoutNode::Panel {
            id: id.into(),
            title: None,
            panel: PanelConfig::Iframe {
                url: url.into(),
                proxy: false,
                address_bar: None,
            },
            collapsed: false,
            icon: None,
        }
    }

    #[test]
    fn a_site_is_the_registrable_name() {
        assert_eq!(
            site_of("https://mail.google.com/mail/u/0/").as_deref(),
            Some("google.com")
        );
        assert_eq!(
            site_of("https://accounts.google.com/ServiceLogin").as_deref(),
            Some("google.com")
        );
        assert_eq!(
            site_of("http://www.google.com/search?q=1").as_deref(),
            Some("google.com")
        );
        assert_eq!(
            site_of("https://www.youtube.com/feed").as_deref(),
            Some("youtube.com")
        );
        assert_eq!(
            site_of("https://news.bbc.co.uk/").as_deref(),
            Some("bbc.co.uk")
        );
        assert_eq!(
            site_of("https://example.co.uk/").as_deref(),
            Some("example.co.uk")
        );
        assert_eq!(
            site_of("https://foo.github.io/project").as_deref(),
            Some("foo.github.io")
        );
        assert_eq!(
            site_of("https://bar.github.io/").as_deref(),
            Some("bar.github.io")
        );
        assert_eq!(
            site_of("http://127.0.0.1:8080/app").as_deref(),
            Some("127.0.0.1")
        );
        assert_eq!(site_of("notes/welcome.md"), None);
    }

    #[test]
    fn a_locked_google_panel_blocks_the_rest_of_that_site() {
        let dir = std::env::temp_dir().join(format!("herdr-site-lock-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("desks")).unwrap();
        let mut desk = DeskDocument::default();
        let mut spaces = BTreeMap::new();
        spaces.insert(
            "wj".into(),
            browser("panel-2", "https://mail.google.com/mail/u/0/"),
        );
        spaces.insert(
            "other".into(),
            browser("panel-9", "https://www.youtube.com/feed"),
        );
        desk.spaces = spaces;
        panel_lock::set_locked(&dir, "default", "wJ", "panel-2", None, true).unwrap();
        let held = holds(&dir, "default", &desk);
        assert!(blocked("https://accounts.google.com/signin", &held));
        assert!(blocked("https://www.google.com/", &held));
        assert!(!blocked("https://youtube.com/watch?v=1", &held));
        assert!(!blocked("https://example.com/", &held));
        assert!(navigation_allowed(
            "panel-2",
            "https://calendar.google.com/",
            &held
        ));
        assert!(!navigation_allowed(
            "panel-9",
            "https://calendar.google.com/",
            &held
        ));
        assert!(navigation_allowed("panel-9", "https://example.com/", &held));

        fs::write(
            dir.join("desks").join("default.json"),
            serde_json::to_vec(&desk).unwrap(),
        )
        .unwrap();
        assert!(any_desk_blocks(&dir, "https://google.com/maps"));
        assert!(!any_desk_blocks(&dir, "https://example.com/"));
        assert!(navigation_allowed_anywhere(
            &dir,
            "panel-2",
            "https://mail.google.com/"
        ));
        assert!(!navigation_allowed_anywhere(
            &dir,
            "panel-9",
            "https://mail.google.com/"
        ));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_locked_tab_group_holds_the_browser_inside_it() {
        let dir = std::env::temp_dir().join(format!("herdr-site-lock-tab-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("desks")).unwrap();
        let root: LayoutNode = serde_json::from_str(
            r#"{
              "type": "panel",
              "id": "panel-2",
              "panel": {
                "type": "tabs",
                "active": "tab-1",
                "tabs": [{
                  "id": "tab-1",
                  "title": "Mail",
                  "panel": {"type": "iframe", "url": "https://mail.google.com/mail/u/0/"}
                }]
              }
            }"#,
        )
        .unwrap();
        let mut desk = DeskDocument::default();
        let mut spaces = BTreeMap::new();
        spaces.insert("wj".into(), root);
        desk.spaces = spaces;
        panel_lock::set_locked(&dir, "default", "wJ", "panel-2", None, true).unwrap();
        let held = holds(&dir, "default", &desk);
        assert!(blocked("https://www.google.com/", &held));
        assert!(navigation_allowed("panel-2", "https://mail.google.com/", &held));
        assert!(!navigation_allowed("panel-9", "https://mail.google.com/", &held));
        let _ = fs::remove_dir_all(&dir);
    }
}
