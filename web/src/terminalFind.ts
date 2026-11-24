import type { TermHit } from "./findText";

export interface TermFind {
  search(query: string, matchCase: boolean): TermHit[];
  show(hit: TermHit): void;
  clear(): void;
}

const bound = new WeakMap<HTMLElement, TermFind>();

export function bindTerminalFind(shell: HTMLElement, find: TermFind) {
  bound.set(shell, find);
}

export function unbindTerminalFind(shell: HTMLElement) {
  bound.delete(shell);
}

export function terminalFind(shell: HTMLElement): TermFind | null {
  return bound.get(shell) ?? null;
}
