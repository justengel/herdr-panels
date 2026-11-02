import { describe, expect, it } from "vitest";
import { deskFillRequest, leaveVisitPanel, openVisit, reuseVisit, type VisitSpace } from "../src/borrowPanel";
import type { LayoutNode } from "../src/types";

function space(id: string, label: string, root: LayoutNode, current = false): VisitSpace {
  return { id, label, root, current };
}

function panel(id: string, title: string): LayoutNode {
  return { type: "panel", id, title, panel: { type: "markdown", path: `${id}.md` } };
}

const spaces: VisitSpace[] = [
  space("wJ", "herdr-panels", panel("notes", "Notes"), true),
  space("wH", "my_sixth_grimoire", panel("panel-1", "google")),
  space("wG", "garden", panel("agents", "Agents")),
  space("wK", "kitchen", panel("files", "Files")),
];

describe("maximizing a panel", () => {
  it("keeps the copy on this space when another space reused the id", () => {
    const here: LayoutNode = {
      type: "panel",
      id: "panel-1",
      title: "google",
      panel: { type: "iframe", url: "https://google.com" },
    };
    const there: LayoutNode = {
      type: "panel",
      id: "panel-1",
      title: "Files",
      panel: { type: "plugin", plugin: "files" },
    };
    const opened = openVisit(
      [space("wJ", "herdr-panels", here, true), space("wH", "my_sixth_grimoire", there)],
      [deskFillRequest("panel-1", "wJ")],
    );
    expect(opened).toMatchObject({
      single: true,
      panelIds: ["panel-1"],
      spaceIds: { "panel-1": "wJ" },
    });
    if (!("node" in opened) || opened.node.type !== "panel" || opened.node.panel.type !== "iframe") {
      throw new Error("expected the browser on this space");
    }
    expect(opened.node.panel.url).toBe("https://google.com");
  });
});

