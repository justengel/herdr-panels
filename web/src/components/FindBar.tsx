import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { desktopHost } from "../desktopBrowser";
import { applyFind, classifyPanel, ourFrame, panelBody, REMOTE_FIND_NOTE, searchRoot, visibleSection } from "../findDom";
import { findChord, wrappedIndex } from "../findText";
import { terminalFind } from "../terminalFind";

interface Session {
  panelId: string;
  query: string;
  matchCase: boolean;
  index: number;
  count: number;
  note: string;
}

interface FindDetail {
  label?: string;
  op?: string;
  token?: number;
  count?: number;
  index?: number;
}

export function FindController({ focusedId }: { focusedId: string | null }) {
  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const focusedRef = useRef(focusedId);
  focusedRef.current = focusedId;
  const remembered = useRef({ query: "", matchCase: false });
  const token = useRef(0);
  const focusPending = useRef(false);
  const activeClear = useRef<{ panelId: string; clear: () => void } | null>(null);

  const open = useCallback((panelId: string) => {
    focusPending.current = true;
    setSession({
      panelId,
      query: remembered.current.query,
      matchCase: remembered.current.matchCase,
      index: 0,
      count: 0,
      note: "",
    });
  }, []);

  const step = useCallback((panelId: string, delta: number) => {
    setSession((current) => {
      if (!current || current.panelId !== panelId) {
        focusPending.current = true;
        return {
          panelId,
          query: remembered.current.query,
          matchCase: remembered.current.matchCase,
          index: delta < 0 ? -1 : 0,
          count: 0,
          note: "",
        };
      }
      if (!current.query) {
        focusPending.current = true;
        return current;
      }
      return { ...current, index: wrappedIndex(current.count, current.index, delta), note: "" };
    });
  }, []);

  const close = useCallback(() => {
    const id = sessionRef.current?.panelId;
    setSession(null);
    if (!id) return;
    const focus = (window as Window & { __hwpFocusPanel?: (panelId: string) => void }).__hwpFocusPanel;
    focus?.(id);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (document.querySelector(".dialog-backdrop, .key-capture-backdrop, .settings-backdrop")) return;
      if (event.key === "Escape" && sessionRef.current) {
        if (document.querySelector(".panel-menu, [data-visit-add]")) return;
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      const chord = findChord(event);
      if (!chord) return;
      if (chord === "open" && event.target instanceof HTMLInputElement && event.target.classList.contains("find-input")) {
        event.preventDefault();
        event.stopPropagation();
        event.target.select();
        return;
      }
      const panelId = panelFromTarget(event.target) ?? focusedRef.current;
      if (!panelId) return;
      event.preventDefault();
      event.stopPropagation();
      if (chord === "open" && event.repeat) return;
      if (chord === "open") open(panelId);
      else step(panelId, chord === "next" ? 1 : -1);
    };
    const onFrame = (event: MessageEvent) => {
      const data = event.data as { source?: string; type?: string; op?: string; token?: number; count?: number; index?: number } | null;
      if (!data || data.source !== "hwp-find") return;
      const frame = [...document.querySelectorAll("iframe")].find(
        (item) => item instanceof HTMLIFrameElement && item.contentWindow === event.source,
      );
      if (!(frame instanceof HTMLIFrameElement)) return;
      const panelId = frame.closest("[data-panel-id]")?.getAttribute("data-panel-id");
      if (!panelId) return;
      if (data.type === "key") {
        if (data.op === "open") open(panelId);
        else if (data.op === "next") step(panelId, 1);
        else if (data.op === "prev") step(panelId, -1);
        return;
      }
      if (data.type !== "result" || data.token !== token.current) return;
      rememberCount(panelId, Number(data.count) || 0, numberOr(data.index, -1));
    };
    const onBrowser = (event: Event) => {
      const detail = (event as CustomEvent<FindDetail>).detail;
      if (!detail?.label || !detail.op) return;
      const hole = document.querySelector(`[data-browser-label="${CSS.escape(detail.label)}"]`);
      const panelId = hole?.closest("[data-panel-id]")?.getAttribute("data-panel-id");
      if (!panelId) return;
      if (detail.op === "open") open(panelId);
      else if (detail.op === "next") step(panelId, 1);
      else if (detail.op === "prev") step(panelId, -1);
    };
    const onCount = (event: Event) => {
      const detail = (event as CustomEvent<FindDetail>).detail;
      if (!detail || detail.token !== token.current) return;
      const panelId = sessionRef.current?.panelId;
      if (!panelId) return;
      rememberCount(panelId, Number(detail.count) || 0, numberOr(detail.index, -1));
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("message", onFrame);
    window.addEventListener("herdr-find", onBrowser);
    window.addEventListener("herdr-find-count", onCount);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("message", onFrame);
      window.removeEventListener("herdr-find", onBrowser);
      window.removeEventListener("herdr-find-count", onCount);
    };
  }, [close, open, step]);

  function rememberCount(panelId: string, count: number, index: number) {
    setSession((current) => {
      if (!current || current.panelId !== panelId) return current;
      if (current.count === count && current.index === index && current.note === "") return current;
      return { ...current, count, index, note: "" };
    });
  }

  useEffect(() => {
    if (!session || !focusPending.current) return;
    focusPending.current = false;
    const input = document.querySelector<HTMLInputElement>(".find-bar .find-input");
    input?.focus();
    input?.select();
  }, [session]);

  useEffect(() => {
    if (!session) {
      activeClear.current?.clear();
      activeClear.current = null;
      return;
    }
    const section = visibleSection(session.panelId);
    if (!section) return;
    const root = searchRoot(section);
    const kind = classifyPanel(root);
    let stopped = false;
    let observer: MutationObserver | null = null;
    const clear = () => clearFind(kind, root);
    if (activeClear.current && activeClear.current.panelId !== session.panelId) activeClear.current.clear();
    activeClear.current = { panelId: session.panelId, clear };
    const run = () => {
      if (stopped) return;
      observer?.disconnect();
      if (kind === "remote") {
        setSession((current) =>
          current && current.panelId === session.panelId && current.note !== REMOTE_FIND_NOTE
            ? { ...current, count: 0, index: -1, note: REMOTE_FIND_NOTE }
            : current,
        );
        return;
      }
      if (kind === "browser") {
        const label = root.querySelector("[data-browser-label]")?.getAttribute("data-browser-label") || "";
        if (!label) return;
        token.current += 1;
        const mine = token.current;
        void desktopHost()
          ?.invoke("find_browser", {
            label,
            query: session.query,
            index: session.index,
            matchCase: session.matchCase,
            token: mine,
          })
          .catch((err: unknown) => {
            if (stopped || token.current !== mine) return;
            const note = err instanceof Error ? err.message : "This page could not be searched";
            setSession((current) => (current && current.panelId === session.panelId ? { ...current, note } : current));
          });
        return;
      }
      if (kind === "frame") {
        const frame = ourFrame(root);
        if (!frame) return;
        token.current += 1;
        const mine = token.current;
        frame.contentWindow?.postMessage(
          { source: "hwp-host", type: "find", query: session.query, index: session.index, matchCase: session.matchCase, token: mine },
          "*",
        );
        return;
      }
      if (kind === "terminal") {
        const shell = root.querySelector(".term-shell");
        const finder = shell instanceof HTMLElement ? terminalFind(shell) : null;
        if (!finder) return;
        const hits = finder.search(session.query, session.matchCase);
        const index = session.query ? wrappedIndex(hits.length, session.index, session.index < 0 ? -1 : 0) : -1;
        if (index >= 0) finder.show(hits[index]);
        else finder.clear();
        setSession((current) => {
          if (!current || current.panelId !== session.panelId) return current;
          if (current.count === hits.length && current.index === index && current.note === "") return current;
          return { ...current, count: hits.length, index, note: "" };
        });
        return;
      }
      const result = applyFind(root, session.query, session.index, session.matchCase);
      setSession((current) => {
        if (!current || current.panelId !== session.panelId) return current;
        if (current.count === result.count && current.index === result.index && current.note === "") return current;
        return { ...current, count: result.count, index: result.index, note: "" };
      });
      if (kind === "text") {
        observer ??= new MutationObserver(() => run());
        observer.observe(root, { subtree: true, childList: true, characterData: true });
      }
    };
    run();
    return () => {
      stopped = true;
      observer?.disconnect();
    };
  }, [session?.panelId, session?.query, session?.index, session?.matchCase]);

  useEffect(() => () => activeClear.current?.clear(), []);

  if (!session) return null;
  const section = visibleSection(session.panelId);
  const body = section ? panelBody(section) : null;
  if (!(body instanceof HTMLElement)) return null;
  const label = countLabel(session);
  return createPortal(
    <div className="find-bar" role="search">
      <input
        className="find-input"
        aria-label="Find"
        placeholder="Find"
        value={session.query}
        onChange={(event) => {
          const query = event.target.value;
          remembered.current.query = query;
          setSession((current) => (current ? { ...current, query, index: 0, note: "" } : current));
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            step(session.panelId, event.shiftKey ? -1 : 1);
          }
        }}
      />
      <button
        type="button"
        aria-label="Match case"
        aria-pressed={session.matchCase}
        title="Match case"
        onClick={() => {
          const matchCase = !session.matchCase;
          remembered.current.matchCase = matchCase;
          setSession((current) => (current ? { ...current, matchCase, index: 0, note: "" } : current));
        }}
      >
        Aa
      </button>
      <span className="find-count">{label}</span>
      <button type="button" aria-label="Previous match" title="Previous match (Shift+F3)" onClick={() => step(session.panelId, -1)}>
        ↑
      </button>
      <button type="button" aria-label="Next match" title="Next match (F3)" onClick={() => step(session.panelId, 1)}>
        ↓
      </button>
      <button type="button" aria-label="Close find" title="Close (Escape)" onClick={close}>
        ×
      </button>
    </div>,
    body,
  );
}

function panelFromTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest("[data-panel-id]")?.getAttribute("data-panel-id") ?? null;
}

function numberOr(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function countLabel(session: Session): string {
  if (session.note) return session.note;
  if (!session.query) return "";
  if (session.count <= 0 || session.index < 0) return "No matches";
  return `${session.index + 1} of ${session.count}`;
}

function clearFind(kind: ReturnType<typeof classifyPanel>, root: HTMLElement) {
  if (kind === "text") applyFind(root, "", 0, false);
  if (kind === "terminal") {
    const shell = root.querySelector(".term-shell");
    if (shell instanceof HTMLElement) terminalFind(shell)?.clear();
  }
  if (kind === "frame") {
    ourFrame(root)?.contentWindow?.postMessage(
      { source: "hwp-host", type: "find", query: "", index: 0, matchCase: false, token: 0 },
      "*",
    );
  }
  if (kind === "browser") {
    const label = root.querySelector("[data-browser-label]")?.getAttribute("data-browser-label");
    if (!label) return;
    void desktopHost()
      ?.invoke("find_browser", { label, query: "", index: 0, matchCase: false, token: 0 })
      .catch(() => undefined);
  }
}
