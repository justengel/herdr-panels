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
}

export function chooseArrange(count: number, requested?: string): VisitArrange | { error: string } {
  if (count > 6) return { error: "a visit can show at most 6 panels" };
  const name = requested?.trim().toLowerCase() ?? "";
  if (!name) return count >= 3 ? "grid" : "row";
  if (name === "row" || name === "column" || name === "grid") return name;
  return { error: "arrange is row, column, or grid" };
}

/** Resolve every panel, then place them. One failure returns only the error. */
export function openVisit(
  spaces: readonly VisitSpace[],
  requests: { panelId: string; spaceId?: string }[],
  requested?: string,
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
  const node =
    visits.length === 1
      ? visits[0].node
      : arrange === "grid"
        ? gridOf(visits)
        : stack(
            visits.map((visit) => visit.node),
            arrange,
          );
  return {
    node,
    origins,
    single: visits.length === 1,
    arrange,
    spaceLabel: visits[0].spaceLabel,
    panelIds: visits.map((visit) => visit.panelId),
  };
}

function stack(nodes: LayoutNode[], direction: "row" | "column"): LayoutNode {
  if (nodes.length === 1) return nodes[0];
  return {
    type: "split",
    direction,
    ratio: 1 / nodes.length,
    first: nodes[0],
    second: stack(nodes.slice(1), direction),
  };
}

function gridOf(visits: PanelVisit[]): LayoutNode {
  const columns = visits.length <= 4 ? 2 : 3;
  const rows = Math.ceil(visits.length / columns);
  return {
    type: "grid",
    columns: Array.from({ length: columns }, () => 1),
    rows: Array.from({ length: rows }, () => 1),
    cells: visits.map((visit, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const remainder = visits.length % columns;
      const last = index === visits.length - 1;
      return {
        id: visit.panelId,
        title: visit.title,
        column,
        row,
        colSpan: last && remainder !== 0 ? columns - column : 1,
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
): OpenedVisit | { error: string } {
  if (typeof window === "undefined" || panels.length === 0) return { error: "panel was not found" };
  const hook = (
    window as Window & {
      __hwpVisitPanel?: (
        panels: { panelId: string; spaceId?: string }[],
        arrange?: string,
      ) => OpenedVisit | { error: string };
    }
  ).__hwpVisitPanel;
  if (!hook) return { error: "The desk could not show that panel." };
  return hook(panels, arrange);
}

export function requestPanelVisit(query: string, spaceId?: string): { panelId: string } | { error: string } {
  const opened = requestVisit([{ panelId: query, spaceId }]);
  if ("error" in opened) return opened;
  return { panelId: opened.panelIds[0] };
}
