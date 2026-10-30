import { describe, expect, it } from "vitest";
import { contentLabel } from "../src/layoutEdit";
import { displayTitle, isDefaultPanelTitle, titleFromPanel } from "../src/openTitle";

describe("open file or URL panel names", () => {
  it("uses the domain for web pages", () => {
    expect(titleFromPanel({ type: "iframe", url: "https://example.com/docs", proxy: false })).toBe(
      "example.com",
    );
    expect(titleFromPanel({ type: "iframe", url: "http://127.0.0.1:8080/app", proxy: true })).toBe(
      "127.0.0.1",
    );
  });

  it("uses the base filename for files and folders", () => {
    expect(titleFromPanel({ type: "markdown", path: "C:\\work\\notes\\welcome.md" })).toBe("welcome.md");
    expect(titleFromPanel({ type: "file", path: "/home/me/src/main.rs" })).toBe("main.rs");
    expect(titleFromPanel({ type: "explorer", path: "C:\\work\\pkg" })).toBe("pkg");
    expect(titleFromPanel({ type: "html", path: "panels/board.html" })).toBe("board.html");
  });

  it("treats blank and automatic labels as unnamed", () => {
    expect(isDefaultPanelTitle(null)).toBe(true);
    expect(isDefaultPanelTitle("")).toBe(true);
    expect(isDefaultPanelTitle("New panel")).toBe(true);
    expect(isDefaultPanelTitle("Panes")).toBe(true);
    expect(isDefaultPanelTitle("spaces")).toBe(true);
    expect(isDefaultPanelTitle("Notes")).toBe(false);
  });

  it("shows a file, site, or panel type until someone names the panel", () => {
    expect(displayTitle("Panes", { type: "explorer", path: "C:\\work\\pkg" })).toBe("pkg");
    expect(displayTitle(null, { type: "herdr", paneId: null })).toBe("Panes");
    expect(displayTitle("Panes", { type: "herdr", paneId: "w1:p1", scope: "pane" })).toBe("Terminal");
    expect(displayTitle("Charts", { type: "iframe", url: "https://example.com", proxy: false })).toBe("Charts");
    expect(displayTitle(null, { type: "iframe", url: "https://example.com/docs", proxy: false })).toBe(
      "example.com",
    );
    expect(displayTitle(null, { type: "markdown", path: "notes/welcome.md" })).toBe("welcome.md");
    expect(displayTitle(null, { type: "plugin", plugin: "checkin-report" }, "Check-in report")).toBe(
      "Check-in report",
    );
    expect(
      displayTitle(null, { type: "plugin", plugin: "checkin-report", path: "notes/welcome.md" }, "Check-in report"),
    ).toBe("welcome.md");
  });

  it("retitles content from the address when assignContent asks to", () => {
    expect(contentLabel({ type: "iframe", url: "https://github.com/org/repo", proxy: false })).toBe(
      "github.com",
    );
    expect(contentLabel({ type: "markdown", path: "notes/welcome.md" })).toBe("welcome.md");
    expect(contentLabel({ type: "blank" })).toBe("");
  });
});
