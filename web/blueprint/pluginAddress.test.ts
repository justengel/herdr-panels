import { describe, expect, it } from "vitest";
import { pluginAddressBar, readPluginAddressMessage } from "../src/pluginAddress";

describe("plugin address bar", () => {
  it("shows the bar and refuses changes when a plugin does not ask", () => {
    expect(pluginAddressBar(undefined)).toEqual({ show: true, modify: false, replace: false });
    expect(pluginAddressBar({})).toEqual({ show: true, modify: false, replace: false });
  });

  it("reads the manifest flags", () => {
    expect(pluginAddressBar({ addressBar: { show: false, modify: false } })).toEqual({
      show: false,
      modify: false,
      replace: false,
    });
    expect(pluginAddressBar({ addressBar: { show: true, modify: true } })).toEqual({
      show: true,
      modify: true,
      replace: false,
    });
    expect(pluginAddressBar({ addressBar: { modify: true } })).toEqual({
      show: true,
      modify: true,
      replace: false,
    });
  });

  it("lets a plugin replace the host bar with its own", () => {
    expect(pluginAddressBar({ addressBar: { replace: true } })).toEqual({
      show: false,
      modify: false,
      replace: true,
    });
    expect(pluginAddressBar({ addressBar: { show: true, modify: true, replace: true } })).toEqual({
      show: false,
      modify: true,
      replace: true,
    });
  });

  it("accepts an address or a visibility change from the plugin", () => {
    expect(readPluginAddressMessage({ source: "hwp-plugin", type: "address", value: " notes/a " })).toEqual({
      type: "address",
      value: "notes/a",
    });
    expect(readPluginAddressMessage({ source: "hwp-plugin", type: "address-bar", show: false })).toEqual({
      type: "address-bar",
      show: false,
      replace: false,
    });
    expect(readPluginAddressMessage({ source: "hwp-plugin", type: "address-bar", replace: true })).toEqual({
      type: "address-bar",
      show: false,
      replace: true,
    });
  });

  it("accepts a plugin's own settings", () => {
    expect(readPluginAddressMessage({ source: "hwp-plugin", type: "config", value: { line: 4 } })).toEqual({
      type: "config",
      value: { line: 4 },
    });
    expect(readPluginAddressMessage({ source: "hwp-plugin", type: "config", value: [] })).toBeNull();
    expect(readPluginAddressMessage({ source: "hwp-plugin", type: "config", value: { blob: "x".repeat(33000) } })).toBeNull();
  });

  it("ignores other frames and unusable addresses", () => {
    expect(readPluginAddressMessage({ source: "hwp-host", type: "address", value: "x" })).toBeNull();
    expect(readPluginAddressMessage({ source: "hwp-plugin", type: "address", value: "   " })).toBeNull();
    expect(readPluginAddressMessage({ source: "hwp-plugin", type: "address", value: "x".repeat(2049) })).toBeNull();
    expect(readPluginAddressMessage({ source: "hwp-plugin", type: "address-bar", show: "no" })).toBeNull();
    expect(readPluginAddressMessage(null)).toBeNull();
  });
});
