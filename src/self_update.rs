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
        println!(
            "Download and install the latest GitHub release. A viewer that is already running is stopped and started again on the same address.\n\nUsage: herdr-panels update"
        );
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
            let outcome = restart_installed_viewer(&exe).await;
            for path in &leftovers {
                let _ = std::fs::remove_file(path);
            }
            let still: Vec<_> = leftovers.into_iter().filter(|path| path.exists()).collect();
            let desktop_replaced = targets.len() > 1;
            match outcome {
                Ok(outcome) => {
                    for line in update_result_lines(&version, desktop_replaced, &outcome) {
                        println!("{line}");
                    }
                    for path in still {
                        println!(
                            "An older copy is still at {} because it is running. Delete it after the new viewer is the one you are using.",
                            path.display()
                        );
                    }
                    Ok(())
                }
                Err(err) => {
                    for line in update_result_lines(
                        &version,
                        desktop_replaced,
                        &RestartOutcome::NotRunning,
                    ) {
                        if line.starts_with("Updated ") {
                            println!("{line}");
                        }
                    }
                    Err(anyhow::Error::msg(err))
                }
            }
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

/// What `herdr-panels update` should do with a viewer after the new files are in place.
#[derive(Debug, PartialEq, Eq)]
pub enum ViewerRestart {
    NotRunning,
    Restart {
        pid: u32,
        server_args: Vec<String>,
        open_desktop: bool,
    },
    CouldNotFind {
        url: String,
    },
}

/// What to tell the user after the files were replaced.
#[derive(Debug, PartialEq, Eq)]
pub enum RestartOutcome {
    Restarted { url: String, desktop: bool },
    NotRunning,
    CouldNotFind { url: String },
}

pub fn viewer_restart(
    url: &str,
    running: bool,
    server_pid: Option<u32>,
    desktop_was_open: bool,
) -> ViewerRestart {
    if !running {
        return ViewerRestart::NotRunning;
    }
    let Some(pid) = server_pid else {
        return ViewerRestart::CouldNotFind {
            url: url.to_string(),
        };
    };
    match relaunch_server_args(url) {
        Ok(server_args) => ViewerRestart::Restart {
            pid,
            server_args,
            open_desktop: desktop_was_open,
        },
        Err(_) => ViewerRestart::CouldNotFind {
            url: url.to_string(),
        },
    }
}

pub fn relaunch_server_args(url: &str) -> Result<Vec<String>, String> {
    let parsed = url::Url::parse(url).map_err(|_| format!("could not read {url}"))?;
    if parsed.scheme() != "http" {
        return Err(format!("{url} is not an http address"));
    }
    let host = parsed
        .host_str()
        .filter(|host| !host.is_empty())
        .ok_or_else(|| format!("could not read {url}"))?;
    let port = parsed
        .port()
        .ok_or_else(|| format!("could not read the port in {url}"))?;
    Ok(vec![
        "server".to_string(),
        "--host".to_string(),
        host.to_string(),
        "--port".to_string(),
        port.to_string(),
    ])
}

pub fn choose_server_pid(
    recorded: Option<u32>,
    recorded_alive_server: bool,
    listeners: &[u32],
    listener_is_server: impl Fn(u32) -> bool,
) -> Option<u32> {
    if recorded_alive_server {
        if let Some(pid) = recorded {
            return Some(pid);
        }
    }
    let matches: Vec<u32> = listeners
        .iter()
        .copied()
        .filter(|pid| listener_is_server(*pid))
        .collect();
    if matches.len() == 1 {
        Some(matches[0])
    } else {
        None
    }
}

pub fn server_image(path: &str) -> bool {
    image_stem(path) == "herdr-panels"
}

pub fn desktop_image(path: &str) -> bool {
    image_stem(path) == "herdr-panels-desktop"
}

