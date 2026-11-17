import type { PanelTab, TabsPanel } from "./types";

/** A browser page that is worth keeping after the person leaves the tab. */
export function warmBrowser(tab: PanelTab): boolean {
  const panel = tab.panel;
  if (panel.type === "iframe") return panel.url.trim().length > 0;
  if (panel.type === "html") {
    const path = panel.path?.trim() ?? "";
    const inline = panel.inline?.trim() ?? "";
    return path.length > 0 || inline.length > 0;
  }
  return false;
}

/**
 * The active tab, plus browser tabs that have already been shown.
 * Leaving those mounted keeps the native page, so switching back does not load it again.
 */
export function tabsToMount(group: TabsPanel, seen: ReadonlySet<string>): PanelTab[] {
  const activeId = group.tabs.some((tab) => tab.id === group.active) ? group.active : group.tabs[0]?.id;
  return group.tabs.filter((tab) => tab.id === activeId || (seen.has(tab.id) && warmBrowser(tab)));
}
