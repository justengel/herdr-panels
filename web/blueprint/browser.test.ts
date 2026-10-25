import { describe, expect, it } from "vitest";
import { browserBounds, fitAround, isRemotePage } from "../src/desktopBrowser";

describe("a browser panel covers its own rectangle", () => {
  it("places a webview on the panel content", () => {
    expect(browserBounds({ left: 320.4, top: 48.2, width: 640.2, height: 480.6 }, false)).toEqual({
      x: 320,
      y: 48,
      width: 640,
      height: 481,
    });
  });

  it("hides the webview when a drag or dialog is covering the desk", () => {
    expect(browserBounds({ left: 10, top: 10, width: 400, height: 300 }, true)).toBeNull();
  });

  it("keeps the page visible beside a right-click menu", () => {
    const page = { x: 100, y: 80, width: 600, height: 400 };
    expect(fitAround(page, [{ x: 800, y: 80, width: 180, height: 240 }])).toEqual(page);
    expect(fitAround(page, [{ x: 120, y: 90, width: 200, height: 80 }])).toEqual({
      x: 100,
      y: 176,
      width: 600,
      height: 304,
    });
    expect(fitAround(page, [{ x: 110, y: 90, width: 180, height: 360 }])).toEqual({
      x: 296,
      y: 80,
      width: 404,
      height: 400,
    });
  });

  it("hides a sliver that cannot show a page", () => {
    expect(browserBounds({ left: 0, top: 0, width: 1, height: 200 }, false)).toBeNull();
  });

  it("treats http and https addresses as their own pages", () => {
    expect(isRemotePage("https://example.com")).toBe(true);
    expect(isRemotePage("http://127.0.0.1:8080/app")).toBe(true);
    expect(isRemotePage("/proxy/http/127.0.0.1/")).toBe(false);
    expect(isRemotePage("notes/welcome.md")).toBe(false);
  });
});
