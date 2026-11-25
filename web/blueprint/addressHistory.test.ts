import { describe, expect, it } from "vitest";
import { followPage, historyForSurface, noteAddress, visitAddress, type AddressHistory } from "../src/addressHistory";

const start: AddressHistory = { entries: ["C:\\Users"], index: 0 };

describe("address history", () => {
  it("replaces the step the bar just submitted when the address is canonicalized", () => {
    const visited = visitAddress(start, "example.com");
    const noted = noteAddress(visited, "https://example.com", true);
    expect(noted).toEqual({ entries: ["C:\\Users", "https://example.com"], index: 1 });
  });

  it("pushes an address that changed outside the bar so Back can return", () => {
    const noted = noteAddress(start, "C:\\Users\\me", false);
    expect(noted).toEqual({ entries: ["C:\\Users", "C:\\Users\\me"], index: 1 });
    expect(noted.entries[noted.index - 1]).toBe("C:\\Users");
  });

  it("drops the forward stack when a new address arrives after Back", () => {
    const history: AddressHistory = { entries: ["a", "b", "c"], index: 1 };
    expect(noteAddress(history, "d", false)).toEqual({ entries: ["a", "b", "d"], index: 2 });
    expect(visitAddress(history, "d")).toEqual({ entries: ["a", "b", "d"], index: 2 });
  });

  it("leaves history alone when the address is already the current step", () => {
    const history: AddressHistory = { entries: ["a", "b"], index: 1 };
    expect(noteAddress(history, "b", false)).toEqual(history);
    expect(visitAddress(history, "b")).toEqual(history);
  });

  it("keeps the typed step when a different page arrives while that step is still settling", () => {
    const history: AddressHistory = { entries: ["https://a.example", "https://b.example"], index: 1 };
    expect(noteAddress(history, "https://c.example", true)).toEqual({
      entries: ["https://a.example", "https://b.example", "https://c.example"],
      index: 2,
    });
  });

  it("rewrites only the canonical form of the address the bar just opened", () => {
    const history: AddressHistory = { entries: ["https://a.example/docs", "example.com/docs"], index: 1 };
    expect(noteAddress(history, "https://example.com/docs/", true)).toEqual({
      entries: ["https://a.example/docs", "https://example.com/docs/"],
      index: 1,
    });
  });

  it("steps back when the page reports the previous address", () => {
    const history: AddressHistory = {
      entries: [
        "https://github.com/cli/cli/pull/1/files",
        "https://github.com/cli/cli/pull/1/files#diff-abc",
      ],
      index: 1,
    };
    expect(followPage(history, "https://github.com/cli/cli/pull/1/files")).toEqual({
      entries: history.entries,
      index: 0,
    });
  });

  it("steps forward when the page reports the next address", () => {
    const history: AddressHistory = {
      entries: ["https://github.com/cli/cli/pull/1/files", "https://github.com/cli/cli/pull/1/commits"],
      index: 0,
    };
    expect(followPage(history, "https://github.com/cli/cli/pull/1/commits")).toEqual({
      entries: history.entries,
      index: 1,
    });
  });

  it("pushes a new fragment and drops the pages beyond the current one", () => {
    const history: AddressHistory = {
      entries: ["https://github.com/cli/cli/pull/1/files", "https://github.com/cli/cli/pull/1/commits"],
      index: 0,
    };
    expect(followPage(history, "https://github.com/cli/cli/pull/1/files#diff-abc")).toEqual({
      entries: [
        "https://github.com/cli/cli/pull/1/files",
        "https://github.com/cli/cli/pull/1/files#diff-abc",
      ],
      index: 1,
    });
  });

  it("keeps the current step when the page repeats that address", () => {
    const history: AddressHistory = { entries: ["https://example.com/a#x"], index: 0 };
    expect(followPage(history, "https://example.com/a#x")).toEqual(history);
    expect(followPage(history, "https://example.com/a/#x")).toEqual({
      entries: ["https://example.com/a/#x"],
      index: 0,
    });
  });

  it("restores a surface's own steps and then records where it is now", () => {
    const saved: AddressHistory = { entries: ["/home/me/a", "/home/me/b"], index: 1 };
    expect(historyForSurface(undefined, "/home/me/now")).toEqual({ entries: ["/home/me/now"], index: 0 });
    expect(historyForSurface(saved, "/home/me/b")).toEqual(saved);
    expect(historyForSurface(saved, "/home/me/c")).toEqual({
      entries: ["/home/me/a", "/home/me/b", "/home/me/c"],
      index: 2,
    });
  });
});
