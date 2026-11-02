import { describe, expect, it } from "vitest";
import { addPanelTab, assignContent, closePanelTab, findPanel, groupOnBar, moveTab, normalizeLayout } from "../src/layoutEdit";
import { dropPlace } from "../src/panelDrop";
import { chevronTurn, collapseBasis, iconRail, railBasis, showTabClose, splitPaneFlex, tabFace, tabNumber } from "../src/tabFace";
import { TAB_ICONS } from "../src/tabIcons";
import { showViewer } from "../src/viewMenu";
import type { LayoutNode } from "../src/types";

const desk: LayoutNode = {
  type: "split",
  direction: "row",
  ratio: 0.5,
  first: {
    type: "panel",
    id: "alpha",
    title: "Alpha",
    panel: {
      type: "tabs",
      edge: "left",
      active: "a",
      tabs: [
        { id: "a", title: "One", icon: "star", panel: { type: "markdown", path: "a.md" } },
        { id: "b", title: "Two", panel: { type: "chat", paneId: null } },
      ],
    },
  },
  second: {
    type: "panel",
    id: "beta",
    title: "Beta",
    icon: "folder",
    panel: { type: "explorer", path: "docs" },
  },
};

describe("dropping on a panel bar", () => {
  const rect = { left: 0, top: 0, width: 200, height: 200 };
  const bar = { left: 0, top: 0, width: 200, height: 34 };

  it("groups when the pointer is on the bar, even along the top edge", () => {
    expect(dropPlace(rect, 20, 10, bar)).toBe("bar");
    expect(dropPlace(rect, 20, 10, null)).toBe("above");
  });

  it("still uses the side and center zones outside the bar", () => {
    expect(dropPlace(rect, 10, 100, bar)).toBe("left");
    expect(dropPlace(rect, 100, 100, bar)).toBe("center");
  });
});

describe("grouping on a bar", () => {
  it("flattens a dragged group onto the target instead of nesting tabs", () => {
    const grouped = groupOnBar(desk, "alpha", "beta");
    expect(findPanel(grouped, "alpha")).toBeNull();
    const beta = findPanel(grouped, "beta");
    expect(beta?.panel.type).toBe("tabs");
    if (beta?.panel.type !== "tabs") return;
    expect(beta.panel.tabs.map((tab) => tab.panel.type)).toEqual(["explorer", "markdown", "chat"]);
    expect(beta.panel.tabs.some((tab) => tab.panel.type === "tabs")).toBe(false);
    expect(beta.panel.tabs[0]).toMatchObject({ title: "Beta", icon: "folder" });
    expect(beta.panel.tabs[1]).toMatchObject({ title: "One", icon: "star" });
    expect(beta.panel.edge).toBe("top");
  });

  it("keeps the target edge when the target is already a group", () => {
    const grouped = groupOnBar(desk, "beta", "alpha");
    const alpha = findPanel(grouped, "alpha");
    expect(alpha?.panel.type).toBe("tabs");
    if (alpha?.panel.type !== "tabs") return;
    expect(alpha.panel.edge).toBe("left");
    expect(alpha.panel.tabs.map((tab) => tab.title)).toEqual(["One", "Two", "Beta"]);
  });

  it("leaves the desk alone when the result would pass 24 tabs", () => {
    const tabs = Array.from({ length: 24 }, (_, index) => ({
      id: `t${index}`,
      title: `T${index}`,
      panel: { type: "blank" as const },
    }));
    const full: LayoutNode = {
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: {
        type: "panel",
        id: "full",
        title: "Full",
        panel: { type: "tabs", edge: "top", active: "t0", tabs },
      },
      second: { type: "panel", id: "extra", title: "Extra", panel: { type: "blank" } },
    };
    expect(groupOnBar(full, "extra", "full")).toBe(full);
  });

  it("keeps the name an untitled panel was showing", () => {
    const desk: LayoutNode = {
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: {
        type: "panel",
        id: "files",
        title: null,
        panel: { type: "explorer", path: "C:/projects/herdr-panels" },
      },
      second: { type: "panel", id: "notes", title: "Notes", panel: { type: "markdown", path: "a.md" } },
    };
    const grouped = groupOnBar(desk, "files", "notes");
    const notes = findPanel(grouped, "notes");
    expect(notes?.panel.type).toBe("tabs");
    if (notes?.panel.type !== "tabs") return;
    expect(notes.panel.tabs.map((tab) => tab.title)).toEqual(["Notes", "herdr-panels"]);
  });
});

