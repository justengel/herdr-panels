import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { dropBeforeId } from "./spaceDrag";

export interface StripDrag {
  id: string;
  beforeId: string | null;
}

/** Drag a horizontal or vertical strip. Tabs carry `data-reorder-id`. */
export function useStripDrag(axis: "x" | "y", onDrop: (draggedId: string, beforeId: string | null) => void) {
  const listRef = useRef<HTMLDivElement>(null);
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;
  const gesture = useRef<{ id: string; point: number; dragging: boolean } | null>(null);
  const skipClick = useRef<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const [drag, setDrag] = useState<StripDrag | null>(null);
  useEffect(() => () => stopRef.current?.(), []);

  function pointOf(event: { clientX: number; clientY: number }): number {
    return axis === "x" ? event.clientX : event.clientY;
  }

  function measure(point: number, draggedId: string): string | null {
    const list = listRef.current;
    if (!list) return null;
    const rows = [...list.querySelectorAll<HTMLElement>("[data-reorder-id]")].map((node) => {
      const box = node.getBoundingClientRect();
      const id = node.dataset.reorderId ?? "";
      return axis === "x"
        ? { id, top: box.left, bottom: box.right }
        : { id, top: box.top, bottom: box.bottom };
    });
    return dropBeforeId(rows, point, draggedId);
  }

  function onPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("button, input, textarea, a")) return;
    const id = event.currentTarget.dataset.reorderId;
    if (!id) return;
    gesture.current = { id, point: pointOf(event), dragging: false };
    const move = (ev: PointerEvent) => {
      const start = gesture.current;
      if (!start || start.id !== id) return;
      const point = pointOf(ev);
      if (!start.dragging && Math.abs(point - start.point) < 5) return;
      start.dragging = true;
      const beforeId = measure(point, start.id);
      setDrag((current) =>
        current?.id === start.id && current.beforeId === beforeId ? current : { id: start.id, beforeId },
      );
    };
    const detach = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
      if (stopRef.current === detach) stopRef.current = null;
    };
    const end = (ev: PointerEvent) => {
      detach();
      const start = gesture.current;
      gesture.current = null;
      if (!start?.dragging) {
        setDrag(null);
        return;
      }
      skipClick.current = start.id;
      const beforeId = measure(pointOf(ev), start.id);
      setDrag(null);
      dropRef.current(start.id, beforeId);
    };
    const cancel = () => {
      detach();
      gesture.current = null;
      setDrag(null);
    };
    stopRef.current = detach;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
  }

  function swallowClick(id: string): boolean {
    if (skipClick.current !== id) return false;
    skipClick.current = null;
    return true;
  }

  return { listRef, drag, onPointerDown, swallowClick };
}
