import { describe, expect, it } from "vitest";
import { settleCssColor } from "../src/cssColor";

describe("screenshot colors", () => {
  it("turns a WebKit srgb color() into rgb", () => {
    expect(settleCssColor("color(srgb 0.2 0.4 0.6)")).toBe("rgb(51, 102, 153)");
  });

  it("keeps the alpha from color()", () => {
    expect(settleCssColor("color(srgb 1 0 0 / 0.5)")).toBe("rgba(255, 0, 0, 0.5)");
    expect(settleCssColor("color(srgb 20% 40% 60% / 50%)")).toBe("rgba(51, 102, 153, 0.5)");
  });

  it("mixes two colors the way color-mix does", () => {
    expect(settleCssColor("color-mix(in srgb, rgb(255, 0, 0) 25%, rgb(0, 0, 255))")).toBe("rgb(64, 0, 191)");
  });

  it("mixes a color into transparent", () => {
    expect(settleCssColor("color-mix(in srgb, rgb(226, 182, 87) 16%, transparent)")).toBe("rgba(226, 182, 87, 0.16)");
  });

  it("rewrites a color() inside a shadow and leaves rgb alone", () => {
    expect(settleCssColor("0 8px 24px color(srgb 0 0 0 / 0.35)")).toBe("0 8px 24px rgba(0, 0, 0, 0.35)");
    expect(settleCssColor("rgb(1, 2, 3)")).toBe("rgb(1, 2, 3)");
  });
});
