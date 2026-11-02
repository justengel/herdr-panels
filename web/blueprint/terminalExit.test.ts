import { describe, expect, it } from "vitest";
import { followTerminalExit } from "../src/terminalExit";

const general = { paneId: "p3", tabId: "general" };
const extra = { paneId: "p9", tabId: "general" };
const other = { paneId: "p4", tabId: "notes" };

describe("a shell that exits", () => {
  it("closes the pane tab when the exit was typed in the terminal panel", () => {
    expect(followTerminalExit("panel", "p3", [general, other])).toEqual({
      kind: "close-tab",
      tabId: "general",
    });
  });

  it("closes only that pane when its tab still has another pane", () => {
    expect(followTerminalExit("panel", "p3", [general, extra])).toEqual({
      kind: "close-pane",
      paneId: "p3",
    });
  });

  it("leaves the tab and retires the terminal panel when the exit was typed in panes", () => {
    expect(followTerminalExit("panes", "p3", [general, other])).toEqual({ kind: "retire-panel" });
  });

  it("does not close a tab when the exit was not typed in the terminal panel", () => {
    expect(followTerminalExit(null, "p3", [general])).toEqual({ kind: "retire-panel" });
  });
});
