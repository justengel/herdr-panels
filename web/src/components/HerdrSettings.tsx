import { useEffect, useMemo, useState } from "react";
import type { HerdrConfig, HerdrField, HerdrIntegration } from "../api";
import {
  DESK_ACTIONS,
  bindingPlaceholder,
  isDeskKey,
  resolveDeskBindings,
  sameBindingList,
  summarizeBindings,
} from "../deskKeys";
import { KeyCapture } from "./KeyCapture";
import { IndicatorSample } from "./StatusMark";

const ORDER = [
  "theme",
  "indicators",
  "sound",
  "toasts",
  "pane-labels",
  "integrations",
  "interface",
  "general",
  "terminal",
  "update",
  "server",
  "session",
  "remote",
  "worktrees",
  "experimental",
  "advanced",
];

const TAB_LABEL: Record<string, string> = {
  theme: "theme",
  indicators: "indicators",
  sound: "sound",
  toasts: "toasts",
  "pane-labels": "pane labels",
  integrations: "integrations",
  interface: "interface",
  general: "general",
  terminal: "shell",
  update: "updates",
  server: "server",
  session: "session",
  remote: "remote",
  worktrees: "worktrees",
  experimental: "experimental",
  advanced: "advanced",
};

const BLURB: Record<string, string> = {
  theme: "This palette colors Herdr Panels and the Herdr terminal.",
  indicators: "Spaces and agents in this window use these marks and this order. The Herdr terminal uses them too.",
  sound: "Herdr plays these when an agent changes state. This window stays quiet.",
  toasts:
    "Herdr sends these. Inside Herdr draws them in the terminal. Via terminal asks the terminal Herdr is attached to. Via system is an operating-system notification, so it can appear while this window is open.",
  "pane-labels":
    "Space rows are the lines on each space here and in the Herdr terminal. Agent rows are the lines in the Herdr terminal’s agent list.",
  integrations: "Herdr installs these and receives agent status from them.",
  terminal: "Herdr uses this when it starts a pane.",
  update: "Herdr checks for its own updates.",
  server: "Herdr’s server process.",
  session: "Herdr restores agent sessions when it starts.",
  remote: "Herdr’s remote SSH setup.",
  worktrees: "Where Herdr keeps linked worktrees.",
  experimental: "Optional Herdr behavior.",
  advanced: "Herdr’s pane scrollback. This window reads that buffer.",
};

function audienceLabel(audience?: string): string {
  if (audience === "both") return "Panels and Herdr";
  if (audience === "panels") return "Panels";
  if (audience === "herdr") return "Herdr";
  return "";
}

function audienceTip(audience?: string): string {
  const omitted = "Settings that only change the Herdr terminal are omitted.";
  if (audience === "both" || audience === "panels") {
    return `Herdr Panels is this window. Panels and Herdr means this window and the Herdr terminal both use it. ${omitted}`;
  }
  return `Herdr is the server that owns panes, agents, and this config. A setting marked Herdr is the server’s. ${omitted}`;
}

function AudienceMark({ audience }: { audience?: string }) {
  const label = audienceLabel(audience);
  if (!label) return null;
  return (
    <span className="audience" title={audienceTip(audience)}>
      {label}
    </span>
  );
}

const CHOICE_LABEL: Record<string, string> = {
  dots: "Color dots",
  symbols: "Distinct symbols",
  herdr: "Inside Herdr",
  terminal: "Via terminal",
  system: "Via system",
  off: "Off",
  on: "On",
  true: "On",
  false: "Off",
};

