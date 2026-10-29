import { describe, expect, it } from "vitest";
import {
  addressToCopy,
  charsThatFit,
  displayPath,
  expandDisplayPath,
  focusedAddress,
  guessHome,
  middleEllipsis,
} from "../src/displayPath";

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

  it("does not turn a narrow path into the tail of the file name", () => {
    const shown = middleEllipsis("~/projects/herdr-panels/examples/panels/charts.html", 8);
    expect(shown.startsWith("…")).toBe(true);
    expect(shown).not.toBe("rts.html");
  });
});

describe("focused address", () => {
  const stored = "C:/Users/jteng/projects/herdr-panels/examples/panels/charts.html";

  it("uses the home shortcut when the field is focused", () => {
    expect(focusedAddress(stored)).toBe("~/projects/herdr-panels/examples/panels/charts.html");
  });

  it("leaves a path outside home unchanged", () => {
    expect(focusedAddress("D:/other/charts.html")).toBe("D:/other/charts.html");
  });

  it("copies the home shortcut when select-all hits an unedited fitted field", () => {
    const shown = "~/projects/herdr-panels/examples/panels/charts.html";
    const fitted = middleEllipsis(displayPath(stored, guessHome(stored)), 8);
    expect(fitted).not.toBe(shown);
    expect(addressToCopy(stored, fitted, false, true)).toBe(shown);
    expect(addressToCopy(stored, "C:/tmp/other.html", true, true)).toBe("C:/tmp/other.html");
    expect(addressToCopy(stored, "charts", false, false)).toBe("charts");
  });
});
