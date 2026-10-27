import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { api, wsUrl } from "../../api";
import { useHost } from "../../host";
import {
  applyScroll,
  pageScroll,
  previewScroll,
  type ScrollPlace,
  screenMoved,
  scrollFromThumb,
  scrollMetrics,
  viewBox,
  wheelScroll,
} from "../../terminalView";

interface Props {
  paneId: string | null;
  source?: "visible" | "recent" | null;
  lines?: number | null;
  onGone?: () => void;
}

interface ScreenMessage {
  type: "frame";
  text?: string;
  cols?: number | null;
  rows?: number | null;
  full?: boolean;
}

interface ErrorMessage {
  type: "error";
  message?: string | null;
}

export function HerdrTerminal({ paneId, source, lines, onGone }: Props) {
  const host = useHost();
  const shellRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const bufferRef = useRef("");
  const flushTimer = useRef(0);
  const placeRef = useRef<ScrollPlace>({ fromEnd: 0, extent: 0 });
  const rowsRef = useRef(1);
  const dragRef = useRef<{ y: number; top: number } | null>(null);
  const pendingRef = useRef<{ direction: "up" | "down"; lines: number; place: ScrollPlace } | null>(null);
  const pendingTimer = useRef(0);
  const [place, setPlace] = useState<ScrollPlace>({ fromEnd: 0, extent: 0 });
  const [gridRows, setGridRows] = useState(1);
  const [trackPx, setTrackPx] = useState(0);
  const seenRef = useRef(false);
  const goneRef = useRef(false);
  const goneHandler = useRef(onGone);
  goneHandler.current = onGone;
  const [status, setStatus] = useState("Connecting");

  useEffect(() => {
    placeRef.current = { fromEnd: 0, extent: 0 };
    pendingRef.current = null;
    window.clearTimeout(pendingTimer.current);
    setPlace({ fromEnd: 0, extent: 0 });
    const shell = shellRef.current;
    const stage = stageRef.current;
    seenRef.current = false;
    goneRef.current = false;
    if (!shell || !stage || !paneId) {
      setStatus(paneId ? "Connecting" : "Choose a pane");
      return;
    }

    const term = new Terminal({
      convertEol: true,
      disableStdin: true,
      cursorBlink: true,
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, ui-monospace, monospace',
      fontSize: 14,
      lineHeight: 1.15,
      scrollback: 400,
      theme: {
        background: "#101318",
        foreground: "#e7e2d6",
        cursor: "#e2b657",
        cursorAccent: "#101318",
        selectionBackground: "#3d4f38",
      },
    });
    term.open(stage);
    paintTheme(term);
    termRef.current = term;
    const onTheme = () => {
      if (termRef.current) paintTheme(termRef.current);
    };
    window.addEventListener("herdr-theme", onTheme);

    let sizeTimer = 0;
    let wanted: { cols: number; rows: number } | null = null;
    let sent: { cols: number; rows: number } | null = null;
    const sizeProblem = { current: false };

    const flushSize = () => {
      const next = wanted;
      const socket = socketRef.current;
      if (!next || !socket || socket.readyState !== WebSocket.OPEN) return;
      if (sent && sent.cols === next.cols && sent.rows === next.rows) return;
      sent = next;
      socket.send(JSON.stringify({ type: "resize", cols: next.cols, rows: next.rows }));
    };

    const applySize = () => {
      const current = termRef.current;
      const host = shellRef.current;
      if (!current || !host) return;
      const cell = readCell(current);
      const next = fitCells(host.clientWidth - 14, host.clientHeight, cell.w, cell.h);
      if (!next) return;
      const shown = viewBox(next, 0, 0) ?? next;
      const sameGrid = current.cols === shown.cols && current.rows === shown.rows;
      const sameRequest = wanted !== null && wanted.cols === shown.cols && wanted.rows === shown.rows;
      if (!sameGrid) current.resize(shown.cols, shown.rows);
      wanted = shown;
      rowsRef.current = shown.rows;
      setGridRows((rows) => (rows === shown.rows ? rows : shown.rows));
      setTrackPx((px) => (px === host.clientHeight ? px : host.clientHeight));
      if (sameRequest) return;
      window.clearTimeout(sizeTimer);
      sizeTimer = window.setTimeout(flushSize, 80);
    };

    const onZoom = () => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => applySize()));
    };
    window.addEventListener("herdr-zoom", onZoom);

    const observer = new ResizeObserver(() => applySize());
    observer.observe(shell);
    void document.fonts?.ready.then(() => {
      if (termRef.current) applySize();
    });
    applySize();

    let stopped = false;
    let gotFrame = false;
    let retry = 0;
    let seedTimer = 0;
    let socket: WebSocket | null = null;
    const params = new URLSearchParams({ paneId });
    if (source) params.set("source", source);
    if (lines) params.set("lines", String(lines));

    let drawn = "";
    let shown: string | null = null;
    let paint = 0;
    let painting = false;
    const readScreen = () => {
      const buffer = term.buffer.active;
      const rows: string[] = [];
      for (let row = 0; row < term.rows; row += 1) {
        const line = buffer.getLine(buffer.baseY + row);
        rows.push(line ? line.translateToString(true) : "");
      }
      return rows.join("\n");
    };
    const connect = () => {
      if (stopped) return;
      setStatus("Connecting");
      socket = new WebSocket(wsUrl(`/ws/terminal?${params.toString()}`));
      socketRef.current = socket;
      socket.onopen = () => {
        sent = null;
        setStatus("");
        flushSize();
        window.clearTimeout(seedTimer);
        seedTimer = window.setTimeout(() => {
          if (stopped || gotFrame) return;
          void api
            .readScreen(paneId)
            .then((screen) => {
              if (stopped || gotFrame || !screen.text) return;
              term.reset();
              term.write(screen.text);
            })
            .catch(() => undefined);
        }, 600);
      };
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as ScreenMessage | ErrorMessage | { type: string };
        if (message.type === "frame") {
          const frame = message as ScreenMessage;
          seenRef.current = true;
          gotFrame = true;
          const text = frame.text ?? "";
          const finish = (token: number) => {
            if (stopped || token !== paint) return;
            painting = false;
            const next = readScreen();
            const previous = shown;
            shown = next;
            if (previous === null) return;
            settleScroll(screenMoved(previous, next));
          };
          if (text !== drawn) {
            drawn = text;
            const token = ++paint;
            painting = true;
            if (frame.full) term.reset();
            if (text) term.write(text, () => finish(token));
            else finish(token);
          } else if (!painting) {
            finish(paint);
          }
          if (!sizeProblem.current) setStatus("");
        } else if (message.type === "error") {
          const text = (message as ErrorMessage).message;
          setStatus(text ? text : "");
        } else if (message.type === "sizeError") {
          const text = (message as ErrorMessage).message;
          sizeProblem.current = true;
          setStatus(text ? text : "Could not resize the shell");
        } else if (message.type === "resized") {
          sizeProblem.current = false;
          setStatus("");
        } else if (message.type === "meta") {
          const meta = message as { present?: boolean; connected?: boolean };
          if (meta.present) seenRef.current = true;
          if (meta.present === false && meta.connected && seenRef.current && !goneRef.current) {
            goneRef.current = true;
            goneHandler.current?.();
            return;
          }
          if (meta.present === false) setStatus("Pane is not in this Herdr session");
        }
      };
      socket.onclose = () => {
        if (!stopped) {
          setStatus("Reconnecting");
          retry = window.setTimeout(connect, 1000);
        }
      };
    };
    connect();

    return () => {
      stopped = true;
      window.clearTimeout(retry);
      window.clearTimeout(seedTimer);
      window.clearTimeout(sizeTimer);
      window.removeEventListener("herdr-theme", onTheme);
      window.removeEventListener("herdr-zoom", onZoom);
      window.clearTimeout(flushTimer.current);
      window.clearTimeout(pendingTimer.current);
      observer.disconnect();
      socket?.close();
      socketRef.current = null;
      term.dispose();
      termRef.current = null;
    };
  }, [paneId, source, lines]);

  function send(payload: unknown) {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }

  function flushText() {
    const text = bufferRef.current;
    bufferRef.current = "";
    if (text) send({ type: "text", text });
  }

  function queueText(text: string) {
    bufferRef.current += text;
    window.clearTimeout(flushTimer.current);
    flushTimer.current = window.setTimeout(flushText, 16);
  }

  function commitPlace(next: ScrollPlace) {
    placeRef.current = next;
    setPlace(next);
  }

  function settleScroll(moved: boolean) {
    const pending = pendingRef.current;
    if (!pending) return;
    const atTop = pending.direction === "up" && pending.place.fromEnd >= pending.place.extent && pending.place.extent > 0;
    const atBottom = pending.direction === "down" && pending.place.fromEnd <= 0;
    if (!moved && !atTop && !atBottom) return;
    window.clearTimeout(pendingTimer.current);
    pendingRef.current = null;
    if (moved && pending.direction === "up" && pending.place.extent > 0 && pending.place.fromEnd < pending.place.extent) {
      const next = Math.min(pending.place.extent, pending.place.fromEnd + pending.lines);
      commitPlace({ fromEnd: next, extent: pending.place.extent });
      return;
    }
    commitPlace(applyScroll(pending.place, pending.direction, pending.lines, moved));
  }

  function giveUp() {
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (!pending) return;
    const probingTop = pending.direction === "up" && pending.place.fromEnd >= pending.place.extent;
    const probingBottom = pending.direction === "down" && pending.place.fromEnd <= 0;
    if (probingTop || probingBottom) {
      commitPlace(applyScroll(pending.place, pending.direction, pending.lines, false));
      return;
    }
    commitPlace(pending.place);
  }

  function emitScroll(direction: "up" | "down", lines: number, source: "wheel" | "page_key") {
    let left = Math.max(0, Math.round(lines));
    while (left > 0) {
      const chunk = Math.min(200, left);
      send({ type: "scroll", direction, lines: chunk, source });
      left -= chunk;
    }
  }

  function queueScroll(direction: "up" | "down", lines: number, source: "wheel" | "page_key") {
    const step = Math.max(0, Math.round(lines) || 0);
    if (!step) return;
    const current = placeRef.current;
    const pending = pendingRef.current;
    if (direction === "down" && current.fromEnd <= 0) return;
    if (direction === "up" && current.extent > 0 && current.fromEnd >= current.extent && pending?.direction === "up") return;
    if (pending && pending.direction === direction) {
      pendingRef.current = { place: pending.place, direction, lines: pending.lines + step };
    } else {
      pendingRef.current = { place: current, direction, lines: step };
    }
    commitPlace(previewScroll(current, direction, step));
    emitScroll(direction, step, source);
    window.clearTimeout(pendingTimer.current);
    pendingTimer.current = window.setTimeout(giveUp, 800);
  }

  const thumb = scrollMetrics(trackPx, gridRows, place.fromEnd, place.extent);

  return (
    <div
      className="term-shell"
      ref={shellRef}
      onKeyDownCapture={(event) => {
        if (!paneId || event.key === "F12") return;
        if (event.nativeEvent.isComposing) return;
        if (host.consume(event.nativeEvent)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        const term = termRef.current;
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && term?.hasSelection()) {
          const selected = term.getSelection();
          if (selected) void navigator.clipboard.writeText(selected);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        const page = pageScroll(event.key, term?.rows ?? 1);
        if (page && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          flushText();
          queueScroll(page.direction, page.lines, "page_key");
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const printable = event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey;
        if (printable) {
          queueText(event.key);
          return;
        }
        flushText();
        send({
          type: "key",
          key: event.key,
          ctrl: event.ctrlKey,
          alt: event.altKey,
          shift: event.shiftKey,
          meta: event.metaKey,
        });
      }}
      onPasteCapture={(event) => {
        const text = event.clipboardData.getData("text");
        if (!text) return;
        event.preventDefault();
        flushText();
        send({ type: "text", text });
      }}
      onCompositionEnd={(event) => {
        if (event.data) queueText(event.data);
      }}
      onWheelCapture={(event) => {
        if (event.ctrlKey || event.metaKey) return;
        const gesture = wheelScroll(event.deltaY, event.deltaMode);
        if (!gesture) return;
        event.preventDefault();
        event.stopPropagation();
        queueScroll(gesture.direction, gesture.lines, "wheel");
      }}
    >
      <div className="term-stage" ref={stageRef} />
      <div
        className="term-scroll"
        role="scrollbar"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={place.extent}
        aria-valuenow={place.fromEnd}
        aria-label="Terminal scroll"
        onPointerDown={(event) => {
          const track = event.currentTarget;
          const metrics = scrollMetrics(track.clientHeight, rowsRef.current, placeRef.current.fromEnd, placeRef.current.extent);
          const local = event.clientY - track.getBoundingClientRect().top;
          if (local >= metrics.top && local <= metrics.top + metrics.height) {
            dragRef.current = { y: event.clientY, top: metrics.top };
            track.setPointerCapture(event.pointerId);
            return;
          }
          const page = Math.max(1, rowsRef.current);
          const direction = local < metrics.top ? "up" : "down";
          queueScroll(direction, page, "page_key");
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag) return;
          const track = event.currentTarget.clientHeight;
          const current = placeRef.current;
          const height = scrollMetrics(track, rowsRef.current, current.fromEnd, current.extent).height;
          const next = scrollFromThumb(track, height, drag.top + (event.clientY - drag.y), current.extent);
          const delta = next - current.fromEnd;
          if (delta === 0) return;
          queueScroll(delta > 0 ? "up" : "down", Math.abs(delta), "wheel");
        }}
        onPointerUp={() => {
          dragRef.current = null;
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
      >
        <div className="term-scroll-thumb" style={{ top: thumb.top, height: thumb.height }} />
      </div>
      {status ? <div className="term-status">{status}</div> : null}
    </div>
  );
}

export function fitCells(
  hostW: number,
  hostH: number,
  cellW: number,
  cellH: number,
): { cols: number; rows: number } | null {
  if (hostW < 8 || hostH < 8 || cellW < 1 || cellH < 1) return null;
  const cols = Math.floor(hostW / cellW);
  const rows = Math.floor(hostH / cellH);
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
  return {
    cols: Math.max(2, Math.min(500, cols)),
    rows: Math.max(1, Math.min(200, rows)),
  };
}

function paintTheme(term: Terminal) {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  term.options.theme = {
    background: read("--term", "#101318"),
    foreground: read("--text", "#e7e2d6"),
    cursor: read("--accent", "#e2b657"),
    cursorAccent: read("--term", "#101318"),
    selectionBackground: read("--line-strong", "#3d4f38"),
  };
}

function readCell(term: Terminal): { w: number; h: number } {
  const core = (term as unknown as {
    _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } };
  })._core;
  const cell = core?._renderService?.dimensions?.css?.cell;
  if (cell && cell.width > 0 && cell.height > 0) return { w: cell.width, h: cell.height };
  return { w: 8.4, h: 17 };
}
