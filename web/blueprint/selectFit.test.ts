import { describe, expect, it } from "vitest";
import { chooseRect, cssForVisual, reportedOffset, shiftBox } from "../src/selectFit";

describe("browser select boxes", () => {
  it("drops the window inset when a corner probe is hit at the origin but reported elsewhere", () => {
    // Top strip and the panels to the left of a right-hand tab put the webview here.
    const offset = reportedOffset({ left: 248, top: 86 }, true);
    expect(offset).toEqual({ x: 248, y: 86 });
    expect(shiftBox({ left: 280, top: 110, width: 90, height: 28 }, offset)).toEqual({
      left: 32,
      top: 24,
      width: 90,
      height: 28,
    });
  });

  it("leaves a box alone when the corner probe already agrees with the pointer", () => {
    expect(reportedOffset({ left: 0.2, top: -0.2 }, true)).toEqual({ x: 0, y: 0 });
    expect(reportedOffset({ left: 248, top: 86 }, false)).toEqual({ x: 0, y: 0 });
  });

  it("picks the rectangle the pointer actually hits", () => {
    const raw = { left: 40, top: 20, width: 30, height: 16 };
    expect(chooseRect(raw, 1.5, () => true)).toEqual(raw);
    expect(chooseRect(raw, 1.5, (box) => box.left === 60)).toEqual({
      left: 60,
      top: 30,
      width: 45,
      height: 24,
    });
    expect(chooseRect(raw, 2, (box) => box.left === 20)).toEqual({
      left: 20,
      top: 10,
      width: 15,
      height: 8,
    });
    expect(chooseRect(raw, 1, () => false)).toEqual(raw);
  });

  it("solves the css position that lands on the element", () => {
    const visual = { left: 100, top: 50, width: 40, height: 20 };
    expect(cssForVisual(visual, visual)).toEqual(visual);
    expect(cssForVisual(visual, { left: 200, top: 100, width: 80, height: 40 })).toEqual({
      left: 50,
      top: 25,
      width: 20,
      height: 10,
    });
    expect(cssForVisual(visual, { left: 130, top: 90, width: 40, height: 20 })).toEqual({
      left: 70,
      top: 10,
      width: 40,
      height: 20,
    });
  });
});
