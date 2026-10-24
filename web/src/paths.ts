const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/;

export function plainPath(path: string): string {
  return path.startsWith("\\\\?\\") ? path.slice(4) : path;
}

export function isWindowsPath(path: string): boolean {
  return WINDOWS_PATH.test(plainPath(path));
}

function segments(path: string): string[] {
  const plain = plainPath(path);
  const parts = isWindowsPath(plain) ? plain.split(/[/\\]/) : plain.split("/");
  return parts.filter((part) => part.length > 0);
}

export function baseName(path: string | null | undefined): string {
  if (!path) return "";
  const parts = segments(path);
  return parts[parts.length - 1] ?? path;
}

export function contentSegments(path: string): string[] {
  return segments(path);
}

export function parentPath(path: string): string {
  const plain = plainPath(path);
  const windows = isWindowsPath(plain);
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
