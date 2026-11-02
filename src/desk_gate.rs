//! The desktop window is the only place that can turn Agent control on or approve an unlock.
//! The viewer token can still arrange the desk and turn Agent control off.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};

pub const GRANT_HEADER: &str = "x-herdr-desk-grant";

pub const ENABLE_REFUSED: &str =
    "Agent control can only be turned on from the desktop window. The CLI can turn it off.";

pub const UNLOCK_REFUSED: &str = "Unlock has to be confirmed in the desktop window.";

#[derive(Clone)]
struct Launch {
    url: String,
    config_dir: PathBuf,
    grant: String,
}

static LAUNCH: Mutex<Option<Launch>> = Mutex::new(None);

pub fn arm_launch(config_dir: PathBuf, grant: String) {
    *launch_slot() = Some(Launch {
        url: String::new(),
        config_dir,
        grant,
    });
}

pub fn set_launch_url(url: &str) {
    if let Some(launch) = launch_slot().as_mut() {
        launch.url = url.trim_end_matches('/').to_string();
    }
}

pub fn grant_matches(expected: &str, presented: &str) -> bool {
    if expected.is_empty() || expected.len() != presented.len() {
        return false;
    }
    let mut diff = 0u8;
    for (left, right) in expected.bytes().zip(presented.bytes()) {
        diff |= left ^ right;
    }
    diff == 0
}

/// Env set on the desktop process, or the launch record when the viewer runs inside that process.
pub fn grant_for_this_process() -> Option<String> {
    if let Some(grant) = launch_slot()
        .as_ref()
        .map(|launch| launch.grant.clone())
        .filter(|grant| !grant.is_empty())
    {
        return Some(grant);
    }
    std::env::var("HERDR_PANELS_DESK_GRANT")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn apply_desktop_env(command: &mut std::process::Command, url: Option<&str>) {
    let launch = launch_slot().as_ref().cloned();
    let Some(launch) = launch else {
        if let Some(url) = url {
            command.env("HERDR_PANELS_URL", url);
        }
        return;
    };
    command.env("HERDR_PANELS_DESK_GRANT", &launch.grant);
    command.env("HERDR_PANELS_CONFIG", &launch.config_dir);
    let chosen = url
        .map(str::to_string)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            if launch.url.is_empty() {
                None
            } else {
                Some(launch.url)
            }
        });
    if let Some(url) = chosen {
        command.env("HERDR_PANELS_URL", url);
    }
}

pub async fn enable_from_desk() -> Result<(), String> {
    let grant = grant_for_this_process().ok_or_else(|| ENABLE_REFUSED.to_string())?;
    post_granted("/api/agent-access", json!({ "enabled": true }), &grant).await
}

pub async fn answer_unlock(id: &str, yes: bool) -> Result<(), String> {
    let grant = if yes {
        grant_for_this_process().ok_or_else(|| UNLOCK_REFUSED.to_string())?
    } else {
        grant_for_this_process().unwrap_or_default()
    };
    post_granted(
        "/api/panel-unlock-answer",
        json!({ "id": id, "yes": yes }),
        &grant,
    )
    .await
}

async fn post_granted(path: &str, body: Value, grant: &str) -> Result<(), String> {
    let config = crate::config::prepare_config_dir(None).map_err(|err| err.to_string())?;
    let token = crate::auth::session_token(&config).map_err(|err| err.to_string())?;
    let base = std::env::var("HERDR_PANELS_URL")
        .ok()
        .map(|url| url.trim().trim_end_matches('/').to_string())
        .filter(|url| !url.is_empty())
        .or_else(|| {
            launch_slot()
                .as_ref()
                .map(|launch| launch.url.clone())
                .filter(|url| !url.is_empty())
        })
        .unwrap_or_else(|| "http://127.0.0.1:4737".into());
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .no_proxy()
        .build()
        .map_err(|err| err.to_string())?;
    let response = client
        .post(format!("{base}{path}"))
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .header(GRANT_HEADER, grant)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|err| err.to_string())?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if status.is_success() {
        return Ok(());
    }
    let message = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|message| !message.is_empty())
        .unwrap_or(text);
    Err(message)
}

fn launch_slot() -> std::sync::MutexGuard<'static, Option<Launch>> {
    LAUNCH.lock().unwrap_or_else(|err| err.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_desk_grant_matches_only_the_same_secret() {
        assert!(!grant_matches("", ""));
        assert!(!grant_matches("abc", ""));
        assert!(!grant_matches("abc", "abd"));
        assert!(!grant_matches("abc", "abcd"));
        assert!(grant_matches("abc", "abc"));
    }
}
