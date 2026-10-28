/** Shown when a plugin calls a control method and the panel flag is off. Keep in step with `CONTROL_OFF` in `src/plugin_grant.rs`. */
export const CONTROL_OFF_MESSAGE =
  'This panel cannot type into a pane. Turn on "control" in the design bar.';

const HINT_KEY = "herdr-panels.control-hint";

export function controlHintVisible(
  permissions: readonly string[] | undefined,
  control: boolean,
  seen: boolean,
): boolean {
  if (control) return false;
  if (!permissions?.includes("herdr:control")) return false;
  return !seen;
}

function hintStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function controlHintSeen(pluginId: string): boolean {
  const local = hintStorage();
  if (!local || !pluginId) return false;
  try {
    const parsed = JSON.parse(local.getItem(HINT_KEY) || "[]") as unknown;
    return Array.isArray(parsed) && parsed.includes(pluginId);
  } catch {
    return false;
  }
}

/** Remember that control was turned on, so the design-bar note does not return. */
export function rememberControlEnabled(pluginId: string) {
  const local = hintStorage();
  if (!local || !pluginId || controlHintSeen(pluginId)) return;
  let ids: string[] = [];
  try {
    const parsed = JSON.parse(local.getItem(HINT_KEY) || "[]") as unknown;
    if (Array.isArray(parsed)) ids = parsed.filter((item) => typeof item === "string");
  } catch {
    ids = [];
  }
  ids.push(pluginId);
  try {
    local.setItem(HINT_KEY, JSON.stringify(ids.slice(-40)));
  } catch {
    // The note can show again next time.
  }
}
