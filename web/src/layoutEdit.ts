import { isDefaultPanelTitle, titleFromPanel } from "./openTitle";
import type { GridCell, LayoutNode, PanelConfig, PanelNode, PanelTab, TabEdge, TabsPanel } from "./types";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function cellNode(cell: GridCell): LayoutNode {
  if (cell.node) return cell.node;
  return {
    type: "panel",
    id: cell.id,
    title: cell.title ?? null,
    panel: cell.panel ?? { type: "herdr", paneId: null },
  };
}

export function normalizeLayout(node: LayoutNode): LayoutNode {
  if (node.type === "split") {
    return {
      ...node,
      first: normalizeLayout(node.first),
      second: normalizeLayout(node.second),
    };
  }
  if (node.type === "panel") {
    let title = node.title;
    let icon = node.icon?.trim() || null;
    let panel = node.panel;
    if (panel.type === "tabs" && panel.tabs.length === 1) {
      const only = panel.tabs[0];
      panel = only.panel;
      if (only.title && !isDefaultPanelTitle(only.title)) title = only.title;
      if (only.icon?.trim()) icon = only.icon.trim();
    }
    if (isDefaultPanelTitle(title)) title = null;
    const next: PanelNode = { type: "panel", id: node.id, title: title ?? null, panel };
    if (icon) next.icon = icon;
    if (node.collapsed) next.collapsed = true;
    if (panel.type !== "tabs" && node.edge && node.edge !== "top") next.edge = node.edge;
    if (panel.type !== "tabs" && node.showNames === false) next.showNames = false;
    if (panel.type !== "tabs" && node.showIcons === false) next.showIcons = false;
    return next;
  }
  return {
    ...node,
    cells: node.cells.map((cell) => ({
      ...cell,
      node: normalizeLayout(cellNode(cell)),
      panel: undefined,
    })),
  };
}

function descend(
  node: LayoutNode,
  path: string,
  update: (node: LayoutNode) => LayoutNode,
): LayoutNode {
  if (path === "") return update(node);
  if (node.type === "split") {
    const slash = path.indexOf("/");
    const head = slash === -1 ? path : path.slice(0, slash);
    const rest = slash === -1 ? "" : path.slice(slash + 1);
    if (head === "first") return { ...node, first: descend(node.first, rest, update) };
    if (head === "second") return { ...node, second: descend(node.second, rest, update) };
    return node;
  }
  if (node.type === "grid" && path.startsWith("cell/")) {
    const restPath = path.slice("cell/".length);
    const slash = restPath.indexOf("/");
    const id = slash === -1 ? restPath : restPath.slice(0, slash);
    const rest = slash === -1 ? "" : restPath.slice(slash + 1);
    return {
      ...node,
      cells: node.cells.map((cell) =>
        cell.id === id
          ? { ...cell, node: descend(cellNode(cell), rest, update), panel: undefined }
          : cell,
      ),
    };
  }
  return node;
}

export function setSplitRatio(node: LayoutNode, path: string, ratio: number): LayoutNode {
  const nextRatio = clamp(ratio, 0.12, 0.88);
  return descend(node, path, (target) =>
    target.type === "split" ? { ...target, ratio: nextRatio } : target,
  );
}

export function setGridTracks(
  node: LayoutNode,
  path: string,
  columns: number[],
  rows: number[],
): LayoutNode {
  return descend(node, path, (target) =>
    target.type === "grid" ? { ...target, columns, rows } : target,
  );
}

export function mapPanel(
  node: LayoutNode,
  id: string,
  update: (panel: PanelNode) => PanelNode,
): LayoutNode {
  if (node.type === "panel") return node.id === id ? update(node) : node;
  if (node.type === "split") {
    return {
      ...node,
      first: mapPanel(node.first, id, update),
      second: mapPanel(node.second, id, update),
    };
  }
  return {
    ...node,
    cells: node.cells.map((cell) => ({
      ...cell,
      node: mapPanel(cellNode(cell), id, update),
      panel: undefined,
    })),
  };
}

export function setPanel(node: LayoutNode, id: string, panel: PanelConfig): LayoutNode {
  return mapPanel(node, id, (current) => ({ ...current, panel }));
}

