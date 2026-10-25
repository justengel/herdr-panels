use std::path::{Component, Path};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FsKind {
    File,
    Dir,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenKind {
    Browser { url: String, proxy: bool },
    Markdown { path: String },
    Html { path: String },
    Text { path: String },
    Explorer { path: String },
    Plugin { id: String },
}

pub fn classify_target(
    target: &str,
    stat: impl Fn(&str) -> Option<FsKind>,
) -> Result<OpenKind, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("target is empty".into());
    }
    if let Some(url) = http_url(target) {
        return Ok(browser(url));
    }
    if let Some(id) = plugin_target(target)? {
        return Ok(OpenKind::Plugin { id });
    }
    if let Some(url) = web_address(target) {
        return Ok(browser(url));
    }
    if has_scheme(target) {
        return Err("url must be http or https".into());
    }
    if target.contains('\0') || has_parent(target) {
        return Err("path cannot contain ..".into());
    }
    match stat(target) {
        Some(FsKind::Dir) => Ok(OpenKind::Explorer {
            path: target.to_string(),
        }),
        Some(FsKind::File) => Ok(file_kind(target)),
        None if Path::new(target).is_absolute() => Err(format!("file was not found: {target}")),
        None => Ok(file_kind(target)),
    }
}

pub fn address_target(
    target: &str,
    stat: impl Fn(&str) -> Option<FsKind>,
) -> Result<OpenKind, String> {
    let kind = classify_target(target, &stat)?;
    match &kind {
        OpenKind::Markdown { path } | OpenKind::Html { path } | OpenKind::Text { path }
            if stat(path).is_none() =>
        {
            Err(format!("file was not found: {path}"))
        }
        _ => Ok(kind),
    }
}

pub fn embedding_refusal(headers: &[(&str, &str)]) -> Option<&'static str> {
    if let Some(policy) = header_value(headers, "content-security-policy") {
        if let Some(sources) = frame_ancestors(policy) {
            return if sources.split_whitespace().any(|source| source == "*") {
                None
            } else {
                Some("This site refused to be embedded.")
            };
        }
    }
    if let Some(policy) = header_value(headers, "x-frame-options") {
        let policy = policy.trim().to_ascii_lowercase();
        if policy == "deny" || policy == "sameorigin" || policy.starts_with("allow-from") {
            return Some("This site refused to be embedded.");
        }
    }
    None
}

pub fn open_title(kind: &OpenKind) -> String {
    match kind {
        OpenKind::Browser { url, .. } => browser_title(url),
        OpenKind::Plugin { id } => id.clone(),
        OpenKind::Markdown { path }
        | OpenKind::Html { path }
        | OpenKind::Text { path }
        | OpenKind::Explorer { path } => file_label(path),
    }
}

fn file_kind(path: &str) -> OpenKind {
    match Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("md") | Some("markdown") => OpenKind::Markdown {
            path: path.to_string(),
        },
        Some("html") | Some("htm") => OpenKind::Html {
            path: path.to_string(),
        },
        _ => OpenKind::Text {
            path: path.to_string(),
        },
    }
}

fn browser(url: String) -> OpenKind {
    OpenKind::Browser {
        proxy: crate::paths::is_loopback_url(&url),
        url,
    }
}

fn plugin_target(target: &str) -> Result<Option<String>, String> {
    let Some(id) = target.strip_prefix("plugin:") else {
        return Ok(None);
    };
    crate::plugins::validate_plugin_id(id).map_err(|err| err.to_string())?;
    Ok(Some(id.to_string()))
}

fn web_address(target: &str) -> Option<String> {
    if target.contains('\\')
        || target.contains(' ')
        || target.contains('#')
        || is_windows_drive(target)
    {
        return None;
    }
    let (without_query, query) = match target.split_once('?') {
        Some((left, right)) => (left, Some(right)),
        None => (target, None),
    };
    if without_query.is_empty() {
        return None;
    }
    let (hostport, path) = match without_query.split_once('/') {
        Some((host, rest)) => (host, format!("/{rest}")),
        None => (without_query, String::new()),
    };
    let (host, port) = split_host_port(hostport)?;
    if !is_web_host(&host) {
        return None;
    }
    if path.is_empty() && query.is_none() && is_content_name(&host) {
        return None;
    }
    let scheme = if prefers_http(&host) { "http" } else { "https" };
    let port = port.map(|value| format!(":{value}")).unwrap_or_default();
    let query = query.map(|value| format!("?{value}")).unwrap_or_default();
    let url = format!("{scheme}://{host}{port}{path}{query}");
    url::Url::parse(&url).ok()?;
    Some(url)
}

