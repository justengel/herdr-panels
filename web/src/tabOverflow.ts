export interface StripEnds {
  before: boolean;
  after: boolean;
}

/** Which ends of a tab strip are past the visible window. A hidden scrollbar still scrolls. */
export function stripEnds(scroll: number, view: number, size: number): StripEnds {
  const slack = 1;
  return {
    before: scroll > slack,
    after: scroll + view < size - slack,
  };
}
