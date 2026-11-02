import { describe, expect, it } from "vitest";
import { donorBrowser } from "../src/browserPlace";
import { browserShotPiece } from "../src/browserShot";

describe("moving a browser into a tab", () => {
  it("keeps the webview that is closing with the same page", () => {
    const waiting = [
      { label: "browser-notes", url: "https://example.com" },
      { label: "browser-google", url: "https://www.google.com/" },
    ];
    expect(donorBrowser(waiting, "https://www.google.com/", "browser-panel-3:tab-2")).toBe("browser-google");
    expect(donorBrowser(waiting, "https://www.google.com/", "browser-google")).toBeNull();
    expect(donorBrowser(waiting, "", "browser-panel-3:tab-2")).toBeNull();
  });
});

describe("a screenshot of a browser hole", () => {
  it("copies the whole page when the hole sits inside the shot", () => {
    expect(
      browserShotPiece(
        { left: 40, top: 20, width: 100, height: 50 },
        { left: 0, top: 0, width: 200, height: 100 },
      ),
    ).toEqual({ x: 40, y: 20, width: 100, height: 50, sx: 0, sy: 0, sw: 1, sh: 1 });
  });

  it("copies only the part of the page that the shot covers", () => {
    const piece = browserShotPiece(
      { left: 0, top: 0, width: 100, height: 100 },
      { left: 25, top: 50, width: 50, height: 40 },
    );
    expect(piece).toEqual({ x: 0, y: 0, width: 50, height: 40, sx: 0.25, sy: 0.5, sw: 0.5, sh: 0.4 });
  });

  it("skips a hole outside the shot", () => {
    expect(
      browserShotPiece({ left: 300, top: 0, width: 10, height: 10 }, { left: 0, top: 0, width: 20, height: 20 }),
    ).toBeNull();
  });
});
