import { api } from "./api";
import { cdCommand } from "./terminalHere";
import type { PanelConfig } from "./types";

export type TerminalPlacement = "shell" | "split";

/**
 * A new terminal is one terminal in this panel, including Terminals → New terminal on Panes.
 * Splitting a tab stays inside the Panes view.
 */
export function terminalPlacement(_choice: "terminal" | "pane:new", _panel: PanelConfig): TerminalPlacement {
  return "shell";
}

export function shellPanel(paneId: string | null): PanelConfig {
  return { type: "herdr", paneId, scope: "pane" };
}

/** Pane created by a new Herdr tab, preferring the space the tab was opened in. */
export function addedPane(
  before: readonly string[],
  after: readonly { paneId: string; workspaceId?: string | null }[],
  workspaceId?: string | null,
): string | null {
  const known = new Set(before);
  const created = after.filter((pane) => pane.paneId && !known.has(pane.paneId));
  const inSpace = workspaceId ? created.filter((pane) => pane.workspaceId === workspaceId) : created;
  return (inSpace[0] ?? created[0])?.paneId ?? null;
}

/** Split a Herdr pane and optionally `cd` into `cwd`. Returns the new pane id. */
export async function openTerminalPane(sourcePaneId: string, cwd?: string | null): Promise<string> {
  const { paneId } = await api.splitPane(sourcePaneId, "right");
  const target = cwd?.trim();
  if (target) {
    const text = cdCommand(target);
    if (text) {
      try {
        await api.sendInput({ paneId, text, keys: ["enter"] });
      } catch {
        // Panel still binds to the new pane even if cd fails.
      }
    }
  }
  return paneId;
}
