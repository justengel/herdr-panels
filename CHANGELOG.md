# Changelog

## Unreleased

## 0.1.13 - 2026-10-30

In the agents list, a space with more than one Herdr tab shows that tab's name beside the space, such as `herdr-panels · general`. A space with one tab shows only the space name.

## 0.1.12 - 2026-10-30

Each browser tab keeps its own Herdr session. A new tab starts on `default`. Refreshing a tab keeps that tab's session. Switching, creating, renaming, or closing a session changes only that tab. Closing a tab leaves the other session connected.

A plugin bridge call names the space it is running in, and the server looks up that panel only in that space. The same panel id in another space no longer answers first. `herdrPanels.context()` returns this panel and space. The host also posts `{ source: "hwp-host", type: "context", panelId, spaceId }` when the frame loads. A bridge error names the panel and the space it checked.

`herdr-panels panel list` adds a control column: `on`, `off`, or empty. `herdr-panels panel open --id` chooses the new panel's id in this space. A `files` path may start with `~` or `${HOME}`.

Opening again with reuse, and without `--from` or `--panel`, replaces the last note, file, HTML page, or browser panel. A plugin panel is left as it is.

## 0.1.11 - 2026-10-30

A space stays on the Herdr tab you left. Both tab bars can be renamed, reordered, and closed.

A Herdr panel is either Panes, which shows every tab in the space, or a Terminal, which shows one shell and has no tab strip. Several Terminal panels can be open at once. Closing Panes leaves the shells open. A panel has no saved name until someone types one, and the title bar shows the file, folder, site, or the panel type. The first start of this version clears names that were filled in automatically, such as Panes, Terminal, Files, Spaces, and Agents. A name someone typed stays, including a tab's own label.

Panel commands take `--space` to edit that workspace and leave the focused space as it is. A new space keeps a bound terminal. Closing a space removes it from the desk. The terminal stays live for every open window, and the window you type in owns the pane size.

Ctrl+wheel zooms the panel under the pointer. Ctrl+0, Ctrl++, and Ctrl+- zoom the panel with the gold bar. With no panel selected, those keys zoom the panel under the pointer while this window is in front. With the pointer somewhere else, Ctrl+0 returns every panel to 100%. Clicking the session bar clears that bar. Steps are 10% from 50% to 200%, and 25% from there down to 25% and up to 300%. A terminal changes its font size. A browser panel and a plugin zoom their own page. The same keys and wheel work in a browser tab, one panel at a time. Spaces and agents stay as they are unless the zoom is aimed at them.

Selecting the whole address bar copies the home shortcut, such as a path that starts with `~`, instead of the shortened path shown on the bar.

## 0.1.10 - 2026-10-29

Selecting an element and choosing Screenshot works in the Ubuntu desktop window. WebKit colors from `color-mix()` are written as `rgb()` before the image is drawn. A page inside a panel is painted directly when that window will not export the SVG capture.

## 0.1.9 - 2026-10-29

The Windows Start menu script stores the viewer's folder from the path text. Downloads for the 0.1.8 menu and plugin-command changes start with this release.

## 0.1.8 - 2026-10-29

A plugin can declare `commands:run` and a `commands` list of program names. `herdrPanels.run(name, args, cwd)` runs that program from PATH, with no shell, in a directory the desk already has open. Install asks before granting it.

`herdr-panels install-launcher` adds a Windows Start menu shortcut and a macOS app in the home Applications folder. Both start `herdr-panels`, so the viewer stays up when the window closes. On Windows the shortcut hides the console. On macOS the app does not keep a Dock icon of its own; the desktop window is the one that shows. `herdr-panels update` replaces the programs in the same folder and leaves that menu entry pointed at them. Run `install-launcher` again when the program moves.

## 0.1.7 - 2026-10-28

Selecting an element and choosing Screenshot asks whether to save a PNG. The image is still copied to the clipboard when that works. Save opens a file dialog and writes nothing until a path is chosen. Don't save discards the image. Inside a browser panel, Save downloads the PNG into the Downloads folder instead. A clipboard copy that fails, or reports success without a pasteable image, can still be kept this way.

A visit can give each panel a share of the screen. `--size 2,1` makes the first panel twice the second in a row or a column. A grid takes `--columns` and `--rows`, one weight per track. Running that command again resizes the visit already open and leaves what the panels are showing. Dragging a divider changes only the visit.

