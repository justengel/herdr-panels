import { chordMatches, eventKey, expandBinding, type Chord } from "./herdrKeys";
import { findPanel, freshPanelId, listPanels, setPanel, splitPanel } from "./layoutEdit";
import { bindTerminalPane } from "./spaceLayout";
import type { LayoutNode, PanelConfig, PanelNode } from "./types";

export type Direction = "left" | "right" | "up" | "down";

export interface Box {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface KeyPress {
  key: string;
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  repeat?: boolean;
}

export type DeskCommand =
  | { action: "focus"; direction: Direction }
  | { action: "move"; direction: Direction }
  | { action: "enter" }
  | { action: "close" }
  | { action: "undo" }
  | { action: "redo" }
  | { action: "reopen" }
  | { action: "cycle-panel"; delta: 1 | -1 }
  | { action: "zoom" }
  | { action: "cycle-space"; delta: 1 | -1 }
  | { action: "space"; index: number }
  | { action: "cycle-agent"; delta: 1 | -1 }
  | { action: "agent"; index: number }
  | { action: "address" }
  | { action: "agents" }
  | { action: "spaces" }
  | { action: "help" };

export type DeskMatch = DeskCommand | { action: "list"; delta: 1 | -1 } | { action: "activate" };

export interface PanelRef {
  id: string;
  kind: string;
  paneId: string | null;
  /** A top-level terminal panel, which can be pointed at another pane. */
  terminal: boolean;
}

/**
 * Optional Herdr bindings. When the box is empty, the desk still uses these.
 * Zoom, help, and the other keys that already have a Herdr default are left alone,
 * so clearing that box turns the shortcut off.
 */
const BINDING_FALLBACK: Record<string, string> = {
  next_workspace: "prefix+alt+n",
  previous_workspace: "prefix+alt+p",
  switch_workspace: "prefix+shift+1..9",
  next_agent: "prefix+alt+.",
  previous_agent: "prefix+alt+,",
  focus_agent: "prefix+alt+1..9",
};

/** Herdr defaults for keys an older server build still omits. Clearing a shown binding stays off. */
const BINDING_WHEN_MISSING: Record<string, string> = {
  ...BINDING_FALLBACK,
  zoom: "prefix+z",
  cycle_pane_next: "prefix+tab",
  cycle_pane_previous: "prefix+shift+tab",
  help: "prefix+?",
  goto: "prefix+g",
  workspace_picker: "prefix+w",
  toggle_sidebar: "prefix+b",
};

export function effectiveBinding(key: string, configured: string): string {
  const value = configured.trim();
  if (value) return value;
  return BINDING_FALLBACK[key] ?? "";
}

export function bindingPlaceholder(key: string): string {
  return BINDING_FALLBACK[key] ?? "";
}

export function bindingWhenMissing(key: string): string {
  return BINDING_WHEN_MISSING[key] ?? "";
}

export function missingBindings(): [string, string][] {
  return Object.entries(BINDING_WHEN_MISSING);
}

export function formatChord(binding: string): string {
  return binding
    .split("+")
    .map((part) => {
      if (part === "prefix") return "Prefix";
      if (part === "ctrl") return "Ctrl";
      if (part === "alt") return "Alt";
      if (part === "shift") return "Shift";
      if (part === "tab") return "Tab";
      if (part === "enter") return "Enter";
      if (part === ",") return "Comma";
      if (part === ".") return "Period";
      if (part === "?") return "?";
      if (part === "1..9") return "1 to 9";
      if (part.length === 1) return part.toUpperCase();
      return part[0].toUpperCase() + part.slice(1);
    })
    .join("+");
}

const DIRS = ["left", "right", "up", "down"] as const;

export interface DeskAction {
  id: string;
  does: string;
  /** Default comma-separated chords. A comma that is the key itself stays inside the chord. */
  defaults: string;
  /** Herdr key ids that seed this action until the panels list is saved. */
  herdr?: string[];
  /** A pressed number is stored as 1 through 9. */
  indexed?: boolean;
  /** Only while a spaces, agents, or files row is focused. */
  list?: boolean;
  /** Ignore a held key. */
  once?: boolean;
}

export const DESK_ACTIONS: DeskAction[] = [
  {
    id: "focus",
    does: "Focus the panel in that direction",
    defaults:
      "alt+shift+left, alt+shift+right, alt+shift+up, alt+shift+down, prefix+left, prefix+right, prefix+up, prefix+down",
  },
  {
    id: "move",
    does: "Swap the focused panel with the one in that direction",
    defaults: "prefix+alt+left, prefix+alt+right, prefix+alt+up, prefix+alt+down",
    once: true,
  },
  {
    id: "cycle-next",
    does: "Focus the next panel",
    defaults: "prefix+tab",
    herdr: ["cycle_pane_next"],
  },
  {
    id: "cycle-prev",
    does: "Focus the previous panel",
    defaults: "prefix+shift+tab",
    herdr: ["cycle_pane_previous"],
  },
  {
    id: "zoom",
    does: "Fill the screen with the focused panel, or show the whole desk",
    defaults: "prefix+f",
    once: true,
  },
  {
    id: "space-next",
    does: "Switch to the next space",
    defaults: "prefix+alt+n",
    herdr: ["next_workspace"],
  },
  {
    id: "space-prev",
    does: "Switch to the previous space",
    defaults: "prefix+alt+p",
    herdr: ["previous_workspace"],
  },
  {
    id: "space-index",
    does: "Switch to a space by number",
    defaults: "prefix+shift+1..9",
    herdr: ["switch_workspace"],
    indexed: true,
    once: true,
  },
  {
    id: "agent-next",
    does: "Switch to the next agent",
    defaults: "prefix+alt+.",
    herdr: ["next_agent"],
  },
  {
    id: "agent-prev",
    does: "Switch to the previous agent",
    defaults: "prefix+alt+,",
    herdr: ["previous_agent"],
  },
  {
    id: "agent-index",
    does: "Switch to an agent by number",
    defaults: "prefix+alt+1..9",
    herdr: ["focus_agent"],
    indexed: true,
    once: true,
  },
  {
    id: "address",
    does: "Focus the address bar",
    defaults: "prefix+g",
    herdr: ["goto"],
    once: true,
  },
  {
    id: "agents",
    does: "Focus the Agents panel",
    defaults: "prefix+a",
    once: true,
  },
  {
    id: "spaces",
    does: "Focus the Spaces panel",
    defaults: "prefix+b, prefix+w",
    herdr: ["toggle_sidebar", "workspace_picker"],
    once: true,
  },
  {
    id: "close",
    does: "Close the focused panel",
    defaults: "prefix+alt+w",
    once: true,
  },
  {
    id: "undo",
    does: "Go back in the selected panel",
    defaults: "prefix+z",
    once: true,
  },
  {
    id: "redo",
    does: "Go forward in the selected panel",
    defaults: "prefix+shift+z",
    once: true,
  },
  {
    id: "reopen",
    does: "Reopen the last closed panel",
    defaults: "prefix+t",
    once: true,
  },
  {
    id: "enter",
    does: "Type in the focused panel",
    defaults: "prefix+enter",
    once: true,
  },
  {
    id: "help",
    does: "Show or hide these shortcuts",
    defaults: "prefix+?",
    herdr: ["help"],
    once: true,
  },
  {
    id: "list-next",
    does: "Next row in a spaces, agents, or files list",
    defaults: "down",
    list: true,
  },
  {
    id: "list-prev",
    does: "Previous row in a spaces, agents, or files list",
    defaults: "up",
    list: true,
  },
  {
    id: "activate",
    does: "Open the highlighted space, agent, or file",
    defaults: "enter",
    list: true,
    once: true,
  },
];

const DESK_KEY_IDS = new Set(DESK_ACTIONS.flatMap((action) => action.herdr ?? []));

/** A Herdr key the desk handles, edited on the Panels tab of Keybinds. */
export function isDeskKey(key: string): boolean {
  return DESK_KEY_IDS.has(key);
}

export interface DeskHelpRow {
  id: string;
  keys: string;
  does: string;
}

export const DESK_KEYS_STORAGE = "herdr-panels.desk-keys";

/** Split on a comma that separates chords. A comma that is the key, as in prefix+alt+,, stays put. */
export function splitBindings(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "," && text[i - 1] !== "+" && /\s/.test(text[i + 1] ?? "")) {
      const item = current.trim();
      if (item) parts.push(item);
      current = "";
      continue;
    }
    current += text[i];
  }
  const item = current.trim();
  if (item) parts.push(item);
  return parts;
}

