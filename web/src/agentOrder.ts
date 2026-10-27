export interface AgentListRow {
  paneId: string;
  workspaceId: string;
  status: string;
  title: string;
}

export type AgentSort = "spaces" | "priority";

const ATTENTION = ["blocked", "working", "idle", "done", "unknown"];

export function agentSortLabel(sort: string): string {
  return sort === "priority" ? "priority" : "grouped";
}

export function nextAgentSort(sort: string): AgentSort {
  return sort === "priority" ? "spaces" : "priority";
}

export function listedAgents(
  agents: { paneId: string; agentStatus?: string }[],
  panes: {
    paneId: string;
    workspaceId?: string;
    agentStatus?: string;
    agent?: string | null;
    agentName?: string | null;
  }[],
  workspaces: { workspaceId: string; label: string }[],
): AgentListRow[] {
  const listed = new Set(agents.map((agent) => agent.paneId));
  const titleFor = (workspaceId: string | undefined, paneId: string) => {
    const space = workspaces.find((item) => item.workspaceId === workspaceId);
    return space?.label || workspaceId || paneId;
  };
  return [
    ...agents.map((agent) => {
      const pane = panes.find((item) => item.paneId === agent.paneId);
      return {
        paneId: agent.paneId,
        workspaceId: pane?.workspaceId ?? "",
        status: agent.agentStatus || "unknown",
        title: titleFor(pane?.workspaceId, agent.paneId),
      };
    }),
    ...panes
      .filter((pane) => (pane.agent || pane.agentName) && !listed.has(pane.paneId))
      .map((pane) => ({
        paneId: pane.paneId,
        workspaceId: pane.workspaceId ?? "",
        status: pane.agentStatus || "unknown",
        title: titleFor(pane.workspaceId, pane.paneId),
      })),
  ];
}

export function orderAgents<T extends AgentListRow>(rows: T[], sort: string, workspaceOrder: string[]): T[] {
  const place = new Map(workspaceOrder.map((id, index) => [id, index]));
  const seen = new Map(rows.map((row, index) => [row.paneId, index]));
  const attention = (status: string) => {
    const at = ATTENTION.indexOf(status);
    return at < 0 ? ATTENTION.length : at;
  };
  const space = (id: string) => place.get(id) ?? workspaceOrder.length;
  return [...rows].sort((left, right) => {
    if (sort === "priority") {
      const byStatus = attention(left.status) - attention(right.status);
      if (byStatus) return byStatus;
    }
    const bySpace = space(left.workspaceId) - space(right.workspaceId);
    if (bySpace) return bySpace;
    const byTitle = left.title.localeCompare(right.title);
    if (byTitle) return byTitle;
    return (seen.get(left.paneId) ?? 0) - (seen.get(right.paneId) ?? 0);
  });
}
