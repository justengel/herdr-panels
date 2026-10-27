import { describe, expect, it } from "vitest";
import { climbExplorer, explorerRootFor, workspaceDirectory } from "../src/explorerRoot";

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

  it("roots a relative file at the workspace that contains it", () => {
    expect(explorerRootFor("notes/welcome.md", "C:/Users/me/proj")).toBe("C:/Users/me/proj");
  });

  it("falls back to the parent folder when a relative path has no workspace", () => {
    expect(explorerRootFor("notes/welcome.md", null)).toBe("notes");
  });

  it("uses the focused pane directory when the space has no root", () => {
    expect(
      workspaceDirectory(
        { workspaceId: "wG", root: null },
        [
          { workspaceId: "wH", focused: false, cwd: "C:/other" },
          { workspaceId: "wG", focused: true, cwd: "C:/Users/me/proj" },
        ],
      ),
    ).toBe("C:/Users/me/proj");
  });

  it("keeps an explicit workspace root", () => {
    expect(
      workspaceDirectory({ workspaceId: "wG", root: "C:/work/proj" }, [
        { workspaceId: "wG", focused: true, cwd: "C:/elsewhere" },
      ]),
    ).toBe("C:/work/proj");
  });

  it("climbs from a focused file to its parent directory", () => {
    expect(
      climbExplorer({
        type: "explorer",
        path: "C:/Users/me/proj",
        focus: "C:/Users/me/proj/examples/notes/welcome.md",
        addressBar: false,
      }),
    ).toEqual({
      type: "explorer",
      path: "C:/Users/me/proj/examples/notes",
      addressBar: false,
    });
  });
});
