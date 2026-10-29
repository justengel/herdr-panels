import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { desktopHost } from "../desktopBrowser";
import { intersects, shiftRect, toFrame, type LocalRect } from "../frameSelect";
import {
  downloadPng,
  keepScreenshot,
  screenshotFileName,
  screenshotOffer,
  writeClipboardPng,
} from "../screenshotOffer";

interface Props {
  onNotice: (message: string) => void;
  onClose: () => void;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

interface Piece {
  live: Element | null;
  frame: HTMLIFrameElement | null;
  tag: string;
  text: string;
  html: string;
  css: string;
  rect: Box;
  title: string;
}

interface Selection {
  pieces: Piece[];
  rects: Box[];
  bounds: Box;
  css: string;
}

interface FrameRecord {
  tag: string;
  text: string;
  html: string;
  rect: LocalRect;
}

interface FrameMessage {
  source?: string;
  type?: string;
  requestId?: string;
  dragged?: boolean;
  css?: string;
  phase?: string;
  x?: number;
  y?: number;
  rect?: LocalRect | null;
  elements?: FrameRecord[];
  element?: FrameRecord | null;
}

const ITEM =
  "button, a, input, textarea, select, label, li, h1, h2, h3, h4, h5, h6, p, pre, blockquote, .tree-row, .agent-row, .space-row, .panel-title, [role='tab']";

const SELECT_CHROME = ".topbar, .select-menu, .dialog, .dialog-backdrop";

interface ShotOffer {
  blob: Blob;
  copied: boolean;
  name: string;
}

export function ElementSelect({ onNotice, onClose }: Props) {
  const [hover, setHover] = useState<Box | null>(null);
  const [marquee, setMarquee] = useState<Box | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [shot, setShot] = useState<ShotOffer | null>(null);
  const [saving, setSaving] = useState(false);
  const closeRef = useRef(onClose);
  const noticeRef = useRef(onNotice);
  const shotRef = useRef<ShotOffer | null>(null);
  const shotTicket = useRef<object | null>(null);
  const alive = useRef(true);
  shotRef.current = shot;
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const chosen = useRef<Piece[]>([]);
  closeRef.current = onClose;
  noticeRef.current = onNotice;

  useEffect(() => {
    alive.current = true;
    document.body.classList.add("is-selecting");
    let stamp = 0;
    const skip = (target: EventTarget | null) =>
      target instanceof Element && Boolean(target.closest(SELECT_CHROME));
    const remember = (pieces: Piece[]) => {
      chosen.current = pieces;
      setSelection(pieces.length > 0 ? pack(pieces) : null);
    };
    const finishDrag = (x: number, y: number) => {
      const start = drag.current;
      if (!start) return;
      drag.current = null;
      setMarquee(null);
      const id = ++stamp;
      const box = rectFromPoints(start.x, start.y, x, y);
      const local = elementsIn(box).map(pieceFromElement);
      void frameHits(box).then((extra) => {
        if (id !== stamp) return;
        const pieces = [...local, ...extra];
        remember(pieces);
        if (pieces.length === 0) noticeRef.current("Nothing in that box");
      });
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
      const frame = bridgedFrame(event.target);
      if (drag.current) return;
      if (frame) {
        scheduleHover(frame, event.clientX, event.clientY);
        return;
      }
      if (skip(event.target)) {
        setHover(null);
        return;
      }
      const element = clickTarget(event.target);
      setHover(element ? boxOf(element.getBoundingClientRect()) : null);
    };
    let hoverTicket = 0;
    const scheduleHover = (frame: HTMLIFrameElement, x: number, y: number) => {
      const ticket = ++hoverTicket;
      const origin = frame.getBoundingClientRect();
      void pointHit(frame, x - origin.left, y - origin.top).then((piece) => {
        if (ticket !== hoverTicket || drag.current) return;
        setHover(piece ? piece.rect : null);
      });
    };
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 || skip(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      stamp += 1;
      drag.current = { x: event.clientX, y: event.clientY, moved: false };
      setHover(null);
      remember([]);
    };
    const onUp = (event: PointerEvent) => {
      const start = drag.current;
      if (!start) return;
      const frame = bridgedFrame(event.target);
      if (frame && !start.moved) {
        drag.current = null;
        const id = ++stamp;
        const origin = frame.getBoundingClientRect();
        void pointHit(frame, event.clientX - origin.left, event.clientY - origin.top).then((piece) => {
          if (id !== stamp) return;
          if (piece) remember([piece]);
        });
        return;
      }
      if (start.moved) {
        event.preventDefault();
        event.stopPropagation();
        finishDrag(event.clientX, event.clientY);
        return;
      }
      drag.current = null;
      setMarquee(null);
      const element = clickTarget(event.target);
      if (!element) return;
      event.preventDefault();
      event.stopPropagation();
      remember([pieceFromElement(element)]);
    };
    const onFrame = (event: MessageEvent) => {
      const data = event.data as FrameMessage;
      if (!data || data.source !== "hwp-panel" || !data.type?.startsWith("select")) return;
      const frame = frameFor(event.source);
      if (!frame) return;
      const origin = frame.getBoundingClientRect();
      if (data.type === "select-ready") {
        frame.dataset.selectBridge = "1";
        return;
      }
      if (data.type === "select-hover") {
        if (drag.current) return;
        setHover(data.rect ? shiftRect(origin, data.rect) : null);
        return;
      }
      if (data.type === "select-marquee") {
        setHover(null);
        setMarquee(data.rect ? shiftRect(origin, data.rect) : null);
        return;
      }
      if (data.type === "select-clear") {
        stamp += 1;
        remember([]);
        setHover(null);
        setMarquee(null);
        return;
      }
      if (data.type === "select-result") {
        stamp += 1;
        setMarquee(null);
        const pieces = (data.elements ?? []).map((item) => pieceFromFrame(frame, item, data.css ?? ""));
        remember(pieces);
        if (pieces.length === 0 && data.dragged) noticeRef.current("Nothing in that box");
        return;
      }
      if (data.type === "select-scroll") {
        const elements = data.elements ?? [];
        setSelection((current) => {
          if (!current) return current;
          const mine = current.pieces.filter((piece) => piece.frame === frame);
          if (mine.length !== elements.length) return current;
          let index = 0;
          const pieces = current.pieces.map((piece) => {
            if (piece.frame !== frame) return piece;
            const next = elements[index];
            index += 1;
            return { ...piece, text: next.text, rect: shiftRect(origin, next.rect) };
          });
          chosen.current = pieces;
          const rects = pieces.map((piece) => piece.rect);
          return { pieces, rects, bounds: unionRects(rects), css: current.css };
        });
        return;
      }
      if (data.type === "select-pointer" && drag.current) {
        const x = origin.left + (data.x ?? 0);
        const y = origin.top + (data.y ?? 0);
        if (data.phase === "up") finishDrag(x, y);
        else if (data.phase === "move") {
          const gesture = drag.current;
          if (!gesture) return;
          const dx = x - gesture.x;
          const dy = y - gesture.y;
          if (!gesture.moved && Math.hypot(dx, dy) < 4) return;
          gesture.moved = true;
          setHover(null);
          setMarquee(rectFromPoints(gesture.x, gesture.y, x, y));
        }
      }
    };
    const tell = (frame: HTMLIFrameElement, enabled: boolean) => {
      frame.contentWindow?.postMessage({ source: "hwp-host", type: "select", enabled }, "*");
    };
    const onLoad = (event: Event) => {
      if (event.target instanceof HTMLIFrameElement) tell(event.target, true);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !shotRef.current) closeRef.current();
    };
    const onScroll = () => {
      if (chosen.current.length > 0) setSelection(pack(chosen.current));
    };
    document.querySelectorAll("iframe").forEach((node) => {
      if (node instanceof HTMLIFrameElement) tell(node, true);
    });
    document.addEventListener("load", onLoad, true);
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("click", block, true);
    document.addEventListener("contextmenu", block, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("message", onFrame);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onScroll);
    const desktop = desktopHost();
    if (desktop) void desktop.invoke("set_browser_select", { enabled: true }).catch(() => undefined);
    return () => {
      document.body.classList.remove("is-selecting");
      document.querySelectorAll("iframe").forEach((node) => {
        if (node instanceof HTMLIFrameElement) {
          tell(node, false);
          delete node.dataset.selectBridge;
        }
      });
      document.removeEventListener("load", onLoad, true);
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("click", block, true);
      document.removeEventListener("contextmenu", block, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("message", onFrame);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onScroll);
      if (desktop) void desktop.invoke("set_browser_select", { enabled: false }).catch(() => undefined);
      alive.current = false;
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
          <span>{labelFor(selection.pieces)}</span>
          <button type="button" onClick={() => void copyText(selection.pieces, onNotice)}>
            Copy
          </button>
          <button type="button" title="Copy the HTML of the selection" onClick={() => void copyHtml(selection.pieces, onNotice)}>
            HTML
          </button>
          <button
            type="button"
            onClick={() => {
              const ticket = {};
              shotTicket.current = ticket;
              const pending = captureShot(selection);
              const copied = writeClipboardPng(pending);
              const name = screenshotFileName();
              void pending.then(
                async (blob) => {
                  const ok = await Promise.race([
                    copied,
                    new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), 700)),
                  ]);
                  if (!alive.current || shotTicket.current !== ticket) return;
                  setSaving(false);
                  setShot({ blob, copied: ok, name });
                  if (ok) return;
                  const later = await copied;
                  if (!alive.current || shotTicket.current !== ticket || !later) return;
                  setShot((current) => (current && current.blob === blob ? { ...current, copied: true } : current));
                },
                (err) => {
                  if (!alive.current || shotTicket.current !== ticket) return;
                  onNotice(clipboardMessage(err, "Could not take the screenshot"));
                },
              );
            }}
          >
            Screenshot
          </button>
        </div>
      ) : null}
      {shot
        ? createPortal(
            <ScreenshotDialog
              copied={shot.copied}
              saving={saving}
              onDismiss={() => {
                if (saving) return;
                shotTicket.current = null;
                setShot(null);
              }}
              onSave={() => {
                if (saving) return;
                const current = shot;
                setSaving(true);
                void keepScreenshot(
                  current.blob,
                  current.name,
                  (blob, name) => api.savePng(blob, name),
                  (name) => downloadPng(current.blob, name),
                ).then(
                  (result) => {
                    if (!alive.current) return;
                    setSaving(false);
                    if (result.kind === "cancelled") return;
                    setShot(null);
                    onNotice(result.kind === "saved" ? `Saved ${result.path}` : "Download started");
                  },
                  () => {
                    if (!alive.current) return;
                    setSaving(false);
                    onNotice("Could not save the screenshot");
                  },
                );
              }}
            />,
            document.body,
          )
        : null}
    </>
  );
}

