import { useEffect, useRef, type ReactNode } from "react";
import { useHost } from "../host";
import { selectedText } from "../textSelect";
import { writeTerminalClipboard } from "../terminalEdit";

/** Copy a highlight when the mouse goes up, the same way a Herdr pane does. */
export function CopyOnSelect({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const host = useHost();
  const notifyRef = useRef(host.notify);
  notifyRef.current = host.notify;

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let armed = false;
    let notice = 0;

    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      armed = event.target instanceof Node && root.contains(event.target);
    };

    const up = (event: PointerEvent) => {
      if (event.button !== 0 || !armed) return;
      armed = false;
      const live = document.getSelection();
      const text = selectedText(
        root,
        live
          ? {
              collapsed: live.isCollapsed,
              text: live.toString(),
              anchor: live.anchorNode,
              focus: live.focusNode,
            }
          : null,
      );
      if (!text) return;
      const windows = /Win/i.test(navigator.userAgent || "");
      void writeTerminalClipboard(text, windows).catch(() => undefined);
      window.clearTimeout(notice);
      notice = window.setTimeout(() => notifyRef.current("Copied to clipboard"), 400);
    };

    const cancel = () => {
      armed = false;
    };

    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel, true);
    return () => {
      window.clearTimeout(notice);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel, true);
    };
  }, []);

  return (
    <div ref={ref} className="copy-on-select">
      {children}
    </div>
  );
}
