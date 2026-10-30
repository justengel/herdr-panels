import { describe, expect, it } from "vitest";
import { addedPane, terminalPlacement } from "../src/openTerminal";
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

  it("gives Add panel → Terminal its own shell instead of splitting the space", () => {
    const blank: PanelConfig = { type: "blank" };
    const space: PanelConfig = { type: "herdr", paneId: "w1:p1" };
    const side: PanelConfig = { type: "herdr", paneId: "w1:p9", scope: "pane" };
    expect(terminalPlacement("terminal", blank)).toBe("shell");
    expect(terminalPlacement("terminal", space)).toBe("shell");
    expect(terminalPlacement("pane:new", space)).toBe("shell");
    expect(terminalPlacement("pane:new", side)).toBe("shell");
  });

  it("picks the pane a new tab added in this space", () => {
    expect(
      addedPane(
        ["w1:p1"],
        [
          { paneId: "w1:p1", workspaceId: "w1" },
          { paneId: "w2:p1", workspaceId: "w2" },
          { paneId: "w1:p2", workspaceId: "w1" },
        ],
        "w1",
      ),
    ).toBe("w1:p2");
  });

  it("builds a quoted cd command for Windows and Unix paths", () => {
    expect(cdCommand("C:\\work\\notes")).toBe('cd "C:\\work\\notes"');
    expect(cdCommand("/home/me/notes")).toBe("cd '/home/me/notes'");
  });
});

