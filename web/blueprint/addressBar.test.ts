import { describe, expect, it } from "vitest";
import {
  addressBarSurfaceId,
  applyAddressBarChoices,
  carryAddressBar,
  hostAddressBarVisible,
  setAddressBar,
  supportsAddressBar,
} from "../src/addressBar";
import type { LayoutNode, PanelConfig } from "../src/types";

const notes: PanelConfig = { type: "markdown", path: "notes/a.md" };
const files: PanelConfig = { type: "explorer", path: "C:\\work" };
const own: PanelConfig = { type: "plugin", plugin: "atlas" };

describe("address bar visibility", () => {
  it("shows the bar on a document until the panel hides it", () => {
    expect(supportsAddressBar(files)).toBe(true);
    expect(supportsAddressBar({ type: "herdr" })).toBe(false);
    expect(hostAddressBarVisible(files)).toBe(true);
    expect(hostAddressBarVisible({ ...files, addressBar: false })).toBe(false);
    expect(hostAddressBarVisible({ ...notes, addressBar: true })).toBe(true);
  });

  it("stores the gear choice on the panel that owns the bar", () => {
    expect(setAddressBar(files, false)).toEqual({ ...files, addressBar: false });
    expect(setAddressBar({ ...notes, addressBar: false }, true)).toEqual({ ...notes, addressBar: true });
    expect(setAddressBar({ type: "agents" }, false)).toEqual({ type: "agents" });
  });

  it("hides a plugin bar when the plugin replaces it, unless the panel says otherwise", () => {
    const replaced = { show: false, modify: false, replace: true };
    expect(hostAddressBarVisible(own, replaced)).toBe(false);
    expect(hostAddressBarVisible({ ...own, addressBar: true }, replaced)).toBe(true);
    expect(hostAddressBarVisible(own, { show: false, modify: false, replace: false })).toBe(false);
  });

  it("changes the active tab and keeps the choice when the address moves", () => {
    const group: PanelConfig = {
      type: "tabs",
      edge: "top",
      active: "one",
      tabs: [
        { id: "one", title: "One", panel: files },
        { id: "two", title: "Two", panel: notes },
      ],
    };
    const next = setAddressBar(group, false);
    expect(next).toMatchObject({
      tabs: [{ panel: { addressBar: false } }, { panel: notes }],
    });
    expect(carryAddressBar({ ...files, addressBar: false }, { type: "explorer", path: "C:\\" })).toEqual({
      type: "explorer",
      path: "C:\\",
      addressBar: false,
    });
    expect(carryAddressBar(files, { type: "herdr" })).toEqual({ type: "herdr" });
  });

  it("restores a hidden bar when a layout comes back without the choice", () => {
    const node: LayoutNode = {
      type: "panel",
      id: "files",
      title: "Files",
      panel: files,
    };
    expect(addressBarSurfaceId("files", files)).toBe("files");
    expect(addressBarSurfaceId("group", group())).toBe("group:one");
    expect(applyAddressBarChoices(node, "desk", { "desk:files": false })).toMatchObject({
      panel: { addressBar: false },
    });
    const kept: LayoutNode = { ...node, panel: { ...files, addressBar: true } };
    expect(applyAddressBarChoices(kept, "desk", { "desk:files": false })).toMatchObject({
      panel: { addressBar: true },
    });
  });
});

function group(): PanelConfig {
  return {
    type: "tabs",
    edge: "top",
    active: "one",
    tabs: [
      { id: "one", title: "One", panel: { type: "explorer", path: "C:\\work" } },
      { id: "two", title: "Two", panel: { type: "markdown", path: "notes/a.md" } },
    ],
  };
}
