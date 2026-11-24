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

    /// Named Herdr session to attach to. Wins over HERDR_SOCKET_PATH and HERDR_SESSION. Ignored when --herdr-socket is set.
    #[arg(long)]
    herdr_session: Option<String>,

    /// Viewer URL to open when this process is not the server. The server command still binds --host and --port.
    #[arg(long)]
    url: Option<String>,

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

const VALUE_FLAGS: &[&str] = &[
    "--config",
    "--url",
    "--herdr-socket",
    "--herdr-session",
    "--host",
    "--port",
];

pub async fn execute() -> anyhow::Result<()> {
    let raw: Vec<std::ffi::OsString> = std::env::args_os().collect();
    match invocation_command(&raw).as_deref() {
        Some("update") => crate::self_update::execute().await,
        Some("install-launcher") => crate::launcher::execute(),
        Some("panel") | Some("plugin") | Some("status") | Some("token") | Some("access")
        | Some("help") | Some("--help") | Some("-h") | Some("--version") | Some("-V") => {
            crate::client::execute().await
        }
        Some("server") => {
            let args = Args::parse_from(without_command(&raw, "server"));
            let config_dir = prepare_config_dir(args.config.clone())?;
            let url = http_bind(args.host, args.port);
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
        Some("desktop") => open_desktop_command(&raw).await,
        Some(other) if other.starts_with('-') => launch_or_serve().await,
        None => launch_or_serve().await,
        Some(other) => anyhow::bail!("unknown command '{other}'. Run herdr-panels --help"),
    }
}

/// The subcommand, after flags that can precede it. `--help` stays a flag when nothing follows it.
pub(crate) fn invocation_command(args: &[std::ffi::OsString]) -> Option<String> {
    let mut args = args.iter().skip(1);
    while let Some(arg) = args.next() {
        let Some(text) = arg.to_str() else {
            continue;
        };
        if text == "--" {
            return args.next().and_then(|arg| arg.to_str().map(str::to_string));
        }
        if let Some((name, _)) = text.split_once('=') {
            if VALUE_FLAGS.contains(&name) {
                continue;
            }
        }
        if VALUE_FLAGS.contains(&text) {
            let _ = args.next();
            continue;
        }
        if text == "--open" {
            continue;
        }
        return Some(text.to_string());
    }
    None
}

pub(crate) fn without_command(
    args: &[std::ffi::OsString],
    command: &str,
) -> Vec<std::ffi::OsString> {
    let mut out = Vec::new();
    let mut args = args.iter();
    if let Some(program) = args.next() {
        out.push(program.clone());
    }
    let mut skipped = false;
    while let Some(arg) = args.next() {
        let text = arg.to_str().unwrap_or("");
        if text == "--" {
            out.push(arg.clone());
            out.extend(args.cloned());
            break;
        }
        if let Some((name, _)) = text.split_once('=') {
            if VALUE_FLAGS.contains(&name) {
                out.push(arg.clone());
                continue;
            }
        }
        if VALUE_FLAGS.contains(&text) {
            out.push(arg.clone());
            if let Some(value) = args.next() {
                out.push(value.clone());
            }
            continue;
        }
        if text == "--open" {
            out.push(arg.clone());
            continue;
        }
        if !skipped && text == command {
            skipped = true;
            continue;
        }
        out.push(arg.clone());
    }
    out
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
    let url = http_bind(args.host, args.port);

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
    let mut args = Args::parse();
    if let Some(url) = args
        .url
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        let (host, port) = parse_loopback(&url)?;
        args.host = host;
        args.port = port;
    }
    let config_dir = prepare_config_dir(args.config.clone())?;
    let bind_url = http_bind(args.host, args.port);
    let probe_url = if args
        .url
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        bind_url.clone()
    } else {
        crate::launch::recorded_url(&config_dir).unwrap_or(bind_url)
    };
    let token = crate::launch::existing_token(&config_dir);
    match crate::launch::choose(
        &probe_url,
        crate::launch::inspect(&probe_url, token.as_deref()).await,
    ) {
        crate::launch::Choice::OpenWindow => {
            println!("viewer is already running at {probe_url}");
            open_surface(&config_dir, &probe_url, args.open).await
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

#[derive(Parser, Debug)]
#[command(
    name = "herdr-panels desktop",
    bin_name = "herdr-panels desktop",
    about = "Open the desktop window on a viewer",
    long_about = "Opens the desktop window for the viewer recorded in the config directory, or for --url. When that viewer is not running, the window starts one and passes --herdr-session, --herdr-socket, and --port through."
)]
struct DesktopArgs {
    /// Viewer URL. Defaults to the address recorded in the config directory.
    #[arg(long)]
    url: Option<String>,

