import { visualBox } from "./zoomSpace";

export interface BrowserBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Internals = {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
};

export const DESKTOP_ERROR_EVENT = "herdr-panels-desktop-error";

const reportedCommands = new Set<string>();

export function isPermissionError(message: string): boolean {
  return /not allowed|permission denied|forbidden/i.test(message);
}

/** Linux is the only desktop window that can snapshot its own page. */
export function supportsWindowSnapshot(userAgent: string): boolean {
  return /Linux|X11/i.test(userAgent);
}

export function desktopHost(): Internals | null {
  if (typeof window === "undefined") return null;
  const host = window as Window & { __TAURI_INTERNALS__?: Internals };
  const inner = host.__TAURI_INTERNALS__;
  if (!inner) return null;
  return {
    invoke: async (command, args) => {
      try {
        return await inner.invoke(command, args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isPermissionError(message) && !reportedCommands.has(command)) {
          reportedCommands.add(command);
          window.dispatchEvent(new CustomEvent(DESKTOP_ERROR_EVENT, { detail: `${command} was refused: ${message}` }));
        }
        throw err;
      }
    },
  };
}

export function isRemotePage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function browserBounds(
  rect: { left: number; top: number; width: number; height: number },
  blocked: boolean,
): BrowserBox | null {
  if (blocked) return null;
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  if (width < 2 || height < 2) return null;
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width,
    height,
  };
}

/**
 * Linux cannot cut a hole through a WebKit view: the opening paints black and hides the popup.
 * Hold a still of the page in the panel and move the live view aside so the popup can draw.
 */
export function nativePopupUsesStill(userAgent: string, cuts: BrowserBox[]): boolean {
  if (!/Linux/i.test(userAgent) || /Android/i.test(userAgent)) return false;
  return cuts.some((cut) => cut.width >= 1 && cut.height >= 1);
}

export function menuCuts(page: BrowserBox, obstacles: BrowserBox[]): BrowserBox[] {
  const cuts: BrowserBox[] = [];
  for (const obstacle of obstacles) {
    const x = Math.max(page.x, obstacle.x);
    const y = Math.max(page.y, obstacle.y);
    const right = Math.min(page.x + page.width, obstacle.x + obstacle.width);
    const bottom = Math.min(page.y + page.height, obstacle.y + obstacle.height);
    if (right - x < 1 || bottom - y < 1) continue;
    cuts.push({ x, y, width: right - x, height: bottom - y });
  }
  return cuts;
}

export function hideBrowserPanels(input: { dragging: boolean; settings: boolean; dialog: boolean }): boolean {
  // A dialog or menu is cut out of the page. Hiding the page would blank everything under it.
  return input.dragging;
}

/**
 * Popups the desk draws above a browser panel. The native webview ignores z-index,
 * so each of these is cut out of that window. A new dialog belongs in this list,
 * or it carries one of these roles.
 */
export const BROWSER_OVERLAYS = [
  ".panel-menu",
  ".panel-menu-flyout",
  ".select-menu",
  ".status-card",
  ".dialog",
  ".herdr-settings",
  ".prefix-mode",
  "[role='dialog']",
  "[role='menu']",
  "[role='tooltip']",
].join(", ");

export function menuObstacles(): BrowserBox[] {
  if (typeof document === "undefined") return [];
  return overlayBoxes(
    [...document.querySelectorAll(BROWSER_OVERLAYS)].map((node) => ({
      getBoundingClientRect: () => visualBox(node),
    })),
  );
}

export function overlayBoxes(nodes: Iterable<{ getBoundingClientRect(): { left: number; top: number; width: number; height: number } }>): BrowserBox[] {
  const boxes: BrowserBox[] = [];
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    if (width < 2 || height < 2) continue;
    boxes.push({ x: Math.round(rect.left), y: Math.round(rect.top), width, height });
  }
  return boxes;
}

export function browserBlocked(): boolean {
  const body = document.body;
  return hideBrowserPanels({
    dragging: body.classList.contains("panel-dragging"),
    settings: document.querySelector(".settings-backdrop") !== null,
    dialog: document.querySelector(".dialog-backdrop") !== null,
  });
}

let generation = 0;
let placeSeq = 0;
const loads = new Set<string>();

/** Ask the native page to load again. The next place consumes this once it can see the panel. */
export function requestBrowserLoad(label: string) {
  loads.add(label);
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent("herdr-browser-load", { detail: { label } }));
  }
}

export function browserLoadPending(label: string): boolean {
  return loads.has(label);
}

export function takeBrowserLoad(label: string): boolean {
  return loads.delete(label);
}

function nextPlaceSeq(): number {
  placeSeq += 1;
  return placeSeq;
}

export function nextBrowserGeneration(): number {
  generation += 1;
  return generation;
}

export function browserSlotKey(bounds: BrowserBox | null, cuts: BrowserBox[] = []): string {
  if (!bounds) return "hidden";
  const base = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
  if (cuts.length === 0) return base;
  const holes = cuts.map((cut) => `${cut.x},${cut.y},${cut.width},${cut.height}`).join(";");
  return `${base}|${holes}`;
}

export async function placeBrowser(
  label: string,
  url: string,
  bounds: BrowserBox | null,
  generationId: number,
  cuts: BrowserBox[] = [],
  reload = false,
): Promise<void> {
  const host = desktopHost();
  if (!host) throw new Error("desktop shell is not connected");
  const seq = nextPlaceSeq();
  await host.invoke("place_browser", {
    label,
    url,
    x: bounds?.x ?? 0,
    y: bounds?.y ?? 0,
    width: bounds?.width ?? 0,
    height: bounds?.height ?? 0,
    visible: bounds !== null,
    generation: generationId,
    locked: false,
    space: "",
    cuts,
    reload,
    seq,
  });
}

/** Keep the native page when its panel becomes a tab. Creating a second webview leaves a blank page. */
export async function adoptBrowser(from: string, to: string, generationId: number): Promise<void> {
  const host = desktopHost();
  if (!host || from === to) return;
  await host.invoke("adopt_browser", { from, to, generation: generationId });
}

/**
 * Pixels of one native browser webview.
 * html2canvas cannot see this window. The desktop app has to hand the image back.
 */
export async function snapshotBrowser(label: string, width: number, height: number): Promise<Blob | null> {
  const host = desktopHost();
  if (!host || width < 2 || height < 2) return null;
  const base64 = await host.invoke("snapshot_browser", { label, width, height });
  if (typeof base64 !== "string" || !base64) return null;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: "image/png" });
}

/** A pixel snapshot of the visible desk page, or null where this window cannot take one. */
export async function desktopSnapshot(rect: { left: number; top: number; width: number; height: number }): Promise<Blob | null> {
  const host = desktopHost();
  if (!host || !supportsWindowSnapshot(navigator.userAgent || "")) return null;
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const width = Math.min(window.innerWidth, rect.left + rect.width) - left;
  const height = Math.min(window.innerHeight, rect.top + rect.height) - top;
  if (width < 1 || height < 1) return null;
  const base64 = await host.invoke("snapshot_view", { x: left, y: top, width, height, viewport: window.innerWidth });
  if (typeof base64 !== "string" || !base64) return null;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: "image/png" });
}

export async function closeBrowser(label: string, generationId: number): Promise<void> {
  const host = desktopHost();
  if (!host) return;
  await host.invoke("close_browser", { label, generation: generationId });
}
