import { describe, expect, it } from "vitest";
import { selectedText, type SelectableRoot, type TextSelection } from "../src/textSelect";

const inside = { id: "inside" };
const outside = { id: "outside" };
const root: SelectableRoot = {
  contains: (node) => node === inside,
};

function selection(text: string, anchor: unknown, focus: unknown, collapsed = false): TextSelection {
  return { collapsed, text, anchor, focus };
}

describe("text and markdown copy", () => {
  it("copies the highlighted characters, including spaces and line breaks", () => {
    expect(selectedText(root, selection("npm test", inside, inside))).toBe("npm test");
    expect(selectedText(root, selection("  keep   \nline", inside, inside))).toBe("  keep   \nline");
  });

  it("copies nothing for a click", () => {
    expect(selectedText(root, selection("", inside, inside, true))).toBeNull();
    expect(selectedText(root, selection("", inside, inside))).toBeNull();
  });

  it("copies nothing when the highlight crosses out of the panel", () => {
    expect(selectedText(root, selection("hello", outside, inside))).toBeNull();
    expect(selectedText(root, selection("hello", inside, outside))).toBeNull();
    expect(selectedText(root, null)).toBeNull();
  });
});
