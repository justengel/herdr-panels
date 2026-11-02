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
  spawn: () => undefined,
  rename: () => undefined,
  fill: () => undefined,
  leave: () => undefined,
  filledId: "google",
};

describe("the panel lock control", () => {
  it("puts an unlocked padlock before settings, with a tooltip", () => {
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
    expect(html).toContain('aria-label="Lock"');
    expect(html).toContain("Plugins and agents cannot read it or drive it");
    expect(html.indexOf('aria-label="Lock"')).toBeLessThan(html.indexOf('aria-label="Panel settings"'));
    expect(html).not.toContain("Lock panel");
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
    expect(html).not.toContain(">Back<");
    expect(html.indexOf("Show the whole desk")).toBeLessThan(html.indexOf("No longer visit google"));
  });

  it("puts the panel type on the right, even when it matches the name", () => {
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
            viewer: "Panes",
          },
          createElement("p", null, "tabs"),
        ),
      ),
    );
    const title = html.slice(html.indexOf("panel-title"), html.indexOf("panel-actions"));
    const actionsHtml = html.slice(html.indexOf("panel-actions"));
    expect(title).not.toContain("panel-type");
    expect(actionsHtml).toContain("panel-type");
    expect(actionsHtml.indexOf("panel-type")).toBeLessThan(actionsHtml.indexOf("Panel settings"));
    expect(html).toContain(">Panes</span>");
  });
});
