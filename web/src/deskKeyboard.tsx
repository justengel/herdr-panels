import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { listedAgents, orderAgents } from "./agentOrder";
import {
  deskHelpRows,
  focusInDirection,
  formatChord,
  matchDesk,
  panelForKind,
  panelRefs,
  readingOrder,
  stepIndex,
  type Box,
  type DeskCommand,
} from "./deskKeys";
import { desktopHost } from "./desktopBrowser";
import { useHost } from "./host";
import { listPanels } from "./layoutEdit";
import { usePanelActions } from "./panelActions";
import type { LayoutNode, RuntimeSnapshot } from "./types";

interface KeyedPanelValue {
  id: string | null;
  set: (id: string) => void;
}

const KeyedPanelContext = createContext<KeyedPanelValue>({ id: null, set: () => {} });

export function KeyedPanelProvider({
  id,
  set,
  children,
}: {
  id: string | null;
  set: (id: string) => void;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ id, set }), [id, set]);
  return <KeyedPanelContext.Provider value={value}>{children}</KeyedPanelContext.Provider>;
}

export function useKeyedPanel(): KeyedPanelValue {
  return useContext(KeyedPanelContext);
}

export function DeskKeyboard({
  layout,
  runtime,
  focusedId,
  zoomedId,
  help,
  onFocus,
  onZoom,
  onSpace,
  onAgent,
  onNotice,
  onToggleHelp,
  onHelp,
  onReopen,
}: {
  layout: LayoutNode;
  runtime: RuntimeSnapshot | null;
  focusedId: string | null;
  zoomedId: string | null;
  help: boolean;
  onFocus: (id: string) => void;
  onZoom: (id: string | null) => void;
  onSpace: (workspaceId: string, paneId?: string) => string | null;
  onAgent: (paneId: string) => string | null;
  onNotice: (message: string) => void;
  onToggleHelp: () => void;
  onHelp: (open: boolean) => void;
  onReopen: () => void;
}) {
  const host = useHost();
  const hostRef = useRef(host);
  hostRef.current = host;
  const focusRef = useRef(focusedId);
  focusRef.current = focusedId;
  const aimRef = useRef<(id: string) => void>(() => {});
  const panelActions = usePanelActions();
  const enterRef = useRef<string | null>(null);
  const runRef = useRef<(command: DeskCommand) => void>(() => {});
  const [focusTick, setFocusTick] = useState(0);
  const prefix = String(host.config?.keys.find((field) => field.key === "prefix")?.value || "ctrl+b");

  function aim(id: string) {
    if (zoomedId && zoomedId !== id) onZoom(null);
    enterRef.current = id;
    onFocus(id);
    setFocusTick((tick) => tick + 1);
  }
  aimRef.current = aim;

  function currentSpaceId(): string {
    return runtime?.focusedWorkspaceId || runtime?.workspaces.find((space) => space.focused)?.workspaceId || "";
  }

  function goSpace(workspaceId: string) {
    const landed = onSpace(workspaceId);
    const label = runtime?.workspaces.find((space) => space.workspaceId === workspaceId)?.label;
    if (label) onNotice(label);
    if (landed) aim(landed);
  }

  runRef.current = (command) => {
    const focusedId = focusRef.current;
    if (command.action === "help") {
      onToggleHelp();
      return;
    }
    onHelp(false);
    if (command.action === "focus" || command.action === "move") {
      const boxes = panelBoxes();
      if (!focusedId) {
        const first = readingOrder(boxes)[0];
        if (first && command.action === "focus") aim(first);
        return;
      }
      const next = focusInDirection(boxes, focusedId, command.direction);
      if (!next) return;
      if (command.action === "move") {
        panelActions.place(focusedId, next, "center");
        aim(focusedId);
        return;
      }
      aim(next);
      return;
    }
    if (command.action === "cycle-panel") {
      const order = readingOrder(panelBoxes());
      if (order.length === 0) return;
      const next = order[stepIndex(order.length, focusedId ? order.indexOf(focusedId) : -1, command.delta)];
      if (next) aim(next);
      return;
    }
    if (command.action === "undo" || command.action === "redo") {
      if (focusedId) stepAddress(focusedId, command.action === "undo" ? "Back" : "Forward");
      return;
    }
    if (command.action === "reopen") {
      onReopen();
      return;
    }
    if (command.action === "zoom") {
      const order = readingOrder(panelBoxes());
      const id = (focusedId && order.includes(focusedId) ? focusedId : null) ?? order[0] ?? focusedId;
      if (!id) return;
      aim(id);
      onZoom(zoomedId === id ? null : id);
      return;
    }
    if (command.action === "cycle-space") {
      const spaces = runtime?.workspaces ?? [];
      if (spaces.length === 0) {
        onNotice("No spaces");
        return;
      }
      const current = currentSpaceId();
      const next = spaces[stepIndex(spaces.length, spaces.findIndex((space) => space.workspaceId === current), command.delta)];
      if (!next || next.workspaceId === current) return;
      goSpace(next.workspaceId);
      return;
    }
    if (command.action === "space") {
      const spaces = runtime?.workspaces ?? [];
      const space = spaces[command.index - 1];
      if (!space) {
        onNotice(`No space ${command.index}`);
        return;
      }
      if (space.workspaceId === currentSpaceId()) return;
      goSpace(space.workspaceId);
      return;
    }
    if (command.action === "cycle-agent" || command.action === "agent") {
      const sort = host.config?.settings.find((field) => field.key === "agent_panel_sort")?.value === "priority" ? "priority" : "spaces";
      const rows = orderAgents(
        listedAgents(runtime?.agents ?? [], runtime?.panes ?? [], runtime?.workspaces ?? [], runtime?.tabs ?? []),
        sort,
        (runtime?.workspaces ?? []).map((space) => space.workspaceId),
      );
      if (rows.length === 0) {
        onNotice("No agents");
        return;
      }
      const row =
        command.action === "agent"
          ? rows[command.index - 1]
          : rows[stepIndex(rows.length, rows.findIndex((item) => item.paneId === runtime?.focusedPaneId), command.delta)];
      if (!row) {
        if (command.action === "agent") onNotice(`No agent ${command.index}`);
        return;
      }
      const landed = onAgent(row.paneId);
      onNotice(row.title);
      if (landed) aim(landed);
      return;
    }
    if (command.action === "address") {
      const id = focusedId ?? readingOrder(panelBoxes())[0];
      if (!id) return;
      onFocus(id);
      if (!focusPanelSurface(id, "address")) onNotice("This panel has no address bar");
      return;
    }
    if (command.action === "agents" || command.action === "spaces") {
      const kind = command.action === "agents" ? "agents" : "files";
      const id = panelForKind(panelRefs(listPanels(layout)), kind);
      if (!id) onNotice(kind === "agents" ? "No Agents panel is open" : "No Spaces panel is open");
      else aim(id);
      return;
    }
    if (command.action === "close") {
      if (focusedId) panelActions.close(focusedId);
      return;
    }
    if (command.action === "enter") {
      const id = focusedId ?? readingOrder(panelBoxes())[0];
      if (id) aim(id);
    }
  };

  useEffect(() => host.registerDesk((command) => runRef.current(command)), [host.registerDesk]);

  useEffect(() => {
    const page = window as Window & { __hwpFocusPanel?: (id: string) => void };
    page.__hwpFocusPanel = (id) => {
      if (!id) return;
      aimRef.current(id);
    };
    return () => {
      delete page.__hwpFocusPanel;
    };
  }, []);

  useEffect(() => {
    if (!focusedId || enterRef.current !== focusedId) return;
    enterRef.current = null;
    focusPanelSurface(focusedId, "content");
  }, [focusedId, focusTick]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (document.querySelector(".key-capture-backdrop")) return;
      if (help && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onHelp(false);
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input[aria-label='Address']") && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        target.blur();
        return;
      }
      if (!(target instanceof Element) || target.closest("input, textarea, select, .xterm")) return;
      const hit = matchDesk(hostRef.current.deskBindings, event, hostRef.current.prefixArmed(), true);
      if (hit?.action === "list" && moveListRow(target, hit.delta)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (hit?.action === "activate" && activateListRow(target)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [help, onHelp]);

  useEffect(() => {
    const select = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return;
      const id = target.closest("[data-panel-id]")?.getAttribute("data-panel-id");
      if (id) onFocus(id);
    };
    const publishFrame = () => {
      const focused = document.activeElement instanceof HTMLIFrameElement;
      void desktopHost()?.invoke("set_frame_focus", { focused });
    };
    const onPointerDown = (event: PointerEvent) => select(event.target);
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof HTMLIFrameElement) select(event.target);
      publishFrame();
    };
    // A click inside a plugin frame never reaches this page. While the window is blurred, follow
    // whichever frame becomes active. The desktop window also hit-tests clicks on browser panels.
    let seen: Element | null = null;
    const followFrame = () => {
      const active = document.activeElement;
      if (!(active instanceof HTMLIFrameElement) || active === seen) return;
      seen = active;
      select(active);
      publishFrame();
    };
    const page = window as Window & { __hwpFocusAt?: (x: number, y: number) => void };
    page.__hwpFocusAt = (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const hit = document.elementFromPoint(x, y);
      if (hit) select(hit);
    };
    let timer = 0;
    const onWindowBlur = () => {
      window.clearInterval(timer);
      timer = window.setInterval(followFrame, 80);
      followFrame();
    };
    const onWindowFocus = () => {
      window.clearInterval(timer);
      timer = 0;
      seen = null;
      publishFrame();
    };
    publishFrame();
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("focus", onWindowFocus);
    if (!document.hasFocus()) onWindowBlur();
    return () => {
      window.clearInterval(timer);
      delete page.__hwpFocusAt;
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("focusin", onFocusIn, true);
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("focus", onWindowFocus);
    };
  }, [onFocus]);

  if (!help) return null;
  return createPortal(
    <div className="dialog-backdrop key-help" role="presentation" onMouseDown={() => onHelp(false)}>
      <div
        className="dialog key-help-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="desk-keys-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="desk-keys-title">Keyboard</h2>
        <p className="settings-note">
          Prefix is {formatChord(prefix)}. Press it, then the key. Prefix+H, J, K, and L still move between Herdr panes.
          Prefix+1 to 9 still switches tabs. The prefix also works inside a plugin, an HTML panel, and a browser panel. Inside a terminal it still belongs to Herdr.
          Ctrl+wheel, Ctrl+Plus, and Ctrl+Minus scale the panels. The session bar stays the same size. Ctrl+0 returns to 100%.
        </p>
        <ul className="key-help-list">
          {deskHelpRows(host.deskBindings).map((row) => (
            <li key={row.id}>
              <kbd>{row.keys}</kbd>
              <span>{row.does}</span>
            </li>
          ))}
        </ul>
        <div className="dialog-actions">
          <span className="dialog-spacer" />
          <button type="button" onClick={() => onHelp(false)}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function stepAddress(panelId: string, direction: "Back" | "Forward") {
  const section = document.querySelector<HTMLElement>(`[data-panel-id="${CSS.escape(panelId)}"]`);
  section?.querySelector<HTMLButtonElement>(`button[aria-label="${direction}"]`)?.click();
}

function panelBoxes(): Box[] {
  return [...document.querySelectorAll<HTMLElement>("[data-panel-id]")]
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        id: element.getAttribute("data-panel-id") || "",
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      };
    })
    .filter((box) => box.id && box.right - box.left > 2 && box.bottom - box.top > 2);
}

