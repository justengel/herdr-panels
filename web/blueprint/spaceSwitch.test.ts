import { describe, expect, it } from "vitest";
import { markWorkspaceFocused, preferPendingSpace } from "../src/spaceLayout";
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
});
