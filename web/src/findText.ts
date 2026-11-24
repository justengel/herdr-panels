export interface FindPress {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export type FindChord = "open" | "next" | "prev";

export interface TextSpan {
  start: number;
  end: number;
}

export interface TermHit {
  line: number;
  column: number;
  length: number;
}

/** Ctrl+F or Cmd+F opens find. F3 and Shift+F3 move through matches. */
export function findChord(event: FindPress): FindChord | null {
  if (event.altKey) return null;
  const command = event.ctrlKey || event.metaKey;
  if (command && !event.shiftKey && (event.key === "f" || event.key === "F")) return "open";
  if (!command && event.key === "F3") return event.shiftKey ? "prev" : "next";
  return null;
}

export function textMatches(text: string, query: string, matchCase: boolean): TextSpan[] {
  if (!query) return [];
  let pattern: RegExp;
  try {
    pattern = new RegExp(escapeRegExp(query), matchCase ? "gu" : "giu");
  } catch {
    return [];
  }
  const found: TextSpan[] = [];
  for (const match of text.matchAll(pattern)) {
    if (!match[0]) break;
    const start = match.index ?? 0;
    found.push({ start, end: start + match[0].length });
  }
  return found;
}

/** `index` of -1 means find has not chosen a match yet. */
export function wrappedIndex(count: number, index: number, delta: number): number {
  if (count <= 0) return -1;
  if (index < 0) return delta < 0 ? count - 1 : 0;
  return ((index + delta) % count + count) % count;
}

export function terminalHits(lines: readonly string[], query: string, matchCase: boolean): TermHit[] {
  const hits: TermHit[] = [];
  for (let line = 0; line < lines.length; line += 1) {
    for (const match of textMatches(lines[line] ?? "", query, matchCase)) {
      hits.push({ line, column: match.start, length: match.end - match.start });
    }
  }
  return hits;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
