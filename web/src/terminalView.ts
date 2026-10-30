export interface ScrollGesture {
  direction: "up" | "down";
  lines: number;
  source: "wheel" | "page_key";
}

/**
 * The grid to draw. The panel's fitted size wins, so the program wraps to the
 * pane after it is expanded, restored, or the window scale changes.
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

export interface CellSize {
  w: number;
  h: number;
}

/**
 * Columns and rows for a measured character cell. Null until that measurement
 * exists, so the first paint is not locked to a stand-in size.
 */
export function fittedGrid(
  hostW: number,
  hostH: number,
  cell: CellSize | null,
): { cols: number; rows: number } | null {
  if (!cell || cell.w < 1 || cell.h < 1 || hostW < 8 || hostH < 8) return null;
  const cols = Math.floor(hostW / cell.w);
  const rows = Math.floor(hostH / cell.h);
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
  return {
    cols: Math.max(2, Math.min(500, cols)),
    rows: Math.max(1, Math.min(200, rows)),
  };
}

export interface StreamFrame {
  text: string;
  full: boolean;
  cols?: number | null;
  rows?: number | null;
}

function sameGrid(frame: StreamFrame, cols: number, rows: number): boolean {
  if (frame.cols == null || frame.rows == null) return true;
  return frame.cols === cols && frame.rows === rows;
}

/**
 * The first screen to draw once the pane size has settled. Partials that
 * arrived before the matching full screen, and frames for another size, are
 * left out.
 */
export function openingScreen(frames: StreamFrame[], cols: number, rows: number): StreamFrame[] {
  const matched = screenFrom(frames.filter((frame) => sameGrid(frame, cols, rows)));
  if (matched.length > 0) return matched;
  return screenFrom(frames);
}

/** A full frame and the partials that follow it at that same size. */
function screenFrom(frames: StreamFrame[]): StreamFrame[] {
  let lastFull = -1;
  for (let index = 0; index < frames.length; index += 1) {
    if (frames[index].full) lastFull = index;
  }
  if (lastFull < 0) return [];
  const anchor = frames[lastFull];
  const tail = [anchor];
  for (let index = lastFull + 1; index < frames.length; index += 1) {
    if (sameGrid(frames[index], anchor.cols ?? 0, anchor.rows ?? 0) || (anchor.cols == null && anchor.rows == null)) {
      tail.push(frames[index]);
    }
  }
  return tail;
}

/**
 * A partial frame cannot rebuild a screen that was reflowed by a resize.
 * Hold those frames until a full screen for this grid arrives.
 */
export function frameDraw(
  waitingForFull: boolean,
  frame: StreamFrame,
  drawn: string,
  grid: { cols: number; rows: number } | null,
): { waitingForFull: boolean; draw: boolean; reset: boolean; drawn: string } {
  if (grid && !sameGrid(frame, grid.cols, grid.rows)) {
    return { waitingForFull, draw: false, reset: false, drawn };
  }
  if (waitingForFull && !frame.full) {
    return { waitingForFull: true, draw: false, reset: false, drawn };
  }
  if (!waitingForFull && frame.text === drawn) {
    return { waitingForFull: false, draw: false, reset: false, drawn };
  }
  return {
    waitingForFull: false,
    draw: true,
    reset: frame.full,
    drawn: frame.text,
  };
}

export interface FollowDecision {
  waitingForFull: boolean;
  draw: boolean;
  reset: boolean;
  drawn: string;
  grid: { cols: number; rows: number } | null;
}

/**
 * Keep the picture moving when another viewer owns the pane size.
 * Partials for the grid on screen are drawn. A full frame at any size
 * replaces the screen. Partials for a size not on screen wait.
 */
export function frameFollow(
  waitingForFull: boolean,
  frame: StreamFrame,
  drawn: string,
  fitted: { cols: number; rows: number } | null,
  showing: { cols: number; rows: number } | null,
): FollowDecision {
  const reported = frame.cols != null && frame.rows != null ? { cols: frame.cols, rows: frame.rows } : null;
  if (showing && reported && reported.cols === showing.cols && reported.rows === showing.rows) {
    const decision = frameDraw(false, frame, drawn, showing);
    return { ...decision, grid: showing };
  }
  if (frame.full && reported) {
    const switched = !showing || reported.cols !== showing.cols || reported.rows !== showing.rows;
    const draw = switched || frame.text !== drawn;
    return { waitingForFull: false, draw, reset: draw, drawn: frame.text, grid: reported };
  }
  if (fitted && reported && reported.cols === fitted.cols && reported.rows === fitted.rows) {
    const decision = frameDraw(true, frame, drawn, fitted);
    return { ...decision, grid: showing };
  }
  if (!reported) {
    const decision = frameDraw(waitingForFull, frame, drawn, showing ?? fitted);
    return { ...decision, grid: showing };
  }
  return { waitingForFull, draw: false, reset: false, drawn, grid: showing };
}