export function contentLabel(panel: PanelConfig): string {
  switch (panel.type) {
    case "herdr":
      return panel.scope === "pane" ? "Terminal" : "Panes";
    case "iframe": {
      const host = titleFromPanel(panel);
      return host || "Browser";
    }
    case "html": {
      const name = titleFromPanel(panel);
      return name || "Browser";
    }
    case "files":
      return "Spaces";
    case "agents":
      return "Agents";
    case "explorer": {
      const name = titleFromPanel(panel);
      return name || "Files";
    }
    case "markdown": {
      const name = titleFromPanel(panel);
      return name || "Notes";
    }
    case "file": {
      const name = titleFromPanel(panel);
      return name || "File";
    }
    case "plugin":
      return panel.plugin || "Plugin";
    case "chat":
      return "Chat";
    case "blank":
      return "";
    case "tabs":
      return "Tabs";
  }
}

export function blankTab(id: string): PanelTab {
  return { id, title: "", panel: { type: "iframe", url: "", proxy: false } };
}

export function freshTabId(tabs: { id: string }[]): string {
  let number = tabs.length + 1;
  let id = `tab-${number}`;
  while (tabs.some((tab) => tab.id === id)) {
    number += 1;
    id = `tab-${number}`;
  }
  return id;
}

export function addPanelTab(node: LayoutNode, id: string): LayoutNode {
  const found = findPanel(node, id);
  if (!found) return node;
  if (found.panel.type === "tabs" && found.panel.tabs.length >= 24) return node;
  return mapPanel(node, id, (current) => {
    const next: PanelNode = { ...current, panel: withAddedTab(current) };
    delete next.showNames;
    delete next.showIcons;
    return next;
  });
}

export function closePanelTab(node: LayoutNode, panelId: string, tabId: string): LayoutNode {
  const current = findPanel(node, panelId);
  if (!current || current.panel.type !== "tabs") return node;
  const group = current.panel;
  const remaining = group.tabs.filter((tab) => tab.id !== tabId);
  if (remaining.length > 1) {
    const nextActive = group.active === tabId ? remaining[remaining.length - 1].id : group.active;
    return mapPanel(node, panelId, (panel) => ({
      ...panel,
      panel: { ...group, active: nextActive, tabs: remaining },
    }));
  }
  const only = remaining[0] ?? blankTab("tab-1");
  return mapPanel(node, panelId, (panel) => panelFromTab(panel, only));
}

function panelFromTab(host: PanelNode, only: PanelTab): PanelNode {
  const title = only.title && only.title !== "New tab" ? only.title : host.title;
  const icon = only.icon?.trim() || null;
  const edge = host.panel.type === "tabs" ? host.panel.edge : host.edge;
  const names = host.panel.type === "tabs" ? host.panel.showNames : host.showNames;
  const icons = host.panel.type === "tabs" ? host.panel.showIcons : host.showIcons;
  const next: PanelNode = { ...host, title: title ?? null, icon, panel: only.panel };
  if (edge && edge !== "top") next.edge = edge;
  else delete next.edge;
  if (names === false) next.showNames = false;
  else delete next.showNames;
  if (icons === false) next.showIcons = false;
  else delete next.showIcons;
  return next;
}

export function assignContent(node: LayoutNode, id: string, panel: PanelConfig, retitle = false): LayoutNode {
  const current = findPanel(node, id);
  if (!current) return node;
  if (panel.type === "tabs") return mapPanel(node, id, (item) => ({ ...item, panel }));
  if (current.panel.type === "tabs") {
    const group = current.panel;
    const activeId = group.tabs.some((tab) => tab.id === group.active) ? group.active : group.tabs[0]?.id;
    return setPanel(node, id, {
      ...group,
      tabs: group.tabs.map((tab) =>
        tab.id === activeId ? { ...tab, panel, title: retitle ? contentLabel(panel) : tab.title } : tab,
      ),
    });
  }
  return mapPanel(node, id, (item) => ({
    ...item,
    panel,
    title: retitle ? contentLabel(panel) : item.title,
  }));
}

