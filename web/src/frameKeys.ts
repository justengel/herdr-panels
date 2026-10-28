import { expandBinding } from "./herdrKeys";

export interface FramePrefix {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

export interface FrameKey {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  repeat: boolean;
}

/** The prefix chord a frame should capture. The binding is the prefix itself, such as ctrl+b. */
export function framePrefix(binding: string): FramePrefix | null {
  const [chord] = expandBinding(binding);
  if (!chord || chord.prefix) return null;
  return { ctrl: chord.ctrl, alt: chord.alt, shift: chord.shift, meta: chord.meta, key: chord.key };
}

/** A key forwarded by a frame we gave the token to. */
export function readFrameKey(data: unknown, token: string): FrameKey | null {
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  if (message.source !== "hwp-keys" || message.token !== token) return null;
  if (typeof message.key !== "string" || message.key.length > 32) return null;
  if (typeof message.code !== "string" || message.code.length > 32) return null;
  return {
    key: message.key,
    code: message.code,
    ctrlKey: Boolean(message.ctrlKey),
    altKey: Boolean(message.altKey),
    shiftKey: Boolean(message.shiftKey),
    metaKey: Boolean(message.metaKey),
    repeat: Boolean(message.repeat),
  };
}

export function frameOwnsKeys(frame: { getAttribute(name: string): string | null; src?: string; srcdoc?: string }): boolean {
  const src = frame.getAttribute("src") || frame.src || "";
  if (isFramePath(src)) return true;
  if (!src && frame.srcdoc) return true;
  return false;
}

function isFramePath(src: string): boolean {
  if (src.startsWith("/plugins/") || src.startsWith("/content/") || src.startsWith("/gate/")) return true;
  try {
    const path = new URL(src, "http://127.0.0.1").pathname;
    return path.startsWith("/plugins/") || path.startsWith("/content/") || path.startsWith("/gate/");
  } catch {
    return false;
  }
}
