import { describe, expect, it } from "vitest";
import { stripEnds } from "../src/tabOverflow";

describe("tab strip overflow", () => {
  it("shows nothing when every tab fits", () => {
    expect(stripEnds(0, 120, 120)).toEqual({ before: false, after: false });
  });

  it("marks the far end when the strip starts at the first tab", () => {
    expect(stripEnds(0, 80, 200)).toEqual({ before: false, after: true });
  });

  it("marks both ends while the window sits in the middle", () => {
    expect(stripEnds(40, 80, 200)).toEqual({ before: true, after: true });
  });

  it("marks the near end when the strip is scrolled to the last tab", () => {
    expect(stripEnds(120, 80, 200)).toEqual({ before: true, after: false });
  });

  it("ignores a one-pixel remainder so the mark does not flicker", () => {
    expect(stripEnds(1, 100, 101)).toEqual({ before: false, after: false });
  });
});
