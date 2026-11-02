import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PanelPlace } from "./layoutEdit";
import { dropPlace, type DropPlace } from "./panelDrop";
import type { PanelConfig, TabEdge } from "./types";

export interface PanelActions {
  close: (id: string) => void;
  add: (id: string, direction: "row" | "column") => void;
  addTab: (id: string) => void;
  use: (id: string, type: PanelConfig["type"], pluginId?: string) => void;
  edge: (id: string, edge: TabEdge) => void;
  place: (sourceId: string, targetId: string, place: PanelPlace) => void;
  /** Drop a panel onto another panel's bar and make one tab group. */
  group: (sourceId: string, targetId: string) => void;
  /** Drag one tab onto a bar, or out beside a panel. */
  dropTab: (sourceId: string, tabId: string, targetId: string, place: DropPlace) => void;
  /** Split a new panel beside this one. */
  spawn: (id: string, direction: "row" | "column", panel: PanelConfig, title: string) => void;
  rename: (id: string, title: string) => void;
  icon: (id: string, icon: string | null) => void;
  collapse: (id: string) => void;
  /** Fill the screen with this panel, or show the whole desk when it already does. */
  fill: (id: string) => void;
  /** Drop this panel from the visit. The panel itself stays where it was. */
  leave: (id: string) => void;
  filledId: string | null;
}

interface DragState {
  draggingId: string | null;
  start: (id: string, event: React.PointerEvent) => void;
  startTab: (panelId: string, tabId: string, event: PointerEvent) => void;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface LiveDrag {
  id: string;
  tabId: string | null;
  title: string;
  x: number;
  y: number;
  origin: Rect;
  hint: { panelId: string; place: DropPlace; rect: Rect } | null;
}

const ActionsContext = createContext<PanelActions | null>(null);
const DragContext = createContext<DragState | null>(null);

const PLACE_LABEL: Record<PanelPlace, string> = {
  left: "Place on the left",
  right: "Place on the right",
  above: "Place above",
  below: "Place below",
  center: "Swap",
};

function placeLabel(place: DropPlace): string {
  if (place === "bar") return "Group on this bar";
  return PLACE_LABEL[place];
}

export function PanelActionsProvider({
  actions,
  children,
}: {
  actions: PanelActions;
  children: React.ReactNode;
}) {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [live, setLive] = useState<LiveDrag | null>(null);

  const begin = useCallback((panelId: string, tabId: string | null, originX: number, originY: number, movedAlready: boolean) => {
    let moved = false;
    let closed = false;
    let frame = 0;
    let origin: Rect | null = null;
    let title = tabId ?? "Panel";
    const point = { x: originX, y: originY };

    const sectionOf = (id: string) =>
      document.querySelector<HTMLElement>(`[data-panel-id="${CSS.escape(id)}"]`);

    const targetAt = (x: number, y: number) => {
      const hit = document.elementsFromPoint(x, y).find((element) => element.closest("[data-panel-id]"));
      const hitId = hit?.closest("[data-panel-id]")?.getAttribute("data-panel-id") ?? null;
      if (!hitId) return null;
      const section = sectionOf(hitId);
      if (!section) return null;
      const rect = clientRect(section);
      const barEl = section.querySelector<HTMLElement>("[data-panel-bar]");
      const bar = barEl ? clientRect(barEl) : null;
      const place = dropPlace(rect, x, y, bar);
      if (tabId) {
        if (hitId === panelId && (place === "bar" || place === "center")) return null;
      } else if (hitId === panelId) {
        return null;
      }
      const zone = place === "bar" && bar ? bar : slotRect(rect, place === "bar" ? "center" : place);
      return { panelId: hitId, place, rect: zone };
    };

    const publish = (x: number, y: number) => {
      if (closed || !origin) return;
      setLive({
        id: panelId,
        tabId,
        title,
        x,
        y,
        origin,
        hint: targetAt(x, y),
      });
    };

    const arm = (x: number, y: number) => {
      moved = true;
      const section = sectionOf(panelId);
      origin = section ? clientRect(section) : { left: x, top: y, width: 240, height: 120 };
      if (tabId) {
        const label = section
          ?.querySelector(`[data-reorder-id="${CSS.escape(tabId)}"] .tab-label`)
          ?.textContent?.trim();
        title = label || tabId;
      } else {
        title =
          section?.querySelector(".panel-title strong")?.textContent?.trim() ||
          section?.querySelector(".side-heading")?.textContent?.trim().split("\n")[0] ||
          "Panel";
        setDraggingId(panelId);
      }
      document.body.classList.add("panel-dragging");
    };

    const finish = (commit: boolean) => {
      if (closed) return;
      closed = true;
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove("panel-dragging");
      if (commit && moved) {
        const next = targetAt(point.x, point.y);
        if (next) {
          if (tabId) actionsRef.current.dropTab(panelId, tabId, next.panelId, next.place);
          else if (next.place === "bar") actionsRef.current.group(panelId, next.panelId);
          else actionsRef.current.place(panelId, next.panelId, next.place);
        }
      }
      setDraggingId(null);
      setLive(null);
    };

    const move = (ev: PointerEvent) => {
      point.x = ev.clientX;
      point.y = ev.clientY;
      if (!moved && Math.hypot(ev.clientX - originX, ev.clientY - originY) < 6) return;
      if (!moved) {
        arm(ev.clientX, ev.clientY);
        frame = requestAnimationFrame(() => publish(point.x, point.y));
        return;
      }
      publish(ev.clientX, ev.clientY);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") finish(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", onKey);
    if (movedAlready) {
      arm(originX, originY);
      publish(originX, originY);
    }
  }, []);

  const start = useCallback((id: string, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget instanceof HTMLElement) {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // The pointer can already be gone. Window listeners still follow the drag.
      }
    }
    begin(id, null, event.clientX, event.clientY, false);
  }, [begin]);

  const startTab = useCallback((panelId: string, tabId: string, event: PointerEvent) => {
    begin(panelId, tabId, event.clientX, event.clientY, true);
  }, [begin]);

  const drag = useMemo(() => ({ draggingId, start, startTab }), [draggingId, start, startTab]);
  return (
    <ActionsContext.Provider value={actions}>
      <DragContext.Provider value={drag}>
        {children}
        {live ? <DragOverlay live={live} /> : null}
      </DragContext.Provider>
    </ActionsContext.Provider>
  );
}

