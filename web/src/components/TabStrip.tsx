import { useLayoutEffect, useRef, useState } from "react";
import { useDesk } from "../desk";
import { blankTab, freshTabId } from "../layoutEdit";
import { isDefaultPanelTitle } from "../openTitle";
import { movedSpaceOrder, sameSpaceOrder } from "../spaceDrag";
import { iconRail, showTabClose, tabFace, tabName, tabNameRunsDown, tabNumber, tabPluginTitle } from "../tabFace";
import { reorderOnEdge, settleEdges, tabEdgeOf } from "../tabFrame";
import { stripEnds, type StripEnds } from "../tabOverflow";
import { useStripDrag } from "../useStripDrag";
import type { PanelTab, TabEdge, TabsPanel } from "../types";
import { TabMark } from "./TabMark";

export function TabStrip({
  group,
  edge,
  flatten = false,
  onChange,
  onActivate,
  onClose,
  onContextMenu,
  onDragAway,
}: {
  group: TabsPanel;
  /** When set, this strip shows and edits only the tabs on that edge. */
  edge?: TabEdge;
  /** Draw every tab on this one bar. Stored edges stay as they are. */
  flatten?: boolean;
  onChange: (next: TabsPanel) => void;
  /** A click or a new tab. The caller opens a collapsed panel onto that tab. */
  onActivate?: (next: TabsPanel) => void;
  onClose: (tabId: string) => void;
  onContextMenu: (tabId: string, event: React.MouseEvent) => void;
  onDragAway: (tabId: string, event: PointerEvent) => void;
}) {
  const plugins = useDesk().plugins;
  const stripEdge = edge ?? group.edge;
  const visible = flatten
    ? group.tabs
    : edge
      ? group.tabs.filter((tab) => tabEdgeOf(tab, group.edge) === stripEdge)
      : group.tabs;
  const vertical = stripEdge === "left" || stripEdge === "right";
  const rail = iconRail(stripEdge, visible, group.showNames !== false, group.showIcons !== false);
  const close = showTabClose(stripEdge, rail);
  const [editing, setEditing] = useState<string | null>(null);
  const [ends, setEnds] = useState<StripEnds>({ before: false, after: false });
  const skipRename = useRef(false);
  const active = group.tabs.find((tab) => tab.id === group.active) ?? group.tabs[0];
  const { listRef, drag, onPointerDown, swallowClick } = useStripDrag(
    vertical ? "y" : "x",
    (draggedId, beforeId) => {
      if (edge && !flatten) {
        const tabs = reorderOnEdge(group.tabs, group.edge, stripEdge, draggedId, beforeId);
        if (tabs === group.tabs) return;
        onChange({ ...group, tabs });
        return;
      }
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
  const laidOut = visible.map((tab) => `${tab.id}:${tab.title}`).join("|");

  useLayoutEffect(() => {
    const node = listRef.current;
    if (!node) return;
    const sync = () => {
      const next = vertical
        ? stripEnds(node.scrollTop, node.clientHeight, node.scrollHeight)
        : stripEnds(node.scrollLeft, node.clientWidth, node.scrollWidth);
      setEnds((prev) => (prev.before === next.before && prev.after === next.after ? prev : next));
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    for (const child of node.children) observer.observe(child);
    node.addEventListener("scroll", sync, { passive: true });
    return () => {
      observer.disconnect();
      node.removeEventListener("scroll", sync);
    };
  }, [listRef, vertical, laidOut, group.verticalNames, group.showNames]);

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
    <div className={["tab-strip-clip", vertical ? "vertical" : ""].filter(Boolean).join(" ")}>
    <div
      ref={listRef}
      className={["tab-strip", "in-bar", vertical ? "vertical" : "", drag && drag.beforeId === null ? "drop-end" : ""]
        .filter(Boolean)
        .join(" ")}
      role="tablist"
      aria-orientation={vertical ? "vertical" : "horizontal"}
    >
      {visible.map((tab) => (
        <TabFace
          key={tab.id}
          tab={tab}
          showNames={group.showNames !== false}
          showIcons={group.showIcons !== false}
          pluginTitle={tabPluginTitle(tab.panel, plugins)}
          close={close}
          down={tabNameRunsDown(tab, group.edge, stripEdge, group.verticalNames, group.showNames !== false)}
          active={tab.id === active?.id}
          editing={editing === tab.id}
          dragging={drag?.id === tab.id}
          dropBefore={drag?.beforeId === tab.id}
          onPointerDown={onPointerDown}
          onOpen={() => {
            if (swallowClick(tab.id)) return;
            const next = { ...group, active: tab.id };
            if (onActivate) onActivate(next);
            else onChange(next);
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
          const active = group.tabs.find((item) => item.id === group.active) ?? group.tabs[0];
          const dest = !flatten && edge ? edge : tabEdgeOf(active ?? tab, group.edge);
          if (dest !== group.edge) tab.edge = dest;
          const next = settleEdges({ ...group, active: tab.id, tabs: [...group.tabs, tab] });
          if (onActivate) onActivate(next);
          else onChange(next);
        }}
      >
        +
      </button>
    </div>
      {ends.before ? (
        <span className="tab-more before" aria-hidden="true">
          …
        </span>
      ) : null}
      {ends.after ? (
        <span className="tab-more after" aria-hidden="true">
          …
        </span>
      ) : null}
    </div>
  );
}

function TabFace({
  tab,
  showNames,
  showIcons,
  pluginTitle,
  close,
  down,
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
  pluginTitle: string;
  close: boolean;
  down: boolean;
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
  const face = tabFace(tab, showNames, showIcons, pluginTitle);
  const stored = isDefaultPanelTitle(tab.title) ? "" : tab.title.trim();
  const name = face.label || tabName(tab, pluginTitle) || tabNumber(tab.id);
  return (
    <div
      data-reorder-id={tab.id}
      className={["tab", active ? "on" : "", down ? "is-down" : "", dragging ? "is-drag-source" : "", dropBefore ? "drop-before" : "", face.iconOnly ? "icon-only" : ""]
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
          defaultValue={stored}
          placeholder={stored ? undefined : tabName(tab, pluginTitle) || undefined}
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
