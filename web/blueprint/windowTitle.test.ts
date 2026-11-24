import { describe, expect, it } from "vitest";
import { windowTitle } from "../src/windowTitle";

describe("desktop window title", () => {
  it("names a session other than default", () => {
    expect(windowTitle("demos")).toBe("Herdr Panels - demos");
    expect(windowTitle("default")).toBe("Herdr Panels");
    expect(windowTitle("")).toBe("Herdr Panels");
    expect(windowTitle("a/b")).toBe("Herdr Panels");
  });
});