function ScreenshotDialog({
  copied,
  saving,
  onDismiss,
  onSave,
}: {
  copied: boolean;
  saving: boolean;
  onDismiss: () => void;
  onSave: () => void;
}) {
  const dismissRef = useRef<HTMLButtonElement>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    dismissRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      dismiss.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const offer = screenshotOffer(copied, "file-dialog");
  return (
    <div className="dialog-backdrop screenshot-dialog-backdrop" role="presentation" onMouseDown={onDismiss}>
      <div
        className="dialog screenshot-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={offer.heading}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2>{offer.heading}</h2>
        <p>{offer.body}</p>
        <div className="dialog-actions">
          <button type="button" disabled={saving} onClick={onSave}>
            {saving ? "Saving…" : "Save…"}
          </button>
          <span className="dialog-spacer" />
          <button type="button" ref={dismissRef} disabled={saving} onClick={onDismiss}>
            Don't save
          </button>
        </div>
      </div>
    </div>
  );
}

function block(event: Event) {
  const target = event.target;
  if (target instanceof Element && target.closest(SELECT_CHROME)) return;
  if (bridgedFrame(target)) return;
  event.preventDefault();
  event.stopPropagation();
}

function clickTarget(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  if (target.closest(SELECT_CHROME)) return null;
  if (target === document.body || target === document.documentElement) return null;
  if (target instanceof HTMLElement || target instanceof SVGElement) return target;
  return null;
}

