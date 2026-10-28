# Changelog

## Unreleased

`herdr-panels update` stops a running viewer and starts the new program on the same address. An open desktop window is closed and opened again so it loads the new page. The viewer records its process id in `server.json`. The open desk reloads its plugin list, so `herdr-panels plugin install` shows up without restarting the viewer. `herdr-panels plugin uninstall <id>` removes that plugin, and the desk drops it from the menu.

## 0.1.6 - 2026-10-28

`herdr-panels` opens the desktop window and exits when the viewer is already running. Another program on that address is reported as not a herdr-panels viewer. The desktop child is waited on, so closing the window does not leave a zombie, and the viewer keeps running. `herdr-panels install-launcher` writes a desktop entry with `StartupWMClass=herdr-panels-desktop` and hicolor icons at 48, 128, and 256 pixels plus the SVG. The window icon is the 256 pixel image.

## 0.1.5 - 2026-10-28

The Windows path helper is compiled only on Windows, so the macOS and Linux builds succeed.

## 0.1.4 - 2026-10-28

A file grant stays inside its directory on macOS when an existing folder, such as `/home` or `/Users`, is a firmlink. Path checks use each system's own separators. `herdr-panels update` is the only update command.

## 0.1.3 - 2026-10-28

The desktop panels scale together so a high-resolution screen stays readable, without growing the session bar or losing the terminal's place in its history. A view plugin can declare permissions. `herdr:read` and `herdr:control` give it the same `herdrPanels` bridge as an HTML panel, still without the viewer token. `herdr:control` types, focuses, and scrolls an open pane only when that panel's layout also sets `"control": true`. `panels:read` lists the panels on the desk. `panels:control` opens, updates, closes, moves, and resizes them, fills the screen with one panel, shows the whole desk again, or sets the desktop window zoom, and cannot turn on `"control": true`. `examples/plugins/desk-sample` exercises those two permissions on `https://example.com` and does not draw the rest of the desk. `files:read`, with a `files` list of absolute paths, makes the server push those files into the frame and again when they change. `herdr-panels plugin install` prints the request and asks before copying; `--yes` skips the question. `plugin list` shows the permissions. Prefix+Z and Prefix+Shift+Z go back and forward in the selected panel, the same as its address bar. Prefix+T reopens the last closed panel, newest first. Prefix+F fills the screen. The prefix also works while a plugin, an HTML panel, or a browser panel has the keyboard. Clicking one of those panels selects it even when the page inside keeps the click. Ctrl+B in a plugin frame reaches the desk, the same way it does in a terminal. `herdr-panels update` downloads the latest GitHub release for this system and replaces the program. When the desktop window is in the same folder, that program is replaced from the same release. A copy that is still in a cargo target directory is left unchanged. Restart the viewer afterward. Mac releases cover Apple Silicon and Intel. On macOS, `herdr-panels update` clears the browser download mark on the programs it replaces. The archives stay unsigned.

## 0.1.2 - 2026-10-27

The release archive includes the desktop window. `herdr-panels` opens it when `herdr-panels-desktop` is in the same folder. On Linux that window needs WebKitGTK 4.1 (`libwebkit2gtk-4.1-0`).

## 0.1.1 - 2026-10-27

First downloadable release. The Linux build installs the OpenSSL and Wayland headers the file dialog needs. The `v0.1.0` tag did not publish a release.

## 0.1.0 - 2026-10-27

The program is a desk for a running Herdr session: live panes, notes, browsers, HTML, files, and installed views. The release binary includes the page and the example files, so running it does not require Node, Rust, or this repository.
