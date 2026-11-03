import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PanelChrome } from "../src/components/PanelChrome";
import { PanelActionsProvider, type PanelActions } from "../src/panelActions";

const actions: PanelActions = {
  close: () => undefined,
  add: () => undefined,
  addTab: () => undefined,
  use: () => undefined,
  edge: () => undefined,
  face: () => undefined,
  place: () => undefined,
  group: () => undefined,
  dropTab: () => undefined,
  spawn: () => undefined,
  rename: () => undefined,
  icon: () => undefined,
  collapse: () => undefined,
  openTab: () => undefined,
  fill: () => undefined,
  leave: () => undefined,
  filledId: "google",
};

describe("the panel lock control", () => {
  it("leaves the padlock off the bar until the panel is locked", () => {
    const html = renderToStaticMarkup(
      createElement(
        PanelActionsProvider,
        { actions: { ...actions, filledId: null } },
        createElement(
          PanelChrome,
          {
            title: "Notes",
            kind: "Notes",
            panelType: "markdown",
            panelId: "notes",
          },
          createElement("p", null, "body"),
        ),
      ),
    );
    expect(html).toContain('aria-label="Collapse panel"');
    expect(html).not.toContain('aria-label="Lock"');
    expect(html).not.toContain('aria-label="Unlock"');
    expect(html).not.toContain("Lock panel");
    expect(html).toContain('aria-label="Panel settings"');
  });
});

describe("a borrowed panel", () => {
  it("replaces the X with an underscore that leaves the visit", () => {
    const html = renderToStaticMarkup(
      createElement(
        PanelActionsProvider,
        { actions },
        createElement(
          PanelChrome,
          {
            title: "google",
            kind: "Browser",
            panelType: "iframe",
            panelId: "google",
            canClose: true,
            leaveVisit: true,
            fromSpace: "my_sixth_grimoire",
          },
          createElement("p", null, "https://google.com"),
        ),
      ),
    );
    expect(html).toContain("google");
    expect(html).toContain("from my_sixth_grimoire");
    expect(html).toContain("https://google.com");
    expect(html).toContain("Show the whole desk");
    expect(html).toContain('aria-label="No longer visit google"');
    expect(html).toContain("No longer visit this panel");
    expect(html).not.toContain("Close google");
    expect(html).not.toContain("Collapse panel");
    expect(html).not.toContain("Expand panel");
    expect(html).not.toContain(">Back<");
    expect(html.indexOf("Show the whole desk")).toBeLessThan(html.indexOf("No longer visit google"));
  });

  it("leaves the panel type off the title bar", () => {
    const html = renderToStaticMarkup(
      createElement(
        PanelActionsProvider,
        { actions },
        createElement(
          PanelChrome,
          {
            title: "Panes",
            kind: "Panes",
            panelType: "herdr",
          },
          createElement("p", null, "tabs"),
        ),
      ),
    );
    expect(html).not.toContain("panel-type");
    expect(html).toContain(">Panes</strong>");
  });
});

describe("adding a panel from the maximized bar", () => {
  it("puts a plus on the in-place maximized panel, ahead of restore", () => {
    const html = renderToStaticMarkup(
      createElement(
        PanelActionsProvider,
        { actions: { ...actions, filledId: "notes" } },
        createElement(
          PanelChrome,
          {
            title: "Notes",
            kind: "Notes",
            panelType: "markdown",
            panelId: "notes",
          },
          createElement("p", null, "body"),
        ),
      ),
    );
    expect(html).toContain('aria-label="Add a panel to this visit"');
    expect(html.indexOf("Add a panel to this visit")).toBeLessThan(html.indexOf("Show the whole desk"));
  });

  it("shows the desk from any panel once the visit has more than one", () => {
    const html = renderToStaticMarkup(
      createElement(
        PanelActionsProvider,
        { actions: { ...actions, filledId: null, visitPanelIds: ["notes", "google"] } },
        createElement(
          PanelChrome,
          {
            title: "Notes",
            kind: "Notes",
            panelType: "markdown",
            panelId: "notes",
            leaveVisit: true,
          },
          createElement("p", null, "body"),
        ),
      ),
    );
    expect(html).toContain('aria-label="Show the desk"');
    expect(html).not.toContain("Fill the screen with Notes");
    expect(html).toContain('aria-label="No longer visit Notes"');
  });

  it("replaces close with an underscore on a maximized panel", () => {
    const html = renderToStaticMarkup(
      createElement(
        PanelActionsProvider,
        { actions: { ...actions, filledId: "notes" } },
        createElement(
          PanelChrome,
          {
            title: "Notes",
            kind: "Notes",
            panelType: "markdown",
            panelId: "notes",
            canClose: true,
          },
          createElement("p", null, "body"),
        ),
      ),
    );
    expect(html).toContain('aria-label="Show the desk"');
    expect(html).toContain("Show the whole desk");
    expect(html).not.toContain("Close Notes");
    expect(html.indexOf("Show the whole desk")).toBeLessThan(html.indexOf('aria-label="Show the desk"'));
  });

  it("puts a plus on a visit panel and leaves an ordinary desk panel without one", () => {
    const visit = renderToStaticMarkup(
      createElement(
        PanelActionsProvider,
        { actions: { ...actions, filledId: null } },
        createElement(
          PanelChrome,
          {
            title: "Notes",
            kind: "Notes",
            panelType: "markdown",
            panelId: "notes",
            leaveVisit: true,
          },
          createElement("p", null, "body"),
        ),
      ),
    );
    expect(visit).toContain('aria-label="Add a panel to this visit"');
    const desk = renderToStaticMarkup(
      createElement(
        PanelActionsProvider,
        { actions: { ...actions, filledId: null } },
        createElement(
          PanelChrome,
          {
            title: "Notes",
            kind: "Notes",
            panelType: "markdown",
            panelId: "notes",
          },
          createElement("p", null, "body"),
        ),
      ),
    );
    expect(desk).not.toContain("Add a panel to this visit");
  });
});
