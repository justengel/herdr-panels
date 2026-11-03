import { closePanel, listPanels, movePanel, splitPanel, type PanelPlace } from "./layoutEdit";
import { spaceLayoutKey } from "./spaceLayout";
import type { LayoutNode, PanelNode } from "./types";

export interface VisitSpace {
  id: string;
  label: string;
  root: LayoutNode;
  current: boolean;
}

export interface PanelVisit {
  panelId: string;
  title: string;
  spaceId: string;
  spaceLabel: string;
  node: PanelNode;
}

type Hit = { space: VisitSpace; panel: PanelNode };

function inNamedSpace(hit: Hit, spaceId: string): boolean {
  return hit.space.id === spaceId || spaceLayoutKey(hit.space.id) === spaceLayoutKey(spaceId);
}

/** Find a panel on any space. The layouts passed in are not changed. `spaceId` keeps the copy on that space. */
export function findPanelVisit(
  spaces: readonly VisitSpace[],
  query: string,
  spaceId?: string,
): { visit: PanelVisit } | { error: string } {
  const needle = query.trim();
  if (!needle) return { error: "panel was not found" };
  const hits: Hit[] = [];
  for (const space of spaces) {
    for (const panel of listPanels(space.root)) hits.push({ space, panel });
  }
  const pool = spaceId ? hits.filter((hit) => inNamedSpace(hit, spaceId)) : hits;
  const byId = pool.filter((hit) => hit.panel.id === needle);
  if (byId.length > 0) return { visit: toVisit(spaceId ? byId[0] : preferOtherSpace(byId)) };
  const byTitle = pool.filter((hit) => (hit.panel.title ?? "").trim().toLowerCase() === needle.toLowerCase());
  const ids = new Set(byTitle.map((hit) => hit.panel.id));
  if (ids.size > 1) return { error: "more than one panel has that name" };
  if (ids.size === 0) return { error: "panel was not found" };
  return { visit: toVisit(spaceId ? byTitle[0] : preferOtherSpace(byTitle)) };
}

function preferOtherSpace(hits: Hit[]): Hit {
  return hits.find((hit) => !hit.space.current) ?? hits[0];
}

export type VisitArrange = "row" | "column" | "grid";

export interface OpenedVisit {
  node: LayoutNode;
  origins: Record<string, string>;
  /** Panel id to the space that owns it. A visit can show a panel from another space. */
  spaceIds: Record<string, string>;
  single: boolean;
  arrange: VisitArrange;
  spaceLabel: string;
  panelIds: string[];
  sizes: number[];
  columns: number[];
  rows: number[];
}

export interface VisitWeights {
  sizes?: number[];
  columns?: number[];
  rows?: number[];
}

export function chooseArrange(count: number, requested?: string): VisitArrange | { error: string } {
  if (count < 1) return { error: "a visit needs at least one panel" };
  const name = requested?.trim().toLowerCase() ?? "";
  if (!name) return count >= 3 ? "grid" : "row";
  if (name === "row" || name === "column" || name === "grid") return name;
  return { error: "arrange is row, column, or grid" };
}

/** Shares of a row, a column, or a grid. Omitted weights are even. */
export function visitWeights(
  count: number,
  arrange: VisitArrange,
  requested?: VisitWeights,
): { sizes: number[]; columns: number[]; rows: number[] } | { error: string } {
  const sizes = requested?.sizes ?? [];
  const columns = requested?.columns ?? [];
  const rows = requested?.rows ?? [];
  if (count <= 1) {
    if (sizes.length || columns.length || rows.length) return { error: "a single panel has no size" };
    return { sizes: [], columns: [], rows: [] };
  }
  if (arrange === "grid") {
    if (sizes.length) return { error: "size is for a row or a column" };
    const tracks = gridTracks(count, columns, rows);
    if ("error" in tracks) return tracks;
    return { sizes: [], columns: tracks.columns, rows: tracks.rows };
  }
  if (columns.length || rows.length) return { error: "columns and rows are for a grid" };
  const nextSizes = sizes.length ? sizes : Array.from({ length: count }, () => 1);
  if (nextSizes.length !== count) return { error: "size has one weight per panel" };
  if (!positive(nextSizes)) return { error: "a weight must be a positive number" };
  return { sizes: nextSizes, columns: [], rows: [] };
}

