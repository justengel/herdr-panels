import { describe, expect, it } from "vitest";
import { openFileBeside, panelWhenUnresolved } from "../src/fileOpen";

describe("opening a file from the explorer", () => {
  it("opens each file as a new split beside the explorer", () => {
    expect(openFileBeside("panel-files", "C:\\Users\\notes.txt")).toEqual({
      target: "C:\\Users\\notes.txt",
      from: "panel-files",
      direction: "right",
    });
  });

  it("opens a Linux absolute path as a file when the server cannot resolve it", () => {
    const path =
      "/tmp/claude-1000/-home-engel-projects-checkin/4486d599-0fa7-42c3-ba03-329780445b47/scratchpad/add_permissions.py";
    expect(panelWhenUnresolved(path)).toEqual({ type: "file", path });
  });

  it("keeps a web address as a browser when resolve fails", () => {
    expect(panelWhenUnresolved("https://example.com/docs")).toEqual({
      type: "iframe",
      url: "https://example.com/docs",
      proxy: false,
    });
  });
});
