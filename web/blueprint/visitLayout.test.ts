import { describe, expect, it } from "vitest";
import {
  deskFillRequest,
  insertVisitPanel,
  joinVisit,
  leaveVisitPanel,
  listVisitChoices,
  openVisit,
  placeVisitPanel,
  reuseVisit,
  type VisitSpace,
} from "../src/borrowPanel";
import { listPanels } from "../src/layoutEdit";
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

  it("packs a grid into splits and gives a short row the full width", () => {
    const grid = openVisit(spaces, [
      { panelId: "google" },
      { panelId: "Notes" },
      { panelId: "Agents" },
      { panelId: "Files" },
    ]);
    if (!("node" in grid) || grid.node.type !== "split") throw new Error("expected splits");
    expect(grid.arrange).toBe("grid");
    expect(grid.columns).toEqual([1, 1]);
    expect(grid.rows).toEqual([1, 1]);
    expect(grid.node).toMatchObject({ type: "split", direction: "column", ratio: 0.5 });
    expect(listPanels(grid.node).map((panel) => panel.id)).toEqual(["panel-1", "notes", "agents", "files"]);
    expect(JSON.stringify(grid.node)).not.toContain('"type":"grid"');

    const three = openVisit(spaces, [{ panelId: "google" }, { panelId: "Notes" }, { panelId: "Agents" }]);
    if (!("node" in three) || three.node.type !== "split") throw new Error("expected a packed grid");
    expect(three.node.direction).toBe("column");
    expect(three.node.second).toMatchObject({ type: "panel", id: "agents" });
    expect(three.node.first).toMatchObject({ type: "split", direction: "row" });
    expect(listPanels(three.node)).toHaveLength(3);

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
    if (!("node" in grid) || grid.node.type !== "split") throw new Error("expected splits");
    expect(grid.node.direction).toBe("column");
    expect(grid.node.ratio).toBeCloseTo(0.25);
    if (grid.node.first.type !== "split" || grid.node.second.type !== "split") throw new Error("expected two rows");
    expect(grid.node.first.ratio).toBeCloseTo(2 / 3);
    expect(grid.node.second.ratio).toBeCloseTo(2 / 3);
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
    const droppedMiddle = leaveVisitPanel(opened, "notes");
    if ("done" in droppedMiddle) throw new Error("expected the row to stay");
    expect(droppedMiddle.panelIds).toEqual(["panel-1", "agents"]);
    expect(droppedMiddle.node).toMatchObject({
      type: "split",
      direction: "row",
      ratio: 0.5,
      second: { id: "agents" },
    });
    const dropped = leaveVisitPanel(opened, "panel-1");
    if ("done" in dropped) throw new Error("expected the row to stay");
    expect(dropped.node).toMatchObject({ type: "split", direction: "row", ratio: 0.5 });
    expect(dropped.panelIds).toEqual(["notes", "agents"]);
    const only = openVisit(spaces, [{ panelId: "google" }]);
    if (!("node" in only)) throw new Error(only.error);
    expect(leaveVisitPanel(only, "panel-1")).toEqual({ done: true });
  });
});

describe("adding a panel to a visit", () => {
  it("appends a panel from the space that is showing", () => {
    const opened = openVisit(spaces, [deskFillRequest("notes", "wJ")]);
    if (!("node" in opened)) throw new Error(opened.error);
    const next = joinVisit(opened, "panel-1", "wH");
    if ("error" in next) throw new Error(next.error);
    expect(next.panels).toEqual([
      { panelId: "notes", spaceId: "wJ" },
      { panelId: "panel-1", spaceId: "wH" },
    ]);
  });

  it("refuses a panel that is already showing and stops at six", () => {
    const opened = openVisit(spaces, [{ panelId: "notes" }, { panelId: "google" }]);
    if (!("node" in opened)) throw new Error(opened.error);
    expect(joinVisit(opened, "notes")).toEqual({ error: "that panel is already in this visit" });
    const full = {
      ...opened,
      panelIds: ["a", "b", "c", "d", "e", "f"],
      spaceIds: { a: "wJ", b: "wJ", c: "wJ", d: "wJ", e: "wJ", f: "wJ" },
    };
    expect(joinVisit(full, "agents", "wG")).toEqual({ error: "a visit can show 6 panels" });
  });

  it("places one visit panel beside another and leaves a single panel alone", () => {
    const opened = openVisit(spaces, [{ panelId: "google" }, { panelId: "Notes" }]);
    if (!("node" in opened)) throw new Error(opened.error);
    const below = placeVisitPanel(opened, "notes", "panel-1", "below");
    expect(below.panelIds).toEqual(["panel-1", "notes"]);
    expect(below.arrange).toBe("column");
    expect(below.node).toMatchObject({ type: "split", direction: "column" });
    const swapped = placeVisitPanel(opened, "notes", "panel-1", "center");
    expect(swapped.panelIds).toEqual(["notes", "panel-1"]);
    const alone = openVisit(spaces, [{ panelId: "notes" }]);
    if (!("node" in alone)) throw new Error(alone.error);
    expect(placeVisitPanel(alone, "notes", "panel-1", "left")).toMatchObject({
      panelIds: ["notes"],
      node: alone.node,
    });
    expect(spaces[0]?.root).toEqual(panel("notes", "Notes"));
  });

  it("adds a panel by splitting, the same way the desk does, and a drag leaves no empty row", () => {
    const opened = openVisit(spaces, [{ panelId: "google" }, { panelId: "Notes" }]);
    if (!("node" in opened)) throw new Error(opened.error);
    const added = panel("agents", "Agents");
    if (added.type !== "panel") throw new Error("expected a panel");
    const next = insertVisitPanel(opened, added, "wG", "garden");
    if ("error" in next) throw new Error(next.error);
    expect(next.node).toMatchObject({
      type: "split",
      direction: "row",
      first: { id: "panel-1" },
      second: { type: "split", direction: "row", first: { id: "notes" }, second: { id: "agents" } },
    });
    expect(listPanels(next.node)).toHaveLength(3);

    const packed = openVisit(spaces, [{ panelId: "google" }, { panelId: "Notes" }, { panelId: "Agents" }]);
    if (!("node" in packed)) throw new Error(packed.error);
    const moved = placeVisitPanel(packed, "agents", "panel-1", "above");
    expect(listPanels(moved.node).map((item) => item.id)).toEqual(["agents", "panel-1", "notes"]);
    expect(moved.node).toMatchObject({
      type: "split",
      direction: "row",
      first: { type: "split", direction: "column" },
      second: { id: "notes" },
    });
    expect(JSON.stringify(moved.node)).not.toContain('"type":"grid"');
  });

  it("offers the copy on the current space when another space reused the id", () => {
    const here = space("wJ", "herdr-panels", panel("notes", "Notes here"), true);
    const there = space("wH", "other", panel("notes", "Notes there"));
    expect(listVisitChoices([there, here])).toEqual([
      { panelId: "notes", title: "Notes here", spaceId: "wJ", space: "herdr-panels" },
    ]);
    expect(listVisitChoices(spaces).map((choice) => [choice.panelId, choice.spaceId])).toEqual([
      ["notes", "wJ"],
      ["panel-1", "wH"],
      ["agents", "wG"],
      ["files", "wK"],
    ]);
  });
});
