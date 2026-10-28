# Changelog

## Unreleased

A view plugin can declare permissions. `herdr:read` and `herdr:control` give it the same `herdrPanels` bridge as an HTML panel, still without the viewer token. `herdr:control` types, focuses, and scrolls an open pane only when that panel's layout also sets `"control": true`. `panels:read` lists the panels on the desk. `panels:control` opens, updates, closes, moves, and resizes them, fills the screen with one panel, shows the whole desk again, or sets the desktop window zoom, and cannot turn on `"control": true`. `examples/plugins/desk-sample` exercises those two permissions on `https://example.com` and does not draw the rest of the desk. `files:read`, with a `files` list of absolute paths, makes the server push those files into the frame and again when they change. `herdr-panels plugin install` prints the request and asks before copying; `--yes` skips the question. `plugin list` shows the permissions. Prefix+Z and Prefix+Shift+Z go back and forward in the selected panel, the same as its address bar. Prefix+T reopens the last closed panel, newest first. Prefix+F fills the screen. The prefix also works while a plugin, an HTML panel, or a browser panel has the keyboard. Clicking one of those panels selects it even when the page inside keeps the click. Ctrl+B in a plugin frame reaches the desk, the same way it does in a terminal.

## 0.1.2 - 2026-10-27

The release archive includes the desktop window. `herdr-panels` opens it when `herdr-panels-desktop` is in the same folder. On Linux that window needs WebKitGTK 4.1 (`libwebkit2gtk-4.1-0`).

## 0.1.1 - 2026-10-27

First downloadable release. The Linux build installs the OpenSSL and Wayland headers the file dialog needs. The `v0.1.0` tag did not publish a release.

## 0.1.0 - 2026-10-27

The program is a desk for a running Herdr session: live panes, notes, browsers, HTML, files, and installed views. The release binary includes the page and the example files, so running it does not require Node, Rust, or this repository.
