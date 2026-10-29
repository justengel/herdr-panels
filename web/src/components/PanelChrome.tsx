import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { PanelConfig, TabEdge } from "../types";
import type { MenuEntry } from "../viewMenu";
import { fitFlyout, useKeepMenuOnScreen, type FlyoutBox } from "../menuPlace";
import { useKeyedPanel } from "../deskKeyboard";
import { desktopHost } from "../desktopBrowser";
import { contentScaleStyle, PanelScaleProvider, usePanelZoom } from "../displayZoom";
import { usePanelActions, usePanelDrag } from "../panelActions";

interface Props {
  title: string;
  kind: string;
  panelType: PanelConfig["type"];
  pluginId?: string;
  badge?: string;
  badgeClass?: string;
  subtitle?: string;
  /** Viewer name shown beside the title when it is not already the title. */
  viewer?: string;
  config?: ReactNode;
  contents?: ReactNode;
  actions?: ReactNode;
  className?: string;
  panelId?: string;
  plain?: boolean;
  tabbed?: boolean;
  tabEdge?: TabEdge;
  addressBar?: boolean;
  onAddressBar?: (show: boolean) => void;
  entries?: MenuEntry[];
  onView?: (id: string) => void;
  canClose?: boolean;
  openMenuToken?: number;
  /** When the menu is dismissed without a choice, e.g. cancel a blank Add panel. */
  onMenuDismiss?: () => void;
  allowPin?: boolean;
  pinLabel?: string;
  onPin?: () => void;
  onClick?: (event: React.MouseEvent<HTMLElement>) => void;
  /** A borrowed panel. Back dismisses the visit and does not close the original. */
  onBack?: () => void;
  fromSpace?: string;
  borrowed?: boolean;
  children: ReactNode;
}

const EDGES: { edge: TabEdge; label: string }[] = [
  { edge: "top", label: "Tabs on top" },
  { edge: "bottom", label: "Tabs on bottom" },
  { edge: "left", label: "Tabs on left" },
  { edge: "right", label: "Tabs on right" },
];

type FlyoutKind = "layout" | "plugins" | "panes" | "views";

/** Delay before a nested flyout opens on hover (menus typically use ~200–400ms). */
const FLYOUT_OPEN_MS = 220;
/** Grace period to cross from the trigger into the flyout without closing. */
const FLYOUT_CLOSE_MS = 280;

function PanelBody({
  panelId,
  panelType,
  children,
}: {
  panelId?: string;
  panelType: PanelConfig["type"];
  children: ReactNode;
}) {
  const scale = usePanelZoom(panelId);
  // A plugin or HTML page is a sandboxed frame, so it zooms its own document.
  // A desktop browser is a separate webview. CSS zoom on this page reaches neither.
  const ownDocument =
    panelType === "plugin" ||
    panelType === "html" ||
    (desktopHost() !== null && panelType === "iframe");
  const style = ownDocument || panelType === "herdr" ? undefined : contentScaleStyle(scale);
  if (panelType === "tabs") {
    return (
      <PanelScaleProvider style={style}>
        <div className="panel-body">{children}</div>
      </PanelScaleProvider>
    );
  }
  return (
    <div className="panel-body">
      <div className="panel-scale" style={style}>
        {children}
      </div>
    </div>
  );
}

