use std::io::{IsTerminal, Write};
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
    long_about = "herdr-panels starts the viewer and opens the desktop window when that program is installed, or a browser tab otherwise. When the viewer is already running, it opens the window and exits.\nherdr-panels server runs the viewer without opening a window.\nherdr-panels desktop opens the desktop window. On its own it starts a viewer when the address is closed, and that viewer stops when the window closes.\nherdr-panels install-launcher writes the Linux application menu entry and icons.\nherdr-panels update downloads the latest GitHub release and replaces this program. When the desktop window is beside it, that program is replaced from the same release. A viewer that is already running is stopped and started again on the same address, and an open desktop window is opened again.\nherdr-panels panel, plugin, and token talk to that viewer or its config."
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
    /// Install, uninstall, and list view plugins
    Plugin {
        #[command(subcommand)]
        command: PluginCommand,
    },
    /// Replace the viewer token stored beside server.json
    Token {
        #[command(subcommand)]
        command: TokenCommand,
    },
}

#[derive(Subcommand, Debug)]
enum TokenCommand {
    /// Generate a new viewer token. Restart the viewer afterward
    Rotate,
    /// Save a token you created. Restart the viewer afterward
    Set {
        /// 32 to 256 characters: letters, digits, and - . _ ~ + / =
        #[arg(allow_hyphen_values = true)]
        value: String,
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
    /// Show panels from any space over this one. Omit the names to list every space
    Visit {
        /// Panel names or ids. Leave these out to list panels on every space
        panels: Vec<String>,
        /// row, column, or grid. Two panels sit side by side; three or more use a grid
        #[arg(long)]
        arrange: Option<String>,
    },
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
        /// Plugin directory. Omit this with --example
        path: Option<PathBuf>,
        /// Install the bundled Welcome example
        #[arg(long)]
        example: bool,
        /// Replace an installed plugin with the same id
        #[arg(long)]
        replace: bool,
        /// Install without asking about the plugin's permissions
        #[arg(long)]
        yes: bool,
    },
    /// Remove an installed view plugin
    Uninstall {
        /// Plugin id printed by plugin list
        id: String,
    },
}

pub async fn execute() -> anyhow::Result<()> {
    let cli = ClientCli::parse();
    let config_dir = prepare_config_dir(cli.config)?;
    match cli.command {
        ClientCommand::Status => status(&config_dir, cli.url).await,
        ClientCommand::Panel { command } => {
            let base = server_url(&config_dir, cli.url)?;
            let token = crate::auth::session_token(&config_dir)?;
            panel_command(&base, &token, command).await
        }
        ClientCommand::Plugin { command } => match command {
            PluginCommand::List => {
                for plugin in plugins::list_plugins(&config_dir)? {
                    println!(
                        "{}\t{}\t{}\t{}",
                        plugin.id,
                        plugin.title,
                        plugin.entry,
                        crate::plugin_grant::permission_summary(&plugin.permissions)
                    );
                }
                Ok(())
            }
            PluginCommand::Install {
                path,
                example,
                replace,
                yes,
            } => {
                if example && path.is_some() {
                    bail!("pass a plugin directory or --example, not both");
                }
                let preview = if example {
                    plugins::bundled_welcome_manifest()?
                } else {
                    let Some(path) = path.as_deref() else {
                        bail!("pass a plugin directory, or --example to install the sample plugin");
                    };
                    plugins::read_manifest_file(&path.join("plugin.json"))?
                };
                confirm_install(&preview, yes)?;
                let manifest = if example {
                    plugins::install_bundled_example(&config_dir, replace)?
                } else {
                    let Some(path) = path else {
                        bail!("pass a plugin directory, or --example to install the sample plugin");
                    };
                    plugins::install_plugin(&config_dir, &path, replace)?
                };
                println!("installed {} ({})", manifest.id, manifest.title);
                Ok(())
            }
            PluginCommand::Uninstall { id } => {
                let manifest = plugins::uninstall_plugin(&config_dir, &id)?;
                println!("uninstalled {} ({})", manifest.id, manifest.title);
                Ok(())
            }
        },
        ClientCommand::Token { command } => token_command(&config_dir, command),
    }
}

fn confirm_install(manifest: &plugins::PluginManifest, yes: bool) -> anyhow::Result<()> {
    if !crate::plugin_grant::needs_consent(&manifest.permissions) {
        return Ok(());
    }
    let text = crate::plugin_grant::consent_text(
        &manifest.id,
        &manifest.title,
        &manifest.permissions,
        &manifest.files,
    );
    println!("{text}");
    if yes {
        return Ok(());
    }
    if !std::io::stdin().is_terminal() {
        bail!(
            "plugin {} asks for permissions. Pass --yes to install it without a prompt",
            manifest.id
        );
    }
    print!("Install this plugin? [y/N] ");
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    std::io::stdin()
        .read_line(&mut line)
        .context("reading the install confirmation")?;
    if !crate::plugin_grant::consent_answer(&line) {
        bail!("plugin install cancelled");
    }
    Ok(())
}

