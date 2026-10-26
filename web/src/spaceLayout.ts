import type { LayoutNode, PanelNode, RuntimeSnapshot } from "./types";
import { closePanel, ensureSidebar, listPanels, setPanel } from "./layoutEdit";
import { pinApplies, readPins, type PinRecord } from "./pins";

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
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Store;
  } catch {
    return {};
  }
}

function writeStore(store: Store) {
  const local = storage();
  if (!local) return;
  try {
    local.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Layout still lives in the active document when storage is full.
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
  const store = readStore();
  store[spaceLayoutKey(workspaceId)] = stripPins(root, workspaceId);
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

/** Remove panels that are still pinned into this space so the space store stays unpinned-only. */
export function stripPins(root: LayoutNode, workspaceId: string): LayoutNode {
  let next = root;
  for (const pin of applicablePins(workspaceId)) {
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

/** Merge pinned panels that apply to this space onto the space layout. */
export function mergePins(root: LayoutNode, workspaceId: string): LayoutNode {
  const pins = applicablePins(workspaceId);
  const byId = new Map(pins.map((pin) => [pin.id, pin]));
  let next = syncPinned(root, byId);
  for (const pin of pins) {
    if (hasPanelId(next, pin.id)) continue;
    next = {
      type: "split",
      direction: "row",
      ratio: PIN_RATIO,
      first: panelNodeFromPin(pin),
      second: next,
    };
  }
  return next;
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
