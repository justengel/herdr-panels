import { describe, expect, it } from "vitest";
import { charsThatFit, displayPath, expandDisplayPath, guessHome, middleEllipsis } from "../src/displayPath";

describe("displayPath", () => {
  it("collapses home to ~ and expands it again", () => {
    const home = "C:/Users/jteng";
    expect(displayPath("C:/Users/jteng/projects/herdr-panels/notes/a.md", home)).toBe(
      "~/projects/herdr-panels/notes/a.md",
    );
    expect(expandDisplayPath("~/projects/herdr-panels/notes/a.md", home).replace(/\\/g, "/")).toBe(
      "C:/Users/jteng/projects/herdr-panels/notes/a.md",
    );
  });

  it("guesses a Windows home prefix", () => {
    expect(guessHome("C:\\Users\\jteng\\projects\\x")).toMatch(/Users\/jteng$/i);
  });
});

describe("middleEllipsis", () => {
  it("keeps the start and leaf when the path is too long", () => {
    expect(middleEllipsis("~/projects/herdr-panels/examples/notes/welcome.md", 28)).toBe(
      "~/projects/…/welcome.md",
    );
  });

  it("leaves short paths alone", () => {
    expect(middleEllipsis("~/notes/a.md", 40)).toBe("~/notes/a.md");
  });

  it("keeps the whole path when it fits and otherwise the longest ellipsis", () => {
    const text = "~/projects/herdr-panels/examples/notes/welcome.md";
    expect(charsThatFit(text, text.length, (sample) => sample.length)).toBe(text.length);
    const max = charsThatFit(text, 28, (sample) => sample.length);
    const shown = middleEllipsis(text, max);
    expect(shown.length).toBeLessThanOrEqual(28);
    expect(shown.startsWith("~/")).toBe(true);
    expect(shown.endsWith("welcome.md")).toBe(true);
  });

  it("keeps the host and leaf for long URLs", () => {
    expect(middleEllipsis("https://example.com/very/long/path/here", 28)).toBe(
      "https://example.com/…/here",
    );
  });
});
