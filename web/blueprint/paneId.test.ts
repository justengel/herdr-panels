import { describe, expect, it } from "vitest";
import { isHerdrPaneId } from "../src/paneId";

describe("herdr pane ids", () => {
  it("accepts workspace and pane parts", () => {
    expect(isHerdrPaneId("w8:pG")).toBe(true);
    expect(isHerdrPaneId("w1:p1")).toBe(true);
    expect(isHerdrPaneId("wK:p1")).toBe(true);
    expect(isHerdrPaneId("not a pane")).toBe(false);
    expect(isHerdrPaneId("w8:p")).toBe(false);
    expect(isHerdrPaneId("../w8:pG")).toBe(false);
  });
});
