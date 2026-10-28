import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { api, wsUrl } from "../../api";
import { useHost } from "../../host";
import {
  joinTerminalSelection,
  keysToRemoveSelection,
  selectionLinesUnchanged,
  shiftSelection,
  spanBetween,
  writeTerminalClipboard,
  type BufferSelection,
  type Caret,
  type SelectionLine,
} from "../../terminalEdit";
import {
  applyScroll,
  inputScroll,
  pageScroll,
  previewScroll,
  scrollDragTarget,
  scrollThumb,
  type ScrollPlace,
  screenMoved,
  viewBox,
  viewportShift,
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

function windowsClipboard(): boolean {
  return typeof navigator !== "undefined" && /Win/i.test(navigator.userAgent || "");
}

/** Selected cells, including spaces. A row that runs to the screen edge marks its blank margin for trimming. */
function linesOfSelection(term: Terminal): SelectionLine[] {
  const position = term.getSelectionPosition();
  if (!position || !term.hasSelection()) return [];
  const buffer = term.buffer.active;
  const y0 = position.start.y;
  const y1 = position.end.y;
  const rows: SelectionLine[] = [];
  for (let y = y0; y <= y1; y += 1) {
    if (y === y1 && y > y0 && position.end.x === 0) break;
    const line = buffer.getLine(y);
    const endCol = y === y1 ? position.end.x : term.cols;
    rows.push({
      text: line ? line.translateToString(false, y === y0 ? position.start.x : 0, endCol) : "",
      wrapped: y !== y0 && Boolean(line?.isWrapped),
      trimEnd: endCol >= term.cols,
    });
  }
  return rows;
}

function publishCopy(term: Terminal): boolean {
  const text = joinTerminalSelection(linesOfSelection(term));
  if (!text) return false;
  void writeTerminalClipboard(text, windowsClipboard()).catch(() => undefined);
  return true;
}

interface ScrollDrag {
  pointer: number;
  y: number;
  fromEnd: number;
  extent: number;
  top: number;
  height: number;
  track: number;
  cell: number;
  lastTarget: number;
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
  const heldButton = useRef<"left" | "right" | "middle" | null>(null);
  const mouseCell = useRef<{ column: number; row: number } | null>(null);
  const pendingRef = useRef<{ direction: "up" | "down"; lines: number; place: ScrollPlace } | null>(null);
  const pendingTimer = useRef(0);
  const [place, setPlace] = useState<ScrollPlace>({ fromEnd: 0, extent: 0 });
  const [trackHeight, setTrackHeight] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<ScrollDrag | null>(null);
  const notifyRef = useRef(host.notify);
  notifyRef.current = host.notify;
  const seenRef = useRef(false);
  const anchorRef = useRef<Caret | null>(null);
  const headRef = useRef<Caret | null>(null);
  const fromKeyboard = useRef(false);
  const pasteStamp = useRef(0);
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
      convertEol: false,
      disableStdin: true,
      cursorBlink: false,
      cursorStyle: "block",
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, ui-monospace, monospace',
      fontSize: 14,
      lineHeight: 1,
      scrollback: 0,
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
    let selectionEpoch = 0;
    let layoutEpoch = 0;
    let restoring = false;
    let copyNotice = 0;
    const onSelection = term.onSelectionChange(() => {
      if (!restoring) {
        const copied = publishCopy(term);
        window.clearTimeout(copyNotice);
        if (copied) copyNotice = window.setTimeout(() => notifyRef.current("Copied to clipboard"), 400);
      }
      if (fromKeyboard.current || restoring) return;
      selectionEpoch += 1;
      const position = term.getSelectionPosition();
      if (!position) {
        anchorRef.current = null;
        headRef.current = null;
        return;
      }
      anchorRef.current = { x: position.start.x, y: position.start.y };
      headRef.current = { x: position.end.x, y: position.end.y };
    });
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
      const host = stageRef.current;
      if (!current || !host) return;
      const cell = readCell(current);
      const next = fitCells(host.clientWidth, host.clientHeight, cell.w, cell.h);
      if (!next) return;
      const shown = viewBox(next, 0, 0) ?? next;
      const sameGrid = current.cols === shown.cols && current.rows === shown.rows;
      const sameRequest = wanted !== null && wanted.cols === shown.cols && wanted.rows === shown.rows;
      if (!sameGrid) {
        layoutEpoch += 1;
        current.clearSelection();
        anchorRef.current = null;
        headRef.current = null;
        current.resize(shown.cols, shown.rows);
      }
      wanted = shown;
      rowsRef.current = shown.rows;
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
    const readLines = () => {
      const buffer = term.buffer.active;
      const rows: string[] = [];
      for (let row = 0; row < term.rows; row += 1) {
        const line = buffer.getLine(buffer.baseY + row);
        rows.push(line ? line.translateToString(true) : "");
      }
      return rows;
    };
    const readScreen = () => readLines().join("\n");
    const viewportSelection = (): BufferSelection | null => {
      const position = term.getSelectionPosition();
      if (!position || !term.hasSelection()) return null;
      const base = term.buffer.active.baseY;
      return {
        start: { x: position.start.x, y: position.start.y - base },
        end: { x: position.end.x, y: position.end.y - base },
      };
    };
    const showSelection = (viewport: BufferSelection | null) => {
      const base = term.buffer.active.baseY;
      restoring = true;
      fromKeyboard.current = true;
      if (!viewport) {
        term.clearSelection();
        anchorRef.current = null;
        headRef.current = null;
      } else {
        const absolute: BufferSelection = {
          start: { x: viewport.start.x, y: viewport.start.y + base },
          end: { x: viewport.end.x, y: viewport.end.y + base },
        };
        const span = spanBetween(absolute.start, absolute.end, term.cols);
        if (span) {
          term.select(span.column, span.row, span.length);
          anchorRef.current = absolute.start;
          headRef.current = absolute.end;
        } else {
          term.clearSelection();
          anchorRef.current = null;
          headRef.current = null;
        }
      }
      fromKeyboard.current = false;
      restoring = false;
    };
    const restoreSelection = (held: BufferSelection | null, before: string[], replaced: boolean) => {
      if (!held) return;
      const after = readLines();
      const shift = viewportShift(before, after);
      if (shift === null) {
        if (!replaced && selectionLinesUnchanged(before, after, held)) return;
        showSelection(selectionLinesUnchanged(before, after, held) ? held : null);
        return;
      }
      showSelection(shiftSelection(held, shift, term.rows));
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
            const held = viewportSelection();
            const before = readLines();
            const epoch = selectionEpoch;
            const layout = layoutEpoch;
            const replaced = Boolean(frame.full);
            fromKeyboard.current = true;
            if (frame.full) term.reset();
            fromKeyboard.current = false;
            const done = () => {
              if (stopped || token !== paint) return;
              term.scrollToBottom();
              finish(token);
              if (selectionEpoch !== epoch || layoutEpoch !== layout) return;
              restoreSelection(held, before, replaced);
            };
            if (text) term.write(text, () => done());
            else done();
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
      window.clearTimeout(copyNotice);
      window.removeEventListener("herdr-theme", onTheme);
      window.removeEventListener("herdr-zoom", onZoom);
      window.clearTimeout(flushTimer.current);
      window.clearTimeout(pendingTimer.current);
      observer.disconnect();
      socket?.close();
      socketRef.current = null;
      onSelection.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [paneId, source, lines]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const measure = () => setTrackHeight(track.clientHeight);
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    measure();
    return () => observer.disconnect();
  }, [paneId]);

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

  function followInput() {
    const lines = inputScroll(placeRef.current);
    if (!lines) return;
    pendingRef.current = null;
    commitPlace({ fromEnd: 0, extent: placeRef.current.extent });
    emitScroll("down", lines, "wheel");
  }

  function queueText(text: string) {
    followInput();
    bufferRef.current += text;
    window.clearTimeout(flushTimer.current);
    flushTimer.current = window.setTimeout(flushText, 16);
  }

  function cursorCaret(term: Terminal): Caret {
    const buffer = term.buffer.active;
    return { x: buffer.cursorX, y: buffer.baseY + buffer.cursorY };
  }

  function copySelection(term: Terminal) {
    if (publishCopy(term)) host.notify("Copied to clipboard");
  }

  function selectionOf(term: Terminal): BufferSelection | null {
    const position = term.getSelectionPosition();
    if (!position || !term.hasSelection()) return null;
    return { start: { x: position.start.x, y: position.start.y }, end: { x: position.end.x, y: position.end.y } };
  }

  function sendKeys(keys: string[]) {
    for (const key of keys) send({ type: "key", key, ctrl: false, alt: false, shift: false, meta: false });
  }

  function removeHighlight(term: Terminal, selection: BufferSelection | null): boolean {
    if (!selection) return false;
    const keys = keysToRemoveSelection(cursorCaret(term), selection);
    flushText();
    if (keys) sendKeys(keys);
    term.clearSelection();
    anchorRef.current = null;
    headRef.current = null;
    return keys !== null;
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

  function reportMouse(
    action: "down" | "up" | "drag" | "move",
    event: { clientX: number; clientY: number; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean },
    button: "left" | "right" | "middle",
  ) {
    const term = termRef.current;
    if (!term) return;
    const cell = cellAt(term, event.clientX, event.clientY);
    if (!cell) return;
    const same = mouseCell.current?.column === cell.column && mouseCell.current?.row === cell.row;
    if (action !== "up" && action !== "down" && same) return;
    mouseCell.current = cell;
    const modifiers =
      (event.shiftKey ? 1 : 0) |
      (event.ctrlKey ? 2 : 0) |
      (event.altKey ? 4 : 0) |
      (event.metaKey ? 8 : 0);
    send({ type: "mouse", action, button, column: cell.column, row: cell.row, modifiers });
  }

  function beginScrollDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    termRef.current?.focus();
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const local = event.clientY - rect.top;
    const box = scrollThumb(rect.height, rowsRef.current, placeRef.current.fromEnd, placeRef.current.extent);
    const onThumb = box.height > 0 && local >= box.top && local < box.top + box.height;
    if (!onThumb) {
      const page = Math.max(1, rowsRef.current - 1);
      queueScroll(local < box.top ? "up" : "down", page, "page_key");
      return;
    }
    dragRef.current = {
      pointer: event.pointerId,
      y: event.clientY,
      fromEnd: placeRef.current.fromEnd,
      extent: placeRef.current.extent,
      top: box.top,
      height: box.height,
      track: rect.height,
      cell: termRef.current ? readCell(termRef.current).h : 17,
      lastTarget: placeRef.current.fromEnd,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // The pointer ended before capture.
    }
  }

  function moveScrollDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const target = scrollDragTarget(
      drag.extent,
      drag.fromEnd,
      event.clientY - drag.y,
      drag.cell,
      drag.track,
      drag.top,
      drag.height,
    );
    const basis = drag.extent <= 0 ? drag.lastTarget : placeRef.current.fromEnd;
    const delta = basis - target;
    if (!delta) return;
    queueScroll(delta > 0 ? "down" : "up", Math.abs(delta), "wheel");
    drag.lastTarget = target;
  }

  function endScrollDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointer !== event.pointerId) return;
    dragRef.current = null;
    event.stopPropagation();
  }

  const thumb = scrollThumb(trackHeight, rowsRef.current, place.fromEnd, place.extent);

  return (
    <div
      className="term-shell"
      ref={shellRef}
      onPointerDown={(event) => {
        const button = pointerButton(event.button);
        if (!button) return;
        heldButton.current = button;
        reportMouse("down", event, button);
      }}
      onPointerMove={(event) => {
        const button = heldButton.current;
        if (button && event.buttons !== 0) {
          reportMouse("drag", event, button);
          return;
        }
        reportMouse("move", event, "left");
      }}
      onPointerUp={(event) => {
        const button = pointerButton(event.button) ?? heldButton.current;
        heldButton.current = null;
        if (button) reportMouse("up", event, button);
      }}
      onPointerCancel={() => {
        heldButton.current = null;
      }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDownCapture={(event) => {
        if (!paneId || event.key === "F12") return;
        if (event.nativeEvent.isComposing) return;
        const term = termRef.current;
        const command = event.ctrlKey || event.metaKey;
        const printable = event.key.length === 1 && !command && !event.altKey;
        if (term && command && !event.altKey && event.key.toLowerCase() === "c" && term.hasSelection()) {
          copySelection(term);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (term && event.ctrlKey && !event.altKey && !event.shiftKey && event.key === "Insert" && term.hasSelection()) {
          copySelection(term);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (term && !event.altKey && ((command && !event.shiftKey && event.key.toLowerCase() === "v") || (!command && event.shiftKey && event.key === "Insert"))) {
          event.preventDefault();
          event.stopPropagation();
          pasteStamp.current = Date.now();
          const highlighted = selectionOf(term);
          void navigator.clipboard?.readText().then((text) => {
            const current = termRef.current;
            if (!current) return;
            if (highlighted) removeHighlight(current, highlighted);
            if (!text) return;
            flushText();
            followInput();
            send({ type: "text", text });
          }).catch(() => undefined);
          return;
        }
        if (term && term.hasSelection() && !event.altKey && !event.metaKey && (event.key === "Backspace" || event.key === "Delete" || printable)) {
          const highlighted = selectionOf(term);
          const removed = highlighted ? keysToRemoveSelection(cursorCaret(term), highlighted) : null;
          if (event.key === "Backspace" || event.key === "Delete") {
            event.preventDefault();
            event.stopPropagation();
            if (highlighted) removeHighlight(term, highlighted);
            return;
          }
          if (removed) {
            event.preventDefault();
            event.stopPropagation();
            removeHighlight(term, highlighted);
            queueText(event.key);
            return;
          }
          term.clearSelection();
        }
        if (host.consume(event.nativeEvent)) {
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
        followInput();
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
        if (Date.now() - pasteStamp.current < 50) {
          event.preventDefault();
          return;
        }
        const text = event.clipboardData.getData("text");
        if (!text) return;
        event.preventDefault();
        const term = termRef.current;
        if (term) {
          const highlighted = selectionOf(term);
          if (highlighted) removeHighlight(term, highlighted);
        }
        flushText();
        followInput();
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
      {paneId ? (
        <div
          className="term-scroll"
          ref={trackRef}
          onPointerDown={beginScrollDrag}
          onPointerMove={moveScrollDrag}
          onPointerUp={endScrollDrag}
          onPointerCancel={endScrollDrag}
        >
          <div className="term-scroll-thumb" style={{ top: thumb.top, height: thumb.height }} />
        </div>
      ) : null}
      {status ? <div className="term-status">{status}</div> : null}
    </div>
  );
}

function pointerButton(button: number): "left" | "right" | "middle" | null {
  if (button === 0) return "left";
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return null;
}

function cellAt(term: Terminal, clientX: number, clientY: number): { column: number; row: number } | null {
  const screen = term.element?.querySelector(".xterm-screen");
  if (!(screen instanceof HTMLElement) || term.cols < 1 || term.rows < 1) return null;
  const rect = screen.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  const column = Math.floor(((clientX - rect.left) / rect.width) * term.cols);
  const row = Math.floor(((clientY - rect.top) / rect.height) * term.rows);
  if (column < 0 || row < 0 || column >= term.cols || row >= term.rows) return null;
  return { column, row };
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
