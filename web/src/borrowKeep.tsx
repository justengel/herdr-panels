import { useEffect, useState } from "react";
import { LayoutView } from "./components/LayoutView";
import type { AgentView, LayoutNode, PaneView, PanelConfig, PanelNode, WorkspaceView } from "./types";

export interface KeptPanel {
  node: PanelNode;
  fromSpace?: string;
}

export function BorrowSlot({ panelId }: { panelId: string }) {
  return <div className="borrow-slot" data-borrow-slot={panelId} />;
}

export function BorrowKeeper({
  panels,
  showing,
  panes,
  workspaces,
  agents,
  layoutId,
  onPanel,
  onFocusPane,
}: {
  panels: KeptPanel[];
  showing: ReadonlySet<string>;
  panes: PaneView[];
  workspaces: WorkspaceView[];
  agents: AgentView[];
  layoutId: string;
  onPanel: (id: string, panel: PanelConfig, retitle?: boolean) => void;
  onFocusPane: (paneId: string) => void;
}) {
  return (
    <div className="borrow-keeper">
      {panels.map((item) => (
        <KeptFrame
          key={item.node.id}
          item={item}
          visible={showing.has(item.node.id)}
          panes={panes}
          workspaces={workspaces}
          agents={agents}
          layoutId={layoutId}
          onPanel={onPanel}
          onFocusPane={onFocusPane}
        />
      ))}
    </div>
  );
}

function KeptFrame({
  item,
  visible,
  panes,
  workspaces,
  agents,
  layoutId,
  onPanel,
  onFocusPane,
}: {
  item: KeptPanel;
  visible: boolean;
  panes: PaneView[];
  workspaces: WorkspaceView[];
  agents: AgentView[];
  layoutId: string;
  onPanel: (id: string, panel: PanelConfig, retitle?: boolean) => void;
  onFocusPane: (paneId: string) => void;
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!host) return;
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      if (!visible) {
        host.hidden = true;
        return;
      }
      const slot = document.querySelector<HTMLElement>(`[data-borrow-slot="${CSS.escape(item.node.id)}"]`);
      if (!slot) {
        host.hidden = true;
        return;
      }
      const rect = slot.getBoundingClientRect();
      host.hidden = false;
      host.style.left = `${rect.left}px`;
      host.style.top = `${rect.top}px`;
      host.style.width = `${rect.width}px`;
      host.style.height = `${rect.height}px`;
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [host, item.node.id, visible]);

  const node: LayoutNode = item.node;
  return (
    <div ref={setHost} className="borrow-float" hidden={!visible}>
      <LayoutView
        node={node}
        panes={panes}
        workspaces={workspaces}
        agents={agents}
        layoutId={layoutId}
        pending={{}}
        onConsume={() => undefined}
        onRatio={() => undefined}
        onTracks={() => undefined}
        onPanel={onPanel}
        onCloseTab={() => undefined}
        onFocusPane={onFocusPane}
        borrowed
        fromSpace={item.fromSpace}
      />
    </div>
  );
}
