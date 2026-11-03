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