describe("dragging a tab out", () => {
  it("joins another bar and keeps the icon", () => {
    const moved = moveTab(desk, "alpha", "a", "beta", "bar");
    expect(findPanel(moved, "alpha")).toMatchObject({
      title: "Two",
      panel: { type: "chat", paneId: null },
    });
    const beta = findPanel(moved, "beta");
    expect(beta?.panel.type).toBe("tabs");
    if (beta?.panel.type !== "tabs") return;
    expect(beta.panel.tabs.map((tab) => tab.title)).toEqual(["Beta", "One"]);
    expect(beta.panel.tabs[1].icon).toBe("star");
  });

  it("becomes its own panel beside the target and keeps the icon", () => {
    const moved = moveTab(desk, "alpha", "a", "beta", "below");
    const created = findPanel(moved, "beta");
    expect(created?.panel.type).toBe("explorer");
    const panels = [findPanel(moved, "alpha")];
    const icon = moved.type === "split" ? findIcon(moved) : null;
    expect(icon).toMatchObject({ icon: "star", title: "One", panel: { type: "markdown", path: "a.md" } });
    expect(panels[0]).toMatchObject({ title: "Two", panel: { type: "chat", paneId: null } });
  });
});

describe("what a tab shows", () => {
  it("uses the id only when the name and the icon are both blank", () => {
    expect(tabNumber("tab-12")).toBe("12");
    expect(tabNumber("notes")).toBe("notes");
    expect(tabFace({ id: "tab-1", title: "  ", icon: "  " })).toEqual({
      label: "1",
      icon: null,
      iconOnly: false,
    });
    expect(tabFace({ id: "tab-3", title: "", icon: " terminal " })).toEqual({
      label: "",
      icon: "terminal",
      iconOnly: true,
    });
    expect(tabFace({ id: "tab-4", title: "Notes", icon: "note" }).label).toBe("Notes");
  });

  it("is a rail only on the side when every tab is an icon", () => {
    const icons = [
      { title: "", icon: "chat" },
      { title: "", icon: "file:C:/icons/term.png" },
    ];
    expect(iconRail("right", icons)).toBe(true);
    expect(iconRail("top", icons)).toBe(false);
    expect(iconRail("left", [...icons, { title: "Logs", icon: "list" }])).toBe(false);
  });

  it("shows tab ids when icons and names are both hidden", () => {
    const named = { id: "tab-2", title: "google.com", icon: "globe" };
    const bare = tabFace(named, false, false);
    expect(bare).toEqual({ label: "2", icon: null, iconOnly: false });
    expect(tabFace(named, true, false)).toEqual({ label: "google.com", icon: null, iconOnly: false });
    const side = [
      { title: "Files", icon: "folder" },
      { title: "Chat", icon: "chat" },
    ];
    expect(iconRail("right", side, false, false)).toBe(true);
    expect(railBasis("right", side, false, false)).toBe(36);
    expect(iconRail("right", side, false, true)).toBe(true);
    expect(railBasis("right", side, false, true)).toBe(42);
    expect(showTabClose("right", true)).toBe(false);
    expect(showTabClose("left", true)).toBe(false);
    expect(showTabClose("right", false)).toBe(true);
    expect(showTabClose("top", true)).toBe(true);
    expect(showTabClose("bottom", false)).toBe(true);
  });

  it("hides stored names and keeps an icon rail on the side", () => {
    const named = { id: "tab-2", title: "google.com", icon: "globe" };
    expect(tabFace(named).label).toBe("google.com");
    const hidden = tabFace(named, false);
    expect(hidden.label).toBe("");
    expect(hidden.icon).toBe("globe");
    expect(hidden.iconOnly).toBe(true);
    expect(tabFace({ id: "tab-2", title: "google.com" }, false).label).toBe("2");
    const side = [
      { title: "Files", icon: "folder" },
      { title: "Chat", icon: "chat" },
    ];
    expect(iconRail("right", side, false)).toBe(true);
    expect(iconRail("top", side, false)).toBe(false);
    expect(iconRail("left", [...side, { title: "Logs" }], false)).toBe(true);
  });

  it("points the chevron the way the panel will move", () => {
    expect(chevronTurn("top", false)).toBe("rotate(180deg)");
    expect(chevronTurn("top", true)).toBe("none");
    expect(chevronTurn("bottom", false)).toBe("none");
    expect(chevronTurn("bottom", true)).toBe("rotate(180deg)");
    expect(chevronTurn("right", false)).toBe("rotate(-90deg)");
    expect(chevronTurn("right", true)).toBe("rotate(90deg)");
    expect(chevronTurn("left", false)).toBe("rotate(90deg)");
    expect(chevronTurn("left", true)).toBe("rotate(-90deg)");
  });

  it("gives a collapsed bar's thickness to the matching split", () => {
    const top: LayoutNode = { type: "panel", id: "p", title: "P", collapsed: true, panel: { type: "blank" } };
    expect(collapseBasis(top, "column")).toBe(34);
    expect(collapseBasis(top, "row")).toBeNull();
    const rail: LayoutNode = {
      type: "panel",
      id: "p",
      collapsed: true,
      panel: {
        type: "tabs",
        edge: "right",
        active: "a",
        tabs: [{ id: "a", title: "", icon: "chat", panel: { type: "chat", paneId: null } }],
      },
    };
    expect(collapseBasis(rail, "row")).toBe(42);
    const named: LayoutNode = {
      type: "panel",
      id: "p",
      collapsed: true,
      panel: {
        type: "tabs",
        edge: "left",
        active: "a",
        tabs: [{ id: "a", title: "Chat", icon: "chat", panel: { type: "chat", paneId: null } }],
      },
    };
    expect(collapseBasis(named, "row")).toBe(168);
    const hiddenNames: LayoutNode = {
      type: "panel",
      id: "p",
      collapsed: true,
      panel: {
        type: "tabs",
        edge: "right",
        active: "a",
        showNames: false,
        tabs: [{ id: "a", title: "Chat", icon: "chat", panel: { type: "chat", paneId: null } }],
      },
    };
    expect(collapseBasis(hiddenNames, "row")).toBe(42);
    const numbers: LayoutNode = {
      type: "panel",
      id: "p",
      collapsed: true,
      panel: {
        type: "tabs",
        edge: "left",
        active: "tab-1",
        showNames: false,
        showIcons: false,
        tabs: [{ id: "tab-1", title: "Chat", icon: "chat", panel: { type: "chat", paneId: null } }],
      },
    };
    expect(collapseBasis(numbers, "row")).toBe(36);
  });

  it("lets the neighbor fill the split when a bar collapses", () => {
    expect(splitPaneFlex(0.43, null, 168)).toBe("1 1 0%");
    expect(splitPaneFlex(0.62, null, 34)).toBe("1 1 0%");
    expect(splitPaneFlex(0.43, 168, null)).toBe("0 0 168px");
    expect(splitPaneFlex(0.5, null, null)).toBe(0.5);
    expect(splitPaneFlex(0.4, 34, 168)).toBe("0 0 34px");
  });
});

