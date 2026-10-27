import { useEffect, useRef, useState } from "react";
import type { AgentView, PaneView, WorkspaceView } from "../../types";
import { useHost } from "../../host";
import { agentSortLabel, listedAgents, nextAgentSort, orderAgents, type AgentSort } from "../../agentOrder";
import { StatusMark } from "../StatusMark";

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

  const ordered = orderAgents(
    listedAgents(agents, panes, workspaces),
    sort,
    workspaces.map((space) => space.workspaceId),
  );

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
        {ordered.map((agent) => {
          const source = agents.find((item) => item.paneId === agent.paneId);
          const pane = panes.find((item) => item.paneId === agent.paneId);
          const kind = source?.agent || source?.name || source?.title || pane?.agent || pane?.agentName || pane?.title || "";
          const current = Boolean(pane?.focused);
          return (
            <li key={agent.paneId}>
              <button
                type="button"
                className={current ? "agent-row is-current" : "agent-row"}
                onClick={() => onFocus(agent.paneId)}
              >
                <StatusMark status={agent.status} symbols={symbols} />
                <span className="agent-copy">
                  <span className="agent-name">{agent.title}</span>
                  {kind ? <span className="agent-kind">{kind}</span> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
