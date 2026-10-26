import { describe, expect, it } from "vitest";
import { openFileBeside } from "../src/fileOpen";

describe("opening a file from the explorer", () => {
  it("opens each file as a new split beside the explorer", () => {
    expect(openFileBeside("panel-files", "C:\\Users\\notes.txt")).toEqual({
      target: "C:\\Users\\notes.txt",
      from: "panel-files",
      direction: "right",
    });
  });
});
