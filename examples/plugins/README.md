# Plugins

A plugin is a directory the viewer can show as a panel. This file is the guide. It is not a plugin, and it does not appear in the panel menu.

Installed plugins are listed in the title-bar menu, under Agents, with a divider above them. The menu shows each plugin's title.

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

Install a directory into the config folder:

```text
herdr-panels plugin install <directory>
```

Pass `--replace` to overwrite a plugin that is already installed. `herdr-panels plugin list` prints the ones the menu can show.

An agent can turn a panel into that plugin with `{"type":"plugin","plugin":"my-plugin"}`.

The plugin page is served by the viewer and shown in a sandbox, so it cannot call the viewer API or read the page around it. It can still talk to another localhost server that you run yourself. A plugin does not get the `herdrPanels` bridge used by HTML panels. That bridge is for panels whose type is `html`.
