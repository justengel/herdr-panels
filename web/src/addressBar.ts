import type { LayoutNode, PanelConfig } from "./types";
import type { PluginAddressBar } from "./pluginAddress";

const STORAGE_KEY = "herdr-panels.address-bar";

type AddressPanel = Extract<
  PanelConfig,
  { type: "markdown" | "iframe" | "html" | "file" | "explorer" | "plugin" }
>;

const ADDRESS_TYPES = new Set<PanelConfig["type"]>(["markdown", "iframe", "html", "file", "explorer", "plugin"]);

export function supportsAddressBar(panel: PanelConfig): panel is AddressPanel {
  return ADDRESS_TYPES.has(panel.type);
}

function activePanel(panel: PanelConfig): PanelConfig {
  if (panel.type !== "tabs") return panel;
  return panel.tabs.find((tab) => tab.id === panel.active)?.panel ?? panel.tabs[0]?.panel ?? panel;
}

/** Whether the viewer's address bar is shown for this panel. */
export function hostAddressBarVisible(panel: PanelConfig, plugin?: PluginAddressBar): boolean {
  const content = activePanel(panel);
  if (!supportsAddressBar(content)) return false;
  if (typeof content.addressBar === "boolean") return content.addressBar;
  if (content.type === "plugin" && (plugin?.replace || plugin?.show === false)) return false;
  return true;
}

/** Record the gear choice on the panel, or on the active tab. */
export function setAddressBar(panel: PanelConfig, show: boolean): PanelConfig {
  if (panel.type === "tabs") {
    const active = panel.tabs.find((tab) => tab.id === panel.active) ?? panel.tabs[0];
    if (!active || !supportsAddressBar(active.panel)) return panel;
    return {
      ...panel,
      tabs: panel.tabs.map((tab) =>
        tab.id === active.id ? { ...tab, panel: { ...active.panel, addressBar: show } } : tab,
      ),
    };
  }
  if (!supportsAddressBar(panel)) return panel;
  return { ...panel, addressBar: show };
}

/** Keep a saved show/hide choice when the address resolves to another document. */
export function carryAddressBar(current: PanelConfig, next: PanelConfig): PanelConfig {
  if (!supportsAddressBar(current) || typeof current.addressBar !== "boolean" || !supportsAddressBar(next)) {
    return next;
  }
  return { ...next, addressBar: current.addressBar };
}

/** Id of the document the gear is looking at, including the active tab. */
export function addressBarSurfaceId(panelId: string, panel: PanelConfig): string | null {
  if (panel.type === "tabs") {
    const active = panel.tabs.find((tab) => tab.id === panel.active) ?? panel.tabs[0];
    if (!active || !supportsAddressBar(active.panel)) return null;
    return `${panelId}:${active.id}`;
  }
  return supportsAddressBar(panel) ? panelId : null;
}

/** Fill in choices a viewer dropped, without overriding a choice the layout already has. */
export function applyAddressBarChoices(
  node: LayoutNode,
  layoutId: string,
  choices: Record<string, boolean>,
): LayoutNode {
  if (node.type === "split") {
    return {
      ...node,
      first: applyAddressBarChoices(node.first, layoutId, choices),
      second: applyAddressBarChoices(node.second, layoutId, choices),
    };
  }
  if (node.type === "grid") {
    return {
      ...node,
      cells: node.cells.map((cell) => ({
        ...cell,
        node: cell.node ? applyAddressBarChoices(cell.node, layoutId, choices) : cell.node,
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
  if (!supportsAddressBar(panel) || typeof panel.addressBar === "boolean") return panel;
  const choice = choices[key];
  if (typeof choice !== "boolean") return panel;
  return { ...panel, addressBar: choice };
}

export function readAddressBarChoices(): Record<string, boolean> {
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

export function writeAddressBarChoice(layoutId: string, surfaceId: string, show: boolean) {
  const storage = browserStorage();
  if (!storage) return;
  const choices = readAddressBarChoices();
  choices[`${layoutId}:${surfaceId}`] = show;
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
