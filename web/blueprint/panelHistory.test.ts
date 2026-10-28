import { describe, expect, it } from "vitest";
import { closePanel, describeClose, reopenPanel } from "../src/layoutEdit";
import { pushClosedPanel, takeClosedPanel } from "../src/panelHistory";
import type { LayoutNode } from "../src/types";

describe("closed panels", () => {
  it("reopens closed panels newest first and puts one back beside its neighbor", () => {
    const notes = { type: "panel" as const, id: "notes", title: "Notes", panel: { type: "markdown" as const, path: "n.md" } };
    const plug = { type: "panel" as const, id: "plug", title: "Plug", panel: { type: "plugin" as const, plugin: "desk-sample" } };
    const root: LayoutNode = { type: "split", direction: "row", ratio: 0.5, first: notes, second: plug };
    const closedPlug = describeClose(root, "plug");
    const withoutPlug = closePanel(root, "plug");
    expect(closedPlug?.anchorId).toBe("notes");
    expect(closedPlug?.place).toBe("right");
    const closedNotes = describeClose(withoutPlug!, "notes");
    let stack = pushClosedPanel([], closedNotes!);
    stack = pushClosedPanel(stack, closedPlug!);
    const newest = takeClosedPanel(stack, new Set());
    expect(newest.closed?.panel.id).toBe("plug");
    const restored = reopenPanel(withoutPlug!, newest.closed!);
    expect(restored?.type === "split" && restored.second.type === "panel" && restored.second.id).toBe("plug");
    const older = takeClosedPanel(newest.stack, new Set(["plug"]));
    expect(older.closed?.panel.id).toBe("notes");
    expect(takeClosedPanel(stack, new Set(["plug", "notes"])).closed).toBeNull();
  });
});
