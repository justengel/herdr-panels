import { describe, expect, it } from "vitest";
import {
  applyScroll,
  fitScale,
  inputScroll,
  pageScroll,
  previewScroll,
  screenMoved,
  scrollDragTarget,
  scrollFromThumb,
  scrollThumb,
  pointerCell,
  viewportShift,
  scrollMetrics,
  viewBox,
  wheelScroll,
  fittedGrid,
  openingScreen,
  frameDraw,
} from "../src/terminalView";
import { consumeZoomWheel, nearestZoom, stepZoom, topBarCounterZoom, zoomChord } from "../src/displayZoom";

describe("terminal view", () => {
  it("keeps the panel grid when Herdr has not reported a larger one", () => {
    expect(viewBox({ cols: 80, rows: 24 }, 0, 0)).toEqual({ cols: 80, rows: 24 });
    expect(viewBox({ cols: 80, rows: 24 }, 80, 24)).toEqual({ cols: 80, rows: 24 });
    expect(viewBox({ cols: 80, rows: 24 }, 40, 12)).toEqual({ cols: 80, rows: 24 });
  });

  it("waits for a measured character cell before fitting the first grid", () => {
    expect(fittedGrid(800, 600, null)).toBeNull();
    expect(fittedGrid(800, 600, { w: 0, h: 17 })).toBeNull();
    expect(fittedGrid(0, 600, { w: 8.4, h: 17 })).toBeNull();
    expect(fittedGrid(800, 600, { w: 8.4, h: 17 })).toEqual({ cols: 95, rows: 35 });
    expect(fittedGrid(800, 600, { w: 9.6, h: 20 })).toEqual({ cols: 83, rows: 30 });
  });

  it("starts from the latest full screen that matches the settled grid", () => {
    const frames = [
      { text: "old", full: true, cols: 120, rows: 40 },
      { text: "partial", full: false, cols: 82, rows: 49 },
      { text: "full", full: true, cols: 82, rows: 49 },
      { text: "next", full: false, cols: 82, rows: 49 },
    ];
    expect(openingScreen(frames, 82, 49)).toEqual([
      { text: "full", full: true, cols: 82, rows: 49 },
      { text: "next", full: false, cols: 82, rows: 49 },
    ]);
    expect(openingScreen([{ text: "partial", full: false, cols: 82, rows: 49 }], 82, 49)).toEqual([]);
  });

  it("holds partial updates after a resize until a full screen for that grid arrives", () => {
    const grid = { cols: 82, rows: 49 };
    const held = frameDraw(true, { text: "diff", full: false, cols: 82, rows: 49 }, "old", grid);
    expect(held).toEqual({ waitingForFull: true, draw: false, reset: false, drawn: "old" });
    const wrong = frameDraw(true, { text: "other", full: true, cols: 80, rows: 24 }, "old", grid);
    expect(wrong.draw).toBe(false);
    expect(wrong.waitingForFull).toBe(true);
    const ready = frameDraw(true, { text: "screen", full: true, cols: 82, rows: 49 }, "old", grid);
    expect(ready).toEqual({ waitingForFull: false, draw: true, reset: true, drawn: "screen" });
    const same = frameDraw(false, { text: "screen", full: false, cols: 82, rows: 49 }, "screen", grid);
    expect(same.draw).toBe(false);
  });

  it("keeps the panel grid when Herdr's frame is larger, so the program wraps to the pane", () => {
    expect(viewBox({ cols: 80, rows: 24 }, 120, 40)).toEqual({ cols: 80, rows: 24 });
    expect(viewBox(null, 120, 40)).toBeNull();
  });

  it("sizes the thumb from the distance the pane can scroll", () => {
    const none = scrollMetrics(400, 40, 0, 0);
    expect(none.height).toBe(400);
    expect(none.top).toBe(0);

    const top = scrollMetrics(400, 20, 40, 40);
    expect(top.top).toBe(0);
    expect(top.height).toBeCloseTo((20 / 60) * 400, 5);

    const bottom = scrollMetrics(400, 20, 0, 40);
    expect(bottom.height).toBeCloseTo(top.height, 5);
    expect(bottom.top + bottom.height).toBeCloseTo(400, 5);
    expect(scrollFromThumb(400, bottom.height, bottom.top, 40)).toBe(0);
    expect(scrollFromThumb(400, top.height, top.top, 40)).toBe(40);
  });

  it("parks a short thumb at the live end until the pane's range is known", () => {
    expect(scrollThumb(400, 40, 0, 0)).toEqual({ top: 372, height: 28 });
    expect(scrollThumb(20, 40, 0, 0)).toEqual({ top: 0, height: 20 });
    const known = scrollThumb(400, 20, 40, 40);
    expect(known.top).toBe(0);
    expect(known.height).toBeCloseTo((20 / 60) * 400, 5);
  });

  it("maps a thumb drag onto Herdr's range, and probes one line per cell before that", () => {
    expect(scrollDragTarget(0, 0, -51, 17, 400, 372, 28)).toBe(3);
    expect(scrollDragTarget(0, 0, 34, 17, 400, 372, 28)).toBe(0);
    expect(scrollDragTarget(40, 40, 0, 17, 400, 0, (20 / 60) * 400)).toBe(40);
    const height = (20 / 60) * 400;
    const travel = 400 - height;
    expect(scrollDragTarget(40, 40, travel, 17, 400, 0, height)).toBe(0);
  });

  it("keeps the thumb size while a scroll is still inside the known range", () => {
    expect(previewScroll({ fromEnd: 0, extent: 0 }, "up", 3)).toEqual({ fromEnd: 0, extent: 0 });
    expect(previewScroll({ fromEnd: 40, extent: 40 }, "up", 3)).toEqual({ fromEnd: 40, extent: 40 });
    const moved = previewScroll({ fromEnd: 10, extent: 40 }, "up", 3);
    expect(moved).toEqual({ fromEnd: 13, extent: 40 });
    expect(previewScroll(moved, "down", 20)).toEqual({ fromEnd: 0, extent: 40 });
  });

  it("jumps back to the live input from any distance above it", () => {
    expect(inputScroll({ fromEnd: 0, extent: 40 })).toBe(0);
    expect(inputScroll({ fromEnd: 3, extent: 40 })).toBe(200);
    expect(inputScroll({ fromEnd: 480, extent: 480 })).toBe(480);
  });

  it("ignores a clock tick and notices a page that shifted", () => {
    const screen = ["a", "b", "c", "d", "e"].join("\n");
    const tick = ["a", "b", "c", "d", "12:01"].join("\n");
    const shifted = ["b", "c", "d", "e", "f"].join("\n");
    expect(screenMoved(screen, screen)).toBe(false);
    expect(screenMoved(screen, tick)).toBe(false);
    expect(screenMoved(screen, shifted)).toBe(true);
  });

  it("learns the top when a scroll no longer moves the screen", () => {
    const climbed = applyScroll({ fromEnd: 0, extent: 0 }, "up", 24, true);
    expect(climbed).toEqual({ fromEnd: 24, extent: 24 });
    const top = applyScroll(climbed, "up", 24, false);
    expect(top).toEqual({ fromEnd: 24, extent: 24 });
    const middle = applyScroll(top, "down", 10, true);
    expect(middle).toEqual({ fromEnd: 14, extent: 24 });
    expect(applyScroll(middle, "down", 40, false)).toEqual({ fromEnd: 0, extent: 24 });
  });

  it("scales a larger grid down so every cell stays inside the panel", () => {
    expect(fitScale(800, 600, 800, 600)).toBe(1);
    expect(fitScale(800, 600, 1600, 600)).toBe(0.5);
    expect(fitScale(800, 600, 800, 1200)).toBe(0.5);
    expect(fitScale(0, 600, 800, 600)).toBe(1);
  });

  it("turns a wheel notch into a Herdr scroll and ignores a resting wheel", () => {
    expect(wheelScroll(-100, 0)).toEqual({ direction: "up", lines: 3, source: "wheel" });
    expect(wheelScroll(100, 0)).toEqual({ direction: "down", lines: 3, source: "wheel" });
    expect(wheelScroll(0, 0)).toBeNull();
    expect(wheelScroll(Number.NaN, 0)).toBeNull();
  });

  it("turns page keys into a page of Herdr scroll", () => {
    expect(pageScroll("PageUp", 24)).toEqual({ direction: "up", lines: 24, source: "page_key" });
    expect(pageScroll("PageDown", 24)).toEqual({ direction: "down", lines: 24, source: "page_key" });
    expect(pageScroll("ArrowUp", 24)).toBeNull();
    expect(pageScroll("PageUp", 0)).toEqual({ direction: "up", lines: 1, source: "page_key" });
  });

  it("scrolls a drag that reaches the top or bottom edge", () => {
    expect(pointerCell(40, 200, 800, 400, 80, 24)).toMatchObject({ edge: null });
    expect(pointerCell(40, 396, 800, 400, 80, 24)?.edge).toBe("down");
    expect(pointerCell(40, 420, 800, 400, 80, 24)).toMatchObject({ row: 23, edge: "down" });
    expect(pointerCell(40, 2, 800, 400, 80, 24)?.edge).toBe("up");
    expect(pointerCell(40, -20, 800, 400, 80, 24)).toMatchObject({ row: 0, edge: "up" });
  });

  it("sees how many rows a scrolled screen moved", () => {
    const before = ["prompt", "name    size", "foo     12", "bar     4", "next"];
    expect(viewportShift(before, ["older", "prompt", "name    size", "foo     12", "bar     4"])).toBe(1);
    expect(viewportShift(before, ["name    size", "foo     12", "bar     4", "next", "newer"])).toBe(-1);
    expect(viewportShift(before, ["prompt", "name    size", "foo     99", "bar     4", "next"])).toBeNull();
    expect(viewportShift(before, before)).toBeNull();
  });
});

