import { createContext, createElement, useContext, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { desktopHost } from "./desktopBrowser";

/**
 * 10% from 50% through 200%. 25% outside that, from 25% to 300%.
 * The same list lives in `src/server.rs`.
 */
export const ZOOM_STEPS = [
  0.25, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2, 2.25, 2.5, 2.75, 3,
];

const STORAGE = "herdr-panels.panel-zoom";
const LEGACY_WINDOW_ZOOM = "herdr-panels.zoom";
const TERMINAL_FONT = 14;

export type ZoomChord = "in" | "out" | "reset";

export type KeyZoom =
  | { type: "panel"; id: string; direction: 1 | -1 | 0 }
  | { type: "reset-all" }
  | { type: "ignore" };

export function nearestZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  let best = ZOOM_STEPS[0];
  for (const step of ZOOM_STEPS) {
    if (Math.abs(step - value) < Math.abs(best - value)) best = step;
  }
  return best;
}

export function stepZoom(current: number, direction: 1 | -1): number {
  const snapped = nearestZoom(current);
  const index = ZOOM_STEPS.indexOf(snapped);
  const next = Math.min(ZOOM_STEPS.length - 1, Math.max(0, index + direction));
  return ZOOM_STEPS[next];
}

export function zoomChord(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): ZoomChord | null {
  if (event.altKey || (!event.ctrlKey && !event.metaKey)) return null;
  if (event.key === "=" || event.key === "+") return "in";
  if (event.key === "-" || event.key === "_") return "out";
  if (event.key === "0") return "reset";
  return null;
}

/**
 * Ctrl++ / Ctrl+- / Ctrl+0 follow the gold bar.
 * With nothing keyed, they follow the panel under the pointer.
 * With neither, only Ctrl+0 does anything, and it resets every panel.
 */
export function keyZoom(chord: ZoomChord, keyedId: string | null, hoveredId: string | null): KeyZoom {
  const id = keyedId ?? hoveredId;
  if (!id) {
    return chord === "reset" ? { type: "reset-all" } : { type: "ignore" };
  }
  const direction = chord === "in" ? 1 : chord === "out" ? -1 : 0;
  return { type: "panel", id, direction };
}

/** The wheel zooms the panel under the pointer. The session bar is not a panel. */
export function wheelPanel(panelId: string | null, onSessionBar: boolean): string | null {
  if (onSessionBar || !panelId) return null;
  return panelId;
}

/**
 * Magnify the panel body. The frame stays put because `.panel-body` clips it.
 * Shrinking the box as well leaves the magnified content in the top-left corner.
 */
export function contentScaleStyle(scale: number): { zoom: number } | undefined {
  const snapped = nearestZoom(scale);
  if (snapped === 1) return undefined;
  return { zoom: snapped };
}

export function terminalFontSize(scale: number): number {
  return Math.round(TERMINAL_FONT * nearestZoom(scale) * 10) / 10;
}

/** A JSON map of panel id to scale. A leftover window-zoom number is ignored. */
export function parseStoredZooms(raw: string | null): Record<string, number> {
  if (!raw) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const stored: Record<string, number> = {};
  for (const [id, value] of Object.entries(data)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const snapped = nearestZoom(value);
    if (snapped !== 1) stored[id] = snapped;
  }
  return stored;
}

/** Trackpad deltas pile up until they cross one mouse notch. Positive steps zoom in. */
export function consumeZoomWheel(pending: number, deltaY: number): { pending: number; steps: number } {
  let total = pending + deltaY;
  let steps = 0;
  while (total <= -100) {
    total += 100;
    steps += 1;
  }
  while (total >= 100) {
    total -= 100;
    steps -= 1;
  }
  return { pending: total, steps };
}

const ScaleContext = createContext<CSSProperties | undefined>(undefined);

export function PanelScaleProvider({ style, children }: { style?: CSSProperties; children: ReactNode }) {
  return createElement(ScaleContext.Provider, { value: style }, children);
}

export function usePanelScaleStyle(): CSSProperties | undefined {
  return useContext(ScaleContext);
}

let levels: Record<string, number> = {};
const listeners = new Set<() => void>();

export function panelZoom(id: string): number {
  return levels[id] ?? 1;
}

