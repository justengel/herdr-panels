use std::path::PathBuf;

use anyhow::{bail, Context};
use clap::{Parser, Subcommand};
use serde_json::{json, Value};

use crate::config::prepare_config_dir;
use crate::plugins;

#[derive(Parser, Debug)]
#[command(
    name = "herdr-panels",
    version,
    about = "Herdr viewer with installable HTML panels",
    long_about = "herdr-panels server runs the viewer.\nherdr-panels panel and herdr-panels plugin talk to that running viewer."
)]
struct ClientCli {
    /// Viewer URL. Defaults to the address recorded by the running server.
    #[arg(long)]
    url: Option<String>,

    /// Configuration directory. Defaults to the per-user config directory.
    #[arg(long)]
    config: Option<PathBuf>,

    #[command(subcommand)]
    command: ClientCommand,
}

#[derive(Subcommand, Debug)]
enum ClientCommand {
    /// Show whether the viewer is running
    Status,
    /// Arrange the open layout
    Panel {
        #[command(subcommand)]
        command: PanelCommand,
    },
    /// Install and list view plugins
    Plugin {
        #[command(subcommand)]
        command: PluginCommand,
    },
}

#[derive(Subcommand, Debug)]
enum PanelCommand {
    /// List panels in the open layout
    List,
    /// Split a panel and place a new one beside it
    Split {
        /// Panel to split, by name or id
        from: String,
        /// right or down
        #[arg(long)]
        direction: String,
        #[arg(long)]
        title: Option<String>,
        /// herdr, markdown, html, iframe, or plugin
        #[arg(long, default_value = "herdr")]
        kind: String,
        #[arg(long)]
        path: Option<String>,
        #[arg(long)]
        page: Option<String>,
        #[arg(long)]
        plugin: Option<String>,
        #[arg(long)]
        pane: Option<String>,
        /// Also split the Herdr pane when the source is a terminal
        #[arg(long)]
        herdr: bool,
    },
    /// Close a panel. The last panel stays open
    Close { panel: String },
    /// Set a panel's share of the nearest divider, from 0.12 to 0.88
    Resize { panel: String, ratio: f64 },
    /// Move a panel onto another
    Move {
        panel: String,
        #[arg(long)]
        to: String,
        /// swap, right, or below
        #[arg(long, default_value = "swap")]
        place: String,
    },
    /// Change a panel's name or what it shows
    Update {
        /// Panel to change, by name or id
        panel: String,
        #[arg(long)]
        title: Option<String>,
        /// herdr, markdown, html, iframe, or plugin
        #[arg(long)]
        kind: Option<String>,
        #[arg(long)]
        path: Option<String>,
        #[arg(long)]
        page: Option<String>,
        #[arg(long)]
        plugin: Option<String>,
        #[arg(long)]
        pane: Option<String>,
    },
    /// Fill the page with one panel. Omit the panel to restore the layout
    Zoom { panel: Option<String> },
    /// Open a file, directory, or http URL in a panel
    Open {
        /// File path, directory, or http(s) URL
        target: String,
        /// Existing panel to replace, by name or id. Omit to add a panel
        #[arg(long)]
        panel: Option<String>,
        /// Panel to split when adding. Defaults to the last content panel
        #[arg(long)]
        from: Option<String>,
        /// right or down. Used when adding a panel
        #[arg(long, default_value = "right")]
        direction: String,
        #[arg(long)]
        title: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
enum PluginCommand {
    /// List installed view plugins
    List,
    /// Copy a plugin directory into the config plugins folder
    Install {
        path: PathBuf,
        /// Replace an installed plugin with the same id
        #[arg(long)]
        replace: bool,
    },
}

pub async fn execute() -> anyhow::Result<()> {
    let cli = ClientCli::parse();
    let config_dir = prepare_config_dir(cli.config)?;
    match cli.command {
        ClientCommand::Status => status(&config_dir, cli.url).await,
        ClientCommand::Panel { command } => {
            let base = server_url(&config_dir, cli.url)?;
            panel_command(&base, command).await
        }
        ClientCommand::Plugin { command } => match command {
            PluginCommand::List => {
                for plugin in plugins::list_plugins(&config_dir)? {
                    println!("{}\t{}\t{}", plugin.id, plugin.title, plugin.entry);
                }
                Ok(())
            }
            PluginCommand::Install { path, replace } => {
                let manifest = plugins::install_plugin(&config_dir, &path, replace)?;
                println!("installed {} ({})", manifest.id, manifest.title);
                Ok(())
            }
        },
    }
}

async fn status(config_dir: &std::path::Path, url: Option<String>) -> anyhow::Result<()> {
    let base = server_url(config_dir, url)?;
    match call(&base, "GET", "/api/health", None).await {
        Ok(body) => {
            println!("{base}");
            println!("{body}");
            Ok(())
        }
        Err(err) => bail!("viewer is not running at {base}: {err}"),
    }
}

async fn panel_command(base: &str, command: PanelCommand) -> anyhow::Result<()> {
    match command {
        PanelCommand::List => {
            let body = call(base, "GET", "/api/agent/workspace", None).await?;
            let value: Value = serde_json::from_str(&body)?;
            for panel in value.get("panels").and_then(Value::as_array).into_iter().flatten() {
                println!(
                    "{}\t{}\t{}\t{}",
                    panel.get("id").and_then(Value::as_str).unwrap_or(""),
                    panel.get("title").and_then(Value::as_str).unwrap_or(""),
                    panel.get("type").and_then(Value::as_str).unwrap_or(""),
                    panel.get("summary").and_then(Value::as_str).unwrap_or("")
                );
            }
            Ok(())
        }
        PanelCommand::Split {
            from,
            direction,
            title,
            kind,
            path,
            page,
            plugin,
            pane,
            herdr,
        } => {
            let mut body = json!({
                "panelId": from,
                "direction": direction,
                "herdr": herdr,
            });
            if let Some(title) = title {
                body["title"] = json!(title);
            }
            if let Some(panel) = panel_config(&kind, path, page, plugin, pane)? {
                body["panel"] = panel;
            }
            let response = call(base, "POST", "/api/agent/split", Some(body)).await?;
            println!("{response}");
            Ok(())
        }
        PanelCommand::Close { panel } => {
            let response = call(
                base,
                "POST",
                "/api/agent/close",
                Some(json!({ "panelId": panel })),
            )
            .await?;
            println!("{response}");
            Ok(())
        }
        PanelCommand::Resize { panel, ratio } => {
            let response = call(
                base,
                "POST",
                "/api/agent/resize",
                Some(json!({ "panelId": panel, "ratio": ratio })),
            )
            .await?;
            println!("{response}");
            Ok(())
        }
        PanelCommand::Move { panel, to, place } => {
            let response = call(
                base,
                "POST",
                "/api/agent/move",
                Some(json!({ "panelId": panel, "target": to, "place": place })),
            )
            .await?;
            println!("{response}");
            Ok(())
        }
        PanelCommand::Update {
            panel,
            title,
            kind,
            path,
            page,
            plugin,
            pane,
        } => {
            let mut body = json!({ "panelId": panel });
            if let Some(title) = title {
                body["title"] = json!(title);
            }
            if let Some(kind) = kind {
                body["panel"] = panel_config(&kind, path, page, plugin, pane)?
                    .context("panel kind was empty")?;
            }
            let response = call(base, "POST", "/api/agent/update", Some(body)).await?;
            println!("{response}");
            Ok(())
        }
        PanelCommand::Zoom { panel } => {
            let response = call(
                base,
                "POST",
                "/api/agent/zoom",
                Some(json!({ "panelId": panel })),
            )
            .await?;
            println!("{response}");
            Ok(())
        }
        PanelCommand::Open {
            target,
            panel,
            from,
            direction,
            title,
        } => {
            let mut body = json!({ "target": target, "direction": direction });
            if let Some(panel) = panel {
                body["panelId"] = json!(panel);
            }
            if let Some(from) = from {
                body["from"] = json!(from);
            }
            if let Some(title) = title {
                body["title"] = json!(title);
            }
            let response = call(base, "POST", "/api/agent/open", Some(body)).await?;
            println!("{response}");
            Ok(())
        }
    }
}

fn panel_config(
    kind: &str,
    path: Option<String>,
    page: Option<String>,
    plugin: Option<String>,
    pane: Option<String>,
) -> anyhow::Result<Option<Value>> {
    let panel = match kind {
        "herdr" => json!({ "type": "herdr", "paneId": pane }),
        "markdown" => json!({ "type": "markdown", "path": path.unwrap_or_else(|| "notes/welcome.md".into()) }),
        "html" => json!({ "type": "html", "path": path.unwrap_or_else(|| "panels/session-board.html".into()) }),
        "iframe" => json!({ "type": "iframe", "url": page.context("--page is required for an iframe panel")?, "proxy": false }),
        "plugin" => json!({ "type": "plugin", "plugin": plugin.context("--plugin is required for a plugin panel")? }),
        "tabs" => json!({
            "type": "tabs",
            "edge": "top",
            "active": "tab-1",
            "tabs": [{
                "id": "tab-1",
                "title": "New tab",
                "panel": { "type": "iframe", "url": "", "proxy": false }
            }]
        }),
        "files" => json!({ "type": "files" }),
        "agents" => json!({ "type": "agents" }),
        other => bail!("unknown panel kind {other}"),
    };
    Ok(Some(panel))
}

pub fn record_server(config_dir: &std::path::Path, url: &str) -> anyhow::Result<()> {
    let path = config_dir.join("server.json");
    let body = json!({ "url": url }).to_string();
    std::fs::write(&path, body).with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

fn server_url(config_dir: &std::path::Path, explicit: Option<String>) -> anyhow::Result<String> {
    if let Some(url) = explicit {
        return Ok(url.trim_end_matches('/').to_string());
    }
    let path = config_dir.join("server.json");
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            if let Some(url) = value.get("url").and_then(Value::as_str) {
                return Ok(url.trim_end_matches('/').to_string());
            }
        }
    }
    Ok("http://127.0.0.1:4737".into())
}

async fn call(base: &str, method: &str, path: &str, body: Option<Value>) -> anyhow::Result<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .no_proxy()
        .build()?;
    let url = format!("{base}{path}");
    let request = client.request(method.parse().unwrap_or(reqwest::Method::GET), &url);
    let request = if let Some(body) = body {
        request
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body.to_string())
    } else {
        request
    };
    let response = request.send().await.with_context(|| format!("connecting to {url}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!("{status}: {text}");
    }
    Ok(text)
}
