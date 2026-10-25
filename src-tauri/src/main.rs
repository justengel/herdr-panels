mod browser;

use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

fn main() {
    ensure_viewer();
    browser::run();
}

fn ensure_viewer() {
    if port_open() {
        eprintln!("desktop shell using the viewer at {}", browser::VIEWER);
        return;
    }
    std::thread::spawn(|| {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        runtime.block_on(async {
            if let Err(err) = start_viewer().await {
                eprintln!("viewer: {err:#}");
            }
        });
    });
    for _ in 0..50 {
        if port_open() {
            eprintln!("desktop shell started the viewer at {}", browser::VIEWER);
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    eprintln!("desktop shell could not reach {}", browser::VIEWER);
}

async fn start_viewer() -> Result<(), String> {
    let config_dir = herdr_web_panels::config::prepare_config_dir(None).map_err(|err| err.to_string())?;
    let herdr_socket = herdr_web_panels::paths::resolve_herdr_socket(None, None).map_err(|err| err.to_string())?;
    herdr_web_panels::serve(herdr_web_panels::server::ServerConfig {
        host: std::net::IpAddr::from([127, 0, 0, 1]),
        port: 4737,
        config_dir,
        herdr_socket,
        open_browser: false,
        url: browser::VIEWER.into(),
    })
    .await
    .map_err(|err| err.to_string())
}

fn port_open() -> bool {
    let Ok(addr) = browser::VIEWER.trim_start_matches("http://").parse::<SocketAddr>() else {
        return false;
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}
