# Herdr Panels

A localhost viewer for a running [Herdr](https://herdr.dev) daemon. It shows Herdr panes beside browsers, Markdown, HTML, and installed view plugins. Layouts are JSON files. Drag a panel's grip onto the side of another panel to place it there, or onto the middle to swap. Right-click a title bar to name the panel, change what it shows, add a neighbor, or close it. The result is saved.

This project is private.

## Architecture

```text
browser (React)
    |  REST + WebSocket, 127.0.0.1 only
Axum server
    |  newline-delimited JSON
Herdr API socket
    Windows: \\.\pipe\<config>\herdr.sock
    Unix:    the socket path itself
```

Herdr's stable control plane is the JSON socket API (`herdr api schema`), not the private length-prefixed client protocol. That private protocol can attach a PTY directly, but it is tied to one Herdr build. This app stays on the public API:

- `session.snapshot` lists workspaces, panes, agents, and pane geometry.
- `pane.read` with `format: ansi` returns the visible screen. Herdr 0.8 does not bump `revision` on output, so the server compares the screen text.
- `pane.send_text` and `pane.send_keys` deliver typing. There is no public output subscription, so an open terminal polls about every 150ms and pushes a new screen only when the text changes.
- Agent status comes from the snapshot (`idle`, `working`, `blocked`, `done`, `unknown`).

Dragging a divider writes the layout file. Splitting a terminal can also call `pane.split`, which opens a real Herdr pane and binds the new panel to it. Other panel types stay in this page. A shell panel keeps a fixed glyph size, pins the grid to the top, and tells Herdr the column and row count that fit the panel.

### Directory layout

```text
src/                 Rust server: socket client, layouts, content, proxy, websockets
assets/              HTML bridge injected into custom panels
examples/            Seed layouts, a note, an iframe page, an HTML panel, and a view plugin
web/                 React workspace
web/src/components   Layout engine, design mode, and the panel types
```

### Panel types

| type | What it shows |
| --- | --- |
| `herdr` | xterm.js mirror of a pane. `paneId` is optional; the header can bind one. |
| `iframe` | A browser frame. `proxy: true` reverse-proxies a loopback `http(s)` origin so it can be framed. |
| `markdown` | A local `.md` file, sanitized in the browser and refreshed when the file changes. |
| `html` | A local HTML file or an inline snippet. A bridge script exposes `window.herdrPanels`. |
| `plugin` | An installed view. The id names a directory under `<config>/plugins` that contains `plugin.json` and its own HTML. |
| `files` | The spaces list: open Herdr workspaces, with a status dot. |
| `agents` | Agents in the session, grouped under the spaces list. |
| `chat` | An older local transcript. It still loads. A Herdr pane is the place to run an agent. |

### Panels

Every panel title bar shows that panel's name, and the close button sits at the far right.

- Drag the grip onto another panel. The panel follows the pointer, and a preview opens on the left, right, top, or bottom to show where it will land. The middle of the panel swaps the two.
- Right-click the title bar to name the panel. That name is how an agent addresses it.
- The same menu changes the view (terminal, browser, Markdown, HTML, or plugin) and edits the pane, file, URL, or plugin id for the current view.
- Add a panel to the right or below. **Add panel** in the top bar splits a new terminal to the right of the selected one. Those new panels stay local until Design mode is asked to split the Herdr pane too.
- × closes the panel. The last panel stays.
- Typing `exit` in a shell closes that panel after Herdr drops the pane. A panel pointed at a pane that was already gone stays open so you can pick another pane.
- Resizing a shell panel changes its columns and rows. The glyphs stay the same size and the text stays at the top. Keystrokes follow Herdr's live screen, including the cursor.

### Design mode

The Design button turns the workspace into an editor:

- Click a panel to select it. In a Markdown note or a custom HTML panel, click a heading, paragraph, or other element to select that component.
- Change the selection into a terminal, browser, Markdown file, HTML view, or plugin, and edit its path, URL, pane, or plugin id.
- Split right or split down, then drag the new divider. Close removes that panel and keeps the other side. The last panel stays.
- Add the selection to a chat when a chat panel is already open.
- When the selected panel is a Herdr terminal, **Split the Herdr pane too** opens a new pane in the daemon and attaches it to the new panel.

`examples/layouts/desk.json` starts with a terminal, a note, and an HTML panel. A plugin is a directory the viewer can show as its own panel. The guide is `examples/plugins/README.md`, and the same file is copied to `<config>/plugins/README.md`. A plugin is a directory:

```text
<config>/plugins/<id>/plugin.json
<config>/plugins/<id>/index.html
```

`plugin.json` has `id`, `title`, and `entry` (default `index.html`). Install one with `herdr-web-panels plugin install <directory>`. The page loads it at `/plugins/<id>`.

### Agents

Anything on this machine can drive the open workspace over HTTP. The page does not have to perform the edit: a split, close, resize, or panel change is saved and pushed to a connected browser. Reads work with the page closed. A connected page adds the live DOM, computed CSS, and the current terminal screen.

```text
GET  /api/agent
GET  /api/agent/workspace
POST /api/agent/split     {"panelId","direction":"right"|"down","title?","panel?","herdr?":true}
POST /api/agent/close     {"panelId"}
POST /api/agent/resize    {"panelId","ratio"}
POST /api/agent/update    {"panelId","title?","panel?"}
POST /api/agent/move      {"panelId","target","place":"swap"|"right"|"below"}
POST /api/agent/zoom      {"panelId":null}
GET  /api/agent/panels/{id}?selector=h2&text=workspace
POST /api/agent/panels/{id}/write   {"text":"echo hi","keys":["enter"]}
POST /api/agent/panels/{id}/select  {"selector":"h2","text":"workspace"}
POST /api/agent/say       {"to":"chat"|"*","from":"planner","text":"look at the note"}
```

`panelId`, `{id}`, and `say.to` accept a panel id or its unique name, compared without case. `*` still means every chat. A project skill for this API lives at `.cursor/skills/herdr-panels/SKILL.md`.

`ratio` is that panel's share of the nearest divider, from 0.12 to 0.88. `herdr: true` also calls Herdr `pane.split` and binds the new terminal. `move` swaps two panels or places one to the right of or below the other. `say` appends to a chat panel; `to` is a panel id, a unique panel name, or `*` for every chat. A chat linked to a pane also types the message into that pane. `write` types into a terminal panel. `select` outlines the match in the open page. Browser HTML that is loopback or served from `/content` can be fetched directly; a same-origin frame, or a custom HTML panel, also returns the live elements and computed style. The proxy still refuses anything that is not loopback.

### Layout JSON

A layout is either a `split` (`direction` is `row` or `column`, `ratio` is the first child's share), a `grid` of weighted tracks and cells, or a `panel`. Files live in `<config>/layouts/<id>.json`. The id and the filename must match. `settings.json` stores `activeLayout` and optional `contentRoots` (extra directories Markdown and HTML panels may read).

Relative content paths resolve under the config directory first, then each content root. `..` is rejected.

### Custom HTML bridge

Sandboxed panels cannot call the API directly. The injected script provides:

```js
await herdrPanels.listPanes()
await herdrPanels.status()
await herdrPanels.sendText("w1:p1", "echo hi")
await herdrPanels.sendKeys("w1:p1", ["enter"])
await herdrPanels.readPane("w1:p1")
```

`examples/panels/session-board.html` is a working panel.

### Security

The server refuses any non-loopback bind. Browser requests that carry a non-local `Origin` are rejected. The iframe proxy accepts only `localhost`, `127.0.0.1`, and `::1`. HTML panels are local files you chose to load; treat them as trusted.

## Setup

Requirements: Rust, Node.js, and a running Herdr (`herdr`, or `herdr server` for a headless session).

```sh
cargo run -- server
```

In another terminal, for UI development:

```sh
cd web
npm install
npm run dev
```

Open http://127.0.0.1:5173. The Vite server proxies API and websocket traffic to port 4737.

To serve the built UI from the Rust process:

```sh
cd web
npm install
npm run build
cd ..
cargo run -- server --open
```

Open http://127.0.0.1:4737. `cargo run -- --open` still starts the server, so older commands keep working.

The server is the long-running viewer. Layout changes are short commands against that process:

```sh
herdr-web-panels panel list
herdr-web-panels panel split Notes --direction right --kind html
herdr-web-panels panel close Board
herdr-web-panels panel resize Notes 0.4
herdr-web-panels panel move Notes --to Herdr --place below
herdr-web-panels panel update Chat --title Shell --kind herdr
herdr-web-panels panel zoom Notes
herdr-web-panels plugin list
herdr-web-panels plugin install <directory>
```

`panel` names a viewer panel. A Herdr pane stays a Herdr pane: use `herdr pane` for the daemon, and point a terminal panel at it.

### Server flags

```text
herdr-web-panels server
--config <dir>           Use this directory instead of the default config dir
--herdr-session <name>   Attach to a named Herdr session
--herdr-socket <path>    Attach to a specific API socket
--host 127.0.0.1         Loopback address (the default)
--port 4737              HTTP port
--open                   Open a browser tab
```

Default config directory:

- Windows: `%APPDATA%\herdr-web-panels`
- macOS and Linux: `$XDG_CONFIG_HOME/herdr-web-panels` or `~/.config/herdr-web-panels`

The first launch copies `examples/` into that directory when it has no layouts. Herdr's own socket is discovered from `HERDR_SOCKET_PATH`, then `HERDR_SESSION` / `--herdr-session`, then the default session socket printed by `herdr status`.

The example side-by-side layout targets pane `w1:p1`. If that pane is not in the session, right-click the terminal's title bar and choose another pane. The choice is saved into the layout file.

### Named session

```sh
herdr --session demo server
herdr --session demo workspace create --label demo
cargo run -- server --herdr-session demo
```

## Development checks

```sh
cargo test
cd web
npm run build
```

`cargo test` covers layout parsing, path confinement, key mapping, the loopback proxy, and snapshot geometry. It does not need a running Herdr. A live Herdr is required to exercise a terminal pane.