describe("names and icons survive saving", () => {
  it("lets an unnamed panel become a tab with a blank title", () => {
    const grouped = addPanelTab({ type: "panel", id: "p", title: null, panel: { type: "blank" } }, "p");
    const panel = findPanel(grouped, "p");
    expect(panel?.panel.type).toBe("tabs");
    if (panel?.panel.type !== "tabs") return;
    expect(panel.panel.tabs[0].title).toBe("");
    expect(tabFace(panel.panel.tabs[0]).label).toBe("1");
    expect(panel.panel.tabs[1].title).toBe("");
  });

  it("keeps a tab icon when the group unwraps", () => {
    const note: LayoutNode = {
      type: "panel",
      id: "notes",
      title: "Notes",
      icon: "note",
      panel: { type: "markdown", path: "notes/welcome.md" },
    };
    const single = closePanelTab(addPanelTab(note, "notes"), "notes", "tab-2");
    expect(findPanel(single, "notes")).toMatchObject({ icon: "note", title: "Notes" });
    const loaded = normalizeLayout({
      type: "panel",
      id: "notes",
      title: "Notes",
      panel: {
        type: "tabs",
        edge: "top",
        active: "tab-1",
        tabs: [{ id: "tab-1", title: "Notes", icon: "note", panel: { type: "markdown", path: "a.md" } }],
      },
    });
    expect(loaded).toMatchObject({ icon: "note", panel: { type: "markdown", path: "a.md" } });
  });

  it("replaces a tab group instead of nesting one inside a tab", () => {
    const note: LayoutNode = {
      type: "panel",
      id: "notes",
      title: "Notes",
      panel: { type: "markdown", path: "notes/welcome.md" },
    };
    const grouped = addPanelTab(note, "notes");
    const current = findPanel(grouped, "notes");
    if (current?.panel.type !== "tabs") throw new Error("expected a group");
    const swapped = assignContent(grouped, "notes", {
      ...current.panel,
      tabs: [...current.panel.tabs].reverse(),
    });
    const panel = findPanel(swapped, "notes");
    expect(panel?.panel.type).toBe("tabs");
    if (panel?.panel.type !== "tabs") return;
    expect(panel.panel.tabs.some((tab) => tab.panel.type === "tabs")).toBe(false);
    expect(panel.panel.tabs[0].id).toBe("tab-2");
  });

  it("changes the tab that was clicked, not only the active one", () => {
    const group = {
      type: "tabs" as const,
      edge: "top" as const,
      active: "one",
      tabs: [
        { id: "one", title: "One", panel: { type: "markdown" as const, path: "a.md" } },
        { id: "two", title: "Two", panel: { type: "chat" as const, paneId: null } },
      ],
    };
    const next = showViewer(group, "agents", [], { tabId: "two" });
    expect(next.type).toBe("tabs");
    if (next.type !== "tabs") return;
    expect(next.tabs[0].panel).toMatchObject({ type: "markdown" });
    expect(next.tabs[1].panel).toMatchObject({ type: "agents" });
  });

  it("offers preset ids the layout can store", () => {
    const ids = Object.keys(TAB_ICONS);
    expect(ids.length).toBeGreaterThanOrEqual(48);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(id.length).toBeLessThanOrEqual(32);
      expect(id.startsWith("file")).toBe(false);
    }
  });
});

function findIcon(node: LayoutNode): LayoutNode | null {
  if (node.type === "panel") return node.icon === "star" ? node : null;
  if (node.type === "split") return findIcon(node.first) ?? findIcon(node.second);
  for (const cell of node.cells) {
    const hit = cell.node ? findIcon(cell.node) : null;
    if (hit) return hit;
  }
  return null;
}
