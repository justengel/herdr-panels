import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { noteAddress, visitAddress, type AddressHistory } from "../addressHistory";
import {
  addressToCopy,
  charsThatFit,
  displayPath,
  expandDisplayPath,
  focusedAddress,
  guessHome,
  middleEllipsis,
} from "../displayPath";
import type { PanelConfig } from "../types";

let textContext: CanvasRenderingContext2D | null | undefined;

function textMeasurer(): CanvasRenderingContext2D | null {
  if (textContext !== undefined) return textContext;
  textContext = document.createElement("canvas").getContext("2d");
  return textContext;
}

function shownAddress(path: string, maxChars: number | null): string {
  const shown = displayPath(path, guessHome(path));
  if (maxChars == null || maxChars >= shown.length) return shown;
  return middleEllipsis(shown, maxChars);
}

function realAddress(path: string, hint = ""): string {
  return expandDisplayPath(path, guessHome(hint) || guessHome(path));
}

let fieldClipboard = "";
let ownClipboard = false;

function writeClipboard(text: string) {
  fieldClipboard = text;
  ownClipboard = true;
  if (!navigator.clipboard?.writeText) return;
  void navigator.clipboard.writeText(text).catch(() => undefined);
}

async function readClipboard(): Promise<string> {
  if (ownClipboard) return fieldClipboard;
  try {
    const text = await navigator.clipboard?.readText();
    if (text) return text;
  } catch {
    // A blocked clipboard still pastes the last cut or copy from an address bar.
  }
  return fieldClipboard;
}

if (typeof window !== "undefined") {
  window.addEventListener("blur", () => {
    ownClipboard = false;
  });
  document.addEventListener("copy", () => {
    ownClipboard = false;
  });
  window.addEventListener(
    "keydown",
    (event) => {
      const key = event.key.toLowerCase();
      if (!(event.ctrlKey || event.metaKey) || (key !== "c" && key !== "x")) return;
      const target = event.target;
      if (target instanceof Element && target.closest("input[aria-label='Address']")) return;
      ownClipboard = false;
    },
    true,
  );
}

function spliceText(value: string, start: number, end: number, insert: string): { value: string; caret: number } {
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  return { value: value.slice(0, from) + insert + value.slice(to), caret: from + insert.length };
}

/** Backspace or Delete with a highlight removes that stretch and leaves the caret where it started. */
export function removeSelectedText(value: string, start: number, end: number): { value: string; caret: number } {
  return spliceText(value, start, end, "");
}

export function addressOf(panel: PanelConfig): string {
  switch (panel.type) {
    case "markdown":
    case "file":
      return panel.path;
    case "explorer":
      return panel.focus || panel.path;
    case "html":
      return panel.path ?? "";
    case "iframe":
      return panel.url;
    case "plugin":
      if (panel.url) return panel.url;
      if (panel.path) return panel.path;
      return panel.plugin ? `plugin:${panel.plugin}` : "";
    default:
      return "";
  }
}

