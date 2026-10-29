export interface ScreenshotOffer {
  heading: string;
  body: string;
}

export type ScreenshotKeep =
  | { kind: "saved"; path: string }
  | { kind: "cancelled" }
  | { kind: "downloaded" };

/** What to say after a screenshot. A file is a separate choice from the clipboard. */
export function screenshotOffer(copied: boolean, where: "file-dialog" | "downloads"): ScreenshotOffer {
  const lead = copied
    ? "Copied to the clipboard. Save a PNG if it does not paste."
    : "The clipboard did not take this image.";
  const tail =
    where === "file-dialog"
      ? "Save asks where to put the file. Nothing is written until you pick a file."
      : "Save downloads a PNG into your Downloads folder. Nothing is written until you choose Save.";
  return { heading: "Screenshot", body: `${lead} ${tail}` };
}

export function screenshotFileName(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `herdr-panels-${stamp}.png`;
}

/**
 * Keep a screenshot only when the person confirms.
 * A cancelled file dialog writes nothing. A dialog that cannot open falls back to a download.
 */
export async function keepScreenshot(
  blob: Blob,
  name: string,
  save: (blob: Blob, name: string) => Promise<string | null>,
  download: (name: string) => void,
): Promise<ScreenshotKeep> {
  try {
    const path = await save(blob, name);
    if (!path) return { kind: "cancelled" };
    return { kind: "saved", path };
  } catch {
    download(name);
    return { kind: "downloaded" };
  }
}

/** Start the clipboard write during the click, before the image finishes rendering. */
export function writeClipboardPng(pending: Promise<Blob>): Promise<boolean> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard?.write || typeof ClipboardItem === "undefined") return Promise.resolve(false);
  const typed = pending.then((blob) => (blob.type === "image/png" ? blob : new Blob([blob], { type: "image/png" })));
  const write = (blob: Blob | Promise<Blob>) =>
    clipboard.write([new ClipboardItem({ "image/png": blob })]).then(
      () => true,
      () => false,
    );
  try {
    return write(typed).then((ok) => (ok ? true : writeBlob(clipboard, typed)));
  } catch {
    return writeBlob(clipboard, typed);
  }
}

function writeBlob(clipboard: Clipboard, pending: Promise<Blob>): Promise<boolean> {
  return pending.then(
    (blob) =>
      clipboard.write([new ClipboardItem({ "image/png": blob })]).then(
        () => true,
        () => false,
      ),
    () => false,
  );
}

export function downloadPng(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
