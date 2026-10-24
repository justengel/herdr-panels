import type { GridCell, LayoutNode, PanelConfig, PanelNode, PanelTab, TabEdge } from "./types";

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
    let panel = node.panel;
    if (panel.type === "tabs" && panel.tabs.length === 1) {
      const only = panel.tabs[0];
      panel = only.panel;
      if (only.title && only.title !== "New tab") title = only.title;
    }
    if (panel.type === "files" && (!title || title === "Directories")) title = "spaces";
    if (panel.type === "agents" && (!title || title === "Agents")) title = "agents";
    return { type: "panel", id: node.id, title: title ?? null, panel };
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
      return "Terminal";
    case "iframe":
    case "html":
      return "Browser";
    case "files":
      return "Spaces";
    case "agents":
      return "Agents";
    case "explorer":
      return "Files";
    case "markdown":
      return "Notes";
    case "file":
      return "File";
    case "plugin":
      return panel.plugin || "Plugin";
    case "chat":
      return "Chat";
    case "tabs":
      return "Tabs";
  }
}

export function blankTab(id: string): PanelTab {
  return { id, title: "New tab", panel: { type: "iframe", url: "", proxy: false } };
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
  return mapPanel(node, id, (current) => ({ ...current, panel: withAddedTab(current) }));
}

export function assignContent(node: LayoutNode, id: string, panel: PanelConfig, retitle = false): LayoutNode {
  const current = findPanel(node, id);
  if (!current || current.panel.type !== "tabs") return setPanel(node, id, panel);
  const group = current.panel;
  const activeId = group.tabs.some((tab) => tab.id === group.active) ? group.active : group.tabs[0]?.id;
  return setPanel(node, id, {
    ...group,
    tabs: group.tabs.map((tab) =>
      tab.id === activeId ? { ...tab, panel, title: retitle ? contentLabel(panel) : tab.title } : tab,
    ),
  });
}

export function setTabEdge(node: LayoutNode, id: string, edge: TabEdge): LayoutNode {
  const current = findPanel(node, id);
  if (!current || current.panel.type !== "tabs") return node;
  return setPanel(node, id, { ...current.panel, edge });
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
  const added = blankTab("tab-2");
  return { type: "tabs", edge: "top", active: added.id, tabs: [kept, added] };
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
    default:
      return { type: "herdr", paneId: null };
  }
}

export function panelKind(panel: PanelConfig): string {
  switch (panel.type) {
    case "herdr":
      return "Terminal";
    case "iframe":
      return "Browser";
    case "markdown":
      return "Markdown";
    case "html":
      return "HTML";
    case "plugin":
      return "Plugin";
    case "files":
      return "spaces";
    case "agents":
      return "agents";
    case "explorer":
      return "Files";
    case "file":
      return "File";
    case "tabs":
      return "Tabs";
    case "chat":
      return "Chat";
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

function builtinPanel(id: string, title: string, panel: PanelConfig): PanelNode {
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
    next = splitPanel(next, files.id, "column", builtinPanel(unusedId(next, "agents"), "agents", { type: "agents" }));
  } else if (!files && agents) {
    const id = unusedId(next, "spaces");
    next = swapPanels(
      splitPanel(next, agents.id, "column", builtinPanel(id, "spaces", { type: "files" })),
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
      first: builtinPanel(filesId, "spaces", { type: "files" }),
      second: builtinPanel(agentsId, "agents", { type: "agents" }),
    };
    next = { type: "split", direction: "row", ratio: 0.22, first: sidebar, second: next };
  }
  return next;
}
