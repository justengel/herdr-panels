/** Herdr pane ids look like `w8:pG`. */
export function isHerdrPaneId(id: string): boolean {
  return /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/.test(id);
}
