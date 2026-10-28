//! Download a newer GitHub release and replace this program.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context;

const LATEST_URL: &str = "https://api.github.com/repos/justengel/herdr-panels/releases/latest";
const DOWNLOAD_PREFIX: &str = "https://github.com/justengel/herdr-panels/releases/download/";
const MAX_BINARY: u64 = 200 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    LinuxX64,
    WindowsX64,
    MacosArm64,
    MacosX64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    UpToDate {
        current: String,
    },
    Ahead {
        current: String,
        latest: String,
    },
    Available {
        version: String,
        name: String,
        url: String,
    },
    Unsupported,
}

impl Platform {
    fn asset_suffix(self) -> &'static str {
        match self {
            Platform::LinuxX64 => "linux-x64.tar.gz",
            Platform::WindowsX64 => "windows-x64.zip",
            Platform::MacosArm64 => "macos-arm64.tar.gz",
            Platform::MacosX64 => "macos-x64.tar.gz",
        }
    }

    fn is_zip(self) -> bool {
        matches!(self, Platform::WindowsX64)
    }
}

pub async fn execute() -> anyhow::Result<()> {
    let extra: Vec<String> = std::env::args().skip(2).collect();
    if extra.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("Download and install the latest GitHub release\n\nUsage: herdr-panels update");
        return Ok(());
    }
    if let Some(arg) = extra.first() {
        anyhow::bail!("unknown argument '{arg}'. Usage: herdr-panels update");
    }
    apply_update().await
}

async fn apply_update() -> anyhow::Result<()> {
    let exe = std::env::current_exe().context("could not find this program")?;
    let exe = if exe.is_symlink() {
        std::fs::canonicalize(&exe).context("could not resolve this program")?
    } else {
        exe
    };
    if is_development_build(&exe) {
        anyhow::bail!(
            "herdr-panels update replaces a downloaded release. This copy is a cargo build at {}",
            exe.display()
        );
    }
    let Some(platform) = current_platform() else {
        anyhow::bail!(
            "there is no GitHub release for this system. Releases are Linux x64, Windows x64, macOS Apple Silicon, and macOS Intel"
        );
    };
    let (server_name, desktop_name) = binary_names(platform);
    println!("Checking GitHub for a newer herdr-panels...");
    let body = fetch_latest().await?;
    let current = env!("CARGO_PKG_VERSION");
    match decide(current, &body, Some(platform)).map_err(anyhow::Error::msg)? {
        Decision::UpToDate { current } => {
            println!("herdr-panels {current} is up to date");
            Ok(())
        }
        Decision::Ahead { current, latest } => {
            println!("herdr-panels {current} is newer than the latest release {latest}");
            Ok(())
        }
        Decision::Unsupported => anyhow::bail!(
            "there is no GitHub release for this system. Releases are Linux x64, Windows x64, macOS Apple Silicon, and macOS Intel"
        ),
        Decision::Available { version, name, url } => {
            let targets = programs_to_replace(&exe, desktop_name);
            let mut wanted = vec![server_name];
            if targets.len() > 1 {
                wanted.push(desktop_name);
            }
            println!("Downloading {name}...");
            let archive = download(&url).await?;
            let extracted = extract_binaries(&archive, platform, &wanted).map_err(anyhow::Error::msg)?;
            let mut files = Vec::new();
            for (archive_name, bytes) in extracted {
                let dest = if archive_name == server_name {
                    exe.clone()
                } else {
                    exe.parent()
                        .context("could not find the folder of this program")?
                        .join(desktop_name)
                };
                files.push((dest, bytes));
            }
            let leftovers = install_files(&files).map_err(anyhow::Error::msg)?;
            if targets.len() > 1 {
                println!("Updated herdr-panels and herdr-panels-desktop to {version}.");
            } else {
                println!("Updated herdr-panels to {version}.");
            }
            println!("Restart the viewer to use it.");
            for path in leftovers {
                println!(
                    "An older copy is still at {} because it is running. Delete it after restarting.",
                    path.display()
                );
            }
            Ok(())
        }
    }
}

