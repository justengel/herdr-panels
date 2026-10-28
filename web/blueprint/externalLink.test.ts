import { describe, expect, it } from "vitest";
import { frameLinkAction, noteLinkAction, openableHttpUrl } from "../src/externalLink";

const page = "http://127.0.0.1:4737/plugins/checkin-report";

describe("only http and https addresses can be opened", () => {
  it("accepts an http or https address", () => {
    expect(openableHttpUrl("https://example.com")).toBe("https://example.com/");
    expect(openableHttpUrl("  http://127.0.0.1:8080/app?q=1#top ")).toBe(
      "http://127.0.0.1:8080/app?q=1#top",
    );
    expect(openableHttpUrl("HTTPS://Example.COM/docs")).toBe("https://example.com/docs");
  });

  it("refuses other schemes and broken addresses", () => {
    for (const raw of [
      "javascript:alert(1)",
      "file:///tmp/x",
      "file:///C:/Windows/win.ini",
      "herdr://panel",
      "data:text/html,hi",
      "about:blank",
      "ftp://example.com",
      "http://",
      "",
      "   ",
      "not a url",
      "example.com",
    ]) {
      expect(openableHttpUrl(raw), raw).toBeNull();
    }
    expect(openableHttpUrl(`https://example.com/${"a".repeat(5000)}`)).toBeNull();
    expect(openableHttpUrl("https://exa\nmple.com/")).toBeNull();
  });
});

describe("a frame link opens outside only when it leaves the page", () => {
  it("opens another site, and a blank target, and leaves the plugin page alone", () => {
    expect(frameLinkAction("https://example.com/pr/1", page, "")).toBe("open");
    expect(frameLinkAction("https://example.com/pr/1", page, "_blank")).toBe("open");
    expect(frameLinkAction("/guide.html", page, "")).toBe("stay");
    expect(frameLinkAction("#findings", page, "")).toBe("stay");
    expect(frameLinkAction("#findings", page, "_blank")).toBe("open");
    expect(frameLinkAction("javascript:alert(1)", page, "_blank")).toBe("block");
    expect(frameLinkAction("file:///tmp/x", page, "_blank")).toBe("block");
    expect(frameLinkAction("herdr://panel", page, "")).toBe("block");
  });
});

describe("a note link opens http and https addresses", () => {
  it("scrolls to a heading and refuses other schemes", () => {
    const note = "http://127.0.0.1:4737/";
    expect(noteLinkAction("https://example.com", note)).toBe("open");
    expect(noteLinkAction("#install", note)).toBe("stay");
    expect(noteLinkAction("javascript:alert(1)", note)).toBe("block");
    expect(noteLinkAction("file:///tmp/x", note)).toBe("block");
  });
});
