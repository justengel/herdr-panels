import { isWindowsPath, parentPath, pathKey, plainPath, samePath } from "./paths";
import type { PanelConfig } from "./types";

type ExplorerPanel = Extract<PanelConfig, { type: "explorer" }>;

function isAbsolute(path: string): boolean {
  return isWindowsPath(path) || path.startsWith("/");
}

/** Join a relative path onto the workspace. Absolute paths stay as they are. */
export function resolveWorkspacePath(filePath: string, workspaceRoot?: string | null): string {
  const file = plainPath(filePath).trim();
  const space = plainPath(workspaceRoot || "").replace(/[\\/]+$/, "");
  if (!file) return space;
  if (!space || isAbsolute(file)) return file;
  const sep = space.includes("\\") && !space.includes("/") ? "\\" : "/";
  const rest = file.replace(/^[\\/]+/, "").replace(/[\\/]/g, sep);
  return `${space}${sep}${rest}`;
}

/** Tree root when opening Files on a file: workspace if it contains the path, else the volume. */
export function explorerRootFor(filePath: string, workspaceRoot?: string | null): string {
  const space = plainPath(workspaceRoot || "").replace(/[\\/]+$/, "");
  const file = resolveWorkspacePath(filePath, space);
  if (!file) return space;
  if (space && samePath(file, space)) return space;
  if (!isWindowsPath(file) && !file.startsWith("/")) return parentPath(file) || file;
  if (isWindowsPath(file)) {
    const match = file.match(/^([A-Za-z]:)([\\/]?)/);
    if (!match) return parentPath(file) || file;
    const sep = file.includes("\\") && !file.includes("/") ? "\\" : "/";
    return `${match[1]}${sep}`;
  }
  return "/";
}

/** Up: the address becomes the parent directory and the file subject is cleared. */
export function climbExplorer(panel: ExplorerPanel): ExplorerPanel | null {
  const address = panel.focus || panel.path;
  const parent = parentPath(address);
  if (!parent || pathKey(parent) === pathKey(address)) return null;
  const next: ExplorerPanel = { type: "explorer", path: parent };
  if (typeof panel.addressBar === "boolean") next.addressBar = panel.addressBar;
  return next;
}

/** Directory for a space: its worktree, or the focused pane's directory when Herdr omits one. */
export function workspaceDirectory(
  space: { workspaceId?: string; root?: string | null } | null | undefined,
  panes: { workspaceId?: string; focused?: boolean; cwd?: string | null }[] = [],
): string | null {
  const root = plainPath(space?.root || "").replace(/[\\/]+$/, "");
  if (root) return root;
  const inSpace = panes.filter((pane) => !space?.workspaceId || pane.workspaceId === space.workspaceId);
  const pane = inSpace.find((item) => item.focused && item.cwd) ?? inSpace.find((item) => item.cwd);
  const cwd = plainPath(pane?.cwd || "").replace(/[\\/]+$/, "");
  return cwd || null;
}
