import { describe, expect, it } from "vitest";
import { openVisit, type VisitSpace } from "../src/borrowPanel";
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
    expect(three.node.cells[2]?.colSpan).toBe(2);

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
});
