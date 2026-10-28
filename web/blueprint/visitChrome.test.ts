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
  rename: () => undefined,
  fill: () => undefined,
  filledId: null,
};

describe("a borrowed panel", () => {
  it("shows the name, the space, and Back, and keeps the page underneath", () => {
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
            onBack: () => undefined,
            fromSpace: "my_sixth_grimoire",
          },
          createElement("p", null, "https://google.com"),
        ),
      ),
    );
    expect(html).toContain("borrow-header");
    expect(html).toContain("google");
    expect(html).toContain("from my_sixth_grimoire");
    expect(html).toContain(">Back<");
    expect(html).toContain("https://google.com");
    expect(html).not.toContain("Fill the screen");
    expect(html).not.toContain("Close google");
  });
});
