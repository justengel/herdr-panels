import { describe, expect, it } from "vitest";
import { expandBinding, chordMatches } from "../src/herdrKeys";
import {
  bindingConflict,
  bindingWhenMissing,
  chordsOverlap,
  deskCommand,
  directionChord,
  DESK_ACTIONS,
  DESK_HELP,
  effectiveBinding,
  focusInDirection,
  formatChord,
  isDeskKey,
  joinBindings,
  layoutForFocusedPane,
  layoutForPaneFocus,
  revealPaneOnDesk,
  arrowMovesList,
  listDelta,
  matchDesk,
  panelForKind,
  panelForPane,
  panelRefs,
  readDeskOverrides,
  readingOrder,
  recordChord,
  resolveDeskBindings,
  splitBindings,
  stepIndex,
  summarizeBindings,
  widenDigit,
  writeDeskOverrides,
  type Box,
} from "../src/deskKeys";
import type { LayoutNode } from "../src/types";

function press(
  key: string,
  mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean; code?: string; repeat?: boolean } = {},
) {
  return {
    key,
    code: mods.code ?? "",
    ctrlKey: mods.ctrl ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
    metaKey: mods.meta ?? false,
    repeat: mods.repeat ?? false,
  };
}

describe("desk shortcuts", () => {
  it("moves between panels with alt+shift+arrows, not ctrl+alt+arrows", () => {
    expect(deskCommand(press("ArrowLeft", { alt: true, shift: true }), false)).toEqual({
      action: "focus",
      direction: "left",
    });
    expect(deskCommand(press("ArrowDown", { alt: true, shift: true }), false)?.direction).toBe("down");
    expect(deskCommand(press("ArrowUp", { alt: true, shift: true }), false)?.direction).toBe("up");
    expect(deskCommand(press("ArrowRight", { alt: true, shift: true }), false)?.direction).toBe("right");
    // Ctrl+Alt+Arrow rotates the display on some Windows machines. Alt+Arrow is browser history.
    expect(deskCommand(press("ArrowLeft", { ctrl: true, alt: true }), false)).toBeNull();
    expect(deskCommand(press("ArrowLeft", { alt: true }), false)).toBeNull();
    expect(deskCommand(press("ArrowLeft"), false)).toBeNull();
  });

  it("keeps prefix arrows for panels when a list row is focused", () => {
    expect(arrowMovesList(press("ArrowDown"), true)).toBe(false);
    expect(arrowMovesList(press("ArrowUp"), true)).toBe(false);
    expect(arrowMovesList(press("ArrowDown"), false)).toBe(true);
    expect(arrowMovesList(press("ArrowUp"), false)).toBe(true);
    expect(arrowMovesList(press("ArrowDown", { alt: true, shift: true }), false)).toBe(false);
  });

  it("uses prefix arrows for panels and leaves prefix+hjkl for Herdr panes", () => {
    expect(deskCommand(press("ArrowLeft"), true)).toEqual({ action: "focus", direction: "left" });
    expect(deskCommand(press("h"), true)).toBeNull();
    expect(deskCommand(press("j"), true)).toBeNull();
    expect(deskCommand(press("k"), true)).toBeNull();
    expect(deskCommand(press("l"), true)).toBeNull();
    expect(deskCommand(press("Tab"), true)).toEqual({ action: "cycle-panel", delta: 1 });
    expect(deskCommand(press("Tab", { shift: true }), true)).toEqual({ action: "cycle-panel", delta: -1 });
    expect(deskCommand(press("Enter"), true)).toEqual({ action: "enter" });
    expect(deskCommand(press("a"), true)).toEqual({ action: "agents" });
    expect(deskCommand(press("w"), true)).toEqual({ action: "spaces" });
    expect(deskCommand(press("s"), true)).toBeNull();
    expect(deskCommand(press("d"), true)).toBeNull();
    expect(deskCommand(press("a", { alt: true }), true)).toBeNull();
    expect(deskCommand(press("ArrowLeft", { alt: true }), true)).toEqual({ action: "move", direction: "left" });
    expect(deskCommand(press("w", { alt: true }), true)).toEqual({ action: "close" });
    expect(deskCommand(press("z"), true)).toEqual({ action: "undo" });
    expect(deskCommand(press("z", { shift: true }), true)).toEqual({ action: "redo" });
    expect(deskCommand(press("t"), true)).toEqual({ action: "reopen" });
    expect(deskCommand(press("f"), true)).toEqual({ action: "zoom" });
    expect(deskCommand(press("u"), true)).toBeNull();
    expect(deskCommand(press("z", { ctrl: true }), false)).toBeNull();
    expect(deskCommand(press("z", { ctrl: true, shift: true }), false)).toBeNull();
    expect(deskCommand(press("w", { alt: true, repeat: true }), true)).toBeNull();
  });

  it("fills empty space and agent bindings", () => {
    expect(effectiveBinding("next_workspace", "")).toBe("prefix+alt+n");
    expect(effectiveBinding("previous_workspace", "")).toBe("prefix+alt+p");
    expect(effectiveBinding("switch_workspace", "")).toBe("prefix+shift+1..9");
    expect(effectiveBinding("next_agent", "")).toBe("prefix+alt+.");
    expect(effectiveBinding("previous_agent", "")).toBe("prefix+alt+,");
    expect(effectiveBinding("focus_agent", "")).toBe("prefix+alt+1..9");
    expect(effectiveBinding("next_workspace", "prefix+n")).toBe("prefix+n");
    expect(effectiveBinding("zoom", "")).toBe("");
  });

  it("uses Herdr defaults when the server omits a key, and keeps a cleared zoom off", () => {
    expect(bindingWhenMissing("zoom")).toBe("prefix+z");
    expect(bindingWhenMissing("cycle_pane_next")).toBe("prefix+tab");
    expect(bindingWhenMissing("help")).toBe("prefix+?");
    expect(bindingWhenMissing("toggle_sidebar")).toBe("prefix+b");
  });

  it("matches a shifted digit by its number key", () => {
    const [chord] = expandBinding("prefix+shift+1");
    expect(
      chordMatches(chord, press("!", { shift: true, code: "Digit1" }) as unknown as KeyboardEvent, true),
    ).toBe(true);
    expect(chordMatches(chord, press("1", { code: "Digit1" }) as unknown as KeyboardEvent, true)).toBe(false);
  });

  it("keeps panel shortcuts apart from Herdr shortcuts", () => {
    expect(isDeskKey("zoom")).toBe(false);
    expect(isDeskKey("next_workspace")).toBe(true);
    expect(isDeskKey("focus_agent")).toBe(true);
    expect(isDeskKey("settings")).toBe(false);
    expect(isDeskKey("focus_pane_left")).toBe(false);
    expect(isDeskKey("prefix")).toBe(false);
    const bound = DESK_ACTIONS.flatMap((action) => action.herdr ?? []);
    expect(new Set(bound).size).toBe(bound.length);
    const focus = DESK_HELP.filter((row) => row.does === "Focus the panel in that direction");
    expect(focus).toHaveLength(1);
    expect(focus[0]?.keys).toBe("Alt+Shift+Arrows, Prefix+Arrows");
  });

  it("formats chords for the help list", () => {
    expect(formatChord("prefix+alt+1..9")).toBe("Prefix+Alt+1 to 9");
    expect(formatChord("prefix+shift+tab")).toBe("Prefix+Shift+Tab");
    expect(formatChord("prefix+alt+.")).toBe("Prefix+Alt+Period");
    expect(DESK_HELP.some((row) => row.keys === "Prefix+Z" && row.does.includes("back"))).toBe(true);
    expect(DESK_HELP.some((row) => row.keys === "Prefix+F" && row.does.includes("Fill"))).toBe(true);
    expect(DESK_HELP.some((row) => row.keys === "Prefix+T")).toBe(true);
    expect(DESK_HELP.some((row) => row.does.toLowerCase().includes("agent"))).toBe(true);
  });
});

