use std::path::{Path, PathBuf};

use anyhow::{bail, Context};

/// Logical Herdr socket path, before the Windows named-pipe prefix.
pub fn resolve_herdr_socket(
    flag: Option<PathBuf>,
    session_flag: Option<String>,
) -> anyhow::Result<PathBuf> {
    if let Some(path) = flag {
        return Ok(path);
    }
    if let Some(path) = std::env::var_os("HERDR_SOCKET_PATH") {
        if !path.is_empty() {
            return Ok(PathBuf::from(path));
        }
    }
    let session = session_flag.or_else(|| {
        std::env::var("HERDR_SESSION")
            .ok()
            .filter(|value| !value.is_empty())
    });
    let base = herdr_config_dir()?;
    let path = match session {
        Some(name) => {
            if name.contains('/')
                || name.contains('\\')
                || name.contains("..")
                || name.starts_with('.')
            {
                bail!("invalid Herdr session name");
            }
            base.join("sessions").join(name).join("herdr.sock")
        }
        None => base.join("herdr.sock"),
    };
    Ok(path)
}

/// Session name encoded in `<herdr config>/sessions/<name>/herdr.sock`.
pub fn session_name_from_socket(socket: &Path) -> Option<String> {
    let file = socket.file_name()?.to_str()?;
    if file != "herdr.sock" {
        return None;
    }
    let session_dir = socket.parent()?;
    let sessions = session_dir.parent()?;
    if sessions.file_name()?.to_str()? != "sessions" {
        return None;
    }
    let name = session_dir.file_name()?.to_str()?;
    if name.is_empty() || name.starts_with('.') || name.contains('/') || name.contains('\\') {
        return None;
    }
    Some(name.to_string())
}

pub fn session_label(socket: &Path) -> String {
    session_name_from_socket(socket).unwrap_or_else(|| "default".into())
}

pub fn list_herdr_sessions() -> anyhow::Result<Vec<(String, PathBuf)>> {
    let base = herdr_config_dir()?;
    let mut sessions = Vec::new();
    let default_socket = base.join("herdr.sock");
    if default_socket.is_file() {
        sessions.push(("default".into(), default_socket));
    }
    let directory = base.join("sessions");
    let mut named = Vec::new();
    if let Ok(entries) = std::fs::read_dir(directory) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !valid_session_name(&name) {
                continue;
            }
            let socket = entry.path().join("herdr.sock");
            if socket.is_file() {
                named.push((name, socket));
            }
        }
    }
    named.sort_by(|left, right| left.0.cmp(&right.0));
    sessions.extend(named);
    Ok(sessions)
}

pub fn session_socket(name: &str) -> anyhow::Result<PathBuf> {
    if name == "default" {
        let socket = herdr_config_dir()?.join("herdr.sock");
        if !socket.is_file() {
            bail!("the default Herdr session is not running");
        }
        return Ok(socket);
    }
    if !valid_session_name(name) {
        bail!("invalid Herdr session name");
    }
    let socket = herdr_config_dir()?
        .join("sessions")
        .join(name)
        .join("herdr.sock");
    if !socket.is_file() {
        bail!("Herdr session {name} is not running");
    }
    Ok(socket)
}

pub(crate) fn named_session_dir(name: &str) -> anyhow::Result<PathBuf> {
    if !valid_session_name(name) {
        bail!("invalid Herdr session name");
    }
    Ok(herdr_config_dir()?.join("sessions").join(name))
}

pub(crate) fn valid_session_name(name: &str) -> bool {
    !name.is_empty()
        && name != "default"
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && !name.starts_with('.')
}

pub fn herdr_config_dir() -> anyhow::Result<PathBuf> {
    #[cfg(windows)]
    {
        let appdata = std::env::var_os("APPDATA").context("APPDATA is not set")?;
        Ok(PathBuf::from(appdata).join("herdr"))
    }
    #[cfg(not(windows))]
    {
        if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
            if !xdg.is_empty() {
                return Ok(PathBuf::from(xdg).join("herdr"));
            }
        }
        let home = std::env::var_os("HOME").context("HOME is not set")?;
        Ok(PathBuf::from(home).join(".config").join("herdr"))
    }
}