export function LocationBar({
  value,
  historyKey,
  onNavigate,
  onReload,
  visible = true,
  canUp = false,
  onUp,
}: {
  value: string;
  historyKey: string;
  onNavigate: (next: string) => void | Promise<unknown>;
  onReload?: () => void;
  visible?: boolean;
  canUp?: boolean;
  onUp?: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [history, setHistory] = useState<string[]>(value ? [value] : []);
  const [index, setIndex] = useState(0);
  const indexRef = useRef(0);
  const historyRef = useRef(history);
  const pendingVisit = useRef<string | null>(null);
  const ready = useRef(false);
  const keyRef = useRef(historyKey);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef(value);
  const caretRef = useRef<number | null>(null);
  const undoRef = useRef<string[]>([]);
  const redoRef = useRef<string[]>([]);
  const undoAt = useRef(0);
  const fitRef = useRef<number | null>(null);
  const fitted = (path: string) => shownAddress(path, fitRef.current);
  const draftFor = (path: string) => {
    const input = inputRef.current;
    if (input && document.activeElement === input) return displayPath(path, guessHome(path));
    return fitted(path);
  };

  function commitHistory(next: AddressHistory) {
    historyRef.current = next.entries;
    indexRef.current = next.index;
    setHistory(next.entries);
    setIndex(next.index);
  }

  useEffect(() => {
    if (keyRef.current !== historyKey) {
      keyRef.current = historyKey;
      pendingVisit.current = null;
      ready.current = true;
      commitHistory({ entries: value ? [value] : [], index: 0 });
      replaceDraft(draftFor(value), true);
      return;
    }
    if (!ready.current) {
      ready.current = true;
      if (pendingVisit.current !== null || historyRef.current[indexRef.current] === value) return;
    }
    const fromBar = pendingVisit.current !== null;
    pendingVisit.current = null;
    commitHistory(noteAddress({ entries: historyRef.current, index: indexRef.current }, value, fromBar));
    replaceDraft(draftFor(value), true);
  }, [historyKey, value]);

  useLayoutEffect(() => {
    draftRef.current = draft;
    const input = inputRef.current;
    const pos = caretRef.current;
    if (!input || pos === null || document.activeElement !== input) {
      caretRef.current = null;
      return;
    }
    caretRef.current = null;
    input.setSelectionRange(pos, pos);
  }, [draft]);

  function replaceDraft(next: string, resetHistory: boolean) {
    caretRef.current = null;
    draftRef.current = next;
    if (resetHistory) {
      undoRef.current = [];
      redoRef.current = [];
      undoAt.current = 0;
    }
    setDraft(next);
  }

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const apply = () => {
      const style = getComputedStyle(input);
      const pad = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
      const available = input.clientWidth - pad;
      if (available <= 8) return;
      const ctx = textMeasurer();
      if (!ctx) return;
      ctx.font = style.font;
      const full = displayPath(value, guessHome(value));
      const fit = charsThatFit(full, available, (sample) => ctx.measureText(sample).width);
      fitRef.current = fit;
      if (document.activeElement === input) return;
      const next = shownAddress(value, fit);
      if (draftRef.current === next) return;
      replaceDraft(next, false);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(input);
    input.addEventListener("blur", apply);
    return () => {
      observer.disconnect();
      input.removeEventListener("blur", apply);
    };
  }, [value]);

  function edit(next: string, caret: number, coalesce: boolean) {
    const current = draftRef.current;
    if (next === current) {
      caretRef.current = caret;
      inputRef.current?.setSelectionRange(caret, caret);
      return;
    }
    const now = Date.now();
    if (!(coalesce && now - undoAt.current < 600 && undoRef.current.length > 0)) {
      undoRef.current.push(current);
      if (undoRef.current.length > 200) undoRef.current.shift();
    }
    undoAt.current = coalesce ? now : 0;
    redoRef.current = [];
    caretRef.current = caret;
    draftRef.current = next;
    setDraft(next);
  }

  function undo() {
    const previous = undoRef.current.pop();
    if (previous === undefined) return;
    redoRef.current.push(draftRef.current);
    caretRef.current = previous.length;
    draftRef.current = previous;
    setDraft(previous);
  }

  function redo() {
    const next = redoRef.current.pop();
    if (next === undefined) return;
    undoRef.current.push(draftRef.current);
    caretRef.current = next.length;
    draftRef.current = next;
    setDraft(next);
  }

  function selectedText(input: HTMLInputElement): { text: string; start: number; end: number } {
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? 0;
    return { text: input.value.slice(Math.min(start, end), Math.max(start, end)), start, end };
  }

  function copySelection(input: HTMLInputElement): string {
    const { text } = selectedText(input);
    if (!text) return "";
    try {
      document.execCommand("copy");
    } catch {
      // writeText covers browsers that refuse the older copy command.
    }
    writeClipboard(text);
    return text;
  }

  function cutSelection(input: HTMLInputElement) {
    const { text, start, end } = selectedText(input);
    if (!text) return;
    try {
      document.execCommand("copy");
    } catch {
      // The field clipboard still receives the cut text.
    }
    writeClipboard(text);
    const next = spliceText(input.value, start, end, "");
    edit(next.value, next.caret, false);
  }

  function pasteText(start: number, end: number, text: string) {
    if (!text) return;
    const next = spliceText(draftRef.current, start, end, text);
    edit(next.value, next.caret, false);
  }

  function onAddressKey(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.altKey || event.nativeEvent.isComposing) return;
    const input = event.currentTarget;
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? 0;
    if (start !== end && (event.key === "Backspace" || event.key === "Delete") && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      const next = removeSelectedText(input.value, start, end);
      edit(next.value, next.caret, true);
      return;
    }
    if (event.repeat) return;
    const command = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (command && event.key === "Insert") {
      event.preventDefault();
      event.stopPropagation();
      copySelection(input);
      return;
    }
    if (!command && event.shiftKey && event.key === "Insert") {
      event.preventDefault();
      event.stopPropagation();
      const start = input.selectionStart ?? 0;
      const end = input.selectionEnd ?? 0;
      void readClipboard().then((text) => pasteText(start, end, text));
      return;
    }
    if (!command && event.shiftKey && event.key === "Delete") {
      event.preventDefault();
      event.stopPropagation();
      cutSelection(input);
      return;
    }
    if (!command) return;
    if (event.shiftKey && key !== "z") return;
    if (key === "a") {
      event.preventDefault();
      event.stopPropagation();
      const full = addressToCopy(value, input.value, undoRef.current.length > 0, true);
      if (full !== input.value) {
        input.value = full;
        replaceDraft(full, false);
      }
      input.select();
      return;
    }
    if (key === "c") {
      const selected = selectedText(input);
      if (!selected.text) return;
      event.preventDefault();
      event.stopPropagation();
      const entire = selected.start === 0 && selected.end === input.value.length;
      const text = addressToCopy(value, selected.text, undoRef.current.length > 0, entire);
      if (text !== selected.text) {
        input.value = text;
        replaceDraft(text, false);
        input.select();
      }
      try {
        document.execCommand("copy");
      } catch {
        // writeText covers browsers that refuse the older copy command.
      }
      writeClipboard(text);
      return;
    }
    if (key === "x") {
      if (!selectedText(input).text) return;
      event.preventDefault();
      event.stopPropagation();
      cutSelection(input);
      return;
    }
    if (key === "v") {
      event.preventDefault();
      event.stopPropagation();
      const start = input.selectionStart ?? 0;
      const end = input.selectionEnd ?? 0;
      void readClipboard().then((text) => pasteText(start, end, text));
      return;
    }
    if (key === "z") {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (key === "y" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      redo();
    }
  }

  function go(nextIndex: number, nextHistory = historyRef.current) {
    const next = nextHistory[nextIndex];
    if (next === undefined) return;
    commitHistory({ entries: nextHistory, index: nextIndex });
    replaceDraft(fitted(next), true);
    pendingVisit.current = next;
    void (async () => {
      try {
        await onNavigate(next);
        window.setTimeout(() => {
          if (pendingVisit.current === next) pendingVisit.current = null;
        }, 0);
      } catch {
        pendingVisit.current = null;
      }
    })();
  }

  function openAddress(next: string) {
    const address = next.trim();
    if (!address) return;
    const visited = visitAddress({ entries: historyRef.current, index: indexRef.current }, address);
    go(visited.index, visited.entries);
  }

  return (
    <form
      className="location-bar"
      hidden={!visible}
      onSubmit={(event) => {
        event.preventDefault();
        openAddress(realAddress(draft.trim(), value));
      }}
    >
      <button type="button" aria-label="Back" disabled={index <= 0} onClick={() => go(index - 1)}>
        ‹
      </button>
      <button
        type="button"
        aria-label="Forward"
        disabled={index >= history.length - 1}
        onClick={() => go(index + 1)}
      >
        ›
      </button>
      {onUp ? (
        <button type="button" aria-label="Up" disabled={!canUp} onClick={onUp}>
          ↑
        </button>
      ) : null}
      <button type="button" aria-label="Reload" onClick={onReload}>
        ↻
      </button>
      <input
        ref={inputRef}
        aria-label="Address"
        value={draft}
        placeholder="URL, file, or plugin"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onFocus={() => replaceDraft(focusedAddress(value) || value, false)}
        onBlur={() => replaceDraft(fitted(value), false)}
        onKeyDown={onAddressKey}
        onChange={(event) => edit(event.target.value, event.target.selectionStart ?? event.target.value.length, true)}
      />
      <button
        type="button"
        aria-label="Browse"
        title="Browse for a file"
        onClick={() => {
          const hint = browseHint(realAddress(value) || value);
          void api.pickFile(hint).then(
            (path) => {
              if (path) openAddress(path);
            },
            () => {
              // Older servers: fall back to the HTML picker, starting near the address when possible.
              const input = fileRef.current;
              if (!input) return;
              if (hint) input.setAttribute("nwworkingdir", hint);
              else input.removeAttribute("nwworkingdir");
              input.click();
            },
          );
        }}
      >
        <BrowseFolderIcon />
      </button>
      <input
        ref={fileRef}
        type="file"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          // Desktop shells expose an absolute path; browsers only give the basename.
          const path = (file as File & { path?: string }).path || file.name;
          openAddress(path);
        }}
      />
    </form>
  );
}

