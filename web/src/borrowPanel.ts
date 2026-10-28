import { listPanels } from "./layoutEdit";
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
  if (count > 6) return { error: "a visit can show at most 6 panels" };
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
    const columnCount = count <= 4 ? 2 : 3;
    const rowCount = Math.ceil(count / columnCount);
    const nextColumns = columns.length ? columns : Array.from({ length: columnCount }, () => 1);
    const nextRows = rows.length ? rows : Array.from({ length: rowCount }, () => 1);
    if (nextColumns.length !== columnCount) return { error: "columns has one weight per column" };
    if (nextRows.length !== rowCount) return { error: "rows has one weight per row" };
    if (!positive(nextColumns) || !positive(nextRows)) return { error: "a weight must be a positive number" };
    return { sizes: [], columns: nextColumns, rows: nextRows };
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
  for (const visit of visits) origins[visit.panelId] = visit.spaceLabel;
  const weighted = visitWeights(visits.length, arrange, weights);
  if ("error" in weighted) return weighted;
  const node =
    visits.length === 1
      ? visits[0].node
      : arrange === "grid"
        ? gridOf(visits, weighted.columns, weighted.rows)
        : stack(
            visits.map((visit) => visit.node),
            weighted.sizes,
            arrange,
          );
  return {
    node,
    origins,
    single: visits.length === 1,
    arrange,
    spaceLabel: visits[0].spaceLabel,
    panelIds: visits.map((visit) => visit.panelId),
    sizes: weighted.sizes,
    columns: weighted.columns,
    rows: weighted.rows,
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

function gridOf(visits: PanelVisit[], columns: number[], rows: number[]): LayoutNode {
  const columnCount = columns.length;
  return {
    type: "grid",
    columns,
    rows,
    cells: visits.map((visit, index) => {
      const column = index % columnCount;
      const row = Math.floor(index / columnCount);
      const remainder = visits.length % columnCount;
      const last = index === visits.length - 1;
      return {
        id: visit.panelId,
        title: visit.title,
        column,
        row,
        colSpan: last && remainder !== 0 ? columnCount - column : 1,
        rowSpan: 1,
        node: visit.node,
      };
    }),
  };
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
