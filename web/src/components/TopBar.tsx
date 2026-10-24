import { useState } from "react";
import type { RuntimeSnapshot } from "../types";

interface Props {
  runtime: RuntimeSnapshot | null;
  notice: string | null;
  zoomed: boolean;
  sessions: string[];
  selecting: boolean;
  onSession: (name: string) => void;
  onCreateSession: (name: string) => void;
  onRenameSession: (name: string) => void;
  onCloseSession: () => void;
  onSelect: () => void;
  onExitZoom: () => void;
}

export function TopBar({
  runtime,
  notice,
  zoomed,
  sessions,
  selecting,
  onSession,
  onCreateSession,
  onRenameSession,
  onCloseSession,
  onSelect,
  onExitZoom,
}: Props) {
  const connected = runtime?.connected === true;
  const label = connected ? `Herdr ${runtime?.version ?? ""}`.trim() : "Herdr offline";
  const session = runtime?.session || "default";
  const choices = sessions.includes(session) ? sessions : [session, ...sessions];
  const [mode, setMode] = useState<"create" | "rename" | "close" | null>(null);
  const [draft, setDraft] = useState("");
  const renameLocked = mode === "rename" && session === "default";
  return (
    <header className="topbar">
      <div className="brand">
        <img className="mark" src="/icon.svg" alt="" />
        <span>Herdr Panels</span>
      </div>
      {mode ? (
        <form
          className="session-switch is-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (mode === "close") {
              if (session !== "default") onCloseSession();
              setMode(null);
              return;
            }
            const name = draft.trim();
            if (!name || renameLocked) return;
            if (mode === "create") onCreateSession(name);
            else onRenameSession(name);
            setMode(null);
          }}
        >
          <span>{mode === "create" ? "New session" : mode === "rename" ? "Rename" : "Close session"}</span>
          {mode === "close" ? (
            <span className="session-note">
              {session === "default"
                ? "The default session is the Herdr client already open on this machine."
                : "This stops the session. The page returns to default."}
            </span>
          ) : renameLocked ? (
            <span>The default session stays named default.</span>
          ) : (
            <input
              aria-label="Session name"
              value={draft}
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
            />
          )}
          {mode === "rename" && !renameLocked ? <span>This restarts the session.</span> : null}
          {mode === "close" && session !== "default" ? <button type="submit">Close</button> : null}
          {mode !== "close" && !renameLocked ? (
            <button type="submit">{mode === "create" ? "Create" : "Rename"}</button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setMode(null);
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <label className="session-switch">
          Session
          <select
            aria-label="Herdr session"
            value={session}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "__new__") {
                setDraft("");
                setMode("create");
                return;
              }
              if (value === "__rename__") {
                setDraft(session === "default" ? "" : session);
                setMode("rename");
                return;
              }
              if (value === "__close__") {
                setMode("close");
                return;
              }
              onSession(value);
            }}
          >
            {choices.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
            <option value="__new__">New session…</option>
            <option value="__rename__">Rename session…</option>
            <option value="__close__">Close session…</option>
          </select>
        </label>
      )}
      {notice ? <span className="notice">{notice}</span> : null}
      {zoomed ? (
        <button type="button" className="quiet" onClick={onExitZoom}>
          Exit zoom
        </button>
      ) : null}
      <div className="topbar-spacer" />
      <button
        type="button"
        className="quiet"
        aria-pressed={selecting}
        title="Click an element, or drag a box around several"
        onClick={onSelect}
      >
        Select
      </button>
      <span className={`status ${connected ? "live" : "down"}`} title={runtime?.error ?? runtime?.socket ?? ""}>
        <span className="dot" />
        {label}
      </span>
    </header>
  );
}
