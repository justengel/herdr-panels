import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PanelPlace } from "./layoutEdit";
import type { PanelConfig, TabEdge } from "./types";

export interface PanelActions {
  close: (id: string) => void;
  add: (id: string, direction: "row" | "column") => void;
  addTab: (id: string) => void;
  use: (id: string, type: PanelConfig["type"], pluginId?: string) => void;
  edge: (id: string, edge: TabEdge) => void;
  place: (sourceId: string, targetId: string, place: PanelPlace) => void;
  rename: (id: string, title: string) => void;
}

interface DragState {
  draggingId: string | null;
  start: (id: string, event: React.PointerEvent) => void;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface LiveDrag {
  id: string;
  title: string;
  x: number;
  y: number;
  origin: Rect;
  hint: { panelId: string; place: PanelPlace; rect: Rect } | null;
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
    const originX = event.clientX;
    const originY = event.clientY;
    let moved = false;
    let origin: Rect | null = null;
    let title = "Panel";
    const point = { x: event.clientX, y: event.clientY };

    const sectionOf = (panelId: string) =>
      document.querySelector<HTMLElement>(`[data-panel-id="${CSS.escape(panelId)}"]`);

    const targetAt = (x: number, y: number) => {
      const hit = document.elementsFromPoint(x, y).find((element) => element.closest("[data-panel-id]"));
      const panelId = hit?.closest("[data-panel-id]")?.getAttribute("data-panel-id") ?? null;
      if (!panelId || panelId === id) return null;
      const section = sectionOf(panelId);
      if (!section) return null;
      const rect = clientRect(section);
      return { panelId, place: placeAt(rect, x, y), rect: slotRect(rect, placeAt(rect, x, y)) };
    };

    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove("panel-dragging");
      if (commit && moved) {
        const next = targetAt(point.x, point.y);
        if (next) actionsRef.current.place(id, next.panelId, next.place);
      }
      setDraggingId(null);
      setLive(null);
    };

    const move = (ev: PointerEvent) => {
      point.x = ev.clientX;
      point.y = ev.clientY;
      if (!moved && Math.hypot(ev.clientX - originX, ev.clientY - originY) < 6) return;
      if (!moved) {
        moved = true;
        const section = sectionOf(id);
        origin = section ? clientRect(section) : { left: ev.clientX, top: ev.clientY, width: 240, height: 120 };
        title =
          section?.querySelector(".panel-title strong")?.textContent?.trim() ||
          section?.querySelector(".side-heading")?.textContent?.trim().split("\n")[0] ||
          "Panel";
        setDraggingId(id);
        document.body.classList.add("panel-dragging");
        setLive({
          id,
          title,
          x: origin.left + origin.width / 2,
          y: origin.top + origin.height / 2,
          origin,
          hint: null,
        });
        const home = origin;
        requestAnimationFrame(() => {
          setLive((current) =>
            current && current.id === id
              ? { ...current, x: point.x, y: point.y, origin: home, hint: targetAt(point.x, point.y) }
              : current,
          );
        });
        return;
      }
      setLive({
        id,
        title,
        x: ev.clientX,
        y: ev.clientY,
        origin: origin!,
        hint: targetAt(ev.clientX, ev.clientY),
      });
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
  }, []);

  const drag = useMemo(() => ({ draggingId, start }), [draggingId, start]);
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
        {live.hint ? <small>{PLACE_LABEL[live.hint.place]}</small> : null}
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

function placeAt(rect: Rect, x: number, y: number): PanelPlace {
  const px = rect.width <= 0 ? 0.5 : (x - rect.left) / rect.width;
  const py = rect.height <= 0 ? 0.5 : (y - rect.top) / rect.height;
  const edge = 0.32;
  const dx = Math.min(px, 1 - px);
  const dy = Math.min(py, 1 - py);
  if (dx <= edge && dx <= dy) return px < 0.5 ? "left" : "right";
  if (dy <= edge && dy < dx) return py < 0.5 ? "above" : "below";
  return "center";
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