/** Filesystem path to open the picker near; null for URLs / plugins. */
export function browseHint(address: string): string | null {
  const trimmed = address.trim();
  if (!trimmed) return null;
  if (/^(https?|plugin|file):/i.test(trimmed)) return null;
  return trimmed;
}

function BrowseFolderIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        fill="currentColor"
        d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2l1.3 1.5H13A1.5 1.5 0 0 1 14.5 5v7.5A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5v-9Z"
      />
    </svg>
  );
}

export function DocumentFrame({
  historyKey,
  address,
  onOpen,
  children,
  visible = true,
  canUp = false,
  onUp,
  onPluginNavigate,
  onPluginReload,
}: {
  historyKey: string;
  address: string;
  onOpen: (panel: PanelConfig) => void;
  children: ReactNode;
  visible?: boolean;
  canUp?: boolean;
  onUp?: () => void;
  onPluginNavigate?: (value: string) => void;
  onPluginReload?: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => setError(null), [address]);

  return (
    <div className="document">
      <LocationBar
        historyKey={historyKey}
        value={address}
        visible={visible}
        canUp={canUp}
        onUp={onUp}
        onNavigate={async (next) => {
          if (onPluginNavigate) {
            setError(null);
            onPluginNavigate(next);
            return;
          }
          try {
            const panel = await api.resolve(next);
            setError(null);
            onOpen(panel);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not open that address");
            throw err;
          }
        }}
        onReload={() => {
          setError(null);
          if (onPluginReload) onPluginReload();
          else setGeneration((current) => current + 1);
        }}
      />
      <div className="document-body" key={generation}>
        {error ? <div className="empty">{error}</div> : children}
      </div>
    </div>
  );
}
