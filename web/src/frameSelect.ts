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

export function shiftRect(frame: { left: number; top: number }, local: LocalRect): ScreenRect {
  const left = frame.left + local.x;
  const top = frame.top + local.y;
  const width = Math.max(0, local.width);
  const height = Math.max(0, local.height);
  return { left, top, width, height, right: left + width, bottom: top + height };
}

export function toFrame(frame: { left: number; top: number }, box: { left: number; top: number; width: number; height: number }): LocalRect {
  return {
    x: box.left - frame.left,
    y: box.top - frame.top,
    width: box.width,
    height: box.height,
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
