import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  bindingConflict,
  chordsOverlap,
  directionChord,
  formatChord,
  joinBindings,
  recordChord,
  splitBindings,
  widenDigit,
  type DeskAction,
} from "../deskKeys";
import { chordMatches, expandBinding } from "../herdrKeys";

export function KeyCapture({
  action,
  value,
  fallback,
  prefixBinding,
  taken,
  onSave,
  onClose,
}: {
  action: DeskAction;
  value: string;
  fallback: string;
  prefixBinding: string;
  taken: { chords: string; does: string }[];
  onSave: (value: string) => void;
  onClose: () => void;
}) {
  const [chords, setChords] = useState(() => splitBindings(value));
  const [armed, setArmed] = useState(false);
  const [status, setStatus] = useState("Press a shortcut");
  const chordsRef = useRef(chords);
  const armedRef = useRef(false);
  const takenRef = useRef(taken);
  const onCloseRef = useRef(onClose);
  chordsRef.current = chords;
  takenRef.current = taken;
  onCloseRef.current = onClose;

  useEffect(() => {
    const prefixChord = expandBinding(prefixBinding)[0];
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (event.key === "Escape") {
        if (armedRef.current) {
          armedRef.current = false;
          setArmed(false);
          setStatus("Press a shortcut");
          return;
        }
        onCloseRef.current();
        return;
      }
      if (prefixChord && chordMatches(prefixChord, event, false)) {
        armedRef.current = !armedRef.current;
        setArmed(armedRef.current);
        setStatus(armedRef.current ? "Prefix…" : "Press a shortcut");
        return;
      }
      const recorded = recordChord(event, armedRef.current);
      if (!recorded) return;
      const stored = action.indexed && /[1-9]$/.test(recorded) ? widenDigit(recorded) : recorded;
      armedRef.current = false;
      setArmed(false);
      if ((action.id === "focus" || action.id === "move") && !directionChord(stored)) {
        setStatus("Press an arrow key");
        return;
      }
      const current = chordsRef.current;
      if (current.some((existing) => chordsOverlap(existing, stored))) {
        setStatus("Already in the list");
        return;
      }
      const conflict = bindingConflict(stored, takenRef.current);
      if (conflict) {
        setStatus(`${formatChord(stored)} is already used for ${conflict}`);
        return;
      }
      const next = [...current, stored];
      chordsRef.current = next;
      setChords(next);
      setStatus(`Added ${formatChord(stored)}`);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [action.id, action.indexed, prefixBinding]);

  const prefixLabel = formatChord(prefixBinding || "ctrl+b");
  return createPortal(
    <div className="dialog-backdrop key-capture-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="dialog key-capture-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="key-capture-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="key-capture-title">{action.does}</h2>
        <p className="settings-note">
          Press a shortcut to add it to the list. Press {prefixLabel}, then the next key, for a prefix chord.
          {action.indexed ? " A number key covers 1 through 9." : ""} {armed ? "Prefix…" : ""}
        </p>
        {chords.length > 0 ? (
          <ul className="key-chips">
            {chords.map((chord, index) => (
              <li key={`${chord}-${index}`}>
                <kbd>{formatChord(chord)}</kbd>
                <button
                  type="button"
                  aria-label={`Remove ${formatChord(chord)}`}
                  onClick={() => {
                    setChords((current) => current.filter((_, at) => at !== index));
                    armedRef.current = false;
                    setArmed(false);
                    setStatus("Press a shortcut");
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="settings-note">No shortcut yet.</p>
        )}
        <p className="key-capture-status" aria-live="polite">
          {status}
        </p>
        <div className="dialog-actions">
          <button type="button" onClick={() => setChords(splitBindings(fallback))}>
            Reset
          </button>
          <button
            type="button"
            onClick={() => {
              setChords([]);
              setStatus("Press a shortcut");
            }}
          >
            Clear
          </button>
          <span className="dialog-spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={() => onSave(joinBindings(chords))}>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
