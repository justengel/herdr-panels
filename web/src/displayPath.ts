import { isWindowsPath, plainPath } from "./paths";

function normalizeSlashes(path: string): string {
  return plainPath(path).replace(/\\/g, "/");
}

/** Infer a home prefix from a path when the host does not publish one. */
export function guessHome(path: string): string {
  const plain = normalizeSlashes(path);
  const win = plain.match(/^([A-Za-z]:\/Users\/[^/]+)/i);
  if (win) return win[1];
  const unix = plain.match(/^(\/Users\/[^/]+)/) || plain.match(/^(\/home\/[^/]+)/);
  if (unix) return unix[1];
  return "";
}

function homeKey(home: string): string {
  const normalized = normalizeSlashes(home).replace(/\/+$/, "");
  return isWindowsPath(home) ? normalized.toLowerCase() : normalized;
}

/** Collapse `$home` to `~` for the address bar. Outside home, keep an absolute display path. */
export function displayPath(path: string, home: string): string {
  const plain = normalizeSlashes(path);
  if (!plain) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(plain) && !isWindowsPath(path)) return plain;
  const root = homeKey(home);
  if (!root) return plain;
  const key = isWindowsPath(path) ? plain.toLowerCase() : plain;
  if (key === root) return "~";
  if (key.startsWith(`${root}/`)) {
    const shown = plain.slice(root.length).replace(/^\//, "");
    return shown ? `~/${shown}` : "~";
  }
  return plain;
}

/** Expand a leading `~` to `home` for submit / focus. */
export function expandDisplayPath(path: string, home: string): string {
  const trimmed = path.trim();
  if (!trimmed) return trimmed;
  if (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    const rest = trimmed.slice(1).replace(/^[\\/]/, "");
    const base = plainPath(home).replace(/[\\/]+$/, "");
    if (!rest) return base;
    const sep = isWindowsPath(home) ? "\\" : "/";
    return `${base}${sep}${rest.replace(/\//g, sep)}`;
  }
  return trimmed;
}

/** Largest character budget whose middle-ellipsis still fits `maxWidth`. */
export function charsThatFit(text: string, maxWidth: number, measure: (sample: string) => number): number {
  if (!text) return 0;
  if (measure(text) <= maxWidth) return text.length;
  let lo = Math.min(8, text.length);
  let hi = text.length;
  let best = lo;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (measure(middleEllipsis(text, mid)) <= maxWidth) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** Shorten a display path/URL by dropping middle segments; keep the start and leaf. */
export function middleEllipsis(path: string, maxChars: number): string {
  if (!path || path.length <= maxChars || maxChars < 8) return path;
  const { sep, parts } = splitDisplay(path);
  if (parts.length <= 2) {
    const keep = Math.max(1, maxChars - 1);
    return `${path.slice(0, keep)}…`;
  }
  const leaf = parts[parts.length - 1] ?? "";
  let head = parts[0] ?? "";
  for (let index = 1; index < parts.length - 1; index += 1) {
    const next = `${head}${sep}${parts[index]}`;
    const shown = `${next}${sep}…${sep}${leaf}`;
    if (shown.length > maxChars) break;
    head = next;
  }
  const shown = `${head}${sep}…${sep}${leaf}`;
  if (shown.length <= maxChars) return shown;
  const budget = maxChars - leaf.length - 2;
  if (budget <= 1) {
    const kept = Math.max(1, maxChars - 1);
    return `…${leaf.slice(-kept)}`;
  }
  return `${head.slice(0, budget)}…${sep}${leaf}`;
}

/** Unshortened address for focus and copy. A home path stays `~`, the same form as the idle field. */
export function focusedAddress(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return displayPath(trimmed, guessHome(trimmed)) || trimmed;
}

/**
 * Select-all in an address field that the user has not edited copies the home shortcut, not the fitted ellipsis.
 * A partial selection copies only that selection.
 */
export function addressToCopy(
  stored: string,
  field: string,
  edited: boolean,
  entireFieldSelected: boolean,
): string {
  if (!entireFieldSelected || edited) return field;
  return focusedAddress(stored) || field;
}

function splitDisplay(path: string): { sep: string; parts: string[] } {
  const url = path.match(/^([a-z][a-z0-9+.-]*:\/\/[^/]+)(\/.*)?$/i);
  if (url) {
    const rest = (url[2] || "").split("/").filter(Boolean);
    return { sep: "/", parts: [url[1], ...rest] };
  }
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  return { sep, parts: path.split(sep).filter((part, index) => part.length > 0 || index === 0) };
}
