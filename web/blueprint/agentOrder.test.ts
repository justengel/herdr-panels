import { describe, expect, it } from "vitest";
import { agentSortLabel, listedAgents, nextAgentSort, orderAgents, type AgentListRow } from "../src/agentOrder";

const rows: AgentListRow[] = [
  { paneId: "p-work", workspaceId: "beta", status: "working", title: "beta" },
  { paneId: "p-block", workspaceId: "alpha", status: "blocked", title: "alpha" },
  { paneId: "p-done", workspaceId: "alpha", status: "done", title: "alpha done" },
];

describe("the agents heading cycles the same orders as the Herdr sidebar", () => {
  it("calls the space order grouped and the attention order priority", () => {
    expect(agentSortLabel("spaces")).toBe("grouped");
    expect(agentSortLabel("priority")).toBe("priority");
    expect(agentSortLabel("workspaces")).toBe("grouped");
    expect(nextAgentSort("spaces")).toBe("priority");
    expect(nextAgentSort("priority")).toBe("spaces");
  });

  it("keeps agents from the same space together, in the spaces list order", () => {
    const ordered = orderAgents(rows, "spaces", ["alpha", "beta"]);
    expect(ordered.map((row) => row.paneId)).toEqual(["p-block", "p-done", "p-work"]);
  });

  it("includes a pane that has an agent even when the agent list omitted it", () => {
    const listed = listedAgents(
      [{ paneId: "p-block", agentStatus: "blocked", agent: "claude" }],
      [
        { paneId: "p-block", workspaceId: "alpha", agentStatus: "blocked", agent: "claude" },
        { paneId: "p-extra", workspaceId: "beta", agentStatus: "working", agentName: "cursor" },
      ],
      [
        { workspaceId: "alpha", label: "Alpha" },
        { workspaceId: "beta", label: "Beta" },
      ],
    );
    expect(listed.map((row) => [row.paneId, row.title])).toEqual([
      ["p-block", "Alpha"],
      ["p-extra", "Beta"],
    ]);
  });

  it("shows the Herdr tab beside the space when that space has several tabs", () => {
    const listed = listedAgents(
      [{ paneId: "p-general", agentStatus: "idle" }],
      [
        { paneId: "p-general", workspaceId: "panels", tabId: "t-general", agentStatus: "idle", agent: "cursor" },
        { paneId: "p-two", workspaceId: "panels", tabId: "t-two", agentStatus: "working", agentName: "cursor" },
        { paneId: "p-notes", workspaceId: "notes", tabId: "t-notes", agentStatus: "idle", agent: "claude" },
      ],
      [
        { workspaceId: "panels", label: "herdr-panels" },
        { workspaceId: "notes", label: "notes" },
      ],
      [
        { tabId: "t-general", workspaceId: "panels", label: "general" },
        { tabId: "t-two", workspaceId: "panels", label: "2" },
        { tabId: "t-notes", workspaceId: "notes", label: "welcome" },
      ],
    );
    expect(listed.map((row) => [row.paneId, row.title])).toEqual([
      ["p-general", "herdr-panels · general"],
      ["p-two", "herdr-panels · 2"],
      ["p-notes", "notes"],
    ]);
  });

  it("keeps the space name when Herdr sent a blank tab title", () => {
    const listed = listedAgents(
      [{ paneId: "p-blank", agentStatus: "idle" }],
      [
        { paneId: "p-blank", workspaceId: "panels", tabId: "t-blank", agentStatus: "idle" },
        { paneId: "p-named", workspaceId: "panels", tabId: "t-named", agentStatus: "idle", agent: "cursor" },
      ],
      [{ workspaceId: "panels", label: "herdr-panels" }],
      [
        { tabId: "t-blank", workspaceId: "panels", label: "  " },
        { tabId: "t-named", workspaceId: "panels", label: "general" },
      ],
    );
    expect(listed.map((row) => [row.paneId, row.title])).toEqual([
      ["p-blank", "herdr-panels"],
      ["p-named", "herdr-panels · general"],
    ]);
  });

  it("puts an agent that needs attention ahead of the others", () => {
    const ordered = orderAgents(rows, "priority", ["alpha", "beta"]);
    expect(ordered.map((row) => row.paneId)).toEqual(["p-block", "p-work", "p-done"]);
  });
});
