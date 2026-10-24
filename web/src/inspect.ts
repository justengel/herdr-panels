export interface InspectElement {
  tag: string;
  text: string;
  style: Record<string, string>;
}

export interface InspectResult {
  accessible: boolean;
  title?: string;
  html?: string;
  css?: string;
  text?: string;
  elements: InspectElement[];
}

const STYLE = ["color", "backgroundColor", "fontSize", "fontFamily", "display", "width", "height", "margin", "padding"] as const;
const CANDIDATES = "h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,a,button,label,td,th,input,code";
const hits: HTMLElement[] = [];

export function highlight(panelId: string, selector?: string, text?: string) {
  clearHits();
  const root = panelRoot(panelId);
  if (!root) return;
  root.querySelectorAll("iframe").forEach((frame) => {
    if (!(frame instanceof HTMLIFrameElement)) return;
    frame.contentWindow?.postMessage(
      { source: "hwp-host", type: "highlight", selector: selector ?? null, text: text ?? null },
      "*",
    );
    const doc = sameOriginDoc(frame);
    if (doc?.body && (selector || text)) paint(doc.body, selector, text);
  });
  const scope = root.querySelector(".panel-body") ?? root;
  if (selector || text) paint(scope, selector, text);
}

export function inspectPanel(panelId: string, selector?: string, text?: string): Promise<InspectResult> {
  const root = panelRoot(panelId);
  if (!root) return Promise.resolve({ accessible: false, elements: [] });
  const frame = root.querySelector("iframe");
  if (frame instanceof HTMLIFrameElement) {
    const doc = sameOriginDoc(frame);
    if (doc?.body) return Promise.resolve(describe(doc, doc.body, selector, text, true));
    return askFrame(frame, selector, text);
  }
  const scope = root.querySelector(".panel-body") ?? root;
  const term = scope.querySelector(".xterm-screen");
  if (term) {
    return Promise.resolve({
      accessible: true,
      text: (term.textContent ?? "").replace(/\s+\n/g, "\n").slice(0, 8000),
      elements: [],
    });
  }
  return Promise.resolve(describe(root.ownerDocument, scope, selector, text, false));
}

function panelRoot(panelId: string): HTMLElement | null {
  const root = document.querySelector(`[data-panel-id="${CSS.escape(panelId)}"]`);
  return root instanceof HTMLElement ? root : null;
}

function sameOriginDoc(frame: HTMLIFrameElement): Document | null {
  try {
    return frame.contentDocument;
  } catch {
    return null;
  }
}

function askFrame(frame: HTMLIFrameElement, selector?: string, text?: string): Promise<InspectResult> {
  const requestId = `p${Date.now().toString(36)}`;
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => finish({ accessible: false, elements: [] }), 500);
    function finish(result: InspectResult) {
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(result);
    }
    function onMessage(event: MessageEvent) {
      const data = event.data as { source?: string; type?: string; requestId?: string; result?: InspectResult };
      if (event.source !== frame.contentWindow) return;
      if (!data || data.source !== "hwp-panel" || data.type !== "inspect-result" || data.requestId !== requestId) return;
      finish(data.result ?? { accessible: false, elements: [] });
    }
    window.addEventListener("message", onMessage);
    frame.contentWindow?.postMessage({ source: "hwp-host", type: "inspect", requestId, selector: selector ?? null, text: text ?? null }, "*");
  });
}

function describe(doc: Document, scope: Element, selector?: string, text?: string, page = false): InspectResult {
  return {
    accessible: true,
    title: page ? doc.title || undefined : undefined,
    html: (page ? doc.documentElement.outerHTML : scope.innerHTML).slice(0, 12000),
    css: page
      ? [...doc.querySelectorAll("style")]
          .map((node) => node.textContent ?? "")
          .join("\n")
          .slice(0, 8000)
      : undefined,
    elements: collect(scope, selector, text),
  };
}

function paint(scope: Element, selector?: string, text?: string) {
  for (const element of collectElements(scope, selector, text).slice(0, 20)) {
    if (!(element instanceof HTMLElement)) continue;
    element.style.outline = "2px solid #e6b35a";
    element.style.outlineOffset = "2px";
    hits.push(element);
  }
}

function clearHits() {
  for (const element of hits) {
    element.style.outline = "";
    element.style.outlineOffset = "";
  }
  hits.length = 0;
}

function collect(scope: Element, selector?: string, text?: string): InspectElement[] {
  return collectElements(scope, selector, text).slice(0, 40).map((element) => ({
    tag: element.tagName.toLowerCase(),
    text: visibleText(element).slice(0, 180),
    style: computed(element),
  }));
}

function collectElements(scope: Element, selector?: string, text?: string): Element[] {
  let nodes: Element[] = [];
  if (selector && selector.length <= 200) {
    try {
      nodes = [...scope.querySelectorAll(selector)];
    } catch {
      nodes = [];
    }
  }
  if (nodes.length === 0 && !selector) {
    nodes = [...scope.querySelectorAll(CANDIDATES)];
  }
  const needle = text?.trim().toLowerCase();
  return nodes.filter((element) => {
    if (element.closest(".xterm")) return false;
    const body = visibleText(element).toLowerCase();
    if (needle && !body.includes(needle)) return false;
    return body.length > 0 || element.matches("input, img, button");
  });
}

function visibleText(element: Element): string {
  return (element.textContent ?? element.getAttribute("aria-label") ?? "").replace(/\s+/g, " ").trim();
}

function computed(element: Element): Record<string, string> {
  const view = element.ownerDocument.defaultView;
  if (!view) return {};
  const style = view.getComputedStyle(element);
  const result: Record<string, string> = {};
  for (const name of STYLE) result[name] = style[name];
  return result;
}
