export interface LocalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

function scaleOf(zoom: number): number {
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

/**
 * A layout rect painted under CSS zoom. The zoom grows from the top-left of the viewport.
 * A scale of 1 leaves the rect alone.
 */
export function scaledRect(rect: { left: number; top: number; width: number; height: number }, zoom: number): ScreenRect {
  const scale = scaleOf(zoom);
  const left = rect.left * scale;
  const top = rect.top * scale;
  const width = Math.max(0, rect.width * scale);
  const height = Math.max(0, rect.height * scale);
  return { left, top, width, height, right: left + width, bottom: top + height };
}

export function shiftRect(frame: { left: number; top: number }, local: LocalRect): ScreenRect {
  return frameRect(frame, 1, local);
}

/** Pointer position inside a frame whose rectangle is still in unzoomed layout pixels. */
export function framePoint(
  frame: { left: number; top: number },
  zoom: number,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const scale = scaleOf(zoom);
  return { x: clientX / scale - frame.left, y: clientY / scale - frame.top };
}

/** A box the frame reported in its own visual pixels, placed on the screen. */
export function frameRect(frame: { left: number; top: number }, zoom: number, local: LocalRect): ScreenRect {
  const scale = scaleOf(zoom);
  const left = (frame.left + local.x) * scale;
  const top = (frame.top + local.y) * scale;
  const width = Math.max(0, local.width * scale);
  const height = Math.max(0, local.height * scale);
  return { left, top, width, height, right: left + width, bottom: top + height };
}

export function toFrame(frame: { left: number; top: number }, box: { left: number; top: number; width: number; height: number }): LocalRect {
  return frameBox(frame, 1, box);
}

/** A screen box described in a frame's visual pixels. */
export function frameBox(
  frame: { left: number; top: number },
  zoom: number,
  box: { left: number; top: number; width: number; height: number },
): LocalRect {
  const scale = scaleOf(zoom);
  return {
    x: box.left / scale - frame.left,
    y: box.top / scale - frame.top,
    width: box.width / scale,
    height: box.height / scale,
  };
}

export function intersects(
  frame: { left: number; top: number; width: number; height: number },
  box: { left: number; top: number; width: number; height: number },
): boolean {
  return (
    frame.left < box.left + box.width &&
    frame.left + frame.width > box.left &&
    frame.top < box.top + box.height &&
    frame.top + frame.height > box.top
  );
}
