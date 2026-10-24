import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { PanelConfig, TabEdge } from "../types";
import { useDesk } from "../desk";
import { usePanelActions, usePanelDrag } from "../panelActions";

interface Props {
  title: string;
  kind: string;
  panelType: PanelConfig["type"];
  pluginId?: string;
  badge?: string;
  badgeClass?: string;
  subtitle?: string;
  config?: ReactNode;
  contents?: ReactNode;
  actions?: ReactNode;
  className?: string;
  panelId?: string;
  plain?: boolean;
  tabbed?: boolean;
  tabEdge?: TabEdge;
  onClick?: (event: React.MouseEvent<HTMLElement>) => void;
  children: ReactNode;
}

const VIEWS: { type: PanelConfig["type"]; label: string }[] = [
  { type: "explorer", label: "Files" },
  { type: "herdr", label: "Terminal" },
  { type: "iframe", label: "Browser" },
  { type: "files", label: "Spaces" },
  { type: "agents", label: "Agents" },
];

const EDGES: { edge: TabEdge; label: string }[] = [
  { edge: "top", label: "Tabs on top" },
  { edge: "bottom", label: "Tabs on bottom" },
  { edge: "left", label: "Tabs on left" },
  { edge: "right", label: "Tabs on right" },
];

export function PanelChrome({
  title,
  kind,
  panelType,
  pluginId,
  badge,
  badgeClass,
  subtitle,
  config,
  contents,
  actions,
  className,
  panelId,
  plain = false,
  tabbed = false,
  tabEdge = "top",
  onClick,
  children,
}: Props) {
  const panelActions = usePanelActions();
  const drag = usePanelDrag();
  const desk = useDesk();
  const viewType = panelType === "html" ? "iframe" : panelType;
  const [menu, setMenu] = useState<{ left?: number; right?: number; top: number } | null>(null);
  const gearRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const dragging = Boolean(panelId && drag.draggingId === panelId);
  const classes = ["panel", className, plain ? "is-plain" : "", dragging ? "is-drag-source" : ""]
    .filter(Boolean)
    .join(" ");

  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      if (event.target instanceof Element && event.target.closest(".panel-gear")) return;
      setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  function run(action: () => void) {
    setMenu(null);
    action();
  }

  function openMenu(event: React.MouseEvent) {
    if (!panelId) return;
    event.preventDefault();
    event.stopPropagation();
    const left = Math.min(event.clientX, window.innerWidth - 220);
    const top = Math.min(event.clientY, window.innerHeight - 16);
    setMenu({ left, top });
  }

  function openGear(event: React.MouseEvent) {
    event.stopPropagation();
    if (!panelId) return;
    if (menu) {
      setMenu(null);
      return;
    }
    const rect = gearRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMenu({
      right: Math.max(8, window.innerWidth - rect.right),
      top: Math.min(rect.bottom + 4, window.innerHeight - 16),
    });
  }

  function beginDrag(event: React.PointerEvent<HTMLElement>) {
    if (!panelId || event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest("button, a, input, select, textarea, label") && !target.closest(".grip")) {
      return;
    }
    drag.start(panelId, event);
  }

  return (
    <section
      className={classes}
      data-panel-id={panelId}
      data-kind={kind}
      onClick={onClick}
    >
      {plain ? (
        <button
          ref={gearRef}
          type="button"
          className="panel-gear tab-gear-button plain-gear"
          aria-label="Panel settings"
          aria-expanded={menu !== null}
          title="Panel settings"
          onClick={openGear}
        >
          <GearIcon />
        </button>
      ) : (
      <header
        className="panel-header"
        onContextMenu={openMenu}
        onPointerDown={beginDrag}
      >
        <button
          type="button"
          className="grip"
          aria-label="Drag to rearrange"
          title="Drag the title bar onto a side to place this panel, or the middle to swap"
        />
        <div className="panel-title">
          <strong>{title}</strong>
          {subtitle ? <span className="subtitle">{subtitle}</span> : null}
        </div>
        {config}
        <div className="panel-actions">
          {badge ? <span className={`badge ${badgeClass ?? ""}`}>{badge}</span> : null}
          {actions}
          <button
            ref={gearRef}
            type="button"
            className="panel-gear tab-gear-button"
            aria-label="Panel settings"
            aria-expanded={menu !== null}
            title="Panel settings"
            onClick={openGear}
          >
            <GearIcon />
          </button>
          <button
            type="button"
            className="panel-close"
            aria-label={`Close ${title}`}
            title="Close panel"
            onClick={(event) => {
              event.stopPropagation();
              if (panelId) panelActions.close(panelId);
            }}
          >
            ×
          </button>
        </div>
      </header>
      )}
      <div className="panel-body">{children}</div>
      {menu && panelId
        ? createPortal(
            <>
            <div
              className="menu-dismiss"
              onPointerDown={() => setMenu(null)}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu(null);
              }}
            />
            <div
              className="panel-menu"
              role="menu"
              ref={menuRef}
              style={{
                left: menu.left,
                right: menu.right,
                top: menu.top,
                maxHeight: `calc(100vh - ${menu.top + 8}px)`,
              }}
              onChange={(event) => {
                if (event.target instanceof HTMLSelectElement) setMenu(null);
              }}
            >
              <NameField panelId={panelId} title={title} />
              {contents}
              <div className="menu-rule" />
              <button
                type="button"
                role="menuitem"
                title="Side by side"
                onClick={() => run(() => panelActions.add(panelId, "row"))}
              >
                Split horizontal
              </button>
              <button
                type="button"
                role="menuitem"
                title="One above the other"
                onClick={() => run(() => panelActions.add(panelId, "column"))}
              >
                Split vertical
              </button>
              <button type="button" role="menuitem" onClick={() => run(() => panelActions.addTab(panelId))}>
                Add tab
              </button>
              {tabbed ? (
                <>
                  <div className="menu-rule" />
                  {EDGES.map((item) => (
                    <button
                      key={item.edge}
                      type="button"
                      role="menuitemradio"
                      className="menu-radio"
                      aria-checked={tabEdge === item.edge}
                      onClick={() => run(() => panelActions.edge(panelId, item.edge))}
                    >
                      <span className="menu-check">{tabEdge === item.edge ? "✓" : ""}</span>
                      {item.label}
                    </button>
                  ))}
                </>
              ) : null}
              <div className="menu-rule" />
              {VIEWS.map((item) => (
                <button
                  key={item.type}
                  type="button"
                  role="menuitem"
                  aria-checked={viewType === item.type}
                  onClick={() => run(() => panelActions.use(panelId, item.type))}
                >
                  {item.label}
                </button>
              ))}
              {desk.plugins.length > 0 ? <div className="menu-rule" /> : null}
              {desk.plugins.map((plugin) => (
                <button
                  key={plugin.id}
                  type="button"
                  role="menuitem"
                  aria-checked={panelType === "plugin" && pluginId === plugin.id}
                  onClick={() => run(() => panelActions.use(panelId, "plugin", plugin.id))}
                >
                  {plugin.title || plugin.id}
                </button>
              ))}
              <div className="menu-rule" />
              <button type="button" role="menuitem" onClick={() => run(() => panelActions.close(panelId))}>
                Close
              </button>
            </div>
            </>,
            document.body,
          )
        : null}
    </section>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        fill="currentColor"
        d="M6.7 1.2h2.6l.35 1.55c.36.1.7.26 1.01.46l1.45-.62 1.3 2.25-1.1 1.1c.08.34.13.7.13 1.06s-.05.72-.13 1.06l1.1 1.1-1.3 2.25-1.45-.62c-.31.2-.65.36-1.01.46l-.35 1.55H6.7l-.35-1.55a4.4 4.4 0 0 1-1.01-.46l-1.45.62-1.3-2.25 1.1-1.1A4.6 4.6 0 0 1 3.56 8c0-.36.05-.72.13-1.06l-1.1-1.1 1.3-2.25 1.45.62c.31-.2.65-.36 1.01-.46L6.7 1.2zM8 6.15a1.85 1.85 0 1 0 0 3.7 1.85 1.85 0 0 0 0-3.7z"
      />
    </svg>
  );
}

function NameField({ panelId, title }: { panelId: string; title: string }) {
  const panelActions = usePanelActions();
  const [value, setValue] = useState(title);
  useEffect(() => setValue(title), [title]);
  const save = () => panelActions?.rename(panelId, value.trim());
  return (
    <label className="menu-name">
      Name
      <input
        aria-label="Panel name"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          save();
        }}
      />
    </label>
  );
}
