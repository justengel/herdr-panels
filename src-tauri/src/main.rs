#![cfg_attr(windows, windows_subsystem = "windows")]

mod browser;

use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

fn main() {
    // cargo run keeps a console open and closing it kills this window.
    // Hand the real window to a process that is not attached to that console.
    if hand_off_terminal() {
        return;
    }
    let url = viewer_target();
    if !ensure_viewer(&url) {
        return;
    }
    browser::run();
}

/// Start an independent copy and let this process exit.
///
/// `cargo run` is a console program. It waits, and its messages show in that
/// console. Closing the console then closes the window. The copy is not part
/// of that console, so the first process can exit and cargo can return.
fn hand_off_terminal() -> bool {
    #[cfg(windows)]
    {
        if std::env::var_os("HERDR_PANELS_DETACHED").is_some() {
            return false;
        }
        let Ok(exe) = std::env::current_exe() else {
            return false;
        };
        let mut command = std::process::Command::new(exe);
        command
            .args(std::env::args().skip(1))
            .env("HERDR_PANELS_DETACHED", "1")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x00000008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x01000000;
        command.creation_flags(
            DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB,
        );
        if command.spawn().is_ok() {
            return true;
        }
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
        return command.spawn().is_ok();
    }
    #[cfg(not(windows))]
    {
        false
    }
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

/// Start a viewer in this process, or keep one that reports this build.
/// Returns false when the window should not open.
fn ensure_viewer(url: &str) -> bool {
    let Ok((host, port)) = endpoint(url) else {
        tell(&format!("This window could not use {url}."));
        return false;
    };
    let addr = SocketAddr::from((host, port));
    let open = port_open(addr);
    let (status, body) = if open {
        fetch_health(url)
    } else {
        (None, String::new())
    };
    match herdr_panels::launch::viewer_launch(open, status, &body, herdr_panels::BUILD_ID) {
        herdr_panels::launch::ViewerLaunch::Attach
        | herdr_panels::launch::ViewerLaunch::LeaveForeign => true,
        herdr_panels::launch::ViewerLaunch::Unread => {
            tell(&format!(
                "A viewer is already running at {url}, and this window could not read its build. Stop that viewer and start the desktop again."
            ));
            false
        }
        herdr_panels::launch::ViewerLaunch::Replace => match stop_other_build(port) {
            Ok(()) => {
                if !wait_until_closed(addr) {
                    tell(&format!(
                        "A viewer from another build is still running at {url}. Stop that process and start the desktop again."
                    ));
                    return false;
                }
                start_viewer_thread(url, addr);
                true
            }
            Err(err) => {
                tell(&format!(
                    "A viewer from another build is running at {url}. {err}"
                ));
                false
            }
        },
        herdr_panels::launch::ViewerLaunch::Start => {
            start_viewer_thread(url, addr);
            true
        }
    }
}

fn fetch_health(url: &str) -> (Option<u16>, String) {
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return (None, String::new());
    };
    let config_dir = herdr_panels::config::prepare_config_dir(None).ok();
    let token = config_dir
        .as_deref()
        .and_then(herdr_panels::launch::existing_token);
    runtime.block_on(async {
        match herdr_panels::launch::read_health(url, token.as_deref()).await {
            Some((status, body)) => (Some(status), body),
            None => (None, String::new()),
        }
    })
}

fn stop_other_build(port: u16) -> Result<(), String> {
    let config_dir =
        herdr_panels::config::prepare_config_dir(None).map_err(|err| err.to_string())?;
    herdr_panels::self_update::stop_mismatched_viewer(&config_dir, port)
}

fn wait_until_closed(addr: SocketAddr) -> bool {
    for _ in 0..50 {
        if !port_open(addr) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    !port_open(addr)
}

fn start_viewer_thread(url: &str, addr: SocketAddr) {
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
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    eprintln!("desktop shell could not reach {url}");
}

fn tell(message: &str) {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONWARNING, MB_OK};
        let mut text: Vec<u16> = std::ffi::OsStr::new(message).encode_wide().collect();
        text.push(0);
        let mut title: Vec<u16> = std::ffi::OsStr::new("Herdr Panels").encode_wide().collect();
        title.push(0);
        unsafe {
            let _ = MessageBoxW(
                None,
                PCWSTR(text.as_ptr()),
                PCWSTR(title.as_ptr()),
                MB_OK | MB_ICONWARNING,
            );
        }
    }
    #[cfg(not(windows))]
    {
        eprintln!("{message}");
    }
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
    fn the_desktop_keeps_a_matching_viewer_and_replaces_a_different_build() {
        use herdr_panels::launch::{viewer_launch, ViewerLaunch};
        assert_eq!(viewer_launch(false, None, "", "abc"), ViewerLaunch::Start);
        assert_eq!(
            viewer_launch(true, Some(200), r#"{"ok":true,"build":"abc"}"#, "abc"),
            ViewerLaunch::Attach
        );
        assert_eq!(
            viewer_launch(true, Some(200), r#"{"ok":true,"build":"old"}"#, "abc"),
            ViewerLaunch::Replace
        );
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