`herdr-panels panel visit google Notes Agents Files` shows those panels together over the current desk. Two sit side by side. Three or more use a grid. `--arrange row`, `column`, or `grid` chooses the placement. One Back leaves all of them. A missing, repeated, or ambiguous name rejects the visit and names that panel. At most six panels. Repeating the command opens the same check again.

`herdr-panels panel visit <name>` shows a panel from any space over the one you are on. The command replies with that panel and its space. A missing name is an error, not a success. `herdr-panels panel visit` with no name lists the panels on every space. `panel list` still shows only the focused space. A plugin with `panels:control` can call `visitPanel`. The bar names the panel and the space it came from, and Back or Escape leaves the visit. That space's layout is left as it was. Fill screen is unchanged: it still magnifies a panel that already belongs to this space. The desktop window embeds the built page, so this overlay needs `npm run build` in `web/` before the desktop program is rebuilt. A page from before that build ignores the visit.

A plugin `focusPane` call switches the desk to that pane. It opens the pane's workspace, shows the pane in a terminal panel (opening one when that space has none), brings that panel to the front, and still focuses the pane in Herdr. A pane that is not in the session is an error. When control is off, the error says to turn on control in the design bar. That bar notes the switch the first time you select a plugin that declared `herdr:control`, until you turn control on.

`herdr-panels update` stops a running viewer and starts the new program on the same address. An open desktop window is closed and opened again so it loads the new page. The viewer records its process id in `server.json`. The open desk reloads its plugin list, so `herdr-panels plugin install` shows up without restarting the viewer. `herdr-panels plugin uninstall <id>` removes that plugin, and the desk drops it from the menu. A terminal panel has a + on its Herdr tab strip that opens a new tab. The Herdr status dot is blue when an update is available.

The desktop window no longer installs a system-wide keyboard or mouse hook, and it opens without a console. It handles keys and the wheel only for its own windows, so Synergy still receives typing for the other machine. Herdr, git, and other console programs the desk starts stay windowless, so Windows Terminal does not flash open and closed. `cargo run` starts the window and returns, and closing that terminal does not close the window.

Spaces in the side list can be dragged into a new order. Herdr keeps that order. A click still opens the space.

Typing in a terminal returns to the live input. Ctrl, Alt, Shift, and the Windows key stay on the key, including Ctrl+Enter, Ctrl+[, and Alt+., so the program handles them the way it does in Herdr. A shell keeps the highlight on the text you can edit. A program that asked for modified keys, such as Claude, gets Shift+Enter as a new line.

The desktop window stops a herdr-panels viewer from a different build and starts its own. A viewer from the same build stays up, and a second window uses it. If that viewer will not exit, the window does not open.

A terminal panel shows the screen Herdr sends and does not keep its own scrollback. The scrollbar asks Herdr to move the pane and does not keep a second copy of the history. The wheel and Page Up or Page Down ask Herdr to scroll, three lines per notch, the same as Herdr's mouse wheel. Finishing a selection says Copied to clipboard. A click is sent to the program, so Claude's prompt at the top can scroll to that prompt when the program is listening for the mouse. Right-click a Herdr tab and choose Close.

Selecting text in a terminal copies it, the same way Herdr does when you finish a mouse selection. The clipboard gets plain text and a preformatted HTML copy, so spaces and line breaks survive a paste into a page. Shift with the arrow keys, Home, or End extends that highlight. Backspace or Delete removes it when it is on the cursor's line, and typing replaces it. A highlight elsewhere is only copied; it does not delete the command. Ctrl+C still copies, and Ctrl+V or Shift+Insert pastes. Scrolling moves the highlight with the text. Resizing the panel clears it, so it does not stick to the wrong cells. In the address bar, Backspace or Delete removes the highlighted stretch.

A link in a note, an HTML panel, or a plugin opens outside the desk. In the desktop window that is the system browser. In a browser tab it is a new tab of that browser. Only `http` and `https` are opened. `target="_blank"` and `window.open` do this without a plugin permission, because the person clicked a link. `links:open` enables `herdrPanels.openExternal(url)` for a button that chooses the address in script, and install asks before granting it. `examples/plugins/desk-sample` has an Open in browser button that calls it for `https://example.com`. `herdr-panels panel open` with an `http` or `https` address still adds a browser panel. That is a new panel, not a tab.

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
