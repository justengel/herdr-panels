import type { LayoutNode, PanelConfig } from "./types";
import { carryAddressBar } from "./addressBar";
import { explorerRootFor, resolveWorkspacePath } from "./explorerRoot";
import { parentPath, plainPath } from "./paths";

export type ViewOpen = "file" | "markdown" | "html" | "directory" | "url";

export interface PluginViewInfo {
  id: string;
  title: string;
  opens: ViewOpen[];
}

export interface MenuPlugin {
  id: string;
  title: string;
  views?: PluginViewInfo[];
  /** Open this plugin with Herdr control on. */
  controlDefault?: boolean;
}

export interface MenuEntry {
  id: string;
  label: string;
  section: "view" | "desk" | "plugins" | "panes" | "views";
  checked: boolean;
  submenu?: boolean;
}

export interface MenuPane {
  paneId: string;
  label: string;
  cwd?: string | null;
  workspaceId?: string | null;
}

export interface MenuContext {
  panes?: MenuPane[];
  workspaceId?: string | null;
  workspaceRoot?: string | null;
}

const VIEW_PLUGIN_INLINE_MAX = 2;

export interface PluginOpen {
  view: string;
  address: string;
  kind: string;
  config: Record<string, unknown>;
}

export interface StoredPluginView {
  plugin: string;
  view?: string;
  path?: string;
  url?: string;
  directory?: boolean;
}

type FileKind = "markdown" | "html" | "text";

type Subject =
  | { kind: "file"; path: string; file: FileKind }
  | { kind: "directory"; path: string }
  | { kind: "url"; url: string }
  | { kind: "page"; inline: string }
  | { kind: "none" };

const STORAGE_KEY = "herdr-panels.plugin-view";


function activePanel(panel: PanelConfig): PanelConfig {
  if (panel.type !== "tabs") return panel;
  return panel.tabs.find((tab) => tab.id === panel.active)?.panel ?? panel.tabs[0]?.panel ?? panel;
}

