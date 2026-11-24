import source from "../../assets/frame-find.js?raw";
import { frameOwnsKeys } from "./frameKeys";

export type FindKind = "browser" | "terminal" | "frame" | "remote" | "text";

type ApplyFind = (root: ParentNode, query: string, index: number, matchCase: boolean) => { count: number; index: number };

export const REMOTE_FIND_NOTE = "Click the page, then Ctrl+F uses the browser's find.";

export function applyFind(root: ParentNode, query: string, index: number, matchCase: boolean): { count: number; index: number } {
  const page = window as Window & { hwpApplyFind?: ApplyFind };
  if (!page.hwpApplyFind) {
    const install = new Function(source);
    install();
  }
  if (!page.hwpApplyFind) return { count: 0, index: -1 };
  return page.hwpApplyFind(root, query, index, Boolean(matchCase));
}

/** The panel's content box. A framed panel keeps that box inside the frame, not on the section itself. */
export function panelBody(section: HTMLElement): HTMLElement | null {
  return (
    [...section.querySelectorAll<HTMLElement>(".panel-body")].find((body) => body.closest("[data-panel-id]") === section) ??
    null
  );
}

/** The visible page inside a panel. A hidden tab is left out, and so is the find bar. */
export function searchRoot(section: HTMLElement): HTMLElement {
  const scope = panelBody(section) ?? section;
  const pane = [...scope.querySelectorAll<HTMLElement>(".tab-pane")].find((item) => !item.hidden);
  if (pane) return pane;
  const scale = scope.querySelector(":scope > .panel-scale");
  return scale instanceof HTMLElement ? scale : scope;
}

export function classifyPanel(root: ParentNode): FindKind {
  if (root.querySelector("[data-browser-label]")) return "browser";
  if (root.querySelector(".xterm")) return "terminal";
  const frame = root.querySelector("iframe.frame");
  if (frame instanceof HTMLIFrameElement) {
    if (frame.srcdoc || frameOwnsKeys(frame)) return "frame";
    return "remote";
  }
  return "text";
}

export function ourFrame(root: ParentNode): HTMLIFrameElement | null {
  const frame = root.querySelector("iframe.frame");
  if (!(frame instanceof HTMLIFrameElement)) return null;
  if (frame.srcdoc || frameOwnsKeys(frame)) return frame;
  return null;
}

export function visibleSection(id: string): HTMLElement | null {
  for (const section of document.querySelectorAll<HTMLElement>(`[data-panel-id="${CSS.escape(id)}"]`)) {
    if (section.closest(".desk-held") || section.closest("[hidden]")) continue;
    return section;
  }
  return null;
}
