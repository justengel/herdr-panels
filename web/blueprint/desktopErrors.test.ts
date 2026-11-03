import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isPermissionError, supportsWindowSnapshot } from "../src/desktopBrowser";

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

describe("window snapshot", () => {
  it("is offered on Linux only, including a Windows user agent that mentions Safari", () => {
    expect(supportsWindowSnapshot("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0")).toBe(false);
    expect(supportsWindowSnapshot("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)")).toBe(false);
    expect(supportsWindowSnapshot("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)")).toBe(true);
    expect(supportsWindowSnapshot("Mozilla/5.0 (Wayland; Linux x86_64)")).toBe(true);
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
      ["allow-snapshot-view", "snapshot_view"],
    ]) {
      expect(permissions).toContain(identifier);
      expect(permissions).toContain(`"${command}"`);
      expect(capability).toContain(identifier);
    }
  });
});
