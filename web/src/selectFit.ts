export interface PlainRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A fixed corner probe that the pointer hits, whose reported box is not the origin,
 * means every reported box is shifted by that much. The shift is the webview's
 * distance from the window corner: a top strip and the panels beside a side strip.
 */
export function reportedOffset(
  rect: { left: number; top: number },
  pointerHitsProbeAtOrigin: boolean,
): { x: number; y: number } {
  if (!pointerHitsProbeAtOrigin) return { x: 0, y: 0 };
  const x = Number(rect.left) || 0;
  const y = Number(rect.top) || 0;
  if (Math.abs(x) < 1 && Math.abs(y) < 1) return { x: 0, y: 0 };
  return { x, y };
}

export function shiftBox(rect: PlainRect, offset: { x: number; y: number }): PlainRect {
  return {
    left: rect.left - offset.x,
    top: rect.top - offset.y,
    width: rect.width,
    height: rect.height,
  };
}

function scaleBox(rect: PlainRect, zoom: number): PlainRect {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return {
    left: rect.left * scale,
    top: rect.top * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

/** The reported box, that box times zoom, or that box divided by zoom. Whichever the pointer hits. */
export function chooseRect(raw: PlainRect, zoom: number, hits: (box: PlainRect) => boolean): PlainRect {
  if (hits(raw)) return raw;
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  if (scale !== 1) {
    const grown = scaleBox(raw, scale);
    if (hits(grown)) return grown;
    const shrunk = scaleBox(raw, 1 / scale);
    if (hits(shrunk)) return shrunk;
  }
  return raw;
}

/**
 * CSS was set to `visual` and the box came back as `landed`.
 * Returns the CSS that lands on `visual` for a scale and a shift.
 */
export function cssForVisual(visual: PlainRect, landed: PlainRect): PlainRect {
  const sx = visual.width > 0 ? landed.width / visual.width : 1;
  const sy = visual.height > 0 ? landed.height / visual.height : 1;
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx === 0 || sy === 0) {
    return { left: visual.left, top: visual.top, width: visual.width, height: visual.height };
  }
  const ox = landed.left - visual.left * sx;
  const oy = landed.top - visual.top * sy;
  return {
    left: (visual.left - ox) / sx,
    top: (visual.top - oy) / sy,
    width: visual.width / sx,
    height: visual.height / sy,
  };
}

const biases = new WeakMap<Document, { x: number; y: number }>();

/** Measure once. A correct engine reports the corner probe at the origin and this stays zero. */
export function boxBias(doc: Document): { x: number; y: number } {
  const cached = biases.get(doc);
  if (cached) return cached;
  const measured = measureBoxBias(doc);
  biases.set(doc, measured);
  return measured;
}

function measureBoxBias(doc: Document): { x: number; y: number } {
  const none = { x: 0, y: 0 };
  const parent = doc.body || doc.documentElement;
  if (!parent || typeof doc.elementFromPoint !== "function") return none;
  const probe = doc.createElement("div");
  probe.style.cssText =
    "position:fixed;left:0;top:0;width:8px;height:8px;z-index:2147483647;background:#000;pointer-events:auto;";
  try {
    parent.append(probe);
    const rect = probe.getBoundingClientRect();
    const hit = doc.elementFromPoint(1, 1);
    return reportedOffset(rect, hit === probe);
  } catch {
    return none;
  } finally {
    probe.remove();
  }
}
