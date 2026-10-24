//! Local browser workspace for a running Herdr daemon.
//!
//! Herdr's stable control plane is newline-delimited JSON over a local socket
//! (a Windows named pipe, or a Unix socket). This server speaks that API and
//! serves a single-page workspace of terminals, Markdown, iframes, and custom
//! HTML. The private length-prefixed client protocol is intentionally not used:
//! it is version-locked to one Herdr build.

pub mod agent;
pub mod chats;
pub mod cli;
pub mod client;
pub mod config;
pub mod content;
pub mod files;
pub mod herdr;
pub mod herdr_config;
pub mod keys;
pub mod layout;
pub mod layout_ops;
pub mod open_target;
pub mod paths;
pub mod plugins;
pub mod proxy;
pub mod server;
pub mod session;
pub mod session_proc;
pub mod store;
pub mod terminal;
pub mod terminal_size;
pub mod watch;

pub use server::{build_app, serve};
