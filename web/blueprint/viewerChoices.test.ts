import { describe, expect, it } from "vitest";
import type { LayoutNode } from "../src/types";
import { bakeStoredDesk, bakeViewerChoices } from "../src/viewerChoices";

const notes: LayoutNode = {
  type: "panel",
  id: "notes",
  title: "Notes",
  panel: { type: "markdown", path: "a.md" },
};

describe("viewer choices", () => {
  it("writes the browser's address, raw text, and plugin subject onto the panel", () => {
    const baked = bakeViewerChoices(notes, "desk", {
      addressBar: { "desk:notes": false },
      raw: { "desk:notes": true },
      plugins: {},
    });
    expect(baked).toMatchObject({
      panel: { addressBar: false, raw: true },
    });
    const plugin: LayoutNode = {
      type: "panel",
      id: "edit",
      title: "Edit",
      panel: { type: "plugin", plugin: "vim" },
    };
    expect(
      bakeViewerChoices(plugin, "desk", {
        addressBar: {},
        raw: {},
        plugins: { "desk:edit": { plugin: "vim", path: "a.md" } },
      }),
    ).toMatchObject({ panel: { path: "a.md" } });
    const desk = bakeStoredDesk(
      {
        pins: [
          {
            id: "notes",
            title: "Notes",
            panel: { type: "markdown", path: "a.md" },
            mode: "chosen",
            spaces: ["wG"],
          },
        ],
        spaces: { wg: notes },
      },
      "desk",
      {
        addressBar: { "desk:notes": false },
        raw: { "desk:notes": true },
        plugins: {},
      },
    );
    expect(desk.pins[0]?.panel).toMatchObject({ addressBar: false, raw: true });
    expect(desk.spaces.wg).toMatchObject({ panel: { addressBar: false, raw: true } });
  });
});