fn image_stem(path: &str) -> &str {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let name = name.strip_suffix(" (deleted)").unwrap_or(name);
    let name = match name.split_once(".previous") {
        Some((head, _)) => head,
        None => name,
    };
    name.strip_suffix(".exe").unwrap_or(name)
}

pub fn pid_in_server_record(text: &str) -> Option<u32> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let pid = value.get("pid")?.as_u64()?;
    u32::try_from(pid).ok().filter(|pid| *pid > 0)
}

pub fn listen_inodes(table: &str, port: u16) -> Vec<u64> {
    let mut inodes = Vec::new();
    for line in table.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 10 {
            continue;
        }
        let Some((_, port_hex)) = cols[1].rsplit_once(':') else {
            continue;
        };
        let Ok(found) = u16::from_str_radix(port_hex, 16) else {
            continue;
        };
        if found != port || !cols[3].eq_ignore_ascii_case("0A") {
            continue;
        }
        if let Ok(inode) = cols[9].parse::<u64>() {
            inodes.push(inode);
        }
    }
    inodes
}

pub fn pids_listening(text: &str, port: u16) -> Vec<u32> {
    let mut pids = Vec::new();
    for line in text.lines() {
        if !line.to_ascii_uppercase().contains("LISTEN") {
            continue;
        }
        let cols: Vec<&str> = line.split_whitespace().collect();
        let Some(local) = cols.iter().find(|col| col.contains(':')) else {
            continue;
        };
        let Some((_, found)) = local.rsplit_once(':') else {
            continue;
        };
        if found != port.to_string() {
            continue;
        }
        let Some(pid) = cols.last().and_then(|col| col.parse::<u32>().ok()) else {
            continue;
        };
        if pid != 0 && !pids.contains(&pid) {
            pids.push(pid);
        }
    }
    pids
}

pub fn update_result_lines(
    version: &str,
    desktop_replaced: bool,
    outcome: &RestartOutcome,
) -> Vec<String> {
    let mut lines = Vec::new();
    if desktop_replaced {
        lines.push(format!(
            "Updated herdr-panels and herdr-panels-desktop to {version}."
        ));
    } else {
        lines.push(format!("Updated herdr-panels to {version}."));
    }
    match outcome {
        RestartOutcome::Restarted { url, desktop: true } => {
            lines.push(format!(
                "Restarted the viewer at {url} and opened the desktop window."
            ));
        }
        RestartOutcome::Restarted {
            url,
            desktop: false,
        } => {
            lines.push(format!("Restarted the viewer at {url}."));
        }
        RestartOutcome::NotRunning => {
            lines.push("The next launch uses it.".to_string());
        }
        RestartOutcome::CouldNotFind { url } => {
            lines.push(format!(
                "A viewer is still running at {url}. Stop that process and start herdr-panels again."
            ));
        }
    }
    lines
}

/// Stop the herdr-panels process listening for a viewer from another build.
/// A recorded pid is used only when that process is herdr-panels or the desktop.
pub fn stop_mismatched_viewer(config_dir: &Path, port: u16) -> Result<(), String> {
    let recorded = recorded_pid(config_dir);
    let image = recorded.and_then(process_image);
    let listeners = listener_pids(port);
    let pairs: Vec<(u32, String)> = listeners
        .into_iter()
        .filter_map(|pid| process_image(pid).map(|image| (pid, image)))
        .collect();
    let listed: Vec<(u32, &str)> = pairs
        .iter()
        .map(|(pid, image)| (*pid, image.as_str()))
        .collect();
    let pid = crate::launch::stale_viewer_pid(recorded, image.as_deref(), &listed)?;
    if pid == std::process::id() {
        return Err("refusing to stop this process".into());
    }
    stop_process(pid)
}

