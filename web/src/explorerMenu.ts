import { parentPath, plainPath } from "./paths";

/** Folder a new terminal should start in. A file uses its parent. */
export function terminalDirectory(path: string, kind: "file" | "dir"): string {
  const cleaned = plainPath(path);
  if (kind === "dir") return cleaned;
  return parentPath(cleaned) || cleaned;
}

/** Label for the system file browser on this machine. */
export function fileBrowserLabel(platform: string): string {
  if (/win/i.test(platform)) return "Open in Explorer";
  if (/mac/i.test(platform)) return "Open in Finder";
  return "Open in file manager";
}
