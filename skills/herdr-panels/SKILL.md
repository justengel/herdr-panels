---
name: herdr-panels
description: >-
  Open a URL, note, HTML page, or plugin on the Herdr Panels desk and
  arrange that layout. Resize, move, rename, and change panels, and
  create or install view plugins. Use when an agent is asked to work
  with herdr-panels, herdr-web-panels, panels, plugins, a chart or page
  on the desk, the desk layout, or the local viewer.
---

# Herdr panels

Prefer `herdr-panels panel` and `herdr-panels plugin`. Those commands attach the viewer token. Use the HTTP API only when a command has no flag for the change. Do not print the token. This skill does not start Herdr and does not speak Herdr's private protocol.

The viewer is usually `http://127.0.0.1:4737`. If it was started elsewhere, use the address in `server.json` in the viewer config directory. Run `herdr-panels panel list` before changing the desk. Address a panel by its unique title or its id. Names are compared without case. If two panels share a name, the call fails with `more than one panel has that name`; rename one first. Panel commands edit the focused space of the current Herdr session's desk, including the pins that space shows.

The person at the desk can focus panels, swap a focused panel with its neighbor, and switch spaces and agents from the keyboard. Keep arranging the desk with the panel commands. Do not send keystrokes to change the layout.

## Arrange the desk

```text
herdr-panels panel list
herdr-panels panel open https://example.com --from Notes --direction right --title Example
herdr-panels panel open notes/welcome.md --from Notes --direction down
herdr-panels panel open panels/charts.html --from Notes --direction right --title Charts
herdr-panels panel open plugin:welcome --from Notes
herdr-panels panel move Charts --to Notes --place below
herdr-panels panel resize Charts 0.4
```

`open` adds a panel. `--from` is the panel to split. When it is omitted, the new panel is beside the last content panel. `--direction right` places it beside that panel. `--direction down` places it below. `--panel Name` replaces that panel instead of adding one. Do not replace a terminal unless the user named that panel.

What `open` creates:

- An `http` or `https` URL becomes a browser panel.
- A `.md` file becomes a note.
- A `.html` file becomes an HTML panel. Use this for a chart or a custom page, such as `panels/charts.html`.
- `plugin:<id>` becomes that installed plugin.
- A directory becomes the file explorer.
- Any other file becomes plain text.

Change a panel that is already open:

```text
herdr-panels panel update Notes --kind markdown --path notes/welcome.md
herdr-panels panel update Board --kind html --path panels/session-board.html
herdr-panels panel update Web --kind iframe --page http://127.0.0.1:8080/
herdr-panels panel update View --kind plugin --plugin welcome
herdr-panels panel update Shell --title Terminal --kind herdr --pane w1:p1
```

`--kind` is `herdr`, `markdown`, `html`, `iframe`, or `plugin`. `--path` is the Markdown or HTML file. `--page` is the browser URL. `--plugin` is the plugin id. `--pane` is the Herdr pane id.

`herdr-panels panel split Notes --direction right --kind html --path panels/charts.html --title Charts` adds a neighbor. `--herdr` is only for a terminal that already has a pane. It also splits that Herdr pane. A failed Herdr split does not save.

`herdr-panels panel close Board` removes a panel. The last panel stays. `herdr-panels panel zoom Charts` fills the page with that panel. `herdr-panels panel zoom` restores the layout. `resize` sets that panel's share of the nearest divider. The server clamps it to 0.12–0.88. `move --place` is `swap`, `right`, or `below`.

Pass `--url http://127.0.0.1:4737` when the viewer is not the one recorded in `server.json`. Herdr pane commands stay on the `herdr` binary. Do not rotate or set the viewer token unless the user asks.

## When the command is not enough

A direct call sends `Authorization: Bearer` and a JSON body built with a JSON library. Read `HERDR_PANELS_TOKEN` when it is set. Otherwise read `auth-token` next to `server.json`. The config directory is `HERDR_PANELS_CONFIG` when that is set. Otherwise it is `%APPDATA%\herdr-panels` on Windows, and `$XDG_CONFIG_HOME/herdr-panels` or `~/.config/herdr-panels` elsewhere. When the new directory is missing and `herdr-web-panels` exists beside it, use the older directory.

