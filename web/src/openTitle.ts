import type { PanelConfig } from "./types";

/** True when the panel has no real name yet (blank add, or the old default). */
export function isDefaultPanelTitle(title: string | null | undefined): boolean {
  const value = (title ?? "").trim();
  return !value || value === "New panel" || value === "Panel";
}

/** Domain for a URL, base filename (or folder name) for a path-backed panel. */
export function titleFromPanel(panel: PanelConfig): string {
  switch (panel.type) {
    case "iframe":
      return domainFromUrl(panel.url);
    case "html":
    case "markdown":
    case "file":
    case "explorer":
      return baseFileName(panel.path || "");
    case "plugin":
      return (panel.plugin || "").trim();
    default:
      return "";
  }
}

export function domainFromUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return parsed.hostname || "";
  } catch {
    return "";
  }
}

export function baseFileName(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return "";
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || "";
}
