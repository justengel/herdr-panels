import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindTerminalPane,
  layoutForSpace,
  loadSpaceLayout,
  markWorkspaceFocused,
  mergePins,
  saveSpaceLayout,
  seedSpaceLayout,
  stripPins,
} from "../src/spaceLayout";
import { upsertPin } from "../src/pins";
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
        first: { title: "Spaces", panel: { type: "files" } },
        second: { title: "Agents", panel: { type: "agents" } },
      },
      second: { title: "Terminal", panel: { type: "herdr", paneId: null } },
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

  it("strips pinned panels from a space layout before saving", () => {
    upsertPin({
      id: "notes",
      title: "Notes",
      panel: { type: "markdown", path: "a.md" },
      mode: "all",
      spaces: [],
    });
    const live = mergePins(terminal, "ws-a");
    expect(stripPins(live, "ws-a")).toEqual(terminal);
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

  it("binds the terminal panel to a pane id", () => {
    expect(bindTerminalPane(terminal, "w2:p9")).toMatchObject({
      id: "terminal",
      panel: { type: "herdr", paneId: "w2:p9" },
    });
  });
});