describe("panel geometry", () => {
  const boxes: Box[] = [
    { id: "a", left: 0, top: 0, right: 100, bottom: 100 },
    { id: "b", left: 100, top: 0, right: 200, bottom: 100 },
    { id: "c", left: 0, top: 100, right: 200, bottom: 200 },
  ];

  it("picks the nearest panel in that direction", () => {
    expect(focusInDirection(boxes, "a", "right")).toBe("b");
    expect(focusInDirection(boxes, "b", "left")).toBe("a");
    expect(focusInDirection(boxes, "a", "down")).toBe("c");
    expect(focusInDirection(boxes, "c", "up")).toBe("a");
    expect(focusInDirection(boxes, "b", "right")).toBeNull();
  });

  it("does not treat a side-by-side panel as down", () => {
    const beside: Box[] = [
      { id: "tall", left: 400, top: 0, right: 800, bottom: 400 },
      { id: "side", left: 0, top: 200, right: 400, bottom: 400 },
    ];
    expect(focusInDirection(beside, "tall", "down")).toBeNull();
    expect(focusInDirection(beside, "tall", "left")).toBe("side");
  });

  it("prefers a near panel over a far one on the same axis", () => {
    const row: Box[] = [
      { id: "a", left: 0, top: 0, right: 100, bottom: 100 },
      { id: "near", left: 100, top: 40, right: 140, bottom: 80 },
      { id: "far", left: 400, top: 40, right: 500, bottom: 60 },
    ];
    expect(focusInDirection(row, "a", "right")).toBe("near");
  });

  it("walks panels in reading order", () => {
    expect(readingOrder(boxes)).toEqual(["a", "b", "c"]);
    expect(stepIndex(3, 2, 1)).toBe(0);
    expect(stepIndex(3, -1, 1)).toBe(0);
    expect(stepIndex(3, -1, -1)).toBe(2);
    expect(stepIndex(0, 0, 1)).toBe(-1);
  });
});

