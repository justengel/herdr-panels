import { scaledRect, type ScreenRect } from "./frameSelect";
import { boxBias, shiftBox } from "./selectFit";

let pointerMatchesRect: boolean | null = null;

/**
 * True when getBoundingClientRect already agrees with elementFromPoint.
 * CSS zoom on Chromium reports the layout box while the pointer and position:fixed use the painted box.
 */
export function layoutRectsMatchPointer(): boolean {
  if (pointerMatchesRect !== null) return pointerMatchesRect;
  pointerMatchesRect = true;
  try {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:0;top:0;width:80px;height:40px;zoom:2;opacity:0;z-index:2147483647";
    const child = document.createElement("div");
    child.style.cssText = "width:20px;height:10px;margin:4px";
    host.append(child);
    (document.body || document.documentElement).append(host);
    const rect = child.getBoundingClientRect();
    pointerMatchesRect = document.elementFromPoint(rect.left + 1, rect.top + 1) === child;
    host.remove();
  } catch {
    pointerMatchesRect = true;
  }
  return pointerMatchesRect;
}

/** The CSS zoom that paints this element, walking ancestors. The property itself is not inherited. */
export function cssZoomOf(element: Element): number {
  let zoom = 1;
  let node: Element | null = element;
  while (node) {
    const value = Number(getComputedStyle(node).zoom);
    if (Number.isFinite(value) && value > 0) zoom *= value;
    node = node.parentElement;
  }
  return zoom;
}

/** Scale a layout rect by this to land on the painted element. 1 when the engine already did that. */
export function visualScale(element: Element): number {
  return layoutRectsMatchPointer() ? 1 : cssZoomOf(element);
}

export function visualBox(element: Element): ScreenRect {
  const raw = element.getBoundingClientRect();
  const shifted = shiftBox(raw, boxBias(element.ownerDocument));
  return scaledRect(shifted, visualScale(element));
}
