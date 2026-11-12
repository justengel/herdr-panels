import { movedSpaceOrder, sameSpaceOrder } from "./spaceDrag";
import type { PanelTab, TabEdge, TabsPanel } from "./types";

const EDGES: TabEdge[] = ["top", "bottom", "left", "right"];

/** The strip a tab sits on. A tab with no edge of its own uses the group's edge. */
export function tabEdgeOf(tab: { edge?: TabEdge }, groupEdge: TabEdge): TabEdge {
  return tab.edge ?? groupEdge;
}

export interface TabFrame {
  top: PanelTab[];
  right: PanelTab[];
  bottom: PanelTab[];
  left: PanelTab[];
}

/** Tabs grouped by the strip they sit on, in the order they have in the group. */
export function tabFrame(group: { edge: TabEdge; tabs: PanelTab[] }): TabFrame {
  const frame: TabFrame = { top: [], right: [], bottom: [], left: [] };
  for (const item of group.tabs) frame[tabEdgeOf(item, group.edge)].push(item);
  return frame;
}

/** More than one strip is showing, so the side rails run the full height of the group. */
export function frameSplits(frame: TabFrame): boolean {
  return EDGES.filter((edge) => frame[edge].length > 0).length > 1;
}

function withoutEdge(tab: PanelTab): PanelTab {
  if (tab.edge == null) return tab;
  const next = { ...tab };
  delete next.edge;
  return next;
}

function withEdge(tab: PanelTab, groupEdge: TabEdge, edge: TabEdge): PanelTab {
  if (edge === groupEdge) return withoutEdge(tab);
  if (tab.edge === edge) return tab;
  return { ...tab, edge };
}

/** Strips that are open. An empty one stays open only when the group lists it. */
export function openEdges(group: { edge: TabEdge; tabs: PanelTab[]; strips?: TabEdge[] }): TabEdge[] {
  const frame = tabFrame(group);
  const occupied = EDGES.filter((edge) => frame[edge].length > 0);
  const listed = (group.strips ?? []).filter((edge) => EDGES.includes(edge));
  const chosen = new Set(listed.length > 0 ? [...listed, ...occupied] : occupied);
  if (chosen.size === 0) chosen.add(group.edge);
  return EDGES.filter((edge) => chosen.has(edge));
}

function occupiedEdges(group: { edge: TabEdge; tabs: PanelTab[] }): TabEdge[] {
  const frame = tabFrame(group);
  return EDGES.filter((edge) => frame[edge].length > 0);
}

function sameEdges(left: TabEdge[], right: TabEdge[]): boolean {
  return left.length === right.length && left.every((edge, index) => edge === right[index]);
}

/** Remember open strips, including empty ones. Omit the list when it is only the occupied strips. */
function storeStrips(group: TabsPanel, wanted: TabEdge[]): TabsPanel {
  const settled = settleEdges(group);
  const occupied = occupiedEdges(settled);
  const open = EDGES.filter((edge) => wanted.includes(edge) || occupied.includes(edge));
  const plain = occupied.length > 0 ? occupied : [settled.edge];
  if (sameEdges(open, plain)) {
    if (!settled.strips) return settled;
    const next = { ...settled };
    delete next.strips;
    return next;
  }
  return { ...settled, strips: open };
}

/** Keep an explicit strip list when a tab moves onto one of those strips. */
export function retainStrips(group: TabsPanel, strips: TabEdge[] | undefined, extra?: TabEdge): TabsPanel {
  if (!strips?.length) return group;
  const occupied = occupiedEdges(group);
  const open = EDGES.filter((edge) => strips.includes(edge) || occupied.includes(edge) || edge === extra);
  return { ...group, strips: open };
}

/**
 * Open or close one strip. Several can be open, including a strip with no tabs.
 * Closing the last strip does nothing. Tabs on a closed strip move to one that stays open.
 */
export function toggleStrip(group: TabsPanel, edge: TabEdge): TabsPanel {
  const open = openEdges(group);
  if (!open.includes(edge)) return storeStrips(group, [...open, edge]);
  if (open.length === 1) return group;
  const rest = open.filter((item) => item !== edge);
  const home = rest.includes(group.edge) ? group.edge : rest[0];
  const tabs = group.tabs.map((tab) => (tabEdgeOf(tab, group.edge) === edge ? withEdge(tab, group.edge, home) : tab));
  return storeStrips({ ...group, tabs }, rest);
}

/** One occupied edge becomes the group edge, and matching overrides are dropped. */
export function settleEdges(group: TabsPanel): TabsPanel {
  const used = new Set(group.tabs.map((item) => tabEdgeOf(item, group.edge)));
  if (used.size !== 1) {
    const tabs = group.tabs.map((item) => (item.edge === group.edge ? withoutEdge(item) : item));
    return tabs.some((item, index) => item !== group.tabs[index]) ? { ...group, tabs } : group;
  }
  const only = [...used][0];
  const tabs = group.tabs.map(withoutEdge);
  if (only === group.edge && tabs.every((item, index) => item === group.tabs[index])) return group;
  return { ...group, edge: only, tabs };
}

/** Move one tab onto a strip. The others stay put. */
export function placeTabOn(group: TabsPanel, tabId: string, edge: TabEdge): TabsPanel {
  if (!group.tabs.some((item) => item.id === tabId)) return group;
  const tabs = group.tabs.map((item) => (item.id === tabId ? withEdge(item, group.edge, edge) : item));
  return retainStrips(settleEdges({ ...group, tabs }), group.strips, edge);
}

/** Move every tab onto one strip. */
export function gatherTabs(group: TabsPanel, edge: TabEdge): TabsPanel {
  const settled = settleEdges({ ...group, edge, tabs: group.tabs.map(withoutEdge) });
  if (!settled.strips) return settled;
  const next = { ...settled };
  delete next.strips;
  return next;
}

/** Reorder tabs on one strip. Tabs on the other strips keep their places. */
export function reorderOnEdge(
  tabs: PanelTab[],
  groupEdge: TabEdge,
  edge: TabEdge,
  draggedId: string,
  beforeId: string | null,
): PanelTab[] {
  const ids = tabs.filter((item) => tabEdgeOf(item, groupEdge) === edge).map((item) => item.id);
  if (sameSpaceOrder(ids, draggedId, beforeId)) return tabs;
  const nextIds = movedSpaceOrder(ids, draggedId, beforeId);
  const byId = new Map(
    tabs.filter((item) => tabEdgeOf(item, groupEdge) === edge).map((item) => [item.id, item]),
  );
  const reordered = nextIds.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
  if (reordered.length !== ids.length) return tabs;
  let index = 0;
  return tabs.map((item) => {
    if (tabEdgeOf(item, groupEdge) !== edge) return item;
    const next = reordered[index];
    index += 1;
    return next ?? item;
  });
}

/** The strip that carries the panel buttons. An empty group edge yields to the active tab. */
export function toolEdge(group: { edge: TabEdge; active: string; tabs: PanelTab[] }): TabEdge {
  const frame = tabFrame(group);
  if (frame[group.edge].length > 0) return group.edge;
  const active = group.tabs.find((item) => item.id === group.active) ?? group.tabs[0];
  return active ? tabEdgeOf(active, group.edge) : group.edge;
}

/**
 * While the panel is collapsed, every tab is drawn on the group edge.
 * The stored edges are left as they are.
 */
export function collapsedTabs(group: TabsPanel): TabsPanel {
  if (!frameSplits(tabFrame(group))) return group;
  return { ...group, tabs: group.tabs.map(withoutEdge) };
}