pub fn app_config_dir() -> anyhow::Result<PathBuf> {
    let base = config_home()?;
    let current = base.join("herdr-panels");
    let earlier = base.join("herdr-web-panels");
    if current.exists() || !earlier.exists() {
        Ok(current)
    } else {
        Ok(earlier)
    }
}

fn config_home() -> anyhow::Result<PathBuf> {
    #[cfg(windows)]
    {
        let appdata = std::env::var_os("APPDATA").context("APPDATA is not set")?;
        Ok(PathBuf::from(appdata))
    }
    #[cfg(not(windows))]
    {
        if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
            if !xdg.is_empty() {
                return Ok(PathBuf::from(xdg));
            }
        }
        let home = std::env::var_os("HOME").context("HOME is not set")?;
        Ok(PathBuf::from(home).join(".config"))
    }
}

/// Transport address for Tokio. On Windows this is `\\.\pipe\<logical path>`.
pub fn transport_name(logical: &Path) -> String {
    #[cfg(windows)]
    {
        format!(r"\\.\pipe\{}", logical.display())
    }
    #[cfg(not(windows))]
    {
        logical.display().to_string()
    }
}

pub fn resolve_content(
    config_dir: &Path,
    roots: &[PathBuf],
    requested: &str,
) -> Result<PathBuf, String> {
    if requested.trim().is_empty() {
        return Err("empty path".into());
    }
    if requested.contains('\0') {
        return Err("invalid path".into());
    }
    let requested_path = content_path(requested)?;
    let absolute = requested_path.is_absolute();

    let candidates = if absolute {
        vec![requested_path]
    } else {
        let mut paths = vec![config_dir.join(&requested_path)];
        for root in roots {
            paths.push(root.join(&requested_path));
        }
        paths
    };

    let mut saw_outside = false;
    for candidate in candidates {
        let Ok(canonical) = candidate.canonicalize() else {
            continue;
        };
        if !canonical.is_file() {
            continue;
        }
        if path_allowed(&canonical, config_dir, roots) || absolute {
            return Ok(canonical);
        }
        saw_outside = true;
    }
    if saw_outside {
        Err("path is outside the configured content roots".into())
    } else {
        Err(format!("file not found: {requested}"))
    }
}

fn content_path(requested: &str) -> Result<PathBuf, String> {
    if requested.split(['/', '\\']).any(|part| part == "..") {
        return Err("path must stay inside a content root".into());
    }
    let native = if cfg!(windows) {
        PathBuf::from(requested.replace('/', "\\"))
    } else {
        PathBuf::from(requested)
    };
    if native.is_absolute() {
        return Ok(native);
    }
    let mut path = PathBuf::new();
    for part in relative_parts(requested) {
        if part.is_empty() || part == "." {
            continue;
        }
        path.push(part);
    }
    if path.as_os_str().is_empty() {
        Err("empty path".into())
    } else {
        Ok(path)
    }
}

fn relative_parts(requested: &str) -> Vec<&str> {
    if cfg!(windows) {
        requested.split(['/', '\\']).collect()
    } else {
        requested.split('/').collect()
    }
}

fn path_allowed(canonical: &Path, config_dir: &Path, roots: &[PathBuf]) -> bool {
    let mut bases = Vec::new();
    if let Ok(config) = config_dir.canonicalize() {
        bases.push(config);
    } else {
        bases.push(config_dir.to_path_buf());
    }
    for root in roots {
        if let Ok(canonical_root) = root.canonicalize() {
            bases.push(canonical_root);
        }
    }
    bases.iter().any(|base| canonical.starts_with(base))
}

pub fn is_loopback_authority(authority: &str) -> bool {
    if authority.is_empty() || authority.contains('@') || authority.contains('\\') {
        return false;
    }
    let host = if let Some(rest) = authority.strip_prefix('[') {
        let Some((host, _)) = rest.split_once(']') else {
            return false;
        };
        host
    } else {
        match authority.rsplit_once(':') {
            Some((host, port))
                if !port.is_empty() && port.chars().all(|ch| ch.is_ascii_digit()) =>
            {
                host
            }
            _ => authority,
        }
    };
    let host = host.trim();
    host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1"
}

