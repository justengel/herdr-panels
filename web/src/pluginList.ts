import type { PluginInfo } from "./desk";

/** True when an install, removal, or manifest change should replace the desk's plugin list. */
export function pluginListChanged(current: readonly PluginInfo[], next: readonly PluginInfo[]): boolean {
  return JSON.stringify(current) !== JSON.stringify(next);
}
