export interface PluginAddressBar {
  show: boolean;
  modify: boolean;
  /** The plugin draws its own bar, so the viewer's bar stays hidden. */
  replace: boolean;
}

const MAX_ADDRESS = 2048;

export function pluginAddressBar(plugin?: {
  addressBar?: { show?: boolean; modify?: boolean; replace?: boolean };
}): PluginAddressBar {
  const bar = plugin?.addressBar;
  const replace = bar?.replace === true;
  return {
    show: replace ? false : bar?.show !== false,
    modify: bar?.modify === true,
    replace,
  };
}

export type PluginAddressMessage =
  | { type: "address"; value: string }
  | { type: "address-bar"; show: boolean; replace: boolean }
  | { type: "config"; value: Record<string, unknown> };

const MAX_CONFIG = 32_000;

export function readPluginAddressMessage(data: unknown): PluginAddressMessage | null {
  if (!data || typeof data !== "object") return null;
  const message = data as {
    source?: unknown;
    type?: unknown;
    value?: unknown;
    show?: unknown;
    replace?: unknown;
  };
  if (message.source !== "hwp-plugin") return null;
  if (message.type === "address" && typeof message.value === "string") {
    const value = message.value.trim();
    if (!value || value.length > MAX_ADDRESS) return null;
    return { type: "address", value };
  }
  if (message.type === "address-bar") {
    if (message.replace === true) return { type: "address-bar", show: false, replace: true };
    if (typeof message.show === "boolean") return { type: "address-bar", show: message.show, replace: false };
  }
  if (message.type === "config" && isConfig(message.value)) return { type: "config", value: message.value };
  return null;
}

function isConfig(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return JSON.stringify(value).length <= MAX_CONFIG;
  } catch {
    return false;
  }
}
