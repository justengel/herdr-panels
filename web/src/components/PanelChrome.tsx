import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { PanelConfig, TabEdge, TabsPanel } from "../types";
import { chevronTurn, iconRail, railBasis, tabFace } from "../tabFace";
import { IconField } from "./IconField";
import { TabMark } from "./TabMark";
import { TabStrip } from "./TabStrip";
import type { MenuEntry } from "../viewMenu";
import { fitFlyout, fitMenu, useKeepMenuOnScreen, type FlyoutBox } from "../menuPlace";
import { useKeyedPanel } from "../deskKeyboard";
import { desktopHost } from "../desktopBrowser";
import { contentScaleStyle, PanelScaleProvider, usePanelZoom } from "../displayZoom";
import { usePanelActions, usePanelDrag } from "../panelActions";
import { api } from "../api";
import { useDesk } from "../desk";

interface Props {
  title: string;
  /** Saved name. Empty until someone names the panel. The title bar uses `title`. */
  name?: string;
  kind: string;
  panelType: PanelConfig["type"];
  /** Type the open menu is about. A tab menu uses that tab, not the active one. */
  menuType?: PanelConfig["type"];
  pluginId?: string;
  badge?: string;
  badgeClass?: string;
  subtitle?: string;
  /** Tooltip for the title, used to explain Panes and Terminal. */
  hint?: string;
  config?: ReactNode;
  contents?: ReactNode;
  actions?: ReactNode;
  className?: string;
  panelId?: string;
  plain?: boolean;
  tabEdge?: TabEdge;
  /** Absent or true draws the title. A side bar narrows when this is false. */
  barNames?: boolean;
  /** Absent or true draws the panel icon. */
  barIcons?: boolean;
  tabs?: TabsPanel;
  onTabs?: (next: TabsPanel) => void;
  onCloseTab?: (tabId: string) => void;
  onMenuTarget?: (tabId: string | null) => void;
  collapsed?: boolean;
  icon?: string | null;
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
  /** Space this panel was borrowed from. Shown beside the title. */
  fromSpace?: string;
  /** This header is a visit. The corner leaves the visit instead of closing the panel. */
  leaveVisit?: boolean;
  children: ReactNode;
}

const EDGES: { edge: TabEdge; label: string }[] = [
  { edge: "top", label: "Tabs on top" },
  { edge: "bottom", label: "Tabs on bottom" },
  { edge: "left", label: "Tabs on left" },
  { edge: "right", label: "Tabs on right" },
];

const BAR_PLACES: { edge: TabEdge; label: string }[] = [
  { edge: "top", label: "Bar on top" },
  { edge: "left", label: "Bar on left" },
  { edge: "bottom", label: "Bar on bottom" },
  { edge: "right", label: "Bar on right" },
];

export function BarFaceItems({
  names,
  icons,
  onNames,
  onIcons,
}: {
  names: boolean;
  icons: boolean;
  onNames: (shown: boolean) => void;
  onIcons: (shown: boolean) => void;
}) {
  return (
    <>
      <div className="menu-rule" />
      <button
        type="button"
        role="menuitemcheckbox"
        className="menu-radio"
        aria-checked={icons}
        onClick={() => onIcons(!icons)}
      >
        <span className="menu-check">{icons ? "✓" : ""}</span>
        Show icons
      </button>
      <button
        type="button"
        role="menuitemcheckbox"
        className="menu-radio"
        aria-checked={names}
        onClick={() => onNames(!names)}
      >
        <span className="menu-check">{names ? "✓" : ""}</span>
        Show names
      </button>
    </>
  );
}

export function BarPlaceItems({ edge, onEdge }: { edge: TabEdge; onEdge: (edge: TabEdge) => void }) {
  return (
    <>
      <div className="menu-rule" />
      <div className="menu-label">Bar</div>
      {BAR_PLACES.map((item) => (
        <button
          key={item.edge}
          type="button"
          role="menuitemradio"
          className="menu-radio"
          aria-checked={edge === item.edge}
          onClick={() => onEdge(item.edge)}
        >
          <span className="menu-check">{edge === item.edge ? "✓" : ""}</span>
          {item.label}
        </button>
      ))}
    </>
  );
}

