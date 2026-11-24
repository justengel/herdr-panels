import { paintNativeBrowsers } from "./browserShot";
import { desktopHost } from "./desktopBrowser";
import { settleComputedColors } from "./cssColor";

export const REMOTE_TAB = "a remote page in a browser tab cannot be scripted";

export interface BrowserDriveMessage {
  requestId: string;
  panelId: string;
  op: string;
  script: string;
  reply: string;
  selector?: string;
  text?: string;
  value?: string;
  key?: string;
  dx?: number;
  dy?: number;
  timeoutMs?: number;
}

export async function runBrowserDrive(message: BrowserDriveMessage): Promise<void> {
  const section = panelSection(message.panelId);
  const type = section?.getAttribute("data-type") || "";
  const reply = (payload: Record<string, unknown>) =>
    fetch(message.reply, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({
        id: message.requestId,
        text: "",
        html: "",
        png: "",
        error: "",
        ...payload,
      }),
    }).then(
      () => undefined,
      () => undefined,
    );

  const hole = browserHole(section);
  const label = hole?.getAttribute("data-browser-label") || "";
  const host = desktopHost();
  if (host && label) {
    const script =
      message.op === "reload" ? "location.reload()" : message.op === "back" || message.op === "forward" ? `history.${message.op}()` : message.script;
    try {
      await host.invoke("eval_browser", { label, script });
      if (message.op === "back" || message.op === "forward" || message.op === "reload") await reply({});
    } catch (err) {
      await reply({ error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (type === "iframe" || message.op === "back" || message.op === "forward" || message.op === "reload") {
    await reply({ error: REMOTE_TAB });
    return;
  }

  await reply(await deskAction(section, message));
}

function panelSection(panelId: string): HTMLElement | null {
  const sections = [...document.querySelectorAll<HTMLElement>(`[data-panel-id="${CSS.escape(panelId)}"]`)];
  const showing = (section: HTMLElement) => !section.closest("[hidden]") && !section.closest(".desk-held");
  return (
    sections.find((section) => showing(section) && section.querySelector("[data-browser-label]")) ??
    sections.find((section) => showing(section)) ??
    sections.find((section) => section.querySelector("[data-browser-label]") && !section.closest("[hidden]")) ??
    sections[0] ??
    null
  );
}

function browserHole(section: HTMLElement | null): HTMLElement | null {
  if (!section) return null;
  const holes = [...section.querySelectorAll<HTMLElement>("[data-browser-label]")];
  const visible = holes.find((hole) => {
    if (hole.closest("[hidden]")) return false;
    const style = getComputedStyle(hole);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = hole.getBoundingClientRect();
    return rect.width >= 2 && rect.height >= 2;
  });
  return visible ?? holes[0] ?? null;
}

async function deskAction(section: HTMLElement | null, message: BrowserDriveMessage): Promise<Record<string, unknown>> {
  if (!section) return { error: "panel was not found" };
  const root = section.querySelector<HTMLElement>(".panel-body") ?? section;
  const found = findIn(root, message.selector, message.text);
  if (message.op === "read" || message.op === "shot") {
    const element = found.element ?? (message.selector || message.text ? null : root);
    if (!element) return { error: found.error || "that element was not found" };
    return capture(element);
  }
  if (message.op === "wait") {
    const limit = Math.min(30_000, Math.max(0, message.timeoutMs ?? 3000));
    const started = Date.now();
    let current = found;
    while (!current.element && Date.now() - started < limit) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      current = findIn(root, message.selector, message.text);
    }
    if (!current.element) return { error: current.error || "that element was not found" };
    return { text: visibleText(current.element) };
  }
  const element = found.element;
  if (
    !element &&
    (message.op === "click" ||
      message.op === "fill" ||
      message.op === "scroll-to" ||
      message.op === "select" ||
      message.selector ||
      message.text)
  ) {
    return { error: found.error || "that element was not found" };
  }
  const target = element ?? root;
  if (message.op === "click") {
    if (target instanceof HTMLElement) target.focus();
    target.click();
    return { text: visibleText(target) };
  }
  if (message.op === "fill") {
    const field = target.matches("input, textarea, [contenteditable='true']")
      ? target
      : target.querySelector<HTMLElement>("input, textarea, [contenteditable='true']");
    if (!field) return { error: "that element is not a field" };
    field.focus();
    writeField(field, message.value ?? "");
    return { text: visibleText(field) };
  }
  if (message.op === "key") {
    const key = message.key ?? "";
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
    return { text: visibleText(target) };
  }
  if (message.op === "scroll") {
    target.scrollBy(message.dx ?? 0, message.dy ?? 0);
    return { text: visibleText(target) };
  }
  if (message.op === "scroll-to") {
    if (!element || typeof element.scrollIntoView !== "function") {
      return { error: found.error || "that element was not found" };
    }
    element.scrollIntoView({ block: "start", inline: "nearest" });
    return { text: visibleText(element) };
  }
  if (message.op === "select") {
    if (!(element instanceof HTMLSelectElement)) return { error: "that element is not a select" };
    writeSelect(element, message.value ?? "");
    return { text: element.value };
  }
  return { error: "unknown browser action" };
}

function findIn(root: HTMLElement, selector?: string, text?: string): { element?: HTMLElement; error?: string } {
  const needle = text?.trim().toLowerCase() ?? "";
  if (selector) {
    let nodes: HTMLElement[];
    try {
      nodes = [...root.querySelectorAll<HTMLElement>(selector)];
    } catch {
      return { error: "the selector is invalid" };
    }
    for (const hit of nodes) {
      if (!needle || shownText(hit).toLowerCase().includes(needle)) return { element: hit };
    }
    return { error: nodes.length > 0 && needle ? "that text was not found" : "that element was not found" };
  }
  if (text) {
    const needle = text.trim().toLowerCase();
    for (const node of root.querySelectorAll<HTMLElement>("*")) {
      if (visibleText(node).toLowerCase().includes(needle)) return { element: node };
    }
    return { error: "that text was not found" };
  }
  return {};
}

function shownText(element: HTMLElement): string {
  return (element.innerText || element.textContent || "").replace(/\u00a0/g, " ");
}

function visibleText(element: HTMLElement): string {
  return shownText(element).trim().slice(0, 20000);
}

function writeSelect(field: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  if (setter) setter.call(field, value);
  else field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
}

function writeField(field: HTMLElement, value: string) {
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(field, value);
    else field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  field.textContent = value;
}

async function capture(element: HTMLElement): Promise<Record<string, unknown>> {
  const text = visibleText(element);
  const html = (element.outerHTML || "").slice(0, 80000);
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return { text, html, png: "" };
  try {
    const { default: html2canvas } = await import("html2canvas");
    const canvas = await html2canvas(element, {
      backgroundColor: "#12151a",
      scale: window.devicePixelRatio || 1,
      logging: false,
      useCORS: true,
      onclone: (doc: Document) => settleComputedColors(doc),
    });
    // The page in a browser panel is a native webview. See paintNativeBrowsers.
    await paintNativeBrowsers(canvas, rect);
    const url = canvas.toDataURL("image/png");
    const comma = url.indexOf(",");
    const png = url.startsWith("data:image/png") && comma >= 0 ? url.slice(comma + 1) : "";
    return { text, html, png };
  } catch (err) {
    return { text, html, png: "", error: err instanceof Error ? err.message : "Could not take the screenshot" };
  }
}
