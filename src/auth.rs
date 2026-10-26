//! Viewer credential.
//!
//! Browsers can open a TCP port on this machine, so the viewer does not trust
//! "localhost" by itself. One token stands in for Herdr's named pipe: whoever
//! can read this OS user's config can control the viewer. The token is created
//! on first start, stored next to `server.json`, and never printed.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use anyhow::Context;

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

pub const FILE_NAME: &str = "auth-token";
pub const ENV: &str = "HERDR_PANELS_TOKEN";
pub const DEV_PORT: u16 = 5173;

/// Token for this process. `HERDR_PANELS_TOKEN` wins when it is non-empty.
/// Otherwise the file is created or reused.
pub fn session_token(config_dir: &Path) -> anyhow::Result<String> {
    if let Ok(value) = std::env::var(ENV) {
        let value = value.trim();
        if !value.is_empty() {
            validate_token(value)?;
            return Ok(value.to_string());
        }
    }
    ensure_file(config_dir)
}

pub fn ensure_file(config_dir: &Path) -> anyhow::Result<String> {
    let path = config_dir.join(FILE_NAME);
    if let Ok(text) = fs::read_to_string(&path) {
        let token = text.trim();
        if validate_token(token).is_ok() {
            tighten(&path);
            return Ok(token.to_string());
        }
    }
    let token = generate()?;
    write_token(&path, &token)?;
    Ok(token)
}

pub fn rotate(config_dir: &Path) -> anyhow::Result<()> {
    let token = generate()?;
    write_token(&config_dir.join(FILE_NAME), &token)
}

pub fn set_token(config_dir: &Path, value: &str) -> anyhow::Result<()> {
    let value = value.trim();
    validate_token(value)?;
    write_token(&config_dir.join(FILE_NAME), value)
}

pub fn validate_token(value: &str) -> anyhow::Result<()> {
    if !(32..=256).contains(&value.len()) {
        anyhow::bail!("token must be 32 to 256 characters");
    }
    if !value.bytes().all(is_token68) {
        anyhow::bail!("token contains characters that are not allowed");
    }
    Ok(())
}

pub fn tokens_match(expected: &str, presented: &str) -> bool {
    let expected = expected.as_bytes();
    let presented = presented.as_bytes();
    if expected.len() != presented.len() {
        return false;
    }
    let mut diff = 0u8;
    for (left, right) in expected.iter().zip(presented.iter()) {
        diff |= left ^ right;
    }
    diff == 0
}

/// `http` only, on localhost / 127.0.0.1 / ::1, and only this viewer or the Vite port.
pub fn origin_allowed(origin: &str, port: u16) -> bool {
    if origin == "null" {
        return false;
    }
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    if url.scheme() != "http" {
        return false;
    }
    let host_ok = match url.host() {
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip == std::net::Ipv4Addr::LOCALHOST,
        Some(url::Host::Ipv6(ip)) => ip == std::net::Ipv6Addr::LOCALHOST,
        None => false,
    };
    let Some(origin_port) = url.port() else {
        return false;
    };
    host_ok && (origin_port == port || origin_port == DEV_PORT)
}

pub(crate) fn random_secret() -> anyhow::Result<String> {
    generate()
}

fn generate() -> anyhow::Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|err| anyhow::anyhow!("reading random bytes: {err}"))?;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(64);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    Ok(out)
}

fn write_token(path: &Path, token: &str) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
        }
    }
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(path)
        .with_context(|| format!("writing {}", path.display()))?;
    writeln!(file, "{token}").with_context(|| format!("writing {}", path.display()))?;
    tighten(path);
    Ok(())
}

fn tighten(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

fn is_token68(byte: u8) -> bool {
    matches!(
        byte,
        b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'.'
            | b'_'
            | b'~'
            | b'+'
            | b'/'
            | b'='
    )
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    fn scratch() -> std::path::PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("hwp-auth-{}-{id}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_file_token_stays_until_it_is_rotated() {
        let dir = scratch();
        let first = ensure_file(&dir).unwrap();
        assert_eq!(first.len(), 64);
        assert_eq!(ensure_file(&dir).unwrap(), first);
        rotate(&dir).unwrap();
        let second = ensure_file(&dir).unwrap();
        assert_ne!(first, second);
        assert!(tokens_match(&second, &second));
        assert!(!tokens_match(&first, &second));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_short_token_is_rejected_and_a_token68_value_is_kept() {
        let dir = scratch();
        assert!(set_token(&dir, "short").is_err());
        assert!(!dir.join(FILE_NAME).exists());
        let value = "Ab3-._~+/=Ab3-._~+/=Ab3-._~+/=Ab";
        assert_eq!(value.len(), 32);
        set_token(&dir, value).unwrap();
        assert_eq!(ensure_file(&dir).unwrap(), value);
        assert!(set_token(&dir, &"a".repeat(257)).is_err());
        assert!(set_token(&dir, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_broken_file_is_replaced() {
        let dir = scratch();
        fs::write(dir.join(FILE_NAME), "nope\n").unwrap();
        let token = ensure_file(&dir).unwrap();
        assert_eq!(token.len(), 64);
        assert_eq!(
            fs::read_to_string(dir.join(FILE_NAME)).unwrap().trim(),
            token
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn the_token_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch();
        ensure_file(&dir).unwrap();
        let mode = fs::metadata(dir.join(FILE_NAME))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn origins_are_limited_to_the_viewer_and_the_dev_server() {
        assert!(origin_allowed("http://127.0.0.1:4737", 4737));
        assert!(origin_allowed("http://localhost:4737", 4737));
        assert!(origin_allowed("http://[::1]:4737", 4737));
        assert!(origin_allowed("http://127.0.0.1:5173", 4737));
        assert!(!origin_allowed("http://127.0.0.1:9", 4737));
        assert!(!origin_allowed("http://127.0.0.1", 4737));
        assert!(!origin_allowed("https://127.0.0.1:4737", 4737));
        assert!(!origin_allowed("https://example.com", 4737));
        assert!(!origin_allowed("null", 4737));
    }
}
