import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { api, wsUrl } from "../../api";
import { desktopHost } from "../../desktopBrowser";
import { useHost } from "../../host";
import {
  caretSelection,
  collectSelectionLines,
  joinTerminalSelection,
  keysToRemoveSelection,
  selectionLinesUnchanged,
  spanBetween,
  visibleSelection,
  wordCells,
  writeTerminalClipboard,
  type BufferSelection,
  type Caret,
  type GridCell,
  type SelectionLine,
} from "../../terminalEdit";
import {
  applyScroll,
  inputScroll,
  pageScroll,
  pointerCell,
  previewScroll,
  scrollDragTarget,
  scrollThumb,
  type ScrollPlace,
  fittedGrid,
  frameDraw,
  openingScreen,
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
  const heldRef = useRef<BufferSelection | null>(null);
  const anchorCellRef = useRef<GridCell | null>(null);
  const headCellRef = useRef<GridCell | null>(null);
  const draggingRef = useRef(false);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const lineCacheRef = useRef(new Map<number, { text: string; wrapped: boolean }>());
  const restoringRef = useRef(false);
  const gestureRef = useRef(0);
  const edgeDirRef = useRef<"up" | "down" | null>(null);
  const edgeTimerRef = useRef(0);
  const copyNoticeRef = useRef(0);
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
    let layoutEpoch = 0;
    let copyNotice = 0;
    const onSelection = term.onSelectionChange(() => {
      if (restoringRef.current || fromKeyboard.current || draggingRef.current) return;
      const position = term.getSelectionPosition();
      if (!position || !term.hasSelection()) return;
      const base = term.buffer.active.baseY;
      heldRef.current = {
        start: { x: position.start.x, y: position.start.y - base },
        end: { x: position.end.x, y: position.end.y - base },
      };
      anchorRef.current = { x: position.start.x, y: position.start.y };
      headRef.current = { x: position.end.x, y: position.end.y };
      const copied = publishCopy(term);
      window.clearTimeout(copyNotice);
      if (copied) copyNotice = window.setTimeout(() => notifyRef.current("Copied to clipboard"), 400);
    });
    const onTheme = () => {
      if (termRef.current) paintTheme(termRef.current);
    };
    window.addEventListener("herdr-theme", onTheme);

    let sizeTimer = 0;
    let liveTimer = 0;
    let wanted: { cols: number; rows: number } | null = null;
    let fittedCell: { w: number; h: number } | null = null;
    let sent: { cols: number; rows: number } | null = null;
    const sizeProblem = { current: false };
    const openedAt = Date.now();
    let zoomSettled = desktopHost() == null;
    let fontsSettled = !document.fonts || document.fonts.status === "loaded";
    let screenLive = false;
    let waitingFull = false;
    let stopped = false;
    const queued: ScreenMessage[] = [];
    let drawn = "";
    let shown: string | null = null;
    let paint = 0;
    let painting = false;
    let goLive = () => {};

    const flushSize = () => {
      const next = wanted;
      const socket = socketRef.current;
      if (!next || !socket || socket.readyState !== WebSocket.OPEN) return;
      if (sent && sent.cols === next.cols && sent.rows === next.rows) return;
      sent = next;
      socket.send(JSON.stringify({ type: "resize", cols: next.cols, rows: next.rows }));
    };

    const scheduleLive = () => {
      if (screenLive) return;
      window.clearTimeout(liveTimer);
      liveTimer = window.setTimeout(() => goLive(), 120);
    };

    const applySize = (force = false) => {
      const current = termRef.current;
      const host = stageRef.current;
      if (!current || !host) return;
      let cell = measureCell(current);
      if (!cell && force) cell = { w: 8.4, h: 17 };
      const next = fittedGrid(host.clientWidth, host.clientHeight, cell);
      if (!next || !cell) return;
      const shownGrid = viewBox(next, 0, 0) ?? next;
      const sameGrid = current.cols === shownGrid.cols && current.rows === shownGrid.rows;
      const sameRequest = wanted !== null && wanted.cols === shownGrid.cols && wanted.rows === shownGrid.rows;
      const cellChanged =
        fittedCell !== null &&
        (Math.abs(fittedCell.w - cell.w) > 0.05 || Math.abs(fittedCell.h - cell.h) > 0.05);
      if (!sameGrid) {
        layoutEpoch += 1;
        current.clearSelection();
        anchorRef.current = null;
        headRef.current = null;
        heldRef.current = null;
        anchorCellRef.current = null;
        headCellRef.current = null;
        lineCacheRef.current.clear();
        if (screenLive) {
          waitingFull = true;
          drawn = "";
          fromKeyboard.current = true;
          current.reset();
          fromKeyboard.current = false;
        }
        current.resize(shownGrid.cols, shownGrid.rows);
      } else if (cellChanged && screenLive) {
        current.refresh(0, current.rows - 1);
      }
      fittedCell = cell;
      wanted = shownGrid;
      rowsRef.current = shownGrid.rows;
      if (sameRequest) return;
      window.clearTimeout(sizeTimer);
      sizeTimer = window.setTimeout(flushSize, 80);
    };

    const onZoom = () => {
      zoomSettled = true;
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() => {
          applySize();
          scheduleLive();
        }),
      );
    };
    window.addEventListener("herdr-zoom", onZoom);

    const observer = new ResizeObserver(() => {
      applySize();
      scheduleLive();
    });
    observer.observe(shell);
    const fontsReady = () => {
      fontsSettled = true;
      if (!termRef.current) return;
      applySize();
      scheduleLive();
    };
    void document.fonts?.ready.then(fontsReady);
    document.fonts?.addEventListener("loadingdone", fontsReady);
    void document.fonts?.load('14px "Cascadia Mono"').then(fontsReady).catch(() => undefined);
    applySize();
    scheduleLive();

    let gotFrame = false;
    let retry = 0;
    let seedTimer = 0;
    let socket: WebSocket | null = null;
    const params = new URLSearchParams({ paneId });
    if (source) params.set("source", source);
    if (lines) params.set("lines", String(lines));

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
    const cacheViewport = () => {
      const buffer = term.buffer.active;
      const base = buffer.baseY;
      for (let row = 0; row < term.rows; row += 1) {
        const line = buffer.getLine(base + row);
        lineCacheRef.current.set(row, {
          text: line ? line.translateToString(false) : "",
          wrapped: Boolean(line?.isWrapped),
        });
      }
    };
    const shiftCache = (rows: number) => {
      if (!rows) return;
      const next = new Map<number, { text: string; wrapped: boolean }>();
      for (const [y, value] of lineCacheRef.current) next.set(y + rows, value);
      lineCacheRef.current = next;
    };
    const restoreSelection = (before: string[], requested: number | null) => {
      const anchor = anchorCellRef.current;
      const head = headCellRef.current;
      const held = heldRef.current;
      if (!anchor || !head || !held) return;
      const after = readLines();
      let shift = viewportShift(before, after);
      if (shift === null && requested && screenMoved(before.join("\n"), after.join("\n"))) shift = requested;
      if (shift === null) {
        if (selectionLinesUnchanged(before, after, held)) {
          cacheViewport();
          return;
        }
        anchorCellRef.current = null;
        headCellRef.current = null;
        lineCacheRef.current.clear();
        paintSelection(term, null);
        return;
      }
      const nextAnchor = { column: anchor.column, row: anchor.row + shift };
      let nextHead = { column: head.column, row: head.row + shift };
      if (draggingRef.current && pointerRef.current) {
        const live = pointerOnTerm(term, pointerRef.current.x, pointerRef.current.y);
        if (live) nextHead = { column: live.column, row: live.row };
      }
      shiftCache(shift);
      anchorCellRef.current = nextAnchor;
      headCellRef.current = nextHead;
      const selection = caretSelection(nextAnchor, nextHead, term.cols);
      cacheViewport();
      pruneCache(selection, term.rows);
      paintSelection(term, selection);
      copyHeld(term, false);
    };
    const finish = (token: number) => {
      if (stopped || token !== paint) return;
      painting = false;
      const next = readScreen();
      const previous = shown;
      shown = next;
      if (previous === null) return;
      settleScroll(screenMoved(previous, next));
    };
    const applyFrame = (frame: ScreenMessage) => {
      const decision = frameDraw(
        waitingFull,
        { text: frame.text ?? "", full: Boolean(frame.full), cols: frame.cols, rows: frame.rows },
        drawn,
        wanted,
      );
      waitingFull = decision.waitingForFull;
      if (!decision.draw) {
        const matches =
          wanted === null ||
          frame.cols == null ||
          frame.rows == null ||
          (frame.cols === wanted.cols && frame.rows === wanted.rows);
        if (matches && !waitingFull && !painting) finish(paint);
        return;
      }
      drawn = decision.drawn;
      const text = frame.text ?? "";
      const token = ++paint;
      painting = true;
      cacheViewport();
      const before = readLines();
      const gesture = gestureRef.current;
      const layout = layoutEpoch;
      const pending = pendingRef.current;
      const requested = pending ? (pending.direction === "up" ? pending.lines : -pending.lines) : null;
      fromKeyboard.current = true;
      if (decision.reset) term.reset();
      fromKeyboard.current = false;
      const done = () => {
        if (stopped || token !== paint) return;
        term.scrollToBottom();
        finish(token);
        if (gestureRef.current !== gesture || layoutEpoch !== layout) return;
        restoreSelection(before, requested);
      };
      if (text) term.write(text, () => done());
      else done();
    };
    goLive = () => {
      if (screenLive || stopped) return;
      const age = Date.now() - openedAt;
      const host = stageRef.current;
      const current = termRef.current;
      const cell = current ? measureCell(current) : null;
      const ready = Boolean(host && fittedGrid(host.clientWidth, host.clientHeight, cell));
      if ((!zoomSettled && age < 600) || (!fontsSettled && age < 600) || (!ready && age < 1500)) {
        scheduleLive();
        return;
      }
      applySize(age >= 1500);
      if (!wanted) {
        if (age < 5000) scheduleLive();
        return;
      }
      const grid = wanted;
      screenLive = true;
      const batch = grid
        ? openingScreen(
            queued.map((frame) => ({
              text: frame.text ?? "",
              full: Boolean(frame.full),
              cols: frame.cols,
              rows: frame.rows,
            })),
            grid.cols,
            grid.rows,
          )
        : [];
      queued.length = 0;
      if (batch.length === 0) waitingFull = true;
      for (const frame of batch) {
        applyFrame({ type: "frame", text: frame.text, full: frame.full, cols: frame.cols, rows: frame.rows });
      }
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
          if (!sizeProblem.current) setStatus("");
          if (!screenLive) {
            queued.push(frame);
            return;
          }
          applyFrame(frame);
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
      window.clearTimeout(liveTimer);
      document.fonts?.removeEventListener("loadingdone", fontsReady);
      window.clearTimeout(copyNotice);
      window.clearTimeout(copyNoticeRef.current);
      window.clearInterval(edgeTimerRef.current);
      window.removeEventListener("herdr-theme", onTheme);
      window.removeEventListener("herdr-zoom", onZoom);
      window.clearTimeout(flushTimer.current);
      const pendingText = bufferRef.current;
      bufferRef.current = "";
      if (pendingText && socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "text", text: pendingText }));
      }
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

  function pruneCache(selection: BufferSelection, rows: number) {
    const y0 = Math.min(selection.start.y, selection.end.y);
    const y1 = Math.max(selection.start.y, selection.end.y);
    const next = new Map<number, { text: string; wrapped: boolean }>();
    for (const [y, value] of lineCacheRef.current) {
      if ((y >= y0 && y <= y1) || (y >= 0 && y < rows)) next.set(y, value);
    }
    lineCacheRef.current = next;
  }

  function paintSelection(term: Terminal, selection: BufferSelection | null) {
    heldRef.current = selection;
    const visible = selection ? visibleSelection(selection, term.cols, term.rows) : null;
    const base = term.buffer.active.baseY;
    restoringRef.current = true;
    fromKeyboard.current = true;
    if (!visible) {
      term.clearSelection();
      anchorRef.current = null;
      headRef.current = null;
    } else {
      const span = spanBetween(
        { x: visible.start.x, y: visible.start.y + base },
        { x: visible.end.x, y: visible.end.y + base },
        term.cols,
      );
      if (span) {
        term.select(span.column, span.row, span.length);
        anchorRef.current = { x: visible.start.x, y: visible.start.y + base };
        headRef.current = { x: visible.end.x, y: visible.end.y + base };
      } else {
        term.clearSelection();
        anchorRef.current = null;
        headRef.current = null;
      }
    }
    fromKeyboard.current = false;
    restoringRef.current = false;
  }

  function pointerOnTerm(term: Terminal, clientX: number, clientY: number) {
    const screen = term.element?.querySelector(".xterm-screen");
    if (!(screen instanceof HTMLElement)) return null;
    const rect = screen.getBoundingClientRect();
    return pointerCell(clientX - rect.left, clientY - rect.top, rect.width, rect.height, term.cols, term.rows);
  }

  function linesOfHeld(term: Terminal): SelectionLine[] {
    const held = heldRef.current;
    if (!held) return [];
    const buffer = term.buffer.active;
    const base = buffer.baseY;
    return collectSelectionLines(held, term.cols, (row, from, to) => {
      if (row >= 0 && row < term.rows) {
        const line = buffer.getLine(base + row);
        if (!line) return null;
        return { text: line.translateToString(false, from, to), wrapped: Boolean(line.isWrapped) };
      }
      const cached = lineCacheRef.current.get(row);
      if (!cached) return null;
      const start = Math.max(0, from);
      return {
        text: Array.from(cached.text).slice(start, Math.max(start, to)).join(""),
        wrapped: cached.wrapped,
      };
    });
  }

  function copyHeld(term: Terminal, announce: boolean): boolean {
    const rows = heldRef.current ? linesOfHeld(term) : linesOfSelection(term);
    const text = joinTerminalSelection(rows);
    if (!text) return false;
    void writeTerminalClipboard(text, windowsClipboard()).catch(() => undefined);
    if (announce) {
      window.clearTimeout(copyNoticeRef.current);
      copyNoticeRef.current = window.setTimeout(() => notifyRef.current("Copied to clipboard"), 400);
    }
    return true;
  }

  function stopEdge() {
    window.clearInterval(edgeTimerRef.current);
    edgeTimerRef.current = 0;
    edgeDirRef.current = null;
  }

  function startEdge(direction: "up" | "down") {
    if (edgeDirRef.current === direction && edgeTimerRef.current) return;
    stopEdge();
    edgeDirRef.current = direction;
    const tick = () => {
      if (!draggingRef.current || edgeDirRef.current !== direction) return;
      queueScroll(direction, 1, "wheel");
    };
    tick();
    edgeTimerRef.current = window.setInterval(tick, 60);
  }

  function dropHeld(term: Terminal) {
    anchorCellRef.current = null;
    headCellRef.current = null;
    lineCacheRef.current.clear();
    draggingRef.current = false;
    stopEdge();
    paintSelection(term, null);
  }

  function applyCells(term: Terminal, anchor: GridCell, head: GridCell) {
    anchorCellRef.current = anchor;
    headCellRef.current = head;
    paintSelection(term, caretSelection(anchor, head, term.cols));
  }

  function extendDrag(clientX: number, clientY: number) {
    const term = termRef.current;
    const anchor = anchorCellRef.current;
    if (!term || !anchor || !draggingRef.current) return;
    const live = pointerOnTerm(term, clientX, clientY);
    if (!live) return;
    const head = { column: live.column, row: live.row };
    if (head.column === anchor.column && head.row === anchor.row) {
      stopEdge();
      return;
    }
    applyCells(term, anchor, head);
    copyHeld(term, true);
    if (live.edge) startEdge(live.edge);
    else stopEdge();
  }

  function beginMouseSelect(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest(".term-scroll, .term-status")) return;
    const term = termRef.current;
    if (!term) return;
    event.stopPropagation();
    event.preventDefault();
    term.focus();
    pointerRef.current = { x: event.clientX, y: event.clientY };
    const live = pointerOnTerm(term, event.clientX, event.clientY);
    if (!live) return;
    gestureRef.current += 1;
    stopEdge();
    const cell = { column: live.column, row: live.row };
    if (event.detail >= 3) {
      draggingRef.current = false;
      applyCells(term, { column: 0, row: cell.row }, { column: Math.max(0, term.cols - 1), row: cell.row });
      copyHeld(term, true);
      return;
    }
    if (event.detail === 2) {
      draggingRef.current = false;
      const buffer = term.buffer.active;
      const line = buffer.getLine(buffer.baseY + cell.row);
      const word = wordCells(line ? line.translateToString(true) : "", cell.column, cell.row, term.cols);
      applyCells(term, word.anchor, word.head);
      copyHeld(term, true);
      return;
    }
    draggingRef.current = true;
    if (event.shiftKey && anchorCellRef.current && heldRef.current) {
      applyCells(term, anchorCellRef.current, cell);
      copyHeld(term, true);
      return;
    }
    anchorCellRef.current = cell;
    headCellRef.current = cell;
    heldRef.current = null;
    lineCacheRef.current.clear();
    paintSelection(term, null);
  }

  function cursorCaret(term: Terminal): Caret {
    const buffer = term.buffer.active;
    return { x: buffer.cursorX, y: buffer.baseY + buffer.cursorY };
  }

  function copySelection(term: Terminal) {
    if (copyHeld(term, false)) host.notify("Copied to clipboard");
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
    const buffer = term.buffer.active;
    const cursor = selection === heldRef.current ? { x: buffer.cursorX, y: buffer.cursorY } : cursorCaret(term);
    const keys = keysToRemoveSelection(cursor, selection);
    flushText();
    if (keys) sendKeys(keys);
    term.clearSelection();
    anchorRef.current = null;
    headRef.current = null;
    heldRef.current = null;
    anchorCellRef.current = null;
    headCellRef.current = null;
    lineCacheRef.current.clear();
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
      cell: termRef.current ? (measureCell(termRef.current)?.h ?? 17) : 17,
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
      onMouseDownCapture={beginMouseSelect}
      onPointerDown={(event) => {
        const button = pointerButton(event.button);
        if (!button) return;
        heldButton.current = button;
        if (button === "left") {
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // The pointer ended before capture.
          }
        }
        reportMouse("down", event, button);
      }}
      onPointerMove={(event) => {
        pointerRef.current = { x: event.clientX, y: event.clientY };
        if (draggingRef.current && (event.buttons & 1) !== 0) extendDrag(event.clientX, event.clientY);
        const button = heldButton.current;
        if (button && event.buttons !== 0) {
          reportMouse("drag", event, button);
          return;
        }
        reportMouse("move", event, "left");
      }}
      onPointerUp={(event) => {
        if (draggingRef.current) {
          draggingRef.current = false;
          stopEdge();
          const term = termRef.current;
          if (term && heldRef.current) copyHeld(term, true);
        }
        const button = pointerButton(event.button) ?? heldButton.current;
        heldButton.current = null;
        if (button) reportMouse("up", event, button);
      }}
      onPointerCancel={() => {
        draggingRef.current = false;
        stopEdge();
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
          const highlighted = heldRef.current ?? selectionOf(term);
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
        if (term && (term.hasSelection() || heldRef.current) && !event.altKey && !event.metaKey && (event.key === "Backspace" || event.key === "Delete" || printable)) {
          const highlighted = heldRef.current ?? selectionOf(term);
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
          dropHeld(term);
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
          const highlighted = heldRef.current ?? selectionOf(term);
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
  return fittedGrid(hostW, hostH, { w: cellW, h: cellH });
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

function measureCell(term: Terminal): { w: number; h: number } | null {
  const core = (term as unknown as {
    _core?: {
      _charSizeService?: { measure?: () => void };
      _renderService?: {
        dimensions?: { css?: { cell?: { width: number; height: number } } };
        _isPaused?: boolean;
        _pausedResizeTask?: { flush?: () => void };
        refreshRows?: (start: number, end: number) => void;
        _rowCount?: number;
      };
    };
  })._core;
  const render = core?._renderService;
  const host = term.element?.parentElement;
  if (render?._isPaused && host && host.clientWidth >= 8 && host.clientHeight >= 8) {
    render._pausedResizeTask?.flush?.();
    render._isPaused = false;
    const rows = render._rowCount ?? term.rows;
    if (rows > 0) render.refreshRows?.(0, rows - 1);
  }
  core?._charSizeService?.measure?.();
  const cell = render?.dimensions?.css?.cell;
  if (!cell || cell.width < 1 || cell.height < 1) return null;
  return { w: cell.width, h: cell.height };
}