/** Uniform scale that keeps a grid inside the panel without enlarging it. */
export function fitScale(shellW: number, shellH: number, gridW: number, gridH: number): number {
  if (shellW < 1 || shellH < 1 || gridW < 1 || gridH < 1) return 1;
  return Math.min(1, shellW / gridW, shellH / gridH);
}

export interface PointerCell {
  column: number;
  row: number;
  edge: "up" | "down" | null;
}

function clampIndex(value: number, max: number): number {
  return Math.max(0, Math.min(max, value));
}

/** The cell under the pointer. A drag in the edge band asks the pane to scroll. */
export function pointerCell(
  localX: number,
  localY: number,
  width: number,
  height: number,
  cols: number,
  rows: number,
): PointerCell | null {
  if (width < 1 || height < 1 || cols < 1 || rows < 1) return null;
  const column = clampIndex(Math.floor((localX / width) * cols), cols - 1);
  const row = clampIndex(Math.floor((localY / height) * rows), rows - 1);
  const band = Math.max(4, Math.min(10, (height / rows) * 0.45));
  let edge: "up" | "down" | null = null;
  if (localY >= height - band) edge = "down";
  else if (localY <= band) edge = "up";
  return { column, row, edge };
}

/** One mouse notch is about 100 pixels and moves three lines, matching a typical terminal. */
export function wheelScroll(deltaY: number, deltaMode: number): ScrollGesture | null {
  if (!Number.isFinite(deltaY) || deltaY === 0) return null;
  const magnitude = Math.abs(deltaY);
  const pixels = deltaMode === 1 ? magnitude * 16 : deltaMode === 2 ? magnitude * 400 : magnitude;
  const lines = Math.max(1, Math.min(40, Math.round((pixels / 100) * 3) || 1));
  return { direction: deltaY < 0 ? "up" : "down", lines, source: "wheel" };
}

/**
 * Lines to move down so typing happens on the live screen. Zero when the view
 * is already there. A short distance still jumps a full page, because the
 * tracked distance can be short of the real one.
 */
export function inputScroll(place: ScrollPlace): number {
  const above = Math.max(0, Math.round(place.fromEnd) || 0);
  if (above <= 0) return 0;
  return Math.max(above, 200);
}

export function pageScroll(key: string, rows: number): ScrollGesture | null {
  if (key !== "PageUp" && key !== "PageDown") return null;
  const lines = Math.max(1, Math.min(200, Math.floor(rows) || 1));
  return { direction: key === "PageUp" ? "up" : "down", lines, source: "page_key" };
}

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

function blankLine(line: string): boolean {
  return line.trim().length === 0;
}

/**
 * How many rows the visible text moved down. Positive means older lines
 * entered at the top. Null when the screen was edited in place.
 */
export function viewportShift(before: string[], after: string[]): number | null {
  const rows = Math.max(before.length, after.length);
  if (rows < 2) return null;
  const score = (shift: number) => {
    let matched = 0;
    for (let i = 0; i < before.length; i += 1) {
      const j = i + shift;
      if (j < 0 || j >= after.length) continue;
      if (blankLine(before[i]) || blankLine(after[j])) continue;
      if (before[i] === after[j]) matched += 1;
    }
    return matched;
  };
  let best = 0;
  let bestScore = score(0);
  for (let distance = 1; distance < rows; distance += 1) {
    for (const shift of [distance, -distance]) {
      const matched = score(shift);
      if (matched > bestScore) {
        bestScore = matched;
        best = shift;
      }
    }
  }
  if (best === 0 || bestScore < 2) return null;
  return best;
}

/**
 * The thumb to draw. A known range uses the pane's distance. Before that
 * range is known, a short thumb sits at the live end so the bar can be dragged.
 */
export function scrollThumb(
  track: number,
  rows: number,
  fromEnd: number,
  extent: number,
): { top: number; height: number } {
  if (track < 1) return { top: 0, height: 0 };
  if (extent <= 0) {
    const height = Math.min(28, track);
    return { top: Math.max(0, track - height), height };
  }
  return scrollMetrics(track, rows, fromEnd, extent);
}

/**
 * Lines above the live screen that a thumb drag is asking for.
 * A known range maps the thumb across that range. An unknown range moves
 * one line per cell, and Herdr's next frame is what proves the distance.
 */
export function scrollDragTarget(
  extent: number,
  fromEnd: number,
  dy: number,
  cell: number,
  track: number,
  thumbTop: number,
  thumbHeight: number,
): number {
  if (extent <= 0) {
    const lines = Math.round(Math.abs(dy) / Math.max(1, cell));
    return dy < 0 ? fromEnd + lines : Math.max(0, fromEnd - lines);
  }
  return scrollFromThumb(track, thumbHeight, thumbTop + dy, extent);
}

/** Convert a thumb top back into lines above the live end. */
export function scrollFromThumb(track: number, height: number, top: number, extent: number): number {
  if (extent <= 0) return 0;
  const travel = Math.max(1, track - height);
  const clamped = Math.max(0, Math.min(travel, top));
  return Math.round(extent * (1 - clamped / travel));
}
