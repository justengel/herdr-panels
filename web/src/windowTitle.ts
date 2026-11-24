import { desktopHost } from "./desktopBrowser";

/** OS window title. Default stays "Herdr Panels" so the usual window is unchanged. */
export function windowTitle(session: string): string {
  const name = session.trim();
  if (
    !name ||
    name === "default" ||
    name.startsWith(".") ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("..")
  ) {
    return "Herdr Panels";
  }
  return `Herdr Panels - ${name}`;
}

export function applyWindowTitle(session: string): void {
  const title = windowTitle(session);
  if (typeof document !== "undefined") document.title = title;
  const host = desktopHost();
  if (!host) return;
  void host.invoke("set_window_title", { session }).catch(() => undefined);
}