export function joinBindings(chords: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const chord of chords) {
    const text = chord.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out.join(", ");
}

export function sameBindingList(left: string, right: string): boolean {
  return joinBindings(splitBindings(left)) === joinBindings(splitBindings(right));
}

function modsOf(chord: Chord): string {
  const parts: string[] = [];
  if (chord.prefix) parts.push("prefix");
  if (chord.ctrl) parts.push("ctrl");
  if (chord.alt) parts.push("alt");
  if (chord.shift) parts.push("shift");
  if (chord.meta) parts.push("meta");
  return parts.join("+");
}

/** Four directions with the same modifiers read as one Arrows chord. */
export function summarizeBindings(text: string): string {
  const items = splitBindings(text);
  const used = new Set<number>();
  const out: string[] = [];
  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;
    const parsed = expandBinding(items[i]);
    const chord = parsed.length === 1 ? parsed[0] : null;
    if (chord && !chord.index && (DIRS as readonly string[]).includes(chord.key)) {
      const mods = modsOf(chord);
      const group = items.flatMap((item, index) => {
        const chords = expandBinding(item);
        const one = chords.length === 1 ? chords[0] : null;
        if (!one || one.index || modsOf(one) !== mods || !(DIRS as readonly string[]).includes(one.key)) return [];
        return [{ index, key: one.key }];
      });
      const keys = new Set(group.map((entry) => entry.key));
      if (DIRS.every((dir) => keys.has(dir))) {
        for (const entry of group) used.add(entry.index);
        out.push(formatChord(mods ? `${mods}+arrows` : "arrows"));
        continue;
      }
    }
    used.add(i);
    out.push(formatChord(items[i]));
  }
  return out.join(", ");
}

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "OS", "AltGraph", "Hyper", "Super"]);

