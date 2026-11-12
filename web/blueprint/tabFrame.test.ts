import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PanelChrome } from "../src/components/PanelChrome";
import { TabFrameLayout } from "../src/components/TabFrameLayout";
import { addPanelTab, closePanelTab, findPanel, groupOnBar, moveTab, normalizeLayout, setBarEdge } from "../src/layoutEdit";
import { PanelActionsProvider, type PanelActions } from "../src/panelActions";
import {
  collapsedTabs,
  frameSplits,
  gatherTabs,
  openEdges,
  placeTabOn,
  reorderOnEdge,
  tabEdgeOf,
  tabFrame,
  toggleStrip,
  toolEdge,
} from "../src/tabFrame";
import type { LayoutNode, PanelTab, TabsPanel } from "../src/types";

function tab(id: string, edge?: PanelTab["edge"]): PanelTab {
  return { id, title: id, panel: { type: "blank" }, ...(edge ? { edge } : {}) };
}

function group(tabs: PanelTab[], edge: TabsPanel["edge"] = "top"): TabsPanel {
  return { type: "tabs", edge, active: tabs[0]?.id ?? "", tabs };
}

describe("tabs on more than one edge", () => {
  it("uses the group edge when a tab does not name one", () => {
    expect(tabEdgeOf(tab("a"), "right")).toBe("right");
    expect(tabEdgeOf(tab("a", "left"), "right")).toBe("left");
  });

  it("keeps each tab on its own strip and skips an empty edge", () => {
    const frame = tabFrame(group([tab("notes"), tab("files", "right"), tab("web", "right"), tab("log", "bottom")]));
    expect(frame.top.map((item) => item.id)).toEqual(["notes"]);
    expect(frame.right.map((item) => item.id)).toEqual(["files", "web"]);
    expect(frame.bottom.map((item) => item.id)).toEqual(["log"]);
    expect(frame.left).toEqual([]);
    expect(frameSplits(frame)).toBe(true);
  });

  it("stays a single strip when every tab shares the group edge", () => {
    const frame = tabFrame(group([tab("a"), tab("b")], "right"));
    expect(frameSplits(frame)).toBe(false);
    expect(frame.right.map((item) => item.id)).toEqual(["a", "b"]);
    expect(frame.top).toEqual([]);
  });

  it("runs the side rails the full height, outside the top and bottom strips", () => {
    const frame = tabFrame(group([tab("top"), tab("side", "right"), tab("foot", "bottom"), tab("rail", "left")]));
    const html = renderToStaticMarkup(
      createElement(TabFrameLayout, {
        frame,
        strip: (edge: string) => createElement("header", { "data-edge": edge }, edge),
        children: createElement("div", { className: "panel-body" }, "page"),
      }),
    );
    expect(html).toBe(
      '<header data-edge="left">left</header><div class="panel-well"><header data-edge="top">top</header><div class="panel-body">page</div><header data-edge="bottom">bottom</header></div><header data-edge="right">right</header>',
    );
  });

  it("moves one tab onto another edge and leaves the others where they are", () => {
    const next = placeTabOn(group([tab("a"), tab("b"), tab("c")]), "b", "right");
    expect(next.edge).toBe("top");
    expect(next.tabs.map((item) => [item.id, item.edge ?? "top"])).toEqual([
      ["a", "top"],
      ["b", "right"],
      ["c", "top"],
    ]);
    expect(next.tabs[0].edge).toBeUndefined();
    expect(next.tabs[1].edge).toBe("right");
  });

  it("adopts that edge for the group when the last tab joins it", () => {
    const next = placeTabOn(group([tab("a"), tab("b", "right")]), "a", "right");
    expect(next.edge).toBe("right");
    expect(next.tabs.every((item) => item.edge == null)).toBe(true);
  });

  it("keeps an empty strip open when that side is checked", () => {
    const opened = toggleStrip(group([tab("a"), tab("b")]), "right");
    expect(openEdges(opened)).toEqual(["top", "right"]);
    expect(opened.strips).toEqual(["top", "right"]);
    expect(opened.tabs.every((item) => item.edge == null)).toBe(true);
    expect(toggleStrip(opened, "top").edge).toBe("right");
    expect(toggleStrip(group([tab("a")]), "top")).toEqual(group([tab("a")]));
  });

  it("moves tabs off a strip that is unchecked", () => {
    const mixed = group([tab("a"), tab("b", "right")]);
    const next = toggleStrip(mixed, "right");
    expect(openEdges(next)).toEqual(["top"]);
    expect(next.strips).toBeUndefined();
    expect(next.tabs.map((item) => item.edge ?? "top")).toEqual(["top", "top"]);
  });

  it("leaves a checked empty strip open when a tab is placed and moved back", () => {
    const opened = toggleStrip(group([tab("a"), tab("b")]), "right");
    const placed = placeTabOn(opened, "b", "right");
    expect(openEdges(placed)).toEqual(["top", "right"]);
    const back = placeTabOn(placed, "b", "top");
    expect(openEdges(back)).toEqual(["top", "right"]);
    expect(back.tabs.every((item) => (item.edge ?? "top") === "top")).toBe(true);
  });

  it("gathers every tab onto one edge", () => {
    const next = gatherTabs(group([tab("a"), tab("b", "right")]), "left");
    expect(next.edge).toBe("left");
    expect(next.tabs.map((item) => item.id)).toEqual(["a", "b"]);
    expect(next.tabs.every((item) => item.edge == null)).toBe(true);
  });

  it("reorders one strip without moving tabs on the other edges", () => {
    const next = reorderOnEdge([tab("a"), tab("b", "right"), tab("c"), tab("d", "right")], "top", "right", "d", "b");
    expect(next.map((item) => item.id)).toEqual(["a", "d", "c", "b"]);
    expect(next.map((item) => item.edge ?? "top")).toEqual(["top", "right", "top", "right"]);
  });

  it("keeps the tools on the group edge, or on the active tab when that edge is empty", () => {
    expect(toolEdge(group([tab("a"), tab("b", "right")]))).toBe("top");
    expect(toolEdge(group([tab("side", "right"), tab("foot", "bottom")]))).toBe("right");
  });

  it("folds every tab onto the group edge while the panel is collapsed", () => {
    const source = group([tab("a"), tab("b", "right")]);
    const shown = collapsedTabs(source);
    expect(shown.tabs.every((item) => item.edge == null)).toBe(true);
    expect(frameSplits(tabFrame(shown))).toBe(false);
    expect(source.tabs[1].edge).toBe("right");
    expect(collapsedTabs(group([tab("a"), tab("b")], "right"))).toEqual(group([tab("a"), tab("b")], "right"));
  });
});

