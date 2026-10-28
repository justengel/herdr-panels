/** One space row, measured from the top of the viewport. */
export interface SpaceDragRow {
  id: string;
  top: number;
  bottom: number;
}

/** The space the dragged row should land before, or null to land at the end. */
export function dropBeforeId(rows: SpaceDragRow[], y: number, draggedId: string): string | null {
  for (const row of rows) {
    if (row.id === draggedId) continue;
    const mid = (row.top + row.bottom) / 2;
    if (y < mid) return row.id;
  }
  return null;
}

/** List order after moving one space before another, or to the end when `beforeId` is null. */
export function movedSpaceOrder(ids: string[], draggedId: string, beforeId: string | null): string[] {
  if (!ids.includes(draggedId)) return ids;
  const without = ids.filter((id) => id !== draggedId);
  if (beforeId == null) return [...without, draggedId];
  const at = without.indexOf(beforeId);
  if (at < 0) return ids;
  return [...without.slice(0, at), draggedId, ...without.slice(at)];
}

export function sameSpaceOrder(ids: string[], draggedId: string, beforeId: string | null): boolean {
  const next = movedSpaceOrder(ids, draggedId, beforeId);
  return next.length === ids.length && next.every((id, index) => id === ids[index]);
}