```python
import json, os, pathlib, urllib.request

def config_dir():
    override = os.environ.get("HERDR_PANELS_CONFIG", "").strip()
    if override:
        return pathlib.Path(override)
    if os.name == "nt":
        base = pathlib.Path(os.environ["APPDATA"])
    else:
        xdg = os.environ.get("XDG_CONFIG_HOME", "").strip()
        base = pathlib.Path(xdg) if xdg else pathlib.Path.home() / ".config"
    current = base / "herdr-panels"
    earlier = base / "herdr-web-panels"
    if current.exists() or not earlier.exists():
        return current
    return earlier

def viewer_token():
    override = os.environ.get("HERDR_PANELS_TOKEN", "").strip()
    if override:
        return override
    return (config_dir() / "auth-token").read_text(encoding="utf-8").strip()

def call(method, path, body=None, base="http://127.0.0.1:4737"):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        base + path, data=data, method=method,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + viewer_token(),
        },
    )
    with urllib.request.urlopen(req) as res:
        return json.load(res)
```

`GET /api/agent/workspace` returns each panel's `id`, `title`, `type`, and `summary`. `*` is only valid for `say.to` and means every chat.

- `POST /api/agent/open` `{"target","panelId?","from?","direction?":"right"|"down","reuse?":false,"title?"}`. `reuse: true` updates a note, file, HTML, or browser panel already on that side instead of adding another one.
- `POST /api/agent/update` `{"panelId","title?","panel?"}` when the new panel needs a field the command cannot set.
- `POST /api/agent/split` `{"panelId","direction":"right"|"down","title?","panel?","herdr?":true}`
- `POST /api/agent/close` `{"panelId"}`
- `POST /api/agent/resize` `{"panelId","ratio"}`
- `POST /api/agent/move` `{"panelId","target","place":"swap"|"right"|"below"}`
- `POST /api/agent/zoom` `{"panelId":null}` fills the page. `null` restores the layout.

`panel` on split or update is one of:

- `{"type":"herdr","paneId":null}` terminal. Set `paneId` when a pane id is known.
- `{"type":"markdown","path":"notes/welcome.md"}`
- `{"type":"iframe","url":"http://127.0.0.1:8080/","proxy":false}` browser. Set `proxy` to true only for a loopback URL that refuses to be framed. The command always leaves `proxy` false.
- `{"type":"html","path":"panels/session-board.html"}` or `{"type":"html","inline":"<p>Hi</p>"}`. Add `"control": true` only when that panel should type into a Herdr pane. The command cannot set `control`.
- `{"type":"plugin","plugin":"my-plugin"}` the plugin's own panel. Add `"view"` and `"path"` or `"url"` when that view is showing a file or a page. Set `"directory": true` when `path` is a folder. Add `"control": true` only when that plugin declared `herdr:control` and this panel should type into a pane or focus one. The command cannot set `control`.
- `{"type":"explorer","path":""}` file explorer. An empty path lists the open workspace folders. This is not the `files` spaces list or the `agents` list.
- `{"type":"file","path":"src/main.rs"}` plain text. Prefer `open`.
- `{"type":"chat","paneId":null}` an older local transcript. Run an agent in a Herdr pane instead.

## Create a plugin

Copy `examples/plugins/welcome` and change it, or install that sample with `herdr-panels plugin install --example`. A plugin is that directory. Do not add it to the viewer source. The same steps are in `examples/plugins/README.md`. The first run of the viewer does not install this plugin.

```json
{
  "id": "my-plugin",
  "title": "My plugin",
  "entry": "index.html"
}
```

The directory name and `id` must match. `id` is 1 to 64 characters of lowercase letters, digits, and hyphens, and it cannot start or end with a hyphen. `title` is the menu label, 1 to 80 characters. `entry` defaults to `index.html` and must be a file inside the directory. CSS, scripts, and images next to the page are served with it.

A plugin is a view. `views` lists the viewers it adds. Each view has an `id`, a `title`, and `opens`: `file`, `markdown`, `html`, `directory`, or `url`. `file` matches every file, including Markdown and HTML. A view with no `opens` is the plugin's own panel and does not take the current file. Leave `views` out for that panel. One view can omit `id`; it then uses the plugin id. The gear shows a matching view beside the built-in viewers and keeps the address. On load the host posts `{ source: "hwp-host", type: "open", view, address, kind, config }`. `kind` is `file`, `markdown`, `html`, `directory`, or `url`. `config` is the panel's JSON object. The page can save that object with `{ source: "hwp-plugin", type: "config", value }`, up to 32 KB. The page stays sandboxed. It does not get the viewer token.

