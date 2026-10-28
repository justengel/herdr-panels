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
        Some("install-launcher") => crate::launcher::execute(),
        Some("panel") | Some("plugin") | Some("status") | Some("token") | Some("help")
        | Some("--help") | Some("-h") | Some("--version") | Some("-V") => {
            crate::client::execute().await
        }
        Some("server") => {
            raw.remove(1);
            let args = Args::parse_from(raw);
            let config_dir = prepare_config_dir(args.config.clone())?;
            let url = format!("http://{}:{}", args.host, args.port);
            let token = crate::launch::existing_token(&config_dir);
            let choice =
                crate::launch::choose(&url, crate::launch::inspect(&url, token.as_deref()).await);
            if let Some(message) = crate::launch::server_refusal(&url, choice) {
                anyhow::bail!(message);
            }
            let launch = if args.open {
                Launch::Browser
            } else {
                Launch::Quiet
            };
            run_server(args, launch).await
        }
        Some("desktop") => open_recorded_desktop().await,
        Some(other) if other.starts_with('-') => launch_or_serve().await,
        None => launch_or_serve().await,
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

    match serve(ServerConfig {
        host: args.host,
        port: args.port,
        config_dir,
        herdr_socket,
        open_browser: matches!(launch, Launch::Browser),
        open_desktop: matches!(launch, Launch::Desktop),
        url,
    })
    .await
    {
        Ok(()) => Ok(()),
        Err(err) if format!("{err}").contains("not a herdr-panels viewer") => Err(err),
        Err(err) => Err(err.context("server stopped")),
    }
}

async fn launch_or_serve() -> anyhow::Result<()> {
    let args = Args::parse();
    let config_dir = prepare_config_dir(args.config.clone())?;
    let bind_url = format!("http://{}:{}", args.host, args.port);
    let probe_url = crate::launch::recorded_url(&config_dir).unwrap_or(bind_url);
    let token = crate::launch::existing_token(&config_dir);
    match crate::launch::choose(
        &probe_url,
        crate::launch::inspect(&probe_url, token.as_deref()).await,
    ) {
        crate::launch::Choice::OpenWindow => {
            println!("viewer is already running at {probe_url}");
            open_surface(&probe_url, args.open)
        }
        crate::launch::Choice::Refuse(message) => anyhow::bail!(message),
        crate::launch::Choice::StartServer => {
            let launch = match surface_for(find_desktop().is_some(), args.open) {
                Surface::Browser => Launch::Browser,
                Surface::Desktop => Launch::Desktop,
            };
            run_server(args, launch).await
        }
    }
}

async fn open_recorded_desktop() -> anyhow::Result<()> {
    let config_dir = prepare_config_dir(None)?;
    let url =
        crate::launch::recorded_url(&config_dir).unwrap_or_else(|| "http://127.0.0.1:4737".into());
    let token = crate::launch::existing_token(&config_dir);
    if let crate::launch::Choice::Refuse(message) =
        crate::launch::choose(&url, crate::launch::inspect(&url, token.as_deref()).await)
    {
        anyhow::bail!(message);
    }
    open_desktop_at(&url)
}

fn open_surface(url: &str, browser_requested: bool) -> anyhow::Result<()> {
    match surface_for(find_desktop().is_some(), browser_requested) {
        Surface::Browser => {
            if !browser_requested {
                println!("the desktop window is not installed; opening a browser tab");
            }
            open_browser(url);
            Ok(())
        }
        Surface::Desktop => {
            if let Err(err) = spawn_desktop_at(Some(url)) {
                eprintln!("desktop window: {err:#}");
                open_browser(url);
            }
            Ok(())
        }
    }
}

enum Surface {
    Desktop,
    Browser,
}

fn surface_for(desktop_installed: bool, browser_requested: bool) -> Surface {
    if browser_requested || !desktop_installed {
        Surface::Browser
    } else {
        Surface::Desktop
    }
}

pub fn spawn_desktop() -> anyhow::Result<()> {
    spawn_desktop_at(None)
}

pub fn spawn_desktop_at(url: Option<&str>) -> anyhow::Result<()> {
    let mut command = desktop_command(url)?;
    let child = command.spawn().context("starting the desktop window")?;
    reap_child(child);
    Ok(())
}

fn open_desktop_at(url: &str) -> anyhow::Result<()> {
    let mut command = desktop_command(Some(url))?;
    let status = command.status().context("starting the desktop window")?;
    if !status.success() {
        anyhow::bail!("desktop window exited with {status}");
    }
    Ok(())
}

fn desktop_command(url: Option<&str>) -> anyhow::Result<std::process::Command> {
    let path = find_desktop().context(
        "the desktop window is not installed. From the repository root, run: cargo install --path src-tauri",
    )?;
    let mut command = std::process::Command::new(path);
    if let Some(url) = url {
        command.env("HERDR_PANELS_URL", url);
    }
    Ok(command)
}

pub fn reap_child(child: std::process::Child) {
    if let Err(err) = spawn_reaper(child) {
        tracing::warn!("could not wait for the desktop window: {err}");
    }
}

pub fn spawn_reaper(
    mut child: std::process::Child,
) -> std::io::Result<std::thread::JoinHandle<std::io::Result<std::process::ExitStatus>>> {
    std::thread::Builder::new()
        .name("herdr-panels-reap".into())
        .spawn(move || child.wait())
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
            {
                let mut command = std::process::Command::new("cmd");
                command.args(["/C", "start", "", url]);
                crate::quiet_process::quiet(&mut command);
                command.spawn()
            }
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
    use super::{desktop_file_name, first_existing, spawn_reaper, surface_for, Surface};

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

    #[test]
    fn an_installed_desktop_program_is_the_window_unless_a_browser_was_requested() {
        assert!(matches!(surface_for(true, false), Surface::Desktop));
        assert!(matches!(surface_for(false, false), Surface::Browser));
        assert!(matches!(surface_for(true, true), Surface::Browser));
    }

    #[test]
    fn a_finished_child_is_waited_on() {
        let mut command = if cfg!(windows) {
            let mut command = std::process::Command::new("cmd");
            command.args(["/C", "exit", "0"]);
            crate::quiet_process::quiet(&mut command);
            command
        } else {
            std::process::Command::new("true")
        };
        let child = command.spawn().unwrap();
        let status = spawn_reaper(child).unwrap().join().unwrap().unwrap();
        assert!(status.success());
    }
}
