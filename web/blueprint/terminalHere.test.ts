import { describe, expect, it } from "vitest";
import { cdCommand, terminalHereCwd } from "../src/terminalHere";
import type { PanelConfig } from "../src/types";

describe("terminal here", () => {
  it("uses the parent folder of a file address", () => {
    const note: PanelConfig = { type: "markdown", path: "C:/work/notes/welcome.md" };
    expect(terminalHereCwd(note)).toBe("C:/work/notes");
  });

  it("uses the folder itself when Files is on a directory", () => {
    const folder: PanelConfig = { type: "explorer", path: "C:/work/notes" };
    expect(terminalHereCwd(folder)).toBe("C:/work/notes");
  });

  it("uses the parent when Files still focuses a file", () => {
    const focused: PanelConfig = {
      type: "explorer",
      path: "C:/work/notes",
      focus: "C:/work/notes/welcome.md",
    };
    expect(terminalHereCwd(focused)).toBe("C:/work/notes");
  });

  it("returns null when there is no filesystem address", () => {
    expect(terminalHereCwd({ type: "iframe", url: "https://example.com", proxy: false })).toBeNull();
    expect(terminalHereCwd({ type: "blank" })).toBeNull();
    expect(terminalHereCwd({ type: "herdr", paneId: "w1:p1" })).toBeNull();
  });

  it("builds a quoted cd command for Windows and Unix paths", () => {
    expect(cdCommand("C:\\work\\notes")).toBe('cd "C:\\work\\notes"');
    expect(cdCommand("/home/me/notes")).toBe("cd '/home/me/notes'");
  });
});

