use std::path::Path;
use std::time::Duration;

/// What answered on the viewer address.
#[derive(Debug, PartialEq, Eq)]
pub enum Probe {
    /// `/api/health` identified this program.
    Up,
    /// Nothing accepted the connection.
    Down,
    /// Something accepted, and it was not this program.
    Foreign { status: u16, body: String },
}

/// What `herdr-panels` with no subcommand should do.
#[derive(Debug, PartialEq, Eq)]
pub enum Choice {
    OpenWindow,
    StartServer,
    Refuse(String),
}

pub fn choose(url: &str, probe: Probe) -> Choice {
    match probe {
        Probe::Up => Choice::OpenWindow,
        Probe::Down => Choice::StartServer,
        Probe::Foreign { status, body } => {
            let detail = one_line(&body);
            let detail = if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            };
            Choice::Refuse(format!(
                "{url} is in use, but it is not a herdr-panels viewer (HTTP {status}{detail})"
            ))
        }
    }
}

pub fn classify_health(status: u16, body: &str) -> Probe {
    if status == 200 && health_ok(body) {
        return Probe::Up;
    }
    if status == 401 && body.contains("viewer token is required") {
        return Probe::Up;
    }
    Probe::Foreign {
        status,
        body: body.to_string(),
    }
}

/// `herdr-panels server` does not open a window. A viewer that is already
/// running is reported instead of being described as another program.
pub fn server_refusal(url: &str, choice: Choice) -> Option<String> {
    match choice {
        Choice::OpenWindow => Some(format!("viewer is already running at {url}")),
        Choice::Refuse(message) => Some(message),
        Choice::StartServer => None,
    }
}

pub fn explain_bind(kind: std::io::ErrorKind, url: &str) -> Option<String> {
    if kind == std::io::ErrorKind::AddrInUse {
        Some(format!(
            "{url} is already in use by something that is not a herdr-panels viewer"
        ))
    } else {
        None
    }
}

/// Address saved by the running viewer, when it is an http loopback URL.
pub fn recorded_url(config_dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(config_dir.join("server.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let url = value.get("url")?.as_str()?.trim();
    loopback_http(url)
}

pub fn existing_token(config_dir: &Path) -> Option<String> {
    if let Ok(value) = std::env::var(crate::auth::ENV) {
        let value = value.trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    let text = std::fs::read_to_string(config_dir.join(crate::auth::FILE_NAME)).ok()?;
    let token = text.trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

pub async fn inspect(url: &str, token: Option<&str>) -> Probe {
    let client = match reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(250))
        .timeout(Duration::from_millis(800))
        .no_proxy()
        .build()
    {
        Ok(client) => client,
        Err(_) => return Probe::Down,
    };
    let request = client.get(format!("{url}/api/health"));
    let request = if let Some(token) = token {
        request.header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {token}"),
        )
    } else {
        request
    };
    match request.send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            classify_health(status, &body)
        }
        Err(_) => Probe::Down,
    }
}

fn health_ok(body: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.get("ok")?.as_bool())
        == Some(true)
}

fn loopback_http(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    match parsed.host_str()? {
        "localhost" | "127.0.0.1" | "::1" => {}
        _ => return None,
    }
    Some(parsed.as_str().trim_end_matches('/').to_string())
}