function positive(values: number[]): boolean {
  return values.every((value) => Number.isFinite(value) && value > 0);
}

function gridTracks(
  count: number,
  columns: number[],
  rows: number[],
): { columns: number[]; rows: number[] } | { error: string } {
  let columnCount = 0;
  let rowCount = 0;
  if (!columns.length && !rows.length) {
    columnCount = Math.max(1, Math.ceil(Math.sqrt(count)));
    rowCount = Math.ceil(count / columnCount);
  } else if (!rows.length) {
    columnCount = Math.max(1, columns.length);
    rowCount = Math.ceil(count / columnCount);
  } else if (!columns.length) {
    rowCount = Math.max(1, rows.length);
    columnCount = Math.ceil(count / rowCount);
  } else {
    columnCount = columns.length;
    rowCount = rows.length;
  }
  if (columnCount < 1 || rowCount < 1 || columnCount * rowCount < count) {
    return { error: "more panels than cells" };
  }
  const nextColumns = columns.length ? columns : Array.from({ length: columnCount }, () => 1);
  const nextRows = rows.length ? rows : Array.from({ length: rowCount }, () => 1);
  if (!positive(nextColumns) || !positive(nextRows)) return { error: "a weight must be a positive number" };
  return { columns: nextColumns, rows: nextRows };
}

export const VISIT_CAP = 6;

export interface VisitChoice {
  panelId: string;
  title: string;
  spaceId: string;
  space: string;
}

/** One row per panel id. The copy on the current space wins, matching maximize. */
export function listVisitChoices(spaces: VisitSpace[]): VisitChoice[] {
  const chosen = new Map<string, { choice: VisitChoice; current: boolean; order: number }>();
  let order = 0;
  for (const space of spaces) {
    for (const panel of listPanels(space.root)) {
      const choice: VisitChoice = {
        panelId: panel.id,
        title: panel.title?.trim() || panel.id,
        spaceId: space.id,
        space: space.label,
      };
      const existing = chosen.get(panel.id);
      if (!existing) {
        chosen.set(panel.id, { choice, current: space.current, order: order++ });
        continue;
      }
      if (space.current && !existing.current) {
        chosen.set(panel.id, { choice, current: true, order: existing.order });
      }
    }
  }
  return [...chosen.values()].sort((left, right) => left.order - right.order).map((item) => item.choice);
}

export function joinVisit(
  opened: OpenedVisit,
  panelId: string,
  spaceId?: string,
): { panels: { panelId: string; spaceId?: string }[] } | { error: string } {
  if (opened.panelIds.includes(panelId)) return { error: "that panel is already in this visit" };
  if (opened.panelIds.length >= VISIT_CAP) return { error: "a visit can show 6 panels" };
  const panels: { panelId: string; spaceId?: string }[] = opened.panelIds.map((id) => ({
    panelId: id,
    spaceId: opened.spaceIds[id],
  }));
  panels.push(spaceId ? { panelId, spaceId } : { panelId });
  return { panels };
}

/** Move panels inside the visit. The desk layout stays as it was. */
export function placeVisitPanel(
  opened: OpenedVisit,
  sourceId: string,
  targetId: string,
  place: PanelPlace,
): Pick<OpenedVisit, "node" | "panelIds" | "arrange" | "sizes" | "columns" | "rows"> {
  const same = {
    node: opened.node,
    panelIds: opened.panelIds,
    arrange: opened.arrange,
    sizes: opened.sizes,
    columns: opened.columns,
    rows: opened.rows,
  };
  if (opened.panelIds.length < 2 || sourceId === targetId) return same;
  if (!opened.panelIds.includes(sourceId) || !opened.panelIds.includes(targetId)) return same;
  const node = movePanel(opened.node, sourceId, targetId, place);
  if (node === opened.node) return same;
  return {
    node,
    panelIds: listPanels(node).map((panel) => panel.id),
    arrange: node.type === "grid" ? "grid" : node.type === "split" && node.direction === "column" ? "column" : "row",
    sizes: [],
    columns: [],
    rows: [],
  };
}

