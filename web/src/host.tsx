import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, type HerdrConfig, type HerdrField } from "./api";
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
  createSpace: (label?: string) => Promise<void>;
  renameSpace: (workspaceId: string, label: string) => Promise<void>;
  closeSpace: (workspaceId: string) => Promise<void>;
  applyThemeNow: (name: string) => Promise<void>;
  saveSettings: (settings: Record<string, string | number | boolean>) => Promise<void>;
  saveKeys: (keys: Record<string, string>) => Promise<void>;
  setAgentOrder: (sort: "spaces" | "priority") => Promise<void>;
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
  const configRef = useRef<HerdrConfig | null>(null);
  const runtimeRef = useRef(runtime);
  const noticeRef = useRef(onNotice);
  const runtimeCb = useRef(onRuntime);
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
    const spaces = current?.workspaces ?? [];
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
        const id = step(
          spaces.map((space) => ({ id: space.workspaceId })),
          workspaceId,
          action === "next_workspace" ? 1 : -1,
        );
        if (id) {
          await api.focus({ workspaceId: id });
          await refresh();
        }
      } else if (action === "switch_workspace" && index) {
        const space = spaces[index - 1];
        if (space) {
          await api.focus({ workspaceId: space.workspaceId });
          await refresh();
        }
      } else if (action === "new_tab") {
        await api.herdrAction({ action: "tab.create", workspaceId });
        await refresh();
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
    for (const field of doc.keys) {
      if (field.key === "prefix" || typeof field.value !== "string" || !field.value) continue;
      for (const chord of expandBinding(field.value)) {
        if (!chordMatches(chord, event, prefixRef.current)) continue;
        prefixRef.current = false;
        setPrefix(false);
        event.preventDefault();
        void runAction(field.key, chord.index);
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
      if (target instanceof Element && target.closest("input, textarea, select, .xterm, .herdr-settings")) return;
      consumeRef.current(event);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    createSpace,
    renameSpace,
    closeSpace,
    applyThemeNow,
    saveSettings,
    saveKeys,
    setAgentOrder,
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
        />
      ) : null}
    </HostContext.Provider>
  );
}

function fieldValue(fields: HerdrField[], key: string): string {
  const field = fields.find((item) => item.key === key);
  return typeof field?.value === "string" ? field.value : "";
}
