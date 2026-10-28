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

export function requestPanelVisit(query: string, spaceId?: string): { panelId: string } | { error: string } {
  if (typeof window === "undefined" || !query.trim()) return { error: "panel was not found" };
  const hook = (
    window as Window & {
      __hwpVisitPanel?: (query: string, spaceId?: string) => { panelId: string } | { error: string };
    }
  ).__hwpVisitPanel;
  if (!hook) return { error: "The desk could not show that panel." };
  return hook(query, spaceId);
}
