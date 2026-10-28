import { describe, expect, it } from "vitest";
import { pluginListChanged } from "../src/pluginList";
import type { PluginInfo } from "../src/desk";

const welcome: PluginInfo = { id: "welcome", title: "Welcome" };

describe("plugin list refresh", () => {
  it("keeps the list when nothing was installed", () => {
    expect(pluginListChanged([welcome], [{ id: "welcome", title: "Welcome" }])).toBe(false);
  });

  it("notices a plugin that was just installed", () => {
    const notes: PluginInfo = { id: "notes", title: "Notes" };
    expect(pluginListChanged([welcome], [welcome, notes])).toBe(true);
  });

  it("notices a plugin that was removed", () => {
    expect(pluginListChanged([welcome], [])).toBe(true);
  });

  it("notices a new title on an installed plugin", () => {
    expect(pluginListChanged([welcome], [{ id: "welcome", title: "Hello" }])).toBe(true);
  });
});
