import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type HerdrConfig, type HerdrField } from "./api";
import {
  asDeskCommand,
  DESK_ACTIONS,
  effectiveBinding,
  isDeskKey,
  matchDesk,
  missingBindings,
  readDeskOverrides,
  resolveDeskBindings,
  writeDeskOverrides,
  type DeskCommand,
} from "./deskKeys";
import { desktopHost } from "./desktopBrowser";
import { frameOwnsKeys, framePrefix, readFrameKey, type FrameKey } from "./frameKeys";
import { chordMatches, eventKey, expandBinding } from "./herdrKeys";
import { HerdrSettings } from "./components/HerdrSettings";
import { applyTheme } from "./themes";
import type { RuntimeSnapshot } from "./types";

interface HostValue {
  prefix: boolean;
  config: HerdrConfig | null;
  renameTick: number;
  closeTick: number;
  settingsView: "settings" | "keybinds" | null;
  openSettings: () => void;
  openKeybinds: () => void;
  reloadConfig: () => Promise<void>;
  updateReady: () => void;
  detachView: () => void;
  consume: (event: KeyboardEvent) => boolean;
  /** True after the prefix key, before the following key. Reads the live flag, not the painted one. */
  prefixArmed: () => boolean;
  createSpace: (label?: string) => Promise<void>;
  /** Create a Herdr tab in this space, the same action as the TUI new-tab key. */
  newTab: (workspaceId?: string) => Promise<void>;
  renameSpace: (workspaceId: string, label: string) => Promise<void>;
  closeSpace: (workspaceId: string) => Promise<void>;
  applyThemeNow: (name: string) => Promise<void>;
  saveSettings: (settings: Record<string, string | number | boolean>) => Promise<void>;
  saveKeys: (keys: Record<string, string>) => Promise<void>;
  setIntegration: (target: string, action: "install" | "uninstall") => Promise<void>;
  setAgentOrder: (sort: "spaces" | "priority") => Promise<void>;
  registerDesk: (handler: (command: DeskCommand) => void) => void;
  deskBindings: Record<string, string>;
  deskOverrides: Record<string, string>;
  setDeskBinding: (id: string, value: string | null) => void;
}

const HostContext = createContext<HostValue | null>(null);

export function useHost(): HostValue {
  const host = useContext(HostContext);
  if (!host) throw new Error("useHost must be used inside HostProvider");
  return host;
}

