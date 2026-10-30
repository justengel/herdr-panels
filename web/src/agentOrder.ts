export interface AgentListRow {
  paneId: string;
  workspaceId: string;
  status: string;
  title: string;
  /** Herdr panes tab, set only when this space has more than one tab. */
  tabLabel?: string;
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
    tabId?: string;
    agentStatus?: string;
    agent?: string | null;
    agentName?: string | null;
  }[],
  workspaces: { workspaceId: string; label: string }[],
  tabs: { tabId: string; workspaceId: string; label: string }[] = [],
): AgentListRow[] {
  const listed = new Set(agents.map((agent) => agent.paneId));
  const tabCount = new Map<string, number>();
  const tabName = new Map<string, string>();
  const seenTabs = new Set<string>();
  for (const tab of tabs) {
    if (!tab.tabId || seenTabs.has(tab.tabId)) continue;
    seenTabs.add(tab.tabId);
    tabName.set(tab.tabId, tab.label);
    if (!tab.workspaceId) continue;
    tabCount.set(tab.workspaceId, (tabCount.get(tab.workspaceId) ?? 0) + 1);
  }
  const titleFor = (workspaceId: string | undefined, paneId: string, tabId: string | undefined) => {
    const space = workspaces.find((item) => item.workspaceId === workspaceId);
    const name = space?.label || workspaceId || paneId;
    const several = Boolean(workspaceId && (tabCount.get(workspaceId) ?? 0) > 1);
    const tab = several && tabId ? tabName.get(tabId)?.trim() : "";
    if (!tab) return { title: name };
    return { title: `${name} · ${tab}`, tabLabel: tab };
  };
  return [
    ...agents.map((agent) => {
      const pane = panes.find((item) => item.paneId === agent.paneId);
      return {
        paneId: agent.paneId,
        workspaceId: pane?.workspaceId ?? "",
        status: agent.agentStatus || "unknown",
        ...titleFor(pane?.workspaceId, agent.paneId, pane?.tabId),
      };
    }),
    ...panes
      .filter((pane) => (pane.agent || pane.agentName) && !listed.has(pane.paneId))
      .map((pane) => ({
        paneId: pane.paneId,
        workspaceId: pane.workspaceId ?? "",
        status: pane.agentStatus || "unknown",
        ...titleFor(pane.workspaceId, pane.paneId, pane.tabId),
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
