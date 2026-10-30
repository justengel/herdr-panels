import { describe, expect, it } from "vitest";
import { fileBrowserLabel, terminalDirectory } from "../src/explorerMenu";

describe("files row menu", () => {
  it("starts a terminal in a folder, or in a file's parent", () => {
    expect(terminalDirectory("C:/work/notes", "dir")).toBe("C:/work/notes");
    expect(terminalDirectory("C:/work/notes/a.md", "file")).toBe("C:/work/notes");
    expect(terminalDirectory("/tmp/claude/add_permissions.py", "file")).toBe("/tmp/claude");
  });

  it("names the file browser for the platform", () => {
    expect(fileBrowserLabel("Win32")).toBe("Open in Explorer");
    expect(fileBrowserLabel("MacIntel")).toBe("Open in Finder");
    expect(fileBrowserLabel("Linux x86_64")).toBe("Open in file manager");
  });
});