describe("a visit of several panels", () => {
  it("sits two panels side by side and leaves their spaces unchanged", () => {
    const before = structuredClone(spaces);
    const opened = openVisit(spaces, [{ panelId: "google" }, { panelId: "Notes" }]);
    expect(opened).toMatchObject({
      single: false,
      arrange: "row",
      panelIds: ["panel-1", "notes"],
    });
    if (!("node" in opened) || opened.node.type !== "split") throw new Error("expected a row");
    expect(opened.node.direction).toBe("row");
    expect(opened.node.first).toMatchObject({ id: "panel-1" });
    expect(opened.node.second).toMatchObject({ id: "notes" });
    expect(opened.origins).toEqual({ "panel-1": "my_sixth_grimoire", notes: "herdr-panels" });
    expect(spaces).toEqual(before);
  });

  it("uses a grid for four panels and a column when asked", () => {
    const grid = openVisit(spaces, [
      { panelId: "google" },
      { panelId: "Notes" },
      { panelId: "Agents" },
      { panelId: "Files" },
    ]);
    if (!("node" in grid) || grid.node.type !== "grid") throw new Error("expected a grid");
    expect(grid.arrange).toBe("grid");
    expect(grid.node.columns).toEqual([1, 1]);
    expect(grid.node.rows).toEqual([1, 1]);
    const three = openVisit(spaces, [{ panelId: "google" }, { panelId: "Notes" }, { panelId: "Agents" }]);
    if (!("node" in three) || three.node.type !== "grid") throw new Error("expected a three-up grid");
    expect(three.node.cells[2]?.colSpan).toBe(1);

    expect(grid.node.cells.map((cell) => cell.node && cell.node.type === "panel" && cell.node.id)).toEqual([
      "panel-1",
      "notes",
      "agents",
      "files",
    ]);

    const stacked = openVisit(
      spaces,
      [{ panelId: "google" }, { panelId: "Notes" }, { panelId: "Agents" }],
      "column",
    );
    if (!("node" in stacked) || stacked.node.type !== "split") throw new Error("expected a column");
    expect(stacked.arrange).toBe("column");
    expect(stacked.node.direction).toBe("column");
  });

  it("gives a row the weights it was given and keeps a panel already on the visit", () => {
    const opened = openVisit(
      spaces,
      [{ panelId: "google" }, { panelId: "Notes" }, { panelId: "Agents" }],
      "row",
      { sizes: [2, 1, 1] },
    );
    if (!("node" in opened) || opened.node.type !== "split") throw new Error("expected a row");
    expect(opened.sizes).toEqual([2, 1, 1]);
    expect(opened.node.ratio).toBeCloseTo(0.5);
    if (opened.node.second.type !== "split") throw new Error("expected the rest to split");
    expect(opened.node.second.ratio).toBeCloseTo(0.5);

    const live = structuredClone(opened.node);
    if (live.type === "split" && live.first.type === "panel") live.first.title = "changed";
    const again = openVisit(
      spaces,
      [{ panelId: "google" }, { panelId: "Notes" }, { panelId: "Agents" }],
      "row",
      { sizes: [3, 1, 1] },
    );
    if (!("node" in again)) throw new Error(again.error);
    const kept = reuseVisit(live, again);
    if (kept.type !== "split" || kept.first.type !== "panel") throw new Error("expected the same row");
    expect(kept.ratio).toBeCloseTo(0.6);
    expect(kept.first.title).toBe("changed");
  });

  it("weights a grid by column and row and refuses a size that does not fit", () => {
    const grid = openVisit(
      spaces,
      [{ panelId: "google" }, { panelId: "Notes" }, { panelId: "Agents" }, { panelId: "Files" }],
      "grid",
      { columns: [2, 1], rows: [1, 3] },
    );
    if (!("node" in grid) || grid.node.type !== "grid") throw new Error("expected a grid");
    expect(grid.node.columns).toEqual([2, 1]);
    expect(grid.node.rows).toEqual([1, 3]);
    expect(openVisit(spaces, [{ panelId: "google" }, { panelId: "Notes" }], "row", { sizes: [2] })).toEqual({
      error: "size has one weight per panel",
    });
    expect(openVisit(spaces, [{ panelId: "google" }, { panelId: "Notes" }], "grid", { sizes: [2, 1] })).toEqual({
      error: "size is for a row or a column",
    });
    expect(openVisit(spaces, [{ panelId: "google" }, { panelId: "Notes" }], "row", { sizes: [0, 1] })).toEqual({
      error: "a weight must be a positive number",
    });
    expect(openVisit(spaces, [{ panelId: "google" }], undefined, { sizes: [2] })).toEqual({
      error: "a single panel has no size",
    });
  });

  it("fails the whole visit when one panel is missing or repeated", () => {
    expect(openVisit(spaces, [{ panelId: "google" }, { panelId: "Missing" }])).toEqual({
      error: "panel was not found: Missing",
    });
    expect(openVisit(spaces, [{ panelId: "google" }, { panelId: "google" }])).toEqual({
      error: "a visit lists that panel more than once",
    });
    expect(openVisit(spaces, [{ panelId: "google" }, { panelId: "Notes" }], "diagonal")).toEqual({
      error: "arrange is row, column, or grid",
    });
  });

  it("drops one panel and lets the rest of the row keep their weights", () => {
    const opened = openVisit(
      spaces,
      [{ panelId: "google" }, { panelId: "Notes" }, { panelId: "Agents" }],
      "row",
      { sizes: [2, 1, 1] },
    );
    if (!("node" in opened)) throw new Error(opened.error);
    expect(leaveVisitPanel(opened, "notes")).toEqual({
      panels: [
        { panelId: "panel-1", spaceId: "wH" },
        { panelId: "agents", spaceId: "wG" },
      ],
      arrange: "row",
      weights: { sizes: [2, 1] },
    });
    const dropped = leaveVisitPanel(opened, "panel-1");
    if ("done" in dropped) throw new Error("expected the row to stay");
    expect(dropped.weights).toEqual({ sizes: [1, 1] });
    const only = openVisit(spaces, [{ panelId: "google" }]);
    if (!("node" in only)) throw new Error(only.error);
    expect(leaveVisitPanel(only, "panel-1")).toEqual({ done: true });
  });
});
