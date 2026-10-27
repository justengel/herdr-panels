import { describe, expect, it } from "vitest";
import { createContextMenuGuard, suppressContextMenu } from "../src/contextMenuGuard";

describe("suppressContextMenu", () => {
  it("ignores the menu Windows sends after a left-button drag or a click that opens a panel", () => {
    expect(suppressContextMenu({ button: 0, ctrlKey: false, metaKey: false })).toBe(true);
  });

  it("keeps a real right-click", () => {
    expect(suppressContextMenu({ button: 2, ctrlKey: false, metaKey: false })).toBe(false);
  });

  it("keeps Ctrl or Command click, which is the context menu on some systems", () => {
    expect(suppressContextMenu({ button: 0, ctrlKey: true, metaKey: false })).toBe(false);
    expect(suppressContextMenu({ button: 0, ctrlKey: false, metaKey: true })).toBe(false);
  });

  it("does nothing when no pointer gesture is in progress", () => {
    expect(suppressContextMenu(null)).toBe(false);
  });
});

describe("createContextMenuGuard", () => {
  const left = { button: 0, buttons: 1, ctrlKey: false, metaKey: false };
  const right = { button: 2, buttons: 2, ctrlKey: false, metaKey: false };

  it("swallows the menu Windows sends for the panel under a left-button drag", () => {
    const guard = createContextMenuGuard();
    guard.pointerDown({ ...left, time: 0 });
    guard.pointerDown({ ...right, buttons: 1, time: 40 });
    expect(guard.swallow(50)).toBe(true);
  });

  it("swallows the menu that arrives just after the left button comes up on another panel", () => {
    const guard = createContextMenuGuard();
    guard.pointerDown({ ...left, time: 0 });
    guard.pointerUp({ button: 0, time: 100 });
    guard.pointerDown({ ...right, time: 130 });
    expect(guard.swallow(140)).toBe(true);
  });

  it("still opens a real right-click after the drag has settled", () => {
    const guard = createContextMenuGuard();
    guard.pointerDown({ ...left, time: 0 });
    guard.pointerUp({ button: 0, time: 100 });
    guard.pointerDown({ ...right, time: 700 });
    expect(guard.swallow(710)).toBe(false);
  });
});
