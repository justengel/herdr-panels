export interface SelectableRoot {
  contains(node: unknown): boolean;
}

export interface TextSelection {
  collapsed: boolean;
  text: string;
  anchor: unknown;
  focus: unknown;
}

/** Highlighted characters inside one panel. A click, or a highlight that leaves the panel, copies nothing. */
export function selectedText(root: SelectableRoot, selection: TextSelection | null): string | null {
  if (!selection || selection.collapsed || selection.text === "") return null;
  if (!root.contains(selection.anchor) || !root.contains(selection.focus)) return null;
  return selection.text;
}
