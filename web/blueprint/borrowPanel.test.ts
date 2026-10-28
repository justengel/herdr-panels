import { describe, expect, it } from "vitest";
import { findPanelVisit, type VisitSpace } from "../src/borrowPanel";
import type { LayoutNode } from "../src/types";

function space(id: string, label: string, root: LayoutNode, current = false): VisitSpace {
  return { id, label, root, current };
}

const notes: LayoutNode = {
  type: "panel",
  id: "notes",
  title: "Notes",
  panel: { type: "markdown", path: "notes/a.md" },
};

const report: LayoutNode = {
  type: "panel",
  id: "report",
  title: "Check-in",
  panel: { type: "plugin", plugin: "checkin-report", control: true },
};

describe("a visit to a panel on another space", () => {
  it("finds that panel and leaves its layout unchanged", () => {
    const source = structuredClone(notes);
    const found = findPanelVisit(
      [space("chief", "Chief", report, true), space("api", "API", source)],
      "Notes",
    );
    expect(found).toMatchObject({
      visit: { panelId: "notes", title: "Notes", spaceId: "api", spaceLabel: "API" },
    });
    if ("visit" in found) found.visit.node.title = "Changed";
    expect(source).toEqual(notes);
  });

  it("prefers the copy on another space when this space has the same panel", () => {
    const found = findPanelVisit(
      [space("chief", "Chief", notes, true), space("api", "API", notes)],
      "notes",
    );
    expect(found).toMatchObject({ visit: { spaceId: "api", spaceLabel: "API" } });
  });

  it("refuses a title that belongs to two panels", () => {
    const other: LayoutNode = {
      type: "panel",
      id: "other",
      title: "Notes",
      panel: { type: "markdown", path: "notes/b.md" },
    };
    expect(findPanelVisit([space("a", "A", notes), space("b", "B", other)], "Notes")).toEqual({
      error: "more than one panel has that name",
    });
  });

  it("keeps the copy on the space the visit named", () => {
    const google: LayoutNode = {
      type: "panel",
      id: "panel-1",
      title: "google",
      panel: { type: "iframe", url: "https://google.com" },
    };
    const found = findPanelVisit(
      [space("wJ", "herdr-panels", google, true), space("wH", "my_sixth_grimoire", google)],
      "panel-1",
      "wH",
    );
    expect(found).toMatchObject({ visit: { spaceId: "wH", spaceLabel: "my_sixth_grimoire" } });
  });

  it("reports a missing panel", () => {
    expect(findPanelVisit([space("chief", "Chief", report, true)], "Missing")).toEqual({
      error: "panel was not found",
    });
    expect(findPanelVisit([space("chief", "Chief", report, true)], "  ")).toEqual({
      error: "panel was not found",
    });
  });
});
