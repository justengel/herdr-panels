import { desktopHost } from "./desktopBrowser";

export type LinkAction = "open" | "stay" | "block";

/** Canonical http(s) address, or null when the address must not be opened. */
export function openableHttpUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 4096 || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return null;
  return url.href;
}

/**
 * A link inside a plugin or HTML frame.
 * A different site, or `target="_blank"`, opens outside the frame.
 * Another page on the same site stays in the frame. Anything else is blocked.
 */
export function frameLinkAction(href: string, pageHref: string, target: string): LinkAction {
  let url: URL;
  let page: URL;
  try {
    url = new URL(href, pageHref);
    page = new URL(pageHref);
  } catch {
    return "block";
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return "block";
  const blank = target.toLowerCase() === "_blank";
  const sameDocument =
    url.origin === page.origin && url.pathname === page.pathname && url.search === page.search && url.hash.length > 0;
  if (sameDocument && !blank) return "stay";
  if (!blank && url.origin === page.origin) return "stay";
  return "open";
}

/** A link in a note. A heading on this page stays. Any other http(s) address opens outside. */
export function noteLinkAction(href: string, pageHref: string): LinkAction {
  let url: URL;
  let page: URL;
  try {
    url = new URL(href, pageHref);
    page = new URL(pageHref);
  } catch {
    return "block";
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return "block";
  if (url.origin === page.origin && url.pathname === page.pathname && url.search === page.search && url.hash.length > 0) {
    return "stay";
  }
  return "open";
}

/** Desktop window: the system browser. Browser tab: a new tab of that browser. */
export async function openExternalUrl(raw: string): Promise<string> {
  const url = openableHttpUrl(raw);
  if (!url) throw new Error("only http and https links can be opened");
  const host = desktopHost();
  if (host) {
    const opened = await host.invoke("open_external", { url });
    return typeof opened === "string" && opened ? opened : url;
  }
  const popup = window.open(url, "_blank", "noopener,noreferrer");
  if (!popup) throw new Error("the browser blocked the new tab");
  return url;
}