fn one_line(body: &str) -> String {
    let text: String = body
        .chars()
        .filter(|ch| *ch != '\r')
        .take(160)
        .collect();
    text.replace('\n', " ").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_running_viewer_opens_the_window_instead_of_starting_another() {
        let choice = choose("http://127.0.0.1:4737", Probe::Up);
        assert_eq!(choice, Choice::OpenWindow);
    }

    #[test]
    fn a_closed_port_starts_the_viewer() {
        let choice = choose("http://127.0.0.1:4737", Probe::Down);
        assert_eq!(choice, Choice::StartServer);
    }

    #[test]
    fn another_program_is_named_as_not_herdr_panels() {
        let choice = choose(
            "http://127.0.0.1:4737",
            Probe::Foreign {
                status: 200,
                body: "nope".into(),
            },
        );
        match choice {
            Choice::Refuse(message) => {
                assert!(message.contains("not a herdr-panels viewer"), "{message}");
                assert!(message.contains("4737"), "{message}");
                assert!(message.contains("200"), "{message}");
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn health_from_this_viewer_counts_as_running() {
        assert_eq!(classify_health(200, r#"{"ok":true}"#), Probe::Up);
        assert_eq!(
            classify_health(401, r#"{"error":"viewer token is required"}"#),
            Probe::Up
        );
    }

    #[test]
    fn a_different_http_response_is_not_this_viewer() {
        let probe = classify_health(200, "nope");
        assert!(matches!(probe, Probe::Foreign { status: 200, .. }));
    }

    #[test]
    fn the_server_command_names_a_running_viewer_and_a_stranger_differently() {
        let url = "http://127.0.0.1:4737";
        assert_eq!(
            server_refusal(url, Choice::OpenWindow).as_deref(),
            Some("viewer is already running at http://127.0.0.1:4737")
        );
        let foreign = server_refusal(
            url,
            Choice::Refuse("http://127.0.0.1:4737 is in use, but it is not a herdr-panels viewer (HTTP 200)".into()),
        )
        .unwrap();
        assert!(foreign.contains("not a herdr-panels viewer"), "{foreign}");
        assert!(server_refusal(url, Choice::StartServer).is_none());
    }

    #[test]
    fn an_occupied_port_says_it_is_not_this_viewer() {
        let message = explain_bind(std::io::ErrorKind::AddrInUse, "http://127.0.0.1:4737")
            .expect("address in use");
        assert!(message.contains("not a herdr-panels viewer"), "{message}");
        assert!(message.contains("4737"), "{message}");
    }

    #[test]
    fn the_recorded_address_has_to_be_loopback_http() {
        let dir = std::env::temp_dir().join(format!("hwp-recorded-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("server.json"), r#"{"url":"http://127.0.0.1:47993/"}"#).unwrap();
        assert_eq!(
            recorded_url(&dir).as_deref(),
            Some("http://127.0.0.1:47993")
        );
        std::fs::write(
            dir.join("server.json"),
            r#"{"url":"http://example.com:4737"}"#,
        )
        .unwrap();
        assert_eq!(recorded_url(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_live_viewer_is_recognized_and_a_stranger_is_refused() {
        let dir = std::env::temp_dir().join(format!(
            "hwp-launch-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let url = format!("http://127.0.0.1:{port}");
        let server_dir = dir.clone();
        let server_url = url.clone();
        let server = tokio::spawn(async move {
            let config_dir = crate::config::prepare_config_dir(Some(server_dir)).unwrap();
            let _ = crate::serve(crate::server::ServerConfig {
                host: std::net::IpAddr::from([127, 0, 0, 1]),
                port,
                config_dir: config_dir.clone(),
                herdr_socket: config_dir.join("missing-herdr.sock"),
                open_browser: false,
                open_desktop: false,
                url: server_url,
            })
            .await;
        });

        let started = std::time::Instant::now();
        let mut saw = false;
        for _ in 0..40 {
            let token = existing_token(&dir);
            if inspect(&url, token.as_deref()).await == Probe::Up {
                saw = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let elapsed = started.elapsed();
        eprintln!("recognized a running viewer in {elapsed:?}");
        assert!(saw, "viewer was not recognized");
        assert!(
            elapsed < Duration::from_secs(3),
            "recognizing the viewer took {elapsed:?}"
        );
        assert_eq!(recorded_url(&dir).as_deref(), Some(url.as_str()));
        let token = existing_token(&dir);
        let again = std::time::Instant::now();
        assert_eq!(
            choose(&url, inspect(&url, token.as_deref()).await),
            Choice::OpenWindow
        );
        eprintln!("second health check took {:?}", again.elapsed());

        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let closed_port = closed.local_addr().unwrap().port();
        drop(closed);
        let closed_url = format!("http://127.0.0.1:{closed_port}");
        let down_at = std::time::Instant::now();
        assert_eq!(inspect(&closed_url, None).await, Probe::Down);
        eprintln!("closed port reported down in {:?}", down_at.elapsed());

        let foreign = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let foreign_port = foreign.local_addr().unwrap().port();
        let foreign_url = format!("http://127.0.0.1:{foreign_port}");
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = foreign.accept().await else {
                    break;
                };
                let mut buf = [0u8; 1024];
                let _ = tokio::io::AsyncReadExt::read(&mut sock, &mut buf).await;
                let body = "nope";
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = tokio::io::AsyncWriteExt::write_all(&mut sock, response.as_bytes()).await;
            }
        });
        let probe = inspect(&foreign_url, None).await;
        match choose(&foreign_url, probe) {
            Choice::Refuse(message) => {
                assert!(message.contains("not a herdr-panels viewer"), "{message}");
            }
            other => panic!("expected a refusal, got {other:?}"),
        }

        server.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
