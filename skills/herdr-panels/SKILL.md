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

The viewer is usually `http://127.0.0.1:4737`. If it was started elsewhere, use the address in `server.json` in the viewer config directory. Run `herdr-panels panel list` before changing the desk. Address a panel by its id, or by `name`, `display`, or `kind` when that word matches one panel. Comparison ignores case. If two panels share that word, the call fails with `more than one panel has that name`; use the id. A panel has no saved name until someone types one. The title bar then shows the file, folder, or site, and otherwise the panel type. `name` in the list is empty for that panel. `display` is the title bar. `kind` is the type on the right of the title bar. `title` is only the stored string. An older layout may still have an automatic `title` such as Panes, Terminal, Files, Spaces, or Agents. Those words are not a person's name, and typing one of them does not stick: the bar keeps following the panel. Prefer `id` when `name` is empty or `display` is shared. Do not decide which panel is which from `title`. Panel commands edit the focused space of the current Herdr session's desk, including the pins that space shows. Pass `--space <herdr workspace id>` on `list`, `open`, `split`, `update`, `close`, `resize`, `move`, and `zoom` to edit that space and leave the focused space as it is. `visit` still searches every space.

The person at the desk can focus panels, swap a focused panel with its neighbor, and switch spaces and agents from the keyboard. Keep arranging the desk with the panel commands. Do not send keystrokes to change the layout.

## Panes and Terminal

A space has two different herdr panels. Read `role` from `herdr-panels panel list`. Do not decide from `title` or `name`. An older Panes panel may still have `title` Terminal or Panes. `name` is empty for that, and `display` and `kind` are Panes.

`role` is `panes` when `scope` is omitted or `"space"`. This panel is the space mirror. It shows every Herdr tab in the space, and the splits inside the selected tab. It is the same layout as the Herdr client. One is enough. A second Panes panel shows the same tabs. The seed layout for a new space is Spaces, Agents, and one Panes panel. None of those has a saved name. The window shows Spaces, Agents, and Panes.

`role` is `terminal` when `"scope":"pane"`. This panel shows one shell and has no tab strip. The shell is still a Herdr tab, so Panes lists it. Several Terminal panels can be open at once. A desk can be only Terminal panels, with no Panes panel. Each one keeps showing its own shell. Nothing puts Panes back until someone asks for it, or a pane that is not already on a panel is focused. `focusPane` does that: it shows the pane in the Panes panel and opens Panes when the space has none. A Terminal panel is left where it is.

Closing Panes does not close the shells or the tabs. Bring it back with Add panel, then Panes. That menu item sets the panel to `{"type":"herdr","paneId":null}` and leaves the name blank, so the window shows Panes. On a Terminal panel the same item replaces that panel with Panes. The shell that was there stays as a tab. To keep the shell, add a new panel first.

The gear menu lists **Panes**, then **Terminals**. The explanation is the tooltip, not a line in the menu. Panes: "Herdr panes that contain the terminals." Terminals: "Show a single terminal from the Herdr panes." New terminal…: "Open a new tab in Panes and display that terminal here." The same two items appear on every panel, including a file or folder. Every panel shows its type on the right of the title bar, before settings. A plugin's type is the plugin name. Panes and Terminal read Panes and Terminal.

- **Panes** makes this panel the space mirror. It is not a flyout. The panel already shows every tab and split. On a Terminal panel, this replaces that panel with Panes. The terminal that was there stays as a tab. To keep the terminal, add a new panel first.
- **Terminals** is the flyout, including on Add panel. It lists the terminals in this space. Choosing one shows that terminal in this panel. **New terminal…** is the last item and opens another terminal in this panel. The terminal that was here stays as a tab. On a Terminal panel, Terminals is checked, and so is the shell that panel is showing.

A right-click on a file or folder in the Files panel is separate from that gear menu. It can open that folder in a new Terminal panel beside Files, in an external terminal, or in the system file browser. A file uses its parent folder. The Files panel stays as it is.

Set these up with the panel JSON. `herdr-panels panel update` and `panel split` accept it through the HTTP body when the command has no flag for `scope`. `--kind herdr` always saves a Panes panel (`scope` omitted). Do not use `--kind herdr` on a Terminal panel you mean to keep as one shell. That clears `scope` and turns it into Panes.

```json
{ "type": "herdr", "paneId": null }
{ "type": "herdr", "paneId": "w1:p1", "scope": "space" }
{ "type": "herdr", "paneId": "w1:p9", "scope": "pane" }
```

The first two are Panes. The third is a Terminal and needs a pane that already exists. `tab.create` answers `{"ok":true,"result":...}`. The new pane id is the one that appears in `GET /api/runtime` `panes` and was not there before. Match `workspaceId`. `focus: false` leaves the space's selected tab alone, so Panes does not jump to the new shell.

