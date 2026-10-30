import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindTerminalPane,
  layoutForSpace,
  loadSpaceLayout,
  markWorkspaceFocused,
  mergePins,
  saveSpaceLayout,
  seedSpaceLayout,
  unpinEverywhere,
  unpinHere,
  closePinned,
} from "../src/spaceLayout";
import { findPin, upsertPin } from "../src/pins";
import type { LayoutNode, RuntimeSnapshot } from "../src/types";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

const terminal: LayoutNode = {
  type: "panel",
  id: "terminal",
  title: "Terminal",
  panel: { type: "herdr", paneId: "w1:p1" },
};

describe("space layouts", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });

  it("saves and loads a layout per space", () => {
    saveSpaceLayout("ws-a", terminal);
    expect(loadSpaceLayout("ws-a")).toEqual(terminal);
    expect(loadSpaceLayout("ws-b")).toBeNull();
  });

  it("seeds Spaces and Agents beside a terminal", () => {
    const seed = seedSpaceLayout();
    expect(seed).toMatchObject({
      type: "split",
      direction: "row",
      first: {
        type: "split",
        direction: "column",
        first: { title: null, panel: { type: "files" } },
        second: { title: null, panel: { type: "agents" } },
      },
      second: { title: null, panel: { type: "herdr", paneId: null } },
    });
  });

  it("stacks every missing pin in one left column", () => {
    upsertPin({
      id: "spaces",
      title: "Spaces",
      panel: { type: "files" },
      mode: "all",
      spaces: [],
    });
    upsertPin({
      id: "agents",
      title: "Agents",
      panel: { type: "agents" },
      mode: "all",
      spaces: [],
    });
    const merged = mergePins(terminal, "ws-a");
    expect(merged).toMatchObject({
      type: "split",
      direction: "row",
      first: {
        type: "split",
        direction: "column",
        first: { id: "agents", title: "Agents" },
        second: { id: "spaces", title: "Spaces" },
      },
      second: { id: "terminal" },
    });
  });

  it("merges all-space pins onto a layout without duplicating ids", () => {
    upsertPin({
      id: "notes",
      title: "Notes",
      panel: { type: "markdown", path: "a.md" },
      mode: "all",
      spaces: [],
    });
    const merged = mergePins(terminal, "ws-a");
    expect(merged.type).toBe("split");
    if (merged.type !== "split") return;
    expect(merged.first).toEqual({
      type: "panel",
      id: "notes",
      title: "Notes",
      panel: { type: "markdown", path: "a.md" },
    });
    expect(mergePins(merged, "ws-a")).toEqual(merged);
  });

  it("adds an all-spaces pin to a new space and leaves out an excluded space", () => {
    upsertPin({
      id: "notes",
      title: "Notes",
      panel: { type: "markdown", path: "a.md" },
      mode: "all",
      spaces: ["ws-a"],
    });
    const added = layoutForSpace("ws-new", terminal);
    expect(added.type).toBe("split");
    if (added.type !== "split") return;
    expect(added.first).toMatchObject({ id: "notes" });
    expect(layoutForSpace("ws-a", terminal)).toEqual(terminal);
  });

  it("skips chosen pins that do not apply", () => {
    upsertPin({
      id: "local",
      title: "Local",
      panel: { type: "explorer", path: "C:/work" },
      mode: "chosen",
      spaces: ["ws-b"],
    });
    expect(layoutForSpace("ws-a", terminal)).toEqual(terminal);
  });

  it("keeps a pin where this space placed it, and still adds it to a space that lacks it", () => {
    upsertPin({
      id: "notes",
      title: "Notes",
      panel: { type: "markdown", path: "a.md" },
      mode: "all",
      spaces: [],
    });
    const placed: LayoutNode = {
      type: "split",
      direction: "row",
      ratio: 0.72,
      first: terminal,
      second: {
        type: "panel",
        id: "notes",
        title: "Notes",
        panel: { type: "markdown", path: "a.md" },
      },
    };
    saveSpaceLayout("ws-a", placed);
    expect(loadSpaceLayout("ws-a")).toEqual(placed);
    expect(layoutForSpace("ws-a", terminal)).toEqual(placed);
    const other = layoutForSpace("ws-b", terminal);
    expect(other.type).toBe("split");
    if (other.type !== "split") return;
    expect(other.first).toMatchObject({ id: "notes" });
    expect(other.second).toEqual(terminal);
  });

  it("drops the panel from this space as soon as it is unpinned here", () => {
    upsertPin({
      id: "notes",
      title: "Notes",
      panel: { type: "markdown", path: "a.md" },
      mode: "all",
      spaces: [],
    });
    const placed: LayoutNode = {
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: terminal,
      second: {
        type: "panel",
        id: "notes",
        title: "Notes",
        panel: { type: "markdown", path: "a.md" },
      },
    };
    expect(unpinHere(placed, "notes", "ws-a", ["ws-a", "ws-b"])).toEqual(terminal);
    expect(findPin("notes")).toMatchObject({ mode: "all", spaces: ["ws-a"] });
  });

  it("keeps the panel when this was its only pinned space", () => {
    upsertPin({
      id: "notes",
      title: "Notes",
      panel: { type: "markdown", path: "a.md" },
      mode: "chosen",
      spaces: ["ws-a"],
    });
    const placed: LayoutNode = {
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: terminal,
      second: {
        type: "panel",
        id: "notes",
        title: "Notes",
        panel: { type: "markdown", path: "a.md" },
      },
    };
    expect(unpinHere(placed, "notes", "ws-a", ["ws-a", "ws-b"])).toBeNull();
    expect(findPin("notes")).toBeNull();
  });

  it("unpin everywhere removes the panel from every space", () => {
    upsertPin({
      id: "notes",
      title: "Notes",
      panel: { type: "markdown", path: "a.md" },
      mode: "all",
      spaces: [],
    });
    const placed: LayoutNode = {
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: terminal,
      second: {
        type: "panel",
        id: "notes",
        title: "Notes",
        panel: { type: "markdown", path: "a.md" },
      },
    };
    saveSpaceLayout("ws-a", placed);
    saveSpaceLayout("ws-b", placed);
    expect(unpinEverywhere(placed, "notes")).toEqual(terminal);
    expect(findPin("notes")).toBeNull();
    expect(loadSpaceLayout("ws-a")).toEqual(terminal);
    expect(loadSpaceLayout("ws-b")).toEqual(terminal);
  });

  it("unpin everywhere leaves Spaces, Agents, and panes where they are", () => {
    const natives: LayoutNode[] = [
      { type: "panel", id: "spaces", title: "Spaces", panel: { type: "files" } },
      { type: "panel", id: "agents", title: "Agents", panel: { type: "agents" } },
      { type: "panel", id: "terminal", title: "Terminal", panel: { type: "herdr", paneId: null } },
    ];
    for (const panel of natives) {
      upsertPin({
        id: panel.id,
        title: panel.title ?? panel.id,
        panel: panel.type === "panel" ? panel.panel : { type: "files" },
        mode: "all",
        spaces: [],
      });
      saveSpaceLayout("ws-a", panel);
      saveSpaceLayout("ws-b", panel);
      expect(unpinEverywhere(panel, panel.id)).toEqual(panel);
      expect(findPin(panel.id)).toBeNull();
      expect(loadSpaceLayout("ws-a")).toEqual(panel);
      expect(loadSpaceLayout("ws-b")).toEqual(panel);
    }
  });

  it("close unpins this space so the panel does not come back, and leaves it pinned elsewhere", () => {
    upsertPin({
      id: "notes",
      title: "Notes",
      panel: { type: "markdown", path: "a.md" },
      mode: "all",
      spaces: [],
    });
    const placed: LayoutNode = {
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: terminal,
      second: {
        type: "panel",
        id: "notes",
        title: "Notes",
        panel: { type: "markdown", path: "a.md" },
      },
    };
    saveSpaceLayout("ws-b", placed);
    expect(closePinned(placed, "notes", "ws-a", ["ws-a", "ws-b"])).toEqual(terminal);
    expect(findPin("notes")).toMatchObject({ mode: "all", spaces: ["ws-a"] });
    expect(loadSpaceLayout("ws-b")).toEqual(placed);
  });

  it("close of the last pinned space does not leave a copy behind", () => {
    upsertPin({
      id: "notes",
      title: "Notes",
      panel: { type: "markdown", path: "a.md" },
      mode: "chosen",
      spaces: ["ws-a"],
    });
    const placed: LayoutNode = {
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: terminal,
      second: {
        type: "panel",
        id: "notes",
        title: "Notes",
        panel: { type: "markdown", path: "a.md" },
      },
    };
    saveSpaceLayout("ws-b", placed);
    expect(closePinned(placed, "notes", "ws-a", ["ws-a", "ws-b"])).toEqual(terminal);
    expect(findPin("notes")).toBeNull();
    expect(loadSpaceLayout("ws-b")).toEqual(terminal);
  });

  it("drops a pin from a space it is not pinned to", () => {
    upsertPin({
      id: "notes",
      title: "Notes",
      panel: { type: "markdown", path: "a.md" },
      mode: "chosen",
      spaces: ["ws-a"],
    });
    const placed: LayoutNode = {
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: terminal,
      second: {
        type: "panel",
        id: "notes",
        title: "Notes",
        panel: { type: "markdown", path: "a.md" },
      },
    };
    expect(mergePins(placed, "ws-b")).toEqual(terminal);
    expect(mergePins(placed, "ws-a")).toEqual(placed);
  });

  it("carries the placed panel onto a space that is receiving the pin", () => {
    upsertPin({
      id: "notes",
      title: "Notes",
      panel: { type: "markdown", path: "a.md" },
      mode: "all",
      spaces: [],
    });
    const placed: LayoutNode = {
      type: "split",
      direction: "row",
      ratio: 0.72,
      first: terminal,
      second: {
        type: "panel",
        id: "notes",
        title: "Renamed",
        panel: { type: "markdown", path: "b.md" },
      },
    };
    saveSpaceLayout("ws-a", placed);
    const other = layoutForSpace("ws-b", terminal);
    expect(other.type).toBe("split");
    if (other.type !== "split" || other.first.type !== "panel") return;
    expect(other.first.title).toBe("Renamed");
    expect(other.first.panel).toEqual({ type: "markdown", path: "b.md" });
  });

  it("keeps the same pin id and title when merging onto another space", () => {
    upsertPin({
      id: "spaces",
      title: "Spaces",
      panel: { type: "files" },
      mode: "all",
      spaces: [],
    });
    const a = mergePins(terminal, "ws-a");
    const b = mergePins(terminal, "ws-b");
    expect(a.type).toBe("split");
    expect(b.type).toBe("split");
    if (a.type !== "split" || b.type !== "split") return;
    expect(a.first).toEqual(b.first);
    expect(a.first).toMatchObject({ id: "spaces", title: "Spaces" });
  });

  it("marks a workspace focused without waiting on Herdr", () => {
    const runtime: RuntimeSnapshot = {
      connected: true,
      socket: "",
      focusedWorkspaceId: "ws-a",
      focusedPaneId: "w1:p1",
      workspaces: [
        { workspaceId: "ws-a", label: "A", focused: true },
        { workspaceId: "ws-b", label: "B", focused: false },
      ],
      panes: [
        {
          paneId: "w1:p1",
          workspaceId: "ws-a",
          title: "a",
          cwd: null,
          cols: 80,
          rows: 24,
          focused: true,
        },
        {
          paneId: "w2:p1",
          workspaceId: "ws-b",
          title: "b",
          cwd: null,
          cols: 80,
          rows: 24,
          focused: false,
        },
      ],
      agents: [],
    };
    const next = markWorkspaceFocused(runtime, "ws-b", "w2:p1");
    expect(next.focusedWorkspaceId).toBe("ws-b");
    expect(next.workspaces.map((space) => [space.workspaceId, space.focused])).toEqual([
      ["ws-a", false],
      ["ws-b", true],
    ]);
    expect(next.panes.map((pane) => [pane.paneId, pane.focused])).toEqual([
      ["w1:p1", false],
      ["w2:p1", true],
    ]);
  });

  it("leaves a side shell in place when binding the space terminal", () => {
    const root: LayoutNode = {
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: {
        type: "panel",
        id: "side",
        title: "Shell",
        panel: { type: "herdr", paneId: "w1:p9", scope: "pane" },
      },
      second: {
        type: "panel",
        id: "space",
        title: "Terminal",
        panel: { type: "herdr", paneId: "w1:p1" },
      },
    };
    const next = bindTerminalPane(root, "w1:p2");
    expect(next).toMatchObject({
      first: { panel: { type: "herdr", paneId: "w1:p9", scope: "pane" } },
      second: { panel: { type: "herdr", paneId: "w1:p2" } },
    });
  });

  it("leaves a desk of only terminal panels without adding Panes", () => {
    const root: LayoutNode = {
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: {
        type: "panel",
        id: "left",
        title: "Terminal",
        panel: { type: "herdr", paneId: "w1:p1", scope: "pane" },
      },
      second: {
        type: "panel",
        id: "right",
        title: "Terminal",
        panel: { type: "herdr", paneId: "w1:p2", scope: "pane" },
      },
    };
    expect(bindTerminalPane(root, "w1:p3")).toBe(root);
  });

  it("binds the terminal panel to a pane id", () => {
    expect(bindTerminalPane(terminal, "w2:p9")).toMatchObject({
      id: "terminal",
      panel: { type: "herdr", paneId: "w2:p9" },
    });
  });
});
