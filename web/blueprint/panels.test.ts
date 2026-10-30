import { describe, expect, it } from "vitest";
import { addPanelTab, assignContent, closePanelTab, findPanel, normalizeLayout } from "../src/layoutEdit";
import type { LayoutNode } from "../src/types";

const note: LayoutNode = {
  type: "panel",
  id: "notes",
  title: "Notes",
  panel: { type: "markdown", path: "notes/welcome.md" },
};

describe("a panel becomes a tab group only while it has more than one tab", () => {
  it("keeps what the panel showed and adds a blank tab", () => {
    const grouped = addPanelTab(note, "notes");
    const panel = findPanel(grouped, "notes");
    expect(panel?.panel.type).toBe("tabs");
    if (panel?.panel.type !== "tabs") return;
    expect(panel.panel.active).toBe("tab-2");
    expect(panel.panel.tabs[0]).toMatchObject({
      title: "Notes",
      panel: { type: "markdown", path: "notes/welcome.md" },
    });
    expect(panel.panel.tabs[1]).toMatchObject({ title: "New tab", panel: { type: "iframe", url: "" } });
  });

  it("stays a group after one of three tabs closes", () => {
    const grouped = addPanelTab(addPanelTab(note, "notes"), "notes");
    const closed = closePanelTab(grouped, "notes", "tab-3");
    const panel = findPanel(closed, "notes");
    expect(panel?.panel.type).toBe("tabs");
    if (panel?.panel.type !== "tabs") return;
    expect(panel.panel.tabs).toHaveLength(2);
  });

  it("turns the remaining tab back into the whole panel", () => {
    const grouped = addPanelTab(note, "notes");
    const single = closePanelTab(grouped, "notes", "tab-2");
    expect(findPanel(single, "notes")).toMatchObject({
      id: "notes",
      title: "Notes",
      panel: { type: "markdown", path: "notes/welcome.md" },
    });
  });

  it("keeps the panel name when the remaining tab is still a blank page", () => {
    const grouped = addPanelTab(note, "notes");
    const single = closePanelTab(grouped, "notes", "tab-1");
    expect(findPanel(single, "notes")).toMatchObject({
      title: "Notes",
      panel: { type: "iframe", url: "", proxy: false },
    });
  });

  it("takes the remaining tab's name when that tab shows something else", () => {
    const grouped = assignContent(addPanelTab(note, "notes"), "notes", { type: "herdr", paneId: null }, true);
    const single = closePanelTab(grouped, "notes", "tab-1");
    expect(findPanel(single, "notes")).toMatchObject({
      title: "Panes",
      panel: { type: "herdr", paneId: null },
    });
  });

  it("retitles a plain panel when Spaces or Agents is assigned", () => {
    expect(assignContent(note, "notes", { type: "files" }, true)).toMatchObject({
      id: "notes",
      title: "Spaces",
      panel: { type: "files" },
    });
    expect(assignContent(note, "notes", { type: "agents" }, true)).toMatchObject({
      id: "notes",
      title: "Agents",
      panel: { type: "agents" },
    });
  });

  it("opens a saved one-tab group as a single panel", () => {
    const loaded = normalizeLayout({
      type: "panel",
      id: "notes",
      title: "Notes",
      panel: {
        type: "tabs",
        edge: "top",
        active: "tab-1",
        tabs: [{ id: "tab-1", title: "Terminal", panel: { type: "herdr", paneId: null } }],
      },
    });
    expect(loaded).toMatchObject({
      type: "panel",
      id: "notes",
      title: "Notes",
      panel: { type: "herdr", paneId: null },
    });
    const named = normalizeLayout({
      type: "panel",
      id: "notes",
      title: "Panel",
      panel: {
        type: "tabs",
        edge: "top",
        active: "tab-1",
        tabs: [{ id: "tab-1", title: "Welcome", panel: { type: "herdr", paneId: null } }],
      },
    });
    expect(named).toMatchObject({ title: "Welcome", panel: { type: "herdr", paneId: null } });
  });
});
