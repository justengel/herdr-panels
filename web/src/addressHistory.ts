export interface AddressHistory {
  entries: string[];
  index: number;
}

/** Record an address submitted from the bar and drop anything after the current step. */
export function visitAddress(history: AddressHistory, next: string): AddressHistory {
  const trimmed = next.trim();
  if (!trimmed) return history;
  const kept = history.entries.slice(0, history.index + 1);
  if (kept[kept.length - 1] !== trimmed) kept.push(trimmed);
  return { entries: kept, index: kept.length - 1 };
}

/**
 * Record an address that arrived after navigation.
 * A bar submission rewrites the step it just created when the address is canonicalized.
 * Any other change pushes a step so Back can return to the previous address.
 */
export function noteAddress(history: AddressHistory, value: string, fromBar: boolean): AddressHistory {
  if (!value) return history;
  if (history.entries[history.index] === value) return history;
  if (fromBar && history.index >= 0 && history.index < history.entries.length) {
    const entries = history.entries.slice();
    entries[history.index] = value;
    return { entries, index: history.index };
  }
  const kept = history.entries.slice(0, Math.max(history.index, -1) + 1);
  kept.push(value);
  return { entries: kept, index: kept.length - 1 };
}
