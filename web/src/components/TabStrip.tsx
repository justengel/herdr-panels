import { useRef, useState } from "react";
import { blankTab, freshTabId } from "../layoutEdit";
import { movedSpaceOrder, sameSpaceOrder } from "../spaceDrag";
import { iconRail, showTabClose, tabFace, tabNumber } from "../tabFace";
import { useStripDrag } from "../useStripDrag";
import type { PanelTab, TabsPanel } from "../types";
import { TabMark } from "./TabMark";

export function TabStrip({
  group,
  onChange,
  onClose,
  onContextMenu,
  onDragAway,
}: {
  group: TabsPanel;
  onChange: (next: TabsPanel) => void;
  onClose: (tabId: string) => void;
  onContextMenu: (tabId: string, event: React.MouseEvent) => void;
  onDragAway: (tabId: string, event: PointerEvent) => void;
}) {
  const vertical = group.edge === "left" || group.edge === "right";
  const rail = iconRail(group.edge, group.tabs, group.showNames !== false, group.showIcons !== false);
  const close = showTabClose(group.edge, rail);
  const [editing, setEditing] = useState<string | null>(null);
  const skipRename = useRef(false);
  const active = group.tabs.find((tab) => tab.id === group.active) ?? group.tabs[0];
  const { listRef, drag, onPointerDown, swallowClick } = useStripDrag(
    vertical ? "y" : "x",
    (draggedId, beforeId) => {
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
    },
    onDragAway,
  );

  function rename(tabId: string, title: string) {
    if (skipRename.current) {
      skipRename.current = false;
      setEditing(null);
      return;
    }
    setEditing(null);
    const cleaned = title.trim().slice(0, 80);
    onChange({
      ...group,
      tabs: group.tabs.map((tab) => (tab.id === tabId ? { ...tab, title: cleaned } : tab)),
    });
  }

  return (
    <div
      ref={listRef}
      className={["tab-strip", "in-bar", vertical ? "vertical" : "", drag && drag.beforeId === null ? "drop-end" : ""]
        .filter(Boolean)
        .join(" ")}
      role="tablist"
      aria-orientation={vertical ? "vertical" : "horizontal"}
    >
      {group.tabs.map((tab) => (
        <TabFace
          key={tab.id}
          tab={tab}
          showNames={group.showNames !== false}
          showIcons={group.showIcons !== false}
          close={close}
          active={tab.id === active?.id}
          editing={editing === tab.id}
          dragging={drag?.id === tab.id}
          dropBefore={drag?.beforeId === tab.id}
          onPointerDown={onPointerDown}
          onOpen={() => {
            if (swallowClick(tab.id)) return;
            onChange({ ...group, active: tab.id });
          }}
          onRename={(title) => rename(tab.id, title)}
          onCancelRename={() => {
            skipRename.current = true;
            setEditing(null);
          }}
          onEdit={() => setEditing(tab.id)}
          onClose={() => onClose(tab.id)}
          onContextMenu={(event) => onContextMenu(tab.id, event)}
        />
      ))}
      <button
        type="button"
        className="tab-add"
        aria-label="New tab"
        onClick={() => {
          if (group.tabs.length >= 24) return;
          const tab = blankTab(freshTabId(group.tabs));
          onChange({ ...group, active: tab.id, tabs: [...group.tabs, tab] });
        }}
      >
        +
      </button>
    </div>
  );
}

function TabFace({
  tab,
  showNames,
  showIcons,
  close,
  active,
  editing,
  dragging,
  dropBefore,
  onPointerDown,
  onOpen,
  onRename,
  onCancelRename,
  onEdit,
  onClose,
  onContextMenu,
}: {
  tab: PanelTab;
  showNames: boolean;
  showIcons: boolean;
  close: boolean;
  active: boolean;
  editing: boolean;
  dragging: boolean;
  dropBefore: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onOpen: () => void;
  onRename: (title: string) => void;
  onCancelRename: () => void;
  onEdit: () => void;
  onClose: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const face = tabFace(tab, showNames, showIcons);
  const name = tab.title.trim() || tabNumber(tab.id);
  return (
    <div
      data-reorder-id={tab.id}
      className={["tab", active ? "on" : "", dragging ? "is-drag-source" : "", dropBefore ? "drop-before" : "", face.iconOnly ? "icon-only" : ""]
        .filter(Boolean)
        .join(" ")}
      role="tab"
      aria-label={name}
      title={name}
      aria-selected={active}
      tabIndex={0}
      onPointerDown={(event) => {
        event.stopPropagation();
        onPointerDown(event);
      }}
      onDoubleClick={onEdit}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onOpen();
      }}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(event);
      }}
    >
      {face.icon ? <TabMark icon={face.icon} /> : null}
      {editing ? (
        <input
          aria-label="Tab name"
          className="tab-rename"
          defaultValue={tab.title}
          autoFocus
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Enter") onRename(event.currentTarget.value);
            if (event.key === "Escape") onCancelRename();
          }}
          onBlur={(event) => onRename(event.currentTarget.value)}
        />
      ) : face.label ? (
        <span className="tab-label">{face.label}</span>
      ) : null}
      {close ? (
        <button
          type="button"
          className="tab-x"
          aria-label={`Close ${name}`}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