type FlyoutKind = "layout" | "plugins" | "panes" | "views" | "options";

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
  name,
  kind,
  panelType,
  menuType,
  badge,
  badgeClass,
  subtitle,
  hint,
  config,
  contents,
  actions,
  className,
  panelId,
  plain = false,
  tabEdge = "top",
  barNames = true,
  barIcons = true,
  tabs,
  onTabs,
  onCloseTab,
  onMenuTarget,
  collapsed = false,
  icon,
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
  fromSpace,
  leaveVisit = false,
  children,
}: Props) {
  const panelActions = usePanelActions();
  const drag = usePanelDrag();
  const keyed = useKeyedPanel();
  const [menuTabId, setMenuTabId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ left?: number; right?: number; top: number } | null>(null);
  const [locked, setLocked] = useState(false);
  const desk = useDesk();
  useEffect(() => {
    if (!panelId) return;
    const space = desk.focusedWorkspaceId || "";
    let stopped = false;
    void api.panelLock(panelId, space).then(
      (row) => {
        if (!stopped) setLocked(row.locked);
      },
      () => undefined,
    );
    const onLock = (event: Event) => {
      const detail = (event as CustomEvent<{ panelId?: string; locked?: boolean }>).detail;
      if (detail?.panelId === panelId && typeof detail.locked === "boolean") setLocked(detail.locked);
    };
    window.addEventListener("herdr-panel-lock", onLock);
    return () => {
      stopped = true;
      window.removeEventListener("herdr-panel-lock", onLock);
    };
  }, [panelId, desk.focusedWorkspaceId]);
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
  const edge = tabs?.edge ?? tabEdge;
  const showNames = tabs ? tabs.showNames !== false : barNames;
  const showIcons = tabs ? tabs.showIcons !== false : barIcons;
  const sideBar = edge === "left" || edge === "right";
  const rail = tabs
    ? iconRail(edge, tabs.tabs, showNames, showIcons)
    : sideBar && !(showNames && Boolean(title.trim()));
  const digitRail = rail && (tabs
    ? railBasis(edge, tabs.tabs, showNames, showIcons) === 36
    : !(showIcons && Boolean(icon?.trim())));
  const menuTab = tabs?.tabs.find((tab) => tab.id === menuTabId) ?? null;
  const barMenu = Boolean(tabs && onTabs && !menuTab);
  const classes = [
    "panel",
    `edge-${edge}`,
    collapsed ? "is-collapsed" : "",
    className,
    plain ? "is-plain" : "",
    dragging ? "is-drag-source" : "",
    panelId && keyed.id === panelId ? "is-keyed" : "",
    leaveVisit ? "is-visit" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const viewEntries = entries.filter((entry) => entry.section === "view");
  const deskEntries = entries.filter((entry) => entry.section === "desk");
  const pluginEntries = entries.filter((entry) => entry.section === "plugins");
  const paneEntries = entries.filter((entry) => entry.section === "panes");
  const paneMenuLabel = deskEntries.find((entry) => entry.id === "terminals")?.label || "Terminals";
  const moreViewEntries = entries.filter((entry) => entry.section === "views");
  const subjectType = menuType ?? panelType;
  const showAddress = Boolean(onAddressBar) && subjectType !== "herdr" && subjectType !== "files" && subjectType !== "agents";

  function dismissMenu() {
    clearFlyoutTimers();
    setMenu(null);
    setMenuTabId(null);
    onMenuTarget?.(null);
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

  function toggleLock() {
    if (!panelId) return;
    const space = desk.focusedWorkspaceId || "";
    const next = !locked;
    void api.setPanelLock(panelId, space, next).then(
      (row) => {
        if (row.ok && typeof row.locked === "boolean") setLocked(row.locked);
      },
      () => undefined,
    );
  }

  function run(action: () => void) {
    choseRef.current = true;
    clearFlyoutTimers();
    setMenu(null);
    setFlyout(null);
    setFlyoutBox(null);
    flyoutAnchor.current = null;
    action();
  }

  function openMenu(event: React.MouseEvent, tabId?: string) {
    if (!panelId) return;
    event.preventDefault();
    event.stopPropagation();
    clearFlyoutTimers();
    setFlyout(null);
    setFlyoutBox(null);
    flyoutAnchor.current = null;
    setMenuTabId(tabId ?? null);
    onMenuTarget?.(tabId ?? null);
    setMenu({ left: event.clientX, top: event.clientY });
  }

  function openGear(event: React.MouseEvent) {
    event.stopPropagation();
    if (!panelId) return;
    if (menu) {
      dismissMenu();
      return;
    }
    setMenuTabId(null);
    onMenuTarget?.(null);
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
    if (target instanceof Element && target.closest("button, a, input, select, textarea, label, .tab") && !target.closest(".grip")) {
      return;
    }
    drag.start(panelId, event);
  }

  function closeFromBar(event: React.MouseEvent) {
    event.stopPropagation();
    if (!panelId) return;
    if (tabs && tabs.tabs.length > 1) {
      const active = tabs.tabs.some((tab) => tab.id === tabs.active) ? tabs.active : tabs.tabs[0]?.id;
      if (active) onCloseTab?.(active);
      return;
    }
    panelActions.close(panelId);
  }

  const activeTab = tabs?.tabs.find((tab) => tab.id === tabs.active) ?? tabs?.tabs[0];
  const closeName = activeTab ? tabFace(activeTab, showNames, showIcons).label || activeTab.id : title;
  const barTools = (
    <>
      <LockButton kind={panelType} locked={locked} onToggle={toggleLock} />
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
      <CollapseButton edge={edge} collapsed={collapsed} panelId={panelId} />
      <AddVisitButton panelId={panelId} leaveVisit={leaveVisit} />
      <FillButton panelId={panelId} title={title} />
      {tabs && tabs.tabs.length > 1 && !leaveVisit ? (
        <button
          type="button"
          className="panel-close"
          aria-label={`Close ${closeName}`}
          title="Close tab"
          onClick={closeFromBar}
        >
          <CloseIcon />
        </button>
      ) : (
        <EndButton panelId={panelId} title={title} canClose={canClose} leaveVisit={leaveVisit} />
      )}
    </>
  );

  const menuStyle = menuBox
    ? { left: menuBox.left, top: menuBox.top, maxWidth: menuBox.maxWidth, maxHeight: menuBox.maxHeight }
    : menu
      ? { left: menu.left, right: menu.right, top: menu.top }
      : undefined;

  return (
    <section
      className={classes}
      data-panel-id={panelId}
      data-type={panelType}
      data-kind={kind}
      data-edge={edge}
      data-collapsed={collapsed ? "true" : "false"}
      tabIndex={-1}
      onClick={(event) => {
        onClick?.(event);
        if (panelId) keyed.set(panelId);
      }}
    >
      {plain ? (
        <div className="plain-actions" data-panel-bar="">
          <button
            type="button"
            className="grip"
            aria-label="Drag to rearrange"
            title="Drag onto a side to place this panel, or the middle to swap"
            onPointerDown={beginDrag}
          />
          {barTools}
        </div>
      ) : (
        <header
          className={["panel-header", rail ? "is-rail" : "", digitRail ? "is-digits" : "", sideBar && !tabs ? "is-spine" : ""].filter(Boolean).join(" ")}
          data-panel-bar=""
          data-edge={edge}
          onContextMenu={(event) => openMenu(event)}
          onPointerDown={beginDrag}
        >
          <button
            type="button"
            className="grip"
            aria-label="Drag to rearrange"
            title="Drag the title bar onto a side to place this panel, or the middle to swap"
          />
          {tabs && onTabs && onCloseTab ? (
            <TabStrip
              group={tabs}
              onChange={onTabs}
              onActivate={(next) => {
                if (collapsed && panelId) panelActions.openTab(panelId, next);
                else onTabs(next);
              }}
              onClose={onCloseTab}
              onContextMenu={(tabId, event) => openMenu(event, tabId)}
              onDragAway={(tabId, event) => {
                if (panelId) drag.startTab(panelId, tabId, event);
              }}
            />
          ) : (
            <div className="panel-title">
              {showIcons && icon ? <TabMark icon={icon} /> : null}
              {showNames ? <strong title={hint}>{title}</strong> : null}
              {showNames && subtitle ? <span className="subtitle">{subtitle}</span> : null}
              {showNames && fromSpace ? <span className="subtitle">from {fromSpace}</span> : null}
            </div>
          )}
          {tabs ? null : config}
          <div className="panel-actions">
            {tabs ? null : badge ? <span className={`badge ${badgeClass ?? ""}`}>{badge}</span> : null}
            {tabs ? null : actions}
            {barTools}
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
                {barMenu ? null : (
                <div className="menu-identity">
                  <IconField
                    icon={menuTab ? menuTab.icon : icon}
                    onChange={(next) => {
                      if (menuTab && tabs && onTabs) {
                        onTabs({
                          ...tabs,
                          tabs: tabs.tabs.map((tab) => (tab.id === menuTab.id ? { ...tab, icon: next } : tab)),
                        });
                        return;
                      }
                      if (panelId) panelActions.icon(panelId, next);
                    }}
                  />
                  <NameField
                    panelId={panelId}
                    name={menuTab ? menuTab.title : (name ?? title)}
                    placeholder={
                      menuTab && !menuTab.title.trim()
                        ? menuTab.id
                        : name !== undefined && name !== title
                          ? title
                          : undefined
                    }
                    onRename={
                      menuTab && tabs && onTabs
                        ? (value) =>
                            onTabs({
                              ...tabs,
                              tabs: tabs.tabs.map((tab) => (tab.id === menuTab.id ? { ...tab, title: value } : tab)),
                            })
                        : undefined
                    }
                  />
                </div>
                )}
                {barMenu && tabs && onTabs ? (
                  <TabMenu
                    names={showNames}
                    icons={showIcons}
                    edge={edge}
                    onNames={(shown) => onTabs({ ...tabs, showNames: shown ? undefined : false })}
                    onIcons={(shown) => onTabs({ ...tabs, showIcons: shown ? undefined : false })}
                    onEdge={(next) => {
                      if (panelId) run(() => panelActions.edge(panelId, next));
                    }}
                    onAdd={() => {
                      if (panelId) run(() => panelActions.addTab(panelId));
                    }}
                    onClose={
                      canClose && !leaveVisit && panelActions.filledId !== panelId
                        ? () => run(() => panelActions.close(panelId))
                        : undefined
                    }
                  />
                ) : (
                  <>
                {contents}
                <div className="menu-rule" />
                <div className="menu-label">Panel</div>
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
                <button
                  type="button"
                  role="menuitem"
                  className="menu-flyout-trigger"
                  aria-haspopup="menu"
                  aria-expanded={flyout === "options"}
                  {...flyoutTrigger("options")}
                >
                  <span className="menu-check" />
                  <span className="menu-flyout-label">Options</span>
                  <span className="menu-chevron">›</span>
                </button>

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
                          title={entry.hint}
                          {...flyoutTrigger("panes")}
                        >
                          <span className="menu-check">{entry.checked ? "✓" : ""}</span>
                          <MenuText label={entry.label} />
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

                {(menuTab && onCloseTab && ((tabs?.tabs.length ?? 0) > 1 || canClose) || (!menuTab && canClose)) &&
                !leaveVisit &&
                panelActions.filledId !== panelId ? (
                  <>
                    <div className="menu-rule menu-rule-strong" />
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-radio"
                      onMouseEnter={scheduleCloseFlyout}
                      onClick={() =>
                        run(() => {
                          if (menuTab && onCloseTab) onCloseTab(menuTab.id);
                          else panelActions.close(panelId);
                        })
                      }
                    >
                      <span className="menu-check" />
                      Close
                    </button>
                  </>
                ) : null}
                  </>
                )}

                {flyout === "options" ? (
                  <div
                    ref={flyoutRef}
                    className="panel-menu-flyout"
                    role="menu"
                    aria-label="Options"
                    style={flyoutStyle(flyoutBox)}
                    onMouseEnter={cancelCloseFlyout}
                    onMouseLeave={scheduleCloseFlyout}
                  >
                    <div className="menu-label">Options</div>
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      className="menu-radio"
                      aria-checked={locked}
                      title={lockTip(panelType, locked)}
                      onClick={() => run(toggleLock)}
                    >
                      <span className="menu-check">{locked ? "✓" : ""}</span>
                      Lock
                    </button>
                    {allowPin && onPin ? (
                      <button
                        type="button"
                        role="menuitem"
                        className="menu-radio"
                        onClick={() => run(() => onPin())}
                      >
                        <span className="menu-check" />
                        {pinLabel}
                      </button>
                    ) : null}
                  </div>
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
                    <BarFaceItems
                      names={showNames}
                      icons={showIcons}
                      onNames={(shown) => run(() => panelActions.face(panelId, shown, showIcons))}
                      onIcons={(shown) => run(() => panelActions.face(panelId, showNames, shown))}
                    />
                    <BarPlaceItems edge={edge} onEdge={(next) => run(() => panelActions.edge(panelId, next))} />
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
                    aria-label={paneMenuLabel}
                    style={flyoutStyle(flyoutBox)}
                    onMouseEnter={cancelCloseFlyout}
                    onMouseLeave={scheduleCloseFlyout}
                  >
                    <div className="menu-label">{paneMenuLabel}</div>
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

function MenuText({ label }: { label: string }) {
  return (
    <span className="menu-copy">
      <span className="menu-name">{label}</span>
    </span>
  );
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
      title={entry.hint}
      onMouseEnter={onHover}
      onClick={() => run(() => onView?.(entry.id))}
    >
      <span className="menu-check">{entry.checked ? "✓" : ""}</span>
      <MenuText label={entry.label} />
    </button>
  );
}

const LOCK_TIP = "Lock this panel. Plugins and agents cannot read it or drive it. You still can.";
const UNLOCK_TIP = "Unlock this panel. Plugins and agents you already granted will be able to read it and drive it again.";
const LOCK_BROWSER_TIP =
  "Lock this panel. Herdr Panels will not read it, drive it, or open this site in any panel. You can still use this panel.";
const UNLOCK_BROWSER_TIP =
  "Unlock this panel. Plugins and agents you already granted can read it, drive it, and open this site again.";

function lockTip(kind: PanelConfig["type"], locked: boolean): string {
  if (kind === "iframe") return locked ? UNLOCK_BROWSER_TIP : LOCK_BROWSER_TIP;
  return locked ? UNLOCK_TIP : LOCK_TIP;
}

function LockButton({
  kind,
  locked,
  onToggle,
}: {
  kind: PanelConfig["type"];
  locked: boolean;
  onToggle: () => void;
}) {
  if (!locked) return null;
  return (
    <button
      type="button"
      className="panel-lock is-locked"
      aria-pressed="true"
      aria-label="Unlock"
      title={lockTip(kind, true)}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <LockedIcon />
    </button>
  );
}

function LockedIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <rect x="3.25" y="7.25" width="9.5" height="6.25" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.4 7.25V5.05a2.6 2.6 0 0 1 5.2 0V7.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
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

function CollapseButton({
  edge,
  collapsed,
  panelId,
}: {
  edge: TabEdge;
  collapsed: boolean;
  panelId?: string;
}) {
  const panelActions = usePanelActions();
  // A panel that already fills the screen has nothing to collapse toward.
  if (!panelId || panelActions.filledId === panelId) return null;
  return (
    <button
      type="button"
      className="panel-collapse"
      aria-pressed={collapsed}
      aria-label={collapsed ? "Expand panel" : "Collapse panel"}
      title={collapsed ? "Expand panel" : "Collapse panel"}
      onClick={(event) => {
        event.stopPropagation();
        panelActions.collapse(panelId);
      }}
    >
      <svg className="chev" viewBox="0 0 16 16" style={{ transform: chevronTurn(edge, collapsed) }} aria-hidden="true">
        <path d="M3.25 6.25 8 11 12.75 6.25" />
      </svg>
    </button>
  );
}

function AddVisitButton({ panelId, leaveVisit }: { panelId?: string; leaveVisit: boolean }) {
  const panelActions = usePanelActions();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const filled = Boolean(panelId && panelActions.filledId === panelId);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-visit-add], .panel-add")) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  if (!panelId || (!leaveVisit && !filled)) return null;
  const choices = panelActions.visitChoices ?? [];
  const showing = new Set(panelActions.visitPanelIds ?? (filled ? [panelId] : []));
  const atCap = showing.size >= 6;
  const groups = new Map<string, { space: string; items: typeof choices }>();
  for (const choice of choices) {
    const group = groups.get(choice.spaceId) ?? { space: choice.space, items: [] };
    group.items.push(choice);
    groups.set(choice.spaceId, group);
  }
  const addable = choices.filter((choice) => !showing.has(choice.panelId));
  const rect = open ? buttonRef.current?.getBoundingClientRect() : null;
  const menuBox = rect
    ? fitMenu(
        { left: rect.right - 240, top: rect.bottom + 4, width: 240, height: 320 },
        { width: window.innerWidth, height: window.innerHeight },
      )
    : null;
  const menu =
    open && menuBox
      ? createPortal(
          <div
            className="panel-menu visit-add-menu"
            data-visit-add=""
            role="menu"
            style={{ left: menuBox.left, top: menuBox.top, width: 240, maxHeight: menuBox.maxHeight }}
          >
            {[...groups.entries()].map(([spaceId, group]) => (
              <div key={spaceId}>
                <p className="menu-label">{group.space}</p>
                {group.items.map((choice) => {
                  const already = showing.has(choice.panelId);
                  return (
                    <button
                      key={`${choice.spaceId}:${choice.panelId}`}
                      type="button"
                      className="visit-add-choice"
                      disabled={already || atCap}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (already || atCap) return;
                        panelActions.joinVisit?.(choice.panelId);
                        setOpen(false);
                      }}
                    >
                      <span>{choice.title}</span>
                      {already ? <small className="visit-add-showing">Showing</small> : null}
                    </button>
                  );
                })}
              </div>
            ))}
            {atCap ? <p className="menu-note">A visit can show 6 panels.</p> : null}
            {addable.length === 0 && !atCap ? (
              <p className="menu-note">Open another panel on the desk, then add it here.</p>
            ) : null}
          </div>,
          document.body,
        )
      : null;
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="panel-add"
        aria-label="Add a panel to this visit"
        aria-expanded={open}
        title="Add a panel to this visit"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <PlusIcon />
      </button>
      {menu}
    </>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.5" d="M8 3.25v9.5M3.25 8h9.5" />
    </svg>
  );
}

function FillButton({ panelId, title }: { panelId?: string; title: string }) {
  const panelActions = usePanelActions();
  if (!panelId) return null;
  const filled = panelActions.filledId === panelId;
  const showing = panelActions.visitPanelIds ?? [];
  const showDesk = filled || (showing.length > 1 && showing.includes(panelId));
  return (
    <button
      type="button"
      className="panel-expand"
      aria-pressed={filled}
      aria-label={showDesk ? (filled ? "Show the whole desk" : "Show the desk") : `Fill the screen with ${title}`}
      title={showDesk ? (filled ? "Show the whole desk" : "Show the desk") : "Fill the screen"}
      onClick={(event) => {
        event.stopPropagation();
        panelActions.fill(panelId);
      }}
    >
      {showDesk ? <RestoreIcon /> : <ExpandIcon />}
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

function EndButton({
  panelId,
  title,
  canClose,
  leaveVisit,
}: {
  panelId?: string;
  title: string;
  canClose: boolean;
  leaveVisit: boolean;
}) {
  const panelActions = usePanelActions();
  if (panelId && panelActions.filledId === panelId && !leaveVisit) {
    return (
      <button
        type="button"
        className="panel-close"
        aria-label="Show the desk"
        title="Show the desk"
        onClick={(event) => {
          event.stopPropagation();
          panelActions.fill(panelId);
        }}
      >
        <LeaveIcon />
      </button>
    );
  }
  if (leaveVisit && panelId) {
    return (
      <button
        type="button"
        className="panel-close"
        aria-label={`No longer visit ${title}`}
        title="No longer visit this panel"
        onClick={(event) => {
          event.stopPropagation();
          panelActions.leave(panelId);
        }}
      >
        <LeaveIcon />
      </button>
    );
  }
  if (!canClose) return null;
  return (
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
  );
}

function LeaveIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="M3.25 12.25h9.5" />
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

function TabMenu({
  names,
  icons,
  edge,
  onNames,
  onIcons,
  onEdge,
  onAdd,
  onClose,
}: {
  names: boolean;
  icons: boolean;
  edge: TabEdge;
  onNames: (shown: boolean) => void;
  onIcons: (shown: boolean) => void;
  onEdge: (edge: TabEdge) => void;
  onAdd: () => void;
  onClose?: () => void;
}) {
  return (
    <>
      <button type="button" role="menuitem" className="menu-radio" onClick={onAdd}>
        <span className="menu-check" />
        Add tab
      </button>
      <div className="menu-rule" />
      <button
        type="button"
        role="menuitemcheckbox"
        className="menu-radio"
        aria-checked={icons}
        onClick={() => onIcons(!icons)}
      >
        <span className="menu-check">{icons ? "✓" : ""}</span>
        Show icons
      </button>
      <button
        type="button"
        role="menuitemcheckbox"
        className="menu-radio"
        aria-checked={names}
        onClick={() => onNames(!names)}
      >
        <span className="menu-check">{names ? "✓" : ""}</span>
        Show names
      </button>
      <div className="menu-rule" />
      <div className="menu-label">Bar</div>
      {EDGES.map((item) => (
        <button
          key={item.edge}
          type="button"
          role="menuitemradio"
          className="menu-radio"
          aria-checked={edge === item.edge}
          onClick={() => onEdge(item.edge)}
        >
          <span className="menu-check">{edge === item.edge ? "✓" : ""}</span>
          {item.label}
        </button>
      ))}
      {onClose ? (
        <>
          <div className="menu-rule menu-rule-strong" />
          <button type="button" role="menuitem" className="menu-radio" onClick={onClose}>
            <span className="menu-check" />
            Close
          </button>
        </>
      ) : null}
    </>
  );
}

function NameField({
  panelId,
  name,
  placeholder,
  onRename,
}: {
  panelId: string;
  name: string;
  placeholder?: string;
  onRename?: (title: string) => void;
}) {
  const panelActions = usePanelActions();
  const [value, setValue] = useState(name);
  useEffect(() => setValue(name), [name]);
  const save = () => {
    const next = value.trim();
    if (onRename) onRename(next);
    else panelActions?.rename(panelId, next);
  };
  return (
    <label className="menu-name">
      Name
      <input
        aria-label="Panel name"
        value={value}
        placeholder={placeholder || undefined}
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