    /// Configuration directory. Defaults to the per-user config directory.
    #[arg(long)]
    config: Option<PathBuf>,

    /// Herdr API socket. Wins over --herdr-session and the inherited socket.
    #[arg(long)]
    herdr_socket: Option<PathBuf>,

    /// Named Herdr session. Wins over HERDR_SOCKET_PATH and HERDR_SESSION.
    #[arg(long)]
    herdr_session: Option<String>,

    /// Loopback address used when this window starts a viewer.
    #[arg(long)]
    host: Option<IpAddr>,

    /// Port used when this window starts a viewer.
    #[arg(long)]
    port: Option<u16>,
}

async fn open_desktop_command(raw: &[std::ffi::OsString]) -> anyhow::Result<()> {
    let args = DesktopArgs::parse_from(without_command(raw, "desktop"));
    let config_dir = prepare_config_dir(args.config.clone())?;
    let url = desktop_target_url(&config_dir, args.url, args.host, args.port)?;
    let token = crate::launch::existing_token(&config_dir);
    if let crate::launch::Choice::Refuse(message) =
        crate::launch::choose(&url, crate::launch::inspect(&url, token.as_deref()).await)
    {
        anyhow::bail!(message);
    }
    let herdr_socket = if args.herdr_socket.is_some() || args.herdr_session.is_some() {
        Some(resolve_herdr_socket(
            args.herdr_socket.clone(),
            args.herdr_session.clone(),
        )?)
    } else {
        None
    };
    if crate::client::request_desk_window_at(&config_dir, &url)
        .await
        .is_ok()
    {
        return Ok(());
    }
    open_desktop_with(&DesktopStart {
        url: Some(url),
        config_dir: Some(config_dir),
        herdr_socket,
        herdr_session: args.herdr_session.filter(|value| !value.trim().is_empty()),
    })
}

fn desktop_target_url(
    config_dir: &std::path::Path,
    url: Option<String>,
    host: Option<IpAddr>,
    port: Option<u16>,
) -> anyhow::Result<String> {
    if let Some(url) = url
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        let (host, port) = parse_loopback(&url)?;
        return Ok(http_bind(host, port));
    }
    if host.is_some() || port.is_some() {
        let host = host.unwrap_or(IpAddr::from([127, 0, 0, 1]));
        if !host.is_loopback() {
            anyhow::bail!("refusing to bind {host}: this server is localhost-only");
        }
        let port = port.unwrap_or(4737);
        if port == 0 {
            anyhow::bail!("port must be greater than 0");
        }
        return Ok(http_bind(host, port));
    }
    Ok(crate::launch::recorded_url(config_dir).unwrap_or_else(|| "http://127.0.0.1:4737".into()))
}

fn parse_loopback(url: &str) -> anyhow::Result<(IpAddr, u16)> {
    let parsed = url::Url::parse(url.trim()).context("viewer url is invalid")?;
    if parsed.scheme() != "http" {
        anyhow::bail!("viewer url must be http");
    }
    let host = match parsed.host_str().unwrap_or("") {
        "localhost" | "127.0.0.1" | "::1" => IpAddr::from([127, 0, 0, 1]),
        other => anyhow::bail!("viewer url must stay on localhost, not {other}"),
    };
    let port = parsed.port().unwrap_or(4737);
    if port == 0 {
        anyhow::bail!("port must be greater than 0");
    }
    Ok((host, port))
}

fn http_bind(host: IpAddr, port: u16) -> String {
    match host {
        IpAddr::V4(ip) => format!("http://{ip}:{port}"),
        IpAddr::V6(ip) => format!("http://[{ip}]:{port}"),
    }
}

