const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg"]);

/** True when a file should be drawn as a picture instead of text. */
export function isImageFile(path: string): boolean {
  const base = path.split(/[/\\]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return IMAGES.has(base.slice(dot + 1).toLowerCase());
}
