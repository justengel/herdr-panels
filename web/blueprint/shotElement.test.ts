import { describe, expect, it } from "vitest";
import { isHtmlElement, isSelectionChrome, SELECTION_CHROME } from "../src/shotElement";

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
