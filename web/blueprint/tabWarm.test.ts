import { describe, expect, it } from "vitest";
import { tabsToMount, warmBrowser } from "../src/tabWarm";
import type { PanelTab, TabsPanel } from "../src/types";

function tab(id: string, panel: PanelTab["panel"]): PanelTab {
  return { id, title: id, panel };
}

function group(tabs: PanelTab[], active: string): TabsPanel {
  return { type: "tabs", edge: "top", active, tabs };
}

describe("browser tabs stay mounted", () => {
  const browser = tab("docs", { type: "iframe", url: "https://example.com/docs" });
  const other = tab("mail", { type: "iframe", url: "https://example.com/mail" });
  const note = tab("note", { type: "markdown", path: "notes/welcome.md" });
  const empty = tab("empty", { type: "iframe", url: "   " });

  it("keeps a browser that has been shown and the tab that is open", () => {
    const seen = new Set(["docs"]);
    const mounted = tabsToMount(group([browser, other, note], "note"), seen);
    expect(mounted.map((item) => item.id)).toEqual(["docs", "note"]);
  });

  it("does not mount a browser until it has been shown", () => {
    const mounted = tabsToMount(group([browser, other], "mail"), new Set());
    expect(mounted.map((item) => item.id)).toEqual(["mail"]);
  });

  it("drops a kept browser once that tab is no longer a page", () => {
    expect(warmBrowser(empty)).toBe(false);
    expect(warmBrowser(tab("page", { type: "html", path: "panels/charts.html" }))).toBe(true);
    const mounted = tabsToMount(group([note, empty], "note"), new Set(["empty", "note"]));
    expect(mounted.map((item) => item.id)).toEqual(["note"]);
  });
});