```python
before = {pane["paneId"] for pane in call("GET", "/api/runtime")["panes"]}
call("POST", "/api/herdr/action", {"action": "tab.create", "workspaceId": "w1", "focus": False})
created = next(
    pane["paneId"]
    for pane in call("GET", "/api/runtime")["panes"]
    if pane["paneId"] not in before and pane.get("workspaceId") == "w1"
)
call("POST", "/api/agent/split", {
    "panelId": "Notes",
    "direction": "right",
    "panel": {"type": "herdr", "paneId": created, "scope": "pane"},
})
```

Leave `title` out. The new panel has no saved name, so the window shows Terminal. Pass `title` only when someone asked for a name.

`panel split --herdr` is different. It splits the current Herdr tab, and the new desk panel is a Terminal for that new piece. That panel has no saved name, so the window shows Terminal. Panes shows the split. A Terminal panel does not.

`herdr-panels panel list` prints `id`, `name`, `display`, `kind`, `type`, `summary`, `role`. `summary` is the pane id, or `unbound` when Panes is not bound yet. `role` is empty for a panel that is not herdr. `herdr-panels panel visit` with no name prints the same panel fields for every space, after a current-space mark, the space id, and the space label. Use `id` when `name` is empty. `display` may be a file name while `kind` is still Files, Markdown, or Browser.

A path that starts with `/` is a file, including on Windows. Open it as text or markdown. If that file is not on this machine, the panel still opens as text and says the file is missing. Do not open that path as a browser.

## Arrange the desk

```text
herdr-panels panel list
herdr-panels panel open https://example.com --from Notes --direction right --title Example
herdr-panels panel open notes/welcome.md --from Notes --direction down
herdr-panels panel open panels/charts.html --from Notes --direction right --title Charts
herdr-panels panel open plugin:welcome --from Notes
herdr-panels panel move Charts --to Notes --place below
herdr-panels panel resize Charts 0.4
herdr-panels panel visit
herdr-panels panel visit Notes
herdr-panels panel visit google Notes Agents Files
herdr-panels panel visit google Notes --arrange column
herdr-panels panel visit google Notes --size 2,1
herdr-panels panel visit google Notes Agents Files --columns 2,1 --rows 1,2
```

`open` adds a panel. `--from` is the panel to split. When it is omitted, the new panel is beside the last content panel. `--direction right` places it beside that panel. `--direction down` places it below. `--panel Name` replaces that panel instead of adding one. Do not replace Panes or a Terminal panel unless the user named that panel. See Panes and Terminal above.

What `open` creates:

A relative file is the caller's current directory. The command sends that absolute path. A relative path typed in the page is still resolved from the viewer's content roots.

- An `http` or `https` URL becomes a browser panel.
- A `.md` file becomes a note.
- A `.html` file becomes an HTML panel. Use this for a chart or a custom page, such as `panels/charts.html`.
- `plugin:<id>` becomes that installed plugin.
- A directory becomes the file explorer.
- Any other file becomes plain text.
- A path that starts with `/` is a file, including on Windows. If that file is not on this machine, the panel still opens as text and says the file is missing. Do not open that path as a browser.

A click on a link does not add a panel. In the desktop window an `http` or `https` link opens in the system browser. In a browser tab it opens a new tab. `target="_blank"` is that click. There is no `target` that adds a panel, and the new browser panel is not a tab. `panel open` is how to put the page on the desk.

Change a panel that is already open:

```text
herdr-panels panel update Notes --kind markdown --path notes/welcome.md
herdr-panels panel update Board --kind html --path panels/session-board.html
herdr-panels panel update Web --kind iframe --page http://127.0.0.1:8080/
herdr-panels panel update View --kind plugin --plugin welcome
herdr-panels panel update Panes --title Panes --kind herdr --pane w1:p1
```

`--kind` is `herdr`, `markdown`, `html`, `iframe`, or `plugin`. `--path` is the Markdown or HTML file. `--page` is the browser URL. `--plugin` is the plugin id. `--pane` is the Herdr pane id. `--kind herdr` saves a Panes panel. A Terminal panel needs `"scope":"pane"` in the panel JSON. See Panes and Terminal above.

`herdr-panels panel split Notes --direction right --kind html --path panels/charts.html --title Charts` adds a neighbor. `--herdr` is only for a Panes or Terminal panel that already has a pane. It splits that Herdr tab and the new desk panel is a Terminal for the new piece. A failed Herdr split does not save.

