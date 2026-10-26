import { useEffect, useRef, useState } from "react";
import type { AgentView, PaneView, WorkspaceView } from "../../types";
import { useHost } from "../../host";
import { agentSortLabel, nextAgentSort, orderAgents, type AgentSort } from "../../agentOrder";
import { StatusMark } from "../StatusMark";

interface AgentRow {
  paneId: string;
  workspaceId: string;
  status: string;
  title: string;
  kind: string;
}

export function AgentsView({
  agents,
  panes,
  workspaces,
  onFocus,
}: {
  agents: AgentView[];
  panes: PaneView[];
  workspaces: WorkspaceView[];
  onFocus: (paneId: string) => void;
}) {
  const host = useHost();
  const symbols = host.config?.settings.find((field) => field.key === "status_indicators")?.value === "symbols";
  const configured = host.config?.settings.find((field) => field.key === "agent_panel_sort")?.value;
  const stored: AgentSort = configured === "priority" ? "priority" : "spaces";
  const [override, setOverride] = useState<AgentSort | null>(null);
  const sort = override ?? stored;
  const sortRef = useRef(sort);
  const saving = useRef(Promise.resolve());
  sortRef.current = sort;
  useEffect(() => {
    if (override && configured === override) setOverride(null);
  }, [configured, override]);

  const listed = new Set(agents.map((agent) => agent.paneId));
  const rows: AgentRow[] = [
    ...agents.map((agent) => {
      const pane = panes.find((item) => item.paneId === agent.paneId);
      const space = workspaces.find((item) => item.workspaceId === pane?.workspaceId);
      return {
        paneId: agent.paneId,
        workspaceId: pane?.workspaceId ?? "",
        status: agent.agentStatus || "unknown",
        title: space?.label || pane?.workspaceId || agent.paneId,
        kind: agent.agent || agent.name || agent.title || "",
      };
    }),
    ...panes
      .filter((pane) => (pane.agent || pane.agentName) && !listed.has(pane.paneId))
      .map((pane) => {
        const space = workspaces.find((item) => item.workspaceId === pane.workspaceId);
        return {
          paneId: pane.paneId,
          workspaceId: pane.workspaceId,
          status: pane.agentStatus || "unknown",
          title: space?.label || pane.workspaceId || pane.paneId,
          kind: pane.agent || pane.agentName || pane.title || "",
        };
      }),
  ];
  const ordered = orderAgents(rows, sort, workspaces.map((space) => space.workspaceId));

  function cycle() {
    const next = nextAgentSort(sortRef.current);
    sortRef.current = next;
    setOverride(next);
    saving.current = saving.current.then(() => host.setAgentOrder(next)).catch(() => undefined);
  }

  return (
    <div className="side-pane">
      <div className="side-toolbar">
        <button
          type="button"
          className="side-mode"
          aria-label={sort === "priority" ? "Agent order, priority" : "Agent order, grouped"}
          title={sort === "priority" ? "Attention order" : "Grouped by space"}
          onClick={cycle}
        >
          {agentSortLabel(sort)}
        </button>
      </div>
      <ul className="side-list">
        {ordered.map((agent) => (
          <li key={agent.paneId}>
            <button type="button" className="agent-row" onClick={() => onFocus(agent.paneId)}>
              <StatusMark status={agent.status} symbols={symbols} />
              <span className="agent-copy">
                <span className="agent-name">{agent.title}</span>
                {agent.kind ? <span className="agent-kind">{agent.kind}</span> : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
