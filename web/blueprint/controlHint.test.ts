import { describe, expect, it } from "vitest";
import { CONTROL_OFF_MESSAGE, controlHintVisible } from "../src/controlHint";

describe("control hint", () => {
  it("names the design bar when a panel cannot control Herdr", () => {
    expect(CONTROL_OFF_MESSAGE).toContain("cannot type into a pane");
    expect(CONTROL_OFF_MESSAGE).toContain('Turn on "control" in the design bar');
  });

  it("shows once for a plugin that declared herdr:control until that panel turns control on", () => {
    expect(controlHintVisible(["herdr:control", "files:read"], false, false)).toBe(true);
    expect(controlHintVisible(["herdr:control"], true, false)).toBe(false);
    expect(controlHintVisible(["herdr:control"], false, true)).toBe(false);
    expect(controlHintVisible(["herdr:read"], false, false)).toBe(false);
    expect(controlHintVisible(undefined, false, false)).toBe(false);
  });
});
