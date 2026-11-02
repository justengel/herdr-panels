import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

export function UnlockDialog({
  panelTitle,
  onCancel,
  onUnlock,
}: {
  panelTitle: string;
  onCancel: () => void;
  onUnlock: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  return createPortal(
    <div className="dialog-backdrop unlock-backdrop" role="presentation" onMouseDown={onCancel}>
      <div
        className="dialog unlock-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id={titleId}>Unlock {panelTitle}?</h2>
        <p id={bodyId}>
          Plugins and agents you already granted will be able to read this panel and drive it again.
        </p>
        <div className="dialog-actions">
          <button ref={cancelRef} type="button" onClick={onCancel}>
            Cancel
          </button>
          <span className="dialog-spacer" />
          <button type="button" className="unlock" onClick={onUnlock}>
            Unlock
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
