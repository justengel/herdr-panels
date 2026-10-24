import { useEffect, useState, type CSSProperties } from "react";
import type { PaneView, TabView, WorkspaceView } from "../../types";
import { useDesk } from "../../desk";
import { HerdrTerminal } from "./HerdrTerminal";

export function SpaceMirror({
  panes,
  workspaces,
  onFocusPane,
}: {
  panes: PaneView[];
  workspaces: WorkspaceView[];
  onFocusPane: (paneId: string) => void;
}) {
  const desk = useDesk();
  const [picked, setPicked] = useState<string | null>(null);
  const workspaceId =
    desk.focusedWorkspaceId ||
    workspaces.find((item) => item.focused)?.workspaceId ||
    panes.find((item) => item.focused)?.workspaceId ||
    panes[0]?.workspaceId ||
    "";
  const spacePanes = panes.filter((pane) => pane.workspaceId === workspaceId);
  const listed = desk.tabs.filter((tab) => tab.workspaceId === workspaceId);
  const tabs: TabView[] = listed.length
    ? listed
    : uniqueTabs(spacePanes);
  useEffect(() => setPicked(null), [desk.focusedTabId]);
  const activeId =
    (picked && tabs.some((tab) => tab.tabId === picked) ? picked : null) ||
    (desk.focusedTabId && tabs.some((tab) => tab.tabId === desk.focusedTabId) ? desk.focusedTabId : null) ||
    tabs.find((tab) => tab.focused)?.tabId ||
    spacePanes.find((pane) => pane.focused)?.tabId ||
    tabs[0]?.tabId ||
    "";
  const visible = spacePanes.filter((pane) => pane.tabId === activeId);

  return (
    <div className="space-mirror">
      <div className="space-tabs" role="tablist" aria-label="Herdr tabs">
        {tabs.map((tab) => (
          <button
            key={tab.tabId}
            type="button"
            role="tab"
            aria-selected={tab.tabId === activeId}
            className={tab.tabId === activeId ? "on" : undefined}
            onClick={() => {
              setPicked(tab.tabId);
              desk.onFocusTab(tab.tabId);
            }}
          >
            {tab.label || tab.tabId}
          </button>
        ))}
      </div>
      <div className="space-panes">
        {visible.length === 0 ? <div className="empty">This space has no panes.</div> : null}
        {visible.map((pane) => (
          <div
            key={pane.paneId}
            className="space-pane"
            style={cellBox(pane, visible)}
            onPointerDown={() => onFocusPane(pane.paneId)}
          >
            <HerdrTerminal paneId={pane.paneId} />
          </div>
        ))}
      </div>
    </div>
  );
}

function uniqueTabs(panes: PaneView[]): TabView[] {
  const seen = new Set<string>();
  const tabs: TabView[] = [];
  for (const pane of panes) {
    if (!pane.tabId || seen.has(pane.tabId)) continue;
    seen.add(pane.tabId);
    tabs.push({
      tabId: pane.tabId,
      workspaceId: pane.workspaceId,
      label: String(tabs.length + 1),
      focused: pane.focused,
    });
  }
  return tabs;
}

function cellBox(pane: PaneView, panes: PaneView[]): CSSProperties {
  if (panes.length < 2) return { inset: 0 };
  const boxes = panes.map((item) => ({
    x: item.x ?? 0,
    y: item.y ?? 0,
    w: Math.max(1, item.cols ?? 1),
    h: Math.max(1, item.rows ?? 1),
  }));
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const spanX = Math.max(1, Math.max(...boxes.map((box) => box.x + box.w)) - minX);
  const spanY = Math.max(1, Math.max(...boxes.map((box) => box.y + box.h)) - minY);
  const box = boxes[panes.indexOf(pane)];
  return {
    left: `${((box.x - minX) / spanX) * 100}%`,
    top: `${((box.y - minY) / spanY) * 100}%`,
    width: `${(box.w / spanX) * 100}%`,
    height: `${(box.h / spanY) * 100}%`,
  };
}
