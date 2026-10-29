import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { PaneView, TabView, WorkspaceView } from "../../types";
import { useDesk } from "../../desk";
import { useHost } from "../../host";
import { useKeepMenuOnScreen } from "../../menuPlace";
import { movedSpaceOrder } from "../../spaceDrag";
import { tabInsertIndex } from "../../tabOrder";
import { useStripDrag } from "../../useStripDrag";
import { HerdrTerminal } from "./HerdrTerminal";

export function SpaceMirror({
  panes,
  workspaces,
  onFocusPane,
}: {
  panes: PaneView[];
  workspaces: WorkspaceView[];
  onFocusPane: (paneId: string) => void;
}) {
  const desk = useDesk();
  const host = useHost();
  const [picked, setPicked] = useState<string | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const moving = useRef(false);
  const menuBox = useKeepMenuOnScreen(menuRef, menu !== null, menu ? `${menu.tabId}:${menu.x}:${menu.y}` : "");
  const skipRename = useRef(false);
  const workspaceId =
    desk.focusedWorkspaceId ||
    workspaces.find((item) => item.focused)?.workspaceId ||
    panes.find((item) => item.focused)?.workspaceId ||
    panes[0]?.workspaceId ||
    "";
  const spacePanes = panes.filter((pane) => pane.workspaceId === workspaceId);
  const listed = desk.tabs.filter((tab) => tab.workspaceId === workspaceId);
  const tabs: TabView[] = listed.length ? listed : uniqueTabs(spacePanes);
  useEffect(() => setPicked(null), [desk.focusedTabId]);
  useEffect(() => {
    if (!order) return;
    const ids = tabs.map((tab) => tab.tabId);
    const sameMembers = ids.length === order.length && ids.every((id) => order.includes(id));
    if (!sameMembers || ids.every((id, index) => id === order[index])) setOrder(null);
  }, [tabs, order]);
  const strip =
    order && order.length === tabs.length
      ? order.flatMap((id) => {
          const tab = tabs.find((item) => item.tabId === id);
          return tab ? [tab] : [];
        })
      : tabs;
  const shown = strip.length === tabs.length ? strip : tabs;
  const remembered = workspaces.find((item) => item.workspaceId === workspaceId)?.activeTabId;
  const activeId =
    (picked && shown.some((tab) => tab.tabId === picked) ? picked : null) ||
    (desk.focusedTabId && shown.some((tab) => tab.tabId === desk.focusedTabId) ? desk.focusedTabId : null) ||
    (remembered && shown.some((tab) => tab.tabId === remembered) ? remembered : null) ||
    shown.find((tab) => tab.focused)?.tabId ||
    spacePanes.find((pane) => pane.focused)?.tabId ||
    shown[0]?.tabId ||
    "";
  const visible = spacePanes.filter((pane) => pane.tabId === activeId);
  const { listRef, drag, onPointerDown, swallowClick } = useStripDrag("x", (draggedId, beforeId) => {
    if (moving.current) return;
    const ids = shown.map((tab) => tab.tabId);
    const index = tabInsertIndex(ids, draggedId, beforeId);
    if (index == null) return;
    moving.current = true;
    setOrder(movedSpaceOrder(ids, draggedId, beforeId));
    void host.moveTab(draggedId, index).then((ok) => {
      moving.current = false;
      if (!ok) setOrder(null);
    });
  });

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

  function commitRename(tabId: string, title: string) {
    if (skipRename.current) {
      skipRename.current = false;
      setEditing(null);
      return;
    }
    setEditing(null);
    const cleaned = title.trim().slice(0, 80);
    if (!cleaned) return;
    void host.renameTab(tabId, cleaned);
  }

  return (
    <div className="space-mirror">
      <div
        ref={listRef}
        className={drag && drag.beforeId === null ? "space-tabs drop-end" : "space-tabs"}
        role="tablist"
        aria-label="Herdr tabs"
      >
        {shown.map((tab) => (
          <div
            key={tab.tabId}
            data-reorder-id={tab.tabId}
            role="tab"
            aria-selected={tab.tabId === activeId}
            tabIndex={0}
            className={["space-tab", tab.tabId === activeId ? "on" : "", drag?.id === tab.tabId ? "is-drag-source" : "", drag?.beforeId === tab.tabId ? "drop-before" : ""]
              .filter(Boolean)
              .join(" ")}
            onClick={() => {
              if (swallowClick(tab.tabId)) return;
              setPicked(tab.tabId);
              desk.onFocusTab(tab.tabId);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              setPicked(tab.tabId);
              desk.onFocusTab(tab.tabId);
            }}
            onDoubleClick={() => setEditing(tab.tabId)}
            onPointerDown={onPointerDown}
            onMouseDown={(event) => {
              if (event.button === 1) event.preventDefault();
            }}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              event.stopPropagation();
              void host.closeTab(tab.tabId);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setPicked(tab.tabId);
              desk.onFocusTab(tab.tabId);
              setMenu({ tabId: tab.tabId, x: event.clientX, y: event.clientY });
            }}
          >
            {editing === tab.tabId ? (
              <input
                aria-label="Tab name"
                className="tab-rename"
                defaultValue={tab.label || ""}
                autoFocus
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitRename(tab.tabId, event.currentTarget.value);
                  if (event.key === "Escape") {
                    skipRename.current = true;
                    setEditing(null);
                  }
                }}
                onBlur={(event) => commitRename(tab.tabId, event.currentTarget.value)}
              />
            ) : (
              tab.label || tab.tabId
            )}
          </div>
        ))}
        <button
          type="button"
          className="space-tab-add"
          aria-label="New tab"
          title="New tab"
          onClick={() => void host.newTab(workspaceId || undefined)}
        >
          +
        </button>
      </div>
      {menu
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
                  void host.newTab(workspaceId || undefined);
                }}
              >
                New tab
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setEditing(menu.tabId);
                  setMenu(null);
                }}
              >
                Rename
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const tabId = menu.tabId;
                  setMenu(null);
                  void host.closeTab(tabId);
                }}
              >
                Close
              </button>
            </div>,
            document.body,
          )
        : null}
      <div className="space-panes">
        {visible.length === 0 ? <div className="empty">This space has no panes.</div> : null}
        {visible.map((pane) => (
          <div
            key={pane.paneId}
            className="space-pane"
            style={cellBox(pane, visible)}
            onPointerDown={() => onFocusPane(pane.paneId)}
          >
            <HerdrTerminal paneId={pane.paneId} />
          </div>
        ))}
      </div>
    </div>
  );
}

