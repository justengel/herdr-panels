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

/** Cells of a mouse selection. `column` is 0-based and may sit on a row outside the viewport. */
export interface GridCell {
  column: number;
  row: number;
}

function caretAt(index: number, cols: number): Caret {
  const y = Math.floor(index / cols);
  return { x: index - y * cols, y };
}

function selectionIndex(selection: BufferSelection, cols: number): { from: number; to: number } {
  const width = columnCount(cols);
  const start = selection.start.y * width + selection.start.x;
  const end = selection.end.y * width + selection.end.x;
  return { from: Math.min(start, end), to: Math.max(start, end) };
}

/** Inclusive cells from the pointer, in buffer order. The same cell is a one-cell selection. */
export function caretSelection(anchor: GridCell, head: GridCell, cols: number): BufferSelection {
  const width = columnCount(cols);
  const start = anchor.row * width + anchor.column;
  const end = head.row * width + head.column;
  const from = Math.min(start, end);
  const to = Math.max(start, end) + 1;
  return { start: caretAt(from, width), end: caretAt(to, width) };
}

/**
 * The on-screen part of a selection. A start above the screen begins at the
 * first cell, and an end below it runs through the last cell. Null when the
 * whole highlight is off screen.
 */
export function visibleSelection(selection: BufferSelection, cols: number, rowCount: number): BufferSelection | null {
  const width = columnCount(cols);
  const rows = Math.max(1, Math.floor(rowCount) || 1);
  const { from, to } = selectionIndex(selection, width);
  const viewEnd = rows * width;
  if (to <= 0 || from >= viewEnd) return null;
  const start = Math.max(from, 0);
  const end = Math.min(to, viewEnd);
  if (end <= start) return null;
  return { start: caretAt(start, width), end: caretAt(end, width) };
}

/** Rows of a selection, including rows the viewport no longer shows. */
export function collectSelectionLines(
  selection: BufferSelection,
  cols: number,
  rowAt: (row: number, fromCol: number, toCol: number) => { text: string; wrapped: boolean } | null,
): SelectionLine[] {
  const width = columnCount(cols);
  const { from, to } = selectionIndex(selection, width);
  if (to <= from) return [];
  const y0 = Math.floor(from / width);
  const y1 = Math.floor((to - 1) / width);
  const rows: SelectionLine[] = [];
  for (let y = y0; y <= y1; y += 1) {
    const fromCol = y === y0 ? from - y * width : 0;
    const toCol = y === y1 ? to - y * width : width;
    const line = rowAt(y, fromCol, toCol);
    rows.push({
      text: line?.text ?? "",
      wrapped: y !== y0 && Boolean(line?.wrapped),
      trimEnd: toCol >= width,
    });
  }
  return rows;
}

const WORD = /[\w./:@%+=~-]/;

/** The word under a double-click, inclusive of both ends. */
export function wordCells(line: string, column: number, row: number, cols: number): { anchor: GridCell; head: GridCell } {
  const width = columnCount(cols);
  const chars = Array.from(line);
  const at = chars.length === 0 ? -1 : Math.max(0, Math.min(column, chars.length - 1));
  if (at < 0 || !WORD.test(chars[at] ?? "")) {
    const only = Math.max(0, Math.min(width - 1, column));
    return { anchor: { column: only, row }, head: { column: only, row } };
  }
  let start = at;
  let end = at;
  while (start > 0 && WORD.test(chars[start - 1] ?? "")) start -= 1;
  while (end + 1 < chars.length && WORD.test(chars[end + 1] ?? "")) end += 1;
  return {
    anchor: { column: start, row },
    head: { column: Math.min(width - 1, end), row },
  };
}

/** Move a highlight by whole rows. Ends may sit outside the viewport. */
export function shiftSelection(selection: BufferSelection, rows: number): BufferSelection {
  return {
    start: { x: selection.start.x, y: selection.start.y + rows },
    end: { x: selection.end.x, y: selection.end.y + rows },
  };
}

/**
 * True when the visible rows a highlight covers still have the same text.
 * Rows that have scrolled off screen are not a reason to drop the highlight.
 */
export function selectionLinesUnchanged(before: string[], after: string[], selection: BufferSelection): boolean {
  const y0 = Math.min(selection.start.y, selection.end.y);
  let y1 = Math.max(selection.start.y, selection.end.y);
  const end = selection.start.y > selection.end.y ? selection.start : selection.end;
  if (end.x === 0) y1 -= 1;
  if (y1 < y0) return true;
  for (let y = y0; y <= y1; y += 1) {
    if (y < 0 || y >= before.length || y >= after.length) continue;
    if (before[y] !== after[y]) return false;
  }
  return true;
}
