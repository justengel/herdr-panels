import { describe, expect, it } from "vitest";
import { baseName, parentPath, samePath } from "../src/paths";

describe("paths follow the operating system they belong to", () => {
  it("keeps a posix path case-sensitive and slash-separated", () => {
    expect(parentPath("/home/me/Projects")).toBe("/home/me");
    expect(parentPath("/home")).toBe("/");
    expect(baseName("/home/me/Projects")).toBe("Projects");
    expect(samePath("/home/me/Projects", "/home/me")).toBe(true);
    expect(samePath("/home/me/Projects", "/home/Me")).toBe(false);
  });

  it("treats a drive path as windows, with either separator", () => {
    expect(parentPath("C:\\Users\\me\\Projects")).toBe("C:\\Users\\me");
    expect(parentPath("C:/Users")).toBe("C:/");
    expect(baseName("C:\\Users\\me\\readme.md")).toBe("readme.md");
    expect(samePath("C:\\Users\\me\\Projects", "c:/users/me")).toBe(true);
    expect(samePath("/home/me/Projects", "c:/users/me")).toBe(false);
  });
});
