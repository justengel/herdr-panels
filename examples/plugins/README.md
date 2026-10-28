# Plugins

A plugin is a directory the viewer can show as a panel. This file is the guide. It is not a plugin, and it does not appear in the panel menu.

A plugin implements a view. The gear lists that view when the open address is one the plugin can show, and it keeps the address. A plugin that does not name an address is its own panel, listed under Plugins. Welcome is that kind of plugin.

## Where they live

The viewer reads plugins from its config directory:

- Windows: `%APPDATA%\herdr-panels\plugins`
- macOS and Linux: `$XDG_CONFIG_HOME/herdr-panels/plugins` or `~/.config/herdr-panels/plugins`

Each plugin is one subdirectory. The directory name and the `id` in `plugin.json` must match.

```text
plugins/
  README.md
  my-plugin/
    plugin.json
    index.html
```

## Make a plugin

Create a directory with `plugin.json` and the page it should show.

```json
{
  "id": "my-plugin",
  "title": "My plugin",
  "entry": "index.html",
  "description": "Optional. Not shown in the menu."
}
```

- `id` uses lowercase letters, digits, and hyphens. It is 1 to 64 characters and cannot start or end with a hyphen.
- `title` is the menu label. It is 1 to 80 characters.
- `entry` is a file inside the plugin directory. It defaults to `index.html`. `..` is rejected.

`index.html` is a normal page. CSS, scripts, and images next to it are served with it. The viewer loads the entry at `/plugins/<id>`.

## Views

`views` tells the gear where this plugin belongs. Leave it out, and the plugin is its own panel. The gear lists it under Plugins, and choosing it leaves the file that was open. Welcome works that way.

```json
"views": [
  { "id": "edit", "title": "Vim", "opens": ["file"] }
]
```

`opens` is the addresses that view can show:

- `file` is any file, including Markdown and HTML. A Vim-style plugin uses this.
- `markdown` is a `.md` or `.markdown` file.
- `html` is a local `.html` or `.htm` file.
- `directory` is a folder. From a file, the host opens the folder that contains it.
- `url` is an `http` or `https` address.

A view can list more than one. A view with no `opens` is the plugin's own panel, even when the plugin also has a file view. One view can omit `id` and `title`; the id is then the plugin id and the title is the plugin title. Several views each need an id. Ids use the same characters as the plugin id.

```json
"views": [
  { "id": "read", "title": "Reader", "opens": ["markdown"] },
  { "id": "home", "title": "Library" }
]
```

Reader appears under View while a Markdown file is open. Library stays under Plugins. Choosing Reader keeps the file. Choosing Library does not.

The host posts this when the frame loads, and again when the address or the view changes:

```js
{
  source: "hwp-host",
  type: "open",
  view: "edit",
  address: "notes/welcome.md",
  kind: "markdown",
  config: {}
}
```

`kind` is `file`, `markdown`, `html`, `directory`, or `url`. For a panel view, `address` and `kind` are empty. `config` is the JSON object stored on that panel. The page can replace it:

```js
parent.postMessage({ source: "hwp-plugin", type: "config", value: { line: 4 } }, "*");
```

`value` has to be an object, and the JSON has to be 32 KB or smaller. An array is ignored. The page does not get the viewer token. It gets `herdrPanels` only when `permissions` includes `herdr:read`, `herdr:control`, `panels:read`, `panels:control`, or `links:open`.

Install the Welcome sample, or copy another directory into the config folder:

```text
herdr-panels plugin install --example
herdr-panels plugin install <directory>
herdr-panels plugin uninstall <id>
```

Pass `--replace` to overwrite a plugin that is already installed. `herdr-panels plugin uninstall <id>` removes that plugin. The open desk drops it from the menu. `herdr-panels plugin list` prints the ones the menu can show.

An agent can turn a panel into that plugin with `{"type":"plugin","plugin":"my-plugin"}`. A file view also stores the view and the address: `{"type":"plugin","plugin":"vim","view":"edit","path":"notes/a.md"}`. A directory view sets `"directory": true`. A page view stores `"url"` instead of `"path"`.

The plugin page is served by the viewer and shown in a sandbox, so it cannot call the viewer API or read the page around it. It can still talk to another localhost server that you run yourself.

## Permissions

`permissions` is optional. Leave it out and the plugin behaves as before: no Herdr bridge and no file feed. These are the names the installer accepts:

- `herdr:read` turns on `herdrPanels.listPanes`, `status`, and `readPane`.
- `herdr:control` turns on `sendText`, `sendKeys`, `focusPane`, and `scrollPane`. The panel's own JSON still has to set `"control": true`. Declaring the permission is not enough, and the flag does nothing for a plugin that did not declare it. When that flag is off, the bridge says to turn on control in the design bar. The design bar shows that note the first time you select a plugin that declared `herdr:control`, and the note stays until you turn control on. `focusPane(paneId)` switches the desk to that pane. It opens the pane's workspace, shows the pane in a terminal panel, and brings that panel to the front. When that space has no terminal panel, one is opened beside the last panel. The call also focuses the pane in Herdr. A pane id that is not in the session returns `pane was not found`. `scrollPane(paneId, direction, lines)` moves that pane. `direction` is `up` or `down`. `lines` is a whole number from 1 to 200. The pane has to be open in the viewer.
- `panels:read` turns on `listPanels`. Each entry has `id`, `title`, `type`, and `summary`.
- `panels:control` turns on `openPanel`, `updatePanel`, `closePanel`, `movePanel`, `resizePanel`, `fillPanel`, `showDesk`, `visitPanel`, and `setZoom`. These are the same desk edits as `herdr-panels panel`, plus the desktop window zoom. `fillPanel` fills the screen with one panel that is already on this space. `showDesk` shows the whole desk again. `visitPanel(panelId)` shows a panel from any space over this one. `visitPanels(panelIds, arrange, { sizes, columns, rows })` shows several in one visit. `arrange` is `row`, `column`, or `grid`. `sizes` is one weight per panel for a row or a column. `columns` and `rows` weight a grid. The reply names each space. A missing panel is an error and nothing opens. One Back, or Escape, leaves the whole visit. Those spaces are not changed, and the visit has no close button. `setZoom(scale)` sets that zoom to the nearest browser step, from 25% to 500%. A browser tab ignores it. They do not type into a Herdr pane. `updatePanel` takes `kind`, `path`, `page`, `plugin`, and `pane` the way the panel command does, and it cannot set `"control": true`. `examples/plugins/desk-sample` opens `https://example.com` as a browser panel, then moves, resizes, fills the screen with, and closes that one panel. Show the desk brings the layout back. Zoom 125% and Zoom 100% set the desktop window. Its Open in browser button calls `openExternal` for that same address, so the sample also declares `links:open`. `listPanels` still includes every panel's title and summary, which can be a file path or a pane id. The sample does not draw that list.
- `files:read` turns on the file feed. It has to come with `files`, a list of absolute paths or directories, such as `"/home/engel/projects/checkin/state"`. A path outside that list is refused. `..` and relative paths are refused. The server resolves symlinks on every read.
- `links:open` turns on `herdrPanels.openExternal(url)`. The address has to be `http` or `https`. In the desktop window that opens the system browser. In a browser tab it opens a new tab of that browser. `file`, `javascript`, and other schemes are refused. A link the person clicks does this without the permission. That includes `<a href="https://example.com" target="_blank">` and `window.open`. The permission is for a button that chooses the address in script, such as Open PR:

```js
await herdrPanels.openExternal("https://example.com/pull/1");
```

To put that address on the desk instead, declare `panels:control` and call `openPanel`. That adds a browser panel beside the current one. It does not add a tab. HTML has no `target` that means a panel. `target="_blank"` means a new browser tab, or the system browser when the desk is the desktop window.

```js
await herdrPanels.openPanel("https://example.com", { title: "Example" });
```

```json
{
  "id": "checkin-report",
  "title": "Check-in report",
  "permissions": ["files:read", "herdr:control"],
  "files": ["/home/engel/projects/checkin/state"]
}
```

`herdr-panels plugin install <directory>` prints those requests in plain language and asks before it copies the directory. Pass `--yes` to skip the question. `herdr-panels plugin list` prints each plugin's permissions. An unknown permission string makes install fail.

The bridge is the same script an HTML panel gets. Calls go to the host page, and the host asks the server. The frame never sees the viewer token.

To watch a file, the page posts:

```js
parent.postMessage({ source: "hwp-plugin", type: "watch", path: "/home/engel/projects/checkin/state/report.json" }, "*");
parent.postMessage({ source: "hwp-plugin", type: "unwatch", path: "/home/engel/projects/checkin/state/report.json" }, "*");
```

The host answers, and answers again when the file changes:

```js
{ source: "hwp-host", type: "file", path, content, mtime }
```

A missing file is `{ error: "not_found" }` and the watch stays up. A file over 1 MB is `{ error: "too_large" }`. One panel can watch 8 paths. `examples/plugins/checkin-report` watches a report and uses `focusPane` when a finding's `url` is a pane id like `w8:pG`. Put `"control": true` on that panel's layout object, or turn on control in the design bar. Otherwise the focus call is refused and the error says to turn that on. The design bar has the same checkbox as an HTML panel. A successful focus switches to that pane's workspace, shows it in a terminal panel, and brings that panel to the front.

## Address bar

The address bar belongs to the panel. `addressBar` chooses whether it is visible and whether the plugin may change the address.

Leave `addressBar` out, and the bar is shown. An address entered there opens in the viewer. `false` hides the bar. `true` shows it, and an address entered there still opens in the viewer.

```json
"addressBar": { "show": true, "modify": true }
```

`show` starts the bar visible and defaults to true. `modify` lets the plugin set the address and show or hide the bar. Back, Forward, Reload, and Enter are then delivered to the plugin.

```json
"addressBar": { "replace": true }
```

`replace` removes the viewer's address bar so the page can draw its own. The page fills the panel. `show` is ignored while `replace` is true. The panel gear can bring the viewer's bar back. With `modify` as well, the plugin can take that bar away again.

The page and the viewer talk with `postMessage`.

Plugin to viewer. These are honored when `modify` is true:

```js
parent.postMessage({ source: "hwp-plugin", type: "address", value: "notes/a" }, "*");
parent.postMessage({ source: "hwp-plugin", type: "address-bar", show: false }, "*");
parent.postMessage({ source: "hwp-plugin", type: "address-bar", replace: true }, "*");
```

`address` sets the text. A change records a history step. `address-bar` shows or hides the viewer's bar. `replace: true` hides it so the page can draw its own. An empty address, or one longer than 2048 characters, is ignored.

Viewer to plugin:

```js
window.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || message.source !== "hwp-host") return;
  if (message.type === "address-navigate") {
    // Someone submitted the bar, or moved Back or Forward. message.value is the address.
  }
  if (message.type === "address-reload") {
    // Someone pressed Reload.
  }
});
```

`address-navigate` arrives when someone submits the bar or uses Back or Forward. `address-reload` arrives for Reload. The plugin decides what those addresses mean.