fn is_windows_drive(target: &str) -> bool {
    let mut chars = target.chars();
    matches!(
        (chars.next(), chars.next()),
        (Some(letter), Some(':')) if letter.is_ascii_alphabetic()
    )
}

fn split_host_port(hostport: &str) -> Option<(String, Option<u16>)> {
    if let Some(host) = hostport.strip_prefix('[') {
        let (host, rest) = host.split_once(']')?;
        if rest.is_empty() {
            return Some((host.to_string(), None));
        }
        let port = rest.strip_prefix(':')?.parse::<u16>().ok()?;
        if port == 0 {
            return None;
        }
        return Some((host.to_string(), Some(port)));
    }
    if let Some((host, port)) = hostport.rsplit_once(':') {
        if !host.is_empty() && !port.is_empty() && port.chars().all(|ch| ch.is_ascii_digit()) {
            let port = port.parse::<u16>().ok()?;
            if port == 0 {
                return None;
            }
            return Some((host.to_string(), Some(port)));
        }
    }
    if hostport.is_empty() {
        return None;
    }
    Some((hostport.to_string(), None))
}

fn is_web_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") || host.parse::<std::net::IpAddr>().is_ok() {
        return true;
    }
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    let tld = labels[labels.len() - 1];
    if tld.len() < 2 || !tld.chars().all(|ch| ch.is_ascii_alphabetic()) {
        return false;
    }
    labels.iter().all(|label| {
        !label.is_empty()
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    })
}

fn prefers_http(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost") || host.parse::<std::net::IpAddr>().is_ok()
}

fn is_content_name(host: &str) -> bool {
    let Some((name, extension)) = host.rsplit_once('.') else {
        return false;
    };
    if name.is_empty() || name.contains('.') {
        return false;
    }
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "md" | "markdown"
            | "html"
            | "htm"
            | "txt"
            | "json"
            | "rs"
            | "toml"
            | "css"
            | "js"
            | "ts"
            | "tsx"
            | "jsx"
            | "py"
            | "csv"
            | "xml"
            | "yml"
            | "yaml"
            | "log"
            | "svg"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "pdf"
    )
}

fn header_value<'a>(headers: &'a [(&str, &str)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| *value)
}

fn frame_ancestors(policy: &str) -> Option<&str> {
    policy.split(';').find_map(|directive| {
        let directive = directive.trim();
        let mut parts = directive.split_whitespace();
        let name = parts.next()?;
        if name.eq_ignore_ascii_case("frame-ancestors") {
            Some(directive[name.len()..].trim())
        } else {
            None
        }
    })
}

fn http_url(target: &str) -> Option<String> {
    let url = url::Url::parse(target).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    url.host_str()?;
    Some(target.to_string())
}

fn has_scheme(target: &str) -> bool {
    let Some((scheme, rest)) = target.split_once(':') else {
        return false;
    };
    if is_drive_path(scheme, rest) {
        return false;
    }
    !scheme.is_empty() && scheme.chars().all(|ch| ch.is_ascii_alphabetic())
}

fn is_drive_path(scheme: &str, rest: &str) -> bool {
    scheme.len() == 1
        && scheme
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_alphabetic())
        && (rest.starts_with('/') || rest.starts_with('\\'))
}

fn file_label(path: &str) -> String {
    path.split(|ch| ch == '/' || (cfg!(windows) && ch == '\\'))
        .filter(|part| !part.is_empty())
        .next_back()
        .unwrap_or("File")
        .to_string()
}

fn has_parent(target: &str) -> bool {
    Path::new(target)
        .components()
        .any(|component| matches!(component, Component::ParentDir))
}

