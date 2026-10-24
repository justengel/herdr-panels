import { useEffect, useRef, useState, type CSSProperties } from "react";

interface Props {
  onNotice: (message: string) => void;
  onClose: () => void;
}

interface Selection {
  elements: HTMLElement[];
  rects: DOMRect[];
  bounds: DOMRect;
}

const ITEM =
  "button, a, input, textarea, select, label, li, h1, h2, h3, h4, h5, h6, p, pre, blockquote, .tree-row, .agent-row, .space-row, .panel-title, [role='tab']";

export function ElementSelect({ onNotice, onClose }: Props) {
  const [hover, setHover] = useState<DOMRect | null>(null);
  const [marquee, setMarquee] = useState<DOMRect | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const closeRef = useRef(onClose);
  const noticeRef = useRef(onNotice);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const chosen = useRef<HTMLElement[]>([]);
  closeRef.current = onClose;
  noticeRef.current = onNotice;

  useEffect(() => {
    document.body.classList.add("is-selecting");
    const skip = (target: EventTarget | null) =>
      target instanceof Element && Boolean(target.closest(".topbar, .select-menu"));
    const remember = (elements: HTMLElement[]) => {
      chosen.current = elements;
      setSelection(elements.length > 0 ? pack(elements) : null);
    };
    const onMove = (event: PointerEvent) => {
      const start = drag.current;
      if (start && event.buttons === 1) {
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (!start.moved && Math.hypot(dx, dy) < 4) return;
        start.moved = true;
        setHover(null);
        setMarquee(rectFromPoints(start.x, start.y, event.clientX, event.clientY));
        return;
      }
      if (drag.current) return;
      if (skip(event.target)) {
        setHover(null);
        return;
      }
      const element = event.target instanceof HTMLElement ? event.target : null;
      if (!element || element === document.body || element === document.documentElement) {
        setHover(null);
        return;
      }
      setHover(element.getBoundingClientRect());
    };
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 || skip(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      drag.current = { x: event.clientX, y: event.clientY, moved: false };
      setHover(null);
      remember([]);
    };
    const onUp = (event: PointerEvent) => {
      const start = drag.current;
      if (!start) return;
      drag.current = null;
      setMarquee(null);
      if (start.moved) {
        event.preventDefault();
        event.stopPropagation();
        const box = rectFromPoints(start.x, start.y, event.clientX, event.clientY);
        const elements = elementsIn(box);
        remember(elements);
        if (elements.length === 0) noticeRef.current("Nothing in that box");
        return;
      }
      const element = event.target instanceof HTMLElement ? event.target : null;
      if (!element || element === document.body || element === document.documentElement || skip(element)) return;
      event.preventDefault();
      event.stopPropagation();
      remember([element]);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    const onScroll = () => {
      if (chosen.current.length > 0) setSelection(pack(chosen.current));
    };
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("click", block, true);
    document.addEventListener("contextmenu", block, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onScroll);
    return () => {
      document.body.classList.remove("is-selecting");
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("click", block, true);
      document.removeEventListener("contextmenu", block, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <>
      {marquee ? <div className="select-marquee" style={boxStyle(marquee)} /> : null}
      {selection
        ? selection.rects.map((rect, index) => <div key={index} className="select-box" style={boxStyle(rect)} />)
        : hover
          ? <div className="select-box" style={boxStyle(hover)} />
          : null}
      {selection ? (
        <div className="select-menu" style={menuStyle(selection.bounds)} role="menu">
          <span>{labelFor(selection.elements)}</span>
          <button type="button" onClick={() => void copyText(selection.elements, onNotice)}>
            Copy
          </button>
          <button type="button" title="Copy the HTML of the selection" onClick={() => void copyHtml(selection.elements, onNotice)}>
            HTML
          </button>
          <button type="button" onClick={() => void copyShot(selection.elements, onNotice)}>
            Screenshot
          </button>
        </div>
      ) : null}
    </>
  );
}

function block(event: Event) {
  const target = event.target;
  if (target instanceof Element && target.closest(".topbar, .select-menu")) return;
  event.preventDefault();
  event.stopPropagation();
}

function boxStyle(rect: DOMRect): CSSProperties {
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

function menuStyle(rect: DOMRect): CSSProperties {
  const below = rect.bottom + 8;
  const top = below + 36 < window.innerHeight ? below : Math.max(8, rect.top - 40);
  return { top, left: Math.min(Math.max(8, rect.left), window.innerWidth - 280) };
}

function rectFromPoints(x1: number, y1: number, x2: number, y2: number): DOMRect {
  return new DOMRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
}

function pack(elements: HTMLElement[]): Selection {
  const rects = elements.map((element) => element.getBoundingClientRect());
  return { elements, rects, bounds: unionRects(rects) };
}

function unionRects(rects: DOMRect[]): DOMRect {
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

function elementsIn(marquee: DOMRect): HTMLElement[] {
  const hits: HTMLElement[] = [];
  for (const node of document.body.querySelectorAll("*")) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.closest(".select-box, .select-marquee, .select-menu, .topbar")) continue;
    if (node.namespaceURI === "http://www.w3.org/2000/svg" && node.tagName.toLowerCase() !== "svg") continue;
    const rect = node.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    if (!covered(rect, marquee) && !centerInside(rect, marquee)) continue;
    hits.push(node);
  }
  const deepest = hits.filter((element) => !hits.some((other) => other !== element && element.contains(other)));
  const promoted = deepest.map((element) => promote(element, marquee));
  const unique = promoted.filter((element, index) => promoted.indexOf(element) === index);
  unique.sort((left, right) => {
    const pos = left.compareDocumentPosition(right);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
  return collapseOverlaps(unique);
}

function promote(element: HTMLElement, marquee: DOMRect): HTMLElement {
  const item = element.closest(ITEM);
  if (!(item instanceof HTMLElement) || item === element) return element;
  if (item.closest(".topbar, .select-menu")) return element;
  const rect = item.getBoundingClientRect();
  if (covered(rect, marquee) || centerInside(rect, marquee)) return item;
  return element;
}

function collapseOverlaps(elements: HTMLElement[]): HTMLElement[] {
  const kept: HTMLElement[] = [];
  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    const index = kept.findIndex((other) => overlapRatio(rect, other.getBoundingClientRect()) > 0.85);
    if (index < 0) {
      kept.push(element);
      continue;
    }
    const previous = (kept[index].innerText || "").trim().length;
    const next = (element.innerText || "").trim().length;
    if (next > previous) kept[index] = element;
  }
  return kept;
}

function covered(rect: DOMRect, marquee: DOMRect): boolean {
  const area = rect.width * rect.height;
  if (area <= 0) return false;
  const width = Math.max(0, Math.min(rect.right, marquee.right) - Math.max(rect.left, marquee.left));
  const height = Math.max(0, Math.min(rect.bottom, marquee.bottom) - Math.max(rect.top, marquee.top));
  return (width * height) / area >= 0.55;
}

function centerInside(rect: DOMRect, marquee: DOMRect): boolean {
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  return x >= marquee.left && x <= marquee.right && y >= marquee.top && y <= marquee.bottom;
}

function overlapRatio(left: DOMRect, right: DOMRect): number {
  const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  const height = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  const small = Math.min(left.width * left.height, right.width * right.height);
  if (small <= 0) return 0;
  return (width * height) / small;
}

function labelFor(elements: HTMLElement[]): string {
  if (elements.length === 1) return `${panelName(elements[0])} ${elements[0].tagName.toLowerCase()}`;
  return `${elements.length} items`;
}

function panelName(element: HTMLElement): string {
  const panel = element.closest("[data-panel-id]");
  const title = panel?.querySelector(".panel-title strong")?.textContent?.trim();
  if (title) return title;
  const side = panel?.querySelector(".side-heading")?.textContent?.trim().split("\n")[0];
  if (side) return side;
  return panel?.getAttribute("data-panel-id") || "Page";
}

function contents(elements: HTMLElement[]): string {
  if (elements.length === 1) return cleanText(elements[0].innerText || elements[0].getAttribute("aria-label") || "");
  const pieces = elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      text: (element.innerText || "").replace(/\u00a0/g, " "),
      top: rect.top,
      left: rect.left,
      right: rect.right,
      height: Math.max(rect.height, 1),
    };
  });
  pieces.sort((left, right) => left.top - right.top || left.left - right.left);
  const lines: { top: number; height: number; parts: { left: number; right: number; text: string }[] }[] = [];
  for (const piece of pieces) {
    if (!piece.text.trim()) continue;
    const block = piece.text.includes("\n");
    const line = block
      ? undefined
      : lines.find((item) => Math.abs(item.top - piece.top) < Math.max(6, Math.min(item.height, piece.height) * 0.6));
    if (line) line.parts.push(piece);
    else lines.push({ top: piece.top, height: piece.height, parts: [piece] });
  }
  return cleanText(
    lines
      .map((line) => {
        const parts = [...line.parts].sort((left, right) => left.left - right.left);
        let text = "";
        let edge = Number.NEGATIVE_INFINITY;
        for (const part of parts) {
          if (text && part.left - edge > 3 && !text.endsWith(" ") && !part.text.startsWith(" ")) text += " ";
          text += part.text.includes("\n") ? part.text : part.text.replace(/\n/g, "");
          edge = part.right;
        }
        return text;
      })
      .join("\n"),
  );
}

function cleanText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function copyText(elements: HTMLElement[], onNotice: (message: string) => void) {
  try {
    const text = contents(elements);
    if (!text) {
      onNotice("Nothing to copy");
      return;
    }
    await navigator.clipboard.writeText(text);
    onNotice("Copied");
  } catch (err) {
    onNotice(clipboardMessage(err, "Could not copy"));
  }
}

async function copyHtml(elements: HTMLElement[], onNotice: (message: string) => void) {
  try {
    await navigator.clipboard.writeText(elements.map((element) => element.outerHTML).join("\n"));
    onNotice(elements.length === 1 ? "Copied HTML" : `Copied HTML for ${elements.length} elements`);
  } catch (err) {
    onNotice(clipboardMessage(err, "Could not copy"));
  }
}

async function copyShot(elements: HTMLElement[], onNotice: (message: string) => void) {
  try {
    const blob = elements.length === 1 ? await rasterize(elements[0]) : await rasterizeRegion(elements);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    onNotice("Screenshot copied");
  } catch (err) {
    onNotice(clipboardMessage(err, "Could not copy the screenshot"));
  }
}

function clipboardMessage(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : fallback;
  if (/not focused|not allowed|denied/i.test(message)) return "Could not copy. Click the page and try again.";
  return message || fallback;
}

async function rasterize(element: HTMLElement): Promise<Blob> {
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) throw new Error("That element has no visible area");
  document.body.classList.add("is-capturing");
  try {
    const { default: html2canvas } = await import("html2canvas");
    const canvas = await html2canvas(element, {
      backgroundColor: backgroundOf(element),
      scale: window.devicePixelRatio || 1,
      logging: false,
      useCORS: true,
    });
    paintCanvases(canvas, element, rect);
    return await blobFrom(canvas);
  } finally {
    document.body.classList.remove("is-capturing");
  }
}

async function rasterizeRegion(elements: HTMLElement[]): Promise<Blob> {
  const bounds = clampToViewport(unionRects(elements.map((element) => element.getBoundingClientRect())));
  if (bounds.width < 1 || bounds.height < 1) throw new Error("That selection has no visible area");
  const root = commonAncestor(elements);
  const origin = root.getBoundingClientRect();
  document.body.classList.add("is-capturing");
  try {
    const { default: html2canvas } = await import("html2canvas");
    const full = await html2canvas(root, {
      backgroundColor: backgroundOf(root),
      scale: window.devicePixelRatio || 1,
      logging: false,
      useCORS: true,
    });
    const scale = full.width / Math.max(origin.width, 1);
    const cropped = document.createElement("canvas");
    cropped.width = Math.max(1, Math.round(bounds.width * scale));
    cropped.height = Math.max(1, Math.round(bounds.height * scale));
    const ctx = cropped.getContext("2d");
    if (!ctx) throw new Error("Could not copy the screenshot");
    ctx.drawImage(
      full,
      (bounds.left - origin.left) * scale,
      (bounds.top - origin.top) * scale,
      cropped.width,
      cropped.height,
      0,
      0,
      cropped.width,
      cropped.height,
    );
    paintCanvases(cropped, root, bounds);
    return await blobFrom(cropped);
  } finally {
    document.body.classList.remove("is-capturing");
  }
}

function commonAncestor(elements: HTMLElement[]): HTMLElement {
  let node: HTMLElement | null = elements[0];
  while (node) {
    if (elements.every((element) => node?.contains(element))) return node;
    node = node.parentElement;
  }
  const app = document.querySelector(".app");
  return app instanceof HTMLElement ? app : document.body;
}

function clampToViewport(rect: DOMRect): DOMRect {
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(window.innerWidth, rect.right);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}

function blobFrom(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not copy the screenshot"))), "image/png");
  });
}

function paintCanvases(canvas: HTMLCanvasElement, element: HTMLElement, origin: DOMRect) {
  const nodes = element instanceof HTMLCanvasElement ? [element] : [...element.querySelectorAll("canvas")];
  if (nodes.length === 0) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const scale = canvas.width / Math.max(origin.width, 1);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, canvas.width, canvas.height);
  ctx.clip();
  for (const node of nodes) {
    const box = node.getBoundingClientRect();
    try {
      ctx.drawImage(
        node,
        (box.left - origin.left) * scale,
        (box.top - origin.top) * scale,
        box.width * scale,
        box.height * scale,
      );
    } catch {
      // A canvas from another origin cannot be copied.
    }
  }
  ctx.restore();
}

function backgroundOf(element: HTMLElement): string {
  let current: HTMLElement | null = element;
  while (current) {
    const color = getComputedStyle(current).backgroundColor;
    if (color && color !== "rgba(0, 0, 0, 0)" && color !== "transparent") return color;
    current = current.parentElement;
  }
  return "#12151a";
}