/** Move a panel's title bar. A tab group keeps the choice on its tab bar. */
export function setBarEdge(node: LayoutNode, id: string, edge: TabEdge): LayoutNode {
  const current = findPanel(node, id);
  if (!current) return node;
  if (current.panel.type === "tabs") {
    const group = current.panel;
    if (group.edge === edge && current.edge == null) return node;
    return mapPanel(node, id, (panel) => {
      const next: PanelNode = { ...panel, panel: { ...group, edge } };
      delete next.edge;
      return next;
    });
  }
  if ((current.edge ?? "top") === edge) return node;
  return mapPanel(node, id, (panel) => {
    const next: PanelNode = { ...panel };
    if (edge === "top") delete next.edge;
    else next.edge = edge;
    return next;
  });
}

/** Show or hide a panel bar's name and icon. A tab group keeps the choice on its tab bar. */
export function setBarFace(node: LayoutNode, id: string, names: boolean, icons: boolean): LayoutNode {
  const current = findPanel(node, id);
  if (!current) return node;
  if (current.panel.type === "tabs") {
    const group = current.panel;
    if ((group.showNames !== false) === names && (group.showIcons !== false) === icons) return node;
    return mapPanel(node, id, (panel) => {
      const tabs: TabsPanel = { ...group };
      if (names) delete tabs.showNames;
      else tabs.showNames = false;
      if (icons) delete tabs.showIcons;
      else tabs.showIcons = false;
      const next: PanelNode = { ...panel, panel: tabs };
      delete next.showNames;
      delete next.showIcons;
      return next;
    });
  }
  if ((current.showNames !== false) === names && (current.showIcons !== false) === icons) return node;
  return mapPanel(node, id, (panel) => {
    const next: PanelNode = { ...panel };
    if (names) delete next.showNames;
    else next.showNames = false;
    if (icons) delete next.showIcons;
    else next.showIcons = false;
    return next;
  });
}

export function setTabEdge(node: LayoutNode, id: string, edge: TabEdge): LayoutNode {
  return setBarEdge(node, id, edge);
}

function withAddedTab(panel: PanelNode): PanelConfig {
  if (panel.panel.type === "tabs") {
    const tab = blankTab(freshTabId(panel.panel.tabs));
    return { ...panel.panel, active: tab.id, tabs: [...panel.panel.tabs, tab] };
  }
  const kept: PanelTab = {
    id: "tab-1",
    title: panel.title?.trim() || contentLabel(panel.panel),
    panel: panel.panel,
  };
  if (panel.icon?.trim()) kept.icon = panel.icon.trim();
  const added = blankTab("tab-2");
  const group: TabsPanel = { type: "tabs", edge: panel.edge ?? "top", active: added.id, tabs: [kept, added] };
  if (panel.showNames === false) group.showNames = false;
  if (panel.showIcons === false) group.showIcons = false;
  return group;
}

export function listPanels(node: LayoutNode): PanelNode[] {
  if (node.type === "panel") return [node];
  if (node.type === "split") return [...listPanels(node.first), ...listPanels(node.second)];
  return node.cells.flatMap((cell) => listPanels(cellNode(cell)));
}

export function findPanel(node: LayoutNode, id: string): PanelNode | null {
  return listPanels(node).find((panel) => panel.id === id) ?? null;
}

export function freshPanelId(node: LayoutNode): string {
  const used = new Set(listPanels(node).map((panel) => panel.id));
  for (let index = 1; index < 500; index += 1) {
    const id = `panel-${index}`;
    if (!used.has(id)) return id;
  }
  return `panel-${used.size + 1}`;
}

export function splitPanel(
  node: LayoutNode,
  id: string,
  direction: "row" | "column",
  created: PanelNode,
): LayoutNode {
  if (node.type === "panel") {
    if (node.id !== id) return node;
    return { type: "split", direction, ratio: 0.5, first: node, second: created };
  }
  if (node.type === "split") {
    return {
      ...node,
      first: splitPanel(node.first, id, direction, created),
      second: splitPanel(node.second, id, direction, created),
    };
  }
  return {
    ...node,
    cells: node.cells.map((cell) => ({
      ...cell,
      node: splitPanel(cellNode(cell), id, direction, created),
      panel: undefined,
    })),
  };
}