describe("which panel shows a pane", () => {
  const terminal = (id: string, paneId: string) => ({
    id,
    panel: { type: "herdr" as const, paneId },
  });

  it("keeps a terminal that already shows the pane", () => {
    const panels = panelRefs([
      terminal("a", "w1:p1"),
      terminal("b", "w1:p2"),
      { id: "note", panel: { type: "markdown" as const, path: "n.md" } },
    ]);
    expect(panelForPane(panels, "w1:p2", "note")).toEqual({ id: "b", rebind: false });
    expect(panelForPane(panels, "w1:p9", "a")).toEqual({ id: "a", rebind: true });
    expect(panelForPane(panels, "w1:p9", "note")).toEqual({ id: "a", rebind: true });
    expect(panelForKind(panels, "markdown")).toBe("note");
    expect(panelForKind(panels, "agents")).toBeNull();
  });

  it("does not retarget the first terminal when another already has the pane", () => {
    const root: LayoutNode = {
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: { type: "panel", id: "a", title: "Terminal", panel: { type: "herdr", paneId: "w1:p1" } },
      second: { type: "panel", id: "b", title: "Other", panel: { type: "herdr", paneId: "w1:p2" } },
    };
    expect(layoutForFocusedPane(root, "w1:p2")).toBe(root);
    const moved = layoutForFocusedPane(root, "w1:p3");
    expect(moved.type === "split" && moved.first.type === "panel" && moved.first.panel).toEqual({
      type: "herdr",
      paneId: "w1:p3",
    });
    expect(moved.type === "split" && moved.second.type === "panel" && moved.second.panel).toEqual({
      type: "herdr",
      paneId: "w1:p2",
    });
  });

  it("keeps the terminal that already shows the pane", () => {
    const root: LayoutNode = {
      type: "panel",
      id: "term",
      title: "Terminal",
      panel: { type: "herdr", paneId: "wC:p1" },
    };
    expect(revealPaneOnDesk(root, "wC:p1", null)).toEqual({ root, panelId: "term" });
  });

  it("does not retarget a side shell when another pane should be shown", () => {
    const root: LayoutNode = {
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: { type: "panel", id: "space", title: "Terminal", panel: { type: "herdr", paneId: "w1:p1" } },
      second: {
        type: "panel",
        id: "side",
        title: "Shell",
        panel: { type: "herdr", paneId: "w1:p9", scope: "pane" },
      },
    };
    const revealed = revealPaneOnDesk(root, "w2:p4", "side");
    expect(revealed.panelId).toBe("space");
    expect(revealed.root).toMatchObject({
      first: { panel: { type: "herdr", paneId: "w2:p4" } },
      second: { panel: { type: "herdr", paneId: "w1:p9", scope: "pane" } },
    });
  });

  it("rebinds the focused terminal and leaves the other pane alone", () => {
    const root: LayoutNode = {
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: { type: "panel", id: "a", title: "Terminal", panel: { type: "herdr", paneId: "w1:p1" } },
      second: { type: "panel", id: "b", title: "Other", panel: { type: "herdr", paneId: "w1:p2" } },
    };
    const revealed = revealPaneOnDesk(root, "w2:p4", "b");
    expect(revealed.panelId).toBe("b");
    expect(revealed.root).toMatchObject({
      first: { panel: { type: "herdr", paneId: "w1:p1" } },
      second: { panel: { type: "herdr", paneId: "w2:p4" } },
    });
  });

  it("opens a terminal when the space has none", () => {
    const root: LayoutNode = {
      type: "panel",
      id: "report",
      title: "Check-in",
      panel: { type: "plugin", plugin: "checkin-report", control: true },
    };
    const revealed = revealPaneOnDesk(root, "wC:p1", null);
    expect(revealed.panelId).not.toBe("report");
    expect(revealed.root).toMatchObject({
      type: "split",
      direction: "row",
      first: { id: "report" },
      second: { id: revealed.panelId, title: null, panel: { type: "herdr", paneId: "wC:p1" } },
    });
  });

  it("opens Panes beside two terminal panels when the shell is not already shown", () => {
    const root: LayoutNode = {
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: {
        type: "panel",
        id: "left",
        title: "Terminal",
        panel: { type: "herdr", paneId: "w1:p1", scope: "pane" },
      },
      second: {
        type: "panel",
        id: "right",
        title: "Terminal",
        panel: { type: "herdr", paneId: "w1:p2", scope: "pane" },
      },
    };
    const shown = revealPaneOnDesk(root, "w1:p2", null);
    expect(shown.panelId).toBe("right");
    expect(shown.root).toMatchObject({
      first: { panel: { scope: "pane", paneId: "w1:p1" } },
      second: { panel: { scope: "pane", paneId: "w1:p2" } },
    });
    const revealed = revealPaneOnDesk(root, "w1:p3", null);
    expect(revealed.root).toMatchObject({
      first: { id: "left", panel: { scope: "pane", paneId: "w1:p1" } },
      second: {
        first: { id: "right", panel: { scope: "pane", paneId: "w1:p2" } },
        second: { title: null, panel: { type: "herdr", paneId: "w1:p3" } },
      },
    });
    const created =
      revealed.root.type === "split" &&
      revealed.root.second.type === "split" &&
      revealed.root.second.second.type === "panel"
        ? revealed.root.second.second.panel
        : null;
    expect(created?.type === "herdr" ? created.scope : "pane").toBeUndefined();
  });

  it("activates a background tab that already shows the pane", () => {
    const root: LayoutNode = {
      type: "panel",
      id: "stack",
      title: "Stack",
      panel: {
        type: "tabs",
        edge: "top",
        active: "note",
        tabs: [
          { id: "note", title: "Note", panel: { type: "markdown", path: "n.md" } },
          { id: "term", title: "Terminal", panel: { type: "herdr", paneId: "wC:p1" } },
        ],
      },
    };
    const revealed = revealPaneOnDesk(root, "wC:p1", null);
    expect(revealed.panelId).toBe("stack");
    expect(revealed.root).toMatchObject({
      panel: { type: "tabs", active: "term" },
    });
  });

  it("switches to the pane's workspace layout and binds that pane", () => {
    const here: LayoutNode = {
      type: "panel",
      id: "report",
      title: "Check-in",
      panel: { type: "plugin", plugin: "checkin-report", control: true },
    };
    const there: LayoutNode = {
      type: "panel",
      id: "term",
      title: "Terminal",
      panel: { type: "herdr", paneId: "w1:p1" },
    };
    const next = layoutForPaneFocus("w1", here, "w2", there, "w2:p4", "report");
    expect(next).toMatchObject({
      workspaceId: "w2",
      panelId: "term",
      root: { id: "term", panel: { type: "herdr", paneId: "w2:p4" } },
    });
    expect(here).toMatchObject({ panel: { type: "plugin", plugin: "checkin-report" } });
  });
});