`herdr-panels panel close Board` removes a panel. The last panel stays. `herdr-panels panel zoom Charts` fills the page with that panel. `herdr-panels panel zoom` restores the layout. `herdr-panels panel visit Notes` shows a panel from any space over the current one. Several names, such as `herdr-panels panel visit google Notes Agents Files`, show those panels together. Two sit side by side. Three or more use a grid. `--arrange row`, `column`, or `grid` chooses the placement. `--size 2,1` gives each panel a share of a row or a column, and the first panel here is twice the second. A grid uses `--columns` and `--rows`, one weight per track. Run the same command again with new weights to resize the visit that is already open; the panels stay as they are. Dragging a divider changes only this visit. At most six panels. One Back leaves the whole visit, and so does Escape when the desk has the keyboard. A browser panel's own page keeps Escape. The other spaces stay as they were. Repeating that command is how to open the same check again. `herdr-panels panel visit` with no name lists panels on every space. `panel list` still shows only the focused space. A missing, repeated, or ambiguous name is an error from the command and nothing opens. The reply names each panel and its space. The overlay appears in a connected viewer whose page includes this visit. A page built before it ignores the message even when the call names the panels. `resize` sets that panel's share of the nearest divider. The server clamps it to 0.12–0.88. `move --place` is `swap`, `right`, or `below`.

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

`GET /api/agent/workspace` returns each panel's `id`, `title`, `name`, `display`, `kind`, `type`, and `summary`, plus `role` for a herdr panel. `listPanels` returns the same fields. `name` is empty until someone names the panel. `display` is the title bar. `kind` is the type chip. `title` is the stored string and may be an old automatic label; do not treat it as the name. Add `?space=` to read one workspace. `*` is only valid for `say.to` and means every chat. The panel routes below take an optional `space` set to a Herdr workspace id. Omit it to edit the focused space.

- `POST /api/agent/open` `{"target","panelId?","from?","direction?":"right"|"down","reuse?":false,"title?"}`. `reuse: true` updates a note, file, HTML, or browser panel already on that side instead of adding another one.
- `POST /api/agent/update` `{"panelId","title?","panel?"}` when the new panel needs a field the command cannot set.
- `POST /api/agent/split` `{"panelId","direction":"right"|"down","title?","panel?","herdr?":true}`
- `POST /api/agent/close` `{"panelId"}`
- `POST /api/agent/resize` `{"panelId","ratio"}`
- `POST /api/agent/move` `{"panelId","target","place":"swap"|"right"|"below"}`
- `POST /api/agent/zoom` `{"panelId":null}` fills the page. `null` restores the layout.
- `POST /api/agent/visit` `{"panelId"}` shows that panel from any space over the current one. `{"panelIds":["google","Notes"],"arrange?":"row"|"column"|"grid","sizes?":[2,1],"columns?":[2,1],"rows?":[1,2]}` shows several in one visit. `sizes` is one weight per panel for a row or a column. `columns` and `rows` are one weight per track for a grid. The reply has `arrange` and `panels`, each with `panelId`, `title`, `spaceId`, and `space`. A single panel also returns those fields at the top. A missing panel is an error. `GET /api/agent/spaces` lists every saved space. `GET /api/agent/workspace` is still only the focused space.

`panel` on split or update is one of:

- `{"type":"herdr","paneId":null}` Panes, the space's tabs and splits. `"scope":"pane"` with a pane id is one Terminal panel. See Panes and Terminal above.
- `{"type":"markdown","path":"notes/welcome.md"}`
- `{"type":"iframe","url":"http://127.0.0.1:8080/","proxy":false}` browser. Set `proxy` to true only for a loopback URL that refuses to be framed. The command always leaves `proxy` false.
- `{"type":"html","path":"panels/session-board.html"}` or `{"type":"html","inline":"<p>Hi</p>"}`. Add `"control": true` only when that panel should type into a Herdr pane.
- `{"type":"plugin","plugin":"my-plugin"}` the plugin's own panel. Add `"view"` and `"path"` or `"url"` when that view is showing a file or a page. Set `"directory": true` when `path` is a folder. Add `"control": true` when that plugin declared `herdr:control` and this panel should type into a pane or focus one. `herdr-panels panel open plugin:my-plugin --control` sets it, and so do `panel update` and `panel split`. A manifest `"control": "default"` opens that plugin with control on. The install prompt still lists `herdr:control`.
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

