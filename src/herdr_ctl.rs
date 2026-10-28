//! Start, update, and report Herdr from the panels server.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::paths::{self, herdr_config_dir, named_session_dir};
use crate::session_proc;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HerdrCtlStatus {
    pub client_version: Option<String>,
    pub channel: Option<String>,
    pub server_running: bool,
    pub restart_needed: bool,
    pub server_binary_stale: bool,
    pub update_available: bool,
    pub latest_version: Option<String>,
}

pub async fn status(http: &reqwest::Client) -> HerdrCtlStatus {
    let raw = read_status_json();
    let client_version = raw
        .as_ref()
        .and_then(|value| value.pointer("/client/version"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let channel = raw
        .as_ref()
        .and_then(|value| value.pointer("/client/channel"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let server_running = raw
        .as_ref()
        .and_then(|value| value.pointer("/server/running"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let restart_needed = flag(raw.as_ref(), "/update/restart_needed")
        || flag(raw.as_ref(), "/server/restart_needed");
    let server_binary_stale = flag(raw.as_ref(), "/update/server_binary_stale")
        || flag(raw.as_ref(), "/server/server_binary_stale");

    let latest_version = match latest_manifest(http, channel.as_deref().unwrap_or("stable")).await {
        Ok(version) => version,
        Err(err) => {
            tracing::debug!("herdr update check skipped: {err}");
            None
        }
    };
    let update_available = match (&latest_version, &client_version) {
        (Some(latest), Some(current)) => version_newer(latest, current),
        _ => false,
    };

    HerdrCtlStatus {
        client_version,
        channel,
        server_running,
        restart_needed,
        server_binary_stale,
        update_available,
        latest_version,
    }
}

pub async fn start(session: &str) -> Result<PathBuf, String> {
    if session == "default" {
        let socket = herdr_config_dir()
            .map_err(|err| err.to_string())?
            .join("herdr.sock");
        if !server_listening(&socket) {
            spawn_server(None)?;
            wait_for_server(&socket).await?;
        }
        Ok(socket)
    } else {
        session_proc::start_session(session).await
    }
}

pub async fn restart(session: &str) -> Result<PathBuf, String> {
    stop(session)?;
    tokio::time::sleep(Duration::from_millis(400)).await;
    start(session).await
}

pub async fn update() -> Result<String, String> {
    let output = tokio::task::spawn_blocking(|| {
        let mut command = Command::new("herdr");
        command.arg("update");
        crate::quiet_process::quiet(&mut command);
        command
            .output()
            .map_err(|err| format!("could not run herdr update: {err}"))
    })
    .await
    .map_err(|err| err.to_string())??;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = format!("{stdout}{stderr}").trim().to_string();
    if output.status.success() {
        Ok(if detail.is_empty() {
            "Herdr updated".into()
        } else {
            detail
        })
    } else {
        Err(if detail.is_empty() {
            "herdr update failed".into()
        } else {
            detail
        })
    }
}

fn stop(session: &str) -> Result<(), String> {
    let mut command = Command::new("herdr");
    if session == "default" {
        command.args(["server", "stop"]);
    } else {
        command.args(["session", "stop", session]);
    }
    crate::quiet_process::quiet(&mut command);
    let output = command
        .output()
        .map_err(|err| format!("could not stop Herdr: {err}"))?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr);
    let detail = detail.trim();
    if detail.is_empty() {
        Ok(())
    } else {
        // Already stopped is fine when restarting from a stale binary.
        if detail.to_ascii_lowercase().contains("not running") {
            Ok(())
        } else {
            Err(detail.to_string())
        }
    }
}

fn spawn_server(session: Option<&str>) -> Result<(), String> {
    let mut command = Command::new("herdr");
    if let Some(name) = session {
        command
            .arg("--session")
            .arg(name)
            .env("HERDR_SESSION", name);
    }
    command
        .arg("server")
        .env_remove("HERDR_SOCKET_PATH")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    crate::quiet_process::quiet(&mut command);
    command
        .spawn()
        .map_err(|err| format!("could not start Herdr: {err}"))?;
    Ok(())
}

fn server_listening(socket: &Path) -> bool {
    #[cfg(windows)]
    {
        let transport = paths::transport_name(socket);
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&transport)
            .is_ok()
    }
    #[cfg(not(windows))]
    {
        socket.exists()
    }
}

async fn wait_for_server(socket: &Path) -> Result<(), String> {
    for _ in 0..50 {
        if server_listening(socket) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Err("Herdr did not become ready".into())
}

fn read_status_json() -> Option<Value> {
    let mut command = Command::new("herdr");
    command.args(["status", "--json"]);
    crate::quiet_process::quiet(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}

fn flag(value: Option<&Value>, pointer: &str) -> bool {
    value
        .and_then(|doc| doc.pointer(pointer))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

async fn latest_manifest(http: &reqwest::Client, channel: &str) -> Result<Option<String>, String> {
    let url = if channel.eq_ignore_ascii_case("preview") {
        "https://herdr.dev/preview.json"
    } else {
        "https://herdr.dev/latest.json"
    };
    let response = http
        .get(url)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|err| err.to_string())?;
    if !response.status().is_success() {
        return Err(format!("manifest HTTP {}", response.status()));
    }
    let text = response.text().await.map_err(|err| err.to_string())?;
    let body: Value = serde_json::from_str(&text).map_err(|err| err.to_string())?;
    Ok(body
        .get("version")
        .and_then(Value::as_str)
        .map(|value| value.trim().trim_start_matches('v').to_string()))
}

/// True when `latest` is a higher dotted version than `current`.
pub fn version_newer(latest: &str, current: &str) -> bool {
    let parse = |value: &str| -> Vec<u64> {
        value
            .trim()
            .trim_start_matches('v')
            .split('.')
            .filter_map(|part| {
                let digits: String = part.chars().take_while(|ch| ch.is_ascii_digit()).collect();
                digits.parse().ok()
            })
            .collect()
    };
    let left = parse(latest);
    let right = parse(current);
    let len = left.len().max(right.len());
    for index in 0..len {
        let a = left.get(index).copied().unwrap_or(0);
        let b = right.get(index).copied().unwrap_or(0);
        if a != b {
            return a > b;
        }
    }
    false
}

#[allow(dead_code)]
pub fn session_socket_path(session: &str) -> Result<PathBuf, String> {
    if session == "default" {
        Ok(herdr_config_dir()
            .map_err(|err| err.to_string())?
            .join("herdr.sock"))
    } else {
        Ok(named_session_dir(session)
            .map_err(|err| err.to_string())?
            .join("herdr.sock"))
    }
}

#[cfg(test)]
mod tests {
    use super::version_newer;

    #[test]
    fn compares_dotted_versions() {
        assert!(version_newer("0.9.6", "0.9.5"));
        assert!(version_newer("1.0.0", "0.9.9"));
        assert!(!version_newer("0.9.5", "0.9.5"));
        assert!(!version_newer("0.9.4", "0.9.5"));
        assert!(version_newer("v0.10.0", "0.9.9"));
    }
}
