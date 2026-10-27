import { desktopHost } from "./desktopBrowser";

/** Chromium's page-zoom steps. 1 is 100 percent. */
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

const STORAGE = "herdr-panels.zoom";

export function nearestZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  let best = ZOOM_STEPS[0];
  for (const step of ZOOM_STEPS) {
    if (Math.abs(step - value) < Math.abs(best - value)) best = step;
  }
  return best;
}

/** The session bar is drawn at this scale so window zoom does not enlarge it. */
export function topBarCounterZoom(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return 1 / scale;
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
}): "in" | "out" | "reset" | null {
  if (event.altKey || (!event.ctrlKey && !event.metaKey)) return null;
  if (event.key === "=" || event.key === "+") return "in";
  if (event.key === "-" || event.key === "_") return "out";
  if (event.key === "0") return "reset";
  return null;
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

function readStoredZoom(): number {
  try {
    return nearestZoom(Number(localStorage.getItem(STORAGE)));
  } catch {
    return 1;
  }
}

function rememberZoom(zoom: number) {
  try {
    localStorage.setItem(STORAGE, String(zoom));
  } catch {
    // The next launch stays at 100 percent.
  }
}

/** Ctrl or Cmd with wheel, plus, minus, and 0 scale the desktop window. The browser already does this itself. */
export function installDisplayZoom(): () => void {
  const host = desktopHost();
  if (!host) return () => {};
  let zoom = readStoredZoom();
  let pending = 0;
  const apply = (next: number) => {
    zoom = nearestZoom(next);
    rememberZoom(zoom);
    document.documentElement.style.setProperty("--topbar-zoom", String(topBarCounterZoom(zoom)));
    void host.invoke("set_display_zoom", { scale: zoom }).then(() => {
      window.dispatchEvent(new Event("herdr-zoom"));
    });
  };
  apply(zoom);
  const onKey = (event: KeyboardEvent) => {
    const chord = zoomChord(event);
    if (!chord) return;
    event.preventDefault();
    event.stopPropagation();
    if (chord === "reset") apply(1);
    else apply(stepZoom(zoom, chord === "in" ? 1 : -1));
  };
  const onWheel = (event: WheelEvent) => {
    // The desktop hook owns Ctrl+wheel, including over a browser panel, which never reaches this listener.
    if ((window as { __herdrZoomCaptured?: boolean }).__herdrZoomCaptured) return;
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    const consumed = consumeZoomWheel(pending, event.deltaY);
    pending = consumed.pending;
    if (consumed.steps === 0) return;
    const direction = consumed.steps > 0 ? 1 : -1;
    let next = zoom;
    for (let i = 0; i < Math.abs(consumed.steps); i += 1) next = stepZoom(next, direction);
    apply(next);
  };
  const onStep = (event: Event) => {
    const steps = (event as CustomEvent<number>).detail;
    if (typeof steps !== "number" || !steps) return;
    const direction = steps > 0 ? 1 : -1;
    let next = zoom;
    for (let i = 0; i < Math.abs(steps); i += 1) next = stepZoom(next, direction);
    apply(next);
  };
  const onSet = (event: Event) => {
    const scale = (event as CustomEvent<number>).detail;
    if (typeof scale !== "number" || !Number.isFinite(scale)) return;
    apply(scale);
  };
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("wheel", onWheel, { capture: true, passive: false });
  window.addEventListener("herdr-zoom-step", onStep);
  window.addEventListener("herdr-zoom-set", onSet);
  return () => {
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("wheel", onWheel, { capture: true });
    window.removeEventListener("herdr-zoom-step", onStep);
    window.removeEventListener("herdr-zoom-set", onSet);
  };
}
