//! Local browser workspace for a running Herdr daemon.
//!
//! Herdr's stable control plane is newline-delimited JSON over a local socket
//! (a Windows named pipe, or a Unix socket). This server speaks that API and
//! serves a single-page workspace of terminals, Markdown, iframes, and custom
//! HTML. The private length-prefixed client protocol is intentionally not used:
//! it is version-locked to one Herdr build.

pub mod agent;
pub mod auth;
pub mod bundle;
pub mod chats;
pub mod cli;
pub mod client;
pub mod config;
pub mod content;
pub mod desk;
pub mod external_link;
pub mod files;
pub mod frame_pass;
pub mod herdr;
pub mod herdr_config;
pub mod herdr_ctl;
pub mod keys;
pub mod launch;
pub mod launcher;
pub mod layout;
pub mod layout_ops;
pub mod local_open;
pub mod migrate;
pub mod open_target;
pub mod paths;
pub mod plugin_command;
pub mod plugin_files;
pub mod plugin_grant;
pub mod plugins;
pub mod proxy;
pub mod quiet_process;
pub mod self_update;
pub mod server;
pub mod session;
pub mod session_proc;
pub mod store;
pub mod terminal;
pub mod terminal_size;
pub mod watch;

pub use server::{build_app, serve};

/// Identity of this build of the viewer. `/api/health` reports it.
/// The desktop starts its own viewer when a running one reports a different value.
pub const BUILD_ID: &str = env!("HERDR_PANELS_BUILD");