type CloseHit = { kind: "gone" } | { kind: "same" } | { kind: "node"; node: LayoutNode };

function closeIn(node: LayoutNode, id: string): CloseHit {
  if (node.type === "panel") return node.id === id ? { kind: "gone" } : { kind: "same" };
  if (node.type === "split") {
    const first = closeIn(node.first, id);
    if (first.kind === "gone") return { kind: "node", node: node.second };
    const second = closeIn(node.second, id);
    if (second.kind === "gone") return { kind: "node", node: node.first };
    if (first.kind === "node" || second.kind === "node") {
      return {
        kind: "node",
        node: {
          ...node,
          first: first.kind === "node" ? first.node : node.first,
          second: second.kind === "node" ? second.node : node.second,
        },
      };
    }
    return { kind: "same" };
  }
  let changed = false;
  const cells: GridCell[] = [];
  for (const cell of node.cells) {
    const hit = closeIn(cellNode(cell), id);
    if (hit.kind === "gone") {
      changed = true;
      continue;
    }
    if (hit.kind === "node") {
      changed = true;
      cells.push({ ...cell, node: hit.node, panel: undefined });
    } else {
      cells.push(cell.node ? cell : { ...cell, node: cellNode(cell), panel: undefined });
    }
  }
  if (!changed) return { kind: "same" };
  if (cells.length === 0) return { kind: "gone" };
  if (cells.length === 1 && cells[0].node) return { kind: "node", node: cells[0].node };
  return { kind: "node", node: { ...node, cells } };
}

export interface ClosedPanel {
  panel: PanelNode;
  anchorId: string | null;
  place: Exclude<PanelPlace, "center">;
}

/** Where a panel sat before it was closed, so it can be put back beside what stayed. */
export function describeClose(root: LayoutNode, id: string): ClosedPanel | null {
  const panel = findPanel(root, id);
  if (!panel) return null;
  const spot = splitSpot(root, id);
  return {
    panel: JSON.parse(JSON.stringify(panel)) as PanelNode,
    anchorId: spot?.anchorId ?? null,
    place: spot?.place ?? "right",
  };
}

export function insertPanel(
  node: LayoutNode,
  anchorId: string,
  panel: PanelNode,
  place: Exclude<PanelPlace, "center">,
): LayoutNode {
  if (!findPanel(node, anchorId) || findPanel(node, panel.id)) return node;
  return insertBeside(node, anchorId, panel, place);
}

export function reopenPanel(root: LayoutNode, closed: ClosedPanel): LayoutNode | null {
  if (findPanel(root, closed.panel.id)) return null;
  const anchor =
    (closed.anchorId && findPanel(root, closed.anchorId) ? closed.anchorId : null) ??
    listPanels(root)[0]?.id ??
    null;
  if (!anchor) return null;
  return insertPanel(root, anchor, closed.panel, closed.place);
}

function splitSpot(
  node: LayoutNode,
  id: string,
): { anchorId: string; place: Exclude<PanelPlace, "center"> } | null {
  if (node.type === "split") {
    const placeFor = (side: "first" | "second"): Exclude<PanelPlace, "center"> => {
      if (node.direction === "row") return side === "first" ? "left" : "right";
      return side === "first" ? "above" : "below";
    };
    if (node.first.type === "panel" && node.first.id === id) {
      const anchor = listPanels(node.second)[0];
      if (anchor) return { anchorId: anchor.id, place: placeFor("first") };
    }
    if (node.second.type === "panel" && node.second.id === id) {
      const anchor = listPanels(node.first)[0];
      if (anchor) return { anchorId: anchor.id, place: placeFor("second") };
    }
    return splitSpot(node.first, id) ?? splitSpot(node.second, id);
  }
  if (node.type === "grid") {
    for (const cell of node.cells) {
      const hit = splitSpot(cellNode(cell), id);
      if (hit) return hit;
    }
  }
  return null;
}

export function closePanel(node: LayoutNode, id: string): LayoutNode | null {
  const hit = closeIn(node, id);
  if (hit.kind === "gone") return null;
  if (hit.kind === "same") return node;
  return hit.node;
}

export type PanelPlace = "left" | "right" | "above" | "below" | "center";

