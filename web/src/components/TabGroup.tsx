import { useRef, type ReactNode } from "react";
import { desktopHost } from "../desktopBrowser";
import { contentZoomsItself, usePanelScaleStyle } from "../displayZoom";
import { tabsToMount, warmBrowser } from "../tabWarm";
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
  const seen = useRef(new Set<string>());
  if (active && warmBrowser(active)) seen.current.add(active.id);
  const mounted = tabsToMount(group, seen.current);

  return (
    <div className="tab-body">
      {mounted.map((tab) => {
        // The group's zoom must not wrap a page that zooms its own document. That second zoom
        // moves the select box off the element, most visibly when a side strip insets the page.
        const ownPage = contentZoomsItself(tab.panel.type, desktopHost() !== null);
        return (
          <div key={tab.id} className="tab-pane" hidden={tab.id !== active?.id}>
            <div className="panel-scale" style={ownPage ? undefined : scaleStyle}>
              {renderContent(tab, (panel) => {
                const title = tab.title === "New tab" ? titleFor(panel) ?? tab.title : tab.title;
                onChange({
                  ...group,
                  tabs: group.tabs.map((item) => (item.id === tab.id ? { ...item, panel, title } : item)),
                });
              })}
            </div>
          </div>
        );
      })}
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