export function HerdrSettings({
  config,
  mode,
  onClose,
  onApplyTheme,
  onSaveSettings,
  onSaveKeys,
  onIntegration,
  deskBindings,
  deskOverrides,
  onDeskBinding,
}: {
  config: HerdrConfig;
  mode: "settings" | "keybinds";
  onClose: () => void;
  onApplyTheme: (name: string) => Promise<void>;
  onSaveSettings: (settings: Record<string, string | number | boolean>) => Promise<void>;
  onSaveKeys: (keys: Record<string, string>) => Promise<void>;
  onIntegration: (target: string, action: "install" | "uninstall") => Promise<void>;
  deskBindings: Record<string, string>;
  deskOverrides: Record<string, string>;
  onDeskBinding: (id: string, value: string | null) => void;
}) {
  const tabs = useMemo(() => tabsFor(config.settings), [config.settings]);
  const [tab, setTab] = useState(tabs[0] ?? "theme");
  const [theme, setTheme] = useState(config.theme);
  const [settings, setSettings] = useState(config.settings);
  const [keys, setKeys] = useState(config.keys);
  const [query, setQuery] = useState("");
  const [keyTab, setKeyTab] = useState<"herdr" | "panels">("herdr");
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => setTheme(config.theme), [config.theme]);
  useEffect(() => setSettings(config.settings), [config.settings]);
  useEffect(() => setKeys(config.keys), [config.keys]);
  useEffect(() => {
    if (!tabs.includes(tab)) setTab(tabs[0] ?? "theme");
  }, [tab, tabs]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (editing) return;
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, onClose]);

  async function chooseTheme(name: string) {
    const previous = theme;
    setTheme(name);
    setBusy(true);
    setError("");
    try {
      await onApplyTheme(name);
    } catch (err) {
      setTheme(previous);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveGroup() {
    setBusy(true);
    setError("");
    const body: Record<string, string | number | boolean> = {};
    for (const field of settings) {
      if (field.group === tab) body[field.key] = field.value;
    }
    try {
      await onSaveSettings(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveKeys() {
    setBusy(true);
    setError("");
    const body: Record<string, string> = {};
    for (const field of keys) body[field.key] = String(field.value ?? "");
    try {
      await onSaveKeys(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function changeIntegration(target: string, action: "install" | "uninstall") {
    setBusy(true);
    setError("");
    try {
      await onIntegration(target, action);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function edit(field: HerdrField, value: string | number | boolean) {
    setSettings((current) => current.map((item) => (item.key === field.key ? { ...item, value } : item)));
  }

  function setKeyValue(key: string, value: string) {
    setKeys((current) => current.map((item) => (item.key === key ? { ...item, value } : item)));
  }

  const fields = settings.filter((field) => field.group === tab);
  const needle = query.trim().toLowerCase();
  const matchesKey = (field: HerdrField) =>
    !needle ||
    field.label.toLowerCase().includes(needle) ||
    field.key.toLowerCase().includes(needle) ||
    String(field.value ?? "").toLowerCase().includes(needle);
  const shownHerdrKeys = keys.filter((field) => !isDeskKey(field.key) && matchesKey(field));
  const shownDeskActions = DESK_ACTIONS.filter((action) => {
    if (!needle) return true;
    const text = deskBindings[action.id] ?? "";
    return (
      action.does.toLowerCase().includes(needle) ||
      action.id.includes(needle) ||
      text.toLowerCase().includes(needle) ||
      summarizeBindings(text).toLowerCase().includes(needle)
    );
  });
  const editingAction = DESK_ACTIONS.find((action) => action.id === editing) ?? null;
  const needsApply = mode === "keybinds" ? keyTab === "herdr" : tab !== "integrations" && fields.length > 0;

  return (
    <div className="settings-backdrop" onMouseDown={onClose}>
      <form
        className="herdr-settings"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (mode === "keybinds") {
            if (keyTab === "herdr") void saveKeys();
          } else if (needsApply) void saveGroup();
        }}
      >
        <header>
          <strong>{mode === "keybinds" ? "Keybinds" : "Settings"}</strong>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>
        {mode === "settings" ? (
          <div className="settings-tabs" role="tablist">
            {tabs.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? "on" : undefined}
                onClick={() => setTab(id)}
              >
                {TAB_LABEL[id] || id}
              </button>
            ))}
          </div>
        ) : (
          <>
            <div className="settings-tabs" role="tablist" aria-label="Keybind groups">
              <button
                type="button"
                role="tab"
                aria-selected={keyTab === "herdr"}
                className={keyTab === "herdr" ? "on" : undefined}
                onClick={() => setKeyTab("herdr")}
              >
                Herdr
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={keyTab === "panels"}
                className={keyTab === "panels" ? "on" : undefined}
                onClick={() => setKeyTab("panels")}
              >
                Panels
              </button>
            </div>
            <input
              className="settings-filter"
              aria-label="Filter keybinds"
              placeholder="Filter keybinds"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </>
        )}
        {mode === "keybinds" && keyTab === "herdr" ? (
          <p className="settings-note">
            These shortcuts are saved in Herdr, so a Herdr terminal uses them too. Panel shortcuts are on the Panels tab. Shortcuts that only the terminal uses are omitted.
          </p>
        ) : null}
        {mode === "keybinds" && keyTab === "panels" ? (
          <p className="settings-note">
            One row is one action. Several chords are separated by commas, so Alt+Shift+Arrows and Prefix+Arrows are a single shortcut. Change records the keys you press. Saved in this browser. Reset puts the usual chords back.
          </p>
        ) : null}
        {mode === "settings" && BLURB[tab] ? <p className="settings-note">{BLURB[tab]}</p> : null}
        {mode === "settings" && tab === "theme" ? (
          <div className="setting-heading">
            <h3>Theme</h3>
            <AudienceMark audience="both" />
          </div>
        ) : null}
        {mode === "settings" && tab === "theme" ? (
          <div className="theme-list" role="listbox" aria-label="Theme">
            {config.themes.map((name) => (
              <button
                key={name}
                type="button"
                role="option"
                aria-selected={name === theme}
                className={name === theme ? "on" : undefined}
                disabled={busy}
                onClick={() => void chooseTheme(name)}
              >
                <span>{name}</span>
                {name === theme ? <span aria-hidden="true">✓</span> : null}
              </button>
            ))}
          </div>
        ) : null}
        {mode === "settings" && tab === "integrations" ? (
          <>
            <div className="setting-heading">
              <h3>Integrations</h3>
              <AudienceMark audience="herdr" />
            </div>
            <IntegrationList items={config.integrations ?? []} error={config.integrationError} busy={busy} onChange={changeIntegration} />
          </>
        ) : null}
        {mode === "settings" && tab !== "integrations"
          ? fields.map((field) => (
              <div className="setting-block" key={field.key}>
                <div className="setting-heading">
                  <h3>{field.label}</h3>
                  <AudienceMark audience={field.audience} />
                </div>
                {field.help ? <p className="settings-note">{field.help}</p> : null}
                <FieldControl field={field} onChange={(value) => edit(field, value)} />
              </div>
            ))
          : null}
        {mode === "keybinds" && keyTab === "herdr" ? (
          <section>
            {shownHerdrKeys.map((field) => (
              <label className="setting-line" key={field.key}>
                <span>{field.label}</span>
                <input
                  aria-label={field.label}
                  value={String(field.value ?? "")}
                  placeholder={bindingPlaceholder(field.key) || undefined}
                  spellCheck={false}
                  onChange={(event) => setKeyValue(field.key, event.target.value)}
                />
              </label>
            ))}
          </section>
        ) : null}
        {mode === "keybinds" && keyTab === "panels" ? (
          <section>
            {shownDeskActions.map((action) => {
              const value = deskBindings[action.id] ?? "";
              const label = summarizeBindings(value) || "None";
              return (
                <div className="setting-line" key={action.id}>
                  <span>{action.does}</span>
                  <button
                    type="button"
                    className="key-edit"
                    aria-label={`Change ${action.does}: ${label}`}
                    onClick={() => setEditing(action.id)}
                  >
                    <span className="key-chord">{label}</span>
                    <span className="key-edit-action">Change</span>
                  </button>
                </div>
              );
            })}
          </section>
        ) : null}
        {editingAction ? (
          <KeyCapture
            action={editingAction}
            value={deskBindings[editingAction.id] ?? ""}
            fallback={fallbackFor(editingAction.id, deskOverrides, config.keys)}
            prefixBinding={String(config.keys.find((field) => field.key === "prefix")?.value || "ctrl+b")}
            taken={DESK_ACTIONS.filter((action) => action.id !== editingAction.id).map((action) => ({
              chords: deskBindings[action.id] ?? "",
              does: action.does,
            }))}
            onClose={() => setEditing(null)}
            onSave={(value) => {
              const fallback = fallbackFor(editingAction.id, deskOverrides, config.keys);
              onDeskBinding(editingAction.id, sameBindingList(value, fallback) ? null : value);
              setEditing(null);
            }}
          />
        ) : null}
        {error ? <p className="settings-error">{error}</p> : null}
        {needsApply ? (
          <footer>
            <span />
            <button type="submit" disabled={busy}>
              {busy ? "Applying" : "Apply"}
            </button>
          </footer>
        ) : tab === "theme" ? (
          <footer>
            <span className="settings-note">{busy ? "Applying" : "Choose a theme to apply it here and in Herdr."}</span>
          </footer>
        ) : null}
      </form>
    </div>
  );
}

function fallbackFor(id: string, overrides: Record<string, string>, keys: HerdrField[]): string {
  const rest = { ...overrides };
  delete rest[id];
  return resolveDeskBindings(rest, keys)[id] ?? "";
}

function tabsFor(settings: HerdrField[]): string[] {
  const present = new Set(settings.map((field) => field.group).filter((group): group is string => Boolean(group)));
  present.add("theme");
  present.add("integrations");
  const known = ORDER.filter((id) => present.has(id));
  const extra = [...present].filter((id) => !ORDER.includes(id)).sort();
  return [...known, ...extra];
}

function FieldControl({
  field,
  onChange,
}: {
  field: HerdrField;
  onChange: (value: string | number | boolean) => void;
}) {
  if (field.kind === "bool") {
    if (field.group === "sound" || field.group === "toasts") {
      return (
        <ChoiceList
          value={field.value === true ? "true" : "false"}
          options={[
            { value: "true", label: "On" },
            { value: "false", label: "Off" },
          ]}
          onChange={(value) => onChange(value === "true")}
        />
      );
    }
    return (
      <input
        className="setting-check"
        type="checkbox"
        aria-label={field.label}
        checked={field.value === true}
        onChange={(event) => onChange(event.target.checked)}
      />
    );
  }
  if (field.kind === "enum") {
    const choices = field.choices?.length ? field.choices : field.options.map((value) => ({ value, detail: undefined }));
    const options = choices.map((choice) => ({
      value: choice.value,
      label: CHOICE_LABEL[choice.value] || choice.value.replaceAll("_", " "),
      detail: choice.detail || undefined,
    }));
    return (
      <ChoiceList
        value={String(field.value)}
        options={options}
        sample={field.key === "status_indicators"}
        onChange={onChange}
      />
    );
  }
  if (field.kind === "tokens") {
    const selected = new Set(String(field.value ?? "").split(",").filter(Boolean));
    return (
      <div className="token-list">
        {field.options.map((option) => (
          <label key={option}>
            <input
              type="checkbox"
              checked={selected.has(option)}
              onChange={(event) => {
                const next = new Set(selected);
                if (event.target.checked) next.add(option);
                else next.delete(option);
                onChange(field.options.filter((item) => next.has(item)).join(","));
              }}
            />
            <span>{option.replaceAll("_", " ")}</span>
          </label>
        ))}
      </div>
    );
  }
  if (field.kind === "int") {
    return (
      <input
        className="setting-input"
        type="number"
        aria-label={field.label}
        value={Number(field.value)}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    );
  }
  return (
    <input
      className="setting-input"
      aria-label={field.label}
      value={String(field.value ?? "")}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function ChoiceList({
  value,
  options,
  sample,
  onChange,
}: {
  value: string;
  options: { value: string; label: string; detail?: string }[];
  sample?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="choice-list" role="listbox">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="option"
          aria-selected={option.value === value}
          className={option.value === value ? "on" : undefined}
          onClick={() => onChange(option.value)}
        >
          <span className="choice-copy">
            <span>{option.label}</span>
            {option.detail ? <span className="choice-detail">{option.detail}</span> : null}
          </span>
          {sample ? <IndicatorSample symbols={option.value === "symbols"} /> : null}
        </button>
      ))}
    </div>
  );
}

function IntegrationList({
  items,
  error,
  busy,
  onChange,
}: {
  items: HerdrIntegration[];
  error?: string;
  busy: boolean;
  onChange: (target: string, action: "install" | "uninstall") => void;
}) {
  if (error) return <p className="settings-error">{error}</p>;
  if (items.length === 0) return <p className="settings-note">Herdr reported no integrations.</p>;
  return (
    <ul className="integration-list">
      {items.map((item) => {
        const installed = item.state === "current" || item.state === "outdated";
        const status = installed ? (item.state === "outdated" ? "outdated" : "installed") : item.available ? "not installed" : "not found";
        return (
          <li key={item.target} className="integration-row">
            <span>
              <strong>{item.label || item.target}</strong>
              <span className="choice-detail">{status}</span>
            </span>
            <button type="button" disabled={busy} onClick={() => onChange(item.target, installed ? "uninstall" : "install")}>
              {installed ? "Remove" : "Install"}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
