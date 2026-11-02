import { describe, expect, it } from "vitest";
import { browserBounds, browserSlotKey, hideBrowserPanels, isRemotePage, menuCuts } from "../src/desktopBrowser";

describe("a browser panel covers its own rectangle", () => {
  it("places a webview on the panel content", () => {
    expect(browserBounds({ left: 320.4, top: 48.2, width: 640.2, height: 480.6 }, false)).toEqual({
      x: 320,
      y: 48,
      width: 640,
      height: 481,
    });
  });

  it("hides a browser panel while a dialog is open", () => {
    expect(hideBrowserPanels({ dragging: false, settings: false, dialog: true })).toBe(true);
    expect(hideBrowserPanels({ dragging: false, settings: true, dialog: false })).toBe(true);
    expect(hideBrowserPanels({ dragging: false, settings: false, dialog: false })).toBe(false);
    expect(browserBounds({ left: 10, top: 10, width: 400, height: 300 }, true)).toBeNull();
  });

  it("covers a menu without shrinking the page", () => {
    const page = { x: 100, y: 80, width: 600, height: 400 };
    expect(menuCuts(page, [{ x: 800, y: 80, width: 180, height: 240 }])).toEqual([]);
    expect(menuCuts(page, [{ x: 520, y: 90, width: 200, height: 320 }])).toEqual([
      { x: 520, y: 90, width: 180, height: 320 },
    ]);
    expect(
      menuCuts(page, [
        { x: 520, y: 90, width: 180, height: 280 },
        { x: 300, y: 120, width: 200, height: 160 },
      ]),
    ).toEqual([
      { x: 520, y: 90, width: 180, height: 280 },
      { x: 300, y: 120, width: 200, height: 160 },
    ]);
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

  it("keeps the same browser panel when it is locked", () => {
    const bounds = { x: 10, y: 20, width: 300, height: 200 };
    expect(browserSlotKey(bounds)).toBe("10,20,300,200");
    expect(browserSlotKey(null)).toBe("hidden");
  });
});
