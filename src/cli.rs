use std::net::IpAddr;
use std::path::PathBuf;

use anyhow::Context;
use clap::Parser;
use tracing_subscriber::EnvFilter;

use crate::config::prepare_config_dir;
use crate::paths::resolve_herdr_socket;
use crate::server::{serve, ServerConfig};

#[derive(Parser, Debug)]
#[command(name = "herdr-panels", version, about = "Run the Herdr web viewer")]
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
        Some("update") => crate::self_update::execute().await,
        Some("panel") | Some("plugin") | Some("status") | Some("token") | Some("help")
        | Some("--help") | Some("-h") | Some("--version") | Some("-V") => {
            crate::client::execute().await
        }
        Some("server") => {
            raw.remove(1);
            let args = Args::parse_from(raw);
            let launch = if args.open {
                Launch::Browser
            } else {
                Launch::Quiet
            };
            run_server(args, launch).await
        }
        Some("desktop") => open_desktop(),
        Some(other) if other.starts_with('-') => {
            let args = Args::parse();
            let launch = if args.open {
                Launch::Browser
            } else {
                Launch::Quiet
            };
            run_server(args, launch).await
        }
        None => {
            let launch = if find_desktop().is_some() {
                Launch::Desktop
            } else {
                Launch::Browser
            };
            run_server(Args::parse(), launch).await
        }
        Some(other) => anyhow::bail!("unknown command '{other}'. Run herdr-panels --help"),
    }
}

enum Launch {
    Quiet,
    Browser,
    Desktop,
}

async fn run_server(args: Args, launch: Launch) -> anyhow::Result<()> {
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
        open_browser: matches!(launch, Launch::Browser),
        open_desktop: matches!(launch, Launch::Desktop),
        url,
    })
    .await
    .context("server stopped")
}

pub fn spawn_desktop() -> anyhow::Result<()> {
    let path = find_desktop().context(
        "the desktop window is not installed. From the repository root, run: cargo install --path src-tauri",
    )?;
    std::process::Command::new(path)
        .spawn()
        .context("starting the desktop window")?;
    Ok(())
}

fn open_desktop() -> anyhow::Result<()> {
    let path = find_desktop().context(
        "the desktop window is not installed. From the repository root, run: cargo install --path src-tauri",
    )?;
    let status = std::process::Command::new(path)
        .status()
        .context("starting the desktop window")?;
    if !status.success() {
        anyhow::bail!("desktop window exited with {status}");
    }
    Ok(())
}

fn find_desktop() -> Option<PathBuf> {
    first_existing(desktop_candidates())
}

fn desktop_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(desktop_file_name()));
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            candidates.push(dir.join(desktop_file_name()));
        }
    }
    let built = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src-tauri")
        .join("target");
    for profile in ["release", "debug"] {
        candidates.push(built.join(profile).join(desktop_file_name()));
    }
    candidates
}

fn desktop_file_name() -> &'static str {
    if cfg!(windows) {
        "herdr-panels-desktop.exe"
    } else {
        "herdr-panels-desktop"
    }
}

fn first_existing(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|path| path.is_file())
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

#[cfg(test)]
mod tests {
    use super::{desktop_file_name, first_existing};

    #[test]
    fn an_existing_file_is_chosen_as_the_desktop_program() {
        let dir = std::env::temp_dir().join(format!("hwp-desktop-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let program = dir.join(desktop_file_name());
        std::fs::write(&program, b"").unwrap();
        let found = first_existing([dir.join("missing"), program.clone()]);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(found, Some(program));
    }
}
