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
