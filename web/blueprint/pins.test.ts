import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialAllSpaces, initialChosen, pinFormKey } from "../src/components/PinDialog";
import { canPinPanel, findPin, pinApplies, pinDraft, readPins, removePin, unpinFromSpace, upsertPin } from "../src/pins";
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

  it("unpins from one space and still covers spaces created later", () => {
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
      mode: "all",
      spaces: ["ws-a"],
    });
    expect(pinApplies(next!, "ws-a")).toBe(false);
    expect(pinApplies(next!, "ws-b")).toBe(true);
    expect(pinApplies(next!, "ws-new")).toBe(true);
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

  it("keeps the pin form still when the space list is a new array with the same ids", () => {
    const pin = {
      id: "charts",
      title: "Charts",
      panel: { type: "html" as const, path: "charts.html" },
      mode: "chosen" as const,
      spaces: ["wG"],
    };
    const first = pinFormKey(pin, [{ id: "wG" }, { id: "wH" }], "wG", false);
    const again = pinFormKey({ ...pin, spaces: ["wG"] }, [{ id: "wG" }, { id: "wH" }], "wG", false);
    expect(again).toBe(first);
    expect(pinFormKey({ ...pin, mode: "all", spaces: [] }, [{ id: "wG" }, { id: "wH" }], "wG", false)).not.toBe(first);
  });

  it("keeps All spaces when a space is unchecked, and treats a full checklist as chosen", () => {
    const pin = {
      id: "notes",
      title: "Notes",
      panel: { type: "markdown" as const, path: "a.md" },
      mode: "all" as const,
      spaces: ["ws-a"],
    };
    expect(initialChosen(pin, [{ id: "ws-a" }, { id: "ws-b" }], "ws-b", true)).toEqual(["ws-b"]);
    expect(pinDraft(true, ["ws-b"], ["ws-a", "ws-b"])).toEqual({ mode: "all", spaces: ["ws-a"] });
    expect(pinDraft(false, ["ws-a", "ws-b"], ["ws-a", "ws-b"])).toEqual({
      mode: "chosen",
      spaces: ["ws-a", "ws-b"],
    });
  });
});