fn token_command(config_dir: &std::path::Path, command: TokenCommand) -> anyhow::Result<()> {
    match command {
        TokenCommand::Rotate => {
            crate::auth::rotate(config_dir)?;
            println!("Rotated the viewer token. Restart the viewer so it picks up the new value, then reload the page.");
        }
        TokenCommand::Set { value } => {
            crate::auth::set_token(config_dir, &value)?;
            println!("Saved the viewer token. Restart the viewer so it picks up the new value, then reload the page.");
        }
    }
    if std::env::var(crate::auth::ENV)
        .ok()
        .is_some_and(|value| !value.trim().is_empty())
    {
        println!(
            "HERDR_PANELS_TOKEN is set, so a viewer started with that variable keeps using it until the variable is unset."
        );
    }
    Ok(())
}

async fn status(config_dir: &std::path::Path, url: Option<String>) -> anyhow::Result<()> {
    let base = server_url(config_dir, url)?;
    let token = crate::auth::session_token(config_dir)?;
    match call(&base, &token, "GET", "/api/health", None).await {
        Ok(body) => {
            println!("{base}");
            println!("{body}");
            Ok(())
        }
        Err(err) => bail!("viewer is not running at {base}: {err}"),
    }
}

async fn panel_command(base: &str, token: &str, command: PanelCommand) -> anyhow::Result<()> {
    match command {
        PanelCommand::List => {
            let body = call(base, token, "GET", "/api/agent/workspace", None).await?;
            let value: Value = serde_json::from_str(&body)?;
            for panel in value
                .get("panels")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
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
            let response = call(base, token, "POST", "/api/agent/split", Some(body)).await?;
            println!("{response}");
            Ok(())
        }
        PanelCommand::Close { panel } => {
            let response = call(
                base,
                token,
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
                token,
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
                token,
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
            let response = call(base, token, "POST", "/api/agent/update", Some(body)).await?;
            println!("{response}");
            Ok(())
        }
        PanelCommand::Zoom { panel } => {
            let response = call(
                base,
                token,
                "POST",
                "/api/agent/zoom",
                Some(json!({ "panelId": panel })),
            )
            .await?;
            println!("{response}");
            Ok(())
        }
        PanelCommand::Visit { panels, arrange } => {
            if panels.is_empty() {
                let body = call(base, token, "GET", "/api/agent/spaces", None).await?;
                let value: Value = serde_json::from_str(&body)?;
                for space in value
                    .get("spaces")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let mark = if space.get("current").and_then(Value::as_bool) == Some(true) {
                        "*"
                    } else {
                        ""
                    };
                    let space_id = space.get("id").and_then(Value::as_str).unwrap_or("");
                    let label = space.get("label").and_then(Value::as_str).unwrap_or("");
                    for panel in space
                        .get("panels")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        println!(
                            "{mark}\t{space_id}\t{label}\t{}\t{}\t{}\t{}",
                            panel.get("id").and_then(Value::as_str).unwrap_or(""),
                            panel.get("title").and_then(Value::as_str).unwrap_or(""),
                            panel.get("type").and_then(Value::as_str).unwrap_or(""),
                            panel.get("summary").and_then(Value::as_str).unwrap_or("")
                        );
                    }
                }
                return Ok(());
            }
            let mut body = json!({ "panelIds": panels });
            if let Some(arrange) = arrange {
                body["arrange"] = json!(arrange);
            }
            let response = call(base, token, "POST", "/api/agent/visit", Some(body)).await?;
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
            let response = call(base, token, "POST", "/api/agent/open", Some(body)).await?;
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
        "markdown" => {
            json!({ "type": "markdown", "path": path.unwrap_or_else(|| "notes/welcome.md".into()) })
        }
        "html" => {
            json!({ "type": "html", "path": path.unwrap_or_else(|| "panels/session-board.html".into()) })
        }
        "iframe" => {
            json!({ "type": "iframe", "url": page.context("--page is required for an iframe panel")?, "proxy": false })
        }
        "plugin" => {
            json!({ "type": "plugin", "plugin": plugin.context("--plugin is required for a plugin panel")? })
        }
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
    let body = json!({ "url": url, "pid": std::process::id() }).to_string();
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

async fn call(
    base: &str,
    token: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> anyhow::Result<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .no_proxy()
        .build()?;
    let url = format!("{base}{path}");
    let request = client
        .request(method.parse().unwrap_or(reqwest::Method::GET), &url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"));
    let request = if let Some(body) = body {
        request
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body.to_string())
    } else {
        request
    };
    let response = request
        .send()
        .await
        .with_context(|| format!("connecting to {url}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!("{status}: {text}");
    }
    Ok(text)
}
