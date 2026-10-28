mod browser;

use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

fn main() {
    let url = viewer_target();
    ensure_viewer(&url);
    browser::run();
}

fn viewer_target() -> String {
    match std::env::var("HERDR_PANELS_URL") {
        Ok(value) => {
            let value = value.trim().trim_end_matches('/').to_string();
            if endpoint(&value).is_ok() {
                value
            } else {
                browser::VIEWER.to_string()
            }
        }
        Err(_) => browser::VIEWER.to_string(),
    }
}

fn ensure_viewer(url: &str) {
    let Ok((host, port)) = endpoint(url) else {
        eprintln!("desktop shell could not use {url}");
        return;
    };
    let addr = SocketAddr::from((host, port));
    if !should_start_viewer(port_open(addr)) {
        eprintln!("desktop shell using the viewer at {url}");
        return;
    }
    let url_owned = url.to_string();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        runtime.block_on(async {
            match herdr_panels::config::prepare_config_dir(None) {
                Ok(config_dir) => {
                    if let Err(err) = start_viewer_in(config_dir, &url_owned).await {
                        eprintln!("viewer: {err}");
                    }
                }
                Err(err) => eprintln!("viewer: {err:#}"),
            }
        });
    });
    for _ in 0..50 {
        if port_open(addr) {
            eprintln!("desktop shell started the viewer at {url}");
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    eprintln!("desktop shell could not reach {url}");
}

/// The desktop program starts a viewer only when its address is closed.
/// That viewer runs in this process, so closing the window stops it.
fn should_start_viewer(port_is_open: bool) -> bool {
    !port_is_open
}

async fn start_viewer_in(config_dir: std::path::PathBuf, url: &str) -> Result<(), String> {
    let (host, port) = endpoint(url)?;
    let config_dir =
        herdr_panels::config::prepare_config_dir(Some(config_dir)).map_err(|err| err.to_string())?;
    let herdr_socket = herdr_panels::paths::resolve_herdr_socket(None, None)
        .map_err(|err| err.to_string())?;
    herdr_panels::serve(herdr_panels::server::ServerConfig {
        host,
        port,
        config_dir,
        herdr_socket,
        open_browser: false,
        open_desktop: false,
        url: url.trim_end_matches('/').to_string(),
    })
    .await
    .map_err(|err| err.to_string())
}

fn endpoint(url: &str) -> Result<(std::net::IpAddr, u16), String> {
    let parsed = url::Url::parse(url).map_err(|_| format!("viewer url is invalid: {url}"))?;
    if parsed.scheme() != "http" {
        return Err("viewer url must be http".into());
    }
    let host = parsed.host_str().unwrap_or("127.0.0.1");
    let ip = match host {
        "localhost" | "127.0.0.1" => std::net::IpAddr::from([127, 0, 0, 1]),
        "::1" => std::net::IpAddr::V6(std::net::Ipv6Addr::LOCALHOST),
        _ => return Err("viewer url must stay on localhost".into()),
    };
    Ok((ip, parsed.port().unwrap_or(4737)))
}

fn port_open(addr: SocketAddr) -> bool {
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_desktop_program_starts_a_viewer_only_when_its_port_is_closed() {
        assert!(should_start_viewer(false));
        assert!(!should_start_viewer(true));
    }

    #[tokio::test]
    async fn the_desktop_program_starts_a_viewer_on_an_isolated_port() {
        let dir = std::env::temp_dir().join(format!(
            "hwp-desktop-view-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let url = format!("http://127.0.0.1:{port}");
        let started = std::time::Instant::now();
        let task_dir = dir.clone();
        let task_url = url.clone();
        let task = tokio::spawn(async move {
            let _ = start_viewer_in(task_dir, &task_url).await;
        });
        let mut open = false;
        for _ in 0..50 {
            if port_open(SocketAddr::from((std::net::IpAddr::from([127, 0, 0, 1]), port))) {
                open = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let elapsed = started.elapsed();
        eprintln!("desktop viewer socket open in {elapsed:?}");
        assert!(open, "herdr-panels-desktop did not start a viewer at {url}");
        task.abort();
        let mut closed = false;
        for _ in 0..30 {
            if !port_open(SocketAddr::from((std::net::IpAddr::from([127, 0, 0, 1]), port))) {
                closed = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        eprintln!("desktop viewer socket closed after the desktop task stopped: {closed}");
        assert!(closed, "the viewer kept listening after the desktop task stopped");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