export function subscribeZoom(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePanelZoom(id: string | undefined): number {
  return useSyncExternalStore(
    subscribeZoom,
    () => (id ? panelZoom(id) : 1),
    () => 1,
  );
}

function remember() {
  try {
    const stored: Record<string, number> = {};
    for (const [id, scale] of Object.entries(levels)) {
      if (scale !== 1) stored[id] = scale;
    }
    if (Object.keys(stored).length === 0) localStorage.removeItem(STORAGE);
    else localStorage.setItem(STORAGE, JSON.stringify(stored));
    localStorage.removeItem(LEGACY_WINDOW_ZOOM);
  } catch {
    // The next launch stays at 100 percent.
  }
}

function publish() {
  remember();
  for (const listener of listeners) listener();
}

export function setPanelZoom(id: string, scale: number) {
  if (!id) return;
  const snapped = nearestZoom(scale);
  const next = { ...levels };
  if (snapped === 1) delete next[id];
  else next[id] = snapped;
  levels = next;
  publish();
}

export function resetAllZooms() {
  levels = {};
  publish();
}

function stepPanel(id: string, direction: 1 | -1 | 0) {
  if (direction === 0) setPanelZoom(id, 1);
  else setPanelZoom(id, stepZoom(panelZoom(id), direction));
}

function applyChord(chord: ZoomChord, keyedId: string | null, hoveredId: string | null) {
  const aim = keyZoom(chord, keyedId, hoveredId);
  if (aim.type === "reset-all") resetAllZooms();
  else if (aim.type === "panel") stepPanel(aim.id, aim.direction);
}

function panelUnderPointer(element: Element | null): string | null {
  if (!element || element.closest(".topbar, .topbar-slot")) return null;
  return element.closest("[data-panel-id]")?.getAttribute("data-panel-id") ?? null;
}

function panelForBrowserLabel(label: string): string | null {
  const hole = document.querySelector(`[data-browser-label="${CSS.escape(label)}"]`);
  return hole?.closest("[data-panel-id]")?.getAttribute("data-panel-id") ?? null;
}

function readStored(): Record<string, number> {
  try {
    return parseStoredZooms(localStorage.getItem(STORAGE));
  } catch {
    return {};
  }
}

function framePanel(source: MessageEventSource | null): { frame: HTMLIFrameElement; id: string } | null {
  // A sandboxed frame is an opaque window. `source instanceof Window` is false there,
  // while `contentWindow === source` still identifies the frame.
  if (!source) return null;
  const frame = [...document.querySelectorAll("iframe")].find(
    (node) => node instanceof HTMLIFrameElement && node.contentWindow === source,
  );
  if (!(frame instanceof HTMLIFrameElement)) return null;
  const id = frame.closest("[data-panel-id]")?.getAttribute("data-panel-id");
  if (!id) return null;
  return { frame, id };
}

/** Tell each plugin or HTML page its zoom. CSS zoom on this page does not reach a sandboxed frame. */
function pushFrameZooms() {
  document.querySelectorAll("iframe").forEach((node) => {
    if (!(node instanceof HTMLIFrameElement) || !node.contentWindow) return;
    const id = node.closest("[data-panel-id]")?.getAttribute("data-panel-id");
    if (!id) return;
    node.contentWindow.postMessage({ source: "hwp-host", type: "zoom", scale: panelZoom(id) }, "*");
  });
}

/** Ctrl or Cmd with wheel, plus, minus, and 0 scale one panel. The window itself stays at 100%. */
export function installDisplayZoom(options: { keyedId: () => string | null }): () => void {
  const host = desktopHost();
  levels = readStored();
  publish();
  if (host) void host.invoke("set_display_zoom", { scale: 1 });
  let pending = 0;
  let hoveredId: string | null = null;
  const aimChord = (chord: ZoomChord) => {
    if (options.keyedId()) {
      applyChord(chord, options.keyedId(), null);
      return;
    }
    void hoverPanel().then((hovered) => {
      applyChord(chord, options.keyedId(), hovered);
    });
  };
  const hoverPanel = async (): Promise<string | null> => {
    if (host) {
      try {
        const place = (await host.invoke("cursor_place")) as { kind?: string; label?: string } | null;
        if (!place || place.kind === "away") return null;
        if (place.kind === "browser" && place.label) return panelForBrowserLabel(place.label);
      } catch {
        // An older window has no cursor query. The last pointer move still names a page panel.
      }
    }
    return hoveredId;
  };
  const onPointer = (event: PointerEvent) => {
    const element = event.target instanceof Element ? event.target : null;
    hoveredId = panelUnderPointer(element);
  };
  const onKey = (event: KeyboardEvent) => {
    const chord = zoomChord(event);
    if (!chord) return;
    event.preventDefault();
    event.stopPropagation();
    aimChord(chord);
  };
  const onChord = (event: Event) => {
    const chord = (event as CustomEvent<string>).detail;
    if (chord !== "in" && chord !== "out" && chord !== "reset") return;
    aimChord(chord);
  };
  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    const element = event.target instanceof Element ? event.target : null;
    const onSessionBar = Boolean(element?.closest(".topbar, .topbar-slot"));
    const panelId = element?.closest("[data-panel-id]")?.getAttribute("data-panel-id") ?? null;
    const id = wheelPanel(panelId, onSessionBar);
    if (!id) return;
    const consumed = consumeZoomWheel(pending, event.deltaY);
    pending = consumed.pending;
    if (consumed.steps === 0) return;
    const direction = consumed.steps > 0 ? 1 : -1;
    let next = panelZoom(id);
    for (let i = 0; i < Math.abs(consumed.steps); i += 1) next = stepZoom(next, direction);
    setPanelZoom(id, next);
  };
  const onStep = (event: Event) => {
    const detail = (event as CustomEvent<{ label?: string; steps?: number }>).detail;
    const steps = detail?.steps;
    const label = detail?.label;
    if (typeof steps !== "number" || !steps || typeof label !== "string" || !label) return;
    const id = panelForBrowserLabel(label);
    if (!id) return;
    const direction = steps > 0 ? 1 : -1;
    let next = panelZoom(id);
    for (let i = 0; i < Math.abs(steps); i += 1) next = stepZoom(next, direction);
    setPanelZoom(id, next);
  };
  const onSet = (event: Event) => {
    const detail = (event as CustomEvent<{ scale?: number; panelId?: string }>).detail;
    if (!detail || typeof detail.scale !== "number" || typeof detail.panelId !== "string") return;
    setPanelZoom(detail.panelId, detail.scale);
  };
  const stepBy = (id: string, steps: number) => {
    if (!steps) return;
    const direction = steps > 0 ? 1 : -1;
    let next = panelZoom(id);
    for (let i = 0; i < Math.abs(steps); i += 1) next = stepZoom(next, direction);
    setPanelZoom(id, next);
  };
  const onFrame = (event: MessageEvent) => {
    const data = event.data as { source?: string; type?: string; deltaY?: number; key?: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } | null;
    if (data?.source === "hwp-keys" && data.type === "ready") {
      pushFrameZooms();
      return;
    }
    if (!data || data.source !== "hwp-frame") return;
    const owned = framePanel(event.source);
    if (!owned) return;
    if (data.type === "zoom-wheel") {
      if (typeof data.deltaY !== "number" || data.deltaY === 0) return;
      const consumed = consumeZoomWheel(pending, data.deltaY);
      pending = consumed.pending;
      stepBy(owned.id, consumed.steps);
      return;
    }
    if (data.type === "zoom-key") {
      const chord = zoomChord({
        key: String(data.key ?? ""),
        ctrlKey: Boolean(data.ctrlKey),
        metaKey: Boolean(data.metaKey),
        altKey: Boolean(data.altKey),
      });
      if (chord) applyChord(chord, owned.id, null);
    }
  };
  const unsubscribeFrames = subscribeZoom(pushFrameZooms);
  pushFrameZooms();
  window.addEventListener("pointermove", onPointer, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("wheel", onWheel, { capture: true, passive: false });
  window.addEventListener("message", onFrame);
  window.addEventListener("herdr-zoom-step", onStep);
  window.addEventListener("herdr-zoom-set", onSet);
  window.addEventListener("herdr-zoom-chord", onChord);
  return () => {
    unsubscribeFrames();
    window.removeEventListener("pointermove", onPointer, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("wheel", onWheel, { capture: true });
    window.removeEventListener("message", onFrame);
    window.removeEventListener("herdr-zoom-step", onStep);
    window.removeEventListener("herdr-zoom-set", onSet);
    window.removeEventListener("herdr-zoom-chord", onChord);
  };
}
