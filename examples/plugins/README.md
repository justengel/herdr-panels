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

`value` has to be an object, and the JSON has to be 32 KB or smaller. An array is ignored. The page does not get the viewer token or `herdrPanels`.

Install a directory into the config folder:

```text
herdr-panels plugin install <directory>
```

Pass `--replace` to overwrite a plugin that is already installed. `herdr-panels plugin list` prints the ones the menu can show.

An agent can turn a panel into that plugin with `{"type":"plugin","plugin":"my-plugin"}`. A file view also stores the view and the address: `{"type":"plugin","plugin":"vim","view":"edit","path":"notes/a.md"}`. A directory view sets `"directory": true`. A page view stores `"url"` instead of `"path"`.

The plugin page is served by the viewer and shown in a sandbox, so it cannot call the viewer API or read the page around it. It can still talk to another localhost server that you run yourself. A plugin does not get the `herdrPanels` bridge used by HTML panels. That bridge is for panels whose type is `html`.

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
