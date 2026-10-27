export interface ScrollGesture {
  direction: "up" | "down";
  lines: number;
  source: "wheel" | "page_key";
}

/**
 * The grid to draw. The panel's fitted size wins, so the program wraps to the
 * pane after it is expanded, restored, or the window scale changes. Adopting a
 * larger frame leaves the input drawn under the scrollbar.
 */
export function viewBox(
  fitted: { cols: number; rows: number } | null,
  frameCols: number,
  frameRows: number,
): { cols: number; rows: number } | null {
  void frameCols;
  void frameRows;
  if (!fitted) return null;
  return { cols: fitted.cols, rows: fitted.rows };
}

/** Uniform scale that keeps a grid inside the panel without enlarging it. */
export function fitScale(shellW: number, shellH: number, gridW: number, gridH: number): number {
  if (shellW < 1 || shellH < 1 || gridW < 1 || gridH < 1) return 1;
  return Math.min(1, shellW / gridW, shellH / gridH);
}

/** One mouse notch is about 100 pixels and moves three lines, matching a typical terminal. */
export function wheelScroll(deltaY: number, deltaMode: number): ScrollGesture | null {
  if (!Number.isFinite(deltaY) || deltaY === 0) return null;
  const magnitude = Math.abs(deltaY);
  const pixels = deltaMode === 1 ? magnitude * 16 : deltaMode === 2 ? magnitude * 400 : magnitude;
  const lines = Math.max(1, Math.min(40, Math.round((pixels / 100) * 3) || 1));
  return { direction: deltaY < 0 ? "up" : "down", lines, source: "wheel" };
}

export function pageScroll(key: string, rows: number): ScrollGesture | null {
  if (key !== "PageUp" && key !== "PageDown") return null;
  const lines = Math.max(1, Math.min(200, Math.floor(rows) || 1));
  return { direction: key === "PageUp" ? "up" : "down", lines, source: "page_key" };
}

/** Width of the scrollbar parked beside the cells, in CSS pixels. */
export const SCROLLBAR_PX = 14;

/** `fromEnd` is lines above the live screen. `extent` is how far up the pane can go. */
export interface ScrollPlace {
  fromEnd: number;
  extent: number;
}

/**
 * Move within the range already discovered. The thumb stays put at the top
 * until a later frame proves the pane can go further.
 */
export function previewScroll(place: ScrollPlace, direction: "up" | "down", lines: number): ScrollPlace {
  const step = Math.max(0, Math.round(lines) || 0);
  const fromEnd = Math.max(0, place.fromEnd);
  const extent = Math.max(fromEnd, place.extent);
  if (direction === "up") return { fromEnd: Math.min(extent, fromEnd + step), extent };
  return { fromEnd: Math.max(0, fromEnd - step), extent };
}

/**
 * A real scroll shifts several rows. A clock or cursor tick changes one or two
 * and must not be read as more history.
 */
export function screenMoved(before: string, after: string): boolean {
  if (before === after) return false;
  const left = before.split("\n");
  const right = after.split("\n");
  const rows = Math.max(left.length, right.length);
  if (rows === 0) return false;
  let changed = 0;
  for (let i = 0; i < rows; i += 1) {
    if ((left[i] ?? "") !== (right[i] ?? "")) changed += 1;
  }
  return changed >= 3;
}

/**
 * Apply one scroll after the visible screen answers. A scroll that does not
 * change the screen has hit the top or the live end, and that distance is the
 * whole range.
 */
export function applyScroll(
  place: ScrollPlace,
  direction: "up" | "down",
  lines: number,
  frameChanged: boolean,
): ScrollPlace {
  const step = Math.max(0, Math.round(lines) || 0);
  const fromEnd = Math.max(0, place.fromEnd);
  const extent = Math.max(fromEnd, place.extent);
  if (direction === "up") {
    if (!frameChanged) return { fromEnd, extent: fromEnd };
    const next = fromEnd + step;
    return { fromEnd: next, extent: Math.max(extent, next) };
  }
  if (!frameChanged) return { fromEnd: 0, extent };
  return { fromEnd: Math.max(0, fromEnd - step), extent };
}

/**
 * Thumb geometry. The thumb fills the track when there is nowhere to scroll.
 * Otherwise its height is the viewport's share of the viewport plus the range.
 */
export function scrollMetrics(
  track: number,
  rows: number,
  fromEnd: number,
  extent: number,
): { top: number; height: number } {
  if (track < 1) return { top: 0, height: 0 };
  const span = Math.max(1, rows);
  const above = Math.max(0, extent);
  const at = Math.max(0, Math.min(above, fromEnd));
  const total = span + above;
  const share = (span / total) * track;
  const height = above === 0 ? track : Math.min(track, Math.max(Math.min(24, track), share));
  const travel = Math.max(0, track - height);
  const top = above === 0 ? 0 : travel * (1 - at / above);
  return { top, height };
}

/** Convert a thumb top back into lines above the live end. */
export function scrollFromThumb(track: number, height: number, top: number, extent: number): number {
  if (extent <= 0) return 0;
  const travel = Math.max(1, track - height);
  const clamped = Math.max(0, Math.min(travel, top));
  return Math.round(extent * (1 - clamped / travel));
}