/** The chord string for a keypress. Null for a modifier or Escape. */
export function recordChord(event: KeyPress, prefixArmed: boolean): string | null {
  if (!event.key || MODIFIER_KEYS.has(event.key) || event.key === "Escape" || event.key === "Dead") return null;
  const parts: string[] = [];
  if (prefixArmed) parts.push("prefix");
  if (event.ctrlKey) parts.push("ctrl");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  if (event.metaKey) parts.push("meta");
  const digit = event.code?.match(/^Digit([1-9])$/)?.[1];
  const key = digit ?? eventKey(event);
  if (!key) return null;
  parts.push(key);
  return parts.join("+");
}

export function widenDigit(chord: string): string {
  return chord.replace(/[1-9]$/, "1..9");
}

export function directionChord(chord: string): boolean {
  const parsed = expandBinding(chord);
  return parsed.length === 1 && (DIRS as readonly string[]).includes(parsed[0].key);
}

function sameChord(left: Chord, right: Chord): boolean {
  return (
    left.prefix === right.prefix &&
    left.ctrl === right.ctrl &&
    left.alt === right.alt &&
    left.shift === right.shift &&
    left.meta === right.meta &&
    left.key === right.key
  );
}

export function chordsOverlap(left: string, right: string): boolean {
  const a = expandBinding(left);
  const b = expandBinding(right);
  return a.some((one) => b.some((two) => sameChord(one, two)));
}

export function bindingConflict(chord: string, others: { chords: string; does: string }[]): string | null {
  for (const other of others) {
    for (const existing of splitBindings(other.chords)) {
      if (chordsOverlap(chord, existing)) return other.does;
    }
  }
  return null;
}

export interface HerdrKeyField {
  key: string;
  value: unknown;
}

function herdrChord(id: string, herdr: HerdrKeyField[] | null | undefined): string {
  const field = herdr?.find((item) => item.key === id);
  if (!field || typeof field.value !== "string") return bindingWhenMissing(id);
  return effectiveBinding(id, field.value);
}

/** Saved panels chords win. Otherwise a Herdr key seeds the action, and a missing key uses the desk default. */
export function resolveDeskBindings(
  overrides: Record<string, string | undefined>,
  herdr: HerdrKeyField[] | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const action of DESK_ACTIONS) {
    if (Object.prototype.hasOwnProperty.call(overrides, action.id) && typeof overrides[action.id] === "string") {
      out[action.id] = overrides[action.id] ?? "";
      continue;
    }
    if (action.herdr?.length) {
      out[action.id] = joinBindings(action.herdr.map((id) => herdrChord(id, herdr)));
      continue;
    }
    out[action.id] = action.defaults;
  }
  return out;
}

