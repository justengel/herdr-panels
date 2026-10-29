/** Colors html2canvas can parse. WebKit reports color-mix() as color(). */

type Rgba = { r: number; g: number; b: number; a: number };

const COLOR_PROPS = [
  "color",
  "background-color",
  "background-image",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "box-shadow",
  "text-decoration-color",
  "text-shadow",
  "-webkit-text-stroke-color",
];

export function settleCssColor(value: string): string {
  const colors = replaceFunctions(value, "color", convertColor);
  return replaceFunctions(colors, "color-mix", convertMix);
}

/** Rewrite computed colors on a cloned document before html2canvas parses them. */
export function settleComputedColors(doc: Document): void {
  const view = doc.defaultView;
  if (!view) return;
  doc.querySelectorAll("*").forEach((node) => {
    if (!(node instanceof view.HTMLElement) && !(node instanceof view.SVGElement)) return;
    const style = view.getComputedStyle(node);
    for (const prop of COLOR_PROPS) {
      const current = style.getPropertyValue(prop);
      if (!current || current === "none" || current === "normal") continue;
      const settled = settleCssColor(current);
      if (settled !== current) node.style.setProperty(prop, settled);
    }
  });
}

function replaceFunctions(value: string, name: string, convert: (args: string) => string | null): string {
  const needle = `${name}(`;
  let result = "";
  let index = 0;
  while (index < value.length) {
    const at = value.toLowerCase().indexOf(needle, index);
    if (at < 0) {
      result += value.slice(index);
      break;
    }
    const before = at === 0 ? "" : value[at - 1];
    if (before && /[a-z-]/i.test(before)) {
      result += value.slice(index, at + needle.length);
      index = at + needle.length;
      continue;
    }
    const end = closeParen(value, at + needle.length);
    if (end < 0) {
      result += value.slice(index);
      break;
    }
    result += value.slice(index, at);
    const args = value.slice(at + needle.length, end);
    result += convert(args) ?? value.slice(at, end + 1);
    index = end + 1;
  }
  return result;
}

function closeParen(value: string, start: number): number {
  let depth = 1;
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === "(") depth += 1;
    else if (value[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function convertColor(args: string): string | null {
  const [body, alphaRaw] = splitSlash(args.trim());
  const parts = body.split(/\s+/).filter(Boolean);
  if (parts.length < 4) return null;
  const channels = parts.slice(1, 4).map(unitChannel);
  if (channels.some((channel) => channel == null)) return null;
  const alpha = alphaRaw == null ? 1 : alphaOf(alphaRaw);
  if (alpha == null) return null;
  return formatColor(channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0, alpha);
}

function convertMix(args: string): string | null {
  const body = args.trim().replace(/^in\s+[a-z0-9-]+\s*,\s*/i, "");
  const parts = splitComma(body);
  if (parts.length !== 2) return null;
  const left = mixPart(parts[0] ?? "");
  const right = mixPart(parts[1] ?? "");
  if (!left || !right) return null;
  let first = left.percent;
  let second = right.percent;
  if (first == null && second == null) {
    first = 0.5;
    second = 0.5;
  } else if (first == null) first = 1 - (second ?? 0);
  else if (second == null) second = 1 - first;
  const leftPercent = first ?? 0;
  const rightPercent = second ?? 0;
  if (leftPercent < 0 || rightPercent < 0) return null;
  const sum = leftPercent + rightPercent;
  if (sum <= 0) return "transparent";
  const leftWeight = leftPercent / sum;
  const rightWeight = rightPercent / sum;
  const alpha = left.color.a * leftWeight + right.color.a * rightWeight;
  if (alpha <= 0) return "transparent";
  const mix = (from: number, to: number) => (leftWeight * left.color.a * from + rightWeight * right.color.a * to) / alpha;
  return formatColor(mix(left.color.r, right.color.r), mix(left.color.g, right.color.g), mix(left.color.b, right.color.b), alpha);
}

function mixPart(value: string): { color: Rgba; percent: number | null } | null {
  const match = value.trim().match(/^(.*?)(?:\s+([\d.]+)%)\s*$/);
  const colorText = (match?.[1] ?? value).trim();
  const percent = match?.[2] == null ? null : Number(match[2]) / 100;
  if (percent != null && !Number.isFinite(percent)) return null;
  const color = parsePlainColor(colorText);
  if (!color) return null;
  return { color, percent };
}

function parsePlainColor(value: string): Rgba | null {
  const text = value.trim().toLowerCase();
  if (text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const hex = text.match(/^#([0-9a-f]{3,8})$/);
  if (hex?.[1]) return parseHex(hex[1]);
  const fn = text.match(/^(rgb|rgba)\((.*)\)$/);
  if (!fn?.[2]) return null;
  return parseRgb(fn[2]);
}

function parseHex(hex: string): Rgba | null {
  const full = hex.length === 3 || hex.length === 4 ? [...hex].map((char) => char + char).join("") : hex;
  if (full.length !== 6 && full.length !== 8) return null;
  const r = Number.parseInt(full.slice(0, 2), 16);
  const g = Number.parseInt(full.slice(2, 4), 16);
  const b = Number.parseInt(full.slice(4, 6), 16);
  const a = full.length === 8 ? Number.parseInt(full.slice(6, 8), 16) / 255 : 1;
  if ([r, g, b].some((channel) => Number.isNaN(channel))) return null;
  return { r, g, b, a };
}

function parseRgb(args: string): Rgba | null {
  const [body, alphaRaw] = splitSlash(args);
  const parts = body.split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const channels = parts.slice(0, 3).map(rgbChannel);
  if (channels.some((channel) => channel == null)) return null;
  const alpha = alphaRaw == null ? (parts[3] == null ? 1 : alphaOf(parts[3])) : alphaOf(alphaRaw);
  if (alpha == null) return null;
  return { r: channels[0] ?? 0, g: channels[1] ?? 0, b: channels[2] ?? 0, a: alpha };
}

function splitSlash(value: string): [string, string | null] {
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "/" && depth === 0) return [value.slice(0, index), value.slice(index + 1).trim()];
  }
  return [value, null];
}

function splitComma(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function unitChannel(token: string): number | null {
  if (token === "none") return 0;
  if (token.endsWith("%")) {
    const percent = Number(token.slice(0, -1));
    if (!Number.isFinite(percent)) return null;
    return clampByte((percent / 100) * 255);
  }
  const number = Number(token);
  if (!Number.isFinite(number)) return null;
  return clampByte(number * 255);
}

function rgbChannel(token: string): number | null {
  if (token.endsWith("%")) {
    const percent = Number(token.slice(0, -1));
    if (!Number.isFinite(percent)) return null;
    return clampByte((percent / 100) * 255);
  }
  const number = Number(token);
  if (!Number.isFinite(number)) return null;
  return clampByte(number);
}

function alphaOf(token: string): number | null {
  const text = token.trim();
  if (text.endsWith("%")) {
    const percent = Number(text.slice(0, -1));
    if (!Number.isFinite(percent)) return null;
    return clamp01(percent / 100);
  }
  const number = Number(text);
  if (!Number.isFinite(number)) return null;
  return clamp01(number);
}

function formatColor(r: number, g: number, b: number, a: number): string {
  const red = clampByte(r);
  const green = clampByte(g);
  const blue = clampByte(b);
  if (a >= 0.999) return `rgb(${red}, ${green}, ${blue})`;
  const alpha = Math.round(clamp01(a) * 1000) / 1000;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
