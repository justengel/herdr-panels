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
  it("puts Panes before Terminals, and the terminal list in the Terminals flyout", () => {
    const menu = menuFor(terminal, [], { panes });
    expect(menu.filter((entry) => entry.section === "desk").map((entry) => entry.id)).toEqual([
      "space-panes",
      "terminals",
      "spaces",
      "agents",
    ]);
    expect(menu.find((entry) => entry.id === "space-panes")?.submenu).toBeUndefined();
    expect(menu.find((entry) => entry.id === "space-panes")?.checked).toBe(true);
    expect(menu.find((entry) => entry.id === "terminals")?.submenu).toBe(true);
    expect(menu.filter((entry) => entry.section === "panes").map((entry) => entry.id)).toEqual([
      "pane:w1:p1",
      "pane:w1:p2",
      "pane:new",
    ]);
    expect(menu.find((entry) => entry.id === "pane:w1:p1")?.checked).toBe(false);
  });

  it("keeps New terminal in the Terminals flyout when there are many panes", () => {
    const many = Array.from({ length: 6 }, (_, index) => ({
      paneId: `w1:p${index + 1}`,
      label: `pane-${index + 1}`,
      cwd: null as string | null,
    }));
    const menu = menuFor(terminal, [], { panes: many });
    expect(menu.filter((entry) => entry.section === "desk").map((entry) => entry.label)).toEqual([
      "Panes",
      "Terminals",
      "Spaces",
      "Agents",
    ]);
    const flyout = menu.filter((entry) => entry.section === "panes");
    expect(flyout).toHaveLength(7);
    expect(flyout.map((entry) => entry.id).slice(0, 2)).toEqual(["pane:w1:p1", "pane:w1:p2"]);
    expect(flyout.at(-1)?.label).toBe("New terminal…");
  });

  it("shows the chosen shell in this panel", () => {
    expect(showViewer(terminal, "pane:w1:p2", [])).toEqual({
      type: "herdr",
      paneId: "w1:p2",
      scope: "pane",
    });
  });

  it("offers Text for a Linux path that was opened as a browser", () => {
    const path =
      "/tmp/claude-1000/-home-engel-projects-checkin/4486d599-0fa7-42c3-ba03-329780445b47/scratchpad/add_permissions.py";
    const browser: PanelConfig = { type: "iframe", url: path, proxy: false };
    const ids = menuFor(browser, []).map((entry) => entry.id);
    expect(ids).toContain("text");
    expect(ids).toContain("files");
    expect(showViewer(browser, "text", [])).toEqual({ type: "file", path });
  });

  it("ends the Terminals flyout with New terminal on a file", () => {
    const menu = menuFor(note, [], { panes: [] });
    expect(menu.some((item) => item.id === "terminal")).toBe(false);
    const flyout = menu.filter((item) => item.section === "panes");
    expect(flyout.at(-1)?.id).toBe("pane:new");
    expect(flyout.at(-1)?.label).toBe("New terminal…");
    const panes = menu.find((item) => item.id === "space-panes");
    expect(panes?.label).toBe("Panes");
    expect(panes?.hint).toBe("Herdr panes that contain the terminals.");
  });

  it("lists only panes in the current space under Panes", () => {
    const mixed = [
      { paneId: "w1:p1", label: "a", cwd: null, workspaceId: "w1" },
      { paneId: "w2:p1", label: "b", cwd: null, workspaceId: "w2" },
      { paneId: "w1:p2", label: "c", cwd: null, workspaceId: "w1" },
    ];
    const menu = menuFor(terminal, [], { panes: mixed, workspaceId: "w1" });
    expect(menu.filter((entry) => entry.section === "desk").map((entry) => entry.id)).toEqual([
      "space-panes",
      "terminals",
      "spaces",
      "agents",
    ]);
    expect(menu.filter((entry) => entry.section === "panes").map((entry) => entry.id)).toEqual([
      "pane:w1:p1",
      "pane:w1:p2",
      "pane:new",
    ]);
  });

  it("names a new shell and the space view on a blank panel", () => {
    const blank: PanelConfig = { type: "blank" };
    const menu = menuFor(blank, []);
    const desk = menu.filter((entry) => entry.section === "desk");
    expect(desk.map((entry) => entry.id).slice(0, 2)).toEqual(["space-panes", "terminals"]);
    expect(desk.find((entry) => entry.id === "terminals")?.submenu).toBe(true);
    const listed = menuFor(blank, [], { panes, workspaceId: "w1" });
    expect(listed.filter((entry) => entry.section === "panes").map((entry) => entry.label)).toEqual([
      "w1:p1 · herdr-panels",
      "w1:p2 · notes",
      "New terminal…",
    ]);
    const panesItem = menu.find((entry) => entry.id === "space-panes");
    expect(panesItem?.label).toBe("Panes");
    expect(panesItem?.submenu).toBeUndefined();
    expect(showViewer(blank, "space-panes", [])).toEqual({ type: "herdr", paneId: null });
  });

  it("offers Panes, then Terminals, on both the space view and a terminal", () => {
    const space = menuFor(terminal, [], { panes });
    expect(space.find((entry) => entry.id === "space-panes")?.submenu).toBeUndefined();
    expect(space.find((entry) => entry.id === "terminals")?.label).toBe("Terminals");
    expect(space.find((entry) => entry.id === "pane:new")?.label).toBe("New terminal…");
    expect(space.find((entry) => entry.id === "terminals")?.hint).toBe(
      "Show a single terminal from the Herdr panes.",
    );
    expect(space.find((entry) => entry.id === "pane:new")?.hint).toBe(
      "Open a new tab in Panes and display that terminal here.",
    );
    const solo = menuFor({ type: "herdr", paneId: "w1:p1", scope: "pane" }, [], { panes });
    expect(solo.filter((entry) => entry.section === "desk").map((entry) => entry.id)).toEqual([
      "space-panes",
      "terminals",
      "spaces",
      "agents",
    ]);
    expect(solo.find((entry) => entry.id === "terminals")?.submenu).toBe(true);
    expect(solo.find((entry) => entry.id === "terminals")?.checked).toBe(true);
    expect(solo.find((entry) => entry.id === "space-panes")?.checked).toBe(false);
    expect(solo.find((entry) => entry.id === "pane:w1:p1")?.checked).toBe(true);
    expect(solo.find((entry) => entry.id === "pane:w1:p2")?.checked).toBe(false);
    expect(solo.find((entry) => entry.id === "space-panes")?.hint).toBe("Herdr panes that contain the terminals.");
  });
});
