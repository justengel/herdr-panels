import { describe, expect, it } from "vitest";
import { menuFor, showViewer } from "../src/viewMenu";
import type { PanelConfig } from "../src/types";

const terminal: PanelConfig = { type: "herdr", paneId: "w1:p1" };
const note: PanelConfig = { type: "markdown", path: "notes/welcome.md" };
const panes = [
  { paneId: "w1:p1", label: "herdr-panels", cwd: "C:/work/herdr-panels" },
  { paneId: "w1:p2", label: "notes", cwd: "C:/work/notes" },
];

describe("terminal desk menu", () => {
  it("puts panes in a Panes flyout under Desk", () => {
    const menu = menuFor(terminal, [], { panes });
    expect(menu.filter((entry) => entry.section === "desk").map((entry) => entry.id)).toEqual([
      "panes",
      "spaces",
      "agents",
    ]);
    expect(menu.find((entry) => entry.id === "panes")?.submenu).toBe(true);
    expect(menu.filter((entry) => entry.section === "panes").map((entry) => entry.id)).toEqual([
      "pane:w1:p1",
      "pane:w1:p2",
      "pane:new",
    ]);
    expect(menu.find((entry) => entry.id === "pane:w1:p1")?.checked).toBe(true);
  });

  it("keeps New pane in the Panes flyout when there are many panes", () => {
    const many = Array.from({ length: 6 }, (_, index) => ({
      paneId: `w1:p${index + 1}`,
      label: `pane-${index + 1}`,
      cwd: null as string | null,
    }));
    const menu = menuFor(terminal, [], { panes: many });
    expect(menu.filter((entry) => entry.section === "desk").map((entry) => entry.id)).toEqual([
      "panes",
      "spaces",
      "agents",
    ]);
    const flyout = menu.filter((entry) => entry.section === "panes");
    expect(flyout).toHaveLength(7);
    expect(flyout.map((entry) => entry.id).slice(0, 2)).toEqual(["pane:w1:p1", "pane:w1:p2"]);
    expect(flyout.at(-1)?.id).toBe("pane:new");
  });

  it("retargets the terminal pane from a Desk choice", () => {
    expect(showViewer(terminal, "pane:w1:p2", [])).toEqual({ type: "herdr", paneId: "w1:p2" });
  });

  it("labels Terminal here when the panel has a file address", () => {
    const entry = menuFor(note, [], { panes: [] }).find((item) => item.id === "terminal");
    expect(entry?.label).toBe("Terminal here");
  });

  it("lists only panes in the current space under Panes", () => {
    const mixed = [
      { paneId: "w1:p1", label: "a", cwd: null, workspaceId: "w1" },
      { paneId: "w2:p1", label: "b", cwd: null, workspaceId: "w2" },
      { paneId: "w1:p2", label: "c", cwd: null, workspaceId: "w1" },
    ];
    const menu = menuFor(terminal, [], { panes: mixed, workspaceId: "w1" });
    expect(menu.filter((entry) => entry.section === "desk").map((entry) => entry.id)).toEqual([
      "panes",
      "spaces",
      "agents",
    ]);
    expect(menu.filter((entry) => entry.section === "panes").map((entry) => entry.id)).toEqual([
      "pane:w1:p1",
      "pane:w1:p2",
      "pane:new",
    ]);
  });
});