pub fn current_platform() -> Option<Platform> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some(Platform::LinuxX64),
        ("windows", "x86_64") => Some(Platform::WindowsX64),
        ("macos", "aarch64") => Some(Platform::MacosArm64),
        ("macos", "x86_64") => Some(Platform::MacosX64),
        _ => None,
    }
}

pub fn binary_names(platform: Platform) -> (&'static str, &'static str) {
    match platform {
        Platform::WindowsX64 => ("herdr-panels.exe", "herdr-panels-desktop.exe"),
        Platform::LinuxX64 | Platform::MacosArm64 | Platform::MacosX64 => {
            ("herdr-panels", "herdr-panels-desktop")
        }
    }
}

pub fn decide(current: &str, body: &str, platform: Option<Platform>) -> Result<Decision, String> {
    let Some(platform) = platform else {
        return Ok(Decision::Unsupported);
    };
    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|err| format!("could not read the GitHub release: {err}"))?;
    let tag = value
        .get("tag_name")
        .and_then(serde_json::Value::as_str)
        .ok_or("the GitHub release has no version")?;
    let latest = tag.trim().trim_start_matches('v').to_string();
    if !crate::herdr_ctl::version_newer(&latest, current) {
        if crate::herdr_ctl::version_newer(current, &latest) {
            return Ok(Decision::Ahead {
                current: current.to_string(),
                latest,
            });
        }
        return Ok(Decision::UpToDate {
            current: current.to_string(),
        });
    }
    let name = format!("herdr-panels-{latest}-{}", platform.asset_suffix());
    let assets = value
        .get("assets")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| format!("the {latest} release has no {name}"))?;
    let asset = assets
        .iter()
        .find(|asset| asset.get("name").and_then(serde_json::Value::as_str) == Some(name.as_str()));
    let Some(asset) = asset else {
        return Err(format!("the {latest} release has no {name}"));
    };
    let url = asset
        .get("browser_download_url")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| format!("the {latest} release has no download address for {name}"))?;
    if !url.starts_with(DOWNLOAD_PREFIX) {
        return Err(format!(
            "the {latest} release has an unexpected download address for {name}"
        ));
    }
    Ok(Decision::Available {
        version: latest,
        name,
        url: url.to_string(),
    })
}

pub fn extract_binaries(
    archive: &[u8],
    platform: Platform,
    names: &[&str],
) -> Result<Vec<(String, Vec<u8>)>, String> {
    let found = if platform.is_zip() {
        extract_zip(archive, names)?
    } else {
        extract_tar(archive, names)?
    };
    let mut out = Vec::new();
    for name in names {
        match found.get(*name) {
            Some(bytes) if bytes.is_empty() => {
                return Err(format!("the archive contained an empty {name}"));
            }
            Some(bytes) => out.push(((*name).to_string(), bytes.clone())),
            None => return Err(format!("the archive is missing {name}")),
        }
    }
    Ok(out)
}

fn extract_tar(archive: &[u8], names: &[&str]) -> Result<HashMap<String, Vec<u8>>, String> {
    let decoder = flate2::read::GzDecoder::new(archive);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|err| format!("could not read the release archive: {err}"))?;
    let mut found = HashMap::new();
    for entry in entries {
        let mut entry =
            entry.map_err(|err| format!("could not read the release archive: {err}"))?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry
            .path()
            .map_err(|err| format!("could not read the release archive: {err}"))?;
        let Some(name) = accepted_file_name(&path.to_string_lossy()) else {
            continue;
        };
        if !names.contains(&name.as_str()) || found.contains_key(&name) {
            continue;
        }
        let size = entry.header().size().unwrap_or(0);
        found.insert(name.clone(), read_limited(&mut entry, size, &name)?);
    }
    Ok(found)
}

