import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { findChord, terminalHits, textMatches, wrappedIndex } from "../src/findText";

function press(
  key: string,
  mods: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {},
) {
  return {
    key,
    ctrlKey: mods.ctrl ?? false,
    metaKey: mods.meta ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
  };
}

describe("find", () => {
  it("opens on ctrl+f and cmd+f, and steps with F3", () => {
    expect(findChord(press("f", { ctrl: true }))).toBe("open");
    expect(findChord(press("F", { meta: true }))).toBe("open");
    expect(findChord(press("f", { ctrl: true, shift: true }))).toBeNull();
    expect(findChord(press("f", { ctrl: true, alt: true }))).toBeNull();
    expect(findChord(press("f"))).toBeNull();
    expect(findChord(press("F3"))).toBe("next");
    expect(findChord(press("F3", { shift: true }))).toBe("prev");
    expect(findChord(press("F3", { ctrl: true }))).toBeNull();
  });

  it("finds case-insensitive matches without overlapping itself", () => {
    expect(textMatches("Alpha beta ALPHA", "alpha", false)).toEqual([
      { start: 0, end: 5 },
      { start: 11, end: 16 },
    ]);
    expect(textMatches("Alpha beta ALPHA", "alpha", true)).toEqual([]);
    expect(textMatches("Alpha beta ALPHA", "Alpha", true)).toEqual([{ start: 0, end: 5 }]);
    expect(textMatches("aaa", "aa", false)).toEqual([{ start: 0, end: 2 }]);
    expect(textMatches("hello", "", false)).toEqual([]);
    expect(textMatches("a.b", ".", false)).toEqual([{ start: 1, end: 2 }]);
  });

  it("wraps the current match", () => {
    expect(wrappedIndex(0, 0, 1)).toBe(-1);
    expect(wrappedIndex(4, -1, 1)).toBe(0);
    expect(wrappedIndex(4, -1, -1)).toBe(3);
    expect(wrappedIndex(4, 3, 1)).toBe(0);
    expect(wrappedIndex(4, 0, -1)).toBe(3);
  });

  it("searches each terminal line", () => {
    expect(terminalHits(["prompt", "echo hello", "hello again"], "hello", false)).toEqual([
      { line: 1, column: 5, length: 5 },
      { line: 2, column: 0, length: 5 },
    ]);
    expect(terminalHits(["Hello"], "hello", true)).toEqual([]);
  });
});

describe("frame find", () => {
  const source = readFileSync(new URL("../../assets/frame-find.js", import.meta.url), "utf8");

  function load() {
    const sandbox = createContext({}) as {
      hwpTextMatches?: (text: string, query: string, matchCase: boolean) => { start: number; end: number }[];
      hwpFindChord?: (event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }) => string | null;
    };
    runInContext(source, sandbox);
    return sandbox;
  }

  it("uses the same match and chord rules inside a frame", () => {
    const sandbox = load();
    expect(sandbox.hwpTextMatches?.("Alpha beta", "alpha", false)).toEqual([{ start: 0, end: 5 }]);
    expect(sandbox.hwpTextMatches?.("a.b", ".", false)).toEqual([{ start: 1, end: 2 }]);
    expect(sandbox.hwpFindChord?.({ key: "f", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe("open");
    expect(sandbox.hwpFindChord?.({ key: "F3", ctrlKey: false, metaKey: false, altKey: false, shiftKey: true })).toBe("prev");
    expect(sandbox.hwpFindChord?.({ key: "f", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })).toBeNull();
  });
});
