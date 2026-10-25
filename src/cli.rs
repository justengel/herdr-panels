use std::net::IpAddr;
use std::path::PathBuf;

use anyhow::Context;
use clap::Parser;
use tracing_subscriber::EnvFilter;

use crate::config::prepare_config_dir;
use crate::paths::resolve_herdr_socket;
use crate::server::{serve, ServerConfig};

#[derive(Parser, Debug)]
#[command(
    name = "herdr-panels",
    version,
    about = "Run the Herdr web viewer"
)]
struct Args {
    /// Configuration directory. Defaults to the per-user config directory.
    #[arg(long)]
    config: Option<PathBuf>,

    /// Herdr API socket. Pass the logical path Herdr prints, without a Windows pipe prefix.
    #[arg(long)]
    herdr_socket: Option<PathBuf>,

    /// Named Herdr session to attach to. Ignored when --herdr-socket is set.
    #[arg(long)]
    herdr_session: Option<String>,

    /// Loopback address to bind.
    #[arg(long, default_value = "127.0.0.1")]
    host: IpAddr,

    /// TCP port.
    #[arg(long, default_value_t = 4737)]
    port: u16,

    /// Open a browser tab after the server starts.
    #[arg(long)]
    open: bool,
}

pub async fn execute() -> anyhow::Result<()> {
    let mut raw: Vec<std::ffi::OsString> = std::env::args_os().collect();
    let first = raw.get(1).and_then(|arg| arg.to_str());
    match first {
        Some("panel") | Some("plugin") | Some("status") | Some("help") | Some("--help")
        | Some("-h") | Some("--version") | Some("-V") => crate::client::execute().await,
        Some("server") => {
            raw.remove(1);
            run_server(Args::parse_from(raw)).await
        }
        Some(other) if other.starts_with('-') => run_server(Args::parse()).await,
        None => run_server(Args::parse()).await,
        Some(other) => anyhow::bail!("unknown command '{other}'. Run herdr-panels --help"),
    }
}

async fn run_server(args: Args) -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("herdr_panels=info")),
        )
        .init();

    if !args.host.is_loopback() {
        anyhow::bail!(
            "refusing to bind {}: this server is localhost-only",
            args.host
        );
    }
    if args.port == 0 {
        anyhow::bail!("port must be greater than 0");
    }

    let config_dir = prepare_config_dir(args.config)?;
    let herdr_socket = resolve_herdr_socket(args.herdr_socket, args.herdr_session)?;
    let url = format!("http://{}:{}", args.host, args.port);

    serve(ServerConfig {
        host: args.host,
        port: args.port,
        config_dir,
        herdr_socket,
        open_browser: args.open,
        url,
    })
    .await
    .context("server stopped")
}

pub fn open_browser(url: &str) {
    let result = {
        #[cfg(windows)]
        {
            std::process::Command::new("cmd")
                .args(["/C", "start", "", url])
                .spawn()
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open").arg(url).spawn()
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            std::process::Command::new("xdg-open").arg(url).spawn()
        }
    };
    if let Err(err) = result {
        tracing::warn!("could not open browser: {err}");
    }
}
