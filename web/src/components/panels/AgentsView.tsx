import { useEffect, useRef, useState } from "react";
import type { AgentView, PaneView, WorkspaceView } from "../../types";
import { useDesk } from "../../desk";
import { useHost } from "../../host";
import { agentSortLabel, listedAgents, nextAgentSort, orderAgents, type AgentListRow, type AgentSort } from "../../agentOrder";
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
  const desk = useDesk();
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
    listedAgents(agents, panes, workspaces, desk.tabs),
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
                  <AgentName title={agent.title} tabLabel={agent.tabLabel} />
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

function AgentName({ title, tabLabel }: Pick<AgentListRow, "title" | "tabLabel">) {
  const mark = tabLabel ? ` · ${tabLabel}` : "";
  if (!mark || !title.endsWith(mark)) return <span className="agent-name">{title}</span>;
  return (
    <span className="agent-name">
      {title.slice(0, -mark.length)}
      <span className="agent-tab">{mark}</span>
    </span>
  );
}
