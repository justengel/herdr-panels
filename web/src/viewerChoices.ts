import { applyAddressBarChoices } from "./addressBar";
import type { DeskSnapshot } from "./deskSync";
import type { PinRecord } from "./pins";
import type { LayoutNode } from "./types";
import { applyRawChoices } from "./rawText";
import { applyPluginSubjects, type StoredPluginView } from "./viewMenu";

export interface ViewerChoiceSet {
  addressBar: Record<string, boolean>;
  raw: Record<string, boolean>;
  plugins: Record<string, StoredPluginView>;
}

/** Copies address-bar, raw-text, and plugin-subject choices onto the panels that display them. */
export function bakeViewerChoices(root: LayoutNode, layoutId: string, choices: ViewerChoiceSet): LayoutNode {
  const addressed = applyAddressBarChoices(root, layoutId, choices.addressBar);
  const raw = applyRawChoices(addressed, layoutId, choices.raw);
  return applyPluginSubjects(raw, layoutId, choices.plugins);
}

function bakePin(pin: PinRecord, layoutId: string, choices: ViewerChoiceSet): PinRecord {
  const baked = bakeViewerChoices(
    { type: "panel", id: pin.id, title: pin.title, panel: pin.panel },
    layoutId,
    choices,
  );
  if (baked.type !== "panel") return pin;
  return { ...pin, panel: baked.panel };
}

/** Bakes viewer choices into every saved space and into pin records, which are copied onto panels later. */
export function bakeStoredDesk(desk: DeskSnapshot, layoutId: string, choices: ViewerChoiceSet): DeskSnapshot {
  const spaces: DeskSnapshot["spaces"] = {};
  for (const [key, root] of Object.entries(desk.spaces)) {
    spaces[key] = bakeViewerChoices(root, layoutId, choices);
  }
  return { pins: desk.pins.map((pin) => bakePin(pin, layoutId, choices)), spaces };
}
