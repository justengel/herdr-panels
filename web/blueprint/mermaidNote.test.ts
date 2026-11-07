import { marked } from "marked";
import { describe, expect, it } from "vitest";
import { diagramHtml, diagramPixelWidth, fittedSvg, mermaidConfig, mermaidFences, renderNote } from "../src/mermaidNote";

const markedOptions = { async: false, gfm: true } as const;

const diagram = [
  "```mermaid",
  "flowchart LR",
  '  subgraph org["Tenant"]',
  '    A["Org<br/>Owner"]',
  "  end",
  '  A -.->|"member"| B["Team<br/>Lead"]',
  "```",
].join("\n");

const python = ["```python", 'print("keep")', "```"].join("\n");
const json = ["```json", '{"ok": true}', "```"].join("\n");
const plain = ["```", "plain fence", "```"].join("\n");
const tilde = ["~~~mermaid", "flowchart LR", "A-->B", "~~~"].join("\n");

function parse(markdown: string): string {
  const html = marked.parse(markdown, markedOptions);
  return typeof html === "string" ? html : "";
}

function codeBlocks(html: string): string[] {
  return Array.from(html.matchAll(/<pre><code[\s\S]*?<\/code><\/pre>/g), (match) => match[0]);
}

describe("mermaid fences", () => {
  it("finds a mermaid fence and keeps its source for rendering", () => {
    const markdown = ["# Orgs", "", python, "", diagram, "", json, "", plain, ""].join("\n");
    const sources = mermaidFences(markdown);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toContain("flowchart LR");
    expect(sources[0]).toContain('subgraph org["Tenant"]');
    expect(sources[0]).toContain('A -.->|"member"| B');
    expect(sources[0]).toContain("<br/>");

    const note = renderNote(markdown);
    expect(note.diagrams.map((item) => item.source)).toEqual(sources);
    expect(note.diagrams[0]?.id).toBe("m0");
    expect(note.html).toContain('data-herdr-mermaid="m0"');
    expect(note.html).not.toContain("<br/>");
    expect(note.html).not.toContain("&lt;br");
  });

  it("leaves python, json, plain, and tilde fences unchanged", () => {
    const others = [python, "", tilde, "", json, "", plain, ""].join("\n");
    const withDiagram = [python, "", diagram, "", tilde, "", json, "", plain, ""].join("\n");
    expect(renderNote(others).diagrams).toEqual([]);
    expect(renderNote(others).html).toBe(parse(others));
    expect(codeBlocks(renderNote(withDiagram).html)).toEqual(codeBlocks(parse(others)));
    expect(mermaidFences(withDiagram)).toHaveLength(1);
    expect(mermaidFences(tilde)).toEqual([]);
  });

  it("finds a mermaid fence inside a list and an indented opening line", () => {
    const listed = ["- note", "", "  ```mermaid", "  flowchart LR", "  A-->B", "  ```", ""].join("\n");
    const spaced = ["``` mermaid", "flowchart LR", "A-->B", "```", ""].join("\n");
    expect(mermaidFences(listed)[0]).toContain("A-->B");
    expect(mermaidFences(spaced)).toEqual(["flowchart LR\nA-->B"]);
  });
});

describe("invalid mermaid diagrams", () => {
  it("shows the original code block and one error line", async () => {
    const source = "flowchart LR\nA -->";
    const html = await diagramHtml(source, "dark", async () => {
      throw new Error("Parse error on line 2:\nExpecting NODE, got EOF");
    });
    const code = parse(["```mermaid", source, "```", ""].join("\n"));
    expect(html.startsWith(code)).toBe(true);
    expect(html).toContain("flowchart LR");
    expect(html).toContain('class="language-mermaid"');
    expect(html).toContain("Diagram error: Parse error on line 2");
    expect(html).not.toContain("Expecting NODE");
    expect(html).not.toContain("<script>");
  });

  it("returns the rendered svg from the stored source", async () => {
    const seen: { source: string; scheme: string }[] = [];
    const html = await diagramHtml('flowchart LR\nA["Org<br/>Owner"]', "light", async (source, scheme) => {
      seen.push({ source, scheme });
      return '<svg id="diagram"></svg>';
    });
    expect(seen).toEqual([{ source: 'flowchart LR\nA["Org<br/>Owner"]', scheme: "light" }]);
    expect(html).toBe('<svg id="diagram"></svg>');
  });

  it("sizes a diagram in pixels so panel zoom can scale it", async () => {
    const small = '<svg id="diagram" width="240" height="80" style="max-width: 240px;" viewBox="8 -2 240 80"></svg>';
    const html = await diagramHtml("flowchart LR\nA-->B", "dark", async () => small);
    expect(html).toContain('data-natural-width="240"');
    expect(html).toContain('width="240"');
    expect(html).not.toContain('width="100%"');
    expect(html).not.toContain('height="');
    expect(html).not.toContain("max-width");
    expect(fittedSvg("<svg></svg>")).toBe("<svg></svg>");
    expect(diagramPixelWidth(240, 900)).toBe(240);
    expect(diagramPixelWidth(2000, 800)).toBe(2000);
    expect(diagramPixelWidth(0, 800)).toBe(800);
    expect(diagramPixelWidth(240, 0)).toBe(240);
  });
});

describe("mermaid drawing", () => {
  it("uses sharp svg text, the classic look, and the desk colors", () => {
    const ink = { elevated: "#181b20", panel: "#12151a", text: "#e7e4dc", muted: "#9aa3b2", line: "#3c4451" };
    const config = mermaidConfig("dark", ink);
    expect(config.htmlLabels).toBe(false);
    expect(config.look).toBe("classic");
    expect(config.securityLevel).toBe("strict");
    expect(config.theme).toBe("base");
    expect(config.fontFamily).toContain("Segoe UI");
    expect(config.flowchart?.useMaxWidth).toBe(false);
    expect(config.flowchart?.curve).toBe("linear");
    expect(config.flowchart?.wrappingWidth).toBe(480);
    expect(config.themeVariables).toMatchObject({
      darkMode: true,
      primaryColor: ink.elevated,
      primaryTextColor: ink.text,
      lineColor: ink.muted,
      clusterBkg: ink.panel,
    });
    expect(mermaidConfig("light", ink).themeVariables.darkMode).toBe(false);
  });
});