fn browser_title(url: &str) -> String {
    let Ok(parsed) = url::Url::parse(url) else {
        return url.to_string();
    };
    let host = parsed.host_str().unwrap_or("");
    let path = parsed.path().trim_matches('/');
    if path.is_empty() {
        host.to_string()
    } else {
        format!("{host}/{path}")
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    fn no_file(_path: &str) -> Option<FsKind> {
        None
    }

    #[test]
    fn classifies_urls_files_and_directories() {
        let page = classify_target("https://example.com/docs", no_file).unwrap();
        assert_eq!(
            page,
            OpenKind::Browser {
                url: "https://example.com/docs".into(),
                proxy: false,
            }
        );
        let local = classify_target("http://127.0.0.1:8080/app", no_file).unwrap();
        assert_eq!(
            local,
            OpenKind::Browser {
                url: "http://127.0.0.1:8080/app".into(),
                proxy: true,
            }
        );
        assert_eq!(
            classify_target("notes/welcome.md", no_file).unwrap(),
            OpenKind::Markdown {
                path: "notes/welcome.md".into()
            }
        );
        assert_eq!(
            classify_target("panels/board.html", no_file).unwrap(),
            OpenKind::Html {
                path: "panels/board.html".into()
            }
        );
        assert_eq!(
            classify_target("src/main.rs", no_file).unwrap(),
            OpenKind::Text {
                path: "src/main.rs".into()
            }
        );

        let root = std::env::temp_dir().join(format!("hwp-open-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let dir = root.join("pkg");
        std::fs::create_dir_all(&dir).unwrap();
        let file = root.join("main.rs");
        std::fs::write(&file, "fn main() {}\n").unwrap();
        let stat = |path: &str| {
            let candidate = Path::new(path);
            if candidate == dir {
                Some(FsKind::Dir)
            } else if candidate == file {
                Some(FsKind::File)
            } else {
                None
            }
        };
        assert_eq!(
            classify_target(&dir.display().to_string(), stat).unwrap(),
            OpenKind::Explorer {
                path: dir.display().to_string()
            }
        );
        assert_eq!(
            classify_target(&file.display().to_string(), stat).unwrap(),
            OpenKind::Text {
                path: file.display().to_string()
            }
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn bare_hosts_become_web_pages_and_plugins_stay_plugins() {
        assert_eq!(
            classify_target("google.com", no_file).unwrap(),
            OpenKind::Browser {
                url: "https://google.com".into(),
                proxy: false,
            }
        );
        assert_eq!(
            classify_target("localhost:8080/app", no_file).unwrap(),
            OpenKind::Browser {
                url: "http://localhost:8080/app".into(),
                proxy: true,
            }
        );
        assert_eq!(
            classify_target("plugin:my-plugin", no_file).unwrap(),
            OpenKind::Plugin {
                id: "my-plugin".into(),
            }
        );
        assert_eq!(
            address_target("notes/missing.md", no_file).unwrap_err(),
            "file was not found: notes/missing.md"
        );
    }

    #[test]
    fn framing_refusal_follows_the_site_headers() {
        assert_eq!(
            embedding_refusal(&[("x-frame-options", "SAMEORIGIN")]),
            Some("This site refused to be embedded.")
        );
        assert_eq!(
            embedding_refusal(&[("content-security-policy", "frame-ancestors 'none'")]),
            Some("This site refused to be embedded.")
        );
        assert_eq!(embedding_refusal(&[("content-type", "text/html")]), None);
    }

    #[test]
    fn rejects_empty_targets_parents_and_non_http_urls() {
        assert!(classify_target("  ", no_file).is_err());
        assert!(classify_target("notes/../../secret.md", no_file).is_err());
        assert!(classify_target("javascript:alert(1)", no_file).is_err());
        let missing = std::env::temp_dir().join("hwp-does-not-exist.txt");
        let err = classify_target(&missing.display().to_string(), no_file).unwrap_err();
        assert!(err.contains("was not found"), "{err}");
    }

    #[cfg(windows)]
    #[test]
    fn a_drive_path_is_a_file_with_either_separator() {
        let slash = classify_target("C:/missing/nope.txt", no_file).unwrap_err();
        let back = classify_target(r"C:\missing\nope.txt", no_file).unwrap_err();
        assert!(slash.contains("was not found"), "{slash}");
        assert!(back.contains("was not found"), "{back}");
        assert_eq!(
            open_title(&OpenKind::Explorer {
                path: r"C:\work\pkg".into()
            }),
            "pkg"
        );
    }

    #[test]
    fn titles_use_the_file_or_page_name() {
        assert_eq!(
            open_title(&OpenKind::Markdown {
                path: "work/readme.md".into()
            }),
            "readme.md"
        );
        assert_eq!(
            open_title(&OpenKind::Browser {
                url: "https://example.com/docs".into(),
                proxy: false,
            }),
            "example.com/docs"
        );
        assert_eq!(
            open_title(&OpenKind::Explorer {
                path: "work/pkg".into()
            }),
            "pkg"
        );
    }
}
