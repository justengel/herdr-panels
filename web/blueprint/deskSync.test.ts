import { describe, expect, it } from "vitest";
import { chooseDesk, type DeskSnapshot } from "../src/deskSync";
import type { LayoutNode } from "../src/types";

const terminal: LayoutNode = {
  type: "panel",
  id: "terminal",
  title: "Terminal",
  panel: { type: "herdr", paneId: null },
};

const notes: LayoutNode = {
  type: "panel",
  id: "notes",
  title: "Notes",
  panel: { type: "markdown", path: "a.md" },
};

const empty: DeskSnapshot = { pins: [], spaces: {} };

describe("desk sync", () => {
  it("uploads a browser desk that has not been stored with herdr-panels yet", () => {
    const local: DeskSnapshot = { pins: [], spaces: { wg: notes } };
    expect(chooseDesk(empty, local, false)).toEqual({ desk: local, upload: true });
  });

  it("uses the server desk once this browser has migrated", () => {
    const server: DeskSnapshot = { pins: [], spaces: { wg: notes } };
    const local: DeskSnapshot = { pins: [], spaces: { wg: terminal } };
    expect(chooseDesk(server, local, true)).toEqual({ desk: server, upload: false });
  });

  it("uses the server desk when this browser has nothing saved", () => {
    const server: DeskSnapshot = { pins: [], spaces: { wg: notes } };
    expect(chooseDesk(server, empty, false)).toEqual({ desk: server, upload: false });
  });
});
