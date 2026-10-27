import type { LayoutNode } from "./types";
import { readPins, writePins, type PinRecord } from "./pins";
import { readSpaceLayouts, replaceSpaceLayouts } from "./spaceLayout";
import { silenceDesk } from "./deskBus";

export interface DeskSnapshot {
  pins: PinRecord[];
  spaces: Record<string, LayoutNode>;
}

export function deskHasContent(desk: DeskSnapshot): boolean {
  return desk.pins.length > 0 || Object.keys(desk.spaces).length > 0;
}

/** Which desk to show, and whether this browser should upload its local copy. */
export function chooseDesk(
  server: DeskSnapshot,
  local: DeskSnapshot,
  migrated: boolean,
): { desk: DeskSnapshot; upload: boolean } {
  if (!migrated && deskHasContent(local)) return { desk: local, upload: true };
  return { desk: server, upload: false };
}

const MIGRATED_KEY = "herdr-panels.desk-migrated";
let revision = 0;

export function deskRevision(): number {
  return revision;
}

export function setDeskRevision(next: number) {
  revision = next;
}

export function deskMigrated(): boolean {
  try {
    return localStorage.getItem(MIGRATED_KEY) === "1";
  } catch {
    return false;
  }
}

export function markDeskMigrated() {
  try {
    localStorage.setItem(MIGRATED_KEY, "1");
  } catch {
    // The server copy is still the desk. The next load can try again.
  }
}

export function readLocalDesk(): DeskSnapshot {
  return { pins: readPins(), spaces: readSpaceLayouts() };
}

export function installDesk(desk: DeskSnapshot, nextRevision: number) {
  silenceDesk(() => {
    writePins(desk.pins);
    replaceSpaceLayouts(desk.spaces);
  });
  revision = nextRevision;
}
