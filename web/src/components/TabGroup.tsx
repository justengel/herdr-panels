import type { ReactNode } from "react";
import { usePanelScaleStyle } from "../displayZoom";
import type { PanelConfig, PanelTab, TabsPanel } from "../types";

export function TabGroup({
  group,
  onChange,
  renderContent,
}: {
  group: TabsPanel;
  onChange: (next: TabsPanel) => void;
  renderContent: (tab: PanelTab, onPanel: (panel: PanelConfig) => void) => ReactNode;
}) {
  const active = group.tabs.find((tab) => tab.id === group.active) ?? group.tabs[0];
  const scaleStyle = usePanelScaleStyle();

  return (
    <div className="tab-body">
      <div className="panel-scale" style={scaleStyle}>
        {active
          ? renderContent(active, (panel) => {
              const title = active.title === "New tab" ? titleFor(panel) ?? active.title : active.title;
              onChange({
                ...group,
                tabs: group.tabs.map((tab) => (tab.id === active.id ? { ...tab, panel, title } : tab)),
              });
            })
          : null}
      </div>
    </div>
  );
}

function titleFor(panel: PanelConfig): string | null {
  if (panel.type === "herdr") return panel.scope === "pane" ? "Terminal" : "Panes";
  if (panel.type === "files") return "Spaces";
  if (panel.type === "agents") return "Agents";
  if (panel.type === "iframe" || panel.type === "html") {
    if (panel.type === "iframe") {
      if (!panel.url) return "Browser";
      try {
        return new URL(panel.url).hostname || panel.url;
      } catch {
        return panel.url;
      }
    }
    return "Browser";
  }
  return null;
}
