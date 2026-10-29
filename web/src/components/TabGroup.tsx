import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { blankTab, freshTabId } from "../layoutEdit";
import { useKeepMenuOnScreen } from "../menuPlace";
import { baseName } from "../paths";
import { movedSpaceOrder, sameSpaceOrder } from "../spaceDrag";
import { useStripDrag } from "../useStripDrag";
import type { PanelConfig, PanelTab, TabsPanel } from "../types";

export function TabGroup({
  group,
  onChange,
  onClose,
  renderContent,
}: {
  group: TabsPanel;
  onChange: (next: TabsPanel) => void;
  onClose: (tabId: string) => void;
  renderContent: (tab: PanelTab, onPanel: (panel: PanelConfig) => void) => ReactNode;
}) {
  const active = group.tabs.find((tab) => tab.id === group.active) ?? group.tabs[0];
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuBox = useKeepMenuOnScreen(menuRef, menu !== null, menu ? `${menu.tabId}:${menu.x}:${menu.y}` : "");
  const skipRename = useRef(false);
  const vertical = group.edge === "left" || group.edge === "right";

  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
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

  function updateTab(tabId: string, patch: Partial<PanelTab>) {
    onChange({
      ...group,
      tabs: group.tabs.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab)),
    });
  }

  function closeTab(tabId: string) {
    onClose(tabId);
  }

  function addTab() {
    const tab = blankTab(freshTabId(group.tabs));
    onChange({ ...group, active: tab.id, tabs: [...group.tabs, tab] });
  }

  function rename(tabId: string, title: string) {
    if (skipRename.current) {
      skipRename.current = false;
      setEditing(null);
      return;
    }
    const cleaned = title.trim().slice(0, 80);
    setEditing(null);
    if (!cleaned) return;
    updateTab(tabId, { title: cleaned });
  }

  const menuTab = group.tabs.find((tab) => tab.id === menu?.tabId);
  const { listRef, drag, onPointerDown, swallowClick } = useStripDrag(vertical ? "y" : "x", (draggedId, beforeId) => {
    const ids = group.tabs.map((tab) => tab.id);
    if (sameSpaceOrder(ids, draggedId, beforeId)) return;
    const nextIds = movedSpaceOrder(ids, draggedId, beforeId);
    const byId = new Map(group.tabs.map((tab) => [tab.id, tab]));
    const tabs = nextIds.flatMap((id) => {
      const tab = byId.get(id);
      return tab ? [tab] : [];
    });
    if (tabs.length !== group.tabs.length) return;
    onChange({ ...group, tabs });
  });

  return (
    <div className={`tab-group ${group.edge}`}>
      <div
        ref={listRef}
        className={[vertical ? "tab-strip vertical" : "tab-strip", drag && drag.beforeId === null ? "drop-end" : ""]
          .filter(Boolean)
          .join(" ")}
        role="tablist"
        aria-orientation={vertical ? "vertical" : "horizontal"}
      >
        {group.tabs.map((tab) => (
          <div
            key={tab.id}
            data-reorder-id={tab.id}
            className={["tab", tab.id === active?.id ? "on" : "", drag?.id === tab.id ? "is-drag-source" : "", drag?.beforeId === tab.id ? "drop-before" : ""]
              .filter(Boolean)
              .join(" ")}
            role="tab"
            aria-selected={tab.id === active?.id}
            tabIndex={0}
            onPointerDown={onPointerDown}
            onDoubleClick={() => setEditing(tab.id)}
            onClick={() => {
              if (swallowClick(tab.id)) return;
              onChange({ ...group, active: tab.id });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") onChange({ ...group, active: tab.id });
            }}
            onMouseDown={(event) => {
              if (event.button === 1) event.preventDefault();
            }}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              event.stopPropagation();
              closeTab(tab.id);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setMenu({
                tabId: tab.id,
                x: Math.min(event.clientX, window.innerWidth - 200),
                y: Math.min(event.clientY, window.innerHeight - 160),
              });
            }}
          >
            {tab.icon ? <span className="tab-icon">{tab.icon}</span> : null}
            {editing === tab.id ? (
              <input
                aria-label="Tab name"
                className="tab-rename"
                defaultValue={tab.title}
                autoFocus
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") rename(tab.id, event.currentTarget.value);
                  if (event.key === "Escape") {
                    skipRename.current = true;
                    setEditing(null);
                  }
                }}
                onBlur={(event) => rename(tab.id, event.currentTarget.value)}
              />
            ) : (
              <span className="tab-label">{tab.title}</span>
            )}
            <button
              type="button"
              className="tab-x"
              aria-label={`Close ${tab.title}`}
              onClick={(event) => {
                event.stopPropagation();
                closeTab(tab.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button type="button" className="tab-add" aria-label="New tab" onClick={addTab}>
          +
        </button>
      </div>
      <div className="tab-body">
        {active
          ? renderContent(active, (panel) => {
              const title = active.title === "New tab" ? titleFor(panel) ?? active.title : active.title;
              updateTab(active.id, { panel, title });
            })
          : null}
      </div>
      {menu && menuTab
        ? createPortal(
            <div
              ref={menuRef}
              className="panel-menu tab-menu"
              role="menu"
              style={
                menuBox
                  ? { left: menuBox.left, top: menuBox.top, maxWidth: menuBox.maxWidth, maxHeight: menuBox.maxHeight }
                  : { left: menu.x, top: menu.y }
              }
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  addTab();
                }}
              >
                New tab
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setEditing(menuTab.id);
                  setMenu(null);
                }}
              >
                Rename
              </button>
              <label className="menu-contents">
                Icon
                <input
                  aria-label="Tab icon"
                  value={menuTab.icon ?? ""}
                  maxLength={8}
                  placeholder="★"
                  onChange={(event) => updateTab(menuTab.id, { icon: event.target.value || null })}
                />
              </label>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  closeTab(menuTab.id);
                  setMenu(null);
                }}
              >
                Close
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function titleFor(panel: PanelConfig): string | null {
  if (panel.type === "herdr") return "Terminal";
  if (panel.type === "files") return "Spaces";
  if (panel.type === "agents") return "Agents";
  if (panel.type === "iframe" || panel.type === "html") {
    if (panel.type === "iframe") {
      if (!panel.url) return "Browser";
      try {
        return new URL(panel.url).hostname || panel.url;
      } catch {
        return panel.url;
      }
    }
    return "Browser";
  }
  if (panel.type === "plugin") return panel.plugin;
  const path = panel.type === "markdown" || panel.type === "file" || panel.type === "explorer" ? panel.path : "";
  if (!path) return panel.type === "explorer" ? "Files" : null;
  return baseName(path) || null;
}
