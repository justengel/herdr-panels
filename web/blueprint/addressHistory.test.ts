import { describe, expect, it } from "vitest";
import { noteAddress, visitAddress, type AddressHistory } from "../src/addressHistory";

const start: AddressHistory = { entries: ["C:\\Users"], index: 0 };

describe("address history", () => {
  it("replaces the step the bar just submitted when the address is canonicalized", () => {
    const visited = visitAddress(start, "example.com");
    const noted = noteAddress(visited, "https://example.com", true);
    expect(noted).toEqual({ entries: ["C:\\Users", "https://example.com"], index: 1 });
  });

  it("pushes an address that changed outside the bar so Back can return", () => {
    const noted = noteAddress(start, "C:\\Users\\jteng", false);
    expect(noted).toEqual({ entries: ["C:\\Users", "C:\\Users\\jteng"], index: 1 });
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
});