function focusPanelSurface(panelId: string, mode: "content" | "address"): boolean {
  const section = document.querySelector<HTMLElement>(`[data-panel-id="${CSS.escape(panelId)}"]`);
  if (!section) return false;
  if (mode === "address") {
    const input = section.querySelector<HTMLElement>("input[aria-label='Address']");
    if (!input) return false;
    input.focus();
    return true;
  }
  const term = section.querySelector<HTMLElement>("textarea.xterm-helper-textarea");
  if (term) {
    term.focus();
    return true;
  }
  const row =
    section.querySelector<HTMLElement>(".space-row.is-current, .agent-row.is-current, .tree-row.is-selected") ??
    section.querySelector<HTMLElement>(".agent-row, .space-row, .tree-row");
  if (row) {
    row.focus();
    return true;
  }
  section.focus({ preventScroll: true });
  return true;
}

function activateListRow(target: Element): boolean {
  const row = target.closest(".agent-row, .space-row, .tree-row");
  if (!(row instanceof HTMLElement)) return false;
  const button = row instanceof HTMLButtonElement ? row : row.querySelector("button");
  (button ?? row).click();
  return true;
}

function moveListRow(target: Element, delta: number): boolean {
  const row = target.closest(".agent-row, .space-row, .tree-row");
  if (!(row instanceof HTMLElement)) return false;
  const scope = row.closest(".side-list") ?? row.closest("[data-panel-id]");
  if (!scope) return false;
  const rows = [...scope.querySelectorAll(".agent-row, .space-row, .tree-row")];
  const index = rows.indexOf(row);
  if (index < 0 || rows.length === 0) return false;
  const next = rows[(index + delta + rows.length) % rows.length];
  if (next instanceof HTMLElement) next.focus();
  return true;
}
