/** Selection outlines drawn by the desk and by framed pages. */
export const SELECTION_CHROME =
  ".select-box, .select-marquee, .select-menu, .hwp-select-ui, .hwp-shot-dialog";

/**
 * An HTML element, including one that belongs to an iframe.
 * `instanceof HTMLElement` is false for those, because the element uses the frame's constructor.
 */
export function isHtmlElement(node: unknown): node is HTMLElement {
  if (!node || typeof node !== "object") return false;
  const element = node as {
    nodeType?: number;
    ownerDocument?: { defaultView?: { HTMLElement?: new (...args: never[]) => unknown } | null } | null;
  };
  if (element.nodeType !== 1) return false;
  const Html = element.ownerDocument?.defaultView?.HTMLElement;
  return typeof Html === "function" && element instanceof Html;
}

export function isSelectionChrome(node: { closest?: (selector: string) => unknown } | null): boolean {
  return Boolean(node?.closest?.(SELECTION_CHROME));
}

/** Drop selection outlines from a document before it is painted into a screenshot. */
export function hideSelectionChrome(doc: Document): void {
  doc.querySelectorAll(SELECTION_CHROME).forEach((node) => node.remove());
}
