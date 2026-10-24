import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import type { PanelConfig } from "../types";

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

export function addressOf(panel: PanelConfig): string {
  switch (panel.type) {
    case "markdown":
    case "file":
    case "explorer":
      return panel.path;
    case "html":
      return panel.path ?? "";
    case "iframe":
      return panel.url;
    case "plugin":
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
}: {
  value: string;
  historyKey: string;
  onNavigate: (next: string) => void;
  onReload?: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [history, setHistory] = useState<string[]>(value ? [value] : []);
  const [index, setIndex] = useState(0);
  const indexRef = useRef(0);
  const keyRef = useRef(historyKey);
  const inputRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef(value);
  const caretRef = useRef<number | null>(null);
  const undoRef = useRef<string[]>([]);
  const redoRef = useRef<string[]>([]);
  const undoAt = useRef(0);

  useEffect(() => {
    if (keyRef.current !== historyKey) {
      keyRef.current = historyKey;
      indexRef.current = 0;
      setIndex(0);
      setHistory(value ? [value] : []);
      replaceDraft(value, true);
      return;
    }
    replaceDraft(value, true);
    setHistory((current) => {
      if (current[indexRef.current] === value) return current;
      const next = current.slice();
      if (next.length === 0) return value ? [value] : [];
      next[indexRef.current] = value;
      return next;
    });
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
    if (event.altKey || event.nativeEvent.isComposing || event.repeat) return;
    const input = event.currentTarget;
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
      input.select();
      return;
    }
    if (key === "c") {
      if (!selectedText(input).text) return;
      event.preventDefault();
      event.stopPropagation();
      copySelection(input);
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

  function go(nextIndex: number, nextHistory = history) {
    const next = nextHistory[nextIndex];
    if (next === undefined) return;
    indexRef.current = nextIndex;
    setIndex(nextIndex);
    replaceDraft(next, true);
    onNavigate(next);
  }

  return (
    <form
      className="location-bar"
      onSubmit={(event) => {
        event.preventDefault();
        const next = draft.trim();
        if (!next) return;
        const kept = history.slice(0, index + 1);
        if (kept[kept.length - 1] !== next) kept.push(next);
        setHistory(kept);
        go(kept.length - 1, kept);
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
        onKeyDown={onAddressKey}
        onChange={(event) => edit(event.target.value, event.target.selectionStart ?? event.target.value.length, true)}
      />
    </form>
  );
}

export function DocumentFrame({
  historyKey,
  address,
  onOpen,
  children,
}: {
  historyKey: string;
  address: string;
  onOpen: (panel: PanelConfig) => void;
  children: ReactNode;
}) {
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => setError(null), [address]);

  return (
    <div className="document">
      <LocationBar
        historyKey={historyKey}
        value={address}
        onNavigate={async (next) => {
          try {
            const panel = await api.resolve(next);
            setError(null);
            onOpen(panel);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not open that address");
          }
        }}
        onReload={() => {
          setError(null);
          setGeneration((current) => current + 1);
        }}
      />
      <div className="document-body" key={generation}>
        {error ? <div className="empty">{error}</div> : children}
      </div>
    </div>
  );
}
