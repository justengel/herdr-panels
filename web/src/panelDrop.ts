import type { PanelPlace } from "./layoutEdit";

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type DropPlace = PanelPlace | "bar";

export function placeAt(rect: Box, x: number, y: number): PanelPlace {
  const px = rect.width <= 0 ? 0.5 : (x - rect.left) / rect.width;
  const py = rect.height <= 0 ? 0.5 : (y - rect.top) / rect.height;
  const edge = 0.32;
  const dx = Math.min(px, 1 - px);
  const dy = Math.min(py, 1 - py);
  if (dx <= edge && dx <= dy) return px < 0.5 ? "left" : "right";
  if (dy <= edge && dy < dx) return py < 0.5 ? "above" : "below";
  return "center";
}

function contains(rect: Box, x: number, y: number): boolean {
  return x >= rect.left && x < rect.left + rect.width && y >= rect.top && y < rect.top + rect.height;
}

/** The panel bar wins over the edge zones underneath it. */
export function dropPlace(rect: Box, x: number, y: number, bar: Box | null): DropPlace {
  if (bar && contains(bar, x, y)) return "bar";
  return placeAt(rect, x, y);
}