fn extract_zip(archive: &[u8], names: &[&str]) -> Result<HashMap<String, Vec<u8>>, String> {
    let cursor = std::io::Cursor::new(archive);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|err| format!("could not read the release archive: {err}"))?;
    let mut found = HashMap::new();
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|err| format!("could not read the release archive: {err}"))?;
        if file.is_dir() {
            continue;
        }
        let Some(name) = accepted_file_name(file.name()) else {
            continue;
        };
        if !names.contains(&name.as_str()) || found.contains_key(&name) {
            continue;
        }
        let size = file.size();
        found.insert(name.clone(), read_limited(&mut file, size, &name)?);
    }
    Ok(found)
}

fn accepted_file_name(path: &str) -> Option<String> {
    let normalized = path.replace('\\', "/");
    let mut last = None;
    for part in normalized.split('/').filter(|part| !part.is_empty()) {
        if part == "." || part == ".." {
            return None;
        }
        last = Some(part);
    }
    last.map(str::to_string)
}

fn read_limited(reader: &mut impl Read, size_hint: u64, name: &str) -> Result<Vec<u8>, String> {
    if size_hint > MAX_BINARY {
        return Err(format!("{name} in the archive is larger than expected"));
    }
    let mut bytes = Vec::new();
    reader
        .take(MAX_BINARY + 1)
        .read_to_end(&mut bytes)
        .map_err(|err| format!("could not read {name} from the archive: {err}"))?;
    if bytes.len() as u64 > MAX_BINARY {
        return Err(format!("{name} in the archive is larger than expected"));
    }
    Ok(bytes)
}

pub fn programs_to_replace(exe: &Path, desktop_name: &str) -> Vec<PathBuf> {
    let mut paths = vec![exe.to_path_buf()];
    if let Some(dir) = exe.parent() {
        let desktop = dir.join(desktop_name);
        if desktop.is_file() {
            paths.push(desktop);
        }
    }
    paths
}

pub fn is_development_build(exe: &Path) -> bool {
    let mut after_target = false;
    for component in exe.components() {
        let Some(text) = component.as_os_str().to_str() else {
            continue;
        };
        if after_target && (text == "debug" || text == "release") {
            return true;
        }
        if text == "target" {
            after_target = true;
        }
    }
    false
}

struct Staged {
    dest: PathBuf,
    temp: PathBuf,
    backup: Option<PathBuf>,
}

pub fn install_files(files: &[(PathBuf, Vec<u8>)]) -> Result<Vec<PathBuf>, String> {
    let mut staged = Vec::new();
    for (dest, bytes) in files {
        match stage(dest, bytes) {
            Ok(item) => staged.push(item),
            Err(err) => {
                for item in &staged {
                    let _ = std::fs::remove_file(&item.temp);
                }
                return Err(err);
            }
        }
    }
    let mut swapped: Vec<&Staged> = Vec::new();
    for item in &staged {
        if let Err(err) = swap_in(item) {
            for done in swapped.iter().rev() {
                restore(done);
            }
            for item in &staged {
                let _ = std::fs::remove_file(&item.temp);
            }
            return Err(err);
        }
        swapped.push(item);
    }
    for item in &staged {
        clear_download_mark(&item.dest);
    }
    let mut leftovers = Vec::new();
    for item in staged {
        if let Some(backup) = item.backup {
            if std::fs::remove_file(&backup).is_err() {
                leftovers.push(backup);
            }
        }
    }
    Ok(leftovers)
}

