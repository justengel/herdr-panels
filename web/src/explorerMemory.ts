export interface TreeEntry {
  name: string;
  path: string;
  kind: "dir" | "file";
}

export interface ExplorerMemory {
  open: Map<string, boolean>;
  entries: Map<string, TreeEntry[]>;
  scroll: number;
}

const panels = new Map<string, ExplorerMemory>();

export function createExplorerMemory(): ExplorerMemory {
  return { open: new Map(), entries: new Map(), scroll: 0 };
}

export function explorerMemory(panelId: string): ExplorerMemory {
  let memory = panels.get(panelId);
  if (!memory) {
    memory = createExplorerMemory();
    panels.set(panelId, memory);
  }
  return memory;
}

export function folderOpen(memory: ExplorerMemory, path: string, startOpen: boolean): boolean {
  return memory.open.has(path) ? memory.open.get(path) === true : startOpen;
}

export function rememberFolder(memory: ExplorerMemory, path: string, open: boolean) {
  memory.open.set(path, open);
}

export function cachedEntries(memory: ExplorerMemory, path: string): TreeEntry[] | undefined {
  return memory.entries.get(path);
}

export function rememberEntries(memory: ExplorerMemory, path: string, entries: TreeEntry[]) {
  memory.entries.set(path, entries);
}