function bridgedFrame(target: EventTarget | null): HTMLIFrameElement | null {
  if (!(target instanceof HTMLIFrameElement) || target.dataset.selectBridge !== "1") return null;
  return target;
}

function frameFor(source: MessageEventSource | null): HTMLIFrameElement | null {
  if (!source) return null;
  for (const node of document.querySelectorAll("iframe")) {
    if (node instanceof HTMLIFrameElement && node.contentWindow === source) return node;
  }
  return null;
}

function pieceFromElement(element: Element): Piece {
  return {
    live: element,
    frame: null,
    tag: element.tagName.toLowerCase(),
    text: textOf(element),
    html: element.outerHTML,
    css: "",
    rect: boxOf(element.getBoundingClientRect()),
    title: panelName(element),
  };
}

function pieceFromFrame(frame: HTMLIFrameElement, item: FrameRecord, css: string): Piece {
  return {
    live: null,
    frame,
    tag: item.tag,
    text: item.text,
    html: item.html,
    css,
    rect: shiftRect(frame.getBoundingClientRect(), item.rect),
    title: panelName(frame),
  };
}

let querySeq = 0;

function frameHits(box: Box): Promise<Piece[]> {
  const frames = [...document.querySelectorAll("iframe")].filter(
    (node): node is HTMLIFrameElement =>
      node instanceof HTMLIFrameElement &&
      node.dataset.selectBridge === "1" &&
      intersects(node.getBoundingClientRect(), box),
  );
  return Promise.all(frames.map((frame) => queryFrame(frame, box))).then((groups) => groups.flat());
}

