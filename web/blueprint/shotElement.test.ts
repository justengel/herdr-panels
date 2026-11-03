import { describe, expect, it, vi } from "vitest";
import {
  anchoredOffset,
  disclosureArrow,
  disclosureHidden,
  isHtmlElement,
  isSelectionChrome,
  paintedBackground,
  SELECTION_CHROME,
  withTimeout,
} from "../src/shotElement";

describe("screenshot element checks", () => {
  it("accepts an element whose constructor belongs to another window", () => {
    class OtherHTMLElement {}
    const node = Object.create(OtherHTMLElement.prototype) as {
      nodeType: number;
      ownerDocument: { defaultView: { HTMLElement: typeof OtherHTMLElement } };
    };
    node.nodeType = 1;
    node.ownerDocument = { defaultView: { HTMLElement: OtherHTMLElement } };
    class LocalHTMLElement {}
    expect(node instanceof LocalHTMLElement).toBe(false);
    expect(isHtmlElement(node)).toBe(true);
  });

  it("rejects a missing node and a text node", () => {
    expect(isHtmlElement(null)).toBe(false);
    expect(isHtmlElement(undefined)).toBe(false);
    class Html {}
    expect(isHtmlElement({ nodeType: 3, ownerDocument: { defaultView: { HTMLElement: Html } } })).toBe(false);
  });

  it("rejects an element when it is not an instance of its document's HTMLElement", () => {
    class OtherHTMLElement {}
    const node = Object.create(OtherHTMLElement.prototype) as {
      nodeType: number;
      ownerDocument: { defaultView: { HTMLElement: new () => void } };
    };
    node.nodeType = 1;
    node.ownerDocument = { defaultView: { HTMLElement: class Local {} } };
    expect(isHtmlElement(node)).toBe(false);
  });

  it("recognizes the selection outline", () => {
    const box = {
      closest: (selector: string) => (selector === SELECTION_CHROME ? box : null),
    };
    expect(isSelectionChrome(box)).toBe(true);
    expect(isSelectionChrome({ closest: () => null })).toBe(false);
    expect(isSelectionChrome(null)).toBe(false);
  });
});

describe("drawn screenshot adjustments", () => {
  it("hides the content of a closed details section and draws an arrow", () => {
    expect(disclosureHidden("SUMMARY", false)).toBe(false);
    expect(disclosureHidden("P", false)).toBe(true);
    expect(disclosureHidden("P", true)).toBe(false);
    expect(disclosureArrow(false)).toBe("\u25B8 ");
    expect(disclosureArrow(true)).toBe("\u25BE ");
  });

  it("shifts a padded piece onto the rectangle it had on the page", () => {
    expect(anchoredOffset(20, 28)).toBe(12);
    expect(anchoredOffset(40, 40)).toBe(40);
  });

  it("keeps the page background and falls back when the page is clear", () => {
    expect(paintedBackground(["rgba(0, 0, 0, 0)", "rgb(255, 255, 255)"], "#14181f")).toBe("rgb(255, 255, 255)");
    expect(paintedBackground(["transparent", ""], "#14181f")).toBe("#14181f");
  });

  it("ends a capture that never finishes", async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise(() => undefined), 20);
    const assertion = expect(pending).rejects.toThrow("The screenshot timed out");
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    vi.useRealTimers();
  });
});
