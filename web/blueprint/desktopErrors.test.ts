import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isPermissionError } from "../src/desktopBrowser";

describe("desktop command errors", () => {
  it("recognizes a command Tauri refused", () => {
    expect(isPermissionError("set_browser_zoom not allowed. Command not found")).toBe(true);
    expect(isPermissionError("Permission denied for this window")).toBe(true);
    expect(isPermissionError("forbidden")).toBe(true);
  });

  it("leaves ordinary failures to their own message", () => {
    expect(isPermissionError("the snapshot timed out")).toBe(false);
    expect(isPermissionError("browser bounds are invalid")).toBe(false);
  });
});

describe("desktop command permissions", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

  it("lists the commands the page already calls", () => {
    const permissions = readFileSync(join(root, "src-tauri/permissions/browser.toml"), "utf8");
    const capability = readFileSync(join(root, "src-tauri/capabilities/default.json"), "utf8");
    for (const [identifier, command] of [
      ["allow-set-browser-zoom", "set_browser_zoom"],
      ["allow-cursor-place", "cursor_place"],
      ["allow-snapshot-browser", "snapshot_browser"],
    ]) {
      expect(permissions).toContain(identifier);
      expect(permissions).toContain(`"${command}"`);
      expect(capability).toContain(identifier);
    }
  });
});