function pointHit(frame: HTMLIFrameElement, x: number, y: number): Promise<Piece | null> {
  const requestId = `p${(querySeq += 1)}`;
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve(null);
    }, 400);
    const onMessage = (event: MessageEvent) => {
      const data = event.data as FrameMessage;
      if (!data || data.source !== "hwp-panel" || data.type !== "select-at-result" || data.requestId !== requestId) return;
      if (event.source !== frame.contentWindow) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(data.element ? pieceFromFrame(frame, data.element, data.css ?? "") : null);
    };
    window.addEventListener("message", onMessage);
    frame.contentWindow?.postMessage({ source: "hwp-host", type: "select-at", requestId, x, y }, "*");
  });
}

function queryFrame(frame: HTMLIFrameElement, box: Box): Promise<Piece[]> {
  const requestId = `s${(querySeq += 1)}`;
  const local = toFrame(frame.getBoundingClientRect(), box);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve([]);
    }, 400);
    const onMessage = (event: MessageEvent) => {
      const data = event.data as FrameMessage;
      if (!data || data.source !== "hwp-panel" || data.type !== "select-hits" || data.requestId !== requestId) return;
      if (event.source !== frame.contentWindow) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve((data.elements ?? []).map((item) => pieceFromFrame(frame, item, data.css ?? "")));
    };
    window.addEventListener("message", onMessage);
    frame.contentWindow?.postMessage({ source: "hwp-host", type: "select-query", requestId, rect: local }, "*");
  });
}