fn stage(dest: &Path, bytes: &[u8]) -> Result<Staged, String> {
    if bytes.is_empty() {
        return Err(format!(
            "{} would be replaced with an empty file",
            dest.display()
        ));
    }
    let parent = dest
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| format!("could not replace {}", dest.display()))?;
    let file_name = dest
        .file_name()
        .ok_or_else(|| format!("could not replace {}", dest.display()))?;
    let temp = parent.join(format!(".{}.download", file_name.to_string_lossy()));
    std::fs::write(&temp, bytes)
        .map_err(|err| format!("could not write {}: {err}", temp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o755))
            .map_err(|err| format!("could not mark {} executable: {err}", temp.display()))?;
    }
    let backup = if dest.exists() {
        Some(unused_backup(dest)?)
    } else {
        None
    };
    Ok(Staged {
        dest: dest.to_path_buf(),
        temp,
        backup,
    })
}

fn unused_backup(dest: &Path) -> Result<PathBuf, String> {
    let parent = dest.parent().unwrap();
    let name = dest.file_name().unwrap().to_string_lossy();
    let mut suffixes = vec![".previous".to_string()];
    suffixes.extend((1..32).map(|index| format!(".previous-{index}")));
    for suffix in suffixes {
        let candidate = parent.join(format!("{name}{suffix}"));
        if !candidate.exists() || std::fs::remove_file(&candidate).is_ok() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "could not move {} aside. Restart the viewer and run herdr-panels update again.",
        dest.display()
    ))
}

fn swap_in(staged: &Staged) -> Result<(), String> {
    if let Some(backup) = &staged.backup {
        std::fs::rename(&staged.dest, backup)
            .map_err(|err| format!("could not move {} aside: {err}", staged.dest.display()))?;
    }
    if let Err(err) = std::fs::rename(&staged.temp, &staged.dest) {
        if let Some(backup) = &staged.backup {
            let _ = std::fs::rename(backup, &staged.dest);
        }
        return Err(format!(
            "could not replace {}: {err}",
            staged.dest.display()
        ));
    }
    Ok(())
}

pub fn download_mark_to_clear(os: &str) -> Option<&'static str> {
    if os == "macos" {
        Some("com.apple.quarantine")
    } else {
        None
    }
}

