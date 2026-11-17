import { describe, expect, it } from "vitest";
import { isImageFile } from "../src/imageFile";

describe("image files", () => {
  it("treats a picture as an image and leaves text alone", () => {
    expect(isImageFile("shots/desk.png")).toBe(true);
    expect(isImageFile("C:\\pics\\photo.JPEG")).toBe(true);
    expect(isImageFile("icon.svg")).toBe(true);
    expect(isImageFile("src/main.rs")).toBe(false);
    expect(isImageFile("notes/welcome.md")).toBe(false);
    expect(isImageFile("readme")).toBe(false);
  });
});
