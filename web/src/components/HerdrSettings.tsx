import { useEffect, useState } from "react";
import type { HerdrConfig, HerdrField } from "../api";

const TABS = [
  ["theme", "theme"],
  ["indicators", "indicators"],
  ["sound", "sound"],
  ["toasts", "toasts"],
  ["pane-labels", "pane labels"],
  ["integrations", "integrations"],
] as const;

const CHOICE: Record<string, string> = {
  dots: "color dots",
  symbols: "distinct symbols",
  off: "off",
  herdr: "inside herdr",
  terminal: "via terminal",
  system: "via system",
  "top-left": "top left",
  "top-right": "top right",
  "bottom-left": "bottom left",
  "bottom-right": "bottom right",
};

const BLURB: Record<string, string> = {
  indicators: "Choose color dots or distinct symbols for each agent state.",
  sound: "Play sounds when agents change state in the background.",
  toasts: "Choose where background popup notifications should appear.",
  "pane-labels": "Show detected agent names in split pane borders.",
  integrations: "Agents report state directly instead of relying only on process detection. Install integrations from the Herdr client.",
};

export function HerdrSettings({
  config,
  mode,
  onClose,
  onApplyTheme,
  onSaveSettings,
  onSaveKeys,
}: {
  config: HerdrConfig;
  mode: "settings" | "keybinds";
  onClose: () => void;
  onApplyTheme: (name: string) => Promise<void>;
  onSaveSettings: (settings: Record<string, string | number | boolean>) => Promise<void>;
  onSaveKeys: (keys: Record<string, string>) => Promise<void>;
}) {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("theme");
  const [theme, setTheme] = useState(config.theme);
  const [settings, setSettings] = useState(config.settings);
  const [keys, setKeys] = useState(config.keys);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => setTheme(config.theme), [config.theme]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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

  const fields = settings.filter((field) => field.group === tab);

  return (
    <div className="settings-backdrop" onMouseDown={onClose}>
      <form
        className="herdr-settings"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (mode === "keybinds") void saveKeys();
          else if (tab !== "theme") void saveGroup();
        }}
      >
        <header>
          <strong>{mode === "keybinds" ? "keybinds" : "settings"}</strong>
          <button type="button" onClick={onClose}>
            esc close
          </button>
        </header>
        {mode === "settings" ? (
          <div className="settings-tabs" role="tablist">
            {TABS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? "on" : undefined}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
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
        {mode === "settings" && tab !== "theme" ? (
          <section>
            {BLURB[tab] ? <p className="settings-note">{BLURB[tab]}</p> : null}
            {fields.map((field) => (
              <label key={field.key}>
                <span>{field.label}</span>
                <FieldControl
                  field={field}
                  onChange={(value) =>
                    setSettings((current) => current.map((item) => (item.key === field.key ? { ...item, value } : item)))
                  }
                />
              </label>
            ))}
          </section>
        ) : null}
        {mode === "keybinds" ? (
          <section>
            <p className="settings-note">These are Herdr’s bindings. The prefix works in this page and in a terminal here. Empty clears a binding.</p>
            {keys.map((field) => (
              <label key={field.key}>
                <span>{field.label}</span>
                <input
                  value={String(field.value ?? "")}
                  spellCheck={false}
                  onChange={(event) =>
                    setKeys((current) => current.map((item) => (item.key === field.key ? { ...item, value: event.target.value } : item)))
                  }
                />
              </label>
            ))}
          </section>
        ) : null}
        {error ? <p className="settings-error">{error}</p> : null}
        {mode === "keybinds" || tab !== "theme" ? (
          <footer>
            <button type="submit" disabled={busy}>
              {busy ? "Applying" : "apply"}
            </button>
          </footer>
        ) : (
          <footer>
            <span className="settings-note">{busy ? "Applying" : "Click a theme to apply it here and in Herdr."}</span>
          </footer>
        )}
      </form>
    </div>
  );
}

function FieldControl({
  field,
  onChange,
}: {
  field: HerdrField;
  onChange: (value: string | number | boolean) => void;
}) {
  if (field.kind === "bool") {
    return <input type="checkbox" checked={field.value === true} onChange={(event) => onChange(event.target.checked)} />;
  }
  if (field.kind === "enum") {
    return (
      <select value={String(field.value)} onChange={(event) => onChange(event.target.value)}>
        {field.options.map((option) => (
          <option key={option} value={option}>
            {CHOICE[option] || option}
          </option>
        ))}
      </select>
    );
  }
  if (field.kind === "int") {
    return (
      <input
        type="number"
        value={Number(field.value)}
        min={1}
        max={500}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    );
  }
  return <input value={String(field.value ?? "")} spellCheck={false} onChange={(event) => onChange(event.target.value)} />;
}
