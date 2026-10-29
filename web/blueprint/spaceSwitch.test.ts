import { describe, expect, it } from "vitest";
import { markWorkspaceFocused, preferPendingPane, preferPendingSpace, spaceReturnFocus } from "../src/spaceLayout";
import type { RuntimeSnapshot } from "../src/types";

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

describe("space switch while Herdr catches up", () => {
  it("keeps the pending space focused when a stale runtime snapshot arrives", () => {
    const next = preferPendingSpace(runtime, "ws-b");
    expect(next.focusedWorkspaceId).toBe("ws-b");
    expect(next.workspaces.find((space) => space.workspaceId === "ws-b")?.focused).toBe(true);
    expect(next.panes.find((pane) => pane.paneId === "w2:p1")?.focused).toBe(true);
  });

  it("passes through when the server already matches the pending space", () => {
    const confirmed = markWorkspaceFocused(runtime, "ws-b", "w2:p1");
    expect(preferPendingSpace(confirmed, "ws-b")).toBe(confirmed);
  });

  it("passes through when nothing is pending", () => {
    expect(preferPendingSpace(runtime, null)).toBe(runtime);
  });

  it("uses the requested pane when that space has several", () => {
    const two = {
      ...runtime,
      panes: [...runtime.panes, { ...runtime.panes[1], paneId: "w2:p2", focused: false, title: "b2" }],
    };
    const next = preferPendingSpace(two, "ws-b", "w2:p2");
    expect(next.focusedWorkspaceId).toBe("ws-b");
    expect(next.focusedPaneId).toBe("w2:p2");
    expect(next.panes.find((pane) => pane.paneId === "w2:p2")?.focused).toBe(true);
  });

  it("returns to the space's active tab instead of its first pane", () => {
    const left = {
      ...runtime,
      focusedWorkspaceId: "ws-b",
      focusedPaneId: "w2:p1",
      focusedTabId: "ws-b:t1",
      workspaces: [
        { workspaceId: "ws-a", label: "A", focused: false, activeTabId: "ws-a:t3" },
        { workspaceId: "ws-b", label: "B", focused: true, activeTabId: "ws-b:t1" },
      ],
      panes: [
        { ...runtime.panes[0], tabId: "ws-a:t1", focused: false },
        { ...runtime.panes[0], paneId: "w1:p3", tabId: "ws-a:t3", focused: false, title: "third" },
        { ...runtime.panes[1], tabId: "ws-b:t1", focused: true },
      ],
    };
    const next = preferPendingSpace(left, "ws-a");
    expect(next.focusedTabId).toBe("ws-a:t3");
    expect(next.focusedPaneId).toBe("w1:p3");
    expect(next.panes.find((pane) => pane.paneId === "w1:p3")?.focused).toBe(true);
    expect(spaceReturnFocus(left, "ws-a").request).toEqual({ workspaceId: "ws-a" });
    expect(spaceReturnFocus(left, "ws-a").paneId).toBe("w1:p3");
    expect(spaceReturnFocus(left, "ws-a", "w1:p1").request).toEqual({ paneId: "w1:p1" });
  });

  it("keeps a requested pane focused until Herdr agrees", () => {
    const stale = markWorkspaceFocused(runtime, "ws-a", "w2:p1");
    const next = preferPendingPane(stale, "w1:p1");
    expect(next.focusedPaneId).toBe("w1:p1");
    expect(next.panes.find((pane) => pane.paneId === "w1:p1")?.focused).toBe(true);
    expect(preferPendingPane(runtime, "w1:p1")).toBe(runtime);
    expect(preferPendingPane(runtime, null)).toBe(runtime);
  });
});
