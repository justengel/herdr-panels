import { describe, expect, it } from "vitest";
import { tabInsertIndex } from "../src/tabOrder";

describe("reordering tabs", () => {
  it("uses Herdr's insert index for a drop before another tab or at the end", () => {
    expect(tabInsertIndex(["a", "b", "c"], "a", "c")).toBe(2);
    expect(tabInsertIndex(["a", "b", "c"], "c", "a")).toBe(0);
    expect(tabInsertIndex(["a", "b", "c"], "b", null)).toBe(3);
  });

  it("skips a drop that leaves the tabs where they are", () => {
    expect(tabInsertIndex(["a", "b", "c"], "b", "c")).toBeNull();
    expect(tabInsertIndex(["a", "b", "c"], "c", null)).toBeNull();
    expect(tabInsertIndex(["a", "b", "c"], "missing", "a")).toBeNull();
  });
});
