/** A caret in the terminal buffer. Columns are 0-based and may sit just past the last cell. */
export interface Caret {
  x: number;
  y: number;
}

/**
 * A highlight from xterm. `start` is the first cell and `end` is the caret after
 * the last cell. xterm's published types say these are 1-based, but the values
 * `getSelectionPosition` returns are the 0-based buffer coordinates.
 */
export interface BufferSelection {
  start: Caret;
  end: Caret;
}

export interface SelectSpan {
  column: number;
  row: number;
  length: number;
}

const SELECT_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

export function isShiftSelectKey(key: string): boolean {
  return SELECT_KEYS.has(key);
}

function columnCount(cols: number): number {
  return Math.max(1, Math.floor(cols) || 1);
}

function clampRow(y: number, maxRow: number): number {
  if (maxRow < 0) return 0;
  return Math.max(0, Math.min(maxRow, y));
}

/** Move a caret one step. `cols` is the width of a row, and x === cols is the caret after that row. */
export function moveCaret(caret: Caret, cols: number, key: string, maxRow: number): Caret {
  const width = columnCount(cols);
  const y = clampRow(caret.y, maxRow);
  const x = Math.max(0, Math.min(width, caret.x));
  if (key === "Home") return { x: 0, y };
  if (key === "End") return { x: width, y };
  if (key === "ArrowUp") return { x, y: clampRow(y - 1, maxRow) };
  if (key === "ArrowDown") return { x, y: clampRow(y + 1, maxRow) };
  if (key === "ArrowLeft") {
    if (x > 0) return { x: x - 1, y };
    if (y <= 0) return { x: 0, y: 0 };
    return { x: width, y: y - 1 };
  }
  if (x < width) return { x: x + 1, y };
  if (y >= maxRow) return { x: width, y };
  return { x: 0, y: y + 1 };
}

function indexOf(caret: Caret, cols: number): number {
  return caret.y * columnCount(cols) + caret.x;
}

/** Cells between two carets, or null when the carets are in the same place. */
export function spanBetween(anchor: Caret, head: Caret, cols: number): SelectSpan | null {
  const width = columnCount(cols);
  const from = Math.min(indexOf(anchor, width), indexOf(head, width));
  const to = Math.max(indexOf(anchor, width), indexOf(head, width));
  if (to === from) return null;
  return { column: from % width, row: Math.floor(from / width), length: to - from };
}

/**
 * Shift plus an arrow, Home, or End grows the highlight from the caret where it
 * started. The shell cursor stays put; Backspace uses that cursor afterwards.
 */
export function extendSelection(
  cols: number,
  cursor: Caret,
  anchor: Caret | null,
  head: Caret | null,
  key: string,
  maxRow: number,
): { anchor: Caret; head: Caret; span: SelectSpan | null } {
  const start = anchor ?? cursor;
  const current = head ?? cursor;
  const next = moveCaret(current, cols, key, maxRow);
  return { anchor: start, head: next, span: spanBetween(start, next, cols) };
}

function sameLine(selection: BufferSelection): boolean {
  return selection.start.y === selection.end.y;
}

/**
 * Keys that remove a highlight on the cursor's line. Null means the highlight
 * is on another line, so it cannot be deleted from the shell input.
 * The names are the key values `map_key` already understands.
 */
export function keysToRemoveSelection(cursor: Caret, selection: BufferSelection): string[] | null {
  if (!sameLine(selection) || selection.start.y !== cursor.y) return null;
  const start = Math.min(selection.start.x, selection.end.x);
  const end = Math.max(selection.start.x, selection.end.x);
  const length = end - start;
  if (length <= 0) return null;
  if (cursor.x >= end) return [...repeat("ArrowLeft", cursor.x - end), ...repeat("Backspace", length)];
  if (cursor.x <= start) return [...repeat("ArrowRight", start - cursor.x), ...repeat("Delete", length)];
  return [...repeat("ArrowRight", end - cursor.x), ...repeat("Backspace", length)];
}

function repeat(key: string, count: number): string[] {
  return Array.from({ length: Math.max(0, count) }, () => key);
}

/** One physical row of a terminal selection. `wrapped` continues the previous row. */
export interface SelectionLine {
  text: string;
  wrapped: boolean;
  /** Drop the blank margin when this row is the end of a logical line. */
  trimEnd?: boolean;
}

/**
 * Plain text for a terminal selection. Spaces that separate words stay.
 * A wrapped row stays on the same line. The blank cells past the last glyph
 * on a full-width row are dropped.
 */
export function joinTerminalSelection(rows: SelectionLine[]): string {
  const logical: { text: string; trimEnd: boolean }[] = [];
  for (const row of rows) {
    const text = row.text.replace(/\u00a0/g, " ");
    if (row.wrapped && logical.length > 0) {
      const current = logical[logical.length - 1];
      current.text += text;
      current.trimEnd = Boolean(row.trimEnd);
    } else {
      logical.push({ text, trimEnd: Boolean(row.trimEnd) });
    }
  }
  return logical.map((line) => (line.trimEnd ? line.text.replace(/[ \t]+$/g, "") : line.text)).join("\n");
}

/** HTML clipboard body. A pre block keeps the spaces and line breaks a page would otherwise collapse. */
export function terminalSelectionHtml(text: string): string {
  const body = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<pre style="white-space:pre;font-family:monospace">${body}</pre>`;
}

/** Plain-text clipboard value. Windows paste wants CRLF; the HTML copy keeps LF. */
export function plainClipboardText(text: string, windows: boolean): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return windows ? normalized.replace(/\n/g, "\r\n") : normalized;
}

/**
 * Write both clipboard types. Rich paste targets use the HTML, and plain
 * editors use the text. Falls back to plain text when the rich write is refused.
 */
export async function writeTerminalClipboard(text: string, windows: boolean): Promise<void> {
  if (!text || typeof navigator === "undefined" || !navigator.clipboard) return;
  const plain = plainClipboardText(text, windows);
  const html = terminalSelectionHtml(text);
  try {
    if (navigator.clipboard.write && typeof ClipboardItem !== "undefined") {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([plain], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);
      return;
    }
  } catch {
    // The page refused the rich clipboard. Plain text still carries the breaks.
  }
  await navigator.clipboard.writeText(plain);
}

/** Move a viewport highlight by whole rows. Null when either end would leave the screen. */
export function shiftSelection(selection: BufferSelection, rows: number, rowCount: number): BufferSelection | null {
  const startY = selection.start.y + rows;
  const endY = selection.end.y + rows;
  const last = rowCount - 1;
  if (startY < 0 || endY < 0 || startY > last || endY > last) return null;
  return { start: { x: selection.start.x, y: startY }, end: { x: selection.end.x, y: endY } };
}

/** True when every viewport row the highlight covers still has the same text. */
export function selectionLinesUnchanged(before: string[], after: string[], selection: BufferSelection): boolean {
  const y0 = Math.min(selection.start.y, selection.end.y);
  const y1 = Math.max(selection.start.y, selection.end.y);
  if (y0 < 0) return false;
  for (let y = y0; y <= y1; y += 1) {
    if (y >= before.length || y >= after.length) return false;
    if (before[y] !== after[y]) return false;
  }
  return true;
}
