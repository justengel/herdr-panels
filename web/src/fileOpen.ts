import type { PanelConfig } from "./types";
import { baseName, isFilesystemAddress } from "./paths";

/** Open a file in a new split beside the explorer. */
export function openFileBeside(from: string, target: string) {
  return { target, from, direction: "right" as const };
}

/** What to show when the server cannot resolve an address from Open file or URL. */
export function panelWhenUnresolved(address: string): PanelConfig {
  const value = address.trim();
  if (isFilesystemAddress(value)) return filePanel(value);
  return { type: "iframe", url: value, proxy: false };
}

function filePanel(path: string): PanelConfig {
  const base = baseName(path);
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  if (ext === "md" || ext === "markdown") return { type: "markdown", path };
  if (ext === "html" || ext === "htm") return { type: "html", path };
  return { type: "file", path };
}
