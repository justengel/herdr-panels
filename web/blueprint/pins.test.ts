import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialAllSpaces } from "../src/components/PinDialog";
import { canPinPanel, findPin, readPins, removePin, unpinFromSpace, upsertPin } from "../src/pins";
import type { PanelConfig } from "../src/types";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe("pins", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });

  it("rejects terminal and blank panels", () => {
    expect(canPinPanel({ type: "herdr", paneId: null })).toBe(false);
    expect(canPinPanel({ type: "blank" })).toBe(false);
    expect(canPinPanel({ type: "markdown", path: "a.md" })).toBe(true);
  });

  it("stores and finds a pin for all spaces", () => {
    const panel: PanelConfig = { type: "markdown", path: "notes/welcome.md" };
    upsertPin({ id: "notes", title: "Notes", panel, mode: "all", spaces: [] });
    expect(findPin("notes")?.mode).toBe("all");
    expect(readPins()).toHaveLength(1);
  });

  it("updates and removes pins", () => {
    upsertPin({
      id: "charts",
      title: "Charts",
      panel: { type: "html", path: "panels/charts.html" },
      mode: "chosen",
      spaces: ["ws-a"],
    });
    upsertPin({
      id: "charts",
      title: "Charts",
      panel: { type: "html", path: "panels/charts.html" },
      mode: "all",
      spaces: [],
    });
    expect(findPin("charts")?.mode).toBe("all");
    removePin("charts");
    expect(findPin("charts")).toBeNull();
  });

  it("unpins from one space while keeping the pin elsewhere", () => {
    upsertPin({
      id: "spaces",
      title: "Spaces",
      panel: { type: "files" },
      mode: "all",
      spaces: [],
    });
    const next = unpinFromSpace("spaces", "ws-a", ["ws-a", "ws-b", "ws-c"]);
    expect(next).toEqual({
      id: "spaces",
      title: "Spaces",
      panel: { type: "files" },
      mode: "chosen",
      spaces: ["ws-b", "ws-c"],
    });
  });

  it("removes the pin when the last space is unpinned", () => {
    upsertPin({
      id: "notes",
      title: "Notes",
      panel: { type: "markdown", path: "a.md" },
      mode: "chosen",
      spaces: ["ws-a"],
    });
    expect(unpinFromSpace("notes", "ws-a", ["ws-a", "ws-b"])).toBeNull();
    expect(findPin("notes")).toBeNull();
  });

  it("defaults a new pin to the current space, except Spaces and Agents", () => {
    expect(initialAllSpaces(null, false)).toBe(false);
    expect(initialAllSpaces(null, true)).toBe(true);
    expect(initialAllSpaces({ id: "n", title: "N", panel: { type: "files" }, mode: "chosen", spaces: ["a"] }, true)).toBe(
      false,
    );
    expect(initialAllSpaces({ id: "n", title: "N", panel: { type: "files" }, mode: "all", spaces: [] }, false)).toBe(true);
  });
});
