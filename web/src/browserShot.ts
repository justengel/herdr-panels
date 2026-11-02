import { snapshotBrowser } from "./desktopBrowser";

export interface ShotBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ShotPiece {
  /** Destination in the screenshot, CSS pixels from the shot's top left. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The part of the webview image to copy, as fractions of that image. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * Where a browser hole lands inside a screenshot.
 * A hole outside the shot is omitted. A hole clipped by the shot copies only the visible part.
 */
export function browserShotPiece(hole: ShotBox, origin: ShotBox): ShotPiece | null {
  const left = Math.max(hole.left, origin.left);
  const top = Math.max(hole.top, origin.top);
  const right = Math.min(hole.left + hole.width, origin.left + origin.width);
  const bottom = Math.min(hole.top + hole.height, origin.top + origin.height);
  const width = right - left;
  const height = bottom - top;
  if (width < 1 || height < 1 || hole.width < 1 || hole.height < 1) return null;
  return {
    x: left - origin.left,
    y: top - origin.top,
    width,
    height,
    sx: (left - hole.left) / hole.width,
    sy: (top - hole.top) / hole.height,
    sw: width / hole.width,
    sh: height / hole.height,
  };
}

/**
 * Paint native browser pages onto a screenshot.
 *
 * html2canvas only sees the desk DOM. A browser panel, including one inside a tab, is a
 * native webview sitting in an empty hole, so the shot is the panel background and not the
 * page. Ask the desktop window for that webview's own pixels and draw them over the hole.
 * Windows prints the webview. Linux asks WebKit to snapshot the same webview. Do not remove
 * this step: both a normal panel and a tab go blank in the screenshot without it.
 */
export async function paintNativeBrowsers(
  canvas: HTMLCanvasElement,
  origin: ShotBox,
): Promise<void> {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const scale = canvas.width / Math.max(origin.width, 1);
  const holes = [...document.querySelectorAll<HTMLElement>(".browser-hole")];
  for (const hole of holes) {
    const rect = hole.getBoundingClientRect();
    const piece = browserShotPiece(
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      origin,
    );
    const label = hole.getAttribute("data-browser-label");
    if (!piece || !label) continue;
    let blob: Blob | null = null;
    try {
      blob = await snapshotBrowser(label, rect.width, rect.height);
    } catch {
      blob = null;
    }
    if (!blob) continue;
    const image = await createImageBitmap(blob);
    ctx.drawImage(
      image,
      piece.sx * image.width,
      piece.sy * image.height,
      piece.sw * image.width,
      piece.sh * image.height,
      piece.x * scale,
      piece.y * scale,
      piece.width * scale,
      piece.height * scale,
    );
    image.close();
  }
}