function extension(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

function fileKind(path: string): FileKind {
  const ext = extension(path);
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  return "text";
}

function subjectOf(panel: PanelConfig): Subject {
  const content = activePanel(panel);
  switch (content.type) {
    case "markdown":
      return { kind: "file", path: content.path, file: "markdown" };
    case "file":
      return { kind: "file", path: content.path, file: fileKind(content.path) };
    case "html":
      if (content.path) return { kind: "file", path: content.path, file: "html" };
      if (content.inline) return { kind: "page", inline: content.inline };
      return { kind: "none" };
    case "iframe":
      return content.url.trim() ? { kind: "url", url: content.url } : { kind: "none" };
    case "explorer":
      if (content.focus) return { kind: "file", path: content.focus, file: fileKind(content.focus) };
      return { kind: "directory", path: content.path };
    case "plugin":
      if (content.url) return { kind: "url", url: content.url };
      if (content.path && content.directory) return { kind: "directory", path: content.path };
      if (content.path) return { kind: "file", path: content.path, file: fileKind(content.path) };
      return { kind: "none" };
    default:
      return { kind: "none" };
  }
}

function pluginChoice(pluginId: string, viewId: string): string {
  return `plugin:${pluginId}:${viewId}`;
}

export function declaredViews(plugin: MenuPlugin): PluginViewInfo[] {
  if (!plugin.views || plugin.views.length === 0) {
    return [{ id: plugin.id, title: plugin.title, opens: [] }];
  }
  return plugin.views.map((view) => ({
    id: view.id || plugin.id,
    title: view.title || plugin.title,
    opens: view.opens ?? [],
  }));
}

function viewMatches(view: PluginViewInfo, subject: Subject): boolean {
  if (subject.kind === "directory") return view.opens.includes("directory");
  if (subject.kind === "url") return view.opens.includes("url");
  if (subject.kind !== "file") return false;
  if (view.opens.includes("file")) return true;
  if (subject.file === "markdown" && view.opens.includes("markdown")) return true;
  return subject.file === "html" && view.opens.includes("html");
}

/** Label for the viewer pill. Empty for desk panels that are already named by their view. */
export function viewerName(panel: PanelConfig, pluginTitle = ""): string {
  const content = activePanel(panel);
  switch (content.type) {
    case "markdown":
      return content.raw ? "Text" : "Markdown";
    case "html":
      return content.raw ? "Text" : "Browser";
    case "iframe":
      return "Browser";
    case "file":
      return "Text";
    case "explorer":
      return "Files";
    case "plugin":
      return pluginTitle || content.view || content.plugin;
    default:
      return "";
  }
}

function activeId(panel: PanelConfig): string {
  const content = activePanel(panel);
  switch (content.type) {
    case "markdown":
      return content.raw ? "text" : "markdown";
    case "html":
      return content.raw ? "text" : "browser";
    case "iframe":
      return "browser";
    case "file":
      return "text";
    case "explorer":
      return "files";
    case "herdr":
      return "terminal";
    case "files":
      return "spaces";
    case "agents":
      return "agents";
    case "plugin":
      return pluginChoice(content.plugin, content.view || content.plugin);
    default:
      return "";
  }
}

function mark(entries: MenuEntry[], active: string): MenuEntry[] {
  return entries.map((entry) => ({ ...entry, checked: entry.id === active }));
}

function deskEntries(panel: PanelConfig, subject: Subject, ctx: MenuContext): { desk: MenuEntry[]; panes: MenuEntry[] } {
  const content = activePanel(panel);
  const terminalLabel =
    subject.kind === "file" || subject.kind === "directory" ? "Terminal here" : "Terminal";
  if (content.type !== "herdr") {
    return {
      desk: [
        { id: "terminal", label: terminalLabel, section: "desk", checked: false },
        { id: "spaces", label: "Spaces", section: "desk", checked: false },
        { id: "agents", label: "Agents", section: "desk", checked: false },
      ],
      panes: [],
    };
  }
  const spaceId = ctx.workspaceId ?? null;
  const panes = (ctx.panes ?? []).filter(
    (pane) => !spaceId || !pane.workspaceId || pane.workspaceId === spaceId,
  );
  const paneRows: MenuEntry[] = panes.map((pane) => ({
    id: `pane:${pane.paneId}`,
    label: pane.label ? `${pane.paneId} · ${pane.label}` : pane.paneId,
    section: "panes" as const,
    checked: false,
  }));
  paneRows.push({ id: "pane:new", label: "New pane…", section: "panes", checked: false });
  return {
    desk: [
      { id: "panes", label: "Panes", section: "desk", checked: false, submenu: true },
      { id: "spaces", label: "Spaces", section: "desk", checked: false },
      { id: "agents", label: "Agents", section: "desk", checked: false },
    ],
    panes: paneRows,
  };
}

/** Viewers for the address in this panel, then desk views, then plugins that are their own panel. */
export function menuFor(panel: PanelConfig, plugins: MenuPlugin[], ctx: MenuContext = {}): MenuEntry[] {
  const subject = subjectOf(panel);
  const active = activeId(panel);
  const view: MenuEntry[] = [{ id: "open", label: "Open file or URL…", section: "view", checked: false }];

  const showFiles =
    subject.kind === "file" ||
    subject.kind === "directory" ||
    subject.kind === "none" ||
    active === "files" ||
    active === "terminal" ||
    active === "spaces" ||
    active === "agents" ||
    activePanel(panel).type === "blank";
  if (showFiles) {
    view.push({ id: "files", label: "Files", section: "view", checked: false });
  }

  const showBrowser =
    (subject.kind === "file" && subject.file === "html") ||
    subject.kind === "url" ||
    subject.kind === "page" ||
    subject.kind === "none" ||
    activePanel(panel).type === "blank" ||
    active === "terminal" ||
    active === "spaces" ||
    active === "agents";
  if (showBrowser) {
    view.push({ id: "browser", label: "Browser", section: "view", checked: false });
  }

  if (subject.kind === "file" || subject.kind === "page") {
    view.push({ id: "text", label: "Text", section: "view", checked: false });
  }
  if (subject.kind === "file" && subject.file === "markdown") {
    view.push({ id: "markdown", label: "Markdown", section: "view", checked: false });
  }

  const panels: MenuEntry[] = [];
  const addressPlugins: MenuEntry[] = [];
  for (const plugin of plugins) {
    for (const viewInfo of declaredViews(plugin)) {
      const id = pluginChoice(plugin.id, viewInfo.id);
      const entry: MenuEntry = { id, label: viewInfo.title, section: "view", checked: false };
      if (viewInfo.opens.length === 0) panels.push({ ...entry, section: "plugins" });
      else if (viewMatches(viewInfo, subject)) addressPlugins.push(entry);
    }
  }
  if (active.startsWith("plugin:") && !addressPlugins.some((entry) => entry.id === active) && !panels.some((entry) => entry.id === active)) {
    const found = findView(active, plugins);
    if (found && found.view.opens.length > 0) {
      addressPlugins.push({ id: active, label: found.view.title, section: "view", checked: false });
    }
  }
  let moreViews: MenuEntry[] = [];
  if (addressPlugins.length > VIEW_PLUGIN_INLINE_MAX) {
    view.push({ id: "more-views", label: "More views", section: "view", checked: false, submenu: true });
    moreViews = addressPlugins.map((entry) => ({ ...entry, section: "views" as const }));
  } else {
    view.push(...addressPlugins);
  }

  const content = activePanel(panel);
  const { desk, panes } = deskEntries(panel, subject, ctx);
  const spacePanes = (ctx.panes ?? []).filter(
    (pane) => !ctx.workspaceId || !pane.workspaceId || pane.workspaceId === ctx.workspaceId,
  );
  const paneActive =
    content.type === "herdr" && content.paneId && spacePanes.length > 0
      ? `pane:${content.paneId}`
      : active;

  return [
    ...mark(view, active),
    ...mark(moreViews, active),
    ...mark(desk, content.type === "herdr" ? "panes" : paneActive),
    ...mark(panes, paneActive),
    ...mark(panels, active),
  ];
}

function findView(choice: string, plugins: MenuPlugin[]): { plugin: MenuPlugin; view: PluginViewInfo } | null {
  const parts = choice.split(":");
  if (parts.length !== 3 || parts[0] !== "plugin") return null;
  const plugin = plugins.find((item) => item.id === parts[1]);
  if (!plugin) return null;
  const view = declaredViews(plugin).find((item) => item.id === parts[2]);
  return view ? { plugin, view } : null;
}

function keepsAddress(choice: string, plugins: MenuPlugin[]): boolean {
  if (choice === "markdown" || choice === "text" || choice === "browser" || choice === "files") return true;
  const found = findView(choice, plugins);
  return Boolean(found && found.view.opens.length > 0);
}

/** Switch viewer without dropping the address that viewer can show. */
export function showViewer(
  panel: PanelConfig,
  choice: string,
  plugins: MenuPlugin[],
  ctx: Pick<MenuContext, "workspaceRoot"> = {},
): PanelConfig {
  if (panel.type === "tabs") {
    const active = panel.tabs.find((tab) => tab.id === panel.active) ?? panel.tabs[0];
    if (!active) return panel;
    return {
      ...panel,
      tabs: panel.tabs.map((tab) =>
        tab.id === active.id ? { ...tab, panel: showViewer(tab.panel, choice, plugins, ctx) } : tab,
      ),
    };
  }
  const next = applyViewer(panel, choice, plugins, ctx);
  return keepsAddress(choice, plugins) ? carryAddressBar(panel, next) : next;
}

function applyViewer(
  panel: PanelConfig,
  choice: string,
  plugins: MenuPlugin[],
  ctx: Pick<MenuContext, "workspaceRoot"> = {},
): PanelConfig {
  const subject = subjectOf(panel);
  if (choice === "markdown") {
    if (subject.kind === "file" && subject.file === "markdown") return { type: "markdown", path: subject.path };
    return panel;
  }
  if (choice === "text") {
    if (subject.kind === "file") return { type: "file", path: subject.path };
    if (subject.kind === "page") return { type: "html", inline: subject.inline, raw: true };
    return panel;
  }
  if (choice === "browser") {
    if (subject.kind === "file" && subject.file === "html") return { type: "html", path: subject.path };
    if (subject.kind === "url") {
      return { type: "iframe", url: subject.url, proxy: panel.type === "iframe" ? Boolean(panel.proxy) : false };
    }
    if (subject.kind === "page") return { type: "html", inline: subject.inline };
    if (subject.kind === "none") return { type: "iframe", url: "", proxy: false };
    return panel;
  }
  if (choice === "files") {
    if (subject.kind === "directory") {
      return { type: "explorer", path: resolveWorkspacePath(subject.path, ctx.workspaceRoot) };
    }
    if (subject.kind === "file") {
      const focus = resolveWorkspacePath(subject.path, ctx.workspaceRoot);
      return {
        type: "explorer",
        path: explorerRootFor(focus, ctx.workspaceRoot),
        focus,
      };
    }
    return { type: "explorer", path: plainPath(ctx.workspaceRoot || "") };
  }
  if (choice === "terminal") return panel.type === "herdr" ? panel : { type: "herdr", paneId: null };
  if (choice.startsWith("pane:") && choice !== "pane:new") {
    const paneId = choice.slice("pane:".length);
    return { type: "herdr", paneId };
  }
  if (choice === "spaces") return panel.type === "files" ? panel : { type: "files" };
  if (choice === "agents") return panel.type === "agents" ? panel : { type: "agents" };
  const found = findView(choice, plugins);
  if (!found) return panel;
  const config = panel.type === "plugin" && panel.plugin === found.plugin.id ? panel.config : undefined;
  const keepControl = panel.type === "plugin" && panel.plugin === found.plugin.id && Boolean(panel.control);
  const control = keepControl || Boolean(found.plugin.controlDefault);
  const base: PanelConfig = {
    type: "plugin",
    plugin: found.plugin.id,
    view: found.view.id,
    ...(config ? { config } : {}),
    ...(control ? { control: true } : {}),
  };
  if (found.view.opens.length === 0) return base;
  if (subject.kind === "directory" && found.view.opens.includes("directory")) {
    return { ...base, path: subject.path, directory: true };
  }
  if (subject.kind === "file" && viewMatches(found.view, subject)) return { ...base, path: subject.path };
  if (subject.kind === "file" && found.view.opens.includes("directory")) {
    return { ...base, path: parentPath(subject.path), directory: true };
  }
  if (subject.kind === "url" && found.view.opens.includes("url")) return { ...base, url: subject.url };
  return panel;
}

/** What the host tells a plugin when its frame opens. */
export function pluginOpenMessage(panel: PanelConfig): PluginOpen | null {
  if (panel.type !== "plugin") return null;
  const subject = subjectOf(panel);
  let address = "";
  let kind = "";
  if (subject.kind === "file") {
    address = subject.path;
    kind = subject.file === "text" ? "file" : subject.file;
  } else if (subject.kind === "directory") {
    address = subject.path;
    kind = "directory";
  } else if (subject.kind === "url") {
    address = subject.url;
    kind = "url";
  }
  return {
    view: panel.view || panel.plugin,
    address,
    kind,
    config: panel.config ?? {},
  };
}

/** Keep a plugin view and point it at the address the host resolved. */
export function adoptPluginAddress(panel: PanelConfig, resolved: PanelConfig): PanelConfig | null {
  if (panel.type !== "plugin") return null;
  const next: Extract<PanelConfig, { type: "plugin" }> = { ...panel };
  delete next.path;
  delete next.url;
  delete next.directory;
  if ((resolved.type === "markdown" || resolved.type === "file") && resolved.path) next.path = resolved.path;
  else if (resolved.type === "html" && resolved.path) next.path = resolved.path;
  else if (resolved.type === "explorer") {
    next.path = resolved.path;
    next.directory = true;
  } else if (resolved.type === "iframe" && resolved.url) next.url = resolved.url;
  else return null;
  if (panel.path === next.path && panel.url === next.url && panel.directory === next.directory) return null;
  return next;
}

/** Fill in a plugin file a viewer dropped, without overriding one the layout already has. */
export function applyPluginSubjects(
  node: LayoutNode,
  layoutId: string,
  choices: Record<string, StoredPluginView>,
): LayoutNode {
  if (node.type === "split") {
    return {
      ...node,
      first: applyPluginSubjects(node.first, layoutId, choices),
      second: applyPluginSubjects(node.second, layoutId, choices),
    };
  }
  if (node.type === "grid") {
    return {
      ...node,
      cells: node.cells.map((cell) => ({
        ...cell,
        node: cell.node ? applyPluginSubjects(cell.node, layoutId, choices) : cell.node,
        panel: cell.panel ? fillPlugin(cell.id, cell.panel, layoutId, choices) : cell.panel,
      })),
    };
  }
  return { ...node, panel: fillPlugin(node.id, node.panel, layoutId, choices) };
}

function fillPlugin(
  panelId: string,
  panel: PanelConfig,
  layoutId: string,
  choices: Record<string, StoredPluginView>,
): PanelConfig {
  if (panel.type === "tabs") {
    return {
      ...panel,
      tabs: panel.tabs.map((tab) => ({
        ...tab,
        panel: restorePlugin(`${layoutId}:${panelId}:${tab.id}`, tab.panel, choices),
      })),
    };
  }
  return restorePlugin(`${layoutId}:${panelId}`, panel, choices);
}

function restorePlugin(key: string, panel: PanelConfig, choices: Record<string, StoredPluginView>): PanelConfig {
  if (panel.type !== "plugin") return panel;
  const stored = choices[key];
  if (!stored || stored.plugin !== panel.plugin) return panel;
  const next = { ...panel };
  if (!next.view && stored.view) next.view = stored.view;
  if (!next.path && stored.path) next.path = stored.path;
  if (!next.url && stored.url) next.url = stored.url;
  if (next.directory !== true && stored.directory) next.directory = true;
  return next;
}

export function readPluginSubjects(): Record<string, StoredPluginView> {
  const storage = browserStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const choices: Record<string, StoredPluginView> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      const item = value as StoredPluginView;
      if (typeof item.plugin !== "string") continue;
      choices[key] = {
        plugin: item.plugin,
        view: typeof item.view === "string" ? item.view : undefined,
        path: typeof item.path === "string" ? item.path : undefined,
        url: typeof item.url === "string" ? item.url : undefined,
        directory: item.directory === true,
      };
    }
    return choices;
  } catch {
    return {};
  }
}

export function writePluginSubject(layoutId: string, surfaceId: string, panel: PanelConfig) {
  const storage = browserStorage();
  if (!storage) return;
  const choices = readPluginSubjects();
  const key = `${layoutId}:${surfaceId}`;
  const content = activePanel(panel);
  if (content.type !== "plugin") delete choices[key];
  else {
    choices[key] = {
      plugin: content.plugin,
      view: content.view || content.plugin,
      path: content.path,
      url: content.url,
      directory: content.directory === true,
    };
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(choices));
  } catch {
    // The panel still records the file when the viewer stores the layout.
  }
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
