import type { PanelConfig } from "./types";
import { baseName } from "./paths";
import { viewerName } from "./viewMenu";

/**
 * Words the desk used to save on its own. They are not a person's name, so the
 * title bar follows the panel instead of keeping the first label it was given.
 */
const GENERATED_TITLES = new Set([
  "panel",
  "new panel",
  "new tab",
  "panes",
  "terminal",
  "files",
  "spaces",
  "agents",
  "browser",
  "html",
  "plugin",
  "file",
  "tabs",
  "chat",
  "directories",
]);

/** True when the panel has no real name yet (blank, or an automatic label). */
export function isDefaultPanelTitle(title: string | null | undefined): boolean {
  const value = (title ?? "").trim().toLowerCase();
  return !value || GENERATED_TITLES.has(value);
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

/**
 * What the title bar shows. A saved name is used as typed. A blank name, or an
 * old automatic label, shows the file, folder, or site, and otherwise the type.
 */
export function displayTitle(
  title: string | null | undefined,
  panel: PanelConfig,
  pluginTitle = "",
): string {
  if (panel.type === "tabs") {
    if (!isDefaultPanelTitle(title)) return (title ?? "").trim();
    return "Tabs";
  }
  if (!isDefaultPanelTitle(title)) return (title ?? "").trim();
  const address = addressOf(panel);
  if (address) return address;
  return viewerName(panel, pluginTitle);
}

function addressOf(panel: PanelConfig): string {
  switch (panel.type) {
    case "iframe":
      return domainFromUrl(panel.url);
    case "html":
    case "markdown":
    case "file":
    case "explorer":
      return baseFileName(panel.path || "");
    case "plugin":
      return baseFileName(panel.path || "") || domainFromUrl(panel.url || "");
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
  return baseName(path.trim());
}