function uniqueTabs(panes: PaneView[]): TabView[] {
  const seen = new Set<string>();
  const tabs: TabView[] = [];
  for (const pane of panes) {
    if (!pane.tabId || seen.has(pane.tabId)) continue;
    seen.add(pane.tabId);
    tabs.push({
      tabId: pane.tabId,
      workspaceId: pane.workspaceId,
      label: String(tabs.length + 1),
      focused: pane.focused,
    });
  }
  return tabs;
}

function cellBox(pane: PaneView, panes: PaneView[]): CSSProperties {
  if (panes.length < 2) return { inset: 0 };
  const boxes = panes.map((item) => ({
    x: item.x ?? 0,
    y: item.y ?? 0,
    w: Math.max(1, item.cols ?? 1),
    h: Math.max(1, item.rows ?? 1),
  }));
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const spanX = Math.max(1, Math.max(...boxes.map((box) => box.x + box.w)) - minX);
  const spanY = Math.max(1, Math.max(...boxes.map((box) => box.y + box.h)) - minY);
  const box = boxes[panes.indexOf(pane)];
  return {
    left: `${((box.x - minX) / spanX) * 100}%`,
    top: `${((box.y - minY) / spanY) * 100}%`,
    width: `${(box.w / spanX) * 100}%`,
    height: `${(box.h / spanY) * 100}%`,
  };
}
