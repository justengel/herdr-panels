export interface BrowserBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Internals = {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
};

export function desktopHost(): Internals | null {
  if (typeof window === "undefined") return null;
  const host = window as Window & { __TAURI_INTERNALS__?: Internals };
  return host.__TAURI_INTERNALS__ ?? null;
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
 * The part of each menu that sits on this page.
 * The native window stays full size and is cut to these rectangles, so the menu
 * draws on top without a margin and without the site reflowing.
 */
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
  return input.dragging || input.settings || input.dialog;
}

export function menuObstacles(): BrowserBox[] {
  return [...document.querySelectorAll(".panel-menu, .panel-menu-flyout, .select-menu")].flatMap((node) => {
    const rect = node.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    if (width < 2 || height < 2) return [];
    return [{ x: Math.round(rect.left), y: Math.round(rect.top), width, height }];
  });
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

export async function closeBrowser(label: string, generationId: number): Promise<void> {
  const host = desktopHost();
  if (!host) return;
  await host.invoke("close_browser", { label, generation: generationId });
}
