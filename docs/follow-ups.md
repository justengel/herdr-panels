# Follow-ups

Recorded 2026-10-27 from the review before the first public release. Closed items are here so this list stays the place to come back to.

## Unreleased

## Done in 0.1.12

- Each browser tab keeps its own Herdr session. Switching a session changes only that tab.
- A plugin bridge call is looked up in the space that is showing the panel. `herdrPanels.context()` returns that panel and space.
- `panel list` shows whether control is on. `panel open --id` chooses the new panel's id. A `files` path may start with `~` or `${HOME}`. Opening again with reuse replaces the last note, file, HTML page, or browser panel.

## Done in 0.1.11

- A space stays on the Herdr tab you left, and both tab bars can be renamed, reordered, and closed.
- A Terminal panel shows one shell. Panes still shows every tab in the space. A panel stays unnamed until someone types a name, and this version clears the old automatic labels.
- Panel commands can name a workspace. A new space keeps a bound terminal, a closed space leaves the desk, and the window you type in owns the pane size.
- Each panel zooms on its own. Selecting the whole address bar copies the home shortcut.

## Done in 0.1.10

- Selecting an element and choosing Screenshot works in the Ubuntu desktop window. WebKit `color()` values are rewritten before the image is drawn, and a panel page is painted when that window will not export the SVG capture.

## Done in 0.1.9

- The Windows launch script reads the program folder from the path text, so that check passes on Linux and macOS.
- A push to master runs the page tests and `cargo test` on Ubuntu, Windows, and both macOS runners. The version tag is created after that run succeeds and the release archives are built. A failed test leaves no tag.

## Done in 0.1.8

- `herdr-panels install-launcher` writes a Windows Start menu shortcut and a macOS app in the home Applications folder, and still writes the Linux desktop entry. An in-place update leaves that entry pointed at the same program.
- A plugin `commands:run` permission runs an allowlisted program from PATH, with no shell, and only inside an open project.

## Done in 0.1.7

- Selecting an element and choosing Screenshot asks before saving a PNG. A cancelled save writes nothing.
- `herdr-panels update` stops a running viewer and starts the new program on the same address. The open desk shows a plugin after `plugin install` and drops it after `plugin uninstall`.

## Done in 0.1.6

- `herdr-panels` opens the desktop window when the viewer is already running, and `herdr-panels install-launcher` writes the Linux menu entry and hicolor icons.

## Done in 0.1.5

- The Windows path helper is compiled only on Windows, so the macOS and Linux builds succeed.

## Done in 0.1.4

- A file grant stays inside its directory on macOS when an existing folder is a firmlink. Paths use each system's own separators.

## Done in 0.1.3

- `herdr-panels update` downloads the latest GitHub release and replaces the program. When the desktop window is in the same folder, that program is replaced from the same release.
- The release includes an Intel Mac archive, built on GitHub's free `macos-15-intel` runner. The archives stay unsigned.

## Done in 0.1.2

- The release archive includes `herdr-panels-desktop`. Running `herdr-panels` from that folder opens the window. Linux needs `libwebkit2gtk-4.1-0`.

## Done in 0.1.1

- The release binary contains the built page and the examples. Moving the program away from this checkout no longer shows the setup page, and the first start can still seed a config directory.
- GitHub Actions runs the page tests and `cargo test` on Ubuntu and Windows. A version tag builds Linux x64, Windows x64, and macOS Apple Silicon archives and attaches them to a GitHub Release.
- The public repository is the install path. npm stays private. crates.io stays unpublished.
- `herdr-plugin.toml` registers one Herdr action, Open Herdr Panels. It does not compile the app. The `herdr-plugin` topic is what the Herdr plugin index looks for.
- The README panel table includes `explorer`, `file`, and `blank`.

## Still open

### Desktop installers

The window is in the release archive. Tauri packaging is still off (`bundle.active` is false), so there is no `.deb`, `.msi`, or `.dmg`. `herdr-panels install-launcher` writes the Linux desktop entry and hicolor icons, a Windows Start menu shortcut, and a macOS app in the home Applications folder. A `cargo install` of the desktop program on the GNU Windows toolchain does not copy `WebView2Loader.dll` next to `herdr-panels-desktop.exe`. The MSVC build links that loader into the program, which is what the GitHub Windows archive uses. The window turns devtools on and sets no content security policy. Linux still needs the system WebKitGTK package named above. The dock icon and the menu's starting spinner still need a check on an X11 session.

### Code signing

The archives are unsigned on purpose. Windows SmartScreen and macOS Gatekeeper will warn. A certificate costs money.

### A test against a live Herdr

`cargo test` and the Vitest suite do not start Herdr. Nothing in CI attaches to a live pane, splits one, or checks the polled terminal screen.

### Machines the release does not cover

There is no Linux arm64 archive. The Linux archive is built on the current Ubuntu runner. It links that system's OpenSSL 3 and Wayland client libraries. Ubuntu 22.04 and 24.04 desktops have both. Ubuntu 20.04 does not have OpenSSL 3.

### Herdr action lifetime

Confirm on a running Herdr that Open Herdr Panels behaves the way you want. The action command is `herdr-panels` itself, so it keeps running until the viewer exits. A startup hook is the wrong place for that: Herdr expects startup hooks to exit and expects plugins not to leave a detached process behind.

### File dialog on Linux

Choose-file uses the XDG desktop portal. An Ubuntu desktop session has it. A machine without the portal can still run the desk; that dialog fails there.

### crates.io later

`cargo install herdr-panels` is only worth publishing if people who already have Rust should compile from source. The GitHub archive remains the program everyone else runs.
