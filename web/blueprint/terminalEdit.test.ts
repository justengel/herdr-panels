import { describe, expect, it } from "vitest";
import {
  caretSelection,
  collectSelectionLines,
  extendSelection,
  joinTerminalSelection,
  keysToRemoveSelection,
  plainClipboardText,
  selectionLinesUnchanged,
  shiftSelection,
  terminalSelectionHtml,
  visibleSelection,
  wordCells,
  type BufferSelection,
  type Caret,
} from "../src/terminalEdit";

const cursor: Caret = { x: 10, y: 3 };

function selection(startX: number, endX: number, y = 3): BufferSelection {
  return { start: { x: startX, y }, end: { x: endX, y } };
}

describe("terminal selection editing", () => {
  it("extends a shift selection from the cursor without moving the other end", () => {
    const first = extendSelection(80, cursor, null, null, "ArrowLeft", 20);
    expect(first.anchor).toEqual(cursor);
    expect(first.head).toEqual({ x: 9, y: 3 });
    expect(first.span).toEqual({ column: 9, row: 3, length: 1 });
    const second = extendSelection(80, cursor, first.anchor, first.head, "ArrowLeft", 20);
    expect(second.span).toEqual({ column: 8, row: 3, length: 2 });
    const home = extendSelection(80, cursor, null, null, "Home", 20);
    expect(home.span).toEqual({ column: 0, row: 3, length: 10 });
    const end = extendSelection(80, cursor, null, null, "End", 20);
    expect(end.span).toEqual({ column: 10, row: 3, length: 70 });
  });

  it("removes a highlight on the cursor line and leaves a highlight on another line", () => {
    expect(keysToRemoveSelection(cursor, selection(4, 8))).toEqual([
      "ArrowLeft",
      "ArrowLeft",
      "Backspace",
      "Backspace",
      "Backspace",
      "Backspace",
    ]);
    expect(keysToRemoveSelection({ x: 4, y: 3 }, selection(4, 8))).toEqual(["Delete", "Delete", "Delete", "Delete"]);
    expect(keysToRemoveSelection({ x: 6, y: 3 }, selection(4, 8))).toEqual([
      "ArrowRight",
      "ArrowRight",
      "Backspace",
      "Backspace",
      "Backspace",
      "Backspace",
    ]);
    expect(keysToRemoveSelection(cursor, selection(4, 8, 1))).toBeNull();
    expect(keysToRemoveSelection(cursor, { start: { x: 0, y: 3 }, end: { x: 4, y: 4 } })).toBeNull();
  });
});

describe("terminal copy", () => {
  it("keeps spaces inside a line and a newline between lines", () => {
    const text = joinTerminalSelection([
      { text: "name    size", wrapped: false, trimEnd: true },
      { text: "foo     12   ", wrapped: false, trimEnd: true },
    ]);
    expect(text).toBe("name    size\nfoo     12");
  });

  it("keeps leading spaces and joins a wrapped row without a newline", () => {
    const text = joinTerminalSelection([
      { text: "    echo hello", wrapped: false },
      { text: "    world   ", wrapped: true, trimEnd: true },
    ]);
    expect(text).toBe("    echo hello    world");
  });

  it("keeps spaces the selection stopped inside", () => {
    expect(joinTerminalSelection([{ text: "hello   ", wrapped: false }])).toBe("hello   ");
  });

  it("puts the same text in a preformatted HTML block", () => {
    const html = terminalSelectionHtml("a  <b>\n  c & d");
    expect(html).toContain("<pre");
    expect(html).toContain("white-space:pre");
    expect(html).toContain("a  &lt;b&gt;\n  c &amp; d");
  });

  it("uses Windows line breaks only in the plain-text clipboard value", () => {
    expect(plainClipboardText("a\nb", true)).toBe("a\r\nb");
    expect(plainClipboardText("a\r\nb", true)).toBe("a\r\nb");
    expect(plainClipboardText("a\nb", false)).toBe("a\nb");
  });
});

describe("terminal selection follow", () => {
  const held: BufferSelection = { start: { x: 1, y: 2 }, end: { x: 4, y: 3 } };

  it("moves a highlight with the rows and keeps the part that leaves the screen", () => {
    expect(shiftSelection(held, 2)).toEqual({ start: { x: 1, y: 4 }, end: { x: 4, y: 5 } });
    expect(shiftSelection(held, -3)).toEqual({ start: { x: 1, y: -1 }, end: { x: 4, y: 0 } });
    expect(shiftSelection(held, 8)).toEqual({ start: { x: 1, y: 10 }, end: { x: 4, y: 11 } });
  });

  it("paints the on-screen part when a scrolled selection hangs off the top or bottom", () => {
    expect(visibleSelection(shiftSelection(held, -3), 80, 10)).toEqual({
      start: { x: 0, y: 0 },
      end: { x: 4, y: 0 },
    });
    const below: BufferSelection = { start: { x: 2, y: 8 }, end: { x: 1, y: 12 } };
    expect(visibleSelection(below, 10, 10)).toEqual({
      start: { x: 2, y: 8 },
      end: { x: 0, y: 10 },
    });
    expect(visibleSelection({ start: { x: 0, y: -4 }, end: { x: 0, y: -1 } }, 10, 10)).toBeNull();
  });

  it("copies the lines that scrolled off along with the lines still on screen", () => {
    const selection: BufferSelection = { start: { x: 1, y: -1 }, end: { x: 4, y: 0 } };
    const lines = collectSelectionLines(selection, 10, (row, from, to) => {
      const text = row === -1 ? "abcdefghij" : "0123456789";
      return { text: text.slice(from, to), wrapped: false };
    });
    expect(joinTerminalSelection(lines)).toBe("bcdefghij\n0123");
  });

  it("selects every cell from the anchor through the cell under the pointer", () => {
    expect(caretSelection({ column: 2, row: 1 }, { column: 5, row: 1 }, 10)).toEqual({
      start: { x: 2, y: 1 },
      end: { x: 6, y: 1 },
    });
    expect(caretSelection({ column: 5, row: 4 }, { column: 1, row: 2 }, 10)).toEqual({
      start: { x: 1, y: 2 },
      end: { x: 6, y: 4 },
    });
    expect(caretSelection({ column: 3, row: -2 }, { column: 4, row: 1 }, 80)).toEqual({
      start: { x: 3, y: -2 },
      end: { x: 5, y: 1 },
    });
  });

  it("selects the word under a double click", () => {
    expect(wordCells("echo hello-world next", 8, 3, 80)).toEqual({
      anchor: { column: 5, row: 3 },
      head: { column: 15, row: 3 },
    });
  });

  it("keeps a highlight when the selected rows are the same text", () => {
    const lines = ["prompt", "name    size", "foo     12", "next"];
    expect(selectionLinesUnchanged(lines, ["other", "name    size", "foo     12", "next"], held)).toBe(true);
    expect(selectionLinesUnchanged(lines, ["prompt", "name    size", "foo     99", "next"], held)).toBe(false);
    const hanging: BufferSelection = { start: { x: 1, y: -2 }, end: { x: 4, y: 1 } };
    expect(selectionLinesUnchanged(lines, lines, hanging)).toBe(true);
    expect(selectionLinesUnchanged(lines, ["prompt", "changed", "foo     12", "next"], hanging)).toBe(false);
  });
});
