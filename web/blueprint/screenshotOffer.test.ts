import { describe, expect, it } from "vitest";
import { keepScreenshot, screenshotFileName, screenshotOffer } from "../src/screenshotOffer";

describe("screenshot save offer", () => {
  it("says the image was copied and still offers a file", () => {
    const offer = screenshotOffer(true, "file-dialog");
    expect(offer.heading).toBe("Screenshot");
    expect(offer.body).toMatch(/Copied to the clipboard/);
    expect(offer.body).toMatch(/nothing is written until you pick a file/i);
  });

  it("says when the clipboard did not take the image", () => {
    const offer = screenshotOffer(false, "downloads");
    expect(offer.body).toMatch(/did not take this image/);
    expect(offer.body).toMatch(/Downloads/);
  });

  it("names a png from the local time", () => {
    expect(screenshotFileName(new Date(2026, 9, 28, 22, 51, 3))).toBe("herdr-panels-20261028-225103.png");
  });

  it("writes nothing when the save dialog is cancelled", async () => {
    const result = await keepScreenshot(new Blob(["png"]), "herdr-panels.png", async () => null);
    expect(result).toEqual({ kind: "cancelled" });
  });

  it("keeps the path the person picked", async () => {
    const result = await keepScreenshot(
      new Blob(["png"]),
      "herdr-panels.png",
      async () => "C:\\shots\\herdr-panels.png",
    );
    expect(result).toEqual({ kind: "saved", path: "C:\\shots\\herdr-panels.png" });
  });

  it("reports a save dialog that cannot open", async () => {
    await expect(
      keepScreenshot(new Blob(["png"]), "herdr-panels.png", async () => {
        throw new Error("dialog unavailable");
      }),
    ).rejects.toThrow(/dialog unavailable/);
  });
});
