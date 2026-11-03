import type { LayoutNode, PanelNode, TabEdge } from "./types";

/** The number on a generated tab id. `tab-2` is shown as `2`. Any other id stays as it is. */
export function tabNumber(id: string): string {
  const match = /^tab-(\d+)$/.exec(id.trim());
  return match?.[1] ?? id;
}

export interface TabFace {
  /** Words on the tab. The tab number when nothing else is drawn. */
  label: string;
  icon: string | null;
  /** A side bar can shrink to this icon. */
  iconOnly: boolean;
}

export function tabFace(
  tab: { id: string; title: string; icon?: string | null },
  showNames = true,
  showIcons = true,
): TabFace {
  const icon = showIcons ? tab.icon?.trim() || null : null;
  const name = tab.title.trim();
  if (!showNames && !showIcons) return { label: tabNumber(tab.id), icon: null, iconOnly: false };
  if (showNames && name) return { label: name, icon, iconOnly: false };
  if (icon) return { label: "", icon, iconOnly: true };
  return { label: tabNumber(tab.id), icon: null, iconOnly: false };
}

/** A side tab is showing its name, so the bar stays wide enough for that name and its close button. */
export function tabShowsName(title: string, showNames = true): boolean {
  return showNames && Boolean(title.trim());
}

/**
 * A left or right bar with no names. Icons and id numbers both use this narrow bar.
 * A name keeps the wider bar.
 */
export function iconRail(
  edge: TabEdge,
  tabs: Array<{ id?: string; title: string; icon?: string | null }>,
  showNames = true,
  // Icons and id numbers share this bar. The width of each is `railBasis`.
  _showIcons = true,
): boolean {
  if ((edge !== "left" && edge !== "right") || tabs.length === 0) return false;
  return tabs.every((tab) => !tabShowsName(tab.title, showNames));
}

/** Pixels for a narrow side bar. An icon needs 42. A lone number needs less. */
export function railBasis(
  edge: TabEdge,
  tabs: Array<{ id?: string; title: string; icon?: string | null }>,
  showNames = true,
  showIcons = true,
): number | null {
  if (!iconRail(edge, tabs, showNames, showIcons)) return null;
  const icons = tabs.some(
    (tab) => tabFace({ id: tab.id ?? "", title: tab.title, icon: tab.icon }, showNames, showIcons).icon,
  );
  return icons ? 42 : 36;
}

/**
 * The close button on a tab.
 * Top and bottom always have it. A narrow side bar (icons or id numbers) does not:
 * showing it, including on hover, widens that bar. A side bar that shows names can have it.
 */
export function showTabClose(edge: TabEdge, rail: boolean): boolean {
  if (edge === "left" || edge === "right") return !rail;
  return true;
}

/** The open chevron points the way the body will move. A collapsed one points back out. */
export function chevronTurn(edge: TabEdge, collapsed: boolean): string {
  if (edge === "top") return collapsed ? "none" : "rotate(180deg)";
  if (edge === "bottom") return collapsed ? "rotate(180deg)" : "none";
  if (edge === "right") return collapsed ? "rotate(90deg)" : "rotate(-90deg)";
  return collapsed ? "rotate(-90deg)" : "rotate(90deg)";
}

function barEdge(node: PanelNode): TabEdge {
  if (node.panel.type === "tabs") return node.panel.edge;
  return node.edge ?? "top";
}

/** Pixels the parent split should give a collapsed panel, or null when this split cannot shrink that way. */
/** Flex for one side of a split. A collapsed neighbor takes the rest of the space. */
export function splitPaneFlex(share: number, basis: number | null, siblingBasis: number | null): string | number {
  if (basis != null) return `0 0 ${basis}px`;
  if (siblingBasis != null) return "1 1 0%";
  return share;
}

export function collapseBasis(node: LayoutNode, split: "row" | "column"): number | null {
  if (node.type !== "panel" || !node.collapsed) return null;
  const edge = barEdge(node);
  const along = edge === "left" || edge === "right" ? "row" : "column";
  if (along !== split) return null;
  if (edge === "left" || edge === "right") {
    if (node.panel.type === "tabs") {
      const names = node.panel.showNames !== false;
      const icons = node.panel.showIcons !== false;
      return railBasis(edge, node.panel.tabs, names, icons) ?? 168;
    }
    // A sideways name is one line thick, the same as the icon rail.
    if (node.showNames !== false && Boolean(node.title?.trim())) return 42;
    return node.showIcons !== false && Boolean(node.icon?.trim()) ? 42 : 36;
  }
  return 34;
}