`permissions` is optional. With no `permissions`, the page does not get `window.herdrPanels` and cannot read files. `herdr:read` enables `listPanes`, `status`, and `readPane`. `herdr:control` enables `sendText`, `sendKeys`, `focusPane`, and `scrollPane`, and only when that panel's layout JSON sets `"control": true`. `focusPane(paneId)` switches the desk to that pane's workspace, shows the pane in the Panes panel (opening Panes when the space has none), brings that panel to the front, and focuses the pane in Herdr. A Terminal panel is left as it is. A missing pane is an error. When control is off, the error says to turn on control in the design bar. `panel open`, `panel update`, and `panel split` set that flag with `--control` on a plugin panel. A manifest `"control": "default"` opens the plugin with the flag on. The layout object and the design bar can still change it. `scrollPane(paneId, "up" or "down", lines)` moves that pane by 1 to 200 lines. The pane has to be open in the viewer. `panels:read` enables `listPanels`. `panels:control` enables `openPanel`, `updatePanel`, `closePanel`, `movePanel`, `resizePanel`, `fillPanel`, `showDesk`, `visitPanel`, and `setZoom`. `fillPanel` fills the screen with one panel that is already on this space. `visitPanel(panelId)` shows a panel from any space over this one and does not change that space. `visitPanels(panelIds, arrange, { sizes, columns, rows })` shows several panels in one visit. `sizes` is one weight per panel. `columns` and `rows` weight a grid. `showDesk` shows the whole desk again. `setZoom(scale)` sets this panel's zoom. Steps are 10% from 50% to 200%, and 25% from 25% to 300%. A browser tab ignores it. Those edit the desk the same way as `herdr-panels panel`, and they cannot set `"control": true` or type into a pane. `files:read` requires a `files` array of absolute paths or directories. The page watches one of those paths with `{ source: "hwp-plugin", type: "watch", path }` and stops with `unwatch`. The host posts `{ source: "hwp-host", type: "file", path, content, mtime }` on load and when the file changes. A path outside `files` is refused. `commands:run` requires a `commands` array of program names. `run(name, args, cwd)` runs that program from PATH with no shell. `cwd` has to be an open project directory; omit it and the focused pane's directory is used. `links:open` enables `openExternal(url)` for an `http` or `https` address. A clicked link, including `target="_blank"`, does not need it. In the desktop window that address opens in the system browser. In a browser tab it opens a new tab. Other schemes are refused. `panel open` with an `http` or `https` address still adds a browser panel. That is a new panel, not a tab, and no HTML `target` selects one. `examples/plugins/checkin-report` is the sample: it reads `/home/engel/projects/checkin/state/report.json` and focuses a pane when a finding's `url` is a pane id.

```text
herdr-panels plugin install --example
herdr-panels plugin install <directory>
herdr-panels plugin install <directory> --yes
herdr-panels plugin uninstall <id>
herdr-panels plugin list
herdr-panels panel open plugin:my-plugin --from Notes
```

Install prints any permissions and file paths and asks before copying. `--yes` skips the question. Pass it when there is no prompt, including for `checkin-report`. `plugin list` shows each plugin's permissions. Pass `--replace` to overwrite an installed plugin. `plugin uninstall <id>` removes that plugin directory. The open desk drops it from the menu. An open panel that was showing it stays until it is closed. The page is sandboxed. It cannot call the viewer API. A plugin can talk to another localhost server that it runs itself. Open the check-in report with `herdr-panels panel open plugin:checkin-report`. `examples/plugins/desk-sample` is the desk-permission sample. It asks for `panels:read`, `panels:control`, and `links:open`. Open example adds `https://example.com` as a browser panel. Open in browser calls `openExternal` for that address. It can set this panel's zoom, and it does not show the other panels. Install it with `--yes`. Focusing a pane from it also needs `"control": true` on that panel. The command cannot set that flag. Use `POST /api/agent/update` with the panel object when it has to be set from here.

## Updates

An update does not rewrite installed plugins. A plugin keeps working. `listPanels` may include extra fields; a page that only reads the fields it already knows keeps working.

Saved desks and layouts are rewritten in place the first time this version starts. The number is `schema` in `settings.json`. This version clears panel and pin names that were automatic labels, such as Panes, Terminal, Files, Spaces, and Agents. A name someone typed is left as it is, including a tab's own label. The window then shows the file, folder, site, or type.

The next change that has to rewrite those files adds a step in `src/migrate.rs` and raises `SCHEMA`. A migration does not edit plugin directories.

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
- `POST /api/agent/panels/{name}/write` `{"text":"echo hi","keys":["enter"]}` types into a Panes or Terminal panel.
- `POST /api/agent/say` `{"to":"Chat","from":"planner","text":"look at the note"}` appends to that chat. `to` may be `*`.

Do not write `exit` into a pane the user is using. That ends the Herdr pane and closes the panel.

`GET /api/agent` lists these routes. A connected browser receives the saved layout over `/ws/agent`.
