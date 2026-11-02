import { describe, expect, it } from "vitest";
import { browserLeader, dropBrowser, holdBrowser } from "../src/browserPlace";

describe("browser window owner", () => {
  it("lets the visit show its panels and hides the rest without a second owner", () => {
    const ids = new Set(["a"]);
    const kept = new Set(["b"]);
    expect(browserLeader("visit", ids, kept, "a")).toEqual({ leader: true, hide: false });
    expect(browserLeader("desk", ids, kept, "a")).toEqual({ leader: false, hide: true });
    expect(browserLeader("keeper", ids, kept, "b")).toEqual({ leader: true, hide: true });
    expect(browserLeader("desk", ids, kept, "c")).toEqual({ leader: true, hide: true });
    expect(browserLeader("desk", null, new Set(), "c")).toEqual({ leader: true, hide: false });
  });

  it("keeps the desk browser when that panel is only being maximized", () => {
    const ids = new Set(["a"]);
    expect(browserLeader("desk", ids, new Set(), "a", "a")).toEqual({ leader: true, hide: false });
    expect(browserLeader("visit", ids, new Set(), "a", "a")).toEqual({ leader: false, hide: true });
    expect(browserLeader("desk", ids, new Set(), "a:tab-2", "a")).toEqual({ leader: true, hide: false });
    expect(browserLeader("desk", ids, new Set(), "b", "a")).toEqual({ leader: true, hide: true });
  });

  it("does not reload a page that is still open when maximize reclaims it", () => {
    const timers: Array<() => void> = [];
    const previous = globalThis.window;
    globalThis.window = {
      setTimeout: (fn: () => void) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimeout: () => undefined,
    } as unknown as Window & typeof globalThis;
    const first = holdBrowser("browser-panel-1");
    dropBrowser("browser-panel-1", first.generation, "https://google.com");
    const again = holdBrowser("browser-panel-1");
    expect(again.reload).toBe(false);
    expect(again.generation).toBe(first.generation);
    globalThis.window = previous;
  });
});