export function movePanel(
  node: LayoutNode,
  sourceId: string,
  targetId: string,
  place: PanelPlace,
): LayoutNode {
  if (sourceId === targetId) return node;
  if (place === "center") return swapPanels(node, sourceId, targetId);
  const source = findPanel(node, sourceId);
  if (!source || !findPanel(node, targetId)) return node;
  const closed = closePanel(node, sourceId);
  if (!closed || !findPanel(closed, targetId)) return node;
  return insertBeside(closed, targetId, source, place);
}

const TAB_LIMIT = 24;

export function writeTab(group: TabsPanel, tabId: string, panel: PanelConfig, retitle = false): TabsPanel {
  const known = group.tabs.some((tab) => tab.id === tabId);
  return {
    ...group,
    active: known ? tabId : group.active,
    tabs: group.tabs.map((tab) => {
      if (tab.id !== tabId) return tab;
      const title = retitle ? contentLabel(panel) || tab.title : tab.title;
      return { ...tab, panel, title };
    }),
  };
}

export function patchTab(
  node: LayoutNode,
  panelId: string,
  tabId: string,
  patch: { title?: string; icon?: string | null },
): LayoutNode {
  const current = findPanel(node, panelId);
  if (!current || current.panel.type !== "tabs") return node;
  return setPanel(node, panelId, {
    ...current.panel,
    tabs: current.panel.tabs.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab)),
  });
}

export function setPanelIcon(node: LayoutNode, id: string, icon: string | null): LayoutNode {
  return mapPanel(node, id, (panel) => ({ ...panel, icon }));
}

export function toggleCollapsed(node: LayoutNode, id: string): LayoutNode {
  return mapPanel(node, id, (panel) => ({ ...panel, collapsed: !panel.collapsed }));
}

/** A click on a tab opens a collapsed panel and shows that tab, even when it was already selected. */
export function openTab(node: LayoutNode, id: string, group: TabsPanel): LayoutNode {
  return mapPanel(node, id, (panel) => ({ ...panel, collapsed: false, panel: group }));
}

/** Drop one panel onto another's bar. A dragged group is flattened into the target. */
export function groupOnBar(node: LayoutNode, sourceId: string, targetId: string): LayoutNode {
  if (sourceId === targetId) return node;
  const source = findPanel(node, sourceId);
  const target = findPanel(node, targetId);
  if (!source || !target) return node;
  const incoming = tabsFrom(source);
  const existing = target.panel.type === "tabs" ? target.panel.tabs.map((tab) => ({ ...tab })) : tabsFrom(target);
  if (existing.length + incoming.length > TAB_LIMIT) return node;
  const closed = closePanel(node, sourceId);
  if (!closed || !findPanel(closed, targetId)) return node;
  const taken = new Set(existing.map((tab) => tab.id));
  const added = incoming.map((tab) => {
    const id = uniqueTabId(tab.id, taken);
    taken.add(id);
    return { ...tab, id };
  });
  const edge = target.panel.type === "tabs" ? target.panel.edge : (target.edge ?? "top");
  const names = target.panel.type === "tabs" ? target.panel.showNames : target.showNames;
  const icons = target.panel.type === "tabs" ? target.panel.showIcons : target.showIcons;
  return mapPanel(closed, targetId, (panel) => {
    const group: TabsPanel = {
      type: "tabs",
      edge,
      active: added[0]?.id ?? existing[0]?.id ?? "tab-1",
      tabs: [...existing, ...added],
    };
    if (names === false) group.showNames = false;
    if (icons === false) group.showIcons = false;
    const next: PanelNode = { ...panel, panel: group };
    delete next.showNames;
    delete next.showIcons;
    return next;
  });
}

/** Move one tab onto a bar or out beside another panel. A plain panel moves as a whole. */
export function moveTab(
  node: LayoutNode,
  sourceId: string,
  tabId: string,
  targetId: string,
  place: PanelPlace | "bar",
): LayoutNode {
  const source = findPanel(node, sourceId);
  const target = findPanel(node, targetId);
  if (!source || !target) return node;
  if (sourceId === targetId && (place === "bar" || place === "center")) return node;
  const whole = source.panel.type !== "tabs" || source.panel.tabs.length < 2;
  if (place === "bar" && tabCount(target) + (whole ? tabCount(source) : 1) > TAB_LIMIT) return node;
  const pulled = pullTab(node, sourceId, tabId);
  if (!pulled) return node;
  if (place === "bar") return groupOnBar(pulled.node, pulled.id, targetId);
  return movePanel(pulled.node, pulled.id, targetId, place);
}

