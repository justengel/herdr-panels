import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import type { PinRecord } from "../pins";

export type PinDialogResult =
  | { action: "apply"; mode: "all" | "chosen"; spaces: string[] }
  | { action: "unpin-space" }
  | { action: "unpin-all" };

export interface PinDialogProps {
  open: boolean;
  panelTitle: string;
  current: PinRecord | null;
  spaces: Array<{ id: string; name: string }>;
  activeSpaceId: string | null;
  /** New pins default to the current space; Spaces/Agents start as all spaces. */
  preferAllSpaces?: boolean;
  onClose: () => void;
  onApply: (result: PinDialogResult) => void;
}

export function PinDialog({
  open,
  panelTitle,
  current,
  spaces,
  activeSpaceId,
  preferAllSpaces = false,
  onClose,
  onApply,
}: PinDialogProps) {
  const titleId = useId();
  const [allSpaces, setAllSpaces] = useState(() => initialAllSpaces(current, preferAllSpaces));
  const [chosen, setChosen] = useState<string[]>(() =>
    initialChosen(current, spaces, activeSpaceId, initialAllSpaces(current, preferAllSpaces)),
  );

  useEffect(() => {
    if (!open) return;
    const nextAll = initialAllSpaces(current, preferAllSpaces);
    setAllSpaces(nextAll);
    setChosen(initialChosen(current, spaces, activeSpaceId, nextAll));
  }, [open, current, activeSpaceId, spaces, preferAllSpaces]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const toggleAll = (checked: boolean) => {
    setAllSpaces(checked);
    if (checked) setChosen(spaces.map((space) => space.id));
  };

  const toggleSpace = (id: string) => {
    setAllSpaces(false);
    setChosen((prev) => {
      const next = prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id];
      if (spaces.length > 0 && spaces.every((space) => next.includes(space.id))) {
        setAllSpaces(true);
      }
      return next;
    });
  };

  const selected = allSpaces ? spaces.map((space) => space.id) : chosen;
  const canApply = allSpaces || selected.length > 0;

  return createPortal(
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="dialog pin-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id={titleId}>Pin “{panelTitle}”</h2>
        <div className="pin-dialog-body">
          <label className="pin-option">
            <input type="checkbox" checked={allSpaces} onChange={(event) => toggleAll(event.target.checked)} />
            <span>All spaces</span>
          </label>
          <ul className="pin-space-list">
            {spaces.map((space) => (
              <li key={space.id}>
                <label className="pin-option">
                  <input
                    type="checkbox"
                    checked={selected.includes(space.id)}
                    disabled={allSpaces}
                    onChange={() => toggleSpace(space.id)}
                  />
                  <span>{space.name || space.id}</span>
                </label>
              </li>
            ))}
          </ul>
          {current ? (
            <p className="pin-hint">
              Unpin removes this panel from the current space only. It stays pinned elsewhere unless you
              unpin everywhere.
            </p>
          ) : null}
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          {current ? (
            <>
              <button type="button" onClick={() => onApply({ action: "unpin-space" })}>
                Unpin here
              </button>
              <button type="button" onClick={() => onApply({ action: "unpin-all" })}>
                Unpin everywhere
              </button>
            </>
          ) : null}
          <span className="dialog-spacer" />
          <button
            type="button"
            disabled={!canApply}
            onClick={() =>
              onApply({
                action: "apply",
                mode: allSpaces ? "all" : "chosen",
                spaces: allSpaces ? [] : selected,
              })
            }
          >
            Apply
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function initialAllSpaces(current: PinRecord | null, preferAllSpaces: boolean): boolean {
  if (current) return current.mode === "all";
  return preferAllSpaces;
}

function initialChosen(
  current: PinRecord | null,
  spaces: Array<{ id: string }>,
  activeSpaceId: string | null,
  all: boolean,
): string[] {
  if (all) return spaces.map((space) => space.id);
  if (current?.mode === "chosen" && current.spaces.length) return [...current.spaces];
  return activeSpaceId ? [activeSpaceId] : [];
}
