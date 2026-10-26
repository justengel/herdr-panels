import type { PanelConfig } from "./types";
import { isWindowsPath, parentPath, plainPath } from "./paths";

function activePanel(panel: PanelConfig): PanelConfig {
  if (panel.type !== "tabs") return panel;
  return panel.tabs.find((tab) => tab.id === panel.active)?.panel ?? panel.tabs[0]?.panel ?? panel;
}

/** Directory a new Terminal-here pane should open in, or null when Desk → Terminal (no here). */
export function terminalHereCwd(panel: PanelConfig): string | null {
  const content = activePanel(panel);
  switch (content.type) {
    case "markdown":
    case "file":
      return parentPath(content.path) || plainPath(content.path) || null;
    case "html":
      return content.path ? parentPath(content.path) || plainPath(content.path) || null : null;
    case "explorer":
      if (content.focus) return parentPath(content.focus) || plainPath(content.path) || null;
      return plainPath(content.path) || null;
    case "plugin":
      if (content.directory && content.path) return plainPath(content.path) || null;
      if (content.path) return parentPath(content.path) || plainPath(content.path) || null;
      return null;
    default:
      return null;
  }
}

/** Shell text to change into `cwd` after a new pane is created. */
export function cdCommand(cwd: string): string {
  const path = plainPath(cwd);
  if (!path) return "";
  if (isWindowsPath(path)) {
    const escaped = path.replace(/"/g, '""');
    return `cd "${escaped}"`;
  }
  const escaped = path.replace(/'/g, `'\\''`);
  return `cd '${escaped}'`;
}