describe("display zoom", () => {
  it("steps through the browser scale list and stops at the ends", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(5, 1)).toBe(5);
    expect(stepZoom(0.25, -1)).toBe(0.25);
    expect(nearestZoom(1.2)).toBe(1.25);
  });

  it("recognizes the browser zoom chords", () => {
    expect(zoomChord({ key: "=", ctrlKey: true, metaKey: false, altKey: false })).toBe("in");
    expect(zoomChord({ key: "+", ctrlKey: true, metaKey: false, altKey: false })).toBe("in");
    expect(zoomChord({ key: "-", ctrlKey: true, metaKey: false, altKey: false })).toBe("out");
    expect(zoomChord({ key: "0", ctrlKey: false, metaKey: true, altKey: false })).toBe("reset");
    expect(zoomChord({ key: "0", ctrlKey: true, metaKey: false, altKey: true })).toBeNull();
    expect(zoomChord({ key: "a", ctrlKey: true, metaKey: false, altKey: false })).toBeNull();
  });

  it("keeps the session bar at its normal size while the window zooms", () => {
    expect(topBarCounterZoom(1)).toBe(1);
    expect(topBarCounterZoom(2)).toBe(0.5);
    expect(topBarCounterZoom(1.25)).toBeCloseTo(0.8);
    expect(topBarCounterZoom(0)).toBe(1);
    expect(topBarCounterZoom(Number.NaN)).toBe(1);
  });

  it("collects a trackpad gesture into one zoom step per notch", () => {
    const first = consumeZoomWheel(0, -40);
    expect(first).toEqual({ pending: -40, steps: 0 });
    expect(consumeZoomWheel(first.pending, -70)).toEqual({ pending: -10, steps: 1 });
    expect(consumeZoomWheel(0, 250)).toEqual({ pending: 50, steps: -2 });
  });
});
