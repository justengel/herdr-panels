import { sameSpaceOrder } from "./spaceDrag";

/**
 * Index Herdr's `tab.move` expects.
 * `beforeId` is the tab the dragged tab should sit in front of. Null means the end of the strip.
 * A drop that would not change the order returns null.
 */
export function tabInsertIndex(ids: string[], draggedId: string, beforeId: string | null): number | null {
  if (!ids.includes(draggedId)) return null;
  if (sameSpaceOrder(ids, draggedId, beforeId)) return null;
  if (beforeId == null) return ids.length;
  const at = ids.indexOf(beforeId);
  return at < 0 ? null : at;
}