`permissions` is optional. With no `permissions`, the page does not get `window.herdrPanels` and cannot read files. `herdr:read` enables `listPanes`, `status`, and `readPane`. `herdr:control` enables `sendText`, `sendKeys`, `focusPane`, and `scrollPane`, and only when that panel's layout JSON sets `"control": true`. The panel command cannot set `control`; the layout object can, and so can the design bar. `scrollPane(paneId, "up" or "down", lines)` moves that pane by 1 to 200 lines. The pane has to be open in the viewer. `panels:read` enables `listPanels`. `panels:control` enables `openPanel`, `updatePanel`, `closePanel`, `movePanel`, `resizePanel`, `fillPanel`, `showDesk`, and `setZoom`. `fillPanel` fills the screen with one panel. `showDesk` shows the whole desk again. `setZoom(scale)` sets the desktop window zoom to the nearest browser step, from 0.25 to 5. A browser tab ignores it. Those edit the desk the same way as `herdr-panels panel`, and they cannot set `"control": true` or type into a pane. `files:read` requires a `files` array of absolute paths or directories. The page watches one of those paths with `{ source: "hwp-plugin", type: "watch", path }` and stops with `unwatch`. The host posts `{ source: "hwp-host", type: "file", path, content, mtime }` on load and when the file changes. A path outside `files` is refused. `examples/plugins/checkin-report` is the sample: it reads `/home/engel/projects/checkin/state/report.json` and focuses a pane when a finding's `url` is a pane id.

```text
herdr-panels plugin install --example
herdr-panels plugin install <directory>
herdr-panels plugin install <directory> --yes
herdr-panels plugin uninstall <id>
herdr-panels plugin list
herdr-panels panel open plugin:my-plugin --from Notes
```

Install prints any permissions and file paths and asks before copying. `--yes` skips the question. Pass it when there is no prompt, including for `checkin-report`. `plugin list` shows each plugin's permissions. Pass `--replace` to overwrite an installed plugin. `plugin uninstall <id>` removes that plugin directory. The open desk drops it from the menu. An open panel that was showing it stays until it is closed. The page is sandboxed. It cannot call the viewer API. A plugin can talk to another localhost server that it runs itself. Open the check-in report with `herdr-panels panel open plugin:checkin-report`. `examples/plugins/desk-sample` is the desk-permission sample. It asks for `panels:read` and `panels:control`, opens `https://example.com`, can set the desktop window zoom, and does not show the other panels. Install it with `--yes`. Focusing a pane from it also needs `"control": true` on that panel. The command cannot set that flag. Use `POST /api/agent/update` with the panel object when it has to be set from here.

## Sessions

A session is one running Herdr. `default` is the Herdr client already open on this machine. The page shows one session at a time, so changing it changes the session for every open tab.

- `GET /api/sessions` lists running sessions.
- `PUT /api/sessions` `{"name"}` attaches to a session that is already running.
- `POST /api/sessions` `{"name"}` starts a named session and attaches to it.
- `POST /api/sessions/rename` `{"name","to"}` renames a named session and restarts it. `default` cannot be renamed.
- `POST /api/sessions/close` `{"name"}` stops a named session. `default` cannot be closed from the page.

## Contents

- `GET /api/agent/panels/{name}?selector=h2&text=workspace` reads text and, when the page is open, the live DOM.
- `POST /api/agent/panels/{name}/select` `{"selector":"h2","text":"workspace"}` outlines a match in the open page.
- `POST /api/agent/panels/{name}/write` `{"text":"echo hi","keys":["enter"]}` types into a terminal panel.
- `POST /api/agent/say` `{"to":"Chat","from":"planner","text":"look at the note"}` appends to that chat. `to` may be `*`.

Do not write `exit` into a pane the user is using. That ends the Herdr pane and closes the panel.

`GET /api/agent` lists these routes. A connected browser receives the saved layout over `/ws/agent`.
