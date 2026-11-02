export type TerminalHome = "panel" | "panes";

export type TerminalExit =
  | { kind: "close-tab"; tabId: string }
  | { kind: "close-pane"; paneId: string }
  | { kind: "retire-panel" };

const drivers = new Map<string, TerminalHome>();
const closed = new Set<string>();

/** The surface that last typed into this pane. Exit follows that surface. */
export function noteTerminalDriver(paneId: string, home: TerminalHome) {
  if (paneId) drivers.set(paneId, home);
}

export function terminalDriver(paneId: string): TerminalHome | null {
  return drivers.get(paneId) ?? null;
}

/** One close for a pane, even when two terminal panels see it end. */
export function claimPaneClose(paneId: string): boolean {
  if (!paneId || closed.has(paneId)) return false;
  closed.add(paneId);
  return true;
}

/**
 * Exit in the terminal panel closes that pane's tab, or just the pane when the
 * tab still has another one. Exit in the panes tab leaves the tab and retires
 * the terminal panel that was showing it.
 */
export function followTerminalExit(
  home: TerminalHome | null,
  paneId: string,
  panes: { paneId: string; tabId?: string | null }[],
): TerminalExit {
  if (home !== "panel") return { kind: "retire-panel" };
  const mine = panes.find((pane) => pane.paneId === paneId);
  const tabId = mine?.tabId || "";
  if (!tabId) return { kind: "close-pane", paneId };
  const siblings = panes.filter((pane) => pane.tabId === tabId);
  if (siblings.length > 1) return { kind: "close-pane", paneId };
  return { kind: "close-tab", tabId };
}
