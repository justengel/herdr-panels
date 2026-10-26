import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

export interface MenuBox {
  left: number;
  top: number;
  maxWidth: number;
  maxHeight: number;
}

export function fitMenu(
  rect: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8,
): MenuBox {
  const maxWidth = Math.max(120, viewport.width - margin * 2);
  const width = Math.min(Math.max(rect.width, 0), maxWidth);
  let left = rect.left;
  if (left + width > viewport.width - margin) left = viewport.width - margin - width;
  if (left < margin) left = margin;
  const maxBox = Math.max(80, viewport.height - margin * 2);
  const height = Math.min(Math.max(rect.height, 0), maxBox);
  let top = rect.top;
  if (top + height > viewport.height - margin) top = viewport.height - margin - height;
  if (top < margin) top = margin;
  return {
    left,
    top,
    maxWidth,
    maxHeight: Math.max(80, viewport.height - margin - top),
  };
}

export interface FlyoutBox {
  left: number;
  top: number;
  maxHeight: number;
  side: "left" | "right";
}

/** Place a nested flyout beside an anchor; flip left when the right edge is tight. */
export function fitFlyout(
  anchor: { left: number; top: number; right: number; bottom: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8,
  gap = 4,
): FlyoutBox {
  const width = Math.max(120, size.width);
  const height = Math.max(40, size.height);
  const roomRight = viewport.width - margin - (anchor.right + gap);
  const roomLeft = anchor.left - gap - margin;
  const side: "left" | "right" = roomRight >= width || roomRight >= roomLeft ? "right" : "left";
  let left = side === "right" ? anchor.right + gap : anchor.left - gap - width;
  if (left < margin) left = margin;
  if (left + width > viewport.width - margin) left = Math.max(margin, viewport.width - margin - width);
  let top = anchor.top;
  const maxHeight = Math.max(80, viewport.height - margin * 2);
  const usedHeight = Math.min(height, maxHeight);
  if (top + usedHeight > viewport.height - margin) top = viewport.height - margin - usedHeight;
  if (top < margin) top = margin;
  return {
    left,
    top,
    maxHeight: Math.max(80, viewport.height - margin - top),
    side,
  };
}

export function useKeepMenuOnScreen(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  anchor = "",
): MenuBox | null {
  const [viewport, setViewport] = useState(() => ({
    w: typeof window === "undefined" ? 0 : window.innerWidth,
    h: typeof window === "undefined" ? 0 : window.innerHeight,
  }));
  useEffect(() => {
    const sync = () => {
      setViewport((prev) =>
        prev.w === window.innerWidth && prev.h === window.innerHeight
          ? prev
          : { w: window.innerWidth, h: window.innerHeight },
      );
    };
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);
  const key = open ? `${anchor}|${viewport.w}x${viewport.h}` : "";
  const [tracked, setTracked] = useState(key);
  const [box, setBox] = useState<MenuBox | null>(null);
  if (tracked !== key) {
    setTracked(key);
    setBox(null);
  }
  useLayoutEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const next = fitMenu(rect, { width: window.innerWidth, height: window.innerHeight });
    setBox((prev) =>
      prev &&
      prev.left === next.left &&
      prev.top === next.top &&
      prev.maxWidth === next.maxWidth &&
      prev.maxHeight === next.maxHeight
        ? prev
        : next,
    );
  }, [open, key, ref]);
  return box;
}
