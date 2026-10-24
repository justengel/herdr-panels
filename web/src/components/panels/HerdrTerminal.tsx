import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { api, wsUrl } from "../../api";
import { useHost } from "../../host";

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
  const seenRef = useRef(false);
  const goneRef = useRef(false);
  const goneHandler = useRef(onGone);
  goneHandler.current = onGone;
  const [status, setStatus] = useState("Connecting");

  useEffect(() => {
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
      const next = fitCells(host.clientWidth, host.clientHeight, cell.w, cell.h);
      if (!next) return;
      if (current.cols !== next.cols || current.rows !== next.rows) current.resize(next.cols, next.rows);
      wanted = next;
      window.clearTimeout(sizeTimer);
      sizeTimer = window.setTimeout(flushSize, 80);
    };

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
          const cols = frame.cols ?? 0;
          const rows = frame.rows ?? 0;
          if (frame.full) term.reset();
          if (cols > 1 && rows > 0 && (term.cols !== cols || term.rows !== rows)) term.resize(cols, rows);
          if (frame.text) term.write(frame.text);
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
      window.clearTimeout(flushTimer.current);
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
    >
      <div className="term-stage" ref={stageRef} />
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
