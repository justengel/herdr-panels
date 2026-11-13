import { describe, expect, it } from "vitest";
import { frameBox, framePoint, frameRect, intersects, scaledRect, shiftRect, toFrame } from "../src/frameSelect";

describe("selection inside a framed page", () => {
  const frame = { left: 400, top: 80, width: 500, height: 360 };

  it("moves a frame-local box into the window", () => {
    expect(shiftRect(frame, { x: 16, y: 24, width: 120, height: 40 })).toEqual({
      left: 416,
      top: 104,
      width: 120,
      height: 40,
      right: 536,
      bottom: 144,
    });
  });

  it("describes a window box in the frame's own coordinates", () => {
    expect(toFrame(frame, { left: 420, top: 100, width: 80, height: 30 })).toEqual({
      x: 20,
      y: 20,
      width: 80,
      height: 30,
    });
  });

  it("knows when a drag misses the frame", () => {
    expect(intersects(frame, { left: 0, top: 0, width: 40, height: 40 })).toBe(false);
    expect(intersects(frame, { left: 380, top: 70, width: 40, height: 40 })).toBe(true);
  });

  it("leaves a box where it is when the page is not zoomed", () => {
    expect(scaledRect({ left: 10, top: 20, width: 30, height: 40 }, 1)).toEqual({
      left: 10,
      top: 20,
      width: 30,
      height: 40,
      right: 40,
      bottom: 60,
    });
  });

  it("moves a zoomed element to where the page paints it", () => {
    expect(scaledRect({ left: 110, top: 210, width: 40, height: 20 }, 2)).toEqual({
      left: 220,
      top: 420,
      width: 80,
      height: 40,
      right: 300,
      bottom: 460,
    });
  });

  it("maps a pointer through a zoomed frame and back to the screen", () => {
    const origin = { left: 40 / 1.5, top: 114 / 1.5 };
    const local = framePoint(origin, 1.5, 55, 129);
    expect(local.x).toBeCloseTo(10, 4);
    expect(local.y).toBeCloseTo(10, 4);
    const screen = frameRect(origin, 1.5, { x: 10, y: 10, width: 80, height: 28 });
    expect(screen.left).toBeCloseTo(55, 4);
    expect(screen.top).toBeCloseTo(129, 4);
    expect(screen.width).toBeCloseTo(120, 4);
    expect(screen.height).toBeCloseTo(42, 4);
    expect(frameBox(origin, 1.5, screen)).toEqual({
      x: expect.closeTo(10, 4),
      y: expect.closeTo(10, 4),
      width: expect.closeTo(80, 4),
      height: expect.closeTo(28, 4),
    });
  });
});
