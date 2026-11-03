import { describe, expect, it } from "vitest";
import { clipboardAction, terminalPlatform } from "../src/terminalEdit";

const press = (key: string, mods: Partial<Record<"ctrlKey" | "shiftKey" | "altKey" | "metaKey", boolean>> = {}) => ({
  key,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("terminal platform", () => {
  it("tells the three platforms apart from the user agent", () => {
    expect(terminalPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(terminalPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe("mac");
    expect(terminalPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
  });
});

describe("terminal clipboard keys", () => {
  it("keeps Ctrl+C as interrupt on Linux and copies with Ctrl+Shift+C or Ctrl+Insert", () => {
    expect(clipboardAction(press("c", { ctrlKey: true }), "linux")).toBeNull();
    expect(clipboardAction(press("C", { ctrlKey: true, shiftKey: true }), "linux")).toBe("copy");
    expect(clipboardAction(press("Insert", { ctrlKey: true }), "linux")).toBe("copy");
  });

  it("pastes with Ctrl+Shift+V or Shift+Insert on Linux, and leaves Ctrl+V for the shell", () => {
    expect(clipboardAction(press("V", { ctrlKey: true, shiftKey: true }), "linux")).toBe("paste");
    expect(clipboardAction(press("Insert", { shiftKey: true }), "linux")).toBe("paste");
    expect(clipboardAction(press("v", { ctrlKey: true }), "linux")).toBeNull();
  });

  it("uses Command on macOS and leaves Control for the shell", () => {
    expect(clipboardAction(press("c", { metaKey: true }), "mac")).toBe("copy");
    expect(clipboardAction(press("v", { metaKey: true }), "mac")).toBe("paste");
    expect(clipboardAction(press("c", { ctrlKey: true }), "mac")).toBeNull();
    expect(clipboardAction(press("v", { ctrlKey: true }), "mac")).toBeNull();
  });

  it("keeps the Windows chords, including Ctrl+Shift+V", () => {
    expect(clipboardAction(press("c", { ctrlKey: true }), "windows")).toBe("copy");
    expect(clipboardAction(press("C", { ctrlKey: true, shiftKey: true }), "windows")).toBe("copy");
    expect(clipboardAction(press("v", { ctrlKey: true }), "windows")).toBe("paste");
    expect(clipboardAction(press("V", { ctrlKey: true, shiftKey: true }), "windows")).toBe("paste");
    expect(clipboardAction(press("Insert", { shiftKey: true }), "windows")).toBe("paste");
  });

  it("ignores any chord with Alt", () => {
    expect(clipboardAction(press("c", { ctrlKey: true, shiftKey: true, altKey: true }), "linux")).toBeNull();
  });
});