async fn open_surface(
    config_dir: &std::path::Path,
    url: &str,
    browser_requested: bool,
) -> anyhow::Result<()> {
    match surface_for(find_desktop().is_some(), browser_requested) {
        Surface::Browser => {
            if !browser_requested {
                println!("the desktop window is not installed; opening a browser tab");
            }
            open_browser(url);
            Ok(())
        }
        Surface::Desktop => {
            if crate::client::request_desk_window_at(config_dir, url)
                .await
                .is_ok()
            {
                return Ok(());
            }
            if let Err(err) = spawn_desktop_with(&DesktopStart {
                url: Some(url.to_string()),
                config_dir: Some(config_dir.to_path_buf()),
                herdr_socket: None,
                herdr_session: None,
            }) {
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

pub struct DesktopStart {
    pub url: Option<String>,
    pub config_dir: Option<PathBuf>,
    pub herdr_socket: Option<PathBuf>,
    pub herdr_session: Option<String>,
}

pub fn spawn_desktop() -> anyhow::Result<()> {
    spawn_desktop_at(None)
}

pub fn spawn_desktop_at(url: Option<&str>) -> anyhow::Result<()> {
    spawn_desktop_with(&DesktopStart {
        url: url.map(str::to_string),
        config_dir: None,
        herdr_socket: None,
        herdr_session: None,
    })
}

pub fn spawn_desktop_with(start: &DesktopStart) -> anyhow::Result<()> {
    let mut command = desktop_command(start)?;
    let child = command.spawn().context("starting the desktop window")?;
    reap_child(child);
    Ok(())
}

fn open_desktop_with(start: &DesktopStart) -> anyhow::Result<()> {
    let mut command = desktop_command(start)?;
    let status = command.status().context("starting the desktop window")?;
    if !status.success() {
        anyhow::bail!("desktop window exited with {status}");
    }
    Ok(())
}

fn desktop_command(start: &DesktopStart) -> anyhow::Result<std::process::Command> {
    let path = find_desktop().context(
        "the desktop window is not installed. From the repository root, run: cargo install --path src-tauri",
    )?;
    let mut command = std::process::Command::new(path);
    crate::desk_gate::apply_desktop_env(&mut command, start.url.as_deref());
    if let Some(config) = &start.config_dir {
        command.env("HERDR_PANELS_CONFIG", config);
    }
    if let Some(socket) = &start.herdr_socket {
        command.env("HERDR_PANELS_HERDR_SOCKET", socket);
    }
    if let Some(session) = start
        .herdr_session
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        command.env("HERDR_PANELS_HERDR_SESSION", session);
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
    use std::ffi::OsString;

    use clap::Parser;

    use super::{
        desktop_file_name, desktop_target_url, first_existing, invocation_command, spawn_reaper,
        surface_for, without_command, DesktopArgs, Surface,
    };

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
    fn config_and_url_can_come_before_the_command() {
        let args = |list: &[&str]| list.iter().map(OsString::from).collect::<Vec<_>>();
        assert_eq!(
            invocation_command(&args(&["herdr-panels", "--config", "DIR", "access"])).as_deref(),
            Some("access")
        );
        assert_eq!(
            invocation_command(&args(&[
                "herdr-panels",
                "--url",
                "http://127.0.0.1:4747",
                "panel"
            ]))
            .as_deref(),
            Some("panel")
        );
        assert_eq!(
            invocation_command(&args(&["herdr-panels", "--config=DIR", "status"])).as_deref(),
            Some("status")
        );
        assert_eq!(
            invocation_command(&args(&["herdr-panels", "desktop", "--help"])).as_deref(),
            Some("desktop")
        );
        assert_eq!(
            invocation_command(&args(&["herdr-panels", "--help"])).as_deref(),
            Some("--help")
        );
        assert_eq!(
            invocation_command(&args(&["herdr-panels", "--config", "DIR"])),
            None
        );
        let stripped = without_command(
            &args(&["herdr-panels", "--config", "DIR", "desktop", "--url", "http://127.0.0.1:4747"]),
            "desktop",
        );
        assert_eq!(
            stripped,
            args(&["herdr-panels", "--config", "DIR", "--url", "http://127.0.0.1:4747"])
        );
    }

    #[test]
    fn desktop_help_lists_the_viewer_flags() {
        let err = DesktopArgs::try_parse_from(["herdr-panels", "--help"]).unwrap_err();
        assert_eq!(err.kind(), clap::error::ErrorKind::DisplayHelp);
        let text = err.to_string();
        assert!(text.contains("--url"), "{text}");
        assert!(text.contains("--config"), "{text}");
        assert!(text.contains("--herdr-session"), "{text}");
        assert!(text.contains("--port"), "{text}");
    }

    #[test]
    fn a_desktop_url_or_port_picks_the_viewer() {
        let dir = std::env::temp_dir().join(format!("hwp-desk-url-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(
            desktop_target_url(&dir, None, None, None).unwrap(),
            "http://127.0.0.1:4737"
        );
        assert_eq!(
            desktop_target_url(
                &dir,
                Some("http://127.0.0.1:4747/".into()),
                None,
                Some(4737)
            )
            .unwrap(),
            "http://127.0.0.1:4747"
        );
        assert_eq!(
            desktop_target_url(&dir, None, None, Some(4747)).unwrap(),
            "http://127.0.0.1:4747"
        );
        std::fs::write(dir.join("server.json"), r#"{"url":"http://127.0.0.1:4747"}"#).unwrap();
        assert_eq!(
            desktop_target_url(&dir, None, None, None).unwrap(),
            "http://127.0.0.1:4747"
        );
        let _ = std::fs::remove_dir_all(&dir);
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