/** Maximize the panel on this desk. Naming the space keeps another space's copy of the same id. */
export function deskFillRequest(
  panelId: string,
  spaceId: string | null | undefined,
): { panelId: string; spaceId?: string } {
  return spaceId ? { panelId, spaceId } : { panelId };
}

/** Resolve every panel, then place them. One failure returns only the error. */
export function openVisit(
  spaces: readonly VisitSpace[],
  requests: { panelId: string; spaceId?: string }[],
  requested?: string,
  weights?: VisitWeights,
): OpenedVisit | { error: string } {
  if (requests.length === 0) return { error: "panel was not found" };
  const arrange = chooseArrange(requests.length, requested);
  if (typeof arrange !== "string") return arrange;
  const visits: PanelVisit[] = [];
  const seen = new Set<string>();
  for (const request of requests) {
    const found = findPanelVisit(spaces, request.panelId, request.spaceId);
    if ("error" in found) {
      if (requests.length === 1) return found;
      if (found.error === "panel was not found") {
        return { error: `panel was not found: ${request.panelId.trim()}` };
      }
      if (found.error === "more than one panel has that name") {
        return { error: `more than one panel has that name: ${request.panelId.trim()}` };
      }
      return found;
    }
    if (seen.has(found.visit.panelId)) return { error: "a visit lists that panel more than once" };
    seen.add(found.visit.panelId);
    visits.push(found.visit);
  }
  const origins: Record<string, string> = {};
  const spaceIds: Record<string, string> = {};
  for (const visit of visits) {
    origins[visit.panelId] = visit.spaceLabel;
    spaceIds[visit.panelId] = visit.spaceId;
  }
  const weighted = visitWeights(visits.length, arrange, weights);
  if ("error" in weighted) return weighted;
  const nodes = visits.map((visit) => visit.node);
  const node =
    nodes.length === 1
      ? nodes[0]
      : arrange === "grid"
        ? gridSplits(nodes, weighted.columns, weighted.rows)
        : stack(nodes, weighted.sizes, arrange);
  return {
    node,
    origins,
    spaceIds,
    single: visits.length === 1,
    arrange,
    spaceLabel: visits[0].spaceLabel,
    panelIds: visits.map((visit) => visit.panelId),
    sizes: weighted.sizes,
    columns: weighted.columns,
    rows: weighted.rows,
  };
}

/** Remove one panel from a visit. The last panel ends it. The split closes up, as it does on the desk. */
export function leaveVisitPanel(opened: OpenedVisit, panelId: string): OpenedVisit | { done: true } {
  if (!opened.panelIds.includes(panelId) || opened.panelIds.length <= 1) return { done: true };
  const node = closePanel(opened.node, panelId);
  if (!node) return { done: true };
  const panelIds = listPanels(node).map((panel) => panel.id);
  const spaceIds = { ...opened.spaceIds };
  const origins = { ...opened.origins };
  delete spaceIds[panelId];
  delete origins[panelId];
  return {
    ...opened,
    node,
    panelIds,
    spaceIds,
    origins,
    single: panelIds.length === 1,
    arrange: node.type === "split" && node.direction === "column" ? "column" : "row",
    sizes: [],
    columns: [],
    rows: [],
  };
}

