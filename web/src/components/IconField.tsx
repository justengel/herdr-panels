import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { fitFlyout, type FlyoutBox } from "../menuPlace";
import { TAB_ICONS } from "../tabIcons";
import { TabMark } from "./TabMark";

const FLYOUT_SIZE = { width: 232, height: 248 };

/** Sit beside the context menu, so the list does not cover the name field. */
function flyoutAnchor(button: HTMLElement) {
  const menu = button.closest(".panel-menu");
  return (menu ?? button).getBoundingClientRect();
}

export function IconField({
  icon,
  onChange,
}: {
  icon?: string | null;
  onChange: (icon: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [box, setBox] = useState<FlyoutBox | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const current = icon?.trim() || "";
  const needle = query.trim().toLowerCase();
  const icons = useMemo(
    () =>
      Object.entries(TAB_ICONS).filter(([id, preset]) => {
        if (!needle) return true;
        return id.includes(needle) || preset.label.toLowerCase().includes(needle);
      }),
    [needle],
  );

  useLayoutEffect(() => {
    if (!open || !buttonRef.current || !flyoutRef.current) return;
    const anchor = flyoutAnchor(buttonRef.current);
    const size = flyoutRef.current.getBoundingClientRect();
    const next = fitFlyout(
      anchor,
      { width: size.width || FLYOUT_SIZE.width, height: size.height || FLYOUT_SIZE.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setBox((prev) =>
      prev && prev.left === next.left && prev.top === next.top && prev.maxHeight === next.maxHeight && prev.side === next.side
        ? prev
        : next,
    );
  }, [open, needle, icons.length]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (buttonRef.current?.contains(target) || flyoutRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  function toggle() {
    setOpen((value) => {
      const next = !value;
      if (next && buttonRef.current) {
        const anchor = flyoutAnchor(buttonRef.current);
        setBox(fitFlyout(anchor, FLYOUT_SIZE, { width: window.innerWidth, height: window.innerHeight }));
      }
      return next;
    });
  }

  function choose(next: string | null) {
    onChange(next);
    setOpen(false);
  }

  function chooseFile() {
    if (busy) return;
    setBusy(true);
    void api
      .pickFile()
      .then((path) => {
        if (path) choose(`file:${path}`);
      })
      .catch(() => undefined)
      .finally(() => setBusy(false));
  }

  const flyout = open
    ? createPortal(
        <div
          ref={flyoutRef}
          className="panel-menu-flyout icon-flyout"
          role="dialog"
          aria-label="Icons"
          style={
            box
              ? { left: box.left, top: box.top, maxHeight: box.maxHeight }
              : { left: -9999, top: 0 }
          }
        >
          <input
            aria-label="Search icons"
            placeholder="Search icons"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
          />
          <div className="icon-grid" role="listbox" aria-label="Icons">
            {icons.map(([id, item]) => (
              <button
                key={id}
                type="button"
                role="option"
                aria-selected={current === id}
                aria-label={item.label}
                title={item.label}
                className={current === id ? "on" : ""}
                onClick={() => choose(id)}
              >
                <TabMark icon={id} />
              </button>
            ))}
          </div>
          <button type="button" onClick={chooseFile} disabled={busy}>
            {busy ? "Choosing a file…" : "Choose a file…"}
          </button>
          {current ? (
            <button type="button" onClick={() => choose(null)}>
              Remove icon
            </button>
          ) : null}
        </div>,
        document.body,
      )
    : null;

  return (
    <div className="icon-field">
      <button
        ref={buttonRef}
        type="button"
        className="icon-box"
        aria-label={current ? "Change icon" : "Choose an icon"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
      >
        {current ? <TabMark icon={current} /> : <span className="icon-empty" aria-hidden="true" />}
      </button>
      {flyout}
    </div>
  );
}