function textOf(element: Element): string {
  const visible = element instanceof HTMLElement ? element.innerText : "";
  return (visible || element.textContent || element.getAttribute("aria-label") || "").replace(/\u00a0/g, " ").trim();
}

function boxStyle(rect: Box): CSSProperties {
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

function menuStyle(rect: Box): CSSProperties {
  const below = rect.bottom + 8;
  const top = below + 36 < window.innerHeight ? below : Math.max(8, rect.top - 40);
  return { top, left: Math.min(Math.max(8, rect.left), window.innerWidth - 280) };
}

function rectFromPoints(x1: number, y1: number, x2: number, y2: number): Box {
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function boxOf(rect: Box): Box {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
}

function pack(pieces: Piece[]): Selection {
  const next = pieces.map((piece) => (piece.live ? { ...piece, rect: boxOf(piece.live.getBoundingClientRect()) } : piece));
  const rects = next.map((piece) => piece.rect);
  return { pieces: next, rects, bounds: unionRects(rects), css: pieces.find((piece) => piece.css)?.css ?? "" };
}

function unionRects(rects: Box[]): Box {
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return { left, top, width: right - left, height: bottom - top, right, bottom };
}

function elementsIn(marquee: Box): Element[] {
  const hits: Element[] = [];
  for (const node of document.body.querySelectorAll("*")) {
    if (!(node instanceof Element)) continue;
    if (node.closest(".select-box, .select-marquee, .select-menu, .topbar")) continue;
    if (node instanceof HTMLIFrameElement && node.dataset.selectBridge === "1") continue;
    const svg = node.namespaceURI === "http://www.w3.org/2000/svg";
    if (svg && node.tagName.toLowerCase() !== "svg") continue;
    if (!(node instanceof HTMLElement) && !svg) continue;
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

function promote(element: Element, marquee: Box): Element {
  const item = element.closest(ITEM);
  if (!(item instanceof Element) || item === element) return element;
  if (item.closest(".topbar, .select-menu")) return element;
  const rect = item.getBoundingClientRect();
  if (covered(rect, marquee) || centerInside(rect, marquee)) return item;
  return element;
}

function collapseOverlaps(elements: Element[]): Element[] {
  const kept: Element[] = [];
  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    const index = kept.findIndex((other) => overlapRatio(rect, other.getBoundingClientRect()) > 0.85);
    if (index < 0) {
      kept.push(element);
      continue;
    }
    const previous = textOf(kept[index]).length;
    const next = textOf(element).length;
    if (next > previous) kept[index] = element;
  }
  return kept;
}

function covered(rect: Box, marquee: Box): boolean {
  const area = rect.width * rect.height;
  if (area <= 0) return false;
  const width = Math.max(0, Math.min(rect.right, marquee.right) - Math.max(rect.left, marquee.left));
  const height = Math.max(0, Math.min(rect.bottom, marquee.bottom) - Math.max(rect.top, marquee.top));
  return (width * height) / area >= 0.55;
}

function centerInside(rect: Box, marquee: Box): boolean {
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  return x >= marquee.left && x <= marquee.right && y >= marquee.top && y <= marquee.bottom;
}

function overlapRatio(left: Box, right: Box): number {
  const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  const height = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  const small = Math.min(left.width * left.height, right.width * right.height);
  if (small <= 0) return 0;
  return (width * height) / small;
}

function labelFor(pieces: Piece[]): string {
  if (pieces.length === 1) return `${pieces[0].title} ${pieces[0].tag}`;
  return `${pieces.length} items`;
}

function panelName(element: Element): string {
  const panel = element.closest("[data-panel-id]");
  const title = panel?.querySelector(".panel-title strong")?.textContent?.trim();
  if (title) return title;
  const side = panel?.querySelector(".side-heading")?.textContent?.trim().split("\n")[0];
  if (side) return side;
  return panel?.getAttribute("data-panel-id") || "Page";
}

function contents(pieces: Piece[]): string {
  if (pieces.length === 1) {
    const only = pieces[0];
    return cleanText(only.live ? textOf(only.live) : only.text);
  }
  const rows = pieces.map((piece) => {
    const rect = piece.live ? piece.live.getBoundingClientRect() : piece.rect;
    return {
      text: (piece.live ? textOf(piece.live) : piece.text).replace(/\u00a0/g, " "),
      top: rect.top,
      left: rect.left,
      right: rect.right,
      height: Math.max(rect.height, 1),
    };
  });
  rows.sort((left, right) => left.top - right.top || left.left - right.left);
  const lines: { top: number; height: number; parts: { left: number; right: number; text: string }[] }[] = [];
  for (const piece of rows) {
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

async function copyText(pieces: Piece[], onNotice: (message: string) => void) {
  try {
    const text = contents(pieces);
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

async function copyHtml(pieces: Piece[], onNotice: (message: string) => void) {
  try {
    await navigator.clipboard.writeText(pieces.map((piece) => piece.live?.outerHTML || piece.html).join("\n"));
    onNotice(pieces.length === 1 ? "Copied HTML" : `Copied HTML for ${pieces.length} elements`);
  } catch (err) {
    onNotice(clipboardMessage(err, "Could not copy"));
  }
}

function captureShot(selection: Selection): Promise<Blob> {
  const live = selection.pieces.every((piece) => piece.live instanceof HTMLElement);
  if (!live) return shotMarkup(selection.pieces, selection.css);
  if (selection.pieces.length === 1) return rasterize(selection.pieces[0].live as HTMLElement);
  return rasterizeRegion(selection.pieces.map((piece) => piece.live as HTMLElement));
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
    if (!ctx) throw new Error("Could not take the screenshot");
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

function clampToViewport(rect: Box): Box {
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(window.innerWidth, rect.right);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  return { left, top, width, height, right: left + width, bottom: top + height };
}

async function shotMarkup(pieces: Piece[], css: string): Promise<Blob> {
  const bounds = unionRects(pieces.map((piece) => piece.rect));
  if (bounds.width < 1 || bounds.height < 1) throw new Error("That selection has no visible area");
  const safeCss = css.replace(/<\/style/gi, "<\\/style");
  const body = pieces
    .map((piece) => {
      const html = piece.html.replace(/<script[\s\S]*?<\/script>/gi, "");
      const left = piece.rect.left - bounds.left;
      const top = piece.rect.top - bounds.top;
      return `<div style="position:absolute;left:${left}px;top:${top}px;width:${piece.rect.width}px">${html}</div>`;
    })
    .join("");
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>${safeCss}</style></head><body style="margin:0;background:#14181f"><div style="position:relative;width:${bounds.width}px;height:${bounds.height}px;overflow:hidden">${body}</div></body></html>`;
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${Math.ceil(bounds.width)}px;height:${Math.ceil(bounds.height)}px;border:0;`;
  const loaded = new Promise<void>((resolve, reject) => {
    frame.addEventListener("load", () => resolve(), { once: true });
    frame.addEventListener("error", () => reject(new Error("Could not take the screenshot")), { once: true });
  });
  frame.srcdoc = doc;
  document.body.appendChild(frame);
  try {
    await loaded;
    const root = frame.contentDocument?.body;
    if (!(root instanceof HTMLElement)) throw new Error("Could not take the screenshot");
    const { default: html2canvas } = await import("html2canvas");
    const canvas = await html2canvas(root, {
      backgroundColor: "#14181f",
      scale: window.devicePixelRatio || 1,
      logging: false,
      useCORS: true,
      width: bounds.width,
      height: bounds.height,
    });
    return await blobFrom(canvas);
  } finally {
    frame.remove();
  }
}

function blobFrom(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not take the screenshot"))), "image/png");
  });
}

function paintCanvases(canvas: HTMLCanvasElement, element: HTMLElement, origin: Box) {
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