function mixedGroup(): LayoutNode {
  return {
    type: "panel",
    id: "group",
    panel: {
      type: "tabs",
      edge: "top",
      active: "side",
      tabs: [
        { id: "page", title: "Page", panel: { type: "blank" } },
        { id: "side", title: "Side", edge: "right", panel: { type: "blank" } },
      ],
    },
  };
}

describe("saving a multi-edge group", () => {
  it("puts a new tab on the active tab's strip", () => {
    const next = addPanelTab(mixedGroup(), "group");
    const panel = findPanel(next, "group");
    if (panel?.panel.type !== "tabs") throw new Error("expected a group");
    const added = panel.panel.tabs[panel.panel.tabs.length - 1];
    expect(panel.panel.active).toBe(added.id);
    expect(added.edge).toBe("right");
    expect(panel.panel.tabs[0].edge).toBeUndefined();
  });

  it("moves every tab when the whole bar changes edge", () => {
    const next = setBarEdge(mixedGroup(), "group", "left");
    const panel = findPanel(next, "group");
    if (panel?.panel.type !== "tabs") throw new Error("expected a group");
    expect(panel.edge).toBeUndefined();
    expect(panel.panel.edge).toBe("left");
    expect(panel.panel.tabs.every((item) => item.edge == null)).toBe(true);
  });

  it("keeps the remaining tab's edge when the group unwraps", () => {
    const next = closePanelTab(mixedGroup(), "group", "page");
    expect(findPanel(next, "group")).toMatchObject({ edge: "right", panel: { type: "blank" } });
  });

  it("keeps a side when a one-tab group is loaded", () => {
    const loaded = normalizeLayout({
      type: "panel",
      id: "group",
      title: "Side",
      panel: {
        type: "tabs",
        edge: "right",
        active: "only",
        tabs: [{ id: "only", title: "Side", panel: { type: "blank" } }],
      },
    });
    expect(loaded).toMatchObject({ edge: "right", panel: { type: "blank" } });
  });

  it("lands a dropped panel on the strip under the pointer", () => {
    const desk: LayoutNode = {
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: { type: "panel", id: "notes", title: "Notes", panel: { type: "markdown", path: "a.md" } },
      second: mixedGroup(),
    };
    const next = groupOnBar(desk, "notes", "group", "right");
    const panel = findPanel(next, "group");
    if (panel?.panel.type !== "tabs") throw new Error("expected a group");
    expect(panel.panel.tabs.map((item) => [item.title, item.edge ?? "top"])).toEqual([
      ["Page", "top"],
      ["Side", "right"],
      ["Notes", "right"],
    ]);
  });

  it("keeps a tab's edge when it is dragged out into its own panel", () => {
    const desk: LayoutNode = {
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: mixedGroup(),
      second: { type: "panel", id: "other", title: "Other", panel: { type: "blank" } },
    };
    const next = moveTab(desk, "group", "side", "other", "below");
    const panels = [findPanel(next, "group"), ...listMoved(next)].filter((panel) => panel && panel.id !== "group" && panel.id !== "other");
    expect(panels).toHaveLength(1);
    expect(panels[0]).toMatchObject({ edge: "right" });
  });

  it("moves one tab onto a strip of another group", () => {
    const desk: LayoutNode = {
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: mixedGroup(),
      second: {
        type: "panel",
        id: "other",
        panel: {
          type: "tabs",
          edge: "top",
          active: "a",
          tabs: [{ id: "a", title: "Other", panel: { type: "blank" } }],
        },
      },
    };
    const next = moveTab(desk, "group", "side", "other", "bar", "bottom");
    const other = findPanel(next, "other");
    if (other?.panel.type !== "tabs") throw new Error("expected a group");
    expect(other.panel.tabs.map((item) => [item.title, item.edge ?? "top"])).toEqual([
      ["Other", "top"],
      ["Side", "bottom"],
    ]);
  });
});

