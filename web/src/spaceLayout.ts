import type { LayoutNode, PanelNode, RuntimeSnapshot } from "./types";
import { closePanel, ensureSidebar, listPanels, setPanel } from "./layoutEdit";
import { findPin, pinApplies, readPins, removePin, unpinFromSpace, writePins, type PinRecord } from "./pins";
import { touchDesk } from "./deskBus";

const STORAGE_KEY = "herdr-panels.space-layouts";
const MAP_KEY = "herdr-panels.space-layout-map";

/** Shared dock for pinned panels: left column, stable ratio across spaces. */
const PIN_RATIO = 0.28;

type Store = Record<string, LayoutNode>;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readStore(): Store {
  const local = storage();
  if (!local) return {};
  try {
    const raw = local.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Store;
  } catch {
    return {};
  }
}

export function readSpaceLayouts(): Store {
  return readStore();
}

export function replaceSpaceLayouts(spaces: Store) {
  writeStore(spaces);
}

function writeStore(store: Store) {
  const local = storage();
  if (!local) return;
  try {
    local.setItem(STORAGE_KEY, JSON.stringify(store));
    touchDesk();
  } catch {
    // The desk is also saved with the herdr-panels server.
  }
}

export function spaceLayoutKey(workspaceId: string): string {
  return workspaceId.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "space";
}

export function seedSpaceLayout(): LayoutNode {
  return ensureSidebar({
    type: "panel",
    id: "terminal",
    title: "Terminal",
    panel: { type: "herdr", paneId: null },
  });
}

export function saveSpaceLayout(workspaceId: string, root: LayoutNode) {
  if (!workspaceId) return;
  rememberPinContent(root, workspaceId);
  const store = readStore();
  store[spaceLayoutKey(workspaceId)] = root;
  writeStore(store);
}

export function loadSpaceLayout(workspaceId: string): LayoutNode | null {
  if (!workspaceId) return null;
  return readStore()[spaceLayoutKey(workspaceId)] ?? null;
}

export function readSpaceMap(): string | null {
  const local = storage();
  if (!local) return null;
  return local.getItem(MAP_KEY);
}

export function writeSpaceMap(workspaceId: string | null) {
  const local = storage();
  if (!local) return;
  if (!workspaceId) local.removeItem(MAP_KEY);
  else local.setItem(MAP_KEY, workspaceId);
}

function panelNodeFromPin(pin: PinRecord): PanelNode {
  return {
    type: "panel",
    id: pin.id,
    title: pin.title,
    panel: pin.panel,
  };
}

function hasPanelId(root: LayoutNode, id: string): boolean {
  return listPanels(root).some((panel) => panel.id === id);
}

