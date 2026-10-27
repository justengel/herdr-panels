# Follow-ups

Recorded 2026-10-27 from the review before the first public release. Closed items are here so this list stays the place to come back to.

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

The window is in the release archive. Tauri packaging is still off (`bundle.active` is false), so there is no `.deb`, `.msi`, or `.dmg`. The window turns devtools on and sets no content security policy. Linux still needs the system WebKitGTK package named above.

### Code signing

The archives are unsigned on purpose. Windows SmartScreen and macOS Gatekeeper will warn. A certificate costs money.

### A test against a live Herdr

`cargo test` and the Vitest suite do not start Herdr. Nothing in CI attaches to a live pane, splits one, or checks the polled terminal screen.

### Machines the release does not cover

There is no Intel Mac archive and no Linux arm64 archive. The macOS archive is Apple Silicon because that is the current GitHub macOS runner. The Linux archive is built on the current Ubuntu runner. It links that system's OpenSSL 3 and Wayland client libraries. Ubuntu 22.04 and 24.04 desktops have both. Ubuntu 20.04 does not have OpenSSL 3.

### Herdr action lifetime

Confirm on a running Herdr that Open Herdr Panels behaves the way you want. The action command is `herdr-panels` itself, so it keeps running until the viewer exits. A startup hook is the wrong place for that: Herdr expects startup hooks to exit and expects plugins not to leave a detached process behind.

### File dialog on Linux

Choose-file uses the XDG desktop portal. An Ubuntu desktop session has it. A machine without the portal can still run the desk; that dialog fails there.

### crates.io later

`cargo install herdr-panels` is only worth publishing if people who already have Rust should compile from source. The GitHub archive remains the program everyone else runs.