const actions: PanelActions = {
  close: () => undefined,
  add: () => undefined,
  addTab: () => undefined,
  use: () => undefined,
  edge: () => undefined,
  face: () => undefined,
  place: () => undefined,
  group: () => undefined,
  dropTab: () => undefined,
  spawn: () => undefined,
  rename: () => undefined,
  icon: () => undefined,
  collapse: () => undefined,
  openTab: () => undefined,
  fill: () => undefined,
  leave: () => undefined,
  filledId: null,
};

describe("the framed panel", () => {
  it("puts the top strip in the center and the right rail beside it", () => {
    const html = renderToStaticMarkup(
      createElement(
        PanelActionsProvider,
        { actions },
        createElement(PanelChrome, {
          title: "Tabs",
          kind: "Tabs",
          panelType: "tabs",
          panelId: "group",
          tabs: group([tab("page"), tab("side", "right")]),
          onTabs: () => undefined,
          onCloseTab: () => undefined,
          children: "the page",
        }),
      ),
    );
    expect(html).toContain("is-framed");
    const well = html.indexOf("panel-well");
    const top = html.indexOf("panel-header edge-top");
    const body = html.indexOf("the page");
    const right = html.indexOf("panel-header edge-right");
    expect(well).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThan(well);
    expect(body).toBeGreaterThan(top);
    expect(right).toBeGreaterThan(body);
    expect(html).not.toContain("panel-header edge-left");
    expect(html.split('aria-label="Panel settings"').length - 1).toBe(1);
  });

  it("draws a checked strip that has no tabs, so a tab can be dropped there", () => {
    const html = renderToStaticMarkup(
      createElement(
        PanelActionsProvider,
        { actions },
        createElement(PanelChrome, {
          title: "Tabs",
          kind: "Tabs",
          panelType: "tabs",
          panelId: "group",
          tabs: { ...group([tab("page")]), strips: ["top", "right"] },
          onTabs: () => undefined,
          onCloseTab: () => undefined,
          children: "the page",
        }),
      ),
    );
    expect(html).toContain("is-framed");
    expect(html).toContain("panel-header edge-top");
    expect(html).toContain("panel-header edge-right");
    expect(html).not.toContain("panel-header edge-left");
  });

  it("turns names down the side tabs and leaves the top strip horizontal", () => {
    const html = renderToStaticMarkup(
      createElement(
        PanelActionsProvider,
        { actions },
        createElement(PanelChrome, {
          title: "Tabs",
          kind: "Tabs",
          panelType: "tabs",
          panelId: "group",
          tabs: {
            ...group([tab("page"), tab("side", "right"), tab("log", "bottom")]),
            verticalNames: true,
          },
          onTabs: () => undefined,
          onCloseTab: () => undefined,
          children: "the page",
        }),
      ),
    );
    const top = headerChunk(html, "top");
    const bottom = headerChunk(html, "bottom");
    const right = headerChunk(html, "right");
    expect(right).toContain("is-vertical-names");
    expect(right).toContain("is-down");
    expect(top).not.toContain("is-vertical-names");
    expect(top).not.toContain("is-down");
    expect(bottom).not.toContain("is-vertical-names");
    expect(bottom).not.toContain("is-down");
  });

  it("keeps a top tab horizontal when a collapsed side bar shows it", () => {
    const html = renderToStaticMarkup(
      createElement(
        PanelActionsProvider,
        { actions },
        createElement(PanelChrome, {
          title: "Tabs",
          kind: "Tabs",
          panelType: "tabs",
          panelId: "group",
          collapsed: true,
          tabs: {
            type: "tabs",
            edge: "right",
            active: "down",
            verticalNames: true,
            tabs: [
              { id: "down", title: "Down", panel: { type: "blank" } },
              { id: "across", title: "Across", edge: "top", panel: { type: "blank" } },
            ],
          },
          onTabs: () => undefined,
          onCloseTab: () => undefined,
        }),
      ),
    );
    expect(html).not.toContain("is-vertical-names");
    expect(classBefore(html, "Down")).toContain("is-down");
    expect(classBefore(html, "Across")).not.toContain("is-down");
  });

  it("draws every tab on the group edge while collapsed", () => {
    const html = renderToStaticMarkup(
      createElement(
        PanelActionsProvider,
        { actions },
        createElement(PanelChrome, {
          title: "Tabs",
          kind: "Tabs",
          panelType: "tabs",
          panelId: "group",
          collapsed: true,
          tabs: group([tab("page"), tab("side", "right")]),
          onTabs: () => undefined,
          onCloseTab: () => undefined,
        }),
      ),
    );
    expect(html).not.toContain("is-framed");
    expect(html).toContain("edge-top");
    expect(html).toContain("page");
    expect(html).toContain("side");
  });
});

function headerChunk(html: string, edge: string): string {
  const marker = `panel-header edge-${edge}`;
  const start = html.indexOf(marker);
  if (start < 0) return "";
  const next = html.indexOf("panel-header", start + marker.length);
  return html.slice(start, next === -1 ? undefined : next);
}

function classBefore(html: string, label: string): string {
  const at = html.indexOf(`aria-label="${label}"`);
  if (at < 0) return "";
  return html.slice(html.lastIndexOf("class=", at), at);
}

function listMoved(node: LayoutNode): LayoutNode[] {
  if (node.type === "panel") return [node];
  if (node.type === "split") return [...listMoved(node.first), ...listMoved(node.second)];
  return node.cells.flatMap((cell) => listMoved(cell.node ?? { type: "panel", id: cell.id, panel: cell.panel ?? { type: "blank" } }));
}