export function HostProvider({
  runtime,
  onRuntime,
  onNotice,
  children,
}: {
  runtime: RuntimeSnapshot | null;
  onRuntime: (runtime: RuntimeSnapshot) => void;
  onNotice: (message: string) => void;
  children: ReactNode;
}) {
  const [config, setConfig] = useState<HerdrConfig | null>(null);
  const [prefix, setPrefix] = useState(false);
  const [settingsView, setSettingsView] = useState<"settings" | "keybinds" | null>(null);
  const [renameTick, setRenameTick] = useState(0);
  const [closeTick, setCloseTick] = useState(0);
  const prefixRef = useRef(false);
  const frameToken = useRef(crypto.randomUUID());
  const configRef = useRef<HerdrConfig | null>(null);
  const runtimeRef = useRef(runtime);
  const noticeRef = useRef(onNotice);
  const runtimeCb = useRef(onRuntime);
  const deskHandler = useRef<(command: DeskCommand) => void>(() => {});
  const registerDesk = useCallback((handler: (command: DeskCommand) => void) => {
    deskHandler.current = handler;
  }, []);
  const [deskOverrides, setDeskOverrides] = useState(() => readDeskOverrides(browserStorage()));
  const deskOverridesRef = useRef(deskOverrides);
  deskOverridesRef.current = deskOverrides;
  const setDeskBinding = useCallback((id: string, value: string | null) => {
    if (!DESK_ACTIONS.some((action) => action.id === id)) return;
    setDeskOverrides((current) => {
      const next = { ...current };
      if (value === null) delete next[id];
      else next[id] = value;
      writeDeskOverrides(browserStorage(), next);
      return next;
    });
  }, []);
  const deskBindings = useMemo(() => resolveDeskBindings(deskOverrides, config?.keys), [deskOverrides, config]);
  configRef.current = config;
  runtimeRef.current = runtime;
  noticeRef.current = onNotice;
  runtimeCb.current = onRuntime;

  useEffect(() => {
    void api
      .herdrConfig()
      .then((doc) => {
        setConfig(doc);
        applyTheme(doc.theme);
      })
      .catch(() => applyTheme("terminal"));
  }, []);

  async function refresh() {
    runtimeCb.current(await api.runtime());
  }

  async function runAction(action: string, index?: number) {
    const current = runtimeRef.current;
    const workspaceId = current?.focusedWorkspaceId || undefined;
    const tabId = current?.focusedTabId || undefined;
    const paneId = current?.focusedPaneId;
    const tabs = (current?.tabs ?? []).filter((tab) => !workspaceId || tab.workspaceId === workspaceId);
    const step = (items: { id: string }[], currentId: string | undefined, delta: number) => {
      if (items.length === 0) return undefined;
      const at = Math.max(0, items.findIndex((item) => item.id === currentId));
      return items[(at + delta + items.length) % items.length]?.id;
    };
    try {
      if (action === "new_workspace") {
        await api.herdrAction({ action: "workspace.create" });
        await refresh();
        noticeRef.current("Space created");
      } else if (action === "rename_workspace") setRenameTick((tick) => tick + 1);
      else if (action === "close_workspace") setCloseTick((tick) => tick + 1);
      else if (action === "settings") setSettingsView("settings");
      else if (action === "previous_workspace" || action === "next_workspace") {
        deskHandler.current({ action: "cycle-space", delta: action === "next_workspace" ? 1 : -1 });
      } else if (action === "switch_workspace" && index) {
        deskHandler.current({ action: "space", index });
      } else if (action === "zoom") {
        deskHandler.current({ action: "zoom" });
      } else if (action === "cycle_pane_next" || action === "cycle_pane_previous") {
        deskHandler.current({ action: "cycle-panel", delta: action === "cycle_pane_next" ? 1 : -1 });
      } else if (action === "help") {
        deskHandler.current({ action: "help" });
      } else if (action === "goto") {
        deskHandler.current({ action: "address" });
      } else if (action === "workspace_picker" || action === "toggle_sidebar") {
        deskHandler.current({ action: "spaces" });
      } else if (action === "next_agent" || action === "previous_agent") {
        deskHandler.current({ action: "cycle-agent", delta: action === "next_agent" ? 1 : -1 });
      } else if (action === "focus_agent" && index) {
        deskHandler.current({ action: "agent", index });
      } else if (action === "new_tab") {
        await newTab(workspaceId);
      } else if (action === "close_tab" && tabId) {
        await api.herdrAction({ action: "tab.close", tabId });
        await refresh();
      } else if (action === "previous_tab" || action === "next_tab") {
        const id = step(
          tabs.map((tab) => ({ id: tab.tabId })),
          tabId,
          action === "next_tab" ? 1 : -1,
        );
        if (id) {
          await api.focus({ tabId: id });
          await refresh();
        }
      } else if (action === "switch_tab" && index) {
        const tab = tabs[index - 1];
        if (tab) {
          await api.focus({ tabId: tab.tabId });
          await refresh();
        }
      } else if (action.startsWith("focus_pane_")) {
        const direction = action.replace("focus_pane_", "");
        await api.herdrAction({ action: "pane.focus_direction", direction, paneId: paneId ?? undefined });
        await refresh();
      } else if (action === "split_vertical" || action === "split_horizontal") {
        await api.herdrAction({
          action: "pane.split",
          direction: action === "split_vertical" ? "right" : "down",
          paneId: paneId ?? undefined,
        });
        await refresh();
      } else if (action === "close_pane" && paneId) {
        await api.herdrAction({ action: "pane.close", paneId });
        await refresh();
      } else if (action === "reload_config") {
        await reloadConfig();
      }
    } catch (err) {
      noticeRef.current(err instanceof Error ? err.message : String(err));
    }
  }

  const consumeRef = useRef<(event: KeyboardEvent) => boolean>(() => false);
  consumeRef.current = (event) => {
    if (event.key === "F12" || event.isComposing) return false;
    if (foreignDialog()) {
      if (event.key === "Escape") return false;
      event.preventDefault();
      return true;
    }
    const bindings = resolveDeskBindings(deskOverridesRef.current, configRef.current?.keys);
    const direct = asDeskCommand(matchDesk(bindings, event, false));
    if (direct) {
      prefixRef.current = false;
      setPrefix(false);
      event.preventDefault();
      deskHandler.current(direct);
      return true;
    }
    const doc = configRef.current;
    if (!doc) return false;
    const prefixBinding = fieldValue(doc.keys, "prefix") || "ctrl+b";
    const prefixChord = expandBinding(prefixBinding)[0];
    if (!prefixRef.current && prefixChord && chordMatches(prefixChord, event, false)) {
      prefixRef.current = true;
      setPrefix(true);
      event.preventDefault();
      return true;
    }
    if (prefixRef.current && (event.key === "Escape" || eventKey(event) === "esc")) {
      prefixRef.current = false;
      setPrefix(false);
      event.preventDefault();
      return true;
    }
    if (prefixRef.current) {
      const prefixed = asDeskCommand(matchDesk(bindings, event, true));
      if (prefixed) {
        prefixRef.current = false;
        setPrefix(false);
        event.preventDefault();
        deskHandler.current(prefixed);
        return true;
      }
    }
    const seen = new Set<string>();
    for (const field of doc.keys) {
      seen.add(field.key);
      if (field.key === "prefix" || isDeskKey(field.key) || typeof field.value !== "string") continue;
      const value = effectiveBinding(field.key, field.value);
      if (!value) continue;
      for (const chord of expandBinding(value)) {
        if (!chordMatches(chord, event, prefixRef.current)) continue;
        prefixRef.current = false;
        setPrefix(false);
        event.preventDefault();
        void runAction(field.key, chord.index);
        return true;
      }
    }
    for (const [key, value] of missingBindings()) {
      if (seen.has(key) || isDeskKey(key) || !value) continue;
      for (const chord of expandBinding(value)) {
        if (!chordMatches(chord, event, prefixRef.current)) continue;
        prefixRef.current = false;
        setPrefix(false);
        event.preventDefault();
        void runAction(key, chord.index);
        return true;
      }
    }
    if (prefixRef.current && event.key !== "Control" && event.key !== "Shift" && event.key !== "Alt" && event.key !== "Meta") {
      prefixRef.current = false;
      setPrefix(false);
      event.preventDefault();
      return true;
    }
    return false;
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, select, .xterm, .herdr-settings, .key-capture-backdrop")) return;
      consumeRef.current(event);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const relay = (key: FrameKey) => {
      consumeRef.current(
        new KeyboardEvent("keydown", {
          key: key.key,
          code: key.code,
          ctrlKey: key.ctrlKey,
          altKey: key.altKey,
          shiftKey: key.shiftKey,
          metaKey: key.metaKey,
          repeat: key.repeat,
          bubbles: true,
          cancelable: true,
        }),
      );
    };
    const page = window as Window & { __hwpRelayKey?: (key: FrameKey) => void };
    page.__hwpRelayKey = relay;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: string; type?: string } | null;
      if (data?.source === "hwp-keys" && data.type === "ready") {
        document.querySelectorAll("iframe").forEach((frame) => {
          if (frame instanceof HTMLIFrameElement && frameOwnsKeys(frame)) {
            frame.contentWindow?.postMessage(
              {
                source: "hwp-host",
                type: "prefix",
                token: frameToken.current,
                chord: framePrefix(String(configRef.current?.keys.find((field) => field.key === "prefix")?.value || "ctrl+b")) ?? {
                  ctrl: true,
                  alt: false,
                  shift: false,
                  meta: false,
                  key: "b",
                },
              },
              "*",
            );
          }
        });
        return;
      }
      const key = readFrameKey(event.data, frameToken.current);
      if (!key) return;
      const owned =
        event.source instanceof Window &&
        [...document.querySelectorAll("iframe")].some(
          (frame) => frame instanceof HTMLIFrameElement && frame.contentWindow === event.source && frameOwnsKeys(frame),
        );
      if (!owned && event.origin !== "null") return;
      relay(key);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      delete page.__hwpRelayKey;
    };
  }, []);

  useEffect(() => {
    const binding = String(config?.keys.find((field) => field.key === "prefix")?.value || "ctrl+b");
    const chord = framePrefix(binding) ?? { ctrl: true, alt: false, shift: false, meta: false, key: "b" };
    const desktop = desktopHost();
    if (desktop) void desktop.invoke("set_desk_prefix", { ...chord });
    const page = window as Window & { __hwpArmFrame?: (frame: Window) => void };
    page.__hwpArmFrame = (frame) => {
      frame.postMessage({ source: "hwp-host", type: "prefix", token: frameToken.current, chord }, "*");
    };
    const send = (frame: HTMLIFrameElement) => {
      frame.contentWindow?.postMessage({ source: "hwp-host", type: "prefix", token: frameToken.current, chord }, "*");
    };
    const onLoad = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLIFrameElement && frameOwnsKeys(target)) send(target);
    };
    document.addEventListener("load", onLoad, true);
    document.querySelectorAll("iframe").forEach((frame) => {
      if (frame instanceof HTMLIFrameElement && frameOwnsKeys(frame)) send(frame);
    });
    return () => {
      delete page.__hwpArmFrame;
      document.removeEventListener("load", onLoad, true);
    };
  }, [config]);

  async function newTab(workspaceId?: string) {
    const space = workspaceId || runtimeRef.current?.focusedWorkspaceId || undefined;
    try {
      await api.herdrAction({ action: "tab.create", workspaceId: space });
      await refresh();
    } catch (err) {
      noticeRef.current(err instanceof Error ? err.message : String(err));
    }
  }

  async function createSpace(label?: string) {
    try {
      await api.herdrAction({ action: "workspace.create", label });
      await refresh();
      noticeRef.current("Space created");
    } catch (err) {
      noticeRef.current(err instanceof Error ? err.message : String(err));
    }
  }

  async function renameSpace(workspaceId: string, label: string) {
    try {
      await api.herdrAction({ action: "workspace.rename", workspaceId, label });
      await refresh();
      noticeRef.current("Renamed");
    } catch (err) {
      noticeRef.current(err instanceof Error ? err.message : String(err));
    }
  }

  async function closeSpace(workspaceId: string) {
    try {
      await api.herdrAction({ action: "workspace.close", workspaceId });
      await refresh();
      noticeRef.current("Space closed");
    } catch (err) {
      noticeRef.current(err instanceof Error ? err.message : String(err));
    }
  }

  async function applyThemeNow(name: string) {
    applyTheme(name);
    const doc = await api.saveHerdrConfig({ theme: name });
    setConfig(doc);
    applyTheme(doc.theme);
  }

  async function saveSettings(settings: Record<string, string | number | boolean>) {
    const doc = await api.saveHerdrConfig({ settings });
    setConfig(doc);
    applyTheme(doc.theme);
    noticeRef.current("Applied");
  }

  async function setAgentOrder(sort: "spaces" | "priority") {
    try {
      const doc = await api.saveHerdrConfig({ settings: { agent_panel_sort: sort } });
      setConfig(doc);
      applyTheme(doc.theme);
    } catch (err) {
      noticeRef.current(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async function setIntegration(target: string, action: "install" | "uninstall") {
    const doc = await api.saveHerdrConfig({ integration: { target, action } });
    setConfig(doc);
    noticeRef.current(action === "install" ? "Integration installed" : "Integration removed");
  }

  async function saveKeys(keys: Record<string, string>) {
    const doc = await api.saveHerdrConfig({ keys });
    setConfig(doc);
    noticeRef.current("Keybinds saved");
  }

  async function reloadConfig() {
    const doc = await api.saveHerdrConfig({ reload: true });
    setConfig(doc);
    applyTheme(doc.theme);
    noticeRef.current("Reloaded Herdr config");
  }

  function updateReady() {
    noticeRef.current("An update is ready. Install it from the Herdr client.");
  }

  function detachView() {
    noticeRef.current("Detach is for the Herdr terminal. This page stays connected.");
  }

  const value: HostValue = {
    prefix,
    config,
    renameTick,
    closeTick,
    settingsView,
    openSettings: () => setSettingsView("settings"),
    openKeybinds: () => setSettingsView("keybinds"),
    reloadConfig,
    updateReady,
    detachView,
    consume: (event) => consumeRef.current(event),
    prefixArmed: () => prefixRef.current,
    createSpace,
    newTab,
    renameSpace,
    closeSpace,
    applyThemeNow,
    saveSettings,
    saveKeys,
    setIntegration,
    setAgentOrder,
    registerDesk,
    deskBindings,
    deskOverrides,
    setDeskBinding,
  };

  return (
    <HostContext.Provider value={value}>
      {children}
      {prefix ? <div className="prefix-mode">prefix</div> : null}
      {settingsView && config ? (
        <HerdrSettings
          config={config}
          mode={settingsView}
          onClose={() => setSettingsView(null)}
          onApplyTheme={applyThemeNow}
          onSaveSettings={saveSettings}
          onSaveKeys={saveKeys}
          onIntegration={setIntegration}
          deskBindings={deskBindings}
          deskOverrides={deskOverrides}
          onDeskBinding={setDeskBinding}
        />
      ) : null}
    </HostContext.Provider>
  );
}

function browserStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function foreignDialog(): boolean {
  return Boolean(document.querySelector(".settings-backdrop, .dialog-backdrop:not(.key-help)"));
}

function fieldValue(fields: HerdrField[], key: string): string {
  const field = fields.find((item) => item.key === key);
  return typeof field?.value === "string" ? field.value : "";
}
