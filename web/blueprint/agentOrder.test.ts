import { describe, expect, it } from "vitest";
import { agentSortLabel, nextAgentSort, orderAgents, type AgentListRow } from "../src/agentOrder";

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

  it("puts an agent that needs attention ahead of the others", () => {
    const ordered = orderAgents(rows, "priority", ["alpha", "beta"]);
    expect(ordered.map((row) => row.paneId)).toEqual(["p-block", "p-work", "p-done"]);
  });
});