pub fn is_loopback_url(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    if url.scheme() != "http" && url.scheme() != "https" {
        return false;
    }
    matches!(
        url.host_str(),
        Some("localhost") | Some("127.0.0.1") | Some("::1")
    )
}

pub fn origin_is_local(origin: &str) -> bool {
    if origin == "null" {
        return false;
    }
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    if url.scheme() != "http" && url.scheme() != "https" {
        return false;
    }
    matches!(
        url.host_str(),
        Some("localhost") | Some("127.0.0.1") | Some("::1")
    )
}

pub fn bundled_examples() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("examples"));
    if let Ok(current) = std::env::current_dir() {
        candidates.push(current.join("examples"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("examples"));
            candidates.push(dir.join("..").join("..").join("examples"));
        }
    }
    candidates
        .into_iter()
        .find(|path| path.join("layouts").is_dir())
}

pub fn find_dist_dir() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("web")
            .join("dist"),
    );
    if let Ok(current) = std::env::current_dir() {
        candidates.push(current.join("web").join("dist"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("web").join("dist"));
            candidates.push(dir.join("..").join("..").join("web").join("dist"));
        }
    }
    candidates
        .into_iter()
        .find(|path| path.join("index.html").is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_authorities() {
        assert!(is_loopback_authority("127.0.0.1:3000"));
        assert!(is_loopback_authority("localhost"));
        assert!(is_loopback_authority("[::1]:8080"));
        assert!(!is_loopback_authority("example.com"));
        assert!(!is_loopback_authority("127.0.0.1.evil.com"));
        assert!(!is_loopback_authority("user@127.0.0.1:3000"));
    }

    #[test]
    fn local_origins() {
        assert!(origin_is_local("http://127.0.0.1:5173"));
        assert!(origin_is_local("http://localhost:4737"));
        assert!(!origin_is_local("https://example.com"));
        assert!(!origin_is_local("null"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_pipe_name() {
        let name = transport_name(Path::new(r"C:\Users\a\herdr.sock"));
        assert_eq!(name, r"\\.\pipe\C:\Users\a\herdr.sock");
    }

    #[test]
    fn session_name_comes_from_the_socket_path() {
        let named = PathBuf::from("herdr")
            .join("sessions")
            .join("webpanels-probe")
            .join("herdr.sock");
        assert_eq!(
            session_name_from_socket(&named).as_deref(),
            Some("webpanels-probe")
        );
        let default_socket = PathBuf::from("herdr").join("herdr.sock");
        assert_eq!(session_name_from_socket(&default_socket), None);
        assert_eq!(session_label(&named), "webpanels-probe");
        assert_eq!(session_label(&default_socket), "default");
    }

    #[test]
    fn a_relative_path_uses_slashes_on_every_system() {
        let root = std::env::temp_dir().join(format!("hwp-rel-{}", std::process::id()));
        let notes = root.join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        std::fs::write(notes.join("welcome.md"), "hi").unwrap();
        let found = resolve_content(&root, &[], "notes/welcome.md").unwrap();
        assert_eq!(
            found.file_name().and_then(|name| name.to_str()),
            Some("welcome.md")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_absolute_file_outside_the_roots_can_be_read() {
        let root = std::env::temp_dir().join(format!("hwp-inside-{}", std::process::id()));
        let outside = std::env::temp_dir().join(format!("hwp-outside-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("note.txt"), "outside").unwrap();
        let found = resolve_content(
            &root,
            &[root.clone()],
            &outside.join("note.txt").display().to_string(),
        )
        .unwrap();
        assert_eq!(
            found.file_name().and_then(|name| name.to_str()),
            Some("note.txt")
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn content_rejects_parent_segments() {
        let dir = std::env::temp_dir();
        let err = resolve_content(&dir, &[], "notes/../../secret.md").unwrap_err();
        assert!(err.contains("content root"));
        let escaped = resolve_content(&dir, &[], r"notes\..\secret.md").unwrap_err();
        assert!(escaped.contains("content root"));
    }
}
