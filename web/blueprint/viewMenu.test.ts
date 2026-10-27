import { describe, expect, it } from "vitest";
import { adoptPluginAddress, applyPluginSubjects, menuFor, pluginOpenMessage, showViewer } from "../src/viewMenu";
import type { LayoutNode, PanelConfig } from "../src/types";
import type { MenuPlugin } from "../src/viewMenu";

const note: PanelConfig = { type: "markdown", path: "notes/welcome.md", addressBar: false };
const page: PanelConfig = { type: "html", path: "panels/charts.html" };
const license: PanelConfig = { type: "file", path: "LICENSE" };
const folder: PanelConfig = { type: "explorer", path: "C:/work/notes" };
const site: PanelConfig = { type: "iframe", url: "https://example.com", proxy: false };
const blank: PanelConfig = { type: "iframe", url: "", proxy: false };
const terminal: PanelConfig = { type: "herdr", paneId: "w1:p1" };
const inline: PanelConfig = { type: "html", inline: "<p>Hi</p>" };
const empty: PanelConfig = { type: "blank" };

const welcome: MenuPlugin = { id: "welcome", title: "Welcome" };
const vim: MenuPlugin = {
  id: "vim",
  title: "Vim",
  views: [{ id: "edit", title: "Vim", opens: ["file"] }],
};
const preview: MenuPlugin = {
  id: "preview",
  title: "Preview",
  views: [{ id: "read", title: "Preview", opens: ["markdown"] }],
};
const docs: MenuPlugin = {
  id: "docs",
  title: "Docs",
  views: [
    { id: "read", title: "Reader", opens: ["markdown", "directory"] },
    { id: "home", title: "Library" },
  ],
};
const plugins = [welcome, vim, preview, docs];

function ids(panel: PanelConfig, section: "view" | "desk" | "plugins" | "views") {
  return menuFor(panel, plugins)
    .filter((entry) => entry.section === section)
    .map((entry) => entry.id);
}

function checked(panel: PanelConfig) {
  return menuFor(panel, plugins)
    .filter((entry) => entry.checked)
    .map((entry) => entry.id);
}

