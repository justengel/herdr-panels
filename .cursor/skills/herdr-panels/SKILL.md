---
name: herdr-panels
description: >-
  Create, resize, move, rename, and change the contents of Herdr web panels
  over the local agent API. Use when the user or an agent mentions
  herdr-web-panels, panels, the desk layout, or http://127.0.0.1:4737.
---

# Herdr web panels

The panels app is a localhost page at `http://127.0.0.1:4737`. It attaches to a running Herdr daemon. This skill drives the open workspace. It does not start Herdr and it does not speak Herdr's private protocol.

Address a panel by its unique name (the title) or by its id. Names are compared without case. If two panels share a name, the call fails with `more than one panel has that name`; rename one first. `*` is only valid for `say.to` and means every chat.

Call the API with Python `json.dumps` and `urllib`. PowerShell `ConvertTo-Json` strips quotes.

```python
import json, urllib.request
def call(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        "http://127.0.0.1:4737" + path, data=data, method=method,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as res:
        return json.load(res)
```

Read the workspace before changing it: `GET /api/agent/workspace`. Each panel has `id`, `title`, `type`, and `summary`.

## Layout

- `POST /api/agent/split` `{"panelId","direction":"right"|"down","title?","panel?","herdr?":true}` creates a neighbor. `herdr: true` also calls Herdr `pane.split` and is only valid on a terminal that already has a pane. A failed Herdr split does not save.
- `POST /api/agent/close` `{"panelId"}` removes a panel. The last panel stays open.
- `POST /api/agent/resize` `{"panelId","ratio"}` sets that panel's share of the nearest divider. The server clamps `ratio` to 0.12–0.88.
- `POST /api/agent/move` `{"panelId","target","place":"swap"|"right"|"below"}`. `swap` is the default. `right` and `below` place `panelId` on that side of `target`. A panel cannot move beside itself.
- `POST /api/agent/open` `{"target","panelId?","from?","direction?":"right"|"down","reuse?":false,"title?"}` opens a file, a directory, or an `http`/`https` URL. `target` is a content path, an absolute path inside an open workspace, or a URL. A Markdown file opens as a note with the path in its address bar. An HTML file opens in the browser panel. Any other file is plain text, a directory is the file explorer, and a URL is a browser panel. Pass `panelId` (name or id) to replace that panel. Omit it to add a panel beside `from`, or beside the last content panel when `from` is omitted. `direction: "right"` is a horizontal split and `"down"` is a vertical split. `reuse: true` updates a note, file, HTML, or browser panel already on that side instead of adding another one. Do not replace a terminal unless the user named that panel.
- `POST /api/agent/zoom` `{"panelId":null}` fills the page with one panel. `null` restores the layout.
- `POST /api/agent/update` `{"panelId","title?","panel?"}` renames a panel, replaces what it shows, or both. Keep names unique.

## What a panel can show

`panel` on split or update is one of:

- `{"type":"herdr","paneId":"w1:p1"}` terminal. The panel mirrors the focused Herdr space: its tabs and the panes inside the focused tab. `paneId` remembers a pane; the page follows the space the viewer is attached to.
- `{"type":"markdown","path":"notes/welcome.md"}` local Markdown. The address bar shows the file.
- `{"type":"iframe","url":"http://127.0.0.1:8080/","proxy":false}` browser address. The proxy accepts only loopback URLs. The same address bar can point at a URL or an HTML file.
- `{"type":"html","path":"panels/session-board.html"}` or `{"type":"html","inline":"<p>Hi</p>"}` a local HTML file shown in the browser panel.
- `{"type":"plugin","plugin":"my-plugin"}` an installed view. Each plugin is a directory in `<config>/plugins/<id>` with `plugin.json` (`id`, `title`, and optional `entry`). `herdr-web-panels plugin install <directory>` copies one in. The guide is `<config>/plugins/README.md`. Installed plugins are listed in the panel menu under their own divider.
- `{"type":"explorer","path":"C:\\Users\\me\\projects"}` a file explorer. An empty path lists the open workspace folders. Clicking a file calls `open`.
- `{"type":"file","path":"src/main.rs"}` plain text. Prefer `open` instead of building this by hand.
- `{"type":"chat","paneId":null}` an older local transcript. Run an agent in a Herdr pane instead.

The same panel can change type. Updating a note panel with a `herdr` panel turns it into a shell and keeps its name.

## Commands

`herdr-web-panels server` is the viewer. These talk to the viewer it recorded in `<config>/server.json`:

- `herdr-web-panels panel list`
- `herdr-web-panels panel split <from> --direction right|down [--kind herdr|markdown|html|iframe|plugin]`
- `herdr-web-panels panel close <panel>`
- `herdr-web-panels panel resize <panel> <ratio>`
- `herdr-web-panels panel move <panel> --to <panel> [--place swap|right|below]`
- `herdr-web-panels panel update <panel> [--title <name>] [--kind herdr|markdown|html|iframe|plugin]`
- `herdr-web-panels panel zoom [panel]`
- `herdr-web-panels panel open <file-or-url> [--panel <name>] [--from <name>] [--direction right|down] [--title <name>]`
- `herdr-web-panels plugin list`
- `herdr-web-panels plugin install <directory>`

Pass `--url http://127.0.0.1:4737` when the viewer is not on the recorded address. Herdr pane commands stay on the `herdr` binary.

## Sessions

A session is one running Herdr. `default` is the Herdr client already open on this machine. A named session is a separate Herdr, with its own spaces, tabs, and panes. The page shows one session at a time.

- `GET /api/sessions` lists running sessions.
- `PUT /api/sessions` `{"name"}` attaches the page to a session that is already running.
- `POST /api/sessions` `{"name"}` starts a named session and attaches to it.
- `POST /api/sessions/rename` `{"name","to"}` renames a named session. That restarts it. `default` cannot be renamed.
- `POST /api/sessions/close` `{"name"}` stops a named session. `default` cannot be closed from the page, because that is the open Herdr client. If the page was attached to the session it closed, it returns to `default`.

## Contents

- `GET /api/agent/panels/{name}?selector=h2&text=workspace` reads text, blocks, and, when the page is open, the live DOM.
- `POST /api/agent/panels/{name}/select` `{"selector":"h2","text":"workspace"}` outlines a match in the open page.
- `POST /api/agent/panels/{name}/write` `{"text":"echo hi","keys":["enter"]}` types into a terminal panel.
- `POST /api/agent/say` `{"to":"Chat","from":"planner","text":"look at the note"}` appends to that chat. `to` may be `*`.

Do not write `exit` into a pane the user is using. That ends the Herdr pane and closes the panel.

`GET /api/agent` lists these routes. A connected browser receives the saved layout over `/ws/agent`; you do not have to edit the page yourself.
