import type { PanelConfig } from "./types";

const STORAGE_KEY = "herdr-panels.pins";

export interface PinRecord {
  id: string;
  title: string;
  panel: PanelConfig;
  mode: "all" | "chosen";
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
  } catch {
    // Pin state is best-effort until layouts persist it server-side.
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

/** Drop this space from a pin. All-spaces becomes chosen without this space. Empty → removed. */
export function unpinFromSpace(panelId: string, spaceId: string, allSpaceIds: string[]): PinRecord | null {
  const pin = findPin(panelId);
  if (!pin || !spaceId) return pin;
  const pool = pin.mode === "all" ? allSpaceIds : pin.spaces;
  const rest = pool.filter((id) => id !== spaceId);
  if (rest.length === 0) {
    removePin(panelId);
    return null;
  }
  const next: PinRecord = { ...pin, mode: "chosen", spaces: rest };
  upsertPin(next);
  return next;
}

export function canPinPanel(panel: PanelConfig): boolean {
  return panel.type !== "herdr" && panel.type !== "blank";
}

export function pinApplies(pin: PinRecord, workspaceId: string): boolean {
  if (pin.mode === "all") return true;
  return pin.spaces.includes(workspaceId);
}
