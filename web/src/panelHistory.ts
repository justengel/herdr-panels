import type { ClosedPanel } from "./layoutEdit";

/** Closed panels kept in this window. A restart starts over. */
export const PANEL_HISTORY_LIMIT = 30;

export function pushClosedPanel(stack: ClosedPanel[], item: ClosedPanel): ClosedPanel[] {
  return [...stack, item].slice(-PANEL_HISTORY_LIMIT);
}

/** Drop closed panels that are already back, then return the newest one still missing. */
export function takeClosedPanel(
  stack: ClosedPanel[],
  openIds: ReadonlySet<string>,
): { stack: ClosedPanel[]; closed: ClosedPanel | null } {
  const next = stack.slice();
  while (next.length > 0) {
    const closed = next.pop();
    if (closed && !openIds.has(closed.panel.id)) return { stack: next, closed };
  }
  return { stack: next, closed: null };
}
