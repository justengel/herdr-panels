import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PaneView, WorkspaceView } from "../../types";
import { useHost } from "../../host";
import { useKeepMenuOnScreen } from "../../menuPlace";
import { StatusMark } from "../StatusMark";

const RANK = ["working", "blocked", "idle", "done", "unknown"];

function spaceStatus(workspace: { workspaceId: string }, panes: PaneView[]): string {
  const mine = panes.filter((pane) => pane.workspaceId === workspace.workspaceId);
  for (const status of RANK) {
    if (mine.some((pane) => pane.agentStatus === status)) return status;
  }
  return "unknown";
}

export function FilesView({
  workspaces,
  panes,
  onOpen,
}: {
  workspaces: WorkspaceView[];
  panes: PaneView[];
  onOpen: (workspaceId: string) => void;
}) {
  const host = useHost();
  const symbols = host.config?.settings.find((field) => field.key === "status_indicators")?.value === "symbols";
  const rows = host.config?.spaceRows?.length
    ? host.config.spaceRows
    : [
        ["state_icon", "workspace"],
        ["branch", "git_status"],
      ];
  const tokens = new Set(rows.flat());
  const menuRef = useRef<HTMLDivElement>(null);
  const seenRename = useRef(0);
  const seenClose = useRef(0);
  const [menu, setMenu] = useState<SpaceMenu | null>(null);
  const menuBox = useKeepMenuOnScreen(
    menuRef,
    menu !== null,
    menu ? `${menu.kind}:${menu.left ?? ""}:${menu.right ?? ""}:${menu.top ?? ""}:${menu.bottom ?? ""}` : "",
  );
  const [mode, setMode] = useState<"rename" | "close" | null>(null);
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const spaces =
    workspaces.length > 0
      ? workspaces
      : panes
          .filter((pane, index, all) => all.findIndex((item) => item.workspaceId === pane.workspaceId) === index)
          .map((pane) => ({
            workspaceId: pane.workspaceId,
            label: pane.workspaceId,
            focused: pane.focused,
            branch: null,
            dirty: false,
          }));
  const current = spaces.find((space) => space.focused) ?? spaces[0];
  const subject = spaces.find((space) => space.workspaceId === subjectId) ?? current;
  useEffect(() => {
    if (!host.renameTick || host.renameTick === seenRename.current) return;
    seenRename.current = host.renameTick;
    setMenu(null);
    setSubjectId(current?.workspaceId ?? null);
    setMode("rename");
    setDraft(current?.label ?? "");
  }, [host.renameTick, current?.workspaceId, current?.label]);
  useEffect(() => {
    if (!host.closeTick || host.closeTick === seenClose.current) return;
    seenClose.current = host.closeTick;
    setMenu(null);
    setSubjectId(current?.workspaceId ?? null);
    setMode("close");
  }, [host.closeTick, current?.workspaceId]);
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      if (event.target instanceof Element && event.target.closest(".side-menu-button")) return;
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

  function openMenu(event: { clientX: number; clientY: number }, workspaceId: string | null, alignRight = false) {
    const width = 168;
    const height = alignRight ? 168 : 112;
    if (alignRight) {
      setMenu({
        kind: "host",
        right: Math.max(8, window.innerWidth - event.clientX),
        bottom: Math.max(8, window.innerHeight - event.clientY + 4),
        workspaceId,
      });
      return;
    }
    setMenu({
      kind: "space",
      left: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
      workspaceId,
    });
  }

  function begin(next: "rename" | "close") {
    const workspaceId = menu?.workspaceId ?? current?.workspaceId ?? null;
    const space = spaces.find((item) => item.workspaceId === workspaceId) ?? current;
    setMenu(null);
    setSubjectId(space?.workspaceId ?? null);
    setDraft(space?.label ?? "");
    setMode(next);
  }

  return (
    <div
      className="side-pane"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const row = event.target instanceof Element ? event.target.closest("[data-workspace-id]") : null;
        const workspaceId = row?.getAttribute("data-workspace-id") ?? current?.workspaceId ?? null;
        openMenu(event, workspaceId);
      }}
    >
      {spaces.length === 0 ? <div className="side-list" /> : (
        <ul className="side-list">
          {spaces.map((space) => (
            <li key={space.workspaceId}>
              <button
                type="button"
                data-workspace-id={space.workspaceId}
                className={space.focused ? "space-row is-current" : "space-row"}
                onClick={() => onOpen(space.workspaceId)}
              >
                {tokens.has("state_icon") ? (
                  <StatusMark status={spaceStatus(space, panes)} symbols={symbols} />
                ) : null}
                <span className="space-copy">
                  <span className="space-name">
                    {space.label}
                    {tokens.has("state_text") ? <span className="space-state"> {spaceStatus(space, panes)}</span> : null}
                  </span>
                  {tokens.has("branch") && space.branch ? (
                    <span className="space-branch">
                      {space.branch}
                      {tokens.has("git_status") && space.dirty ? " *" : ""}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {mode === "rename" && subject ? (
        <form
          className="side-form"
          onSubmit={(event) => {
            event.preventDefault();
            const label = draft.trim();
            if (!label) return;
            void host.renameSpace(subject.workspaceId, label);
            setMode(null);
          }}
        >
          <input
            aria-label="Space name"
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit">Rename</button>
          <button type="button" onClick={() => setMode(null)}>
            Cancel
          </button>
        </form>
      ) : null}
      {mode === "close" && subject ? (
        <div className="side-form">
          <span>Close {subject.label}?</span>
          <button
            type="button"
            onClick={() => {
              void host.closeSpace(subject.workspaceId);
              setMode(null);
            }}
          >
            Close
          </button>
          <button type="button" onClick={() => setMode(null)}>
            Cancel
          </button>
        </div>
      ) : null}
      <div className="side-actions">
        <button type="button" onClick={() => void host.createSpace()}>
          new
        </button>
        <button
          type="button"
          className="side-menu-button"
          aria-expanded={menu !== null}
          onClick={(event) => {
            event.stopPropagation();
            if (menu) {
              setMenu(null);
              return;
            }
            const rect = event.currentTarget.getBoundingClientRect();
            openMenu({ clientX: rect.right, clientY: rect.top }, current?.workspaceId ?? null, true);
          }}
        >
          menu
        </button>
      </div>
      {menu
        ? createPortal(
            <div
              className="panel-menu space-menu"
              role="menu"
              ref={menuRef}
              style={
                menuBox
                  ? { left: menuBox.left, top: menuBox.top, maxWidth: menuBox.maxWidth, maxHeight: menuBox.maxHeight }
                  : { left: menu.left, right: menu.right, top: menu.top, bottom: menu.bottom }
              }
            >
              {menu.kind === "host" ? (
                <>
                  <button type="button" role="menuitem" onClick={() => { setMenu(null); host.openSettings(); }}>
                    settings
                  </button>
                  <button type="button" role="menuitem" onClick={() => { setMenu(null); host.openKeybinds(); }}>
                    keybinds
                  </button>
                  <button type="button" role="menuitem" onClick={() => { setMenu(null); void host.reloadConfig(); }}>
                    reload config
                  </button>
                  <button type="button" role="menuitem" onClick={() => { setMenu(null); host.updateReady(); }}>
                    <span className="menu-dot" aria-hidden="true" />
                    update ready
                  </button>
                  <button type="button" role="menuitem" onClick={() => { setMenu(null); host.detachView(); }}>
                    detach
                  </button>
                </>
              ) : (
                <>
                  <button type="button" role="menuitem" disabled={!menu.workspaceId} onClick={() => begin("rename")}>
                    Rename
                  </button>
                  <button type="button" role="menuitem" disabled={!menu.workspaceId} onClick={() => begin("close")}>
                    Close
                  </button>
                </>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

interface SpaceMenu {
  kind: "host" | "space";
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
  workspaceId: string | null;
}
