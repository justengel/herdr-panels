import { marked, type Token, type Tokens } from "marked";
import type { MermaidConfig } from "mermaid";

export interface MermaidDiagram {
  id: string;
  source: string;
}

export type NoteScheme = "light" | "dark";

const markedOptions = { async: false, gfm: true } as const;

function fenceLanguage(lang: string | undefined): string {
  return (lang ?? "").match(/^\S*/)?.[0] ?? "";
}

function isMermaidFence(token: Tokens.Code): boolean {
  return token.codeBlockStyle !== "indented" && fenceLanguage(token.lang) === "mermaid" && /^ {0,3}`{3,}/.test(token.raw);
}

function walk(tokens: readonly Token[], out: Tokens.Code[]) {
  for (const token of tokens) {
    if (token.type === "code") {
      const code = token as Tokens.Code;
      if (isMermaidFence(code)) out.push(code);
      continue;
    }
    if (token.type === "list") {
      for (const item of token.items) walk(item.tokens, out);
      continue;
    }
    if ("tokens" in token && token.tokens) walk(token.tokens, out);
  }
}

export function mermaidFences(markdown: string): string[] {
  const found: Tokens.Code[] = [];
  walk(marked.lexer(markdown, markedOptions), found);
  return found.map((token) => token.text);
}

export function renderNote(markdown: string): { html: string; diagrams: MermaidDiagram[] } {
  const diagrams: MermaidDiagram[] = [];
  const renderer = new marked.Renderer();
  renderer.code = function (token) {
    if (!isMermaidFence(token)) return marked.Renderer.prototype.code.call(this, token);
    const id = `m${diagrams.length}`;
    diagrams.push({ id, source: token.text });
    return `<div class="mermaid-diagram" data-herdr-mermaid="${id}"></div>\n`;
  };
  const parsed = marked.parse(markdown, { ...markedOptions, renderer });
  return { html: typeof parsed === "string" ? parsed : "", diagrams };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function shortError(message: string): string {
  const line = message
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  const text = line && line.length > 0 ? line : "Could not render the diagram";
  const clipped = text.length > 180 ? `${text.slice(0, 179)}…` : text;
  return `Diagram error: ${clipped}`;
}

export function mermaidFailureHtml(source: string, message: string): string {
  const fence = ["```mermaid", source.replace(/\n$/, ""), "```", ""].join("\n");
  const parsed = marked.parse(fence, markedOptions);
  const code = typeof parsed === "string" ? parsed : "";
  return `${code}<p class="mermaid-error">${escapeHtml(shortError(message))}</p>\n`;
}

export type MermaidRender = (source: string, scheme: NoteScheme) => Promise<string>;

export interface DiagramInk {
  elevated: string;
  panel: string;
  text: string;
  muted: string;
  line: string;
}

/** Mermaid is the renderer. HTML labels and a stretched SVG are what look soft. */
export function mermaidConfig(scheme: NoteScheme, ink: DiagramInk): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    htmlLabels: false,
    look: "classic",
    fontFamily: '"Segoe UI", sans-serif',
    theme: "base",
    flowchart: {
      useMaxWidth: false,
      curve: "linear",
      padding: 8,
      nodeSpacing: 32,
      rankSpacing: 44,
      // The default is 120px, which splits a label such as notes/welcome.md.
      wrappingWidth: 480,
    },
    themeVariables: {
      darkMode: scheme === "dark",
      background: "transparent",
      fontFamily: '"Segoe UI", sans-serif',
      fontSize: "15px",
      primaryColor: ink.elevated,
      primaryTextColor: ink.text,
      primaryBorderColor: ink.line,
      secondaryColor: ink.panel,
      secondaryTextColor: ink.text,
      secondaryBorderColor: ink.line,
      tertiaryColor: ink.panel,
      tertiaryTextColor: ink.text,
      tertiaryBorderColor: ink.line,
      lineColor: ink.muted,
      textColor: ink.text,
      mainBkg: ink.elevated,
      nodeBorder: ink.line,
      clusterBkg: ink.panel,
      clusterBorder: ink.line,
      titleColor: ink.text,
      edgeLabelBackground: ink.panel,
      nodeTextColor: ink.text,
    },
  };
}

/**
 * Draw the diagram at the size it was laid out. Do not stretch it to the
 * note. Panel zoom scales these pixels. `columnWidth` is only a fallback
 * when the diagram has no size of its own.
 */
export function diagramPixelWidth(naturalWidth: number, columnWidth: number): number {
  const natural = Number.isFinite(naturalWidth) && naturalWidth > 0 ? naturalWidth : 0;
  if (natural) return natural;
  const column = Number.isFinite(columnWidth) && columnWidth > 0 ? columnWidth : 0;
  return column;
}

/**
 * Remember the diagram's own width and drop the percentage size.
 * A width of 100% stays tied to the panel frame, so zooming the note
 * enlarges the text and leaves the picture the same size.
 */
export function fittedSvg(svg: string): string {
  const box = svg.match(/viewBox="\s*-?[0-9.]+\s+-?[0-9.]+\s+([0-9.]+)\s+[0-9.]+\s*"/);
  const width = box?.[1];
  if (!width) return svg;
  let next = svg.replace(/\sdata-natural-width="[^"]*"/, "");
  next = /\swidth="/.test(next) ? next.replace(/\swidth="[^"]*"/, ` width="${width}"`) : next.replace("<svg", `<svg width="${width}"`);
  next = next.replace(/\sheight="[^"]*"/, "");
  next = next.replace("<svg", `<svg data-natural-width="${width}"`);
  if (/\sstyle="/.test(next)) {
    return next.replace(/\sstyle="([^"]*)"/, (_match, style: string) => {
      const kept = style
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part.length > 0 && !part.startsWith("max-width") && !part.startsWith("min-width"));
      return kept.length > 0 ? ` style="${kept.join("; ")}"` : "";
    });
  }
  return next;
}

export async function diagramHtml(source: string, scheme: NoteScheme, render: MermaidRender = renderWithMermaid): Promise<string> {
  try {
    return fittedSvg(await render(source, scheme));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return mermaidFailureHtml(source, message);
  }
}

let mermaidApi: Promise<typeof import("mermaid").default> | null = null;
let renderQueue: Promise<void> = Promise.resolve();

function diagramInk(): DiagramInk {
  const style = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    elevated: pick("--bg-elev", "#181b20"),
    panel: pick("--bg-panel", "#12151a"),
    text: pick("--text", "#e7e4dc"),
    muted: pick("--muted", "#9aa3b2"),
    line: pick("--line-strong", "#3c4451"),
  };
}

function loadMermaid(): Promise<typeof import("mermaid").default> {
  mermaidApi ??= import("mermaid").then((mod) => mod.default);
  return mermaidApi;
}

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = renderQueue.then(job, job);
  renderQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function renderWithMermaid(source: string, scheme: NoteScheme): Promise<string> {
  return enqueue(async () => {
    const mermaid = await loadMermaid();
    mermaid.initialize(mermaidConfig(scheme, diagramInk()));
    const id = `herdrMermaid${Math.random().toString(36).slice(2)}`;
    try {
      const { svg } = await mermaid.render(id, source);
      return svg;
    } finally {
      const leftover = document.getElementById(id);
      if (leftover?.parentElement === document.body) leftover.remove();
    }
  });
}
