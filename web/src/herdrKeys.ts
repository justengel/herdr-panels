export interface Chord {
  prefix: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
  index?: number;
}

const KEY_ALIAS: Record<string, string> = {
  arrowleft: "left",
  arrowright: "right",
  arrowup: "up",
  arrowdown: "down",
  escape: "esc",
  " ": "space",
};

export function expandBinding(binding: string): Chord[] {
  const text = binding.trim().toLowerCase();
  if (!text) return [];
  if (text.includes("1..9")) {
    return [1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((index) =>
      expandBinding(text.replace("1..9", String(index))).map((chord) => ({ ...chord, index })),
    );
  }
  const chord: Chord = { prefix: false, ctrl: false, alt: false, shift: false, meta: false, key: "" };
  for (const part of text.split("+")) {
    if (part === "prefix") chord.prefix = true;
    else if (part === "ctrl" || part === "control") chord.ctrl = true;
    else if (part === "alt" || part === "opt" || part === "option") chord.alt = true;
    else if (part === "shift") chord.shift = true;
    else if (part === "cmd" || part === "super" || part === "meta") chord.meta = true;
    else if (part === "minus") chord.key = "-";
    else chord.key = part;
  }
  return chord.key ? [chord] : [];
}

export function eventKey(event: KeyboardEvent): string {
  const raw = event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase();
  return KEY_ALIAS[raw] ?? raw;
}

export function chordMatches(chord: Chord, event: KeyboardEvent, prefix: boolean): boolean {
  if (chord.prefix !== prefix) return false;
  if (chord.ctrl !== event.ctrlKey || chord.alt !== event.altKey || chord.meta !== event.metaKey) return false;
  const key = eventKey(event);
  if (key !== chord.key && !(chord.key === "?" && key === "/")) return false;
  if (chord.shift) return event.shiftKey;
  if (/^[a-z]$/.test(chord.key) && event.shiftKey) return false;
  return true;
}
