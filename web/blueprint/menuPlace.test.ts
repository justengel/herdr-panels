import { describe, expect, it } from "vitest";
import { fitMenu } from "../src/menuPlace";

const view = { width: 1280, height: 800 };

function inside(box: { left: number; top: number; maxWidth: number; maxHeight: number }, width: number, height: number) {
  const usedWidth = Math.min(width, box.maxWidth);
  const usedHeight = Math.min(height, box.maxHeight);
  expect(box.left).toBeGreaterThanOrEqual(8);
  expect(box.top).toBeGreaterThanOrEqual(8);
  expect(box.left + usedWidth).toBeLessThanOrEqual(view.width - 8);
  expect(box.top + usedHeight).toBeLessThanOrEqual(view.height - 8);
}

describe("menus stay inside the window", () => {
  it("slides a right-aligned menu back in when the panel is against the left edge", () => {
    const box = fitMenu({ left: -48, top: 36, width: 220, height: 280 }, view);
    inside(box, 220, 280);
    expect(box.left).toBe(8);
    expect(box.top).toBe(36);
  });

  it("lifts a menu that would run off the bottom", () => {
    const box = fitMenu({ left: 400, top: 640, width: 220, height: 280 }, view);
    inside(box, 220, 280);
    expect(box.top).toBe(800 - 8 - 280);
  });

  it("pulls an upward menu down when it starts above the window", () => {
    const box = fitMenu({ left: 900, top: -40, width: 168, height: 168 }, view);
    inside(box, 168, 168);
    expect(box.top).toBe(8);
  });

  it("caps a menu that is taller and wider than the window", () => {
    const box = fitMenu({ left: 20, top: 20, width: 2000, height: 2000 }, view);
    inside(box, 2000, 2000);
    expect(box.left).toBe(8);
    expect(box.top).toBe(8);
    expect(box.maxWidth).toBe(view.width - 16);
    expect(box.maxHeight).toBe(view.height - 16);
  });

  it("leaves a menu that already fits where it opened", () => {
    const box = fitMenu({ left: 240, top: 120, width: 220, height: 180 }, view);
    expect(box.left).toBe(240);
    expect(box.top).toBe(120);
  });
});
