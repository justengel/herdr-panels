import { describe, expect, it } from "vitest";
import { applyRawChoices, carryRaw, rawTextChoice, setRawText, showsRawText } from "../src/rawText";
import type { LayoutNode, PanelConfig } from "../src/types";

const note: PanelConfig = { type: "markdown", path: "notes/a.md" };
const page: PanelConfig = { type: "html", path: "panels/charts.html" };
const inline: PanelConfig = { type: "html", inline: "<p>Hi</p>" };
const source: PanelConfig = { type: "file", path: "src/main.rs" };
const htmlFile: PanelConfig = { type: "file", path: "panels/charts.html" };

describe("raw text", () => {
  it("keeps a rendered file rendered until the panel asks for the text", () => {
    expect(showsRawText(note)).toBe(false);
    expect(rawTextChoice(note)).toBe(false);
    expect(showsRawText(source)).toBe(true);
    expect(rawTextChoice(source)).toBeNull();
    expect(rawTextChoice({ type: "herdr" })).toBeNull();
    expect(setRawText(note, true)).toEqual({ ...note, raw: true });
    expect(showsRawText({ ...note, raw: true })).toBe(true);
    expect(setRawText({ ...page, raw: true }, false)).toEqual(page);
    expect(setRawText(inline, true)).toEqual({ ...inline, raw: true });
  });

  it("can show a text file as its page when the file is html or markdown", () => {
    expect(rawTextChoice(htmlFile)).toBe(true);
    expect(setRawText(htmlFile, false)).toEqual({ type: "html", path: "panels/charts.html" });
    expect(setRawText({ type: "file", path: "notes/a.md", addressBar: false }, false)).toEqual({
      type: "markdown",
      path: "notes/a.md",
      addressBar: false,
    });
    expect(setRawText(source, false)).toEqual(source);
  });

  it("changes the active tab and keeps the choice when the address moves", () => {
    const group: PanelConfig = {
      type: "tabs",
      edge: "top",
      active: "one",
      tabs: [
        { id: "one", title: "One", panel: note },
        { id: "two", title: "Two", panel: page },
      ],
    };
    expect(setRawText(group, true)).toMatchObject({
      tabs: [{ panel: { raw: true } }, { panel: page }],
    });
    expect(carryRaw({ ...note, raw: true }, { type: "markdown", path: "notes/b.md" })).toEqual({
      type: "markdown",
      path: "notes/b.md",
      raw: true,
    });
    expect(carryRaw(note, { type: "markdown", path: "notes/b.md" })).toEqual({
      type: "markdown",
      path: "notes/b.md",
    });
    expect(carryRaw(source, page)).toEqual(page);
  });

  it("restores a raw view when a layout comes back without the choice", () => {
    const node: LayoutNode = { type: "panel", id: "notes", title: "Notes", panel: note };
    expect(applyRawChoices(node, "desk", { "desk:notes": true })).toMatchObject({
      panel: { raw: true },
    });
    const kept: LayoutNode = { ...node, panel: { ...note, raw: true } };
    expect(applyRawChoices(kept, "desk", { "desk:notes": false })).toMatchObject({
      panel: { raw: true },
    });
  });
});
