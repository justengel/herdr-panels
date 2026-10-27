import { describe, expect, it } from "vitest";
import { markWorkspaceFocused, preferPendingPane, preferPendingSpace } from "../src/spaceLayout";
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

  it("keeps a requested pane focused until Herdr agrees", () => {
    const stale = markWorkspaceFocused(runtime, "ws-a", "w2:p1");
    const next = preferPendingPane(stale, "w1:p1");
    expect(next.focusedPaneId).toBe("w1:p1");
    expect(next.panes.find((pane) => pane.paneId === "w1:p1")?.focused).toBe(true);
    expect(preferPendingPane(runtime, "w1:p1")).toBe(runtime);
    expect(preferPendingPane(runtime, null)).toBe(runtime);
  });
});
