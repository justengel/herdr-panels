import { describe, expect, it } from "vitest";
import { dropBeforeId, movedSpaceOrder, sameSpaceOrder, type SpaceDragRow } from "../src/spaceDrag";

const rows: SpaceDragRow[] = [
  { id: "a", top: 0, bottom: 20 },
  { id: "b", top: 20, bottom: 40 },
  { id: "c", top: 40, bottom: 60 },
];

describe("dragging a space", () => {
  it("lands before the row whose top half is under the pointer", () => {
    expect(dropBeforeId(rows, 5, "c")).toBe("a");
    expect(dropBeforeId(rows, 25, "c")).toBe("b");
  });

  it("lands before the next row when the pointer is in the bottom half", () => {
    expect(dropBeforeId(rows, 15, "c")).toBe("b");
  });

  it("lands at the end below the last other row", () => {
    expect(dropBeforeId(rows, 55, "a")).toBeNull();
  });

  it("ignores the row being dragged", () => {
    expect(dropBeforeId(rows, 50, "c")).toBeNull();
    expect(dropBeforeId(rows, 10, "a")).toBe("b");
  });

  it("moves a space before another and to the end", () => {
    expect(movedSpaceOrder(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(movedSpaceOrder(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
    expect(movedSpaceOrder(["a", "b", "c"], "a", "c")).toEqual(["b", "a", "c"]);
  });

  it("leaves the list alone when the drop is where the space already sits", () => {
    expect(sameSpaceOrder(["a", "b", "c"], "b", "c")).toBe(true);
    expect(sameSpaceOrder(["a", "b", "c"], "a", "b")).toBe(true);
    expect(sameSpaceOrder(["a", "b", "c"], "a", "c")).toBe(false);
    expect(sameSpaceOrder(["a", "b", "c"], "c", null)).toBe(true);
    expect(sameSpaceOrder(["a", "b", "c"], "b", "missing")).toBe(true);
  });
});