function DragOverlay({ live }: { live: LiveDrag }) {
  const band = live.hint ? inset(live.hint.rect, 8) : followRect(live);
  const strips = live.hint ? edgeStrips(panelRect(live.hint.panelId) ?? live.hint.rect) : [];
  return createPortal(
    <div className="drag-layer" aria-hidden="true">
      {strips.map((strip) =>
        strip.place === live.hint?.place ? null : (
          <div
            key={strip.place}
            className="drag-zone"
            style={{ left: strip.rect.left, top: strip.rect.top, width: strip.rect.width, height: strip.rect.height }}
          />
        ),
      )}
      <div
        className={live.hint ? "drag-band landing" : "drag-band"}
        style={{ left: band.left, top: band.top, width: band.width, height: band.height }}
      >
        <span>{live.title}</span>
        {live.hint ? <small>{placeLabel(live.hint.place)}</small> : null}
      </div>
    </div>,
    document.body,
  );
}

function panelRect(id: string): Rect | null {
  const section = document.querySelector<HTMLElement>(`[data-panel-id="${CSS.escape(id)}"]`);
  return section ? clientRect(section) : null;
}

function clientRect(element: HTMLElement): Rect {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function slotRect(rect: Rect, place: PanelPlace): Rect {
  const share = 0.5;
  if (place === "left") return { left: rect.left, top: rect.top, width: rect.width * share, height: rect.height };
  if (place === "right") {
    return { left: rect.left + rect.width * (1 - share), top: rect.top, width: rect.width * share, height: rect.height };
  }
  if (place === "above") return { left: rect.left, top: rect.top, width: rect.width, height: rect.height * share };
  if (place === "below") {
    return { left: rect.left, top: rect.top + rect.height * (1 - share), width: rect.width, height: rect.height * share };
  }
  return rect;
}

function edgeStrips(rect: Rect): { place: Exclude<PanelPlace, "center">; rect: Rect }[] {
  const thickness = Math.min(28, rect.width * 0.16, rect.height * 0.16);
  return [
    { place: "left", rect: { left: rect.left, top: rect.top, width: thickness, height: rect.height } },
    { place: "right", rect: { left: rect.left + rect.width - thickness, top: rect.top, width: thickness, height: rect.height } },
    { place: "above", rect: { left: rect.left, top: rect.top, width: rect.width, height: thickness } },
    { place: "below", rect: { left: rect.left, top: rect.top + rect.height - thickness, width: rect.width, height: thickness } },
  ];
}

function inset(rect: Rect, amount: number): Rect {
  return {
    left: rect.left + amount,
    top: rect.top + amount,
    width: Math.max(0, rect.width - amount * 2),
    height: Math.max(0, rect.height - amount * 2),
  };
}

function followRect(live: LiveDrag): Rect {
  const width = Math.min(240, Math.max(160, live.origin.width * 0.55));
  const height = Math.min(120, Math.max(64, live.origin.height * 0.35));
  return {
    left: live.x - width * 0.3,
    top: live.y - 18,
    width,
    height,
  };
}

export function usePanelActions(): PanelActions {
  const actions = useContext(ActionsContext);
  if (!actions) throw new Error("panel actions are missing");
  return actions;
}

export function usePanelDrag(): DragState {
  const drag = useContext(DragContext);
  if (!drag) throw new Error("panel drag is missing");
  return drag;
}
