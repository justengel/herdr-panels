import { api } from "./api";
import { cdCommand } from "./terminalHere";

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
