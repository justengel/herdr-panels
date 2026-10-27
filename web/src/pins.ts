import type { PanelConfig } from "./types";
import { touchDesk } from "./deskBus";

const STORAGE_KEY = "herdr-panels.pins";

export interface PinRecord {
  id: string;
  title: string;
  panel: PanelConfig;
  /** "all" covers every space, including ones created later. "chosen" covers only `spaces`. */
  mode: "all" | "chosen";
  /** For "all", the spaces to skip. For "chosen", the only spaces that receive the pin. */
  spaces: string[];
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readPins(): PinRecord[] {
  const local = storage();
  if (!local) return [];
  try {
    const raw = local.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPin) as PinRecord[];
  } catch {
    return [];
  }
}

function isPin(value: unknown): value is PinRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as PinRecord;
  return (
    typeof item.id === "string" &&
    typeof item.title === "string" &&
    item.panel !== null &&
    typeof item.panel === "object" &&
    (item.mode === "all" || item.mode === "chosen") &&
    Array.isArray(item.spaces)
  );
}

export function writePins(pins: PinRecord[]) {
  const local = storage();
  if (!local) return;
  try {
    local.setItem(STORAGE_KEY, JSON.stringify(pins));
    touchDesk();
  } catch {
    // The desk is also saved with the herdr-panels server.
  }
}

export function findPin(panelId: string): PinRecord | null {
  return readPins().find((pin) => pin.id === panelId) ?? null;
}

export function upsertPin(pin: PinRecord) {
  const pins = readPins().filter((item) => item.id !== pin.id);
  pins.push(pin);
  writePins(pins);
}

export function removePin(panelId: string) {
  writePins(readPins().filter((pin) => pin.id !== panelId));
}

/**
 * Skip this space. All spaces stays all spaces and records an exclusion, so a space
 * created later still receives the pin. A chosen list that becomes empty is removed.
 * `allSpaceIds` is unused: exclusions are not a snapshot of the spaces that exist now.
 */
export function unpinFromSpace(panelId: string, spaceId: string, _allSpaceIds: string[]): PinRecord | null {
  const pin = findPin(panelId);
  if (!pin || !spaceId) return pin;
  if (pin.mode === "all") {
    if (pin.spaces.includes(spaceId)) return pin;
    const next: PinRecord = { ...pin, spaces: [...pin.spaces, spaceId] };
    upsertPin(next);
    return next;
  }
  const rest = pin.spaces.filter((id) => id !== spaceId);
  if (rest.length === 0) {
    removePin(panelId);
    return null;
  }
  const next: PinRecord = { ...pin, spaces: rest };
  upsertPin(next);
  return next;
}

export function canPinPanel(panel: PanelConfig): boolean {
  return panel.type !== "herdr" && panel.type !== "blank";
}

export function pinApplies(pin: PinRecord, workspaceId: string): boolean {
  if (pin.mode === "all") return !pin.spaces.includes(workspaceId);
  return pin.spaces.includes(workspaceId);
}

/** Dialog selection. All spaces stores the unchecked rows as exclusions. */
export function pinDraft(
  allSpaces: boolean,
  checked: string[],
  spaceIds: string[],
): { mode: "all" | "chosen"; spaces: string[] } {
  if (allSpaces) return { mode: "all", spaces: spaceIds.filter((id) => !checked.includes(id)) };
  return { mode: "chosen", spaces: checked };
}
