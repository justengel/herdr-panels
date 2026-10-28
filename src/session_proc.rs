use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::paths::{self, named_session_dir};

pub async fn start_session(name: &str) -> Result<PathBuf, String> {
    let socket = socket_for(name)?;
    if !socket.is_file() {
        spawn_server(name)?;
        wait_for_file(&socket).await?;
    }
    Ok(socket)
}

pub async fn rename_session(from: &str, to: &str) -> Result<PathBuf, String> {
    if from == "default" {
        return Err("the default session cannot be renamed".into());
    }
    if from == to {
        return start_session(to).await;
    }
    let source = named_session_dir(from).map_err(|err| err.to_string())?;
    let dest = named_session_dir(to).map_err(|err| err.to_string())?;
    if !source.is_dir() {
        return Err(format!("Herdr session {from} was not found"));
    }
    if dest.exists() {
        return Err("a session with that name already exists".into());
    }
    let old_socket = source.join("herdr.sock");
    if old_socket.is_file() {
        stop_session(from)?;
        wait_until_gone(&old_socket).await?;
    }
    std::fs::rename(&source, &dest)
        .map_err(|err| format!("could not rename the session: {err}"))?;
    spawn_server(to)?;
    let socket = dest.join("herdr.sock");
    wait_for_file(&socket).await?;
    Ok(socket)
}

fn socket_for(name: &str) -> Result<PathBuf, String> {
    if name == "default" {
        return Err("choose a name other than default".into());
    }
    if !paths::valid_session_name(name) {
        return Err("invalid Herdr session name".into());
    }
    Ok(named_session_dir(name)
        .map_err(|err| err.to_string())?
        .join("herdr.sock"))
}

pub async fn close_session(name: &str) -> Result<(), String> {
    if name == "default" {
        return Err("the default session is the Herdr client already open on this machine".into());
    }
    if !paths::valid_session_name(name) {
        return Err("invalid Herdr session name".into());
    }
    let socket = named_session_dir(name)
        .map_err(|err| err.to_string())?
        .join("herdr.sock");
    if socket.is_file() {
        stop_session(name)?;
        wait_until_gone(&socket).await?;
    }
    Ok(())
}

fn stop_session(name: &str) -> Result<(), String> {
    let mut command = Command::new("herdr");
    command.args(["session", "stop", name]);
    crate::quiet_process::quiet(&mut command);
    let output = command
        .output()
        .map_err(|err| format!("could not stop the session: {err}"))?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr);
    let detail = detail.trim();
    if detail.is_empty() {
        Err(format!("could not stop {name}"))
    } else {
        Err(detail.to_string())
    }
}

fn spawn_server(name: &str) -> Result<(), String> {
    let mut command = Command::new("herdr");
    command
        .arg("--session")
        .arg(name)
        .arg("server")
        .env("HERDR_SESSION", name)
        .env_remove("HERDR_SOCKET_PATH")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    crate::quiet_process::quiet(&mut command);
    command
        .spawn()
        .map_err(|err| format!("could not start the session: {err}"))?;
    Ok(())
}

async fn wait_for_file(path: &Path) -> Result<(), String> {
    for _ in 0..50 {
        if path.is_file() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Err("the session did not start".into())
}

async fn wait_until_gone(path: &Path) -> Result<(), String> {
    for _ in 0..50 {
        if !path.exists() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("the session did not stop".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn closing_the_default_session_is_refused() {
        let error = close_session("default").await.unwrap_err();
        assert!(error.contains("default"));
    }
}
