import { describe, expect, it } from "vitest";
import { browseHint } from "../src/components/LocationBar";

describe("browseHint", () => {
  it("keeps filesystem addresses for the native picker start folder", () => {
    expect(browseHint("C:\\work\\notes\\welcome.md")).toBe("C:\\work\\notes\\welcome.md");
    expect(browseHint("C:\\work\\notes")).toBe("C:\\work\\notes");
    expect(browseHint("/home/me/src")).toBe("/home/me/src");
  });

  it("skips URLs and plugins", () => {
    expect(browseHint("https://example.com")).toBeNull();
    expect(browseHint("plugin:welcome")).toBeNull();
    expect(browseHint("")).toBeNull();
    expect(browseHint("  ")).toBeNull();
  });
});