export function readDeskOverrides(storage: { getItem(key: string): string | null } | null): Record<string, string> {
  if (!storage) return {};
  try {
    const parsed = JSON.parse(storage.getItem(DESK_KEYS_STORAGE) || "");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const action of DESK_ACTIONS) {
      const value = (parsed as Record<string, unknown>)[action.id];
      if (typeof value === "string") out[action.id] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeDeskOverrides(
  storage: { setItem(key: string, value: string): void } | null,
  overrides: Record<string, string>,
): void {
  if (!storage) return;
  try {
    storage.setItem(DESK_KEYS_STORAGE, JSON.stringify(overrides));
  } catch {
    // The list in memory still applies for this visit.
  }
}

export function deskHelpRows(bindings: Record<string, string>): DeskHelpRow[] {
  return DESK_ACTIONS.flatMap((action) => {
    const text = bindings[action.id] ?? "";
    if (!splitBindings(text).length) return [];
    return [{ id: action.id, keys: summarizeBindings(text), does: action.does }];
  });
}

export const DESK_HELP: DeskHelpRow[] = deskHelpRows(resolveDeskBindings({}, undefined));

function directionOf(key: string): Direction | null {
  if (key === "left" || key === "right" || key === "up" || key === "down") return key;
  return null;
}

function commandFor(action: DeskAction, chord: Chord): DeskMatch | null {
  const direction = directionOf(chord.key);
  const index = chord.index ?? (/^[1-9]$/.test(chord.key) ? Number(chord.key) : 0);
  switch (action.id) {
    case "focus":
      return direction ? { action: "focus", direction } : null;
    case "move":
      return direction ? { action: "move", direction } : null;
    case "cycle-next":
      return { action: "cycle-panel", delta: 1 };
    case "cycle-prev":
      return { action: "cycle-panel", delta: -1 };
    case "zoom":
      return { action: "zoom" };
    case "space-next":
      return { action: "cycle-space", delta: 1 };
    case "space-prev":
      return { action: "cycle-space", delta: -1 };
    case "space-index":
      return index ? { action: "space", index } : null;
    case "agent-next":
      return { action: "cycle-agent", delta: 1 };
    case "agent-prev":
      return { action: "cycle-agent", delta: -1 };
    case "agent-index":
      return index ? { action: "agent", index } : null;
    case "address":
      return { action: "address" };
    case "agents":
      return { action: "agents" };
    case "spaces":
      return { action: "spaces" };
    case "close":
      return { action: "close" };
    case "undo":
      return { action: "undo" };
    case "redo":
      return { action: "redo" };
    case "reopen":
      return { action: "reopen" };
    case "enter":
      return { action: "enter" };
    case "help":
      return { action: "help" };
    case "list-next":
      return { action: "list", delta: 1 };
    case "list-prev":
      return { action: "list", delta: -1 };
    case "activate":
      return { action: "activate" };
    default:
      return null;
  }
}

function modifierScore(chord: Chord): number {
  return Number(chord.ctrl) + Number(chord.alt) + Number(chord.shift) + Number(chord.meta);
}

/**
 * The most specific matching chord wins, so Prefix+Shift+Tab is previous
 * even though a bare Prefix+Tab would also see that key.
 */
export function matchDesk(
  bindings: Record<string, string>,
  event: KeyPress,
  prefix: boolean,
  includeList = false,
): DeskMatch | null {
  let best: { command: DeskMatch; score: number } | null = null;
  for (const action of DESK_ACTIONS) {
    if (action.list && !includeList) continue;
    if (action.once && event.repeat) continue;
    for (const spec of splitBindings(bindings[action.id] ?? "")) {
      for (const chord of expandBinding(spec)) {
        if (!chordMatches(chord, event, prefix)) continue;
        const command = commandFor(action, chord);
        if (!command) continue;
        const score = modifierScore(chord);
        if (!best || score > best.score) best = { command, score };
      }
    }
  }
  return best?.command ?? null;
}

export function asDeskCommand(match: DeskMatch | null): DeskCommand | null {
  if (!match || match.action === "list" || match.action === "activate") return null;
  return match;
}

/** Default desk chords, including the ones an older server omits from Herdr. */
export function deskCommand(event: KeyPress, prefix: boolean): DeskCommand | null {
  return asDeskCommand(matchDesk(resolveDeskBindings({}, undefined), event, prefix));
}

export function listDelta(event: KeyPress): 1 | -1 | null {
  if (event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return null;
  if (event.key === "ArrowDown") return 1;
  if (event.key === "ArrowUp") return -1;
  return null;
}

/** A prefix chord moves panels. The list only takes a bare arrow. */
export function arrowMovesList(event: KeyPress, prefix: boolean): boolean {
  return matchDesk(resolveDeskBindings({}, undefined), event, prefix, true)?.action === "list";
}

function center(box: Box): { x: number; y: number } {
  return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
}

const EDGE = 4;

function pastEdge(from: Box, box: Box, direction: Direction): boolean {
  if (direction === "right") return box.left >= from.right - EDGE;
  if (direction === "left") return box.right <= from.left + EDGE;
  if (direction === "down") return box.top >= from.bottom - EDGE;
  return box.bottom <= from.top + EDGE;
}

export function focusInDirection(boxes: Box[], fromId: string, direction: Direction): string | null {
  const from = boxes.find((box) => box.id === fromId);
  if (!from) return null;
  const origin = center(from);
  let best: { id: string; score: number; cross: number } | null = null;
  for (const box of boxes) {
    if (box.id === fromId || !pastEdge(from, box, direction)) continue;
    const point = center(box);
    const score = (point.x - origin.x) ** 2 + (point.y - origin.y) ** 2;
    const cross = direction === "up" || direction === "down" ? point.x : point.y;
    if (!best || score < best.score - 0.01 || (Math.abs(score - best.score) <= 0.01 && cross < best.cross)) {
      best = { id: box.id, score, cross };
    }
  }
  return best?.id ?? null;
}

export function readingOrder(boxes: Box[]): string[] {
  return [...boxes]
    .sort((left, right) => left.top - right.top || left.left - right.left || left.id.localeCompare(right.id))
    .map((box) => box.id);
}

export function stepIndex(length: number, index: number, delta: number): number {
  if (length <= 0) return -1;
  if (index < 0) return delta < 0 ? length - 1 : 0;
  return (index + delta + length) % length;
}

function activeConfig(panel: PanelConfig): PanelConfig {
  if (panel.type !== "tabs") return panel;
  return panel.tabs.find((tab) => tab.id === panel.active)?.panel ?? panel.tabs[0]?.panel ?? panel;
}

export function panelRefs(panels: { id: string; panel: PanelConfig }[]): PanelRef[] {
  return panels.map((panel) => {
    const content = activeConfig(panel.panel);
    const paneId = content.type === "herdr" || content.type === "chat" ? (content.paneId ?? null) : null;
    return { id: panel.id, kind: content.type, paneId, terminal: panel.panel.type === "herdr" };
  });
}

export function panelForPane(
  panels: PanelRef[],
  paneId: string,
  preferId: string | null,
): { id: string; rebind: boolean } | null {
  const showing = panels.find((panel) => panel.paneId === paneId);
  if (showing) return { id: showing.id, rebind: false };
  const preferred = preferId ? panels.find((panel) => panel.id === preferId && panel.terminal) : undefined;
  if (preferred) return { id: preferred.id, rebind: true };
  const first = panels.find((panel) => panel.terminal);
  if (first) return { id: first.id, rebind: true };
  return null;
}

export function panelForKind(panels: PanelRef[], kind: string): string | null {
  return panels.find((panel) => panel.kind === kind)?.id ?? null;
}

export function layoutForFocusedPane(root: LayoutNode, paneId: string): LayoutNode {
  if (panelRefs(listPanels(root)).some((panel) => panel.paneId === paneId)) return root;
  return bindTerminalPane(root, paneId);
}

interface TerminalSlot {
  panelId: string;
  tabId: string | null;
  paneId: string | null;
  active: boolean;
  scope: "space" | "pane";
}

function terminalSlots(root: LayoutNode): TerminalSlot[] {
  const slots: TerminalSlot[] = [];
  for (const panel of listPanels(root)) {
    if (panel.panel.type === "tabs") {
      for (const tab of panel.panel.tabs) {
        if (tab.panel.type !== "herdr") continue;
        slots.push({
          panelId: panel.id,
          tabId: tab.id,
          paneId: tab.panel.paneId ?? null,
          active: tab.id === panel.panel.active,
          scope: tab.panel.scope === "pane" ? "pane" : "space",
        });
      }
      continue;
    }
    if (panel.panel.type !== "herdr") continue;
    slots.push({
      panelId: panel.id,
      tabId: null,
      paneId: panel.panel.paneId ?? null,
      active: true,
      scope: panel.panel.scope === "pane" ? "pane" : "space",
    });
  }
  return slots;
}

function withSlotPane(root: LayoutNode, slot: TerminalSlot, paneId: string): LayoutNode {
  const panel = findPanel(root, slot.panelId);
  if (!panel) return root;
  if (panel.panel.type === "tabs" && slot.tabId) {
    const showing = panel.panel.tabs.some(
      (tab) => tab.id === slot.tabId && tab.panel.type === "herdr" && (tab.panel.paneId ?? null) === paneId,
    );
    if (showing && panel.panel.active === slot.tabId) return root;
    return setPanel(root, slot.panelId, {
      ...panel.panel,
      active: slot.tabId,
      tabs: panel.panel.tabs.map((tab) =>
        tab.id === slot.tabId && tab.panel.type === "herdr" ? { ...tab, panel: { ...tab.panel, paneId } } : tab,
      ),
    });
  }
  if (panel.panel.type === "herdr") {
    if ((panel.panel.paneId ?? null) === paneId) return root;
    return setPanel(root, slot.panelId, { ...panel.panel, paneId });
  }
  return root;
}

function preferredSlot(slots: TerminalSlot[], preferId: string | null): TerminalSlot | undefined {
  if (preferId) {
    const matches = slots.filter((slot) => slot.panelId === preferId);
    const chosen = matches.find((slot) => slot.active) ?? matches[0];
    if (chosen) return chosen;
  }
  return slots[0];
}

/** Show `paneId` in this layout. Rebind Panes, or open that panel when the space has none. A Terminal panel (`scope: "pane"`) is left as it is. */
export function revealPaneOnDesk(
  root: LayoutNode,
  paneId: string,
  preferId: string | null,
): { root: LayoutNode; panelId: string } {
  const slots = terminalSlots(root);
  const showing = slots.find((slot) => slot.paneId === paneId);
  if (showing) return { root: withSlotPane(root, showing, paneId), panelId: showing.panelId };
  const target = preferredSlot(
    slots.filter((slot) => slot.scope !== "pane"),
    preferId,
  );
  if (target) return { root: withSlotPane(root, target, paneId), panelId: target.panelId };
  const created: PanelNode = {
    type: "panel",
    id: freshPanelId(root),
    title: null,
    panel: { type: "herdr", paneId },
  };
  const host = listPanels(root).at(-1);
  if (!host) return { root: created, panelId: created.id };
  return { root: splitPanel(root, host.id, "row", created), panelId: created.id };
}

/**
 * The desk after a plugin focuses a pane. A different workspace uses that space's
 * layout. The current layout is left unchanged.
 */
export function layoutForPaneFocus(
  currentWorkspace: string | null,
  currentRoot: LayoutNode,
  workspaceId: string,
  targetRoot: LayoutNode,
  paneId: string,
  preferId: string | null,
): { workspaceId: string; root: LayoutNode; panelId: string } {
  const switched = Boolean(workspaceId) && workspaceId !== currentWorkspace;
  const revealed = revealPaneOnDesk(switched ? targetRoot : currentRoot, paneId, switched ? null : preferId);
  return {
    workspaceId: workspaceId || currentWorkspace || "",
    root: revealed.root,
    panelId: revealed.panelId,
  };
}

/** Ask the open desk to show a pane. Returns the panel id, or null when the desk is not ready. */
export function requestPaneReveal(paneId: string, workspaceId: string): string | null {
  if (typeof window === "undefined" || !paneId) return null;
  const hook = (window as Window & { __hwpRevealPane?: (paneId: string, workspaceId: string) => string | null })
    .__hwpRevealPane;
  if (!hook) return null;
  return hook(paneId, workspaceId) || null;
}
