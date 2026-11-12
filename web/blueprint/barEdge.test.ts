import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BarFaceItems, BarPlaceItems, TabPlaceItems, VerticalNamesItem } from "../src/components/PanelChrome";
import { addPanelTab, closePanelTab, findPanel, movePanel, normalizeLayout, setBarEdge, setBarFace } from "../src/layoutEdit";
import { collapseBasis } from "../src/tabFace";
import type { LayoutNode } from "../src/types";

function note(): LayoutNode {
  return {
    type: "panel",
    id: "notes",
    title: "Notes",
    panel: { type: "markdown", path: "notes.md" },
  };
}

describe("the panel bar edge", () => {
  it("stores a side on a normal panel and treats the top as unset", () => {
    const left = setBarEdge(note(), "notes", "left");
    expect(left).toMatchObject({ type: "panel", edge: "left" });
    const top = setBarEdge(left, "notes", "top");
    expect(top.type === "panel" ? top.edge : "kept").toBeUndefined();
  });

  it("keeps the side when the layout is loaded", () => {
    const loaded = normalizeLayout({ ...note(), edge: "bottom" });
    expect(loaded).toMatchObject({ edge: "bottom" });
  });

  it("moves a tab bar with the same control and leaves the panel edge unset", () => {
    const tabs: LayoutNode = {
      type: "panel",
      id: "group",
      panel: {
        type: "tabs",
        edge: "top",
        active: "a",
        tabs: [{ id: "a", title: "Notes", panel: { type: "blank" } }],
      },
    };
    const right = setBarEdge(tabs, "group", "right");
    expect(right.type === "panel" && right.panel.type === "tabs" ? right.panel.edge : "").toBe("right");
    expect(right.type === "panel" ? right.edge : "kept").toBeUndefined();
  });

  it("keeps the side when the panel is dragged beside another", () => {
    const desk: LayoutNode = {
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: { ...note(), edge: "right" },
      second: { type: "panel", id: "other", title: "Other", panel: { type: "blank" } },
    };
    const moved = movePanel(desk, "notes", "other", "below");
    expect(findPanel(moved, "notes")?.edge).toBe("right");
  });

  it("collapses a side bar across a row and a top bar down a column", () => {
    const side: LayoutNode = { ...note(), edge: "left", collapsed: true };
    expect(collapseBasis(side, "row")).toBe(42);
    expect(collapseBasis(side, "column")).toBeNull();
    const top: LayoutNode = { ...note(), collapsed: true };
    expect(collapseBasis(top, "column")).toBe(34);
    expect(collapseBasis(top, "row")).toBeNull();
  });
});

describe("the panel bar name and icon", () => {
  it("stores a hidden name and icon and clears them when shown again", () => {
    const hidden = setBarFace(note(), "notes", false, false);
    expect(hidden).toMatchObject({ showNames: false, showIcons: false });
    const shown = setBarFace(hidden, "notes", true, true);
    expect(shown.type === "panel" ? shown.showNames : false).toBeUndefined();
    expect(shown.type === "panel" ? shown.showIcons : false).toBeUndefined();
  });

  it("keeps a hidden name when the layout is loaded", () => {
    const loaded = normalizeLayout({ ...note(), showNames: false, showIcons: false });
    expect(loaded).toMatchObject({ showNames: false, showIcons: false });
  });

  it("carries the choice onto a new tab bar and back off it", () => {
    const hidden = setBarFace({ ...note(), icon: "file" }, "notes", false, true);
    const grouped = addPanelTab(hidden, "notes");
    const group = findPanel(grouped, "notes");
    expect(group?.panel.type === "tabs" ? group.panel.showNames : true).toBe(false);
    expect(group?.showNames).toBeUndefined();
    expect(group?.panel.type === "tabs" ? group.panel.showIcons : false).toBeUndefined();
    const unwrapped = closePanelTab(grouped, "notes", "tab-2");
    expect(findPanel(unwrapped, "notes")?.showNames).toBe(false);
    expect(findPanel(unwrapped, "notes")?.panel.type).not.toBe("tabs");
  });

  it("narrows a collapsed side bar when the name is hidden", () => {
    const named: LayoutNode = { ...note(), edge: "left", collapsed: true };
    expect(collapseBasis(named, "row")).toBe(42);
    const iconOnly: LayoutNode = { ...named, icon: "file", showNames: false };
    expect(collapseBasis(iconOnly, "row")).toBe(42);
    const bare: LayoutNode = { ...named, showNames: false, showIcons: false };
    expect(collapseBasis(bare, "row")).toBe(36);
  });

  it("offers vertical names as a checked menu item", () => {
    const on = renderToStaticMarkup(createElement(VerticalNamesItem, { checked: true, onToggle: () => undefined }));
    expect(on).toContain("Vertical names");
    expect(on).toContain('aria-checked="true"');
    const off = renderToStaticMarkup(createElement(VerticalNamesItem, { checked: false, onToggle: () => undefined }));
    expect(off).toContain('aria-checked="false"');
  });

  it("offers show icons and show names ahead of the bar sides", () => {
    const html = renderToStaticMarkup(
      createElement(BarFaceItems, { names: true, icons: false, onNames: () => undefined, onIcons: () => undefined }),
    );
    expect(html).toContain("Show icons");
    expect(html).toContain("Show names");
    expect(html).toContain('aria-checked="false"');
    expect(html.indexOf("Show icons")).toBeLessThan(html.indexOf("Show names"));
  });
});

describe("the layout menu bar choices", () => {
  it("offers the four sides and marks the current one", () => {
    const html = renderToStaticMarkup(createElement(BarPlaceItems, { edge: "left", onEdge: () => undefined }));
    expect(html).toContain("Bar on top");
    expect(html).toContain("Bar on left");
    expect(html).toContain("Bar on bottom");
    expect(html).toContain("Bar on right");
    expect(html).toContain('aria-checked="true"');
    expect(html.indexOf("Bar on left")).toBeLessThan(html.indexOf("Bar on bottom"));
    const checked = html.slice(html.indexOf('aria-checked="true"') - 80, html.indexOf('aria-checked="true"'));
    expect(html.slice(html.indexOf('aria-checked="true"'), html.indexOf('aria-checked="true"') + 200)).toContain(
      "Bar on left",
    );
    expect(checked).not.toContain("Bar on top");
  });

  it("offers the four places for one tab and marks the current one", () => {
    const html = renderToStaticMarkup(createElement(TabPlaceItems, { edge: "right", onEdge: () => undefined }));
    expect(html).toContain("Place on top");
    expect(html).toContain("Place on bottom");
    expect(html).toContain("Place on left");
    expect(html).toContain("Place on right");
    expect(html.indexOf("Place on top")).toBeLessThan(html.indexOf("Place on bottom"));
    expect(html.slice(html.indexOf('aria-checked="true"'), html.indexOf('aria-checked="true"') + 200)).toContain(
      "Place on right",
    );
    expect(html).toContain("Move this tab onto the right. The other tabs stay where they are.");
  });
});
