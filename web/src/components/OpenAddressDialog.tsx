import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { browseHint } from "./LocationBar";

interface Props {
  title?: string;
  onCancel: () => void;
  onOpen: (address: string) => void;
}

/** File picker plus a URL/path field — the View → Open catch-all. */
export function OpenAddressDialog({ title = "Open file or URL", onCancel, onOpen }: Props) {
  const [draft, setDraft] = useState("");
  const [picking, setPicking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const address = draft.trim();
    if (!address) return;
    onOpen(address);
  }

  function browse() {
    if (picking) return;
    setPicking(true);
    const hint = browseHint(draft);
    void api
      .pickFile(hint)
      .then(
        (path) => {
          if (!path) return;
          setDraft(path);
          inputRef.current?.focus();
        },
        () => {
          // Older servers: fall back to the HTML picker (basename-only in most browsers).
          const input = fileRef.current;
          if (!input) return;
          if (hint) input.setAttribute("nwworkingdir", hint);
          else input.removeAttribute("nwworkingdir");
          input.click();
        },
      )
      .finally(() => setPicking(false));
  }

  return createPortal(
    <div className="dialog-backdrop" role="presentation" onMouseDown={onCancel}>
      <form
        className="dialog open-address-dialog"
        role="dialog"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <h2>{title}</h2>
        <label>
          File or URL
          <input
            ref={inputRef}
            aria-label="File or URL"
            value={draft}
            placeholder="C:\\path\\file.md or https://…"
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <div className="dialog-actions">
          <button type="button" disabled={picking} onClick={browse}>
            {picking ? "Browsing…" : "Browse…"}
          </button>
          <input
            ref={fileRef}
            type="file"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              // Desktop shells expose an absolute path; browsers only give the basename.
              const path = (file as File & { path?: string }).path || file.name;
              setDraft(path);
              inputRef.current?.focus();
            }}
          />
          <span className="dialog-spacer" />
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" disabled={!draft.trim()}>
            Open
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