pub fn stop_process(pid: u32) -> Result<(), String> {
    if !process_running(pid) {
        return Ok(());
    }
    #[cfg(windows)]
    {
        let mut command = std::process::Command::new("taskkill");
        command
            .args(["/PID", &pid.to_string(), "/F"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        crate::quiet_process::quiet(&mut command);
        let status = command
            .status()
            .map_err(|err| format!("could not stop process {pid}: {err}"))?;
        if !status.success() && process_running(pid) {
            return Err(format!("could not stop process {pid}"));
        }
    }
    #[cfg(unix)]
    {
        signal_process(pid, 15)?;
        let start = std::time::Instant::now();
        while process_running(pid) && start.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(30));
        }
        if process_running(pid) {
            signal_process(pid, 9)?;
        }
    }
    let start = std::time::Instant::now();
    while process_running(pid) && start.elapsed() < Duration::from_secs(3) {
        std::thread::sleep(Duration::from_millis(30));
    }
    if process_running(pid) {
        Err(format!("process {pid} did not exit"))
    } else {
        Ok(())
    }
}

async fn restart_installed_viewer(exe: &Path) -> Result<RestartOutcome, String> {
    let config_dir = update_config_dir();
    let url = config_dir
        .as_ref()
        .and_then(|dir| crate::launch::recorded_url(dir))
        .unwrap_or_else(|| "http://127.0.0.1:4737".to_string());
    let token = config_dir
        .as_ref()
        .and_then(|dir| crate::launch::existing_token(dir));
    let running = matches!(
        crate::launch::inspect(&url, token.as_deref()).await,
        crate::launch::Probe::Up
    );
    if !running {
        return Ok(RestartOutcome::NotRunning);
    }
    let port = url::Url::parse(&url)
        .ok()
        .and_then(|parsed| parsed.port())
        .unwrap_or(4737);
    let recorded = config_dir.as_ref().and_then(|dir| recorded_pid(dir));
    let recorded_alive_server = recorded.is_some_and(|pid| {
        process_running(pid) && process_image(pid).is_some_and(|image| server_image(&image))
    });
    let listeners = listener_pids(port);
    let pid = choose_server_pid(recorded, recorded_alive_server, &listeners, |candidate| {
        process_image(candidate).is_some_and(|image| server_image(&image))
    });
    let desktops = exe.parent().map(desktop_pids_beside).unwrap_or_default();
    match viewer_restart(&url, true, pid, !desktops.is_empty()) {
        ViewerRestart::NotRunning => Ok(RestartOutcome::NotRunning),
        ViewerRestart::CouldNotFind { url } => Ok(RestartOutcome::CouldNotFind { url }),
        ViewerRestart::Restart {
            pid,
            server_args,
            open_desktop,
        } => {
            for desktop in &desktops {
                stop_process(*desktop)?;
            }
            stop_process(pid)?;
            wait_until_not_up(&url, token.as_deref()).await?;
            spawn_detached(exe, &server_args, &[])?;
            wait_until_up(&url, token.as_deref()).await?;
            let mut opened = false;
            if open_desktop {
                if let Some(desktop) = exe.parent().and_then(desktop_binary) {
                    spawn_detached(&desktop, &[], &[("HERDR_PANELS_URL", url.as_str())])?;
                    opened = true;
                }
            }
            Ok(RestartOutcome::Restarted {
                url,
                desktop: opened,
            })
        }
    }
}

fn update_config_dir() -> Option<PathBuf> {
    if let Some(value) = std::env::var_os("HERDR_PANELS_CONFIG") {
        if !value.is_empty() {
            return Some(PathBuf::from(value));
        }
    }
    crate::paths::app_config_dir().ok()
}

fn recorded_pid(dir: &Path) -> Option<u32> {
    let text = std::fs::read_to_string(dir.join("server.json")).ok()?;
    pid_in_server_record(&text)
}

fn desktop_binary(dir: &Path) -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "herdr-panels-desktop.exe"
    } else {
        "herdr-panels-desktop"
    };
    let path = dir.join(name);
    path.is_file().then_some(path)
}

