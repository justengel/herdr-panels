import { describe, expect, it } from "vitest";
import {
  cachedEntries,
  createExplorerMemory,
  explorerMemory,
  folderOpen,
  rememberEntries,
  rememberFolder,
} from "../src/explorerMemory";

describe("explorer memory", () => {
  it("keeps folders open or closed when the Files panel is built again", () => {
    const memory = createExplorerMemory();
    expect(folderOpen(memory, "C:\\proj", true)).toBe(true);
    expect(folderOpen(memory, "C:\\proj\\examples", false)).toBe(false);

    rememberFolder(memory, "C:\\proj\\examples", true);
    rememberFolder(memory, "C:\\proj\\src", false);

    expect(folderOpen(memory, "C:\\proj\\examples", false)).toBe(true);
    expect(folderOpen(memory, "C:\\proj\\src", true)).toBe(false);
  });

  it("keeps a folder listing so the tree can paint before the next read", () => {
    const memory = createExplorerMemory();
    const entries = [{ name: "notes", path: "C:\\proj\\examples\\notes", kind: "dir" as const }];
    expect(cachedEntries(memory, "C:\\proj\\examples")).toBeUndefined();
    rememberEntries(memory, "C:\\proj\\examples", entries);
    expect(cachedEntries(memory, "C:\\proj\\examples")).toEqual(entries);
  });

  it("keeps that memory for the same Files panel", () => {
    const first = explorerMemory("panel-files-memory");
    rememberFolder(first, "C:\\proj\\examples", true);
    expect(folderOpen(explorerMemory("panel-files-memory"), "C:\\proj\\examples", false)).toBe(true);
    expect(explorerMemory("panel-files-other")).not.toBe(first);
  });
});