/** Split the last panel and put this one on its right, the same as Add panel on the desk. */
export function insertVisitPanel(
  opened: OpenedVisit,
  panel: PanelNode,
  spaceId: string,
  spaceLabel: string,
): OpenedVisit | { error: string } {
  if (opened.panelIds.includes(panel.id)) return { error: "that panel is already in this visit" };
  if (opened.panelIds.length >= VISIT_CAP) return { error: "a visit can show 6 panels" };
  const host = opened.panelIds[opened.panelIds.length - 1];
  if (!host) return { error: "panel was not found" };
  const node = splitPanel(opened.node, host, "row", panel);
  return {
    ...opened,
    node,
    single: false,
    arrange: "row",
    panelIds: listPanels(node).map((item) => item.id),
    sizes: [],
    columns: [],
    rows: [],
    spaceIds: { ...opened.spaceIds, [panel.id]: spaceId },
    origins: { ...opened.origins, [panel.id]: spaceLabel },
  };
}

/** Keep panels that are already on this visit, and apply a new share to each divider. */
export function reuseVisit(current: LayoutNode, opened: OpenedVisit): LayoutNode {
  const ids = listPanels(current)
    .map((panel) => panel.id)
    .join("\0");
  if (ids !== opened.panelIds.join("\0")) return opened.node;
  const framed = copyFrame(current, opened.node);
  return framed === current ? opened.node : framed;
}

function copyFrame(current: LayoutNode, next: LayoutNode): LayoutNode {
  if (current.type === "split" && next.type === "split" && current.direction === next.direction) {
    return {
      ...current,
      ratio: next.ratio,
      first: copyFrame(current.first, next.first),
      second: copyFrame(current.second, next.second),
    };
  }
  if (current.type === "grid" && next.type === "grid") {
    return { ...current, columns: [...next.columns], rows: [...next.rows] };
  }
  return current;
}

function stack(nodes: LayoutNode[], weights: number[], direction: "row" | "column"): LayoutNode {
  if (nodes.length === 1) return nodes[0];
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return {
    type: "split",
    direction,
    ratio: weights[0] / total,
    first: nodes[0],
    second: stack(nodes.slice(1), weights.slice(1), direction),
  };
}

/** A grid's weights become the same splits the desk uses. A short last row takes the whole width. */
function gridSplits(nodes: LayoutNode[], columns: number[], rows: number[]): LayoutNode {
  const width = Math.max(1, columns.length);
  const bands: LayoutNode[] = [];
  const bandWeights: number[] = [];
  for (let row = 0; row < rows.length; row += 1) {
    const start = row * width;
    if (start >= nodes.length) break;
    const slice = nodes.slice(start, Math.min(start + width, nodes.length));
    const weights = columns.slice(0, slice.length);
    bands.push(slice.length === 1 ? slice[0] : stack(slice, weights, "row"));
    bandWeights.push(rows[row] ?? 1);
  }
  if (bands.length === 1) return bands[0];
  return stack(bands, bandWeights, "column");
}

function toVisit(hit: Hit): PanelVisit {
  const panel = JSON.parse(JSON.stringify(hit.panel)) as PanelNode;
  return {
    panelId: panel.id,
    title: panel.title?.trim() || panel.id,
    spaceId: hit.space.id,
    spaceLabel: hit.space.label || hit.space.id,
    node: panel,
  };
}

export function requestVisit(
  panels: { panelId: string; spaceId?: string }[],
  arrange?: string,
  weights?: VisitWeights,
): OpenedVisit | { error: string } {
  if (typeof window === "undefined" || panels.length === 0) return { error: "panel was not found" };
  const hook = (
    window as Window & {
      __hwpVisitPanel?: (
        panels: { panelId: string; spaceId?: string }[],
        arrange?: string,
        weights?: VisitWeights,
      ) => OpenedVisit | { error: string };
    }
  ).__hwpVisitPanel;
  if (!hook) return { error: "The desk could not show that panel." };
  return hook(panels, arrange, weights);
}

export function requestPanelVisit(query: string, spaceId?: string): { panelId: string } | { error: string } {
  const opened = requestVisit([{ panelId: query, spaceId }]);
  if ("error" in opened) return opened;
  return { panelId: opened.panelIds[0] };
}
