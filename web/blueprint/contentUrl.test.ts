import { describe, expect, it } from "vitest";
import { contentUrl } from "../src/api";

describe("content urls keep an absolute posix path", () => {
  it("prefixes a posix absolute path so the server sees the leading slash", () => {
    expect(contentUrl("/home/me/x.html")).toBe("/content/%2Fhome/me/x.html");
    expect(contentUrl("/home/me/x.html", true)).toBe("/content/%2Fhome/me/x.html?bridge=1");
  });

  it("leaves a relative path and a windows drive path unprefixed", () => {
    expect(contentUrl("notes/a.html")).toBe("/content/notes/a.html");
    expect(contentUrl("notes/a.html", true)).toBe("/content/notes/a.html?bridge=1");
    expect(contentUrl("C:\\Users\\me\\x.html")).toBe("/content/C%3A/Users/me/x.html");
    expect(contentUrl("C:\\Users\\me\\x.html", true)).toBe("/content/C%3A/Users/me/x.html?bridge=1");
  });
});
