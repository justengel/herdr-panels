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

/** A closed details section hides every child except its summary. */
export function disclosureHidden(tagName: string, open: boolean): boolean {
  return !open && tagName.toUpperCase() !== "SUMMARY";
}

/** The arrow drawn in place of the list marker html2canvas adds to a summary. */
export function disclosureArrow(open: boolean): string {
  return open ? "\u25BE " : "\u25B8 ";
}

/**
 * html2canvas does not know disclosure widgets. It draws a closed section's hidden content and
 * numbers the summary like a list item, so hide the content and draw the arrow ourselves.
 */
export function settleDisclosure(doc: Document): void {
  const styled = (node: Element) => node as HTMLElement;
  for (const details of Array.from(doc.querySelectorAll("details"))) {
    const open = details.hasAttribute("open");
    if (open) continue;
    for (const child of Array.from(details.children)) {
      if (disclosureHidden(child.tagName, open)) styled(child).style.display = "none";
    }
  }
  const view = doc.defaultView;
  for (const summary of Array.from(doc.querySelectorAll("summary"))) {
    const marked = view ? view.getComputedStyle(summary).listStyleType !== "none" : true;
    styled(summary).style.display = "block";
    styled(summary).style.listStyle = "none";
    if (!marked) continue;
    const arrow = doc.createElement("span");
    arrow.textContent = disclosureArrow(Boolean(summary.parentElement?.hasAttribute("open")));
    summary.insertBefore(arrow, summary.firstChild);
  }
}

/** Where a wrapper has to sit so its child lands on the rectangle the piece had on the page. */
export function anchoredOffset(intended: number, actual: number): number {
  return intended + (intended - actual);
}

/**
 * An inline element with padding, such as a pill, paints above and beside the line it sits in, so
 * its box does not start where the wrapper does. Shift each wrapper until its first element's box
 * lands on the rectangle the piece had on the page.
 */
export function anchorPieces(root: HTMLElement): void {
  for (const wrapper of Array.from(root.querySelectorAll("[data-piece]"))) {
    const box = wrapper as HTMLElement;
    const child = box.firstElementChild;
    if (!child) continue;
    const left = Number(box.dataset.left);
    const top = Number(box.dataset.top);
    const actual = child.getBoundingClientRect();
    box.style.left = `${anchoredOffset(left, actual.left)}px`;
    box.style.top = `${anchoredOffset(top, actual.top)}px`;
  }
}

/** The first painted background, or the fallback when every color is clear. */
export function paintedBackground(colors: readonly string[], fallback: string): string {
  for (const color of colors) {
    const value = color.trim();
    if (value && value !== "rgba(0, 0, 0, 0)" && value !== "transparent") return value;
  }
  return fallback;
}

/** Fail with a message instead of leaving the button silent when a capture never finishes. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The screenshot timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
