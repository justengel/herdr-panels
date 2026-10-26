import type { LayoutNode, PanelConfig } from "./types";

const STORAGE_KEY = "herdr-panels.raw-text";

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

function renderedFromFile(
  kind: "markdown" | "html",
  path: string,
  addressBar: boolean | undefined,
): PanelConfig {
  if (kind === "markdown") {
    return addressBar === undefined ? { type: "markdown", path } : { type: "markdown", path, addressBar };
  }
  return addressBar === undefined ? { type: "html", path } : { type: "html", path, addressBar };
}

function renderedKind(path: string): "markdown" | "html" | null {
  const ext = extension(path);
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  return null;
}

function hasSource(panel: PanelConfig): boolean {
  if (panel.type === "markdown" || panel.type === "file") return true;
  if (panel.type === "html") return Boolean(panel.path) || Boolean(panel.inline);
  return false;
}

/** The panel is showing the file bytes instead of a rendered page. */
export function showsRawText(panel: PanelConfig): boolean {
  const content = activePanel(panel);
  if (content.type === "file") return true;
  if (content.type === "markdown" || content.type === "html") return content.raw === true;
  return false;
}

/**
 * The gear check for Raw text.
 * Null means this panel has only one way to show its file.
 */
export function rawTextChoice(panel: PanelConfig): boolean | null {
  const content = activePanel(panel);
  if (!hasSource(content)) return null;
  if (content.type === "markdown" || content.type === "html") return content.raw === true;
  if (content.type === "file" && renderedKind(content.path)) return true;
  return null;
}

/** Turn the raw view on or off without dropping the file. */
export function setRawText(panel: PanelConfig, raw: boolean): PanelConfig {
  if (panel.type === "tabs") {
    const active = panel.tabs.find((tab) => tab.id === panel.active) ?? panel.tabs[0];
    if (!active || rawTextChoice(active.panel) === null) return panel;
    return {
      ...panel,
      tabs: panel.tabs.map((tab) =>
        tab.id === active.id ? { ...tab, panel: setRawText(tab.panel, raw) } : tab,
      ),
    };
  }
  if (panel.type === "markdown" || panel.type === "html") {
    if (!hasSource(panel)) return panel;
    if (!raw) {
      const next = { ...panel };
      delete next.raw;
      return next;
    }
    return { ...panel, raw: true };
  }
  if (panel.type === "file" && !raw) {
    const kind = renderedKind(panel.path);
    if (kind === "markdown" || kind === "html") return renderedFromFile(kind, panel.path, panel.addressBar);
  }
  return panel;
}

/** Keep a raw choice when the address resolves to another rendered file. */
export function carryRaw(current: PanelConfig, next: PanelConfig): PanelConfig {
  if ((current.type !== "markdown" && current.type !== "html") || current.raw !== true) return next;
  if (next.type === "markdown" || next.type === "html") return { ...next, raw: true };
  return next;
}

/** Fill in a raw choice a viewer dropped, without overriding one the layout already has. */
export function applyRawChoices(
  node: LayoutNode,
  layoutId: string,
  choices: Record<string, boolean>,
): LayoutNode {
  if (node.type === "split") {
    return {
      ...node,
      first: applyRawChoices(node.first, layoutId, choices),
      second: applyRawChoices(node.second, layoutId, choices),
    };
  }
  if (node.type === "grid") {
    return {
      ...node,
      cells: node.cells.map((cell) => ({
        ...cell,
        node: cell.node ? applyRawChoices(cell.node, layoutId, choices) : cell.node,
        panel: cell.panel ? applyPanelConfig(cell.id, cell.panel, layoutId, choices) : cell.panel,
      })),
    };
  }
  return { ...node, panel: applyPanelConfig(node.id, node.panel, layoutId, choices) };
}

function applyPanelConfig(
  panelId: string,
  panel: PanelConfig,
  layoutId: string,
  choices: Record<string, boolean>,
): PanelConfig {
  if (panel.type === "tabs") {
    return {
      ...panel,
      tabs: panel.tabs.map((tab) => ({
        ...tab,
        panel: fillChoice(`${layoutId}:${panelId}:${tab.id}`, tab.panel, choices),
      })),
    };
  }
  return fillChoice(`${layoutId}:${panelId}`, panel, choices);
}

function fillChoice(key: string, panel: PanelConfig, choices: Record<string, boolean>): PanelConfig {
  if ((panel.type !== "markdown" && panel.type !== "html") || panel.raw === true) return panel;
  if (choices[key] !== true || !hasSource(panel)) return panel;
  return { ...panel, raw: true };
}

export function readRawChoices(): Record<string, boolean> {
  const storage = browserStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const choices: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "boolean") choices[key] = value;
    }
    return choices;
  } catch {
    return {};
  }
}

export function writeRawChoice(layoutId: string, surfaceId: string, raw: boolean) {
  const storage = browserStorage();
  if (!storage) return;
  const choices = readRawChoices();
  choices[`${layoutId}:${surfaceId}`] = raw;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(choices));
  } catch {
    // The panel field still records the choice when the viewer stores the layout.
  }
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