describe("panel menu", () => {
  it("lists View in Open → Files → Browser → Text → Markdown → plugins order and hides unavailable", () => {
    expect(ids(note, "view")).toEqual(["open", "files", "text", "markdown", "more-views"]);
    expect(ids(note, "views")).toEqual([
      "plugin:vim:edit",
      "plugin:preview:read",
      "plugin:docs:read",
    ]);
    expect(checked(note)).toEqual(["markdown"]);
    expect(ids(note, "desk")).toEqual(["terminal", "spaces", "agents"]);
    expect(ids(note, "plugins")).toEqual(["plugin:welcome:welcome", "plugin:docs:home"]);

    expect(ids(page, "view")).toEqual(["open", "files", "browser", "text", "plugin:vim:edit"]);
    expect(checked(page)).toEqual(["browser"]);

    expect(ids(license, "view")).toEqual(["open", "files", "text", "plugin:vim:edit"]);
    expect(checked(license)).toEqual(["text"]);

    expect(ids(folder, "view")).toEqual(["open", "files", "plugin:docs:read"]);
    expect(checked(folder)).toEqual(["files"]);

    expect(ids(site, "view")).toEqual(["open", "browser"]);
    expect(checked(blank)).toEqual(["browser"]);
    expect(ids(blank, "view")).toEqual(["open", "files", "browser"]);

    expect(ids(terminal, "view")).toEqual(["open", "files", "browser"]);
    expect(checked(terminal)).toEqual(["panes"]);
    expect(ids({ type: "files" }, "view")).toEqual(["open", "files", "browser"]);
    expect(checked({ type: "files" })).toEqual(["spaces"]);
    expect(ids(inline, "view")).toEqual(["open", "browser", "text"]);
    expect(ids(empty, "view")).toEqual(["open", "files", "browser"]);
  });

  it("keeps the file address when switching to Files so View can return", () => {
    expect(showViewer(note, "files", plugins, { workspaceRoot: "C:/work/herdr-panels" })).toEqual({
      type: "explorer",
      path: "C:/work/herdr-panels",
      focus: "C:/work/herdr-panels/notes/welcome.md",
      addressBar: false,
    });
    expect(
      showViewer(
        { type: "markdown", path: "C:/work/herdr-panels/notes/welcome.md", addressBar: false },
        "files",
        plugins,
        { workspaceRoot: "C:/work/herdr-panels" },
      ),
    ).toEqual({
      type: "explorer",
      path: "C:/work/herdr-panels",
      focus: "C:/work/herdr-panels/notes/welcome.md",
      addressBar: false,
    });
    const focused: PanelConfig = {
      type: "explorer",
      path: "C:/work/herdr-panels",
      focus: "C:/work/herdr-panels/notes/welcome.md",
      addressBar: false,
    };
    expect(ids(focused, "view")).toEqual(["open", "files", "text", "markdown", "more-views"]);
    expect(ids(focused, "views")).toEqual([
      "plugin:vim:edit",
      "plugin:preview:read",
      "plugin:docs:read",
    ]);
    expect(checked(focused)).toEqual(["files"]);
    const directory = {
      type: "explorer" as const,
      path: "C:/work/herdr-panels/notes",
      addressBar: false,
    };
    expect(ids(directory, "view")).toEqual(["open", "files", "plugin:docs:read"]);
    expect(checked(directory)).toEqual(["files"]);
    expect(showViewer(focused, "markdown", plugins)).toEqual({
      type: "markdown",
      path: "C:/work/herdr-panels/notes/welcome.md",
      addressBar: false,
    });
    expect(showViewer(page, "text", plugins)).toEqual({ type: "file", path: "panels/charts.html" });
    expect(showViewer({ type: "file", path: "panels/charts.html" }, "browser", plugins)).toEqual({
      type: "html",
      path: "panels/charts.html",
    });
    expect(showViewer({ type: "file", path: "notes/welcome.md" }, "markdown", plugins)).toEqual({
      type: "markdown",
      path: "notes/welcome.md",
    });
    expect(showViewer(note, "browser", plugins)).toEqual(note);
    expect(showViewer(note, "plugin:vim:edit", plugins)).toEqual({
      type: "plugin",
      plugin: "vim",
      view: "edit",
      path: "notes/welcome.md",
      addressBar: false,
    });
    expect(showViewer(folder, "plugin:docs:read", plugins)).toEqual({
      type: "plugin",
      plugin: "docs",
      view: "read",
      path: "C:/work/notes",
      directory: true,
    });
    expect(showViewer(note, "plugin:welcome:welcome", plugins)).toEqual({
      type: "plugin",
      plugin: "welcome",
      view: "welcome",
    });
    expect(showViewer(terminal, "terminal", plugins)).toEqual(terminal);
    expect(showViewer(note, "terminal", plugins)).toEqual({ type: "herdr", paneId: null });
    expect(showViewer(inline, "text", plugins)).toEqual({ type: "html", inline: "<p>Hi</p>", raw: true });
    expect(showViewer({ type: "html", inline: "<p>Hi</p>", raw: true }, "browser", plugins)).toEqual(inline);
    expect(showViewer(empty, "files", plugins)).toEqual({ type: "explorer", path: "" });
    expect(showViewer(empty, "browser", plugins)).toEqual({ type: "iframe", url: "", proxy: false });
  });

  it("changes the active tab and tells a plugin what it opened", () => {
    const group: PanelConfig = {
      type: "tabs",
      edge: "top",
      active: "one",
      tabs: [
        { id: "one", title: "One", panel: note },
        { id: "two", title: "Two", panel: page },
      ],
    };
    expect(showViewer(group, "text", plugins)).toMatchObject({
      tabs: [{ panel: { type: "file", path: "notes/welcome.md" } }, { panel: page }],
    });
    expect(checked(group)).toEqual(["markdown"]);
    const vimPanel: PanelConfig = {
      type: "plugin",
      plugin: "vim",
      view: "edit",
      path: "notes/welcome.md",
      config: { line: 4 },
    };
    expect(pluginOpenMessage(vimPanel)).toEqual({
      view: "edit",
      address: "notes/welcome.md",
      kind: "markdown",
      config: { line: 4 },
    });
    expect(pluginOpenMessage(welcomePanel())).toEqual({
      view: "welcome",
      address: "",
      kind: "",
      config: {},
    });
    expect(adoptPluginAddress(vimPanel, { type: "explorer", path: "notes" })).toEqual({
      ...vimPanel,
      path: "notes",
      directory: true,
    });
  });

  it("restores the file a plugin view was showing", () => {
    const node: LayoutNode = {
      type: "panel",
      id: "notes",
      title: "Notes",
      panel: { type: "plugin", plugin: "vim" },
    };
    const stored = {
      "desk:notes": { plugin: "vim", view: "edit", path: "notes/welcome.md" },
    };
    expect(applyPluginSubjects(node, "desk", stored)).toMatchObject({
      panel: { view: "edit", path: "notes/welcome.md" },
    });
    const kept: LayoutNode = {
      ...node,
      panel: { type: "plugin", plugin: "vim", view: "edit", path: "notes/other.md" },
    };
    expect(applyPluginSubjects(kept, "desk", stored)).toMatchObject({
      panel: { path: "notes/other.md" },
    });
  });
});

function welcomePanel(): PanelConfig {
  return { type: "plugin", plugin: "welcome", view: "welcome" };
}