describe("binding lists", () => {
  it("keeps a comma that is the key when splitting chords", () => {
    expect(splitBindings("prefix+alt+., prefix+alt+,")).toEqual(["prefix+alt+.", "prefix+alt+,"]);
    expect(splitBindings("up, down")).toEqual(["up", "down"]);
    expect(joinBindings(["prefix+b", "prefix+b", ""])).toBe("prefix+b");
  });

  it("shows both focus chords as one comma-separated shortcut", () => {
    const bindings = resolveDeskBindings({}, undefined);
    expect(summarizeBindings(bindings.focus)).toBe("Alt+Shift+Arrows, Prefix+Arrows");
    expect(summarizeBindings(bindings.move)).toBe("Prefix+Alt+Arrows");
    expect(matchDesk(bindings, press(",", { alt: true }), true)).toEqual({ action: "cycle-agent", delta: -1 });
    expect(matchDesk(bindings, press(".", { alt: true }), true)).toEqual({ action: "cycle-agent", delta: 1 });
  });

  it("uses a saved list instead of the other focus chords", () => {
    const custom = resolveDeskBindings(
      { focus: "ctrl+shift+left, ctrl+shift+right, ctrl+shift+up, ctrl+shift+down" },
      undefined,
    );
    expect(matchDesk(custom, press("ArrowLeft", { ctrl: true, shift: true }), false)).toEqual({
      action: "focus",
      direction: "left",
    });
    expect(matchDesk(custom, press("ArrowLeft", { alt: true, shift: true }), false)).toBeNull();
    expect(matchDesk(custom, press("ArrowLeft"), true)).toBeNull();
    expect(summarizeBindings(custom.focus)).toBe("Ctrl+Shift+Arrows");
  });

  it("keeps fill on prefix+f when Herdr still uses prefix+z for zoom", () => {
    expect(resolveDeskBindings({}, [{ key: "zoom", value: "" }]).zoom).toBe("prefix+f");
    expect(resolveDeskBindings({}, [{ key: "zoom", value: "prefix+z" }]).zoom).toBe("prefix+f");
    expect(resolveDeskBindings({}, []).zoom).toBe("prefix+f");
    const bindings = resolveDeskBindings({}, [{ key: "zoom", value: "prefix+z" }]);
    expect(matchDesk(bindings, press("z"), true)).toEqual({ action: "undo" });
    expect(matchDesk(bindings, press("z", { shift: true }), true)).toEqual({ action: "redo" });
    expect(matchDesk(bindings, press("f"), true)).toEqual({ action: "zoom" });
    expect(matchDesk(bindings, press("t"), true)).toEqual({ action: "reopen" });
    expect(resolveDeskBindings({ zoom: "prefix+m" }, [{ key: "zoom", value: "prefix+z" }]).zoom).toBe("prefix+m");
    expect(
      resolveDeskBindings({}, [
        { key: "toggle_sidebar", value: "prefix+b" },
        { key: "workspace_picker", value: "" },
      ]).spaces,
    ).toBe("prefix+b");
  });

  it("records a keypress and refuses a chord another action already uses", () => {
    expect(recordChord(press("ArrowLeft", { alt: true, shift: true }), false)).toBe("alt+shift+left");
    expect(directionChord("alt+shift+left")).toBe(true);
    expect(directionChord("alt+shift+q")).toBe(false);
    expect(recordChord(press("ArrowDown"), true)).toBe("prefix+down");
    expect(recordChord(press("Shift"), false)).toBeNull();
    expect(recordChord(press("Escape"), true)).toBeNull();
    expect(recordChord(press("!", { shift: true, code: "Digit1" }), true)).toBe("prefix+shift+1");
    expect(widenDigit("prefix+shift+1")).toBe("prefix+shift+1..9");
    expect(chordsOverlap("prefix+shift+1", "prefix+shift+1..9")).toBe(true);
    expect(chordsOverlap("prefix+z", "prefix+a")).toBe(false);
    expect(bindingConflict("prefix+z", [{ chords: "prefix+z", does: "Zoom the focused panel, or show the whole desk" }])).toBe(
      "Zoom the focused panel, or show the whole desk",
    );
  });

  it("stores only known panel actions", () => {
    const saved = new Map<string, string>();
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => {
        saved.set(key, value);
      },
    };
    writeDeskOverrides(storage, { focus: "prefix+left", zoom: "", extra: "prefix+q" });
    expect(readDeskOverrides(storage)).toEqual({ focus: "prefix+left", zoom: "" });
    expect(readDeskOverrides({ getItem: () => "{" })).toEqual({});
    expect(formatChord("prefix+alt+,")).toBe("Prefix+Alt+Comma");
  });
});

describe("list rows", () => {
  it("moves with plain arrows only", () => {
    expect(listDelta(press("ArrowDown"))).toBe(1);
    expect(listDelta(press("ArrowUp"))).toBe(-1);
    expect(listDelta(press("ArrowDown", { alt: true }))).toBeNull();
    expect(listDelta(press("j"))).toBeNull();
  });
});