fn desktop_pids_beside(install_dir: &Path) -> Vec<u32> {
    listed_pids()
        .into_iter()
        .filter(|pid| {
            process_image(*pid).is_some_and(|image| {
                desktop_image(&image) && parent_is_install(&image, install_dir)
            })
        })
        .collect()
}

fn parent_is_install(image: &str, install_dir: &Path) -> bool {
    let trimmed = image.trim().trim_end_matches(" (deleted)");
    let Some(parent) = Path::new(trimmed).parent() else {
        return false;
    };
    if parent == install_dir {
        return true;
    }
    #[cfg(windows)]
    {
        parent
            .to_string_lossy()
            .eq_ignore_ascii_case(&install_dir.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        let _ = parent;
        false
    }
}

async fn wait_until_not_up(url: &str, token: Option<&str>) -> Result<(), String> {
    let start = std::time::Instant::now();
    while start.elapsed() < Duration::from_secs(5) {
        if !matches!(
            crate::launch::inspect(url, token).await,
            crate::launch::Probe::Up
        ) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err(format!(
        "the viewer at {url} did not stop. Stop that process and start herdr-panels again."
    ))
}

async fn wait_until_up(url: &str, token: Option<&str>) -> Result<(), String> {
    let start = std::time::Instant::now();
    while start.elapsed() < Duration::from_secs(15) {
        if matches!(
            crate::launch::inspect(url, token).await,
            crate::launch::Probe::Up
        ) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(format!(
        "stopped the old viewer, but the new one did not start at {url}. Start herdr-panels again."
    ))
}

fn spawn_detached(exe: &Path, args: &[String], extra_env: &[(&str, &str)]) -> Result<(), String> {
    let mut command = std::process::Command::new(exe);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    for (key, value) in extra_env {
        command.env(key, value);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                extern "C" {
                    fn setsid() -> i32;
                }
                if setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("could not start {}: {err}", exe.display()))
}

fn listener_pids(port: u16) -> Vec<u32> {
    #[cfg(windows)]
    {
        windows_listener_pids(port)
    }
    #[cfg(target_os = "linux")]
    {
        linux_listener_pids(port)
    }
    #[cfg(target_os = "macos")]
    {
        macos_listener_pids(port)
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        let _ = port;
        Vec::new()
    }
}

#[cfg(windows)]
fn windows_listener_pids(port: u16) -> Vec<u32> {
    let pids = tcp_table_listener_pids(port);
    if !pids.is_empty() {
        return pids;
    }
    command_output("netstat", &["-ano", "-p", "TCP"])
        .map(|text| pids_listening(&text, port))
        .unwrap_or_default()
}

#[cfg(windows)]
fn tcp_table_listener_pids(port: u16) -> Vec<u32> {
    #[link(name = "iphlpapi")]
    extern "system" {
        fn GetExtendedTcpTable(
            table: *mut std::ffi::c_void,
            size: *mut u32,
            order: i32,
            af: u32,
            class: i32,
            reserved: u32,
        ) -> u32;
    }
    const AF_INET: u32 = 2;
    const TCP_TABLE_OWNER_PID_LISTENER: i32 = 3;
    const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
    #[repr(C)]
    struct Row {
        state: u32,
        local_addr: u32,
        local_port: u32,
        remote_addr: u32,
        remote_port: u32,
        owning_pid: u32,
    }
    unsafe {
        let mut size = 0u32;
        let first = GetExtendedTcpTable(
            std::ptr::null_mut(),
            &mut size,
            0,
            AF_INET,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        );
        if first != ERROR_INSUFFICIENT_BUFFER && first != 0 {
            return Vec::new();
        }
        if size < 4 {
            return Vec::new();
        }
        let mut buffer = vec![0u8; size as usize];
        let status = GetExtendedTcpTable(
            buffer.as_mut_ptr() as *mut std::ffi::c_void,
            &mut size,
            0,
            AF_INET,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        );
        if status != 0 || buffer.len() < 4 {
            return Vec::new();
        }
        let count = u32::from_ne_bytes([buffer[0], buffer[1], buffer[2], buffer[3]]) as usize;
        let row_size = std::mem::size_of::<Row>();
        let available = buffer.len().saturating_sub(4) / row_size;
        let mut pids = Vec::new();
        for index in 0..count.min(available) {
            let start = 4 + index * row_size;
            let row = std::ptr::read_unaligned(buffer[start..].as_ptr() as *const Row);
            let found = u16::from_be(row.local_port as u16);
            if found == port && row.owning_pid != 0 && !pids.contains(&row.owning_pid) {
                pids.push(row.owning_pid);
            }
        }
        pids
    }
}

#[cfg(target_os = "linux")]
fn linux_listener_pids(port: u16) -> Vec<u32> {
    let mut inodes = Vec::new();
    for name in ["/proc/net/tcp", "/proc/net/tcp6"] {
        if let Ok(text) = std::fs::read_to_string(name) {
            inodes.extend(listen_inodes(&text, port));
        }
    }
    let mut pids = Vec::new();
    for inode in inodes {
        if let Some(pid) = pid_for_socket_inode(inode) {
            if !pids.contains(&pid) {
                pids.push(pid);
            }
        }
    }
    pids
}

#[cfg(target_os = "linux")]
fn pid_for_socket_inode(inode: u64) -> Option<u32> {
    let needle = format!("socket:[{inode}]");
    let entries = std::fs::read_dir("/proc").ok()?;
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(fds) = std::fs::read_dir(entry.path().join("fd")) else {
            continue;
        };
        for fd in fds.flatten() {
            let Ok(target) = std::fs::read_link(fd.path()) else {
                continue;
            };
            if target.to_string_lossy() == needle {
                return Some(pid);
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn macos_listener_pids(port: u16) -> Vec<u32> {
    let query = format!("-iTCP:{port}");
    command_output("lsof", &["-nP", &query, "-sTCP:LISTEN", "-t"])
        .map(|text| {
            text.split_whitespace()
                .filter_map(|item| item.parse().ok())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(any(windows, target_os = "macos"))]
fn command_output(program: &str, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    String::from_utf8(output.stdout).ok()
}

fn process_image(pid: u32) -> Option<String> {
    #[cfg(windows)]
    {
        windows_process_image(pid)
    }
    #[cfg(target_os = "linux")]
    {
        std::fs::read_link(format!("/proc/{pid}/exe"))
            .ok()
            .map(|path| path.to_string_lossy().into_owned())
    }
    #[cfg(target_os = "macos")]
    {
        command_output("ps", &["-p", &pid.to_string(), "-o", "command="]).and_then(|text| {
            let line = text.trim();
            if line.is_empty() {
                None
            } else {
                Some(line.split_whitespace().next()?.to_string())
            }
        })
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        None
    }
}

#[cfg(windows)]
fn windows_process_image(pid: u32) -> Option<String> {
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
        fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        fn QueryFullProcessImageNameW(
            process: *mut std::ffi::c_void,
            flags: u32,
            name: *mut u16,
            size: *mut u32,
        ) -> i32;
    }
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(handle);
        if ok == 0 {
            return None;
        }
        buf.truncate(len as usize);
        use std::os::windows::ffi::OsStringExt;
        Some(
            std::ffi::OsString::from_wide(&buf)
                .to_string_lossy()
                .into_owned(),
        )
    }
}

fn process_running(pid: u32) -> bool {
    #[cfg(windows)]
    {
        windows_process_running(pid)
    }
    #[cfg(target_os = "linux")]
    {
        linux_process_running(pid)
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        unix_process_running(pid)
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = pid;
        false
    }
}

#[cfg(windows)]
fn windows_process_running(pid: u32) -> bool {
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
        fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        fn GetExitCodeProcess(process: *mut std::ffi::c_void, code: *mut u32) -> i32;
    }
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok != 0 && code == STILL_ACTIVE
    }
}

#[cfg(target_os = "linux")]
fn linux_process_running(pid: u32) -> bool {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return false;
    };
    let Some((_, after)) = stat.rsplit_once(')') else {
        return false;
    };
    let state = after.trim_start().chars().next();
    matches!(state, Some(state) if state != 'Z' && state != 'X')
}

#[cfg(all(unix, not(target_os = "linux")))]
fn unix_process_running(pid: u32) -> bool {
    let Some(text) = command_output("ps", &["-o", "stat=", "-p", &pid.to_string()]) else {
        return false;
    };
    let text = text.trim();
    !text.is_empty() && !text.starts_with('Z')
}

#[cfg(unix)]
fn signal_process(pid: u32, signal: i32) -> Result<(), String> {
    let status = std::process::Command::new("kill")
        .arg(format!("-{signal}"))
        .arg(pid.to_string())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|err| format!("could not stop process {pid}: {err}"))?;
    if status.success() || !process_running(pid) {
        Ok(())
    } else {
        Err(format!("could not stop process {pid}"))
    }
}

fn listed_pids() -> Vec<u32> {
    #[cfg(windows)]
    {
        windows_pids()
    }
    #[cfg(target_os = "linux")]
    {
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return Vec::new();
        };
        entries
            .flatten()
            .filter_map(|entry| entry.file_name().to_string_lossy().parse().ok())
            .collect()
    }
    #[cfg(target_os = "macos")]
    {
        command_output("ps", &["-ax", "-o", "pid="])
            .map(|text| {
                text.split_whitespace()
                    .filter_map(|item| item.parse().ok())
                    .collect()
            })
            .unwrap_or_default()
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        Vec::new()
    }
}

#[cfg(windows)]
fn windows_pids() -> Vec<u32> {
    #[repr(C)]
    struct ProcessEntry {
        size: u32,
        cnt_usage: u32,
        pid: u32,
        heap: usize,
        module: u32,
        threads: u32,
        parent: u32,
        priority: i32,
        flags: u32,
        exe: [u16; 260],
    }
    extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> *mut std::ffi::c_void;
        fn Process32FirstW(snap: *mut std::ffi::c_void, entry: *mut ProcessEntry) -> i32;
        fn Process32NextW(snap: *mut std::ffi::c_void, entry: *mut ProcessEntry) -> i32;
        fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    }
    const TH32CS_SNAPPROCESS: u32 = 0x00000002;
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == -1isize as *mut std::ffi::c_void || snap.is_null() {
            return Vec::new();
        }
        let mut entry = std::mem::zeroed::<ProcessEntry>();
        entry.size = std::mem::size_of::<ProcessEntry>() as u32;
        let mut pids = Vec::new();
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                if entry.pid != 0 {
                    pids.push(entry.pid);
                }
                entry.size = std::mem::size_of::<ProcessEntry>() as u32;
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
        pids
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

    #[test]
    fn update_restarts_a_running_viewer_and_reopens_its_window() {
        assert_eq!(
            viewer_restart("http://127.0.0.1:4737", true, Some(42), true),
            ViewerRestart::Restart {
                pid: 42,
                server_args: vec![
                    "server".into(),
                    "--host".into(),
                    "127.0.0.1".into(),
                    "--port".into(),
                    "4737".into(),
                ],
                open_desktop: true,
            }
        );
    }

    #[test]
    fn update_leaves_a_stopped_viewer_stopped() {
        assert_eq!(
            viewer_restart("http://127.0.0.1:4737", false, None, false),
            ViewerRestart::NotRunning
        );
    }

    #[test]
    fn update_does_not_guess_when_the_viewer_process_is_unknown() {
        assert_eq!(
            viewer_restart("http://127.0.0.1:48001", true, None, false),
            ViewerRestart::CouldNotFind {
                url: "http://127.0.0.1:48001".into(),
            }
        );
    }

    #[test]
    fn the_recorded_process_wins_and_one_listener_is_the_fallback() {
        assert_eq!(choose_server_pid(Some(7), true, &[8], |_| true), Some(7));
        assert_eq!(choose_server_pid(Some(7), false, &[8], |_| true), Some(8));
        assert_eq!(choose_server_pid(None, false, &[8, 9], |_| true), None);
        assert_eq!(choose_server_pid(None, false, &[8], |_| false), None);
    }

    #[test]
    fn a_renamed_running_image_is_still_the_server() {
        assert!(server_image("herdr-panels"));
        assert!(server_image("herdr-panels.exe"));
        assert!(server_image("herdr-panels.exe.previous"));
        assert!(server_image(
            r"C:\Users\x\.local\bin\herdr-panels.exe.previous-2"
        ));
        assert!(server_image("/usr/local/bin/herdr-panels (deleted)"));
        assert!(!server_image("herdr-panels-desktop"));
        assert!(!server_image("herdr-panels-desktop.exe"));
        assert!(!server_image("herdr-panels-desktop.exe.previous"));
        assert!(!server_image("nginx"));
    }

    #[test]
    fn the_desktop_window_is_separate_from_the_server() {
        assert!(desktop_image("herdr-panels-desktop"));
        assert!(desktop_image("/home/x/.local/bin/herdr-panels-desktop"));
        assert!(desktop_image("herdr-panels-desktop.exe.previous"));
        assert!(!desktop_image("herdr-panels"));
        assert!(!desktop_image("herdr-panels.exe"));
    }

    #[test]
    fn server_record_keeps_the_listener_pid() {
        assert_eq!(
            pid_in_server_record(r#"{"url":"http://127.0.0.1:4737","pid":4242}"#),
            Some(4242)
        );
        assert_eq!(
            pid_in_server_record(r#"{"url":"http://127.0.0.1:4737"}"#),
            None
        );
        assert_eq!(pid_in_server_record(r#"{"pid":0}"#), None);
    }

    #[test]
    fn the_saved_server_record_includes_this_process() {
        let dir = scratch();
        crate::client::record_server(&dir, "http://127.0.0.1:47991").unwrap();
        let text = std::fs::read_to_string(dir.join("server.json")).unwrap();
        assert_eq!(pid_in_server_record(&text), Some(std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn proc_net_tcp_finds_the_listening_socket() {
        let table = "\
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1281 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 555 1 0000000000000000 100 0 0 10 0
   1: 0100007F:1282 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 556 1 0000000000000000 100 0 0 10 0
   2: 0100007F:1281 0100007F:1F90 01 00000000:00000000 00:00000000 00000000     0        0 557 1 0000000000000000 100 0 0 10 0
";
        assert_eq!(listen_inodes(table, 4737), vec![555]);
    }

    #[test]
    fn netstat_finds_the_listening_pid() {
        let text = "\
  TCP    127.0.0.1:4737         0.0.0.0:0              LISTENING       4242
  TCP    127.0.0.1:47370        0.0.0.0:0              LISTENING       99
  TCP    127.0.0.1:80           127.0.0.1:4737         ESTABLISHED     7
";
        assert_eq!(pids_listening(text, 4737), vec![4242]);
    }

    #[test]
    fn stopping_a_process_ends_it() {
        let mut child = long_sleeper();
        let pid = child.id();
        let stopped = stop_process(pid);
        let exited = wait_until_exited(&mut child, Duration::from_secs(4));
        if !exited {
            let _ = child.kill();
            let _ = child.wait();
        }
        assert!(stopped.is_ok(), "{stopped:?}");
        assert!(exited, "process {pid} was still running");
    }

    #[test]
    fn a_restart_says_the_viewer_is_running_again() {
        let lines = update_result_lines(
            "0.1.7",
            true,
            &RestartOutcome::Restarted {
                url: "http://127.0.0.1:4737".into(),
                desktop: true,
            },
        );
        assert!(
            lines
                .iter()
                .any(|line| line.contains("herdr-panels-desktop")),
            "{lines:?}"
        );
        assert!(
            lines
                .iter()
                .any(|line| line.contains("Restarted the viewer at http://127.0.0.1:4737")),
            "{lines:?}"
        );
        assert!(
            lines.iter().any(|line| line.contains("desktop window")),
            "{lines:?}"
        );
        assert!(
            lines
                .iter()
                .all(|line| !line.contains("Restart the viewer")),
            "{lines:?}"
        );
    }

    fn long_sleeper() -> std::process::Child {
        #[cfg(windows)]
        {
            std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 40"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap()
        }
        #[cfg(not(windows))]
        {
            std::process::Command::new("sleep")
                .arg("40")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap()
        }
    }

    fn wait_until_exited(child: &mut std::process::Child, limit: Duration) -> bool {
        let start = std::time::Instant::now();
        while start.elapsed() < limit {
            if child.try_wait().ok().flatten().is_some() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(30));
        }
        child.try_wait().ok().flatten().is_some()
    }

    #[test]
    fn a_bound_port_belongs_to_this_process() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let pids = listener_pids(port);
        assert!(
            pids.contains(&std::process::id()),
            "port {port} pids {pids:?}"
        );
    }

    #[tokio::test]
    async fn a_running_server_is_replaced_by_a_new_process() {
        let current = std::env::current_exe().unwrap();
        let exe = current
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join(if cfg!(windows) {
                "herdr-panels.exe"
            } else {
                "herdr-panels"
            });
        assert!(
            exe.is_file(),
            "missing {} — build herdr-panels before this test",
            exe.display()
        );
        let dir = scratch();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let url = format!("http://127.0.0.1:{port}");
        let config = dir.to_string_lossy().into_owned();
        let port_text = port.to_string();
        let socket = dir
            .join("missing-herdr.sock")
            .to_string_lossy()
            .into_owned();
        let mut child = std::process::Command::new(&exe)
            .args([
                "server",
                "--config",
                &config,
                "--port",
                &port_text,
                "--herdr-socket",
                &socket,
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let old_pid = child.id();
        let started = std::time::Instant::now();
        let mut up = false;
        while started.elapsed() < Duration::from_secs(8) {
            if matches!(
                crate::launch::inspect(&url, None).await,
                crate::launch::Probe::Up
            ) {
                up = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if !up {
            let _ = child.kill();
            let _ = child.wait();
            panic!("viewer did not start on {url}");
        }

        let previous = std::env::var_os("HERDR_PANELS_CONFIG");
        std::env::set_var("HERDR_PANELS_CONFIG", &dir);
        let outcome = restart_installed_viewer(&exe).await;
        match &previous {
            Some(value) => std::env::set_var("HERDR_PANELS_CONFIG", value),
            None => std::env::remove_var("HERDR_PANELS_CONFIG"),
        }
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(err) => {
                let _ = stop_process(old_pid);
                let _ = child.wait();
                panic!("{err}");
            }
        };
        assert_eq!(
            outcome,
            RestartOutcome::Restarted {
                url: url.clone(),
                desktop: false,
            }
        );
        let _ = child.wait();
        assert!(
            !process_running(old_pid),
            "old viewer {old_pid} is still running"
        );
        let text = std::fs::read_to_string(dir.join("server.json")).unwrap();
        let new_pid = pid_in_server_record(&text).expect("new pid");
        assert_ne!(new_pid, old_pid);
        assert!(
            process_running(new_pid),
            "new viewer {new_pid} is not running"
        );
        assert!(matches!(
            crate::launch::inspect(&url, None).await,
            crate::launch::Probe::Up
        ));
        stop_process(new_pid).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn this_process_has_an_image_and_is_in_the_process_list() {
        let image = process_image(std::process::id()).expect("process image");
        assert!(!server_image(&image), "{image}");
        assert!(
            listed_pids().contains(&std::process::id()),
            "process list omitted {}",
            std::process::id()
        );
    }
}
