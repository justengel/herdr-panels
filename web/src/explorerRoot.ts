import { isWindowsPath, parentPath, plainPath, samePath } from "./paths";

/** Tree root when opening Files on a file: workspace if it contains the path, else the volume. */
export function explorerRootFor(filePath: string, workspaceRoot?: string | null): string {
  const file = plainPath(filePath);
  if (!file) return plainPath(workspaceRoot || "") || "";
  const space = plainPath(workspaceRoot || "");
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
