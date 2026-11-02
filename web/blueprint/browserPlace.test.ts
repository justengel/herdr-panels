import { describe, expect, it } from "vitest";
import { browserLeader } from "../src/browserPlace";

describe("browser window owner", () => {
  it("lets the visit show its panels and hides the rest without a second owner", () => {
    const ids = new Set(["a"]);
    const kept = new Set(["b"]);
    expect(browserLeader("visit", ids, kept, "a")).toEqual({ leader: true, hide: false });
    expect(browserLeader("desk", ids, kept, "a")).toEqual({ leader: false, hide: true });
    expect(browserLeader("keeper", ids, kept, "b")).toEqual({ leader: true, hide: true });
    expect(browserLeader("desk", ids, kept, "c")).toEqual({ leader: true, hide: true });
    expect(browserLeader("desk", null, new Set(), "c")).toEqual({ leader: true, hide: false });
  });
});