function applicablePins(workspaceId: string): PinRecord[] {
  return readPins()
    .filter((pin) => pinApplies(pin, workspaceId) && pin.panel.type !== "herdr")
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** A pin's place belongs to the space. Saving records the panel that is sitting there. */
function rememberPinContent(root: LayoutNode, workspaceId: string) {
  const panels = listPanels(root);
  let changed = false;
  const next = readPins().map((pin) => {
    if (!pinApplies(pin, workspaceId) || pin.panel.type === "herdr") return pin;
    const placed = panels.find((panel) => panel.id === pin.id);
    if (!placed) return pin;
    const title = placed.title?.trim() || pin.title;
    if (title === pin.title && JSON.stringify(placed.panel) === JSON.stringify(pin.panel)) return pin;
    changed = true;
    return { ...pin, title, panel: placed.panel };
  });
  if (changed) writePins(next);
}

/** Take out a pin that belongs to other spaces, so it does not linger after its scope changes. */
function withoutForeignPins(root: LayoutNode, workspaceId: string): LayoutNode {
  let next = root;
  for (const pin of readPins()) {
    if (pin.panel.type === "herdr" || pinApplies(pin, workspaceId)) continue;
    if (!hasPanelId(next, pin.id)) continue;
    const closed = closePanel(next, pin.id);
    if (closed) next = closed;
  }
  return next;
}

function syncPinned(node: LayoutNode, byId: Map<string, PinRecord>): LayoutNode {
  if (node.type === "split") {
    return {
      ...node,
      first: syncPinned(node.first, byId),
      second: syncPinned(node.second, byId),
    };
  }
  if (node.type === "grid") {
    return {
      ...node,
      cells: node.cells.map((cell) => ({
        ...cell,
        node: cell.node ? syncPinned(cell.node, byId) : cell.node,
        panel: undefined,
      })),
    };
  }
  const pin = byId.get(node.id);
  if (!pin) return node;
  return { ...node, title: pin.title, panel: pin.panel };
}

function pinColumn(pins: PinRecord[]): LayoutNode {
  const nodes = pins.map(panelNodeFromPin);
  const stack = (items: LayoutNode[]): LayoutNode => {
    const [first, ...rest] = items;
    if (!first) {
      return { type: "panel", id: "pin", title: null, panel: { type: "blank" } };
    }
    if (rest.length === 0) return first;
    return {
      type: "split",
      direction: "column",
      ratio: 1 / items.length,
      first,
      second: stack(rest),
    };
  };
  return stack(nodes);
}

/** Remove the panel from this space when the pin still applies somewhere else. Null means the panel stays. */
export function unpinHere(
  root: LayoutNode,
  panelId: string,
  spaceId: string,
  allSpaceIds: string[],
): LayoutNode | null {
  const kept = unpinFromSpace(panelId, spaceId, allSpaceIds);
  if (!kept) return null;
  return closePanel(root, panelId);
}

/** Spaces, Agents, and panes belong to each space even when they are not pinned. */
function isDeskNative(panel: { type: string }): boolean {
  return panel.type === "files" || panel.type === "agents" || panel.type === "herdr";
}

/** Drop a panel id from saved spaces so a removed pin cannot leave a copy behind. */
function scrubStoredPin(panelId: string) {
  const store = readStore();
  let changed = false;
  for (const [key, node] of Object.entries(store)) {
    if (!hasPanelId(node, panelId)) continue;
    const closed = closePanel(node, panelId);
    if (closed) store[key] = closed;
    else delete store[key];
    changed = true;
  }
  if (changed) writeStore(store);
}

/** Clears the pin. Other panels are removed from every space. Spaces, Agents, and panes stay. */
export function unpinEverywhere(root: LayoutNode, panelId: string): LayoutNode {
  const pin = findPin(panelId);
  if (!pin) return root;
  const native = isDeskNative(pin.panel);
  removePin(panelId);
  if (native) return root;
  scrubStoredPin(panelId);
  return closePanel(root, panelId) ?? root;
}

/** Close this panel. A pin stops applying here so it cannot come back. The last copy of an ordinary panel is removed from every space. */
export function closePinned(
  root: LayoutNode,
  panelId: string,
  spaceId: string,
  allSpaceIds: string[],
): LayoutNode | null {
  const next = closePanel(root, panelId);
  if (!next) return null;
  const pin = findPin(panelId);
  if (pin && spaceId) {
    const kept = unpinFromSpace(panelId, spaceId, allSpaceIds);
    if (!kept && !isDeskNative(pin.panel)) scrubStoredPin(panelId);
  }
  return next;
}

/** Merge pinned panels that apply to this space onto the space layout. */
export function mergePins(root: LayoutNode, workspaceId: string): LayoutNode {
  const pins = applicablePins(workspaceId);
  const byId = new Map(pins.map((pin) => [pin.id, pin]));
  const next = syncPinned(withoutForeignPins(root, workspaceId), byId);
  const missing = pins.filter((pin) => !hasPanelId(next, pin.id));
  if (missing.length === 0) return next;
  return {
    type: "split",
    direction: "row",
    ratio: PIN_RATIO,
    first: pinColumn(missing),
    second: next,
  };
}

export function layoutForSpace(workspaceId: string, fallback: LayoutNode): LayoutNode {
  const stored = loadSpaceLayout(workspaceId) ?? fallback;
  return mergePins(stored, workspaceId);
}

/** Optimistic runtime focus so the Spaces list updates before Herdr/poll catches up. */
export function markWorkspaceFocused(
  runtime: RuntimeSnapshot,
  workspaceId: string,
  paneId: string | null,
): RuntimeSnapshot {
  return {
    ...runtime,
    focusedWorkspaceId: workspaceId,
    focusedPaneId: paneId ?? runtime.focusedPaneId,
    workspaces: runtime.workspaces.map((space) => ({
      ...space,
      focused: space.workspaceId === workspaceId,
    })),
    panes: runtime.panes.map((pane) => ({
      ...pane,
      focused: paneId ? pane.paneId === paneId : false,
    })),
  };
}

/**
 * While a local space switch is in flight, ignore stale Herdr snapshots that still
 * point at the previous space — otherwise the desk snaps back until the next poll.
 */
export function preferPendingSpace(
  runtime: RuntimeSnapshot,
  pendingWorkspaceId: string | null,
): RuntimeSnapshot {
  if (!pendingWorkspaceId) return runtime;
  if (runtime.focusedWorkspaceId === pendingWorkspaceId) return runtime;
  const inSpace = runtime.panes.filter((pane) => pane.workspaceId === pendingWorkspaceId);
  const pane = inSpace.find((item) => item.focused) ?? inSpace[0] ?? null;
  return markWorkspaceFocused(runtime, pendingWorkspaceId, pane?.paneId ?? null);
}

/** Bind the first Terminal panel to a pane without waiting on Herdr. */
export function bindTerminalPane(root: LayoutNode, paneId: string | null): LayoutNode {
  if (!paneId) return root;
  const terminal = listPanels(root).find((panel) => panel.panel.type === "herdr");
  if (!terminal || terminal.panel.type !== "herdr" || terminal.panel.paneId === paneId) return root;
  return setPanel(root, terminal.id, { ...terminal.panel, paneId });
}