fn clear_download_mark(path: &Path) {
    let Some(attr) = download_mark_to_clear(std::env::consts::OS) else {
        return;
    };
    let _ = std::process::Command::new("/usr/bin/xattr")
        .args(["-d", attr])
        .arg(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

fn restore(staged: &Staged) {
    let _ = std::fs::remove_file(&staged.dest);
    if let Some(backup) = &staged.backup {
        let _ = std::fs::rename(backup, &staged.dest);
    }
}

async fn fetch_latest() -> anyhow::Result<String> {
    let bytes = fetch(LATEST_URL, Some("application/vnd.github+json")).await?;
    String::from_utf8(bytes).context("could not read the GitHub release")
}

async fn download(url: &str) -> anyhow::Result<Vec<u8>> {
    if !url.starts_with(DOWNLOAD_PREFIX) {
        anyhow::bail!("the release file has an unexpected download address");
    }
    fetch(url, None).await
}

async fn fetch(url: &str, accept: Option<&str>) -> anyhow::Result<Vec<u8>> {
    let client = reqwest::Client::builder()
        .user_agent(format!("herdr-panels/{}", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(180))
        .build()
        .context("could not prepare the GitHub request")?;
    let mut request = client.get(url);
    if let Some(accept) = accept {
        request = request.header(reqwest::header::ACCEPT, accept);
    }
    let response = request.send().await.context("could not reach GitHub")?;
    let status = response.status();
    if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::TOO_MANY_REQUESTS
    {
        anyhow::bail!("GitHub refused the update check. Try again in a little while.");
    }
    if !status.is_success() {
        anyhow::bail!("GitHub returned HTTP {status}");
    }
    let bytes = response
        .bytes()
        .await
        .context("could not download from GitHub")?;
    Ok(bytes.to_vec())
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    fn scratch() -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("hwp-update-{}-{id}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn release_json() -> String {
        r#"{
            "tag_name": "v0.1.3",
            "assets": [
                {
                    "name": "herdr-panels-0.1.3-linux-x64.tar.gz",
                    "browser_download_url": "https://github.com/justengel/herdr-panels/releases/download/v0.1.3/herdr-panels-0.1.3-linux-x64.tar.gz"
                },
                {
                    "name": "herdr-panels-0.1.3-windows-x64.zip",
                    "browser_download_url": "https://github.com/justengel/herdr-panels/releases/download/v0.1.3/herdr-panels-0.1.3-windows-x64.zip"
                },
                {
                    "name": "herdr-panels-0.1.3-macos-arm64.tar.gz",
                    "browser_download_url": "https://github.com/justengel/herdr-panels/releases/download/v0.1.3/herdr-panels-0.1.3-macos-arm64.tar.gz"
                },
                {
                    "name": "herdr-panels-0.1.3-macos-x64.tar.gz",
                    "browser_download_url": "https://github.com/justengel/herdr-panels/releases/download/v0.1.3/herdr-panels-0.1.3-macos-x64.tar.gz"
                }
            ]
        }"#
        .into()
    }

    fn gzip_tar(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut archive = tar::Builder::new(Vec::new());
        for (path, bytes) in files {
            let mut header = tar::Header::new_gnu();
            header.set_path(path).unwrap();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            archive.append(&header, *bytes).unwrap();
        }
        let tar_bytes = archive.into_inner().unwrap();
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&tar_bytes).unwrap();
        encoder.finish().unwrap()
    }

    fn zip_archive(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut cursor = std::io::Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(&mut cursor);
        let options = zip::write::SimpleFileOptions::default();
        for (path, bytes) in files {
            writer.start_file(*path, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
        cursor.into_inner()
    }

    #[test]
    fn a_newer_linux_release_selects_the_linux_archive() {
        let decision = decide("0.1.2", &release_json(), Some(Platform::LinuxX64)).unwrap();
        match decision {
            Decision::Available { version, name, url } => {
                assert_eq!(version, "0.1.3");
                assert_eq!(name, "herdr-panels-0.1.3-linux-x64.tar.gz");
                assert!(url.ends_with("/herdr-panels-0.1.3-linux-x64.tar.gz"));
            }
            other => panic!("expected a download, got {other:?}"),
        }
    }

    #[test]
    fn a_newer_intel_mac_release_selects_the_intel_archive() {
        let decision = decide("0.1.2", &release_json(), Some(Platform::MacosX64)).unwrap();
        match decision {
            Decision::Available { name, .. } => {
                assert_eq!(name, "herdr-panels-0.1.3-macos-x64.tar.gz");
            }
            other => panic!("expected a download, got {other:?}"),
        }
    }

    #[test]
    fn a_newer_windows_release_selects_the_windows_archive() {
        let decision = decide("0.1.2", &release_json(), Some(Platform::WindowsX64)).unwrap();
        match decision {
            Decision::Available { name, .. } => {
                assert_eq!(name, "herdr-panels-0.1.3-windows-x64.zip");
            }
            other => panic!("expected a download, got {other:?}"),
        }
    }

    #[test]
    fn the_same_version_is_up_to_date() {
        let decision = decide("0.1.3", &release_json(), Some(Platform::LinuxX64)).unwrap();
        assert!(matches!(decision, Decision::UpToDate { .. }));
    }

    #[test]
    fn a_local_version_newer_than_the_release_is_not_replaced() {
        let decision = decide("0.1.4", &release_json(), Some(Platform::LinuxX64)).unwrap();
        assert!(matches!(decision, Decision::Ahead { .. }));
    }

    #[test]
    fn a_release_without_this_system_is_an_error() {
        let body = r#"{"tag_name":"v0.1.3","assets":[]}"#;
        let error = decide("0.1.2", body, Some(Platform::MacosArm64)).unwrap_err();
        assert!(error.contains("macos-arm64"), "{error}");
    }

    #[test]
    fn a_download_address_outside_this_repository_is_rejected() {
        let body = r#"{
            "tag_name":"v0.1.3",
            "assets":[{
                "name":"herdr-panels-0.1.3-linux-x64.tar.gz",
                "browser_download_url":"https://example.com/herdr-panels"
            }]
        }"#;
        let error = decide("0.1.2", body, Some(Platform::LinuxX64)).unwrap_err();
        assert!(error.contains("download address"), "{error}");
    }

    #[test]
    fn an_unsupported_system_is_reported() {
        let decision = decide("0.1.2", &release_json(), None).unwrap();
        assert!(matches!(decision, Decision::Unsupported));
    }

    #[test]
    fn this_machine_maps_to_its_release() {
        let expected = match (std::env::consts::OS, std::env::consts::ARCH) {
            ("linux", "x86_64") => Some(Platform::LinuxX64),
            ("windows", "x86_64") => Some(Platform::WindowsX64),
            ("macos", "aarch64") => Some(Platform::MacosArm64),
            ("macos", "x86_64") => Some(Platform::MacosX64),
            _ => None,
        };
        assert_eq!(current_platform(), expected);
    }

    #[test]
    fn linux_and_windows_use_their_own_program_names() {
        assert_eq!(
            binary_names(Platform::LinuxX64),
            ("herdr-panels", "herdr-panels-desktop")
        );
        assert_eq!(
            binary_names(Platform::WindowsX64),
            ("herdr-panels.exe", "herdr-panels-desktop.exe")
        );
        assert_eq!(
            binary_names(Platform::MacosArm64),
            ("herdr-panels", "herdr-panels-desktop")
        );
        assert_eq!(
            binary_names(Platform::MacosX64),
            ("herdr-panels", "herdr-panels-desktop")
        );
    }

    #[test]
    fn a_linux_archive_yields_the_requested_programs() {
        let archive = gzip_tar(&[
            ("herdr-panels-0.1.3-linux-x64/herdr-panels", b"server-bytes"),
            (
                "herdr-panels-0.1.3-linux-x64/herdr-panels-desktop",
                b"desktop-bytes",
            ),
            ("herdr-panels-0.1.3-linux-x64/README.md", b"readme"),
        ]);
        let files = extract_binaries(&archive, Platform::LinuxX64, &["herdr-panels"]).unwrap();
        assert_eq!(
            files,
            vec![("herdr-panels".into(), b"server-bytes".to_vec())]
        );
        let files = extract_binaries(
            &archive,
            Platform::LinuxX64,
            &["herdr-panels", "herdr-panels-desktop"],
        )
        .unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].1, b"server-bytes");
        assert_eq!(files[1].1, b"desktop-bytes");
    }

    #[test]
    fn an_archive_without_the_program_is_an_error() {
        let archive = gzip_tar(&[("herdr-panels-0.1.3-linux-x64/README.md", b"readme")]);
        let error = extract_binaries(&archive, Platform::LinuxX64, &["herdr-panels"]).unwrap_err();
        assert!(error.contains("missing herdr-panels"), "{error}");
    }

    #[test]
    fn a_windows_archive_reads_the_published_layout() {
        let archive = zip_archive(&[
            (
                "herdr-panels-0.1.2-windows-x64/herdr-panels.exe",
                b"server-exe",
            ),
            (
                "herdr-panels-0.1.2-windows-x64/herdr-panels-desktop.exe",
                b"desktop-exe",
            ),
            ("herdr-panels-0.1.2-windows-x64/README.md", b"readme"),
        ]);
        let files = extract_binaries(
            &archive,
            Platform::WindowsX64,
            &["herdr-panels.exe", "herdr-panels-desktop.exe"],
        )
        .unwrap();
        assert_eq!(files[0].1, b"server-exe");
        assert_eq!(files[1].1, b"desktop-exe");
    }

    #[test]
    fn a_windows_archive_reads_backslash_paths() {
        let archive = zip_archive(&[
            (
                "herdr-panels-0.1.3-windows-x64\\herdr-panels.exe",
                b"server-exe",
            ),
            (
                "herdr-panels-0.1.3-windows-x64\\herdr-panels-desktop.exe",
                b"desktop-exe",
            ),
        ]);
        let files = extract_binaries(
            &archive,
            Platform::WindowsX64,
            &["herdr-panels.exe", "herdr-panels-desktop.exe"],
        )
        .unwrap();
        assert_eq!(files[0].1, b"server-exe");
        assert_eq!(files[1].1, b"desktop-exe");
    }

    #[test]
    fn only_macos_clears_the_browser_download_mark() {
        assert_eq!(
            download_mark_to_clear("macos"),
            Some("com.apple.quarantine")
        );
        assert_eq!(download_mark_to_clear("linux"), None);
        assert_eq!(download_mark_to_clear("windows"), None);
    }

    #[test]
    fn a_path_that_climbs_out_of_the_archive_is_ignored() {
        assert_eq!(accepted_file_name("../../herdr-panels"), None);
        assert_eq!(accepted_file_name(r"..\herdr-panels.exe"), None);
        assert_eq!(
            accepted_file_name("herdr-panels-0.1.3-linux-x64/herdr-panels").as_deref(),
            Some("herdr-panels")
        );
        assert_eq!(
            accepted_file_name(r"folder\herdr-panels.exe").as_deref(),
            Some("herdr-panels.exe")
        );
    }

    #[test]
    fn the_desktop_program_is_replaced_only_when_it_is_already_installed() {
        let dir = scratch();
        let exe = dir.join("herdr-panels");
        std::fs::write(&exe, b"server").unwrap();
        assert_eq!(
            programs_to_replace(&exe, "herdr-panels-desktop"),
            vec![exe.clone()]
        );
        let desktop = dir.join("herdr-panels-desktop");
        std::fs::write(&desktop, b"desktop").unwrap();
        assert_eq!(
            programs_to_replace(&exe, "herdr-panels-desktop"),
            vec![exe, desktop]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_replaces_the_programs_it_is_given() {
        let dir = scratch();
        let server = dir.join("herdr-panels");
        let desktop = dir.join("herdr-panels-desktop");
        std::fs::write(&server, b"old-server").unwrap();
        std::fs::write(&desktop, b"old-desktop").unwrap();
        let leftovers = install_files(&[
            (server.clone(), b"new-server".to_vec()),
            (desktop.clone(), b"new-desktop".to_vec()),
        ])
        .unwrap();
        assert!(leftovers.is_empty());
        assert_eq!(std::fs::read(&server).unwrap(), b"new-server");
        assert_eq!(std::fs::read(&desktop).unwrap(), b"new-desktop");
        assert!(!dir.join("herdr-panels.previous").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn install_marks_the_program_executable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch();
        let server = dir.join("herdr-panels");
        std::fs::write(&server, b"old").unwrap();
        install_files(&[(server.clone(), b"new".to_vec())]).unwrap();
        let mode = std::fs::metadata(&server).unwrap().permissions().mode();
        assert_ne!(mode & 0o111, 0, "mode {mode:o}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_cargo_target_directory_is_a_development_build() {
        assert!(is_development_build(Path::new(
            "/work/herdr-panels/target/release/herdr-panels"
        )));
        #[cfg(windows)]
        assert!(is_development_build(Path::new(
            r"C:\work\herdr-panels\target\debug\herdr-panels.exe"
        )));
        #[cfg(not(windows))]
        assert!(!is_development_build(Path::new(
            r"C:\work\herdr-panels\target\debug\herdr-panels.exe"
        )));
        assert!(is_development_build(Path::new(
            "/work/herdr-panels/target/x86_64-unknown-linux-gnu/release/herdr-panels"
        )));
        assert!(!is_development_build(Path::new(
            "/home/someone/herdr-panels/herdr-panels"
        )));
        assert!(!is_development_build(Path::new(
            "/home/target/bin/herdr-panels"
        )));
    }
}