function tabCount(panel: PanelNode): number {
  return panel.panel.type === "tabs" ? panel.panel.tabs.length : 1;
}

function tabsFrom(panel: PanelNode): PanelTab[] {
  if (panel.panel.type === "tabs") {
    return panel.panel.tabs.flatMap((tab) =>
      tab.panel.type === "tabs" ? tab.panel.tabs.map((inner) => ({ ...inner })) : [{ ...tab }],
    );
  }
  const given = (panel.title ?? "").trim();
  const tab: PanelTab = {
    id: "tab-1",
    title: given && !isDefaultPanelTitle(given) ? given : contentLabel(panel.panel),
    panel: panel.panel,
  };
  if (panel.icon?.trim()) tab.icon = panel.icon.trim();
  return [tab];
}

function uniqueTabId(preferred: string, taken: Set<string>): string {
  if (!taken.has(preferred)) return preferred;
  let number = 1;
  while (taken.has(`tab-${number}`)) number += 1;
  return `tab-${number}`;
}

function pullTab(node: LayoutNode, sourceId: string, tabId: string): { node: LayoutNode; id: string } | null {
  const source = findPanel(node, sourceId);
  if (!source) return null;
  if (source.panel.type !== "tabs" || source.panel.tabs.length < 2) return { node, id: sourceId };
  const tab = source.panel.tabs.find((item) => item.id === tabId);
  if (!tab) return null;
  const remaining = source.panel.tabs.filter((item) => item.id !== tabId);
  const group = source.panel;
  const stripped =
    remaining.length === 1
      ? mapPanel(node, sourceId, (panel) => panelFromTab(panel, remaining[0]))
      : mapPanel(node, sourceId, (panel) => ({
          ...panel,
          panel: {
            ...group,
            active: group.active === tabId ? remaining[remaining.length - 1].id : group.active,
            tabs: remaining,
          },
        }));
  const id = freshPanelId(stripped);
  const title = tab.title.trim();
  const created: PanelNode = {
    type: "panel",
    id,
    title: title && title !== "New tab" ? title : null,
    icon: tab.icon?.trim() || null,
    panel: tab.panel,
  };
  return { node: insertBeside(stripped, sourceId, created, "right"), id };
}

function insertBeside(
  node: LayoutNode,
  targetId: string,
  source: PanelNode,
  place: Exclude<PanelPlace, "center">,
): LayoutNode {
  if (node.type === "panel") {
    if (node.id !== targetId) return node;
    const direction = place === "left" || place === "right" ? "row" : "column";
    const sourceFirst = place === "left" || place === "above";
    return {
      type: "split",
      direction,
      ratio: 0.5,
      first: sourceFirst ? source : node,
      second: sourceFirst ? node : source,
    };
  }
  if (node.type === "split") {
    return {
      ...node,
      first: insertBeside(node.first, targetId, source, place),
      second: insertBeside(node.second, targetId, source, place),
    };
  }
  return {
    ...node,
    cells: node.cells.map((cell) => ({
      ...cell,
      node: insertBeside(cellNode(cell), targetId, source, place),
      panel: undefined,
    })),
  };
}

export function swapPanels(node: LayoutNode, sourceId: string, targetId: string): LayoutNode {
  if (sourceId === targetId) return node;
  const source = findPanel(node, sourceId);
  const target = findPanel(node, targetId);
  if (!source || !target) return node;
  return swapAt(node, source, target);
}

function swapAt(node: LayoutNode, source: PanelNode, target: PanelNode): LayoutNode {
  if (node.type === "panel") {
    if (node.id === source.id) return target;
    if (node.id === target.id) return source;
    return node;
  }
  if (node.type === "split") {
    return {
      ...node,
      first: swapAt(node.first, source, target),
      second: swapAt(node.second, source, target),
    };
  }
  return {
    ...node,
    cells: node.cells.map((cell) => ({
      ...cell,
      node: swapAt(cellNode(cell), source, target),
      panel: undefined,
    })),
  };
}