export function PanelChrome({
  title,
  kind,
  panelType,
  badge,
  badgeClass,
  subtitle,
  viewer,
  config,
  contents,
  actions,
  className,
  panelId,
  plain = false,
  tabbed = false,
  tabEdge = "top",
  addressBar = false,
  onAddressBar,
  entries = [],
  onView,
  canClose = true,
  openMenuToken,
  onMenuDismiss,
  allowPin = false,
  pinLabel = "Pin…",
  onPin,
  onClick,
  onBack,
  fromSpace,
  borrowed = false,
  children,
}: Props) {
  const panelActions = usePanelActions();
  const drag = usePanelDrag();
  const keyed = useKeyedPanel();
  const [menu, setMenu] = useState<{ left?: number; right?: number; top: number } | null>(null);
  const [flyout, setFlyout] = useState<FlyoutKind | null>(null);
  const [flyoutBox, setFlyoutBox] = useState<FlyoutBox | null>(null);
  const flyoutAnchor = useRef<DOMRect | null>(null);
  const flyoutKindRef = useRef<FlyoutKind | null>(null);
  const openFlyoutTimer = useRef<number | null>(null);
  const closeFlyoutTimer = useRef<number | null>(null);
  const choseRef = useRef(false);
  const onMenuDismissRef = useRef(onMenuDismiss);
  onMenuDismissRef.current = onMenuDismiss;
  const gearRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  flyoutKindRef.current = flyout;
  const menuBox = useKeepMenuOnScreen(
    menuRef,
    menu !== null,
    menu ? `${menu.left ?? ""}:${menu.right ?? ""}:${menu.top}` : "",
  );

  function clearFlyoutTimers() {
    if (openFlyoutTimer.current !== null) {
      window.clearTimeout(openFlyoutTimer.current);
      openFlyoutTimer.current = null;
    }
    if (closeFlyoutTimer.current !== null) {
      window.clearTimeout(closeFlyoutTimer.current);
      closeFlyoutTimer.current = null;
    }
  }

  function showFlyout(kind: FlyoutKind, anchor: HTMLElement) {
    clearFlyoutTimers();
    const rect = anchor.getBoundingClientRect();
    flyoutAnchor.current = rect;
    setFlyoutBox(
      fitFlyout(rect, { width: 180, height: 160 }, { width: window.innerWidth, height: window.innerHeight }),
    );
    setFlyout(kind);
  }

  function hideFlyout() {
    clearFlyoutTimers();
    setFlyout(null);
    setFlyoutBox(null);
    flyoutAnchor.current = null;
  }

  function scheduleOpenFlyout(kind: FlyoutKind, anchor: HTMLElement) {
    if (closeFlyoutTimer.current !== null) {
      window.clearTimeout(closeFlyoutTimer.current);
      closeFlyoutTimer.current = null;
    }
    if (flyoutKindRef.current === kind) {
      if (openFlyoutTimer.current !== null) {
        window.clearTimeout(openFlyoutTimer.current);
        openFlyoutTimer.current = null;
      }
      return;
    }
    if (openFlyoutTimer.current !== null) window.clearTimeout(openFlyoutTimer.current);
    const delay = flyoutKindRef.current ? 80 : FLYOUT_OPEN_MS;
    openFlyoutTimer.current = window.setTimeout(() => showFlyout(kind, anchor), delay);
  }

  function scheduleCloseFlyout() {
    if (openFlyoutTimer.current !== null) {
      window.clearTimeout(openFlyoutTimer.current);
      openFlyoutTimer.current = null;
    }
    if (closeFlyoutTimer.current !== null) window.clearTimeout(closeFlyoutTimer.current);
    closeFlyoutTimer.current = window.setTimeout(() => hideFlyout(), FLYOUT_CLOSE_MS);
  }

  function cancelCloseFlyout() {
    if (closeFlyoutTimer.current !== null) {
      window.clearTimeout(closeFlyoutTimer.current);
      closeFlyoutTimer.current = null;
    }
  }

  /** Click still toggles for keyboard / touch; hover opens after a short delay. */
  function openFlyout(kind: FlyoutKind, event: React.MouseEvent<HTMLElement>) {
    clearFlyoutTimers();
    if (flyoutKindRef.current === kind) {
      hideFlyout();
      return;
    }
    showFlyout(kind, event.currentTarget);
  }

  function flyoutTrigger(kind: FlyoutKind) {
    return {
      onMouseEnter: (event: React.MouseEvent<HTMLElement>) => scheduleOpenFlyout(kind, event.currentTarget),
      onMouseLeave: () => scheduleCloseFlyout(),
      onClick: (event: React.MouseEvent<HTMLElement>) => openFlyout(kind, event),
      onFocus: (event: React.FocusEvent<HTMLElement>) => scheduleOpenFlyout(kind, event.currentTarget),
    };
  }

  useLayoutEffect(() => {
    if (!flyout || !flyoutRef.current || !flyoutAnchor.current) return;
    const size = flyoutRef.current.getBoundingClientRect();
    const next = fitFlyout(
      flyoutAnchor.current,
      { width: size.width, height: size.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setFlyoutBox((prev) =>
      prev && prev.left === next.left && prev.top === next.top && prev.maxHeight === next.maxHeight && prev.side === next.side
        ? prev
        : next,
    );
  }, [flyout]);
  const dragging = Boolean(panelId && drag.draggingId === panelId);
  const classes = [
    "panel",
    className,
    plain ? "is-plain" : "",
    dragging ? "is-drag-source" : "",
    panelId && keyed.id === panelId ? "is-keyed" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const viewEntries = entries.filter((entry) => entry.section === "view");
  const deskEntries = entries.filter((entry) => entry.section === "desk");
  const pluginEntries = entries.filter((entry) => entry.section === "plugins");
  const paneEntries = entries.filter((entry) => entry.section === "panes");
  const moreViewEntries = entries.filter((entry) => entry.section === "views");
  const showAddress = Boolean(onAddressBar) && panelType !== "herdr" && panelType !== "files" && panelType !== "agents";

  function dismissMenu() {
    clearFlyoutTimers();
    setMenu(null);
    setFlyout(null);
    setFlyoutBox(null);
    flyoutAnchor.current = null;
    if (!choseRef.current) onMenuDismissRef.current?.();
    choseRef.current = false;
  }

  useEffect(() => () => clearFlyoutTimers(), []);

  useEffect(() => {
    if (openMenuToken === undefined || !panelId || !gearRef.current) return;
    const rect = gearRef.current.getBoundingClientRect();
    choseRef.current = false;
    clearFlyoutTimers();
    setFlyout(null);
    setFlyoutBox(null);
    flyoutAnchor.current = null;
    setMenu({
      right: Math.max(8, window.innerWidth - rect.right),
      top: rect.bottom + 4,
    });
  }, [openMenuToken, panelId]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      if (event.target instanceof Element && event.target.closest(".panel-gear")) return;
      if (event.target instanceof Element && event.target.closest(".panel-menu-flyout")) return;
      dismissMenu();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismissMenu();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  function run(action: () => void) {
    choseRef.current = true;
    clearFlyoutTimers();
    setMenu(null);
    setFlyout(null);
    setFlyoutBox(null);
    flyoutAnchor.current = null;
    action();
  }

  function openMenu(event: React.MouseEvent) {
    if (!panelId) return;
    event.preventDefault();
    event.stopPropagation();
    clearFlyoutTimers();
    setFlyout(null);
    setFlyoutBox(null);
    flyoutAnchor.current = null;
    setMenu({ left: event.clientX, top: event.clientY });
  }

  function openGear(event: React.MouseEvent) {
    event.stopPropagation();
    if (!panelId) return;
    if (menu) {
      dismissMenu();
      return;
    }
    choseRef.current = false;
    const rect = gearRef.current?.getBoundingClientRect();
    if (!rect) return;
    clearFlyoutTimers();
    setFlyout(null);
    setFlyoutBox(null);
    flyoutAnchor.current = null;
    setMenu({
      right: Math.max(8, window.innerWidth - rect.right),
      top: rect.bottom + 4,
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

  const menuStyle = menuBox
    ? { left: menuBox.left, top: menuBox.top, maxWidth: menuBox.maxWidth, maxHeight: menuBox.maxHeight }
    : menu
      ? { left: menu.left, right: menu.right, top: menu.top }
      : undefined;

  if (onBack || borrowed) {
    return (
      <section className={classes} data-panel-id={panelId} data-kind={kind} data-type={panelType} tabIndex={-1}>
        <header className="panel-header borrow-header">
          <div className="panel-title">
            <strong>{title}</strong>
            {fromSpace ? <span className="subtitle">from {fromSpace}</span> : null}
          </div>
          {onBack ? (
            <button
              type="button"
              className="borrow-back"
              onClick={(event) => {
                event.stopPropagation();
                onBack();
              }}
            >
              Back
            </button>
          ) : null}
        </header>
        <PanelBody panelId={panelId} panelType={panelType}>
          {children}
        </PanelBody>
      </section>
    );
  }

  return (
    <section
      className={classes}
      data-panel-id={panelId}
      data-type={panelType}
      data-kind={kind}
      tabIndex={-1}
      onClick={(event) => {
        onClick?.(event);
        if (panelId) keyed.set(panelId);
      }}
    >
      {plain ? (
        <div className="plain-actions">
          <button
            type="button"
            className="grip"
            aria-label="Drag to rearrange"
            title="Drag onto a side to place this panel, or the middle to swap"
            onPointerDown={beginDrag}
          />
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
          <FillButton panelId={panelId} title={title} />
          {canClose ? (
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
              <CloseIcon />
            </button>
          ) : null}
        </div>
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
            {viewer && viewer.trim().toLowerCase() !== title.trim().toLowerCase() ? (
              <span className="viewer-pill">{viewer}</span>
            ) : null}
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
            <FillButton panelId={panelId} title={title} />
            {canClose ? (
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
                <CloseIcon />
              </button>
            ) : null}
          </div>
        </header>
      )}
      <PanelBody panelId={panelId} panelType={panelType}>
        {children}
      </PanelBody>
      {menu && panelId
        ? createPortal(
            <>
              <div
                className="menu-dismiss"
                onPointerDown={() => dismissMenu()}
                onContextMenu={(event) => {
                  event.preventDefault();
                  dismissMenu();
                }}
              />
              <div
                className="panel-menu"
                role="menu"
                ref={menuRef}
                style={menuStyle}
              >
                <NameField panelId={panelId} title={title} />
                {contents}
                <div className="menu-rule" />
                <div className="menu-label">Panel</div>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-flyout-trigger"
                  aria-haspopup="menu"
                  aria-expanded={flyout === "layout"}
                  {...flyoutTrigger("layout")}
                >
                  <span className="menu-check" />
                  <span className="menu-flyout-label">Layout</span>
                  <span className="menu-chevron">›</span>
                </button>
                {showAddress ? (
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    className="menu-radio"
                    aria-checked={addressBar}
                    onMouseEnter={scheduleCloseFlyout}
                    onClick={() => run(() => onAddressBar?.(!addressBar))}
                  >
                    <span className="menu-check">{addressBar ? "✓" : ""}</span>
                    Address bar
                  </button>
                ) : null}
                {allowPin && onPin ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="menu-radio"
                    onMouseEnter={scheduleCloseFlyout}
                    onClick={() => run(() => onPin())}
                  >
                    <span className="menu-check" />
                    {pinLabel}
                  </button>
                ) : null}

                {viewEntries.length > 0 ? (
                  <>
                    <div className="menu-rule" />
                    <div className="menu-label">View</div>
                    {viewEntries.map((entry) =>
                      entry.submenu ? (
                        <button
                          key={entry.id}
                          type="button"
                          role="menuitem"
                          className="menu-flyout-trigger"
                          aria-haspopup="menu"
                          aria-expanded={flyout === "views"}
                          aria-checked={entry.checked}
                          {...flyoutTrigger("views")}
                        >
                          <span className="menu-check">{entry.checked ? "✓" : ""}</span>
                          <span className="menu-flyout-label">{entry.label}</span>
                          <span className="menu-chevron">›</span>
                        </button>
                      ) : (
                        <MenuRow
                          key={entry.id}
                          entry={entry}
                          onView={onView}
                          run={run}
                          onHover={scheduleCloseFlyout}
                        />
                      ),
                    )}
                  </>
                ) : null}

                {deskEntries.length > 0 ? (
                  <>
                    <div className="menu-rule" />
                    <div className="menu-label">Desk</div>
                    {deskEntries.map((entry) =>
                      entry.submenu ? (
                        <button
                          key={entry.id}
                          type="button"
                          role="menuitem"
                          className="menu-flyout-trigger"
                          aria-haspopup="menu"
                          aria-expanded={flyout === "panes"}
                          aria-checked={entry.checked}
                          {...flyoutTrigger("panes")}
                        >
                          <span className="menu-check">{entry.checked ? "✓" : ""}</span>
                          <span className="menu-flyout-label">{entry.label}</span>
                          <span className="menu-chevron">›</span>
                        </button>
                      ) : (
                        <MenuRow
                          key={entry.id}
                          entry={entry}
                          onView={onView}
                          run={run}
                          onHover={scheduleCloseFlyout}
                        />
                      ),
                    )}
                  </>
                ) : null}

                {pluginEntries.length > 0 ? (
                  <>
                    <div className="menu-rule" />
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-flyout-trigger"
                      aria-haspopup="menu"
                      aria-expanded={flyout === "plugins"}
                      {...flyoutTrigger("plugins")}
                    >
                      <span className="menu-check" />
                      <span className="menu-flyout-label">Plugins</span>
                      <span className="menu-chevron">›</span>
                    </button>
                  </>
                ) : null}

                {canClose ? (
                  <>
                    <div className="menu-rule menu-rule-strong" />
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-radio"
                      onMouseEnter={scheduleCloseFlyout}
                      onClick={() => run(() => panelActions.close(panelId))}
                    >
                      <span className="menu-check" />
                      Close
                    </button>
                  </>
                ) : null}

                {flyout === "layout" ? (
                  <div
                    ref={flyoutRef}
                    className="panel-menu-flyout"
                    role="menu"
                    aria-label="Layout"
                    style={flyoutStyle(flyoutBox)}
                    onMouseEnter={cancelCloseFlyout}
                    onMouseLeave={scheduleCloseFlyout}
                  >
                    <div className="menu-label">Layout</div>
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-radio"
                      title="Side by side"
                      onClick={() => run(() => panelActions.add(panelId, "row"))}
                    >
                      <span className="menu-check" />
                      Split horizontal
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-radio"
                      title="One above the other"
                      onClick={() => run(() => panelActions.add(panelId, "column"))}
                    >
                      <span className="menu-check" />
                      Split vertical
                    </button>
                    <button type="button" role="menuitem" className="menu-radio" onClick={() => run(() => panelActions.addTab(panelId))}>
                      <span className="menu-check" />
                      Add tab
                    </button>
                    {tabbed
                      ? EDGES.map((item) => (
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
                        ))
                      : null}
                  </div>
                ) : null}
                {flyout === "plugins" ? (
                  <div
                    ref={flyoutRef}
                    className="panel-menu-flyout"
                    role="menu"
                    aria-label="Plugins"
                    style={flyoutStyle(flyoutBox)}
                    onMouseEnter={cancelCloseFlyout}
                    onMouseLeave={scheduleCloseFlyout}
                  >
                    <div className="menu-label">Plugins</div>
                    {pluginEntries.map((entry) => (
                      <MenuRow key={entry.id} entry={entry} onView={onView} run={run} />
                    ))}
                  </div>
                ) : null}
                {flyout === "panes" ? (
                  <div
                    ref={flyoutRef}
                    className="panel-menu-flyout"
                    role="menu"
                    aria-label="Panes"
                    style={flyoutStyle(flyoutBox)}
                    onMouseEnter={cancelCloseFlyout}
                    onMouseLeave={scheduleCloseFlyout}
                  >
                    <div className="menu-label">Panes</div>
                    {paneEntries.map((entry) => (
                      <MenuRow key={entry.id} entry={entry} onView={onView} run={run} />
                    ))}
                  </div>
                ) : null}
                {flyout === "views" ? (
                  <div
                    ref={flyoutRef}
                    className="panel-menu-flyout"
                    role="menu"
                    aria-label="More views"
                    style={flyoutStyle(flyoutBox)}
                    onMouseEnter={cancelCloseFlyout}
                    onMouseLeave={scheduleCloseFlyout}
                  >
                    <div className="menu-label">More views</div>
                    {moreViewEntries.map((entry) => (
                      <MenuRow key={entry.id} entry={entry} onView={onView} run={run} />
                    ))}
                  </div>
                ) : null}
              </div>
            </>,
            document.body,
          )
        : null}
    </section>
  );
}

function flyoutStyle(box: FlyoutBox | null): CSSProperties | undefined {
  if (!box) return undefined;
  return {
    position: "fixed",
    left: box.left,
    top: box.top,
    maxHeight: box.maxHeight,
    overflow: "auto",
  };
}

function MenuRow({
  entry,
  onView,
  run,
  onHover,
}: {
  entry: MenuEntry;
  onView?: (id: string) => void;
  run: (action: () => void) => void;
  onHover?: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      className="menu-radio"
      aria-checked={entry.checked}
      onMouseEnter={onHover}
      onClick={() => run(() => onView?.(entry.id))}
    >
      <span className="menu-check">{entry.checked ? "✓" : ""}</span>
      {entry.label}
    </button>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M6.61 3.35 6.99.87 9.01.87 9.39 3.35 10.3 3.73 12.32 2.24 13.76 3.68 12.27 5.7 12.65 6.61 15.13 6.99 15.13 9.01 12.65 9.39 12.27 10.3 13.76 12.32 12.32 13.76 10.3 12.27 9.39 12.65 9.01 15.13 6.99 15.13 6.61 12.65 5.7 12.27 3.68 13.76 2.24 12.32 3.73 10.3 3.35 9.39.87 9.01.87 6.99 3.35 6.61 3.73 5.7 2.24 3.68 3.68 2.24 5.7 3.73ZM8 5.65a2.35 2.35 0 1 1 0 4.7 2.35 2.35 0 1 1 0-4.7Z"
      />
    </svg>
  );
}

function FillButton({ panelId, title }: { panelId?: string; title: string }) {
  const panelActions = usePanelActions();
  if (!panelId) return null;
  const filled = panelActions.filledId === panelId;
  return (
    <button
      type="button"
      className="panel-expand"
      aria-pressed={filled}
      aria-label={filled ? "Show the whole desk" : `Fill the screen with ${title}`}
      title={filled ? "Show the whole desk" : "Fill the screen"}
      onClick={(event) => {
        event.stopPropagation();
        panelActions.fill(panelId);
      }}
    >
      {filled ? <RestoreIcon /> : <ExpandIcon />}
    </button>
  );
}

function ExpandIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <rect x="2.75" y="2.75" width="10.5" height="10.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.5" d="M5.25 2.75h8v8h-8z" />
      <path fill="none" stroke="currentColor" strokeWidth="1.5" d="M2.75 5.25h8v8h-8z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        d="M2.15 2.15 13.85 13.85M13.85 2.15 2.15 13.85"
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
