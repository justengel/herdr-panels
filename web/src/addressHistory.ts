import { expandDisplayPath, guessHome } from "./displayPath";
import { pathKey } from "./paths";

export interface AddressHistory {
  entries: string[];
  index: number;
}

/**
 * A bar submission and the address it becomes are one step.
 * `example.com` and `https://example.com/`, or `~/notes` and the home path, are that step.
 * A different page is not.
 */
export function continuesVisit(submitted: string, landed: string): boolean {
  const from = visitKey(submitted, landed);
  const to = visitKey(landed, submitted);
  return from !== "" && from === to;
}

function visitKey(value: string, other: string): string {
  const home = guessHome(other) || guessHome(value);
  const expanded = expandDisplayPath(value.trim(), home);
  if (!expanded) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(expanded) || looksLikeWeb(expanded)) {
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(expanded) ? expanded : `https://${expanded}`;
    try {
      const url = new URL(withScheme);
      if (url.protocol !== "http:" && url.protocol !== "https:") return pathKey(expanded);
      const path = url.pathname.replace(/\/+$/, "");
      return `${url.protocol}//${url.host}${path}${url.search}${url.hash}`;
    } catch {
      return pathKey(expanded);
    }
  }
  return pathKey(expanded);
}

function looksLikeWeb(value: string): boolean {
  if (value.startsWith("/") || value.startsWith("~") || /^[a-z]:[\\/]/i.test(value)) return false;
  return /^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(value);
}

/** History for a panel or tab that is showing again. A new address is one more step. */
export function historyForSurface(saved: AddressHistory | undefined, value: string): AddressHistory {
  if (!saved || saved.entries.length === 0) return { entries: value ? [value] : [], index: 0 };
  return noteAddress(saved, value, false);
}

/** Record an address submitted from the bar and drop anything after the current step. */
export function visitAddress(history: AddressHistory, next: string): AddressHistory {
  const trimmed = next.trim();
  if (!trimmed) return history;
  const kept = history.entries.slice(0, history.index + 1);
  if (kept[kept.length - 1] !== trimmed) kept.push(trimmed);
  return { entries: kept, index: kept.length - 1 };
}

/**
 * Record an address that arrived after navigation.
 * A bar submission rewrites the step it just created when the address is canonicalized.
 * Any other change pushes a step so Back can return to the previous address.
 */
export function noteAddress(history: AddressHistory, value: string, fromBar: boolean): AddressHistory {
  if (!value) return history;
  if (history.entries[history.index] === value) return history;
  if (
    fromBar &&
    history.index >= 0 &&
    history.index < history.entries.length &&
    continuesVisit(history.entries[history.index] ?? "", value)
  ) {
    const entries = history.entries.slice();
    entries[history.index] = value;
    return { entries, index: history.index };
  }
  const kept = history.entries.slice(0, Math.max(history.index, -1) + 1);
  kept.push(value);
  return { entries: kept, index: kept.length - 1 };
}