export function defaultPanel(type: PanelConfig["type"]): PanelConfig {
  switch (type) {
    case "markdown":
      return { type: "markdown", path: "notes/welcome.md" };
    case "iframe":
      return { type: "iframe", url: "", proxy: false };
    case "html":
      return { type: "html", path: "panels/session-board.html" };
    case "plugin":
      return { type: "plugin", plugin: "my-plugin" };
    case "files":
      return { type: "files" };
    case "agents":
      return { type: "agents" };
    case "explorer":
      return { type: "explorer", path: "" };
    case "file":
      return { type: "file", path: "notes/welcome.md" };
    case "tabs":
      return {
        type: "tabs",
        edge: "top",
        active: "tab-1",
        tabs: [{ id: "tab-1", title: "New tab", panel: { type: "iframe", url: "", proxy: false } }],
      };
    case "chat":
      return { type: "chat", paneId: null };
    case "blank":
      return { type: "blank" };
    default:
      return { type: "herdr", paneId: null };
  }
}

export function panelKind(panel: PanelConfig): string {
  switch (panel.type) {
    case "herdr":
      return panel.scope === "pane" ? "Terminal" : "Panes";
    case "iframe":
      return "Browser";
    case "markdown":
      return "Markdown";
    case "html":
      return "HTML";
    case "plugin":
      return "Plugin";
    case "files":
      return "Spaces";
    case "agents":
      return "Agents";
    case "explorer":
      return "Files";
    case "file":
      return "File";
    case "tabs":
      return "Tabs";
    case "chat":
      return "Chat";
    case "blank":
      return "";
  }
}

export function panelSummary(panel: PanelNode): string {
  const config = panel.panel;
  switch (config.type) {
    case "herdr":
      return config.paneId || "No pane selected";
    case "iframe":
      return config.url;
    case "markdown":
      return config.path;
    case "html":
      return config.path || "inline";
    case "plugin":
      return config.plugin;
    case "files":
      return "spaces";
    case "agents":
      return "agents";
    case "blank":
      return "Choose a view";
    case "explorer":
      return config.path || "Choose a folder";
    case "file":
      return config.path;
    case "tabs": {
      const current = config.tabs.find((tab) => tab.id === config.active) ?? config.tabs[0];
      return current?.title ?? "Tabs";
    }
    case "chat":
      return config.paneId ? `Sends to ${config.paneId}` : "Local transcript";
  }
}

function builtinPanel(id: string, title: string | null, panel: PanelConfig): PanelNode {
  return { type: "panel", id, title, panel };
}

function unusedId(root: LayoutNode, preferred: string): string {
  const used = new Set(listPanels(root).map((panel) => panel.id));
  if (!used.has(preferred)) return preferred;
  return freshPanelId(root);
}

export function ensureSidebar(root: LayoutNode): LayoutNode {
  const panels = listPanels(root);
  const files = panels.find((panel) => panel.panel.type === "files");
  const agents = panels.find((panel) => panel.panel.type === "agents");
  let next = root;
  if (files && !agents) {
    next = splitPanel(next, files.id, "column", builtinPanel(unusedId(next, "agents"), null, { type: "agents" }));
  } else if (!files && agents) {
    const id = unusedId(next, "spaces");
    next = swapPanels(
      splitPanel(next, agents.id, "column", builtinPanel(id, null, { type: "files" })),
      agents.id,
      id,
    );
  } else if (!files && !agents) {
    const filesId = unusedId(next, "spaces");
    const agentsId = filesId === "agents" ? "agents-list" : unusedId(next, "agents");
    const sidebar: LayoutNode = {
      type: "split",
      direction: "column",
      ratio: 0.62,
      first: builtinPanel(filesId, null, { type: "files" }),
      second: builtinPanel(agentsId, null, { type: "agents" }),
    };
    next = { type: "split", direction: "row", ratio: 0.22, first: sidebar, second: next };
  }
  return next;
}
