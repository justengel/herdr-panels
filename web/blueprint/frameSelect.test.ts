import { describe, expect, it } from "vitest";
import { intersects, shiftRect, toFrame } from "../src/frameSelect";

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
});
