const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/;

export function plainPath(path: string): string {
  return path.startsWith("\\\\?\\") ? path.slice(4) : path;
}

export function isWindowsPath(path: string): boolean {
  return WINDOWS_PATH.test(plainPath(path));
}

/** A Linux absolute path. `//host` stays a protocol-relative URL. */
export function isPosixAbsolute(path: string): boolean {
  const plain = plainPath(path);
  return plain.startsWith("/") && !plain.startsWith("//");
}

/** A filesystem address, including a Linux absolute path typed on Windows. */
export function isFilesystemAddress(address: string): boolean {
  const value = address.trim();
  if (!value || value.includes("://")) return false;
  if (isWindowsPath(value) || isPosixAbsolute(value)) return true;
  if (value.startsWith("//")) return false;
  if (!/[\\/]/.test(value)) return false;
  const head = value.split(/[\\/]/)[0] ?? "";
  return !isWebHost(head);
}

function isWebHost(hostport: string): boolean {
  const host = hostport.replace(/:\d+$/, "");
  if (!host) return false;
  if (host.toLowerCase() === "localhost" || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  const tld = labels[labels.length - 1] ?? "";
  if (tld.length < 2 || !/^[A-Za-z]+$/.test(tld)) return false;
  return labels.every(
    (label) =>
      label.length > 0 &&
      !label.startsWith("-") &&
      !label.endsWith("-") &&
      /^[A-Za-z0-9-]+$/.test(label),
  );
}

/** True on a Windows browser. Tests pass the host in directly. */
export function hostIsWindows(): boolean {
  return typeof navigator !== "undefined" && /win/i.test(navigator.platform || "");
}

/**
 * Windows separators for a drive or UNC path, and for a relative path on Windows.
 * A Linux absolute path keeps `/` only, so `\` can be part of a file name.
 */
export function windowsSeparators(path: string, hostIsWindowsPlatform = hostIsWindows()): boolean {
  const plain = plainPath(path);
  if (isWindowsPath(plain)) return true;
  if (isPosixAbsolute(plain)) return false;
  return hostIsWindowsPlatform;
}

function segments(path: string, hostIsWindowsPlatform = hostIsWindows()): string[] {
  const plain = plainPath(path);
  const parts = windowsSeparators(plain, hostIsWindowsPlatform) ? plain.split(/[/\\]/) : plain.split("/");
  return parts.filter((part) => part.length > 0);
}

export function baseName(path: string | null | undefined, hostIsWindowsPlatform = hostIsWindows()): string {
  if (!path) return "";
  const parts = segments(path, hostIsWindowsPlatform);
  return parts[parts.length - 1] ?? path;
}

export function contentSegments(path: string): string[] {
  return segments(path);
}

export function parentPath(path: string, hostIsWindowsPlatform = hostIsWindows()): string {
  const plain = plainPath(path);
  const windows = windowsSeparators(plain, hostIsWindowsPlatform);
  const trimmed = plain.replace(windows ? /[\\/]+$/ : /\/+$/, "");
  const index = windows
    ? Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"))
    : trimmed.lastIndexOf("/");
  if (index < 0) return "";
  if (windows && index === 2 && /^[A-Za-z]:/.test(trimmed)) return trimmed.slice(0, 3);
  if (index === 0) return trimmed.slice(0, 1);
  return trimmed.slice(0, index);
}

export function pathKey(path: string): string {
  const plain = plainPath(path);
  const windows = isWindowsPath(plain);
  const slashed = windows ? plain.replace(/\\/g, "/") : plain;
  const trimmed = slashed.replace(/\/+$/, "");
  return windows ? trimmed.toLowerCase() : trimmed;
}

export function samePath(path: string, root: string): boolean {
  const child = pathKey(path);
  const base = pathKey(root);
  if (!base) return false;
  return child === base || child.startsWith(`${base}/`);
}
