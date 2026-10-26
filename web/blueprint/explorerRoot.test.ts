import { describe, expect, it } from "vitest";
import { explorerRootFor } from "../src/explorerRoot";

describe("explorerRootFor", () => {
  it("roots at the workspace when the file is inside it", () => {
    expect(
      explorerRootFor("C:/Users/me/proj/examples/notes/welcome.md", "C:/Users/me/proj"),
    ).toBe("C:/Users/me/proj");
  });

  it("roots at the drive when the file is outside every workspace", () => {
    expect(explorerRootFor("D:/data/logs/app.log", "C:/Users/me/proj")).toBe("D:/");
    expect(explorerRootFor("D:\\data\\logs\\app.log", null)).toBe("D:\\");
  });

  it("roots at / when a Unix path has no workspace", () => {
    expect(explorerRootFor("/var/log/syslog", null)).toBe("/");
  });

  it("falls back to the parent folder for relative paths", () => {
    expect(explorerRootFor("notes/welcome.md", "C:/Users/me/proj")).toBe("notes");
  });
});
