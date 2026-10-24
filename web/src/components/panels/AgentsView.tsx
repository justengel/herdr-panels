import type { AgentView, PaneView, WorkspaceView } from "../../types";

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
  const listed = new Set(agents.map((agent) => agent.paneId));
  const rows = [
    ...agents,
    ...panes
      .filter((pane) => (pane.agent || pane.agentName) && !listed.has(pane.paneId))
      .map((pane) => ({
        paneId: pane.paneId,
        name: pane.agentName,
        agent: pane.agent,
        agentStatus: pane.agentStatus,
        title: pane.title,
      })),
  ];
  return (
    <div className="side-pane">
      <div className="side-heading">
        <span>agents</span>
        <span className="side-mode">grouped</span>
      </div>
      <ul className="side-list">
        {rows.map((agent) => {
          const pane = panes.find((item) => item.paneId === agent.paneId);
          const space = workspaces.find((item) => item.workspaceId === pane?.workspaceId);
          const title = space?.label || pane?.workspaceId || agent.paneId;
          const kind = agent.agent || agent.name || agent.title || "";
          const status = agent.agentStatus || "unknown";
          return (
            <li key={agent.paneId}>
              <button type="button" className="agent-row" onClick={() => onFocus(agent.paneId)}>
                <span className={`dot status-${status}`} aria-hidden="true" />
                <span className="agent-copy">
                  <span className="agent-name">{title}</span>
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
