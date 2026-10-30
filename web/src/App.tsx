import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  rememberSession,
  tabSession,
  wsUrl,
  type DeskFile,
  type HerdrCtlStatus,
  type ViewerHealth,
} from "./api";
import type { HerdrStatusAction } from "./herdrStatus";
import { DesignProvider } from "./design";
import { highlight, inspectPanel } from "./inspect";
import {
  addPanelTab,
  assignContent,
  closePanelTab,
  type ClosedPanel,
  defaultPanel,
  describeClose,
  findPanel,
  freshPanelId,
  listPanels,
  mapPanel,
  movePanel,
  reopenPanel,
  normalizeLayout,
  setGridTracks,
  setPanel,
  setSplitRatio,
  setTabEdge,
  splitPanel,
} from "./layoutEdit";
import { DeskProvider, type PluginInfo } from "./desk";
import { pluginListChanged } from "./pluginList";
import { PanelActionsProvider } from "./panelActions";
import type { Attachment, LayoutDocument, LayoutNode, PanelConfig, RuntimeSnapshot } from "./types";
import { LayoutView } from "./components/LayoutView";
import { TopBar } from "./components/TopBar";
import { DesignBar } from "./components/DesignBar";
import { ElementSelect } from "./components/ElementSelect";
import { DeskKeyboard, KeyedPanelProvider } from "./deskKeyboard";
import { openVisit, reuseVisit, type OpenedVisit, type VisitWeights } from "./borrowPanel";
import { layoutForFocusedPane, layoutForPaneFocus, panelForPane, panelRefs } from "./deskKeys";
import { installDisplayZoom } from "./displayZoom";
import { pushClosedPanel, takeClosedPanel } from "./panelHistory";
import { HostProvider } from "./host";
import { readAddressBarChoices } from "./addressBar";
import { readRawChoices } from "./rawText";
import { readPluginSubjects } from "./viewMenu";
import { bakeStoredDesk } from "./viewerChoices";
import { installContextMenuGuard } from "./contextMenuGuard";
import { subscribeDesk } from "./deskBus";
import {
  chooseDesk,
  deskMigrated,
  deskRevision,
  installDesk,
  markDeskMigrated,
  readLocalDesk,
  setDeskRevision,
} from "./deskSync";
import {
  bindTerminalPane,
  closePinned,
  layoutForSpace,
  loadSpaceLayout,
  markWorkspaceFocused,
  preferPendingPane,
  preferPendingSpace,
  spaceReturnFocus,
  readSpaceLayouts,
  saveSpaceLayout,
  paneOnActiveTab,
  seedSpaceLayout,
  spaceLayoutKey,
  writeSpaceMap,
} from "./spaceLayout";

const VIEWER_BAKED = "herdr-panels.viewer-baked";

function viewerBaked(): boolean {
  try {
    return localStorage.getItem(VIEWER_BAKED) === "1";
  } catch {
    return false;
  }
}

function markViewerBaked() {
  try {
    localStorage.setItem(VIEWER_BAKED, "1");
    localStorage.removeItem("herdr-panels.address-bar");
    localStorage.removeItem("herdr-panels.raw-text");
    localStorage.removeItem("herdr-panels.plugin-view");
  } catch {
    // A later load can bake the same choices again.
  }
}

function present(doc: LayoutDocument): LayoutDocument {
  return { ...doc, root: normalizeLayout(doc.root) };
}

export function App() {
  const [layout, setLayout] = useState<LayoutDocument | null>(null);
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [design, setDesign] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [element, setElement] = useState<{ panelId: string; tag: string; text: string } | null>(null);
  const [zoomedId, setZoomedId] = useState<string | null>(null);
  const [visit, setVisit] = useState<(OpenedVisit & { openedOn: string }) | null>(null);
  const [chatTarget, setChatTarget] = useState("");
  const [splitHerdr, setSplitHerdr] = useState(true);
  const [inbox, setInbox] = useState<Record<string, Attachment[]>>({});
  const [sessions, setSessions] = useState<string[]>([]);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [selecting, setSelecting] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [keyId, setKeyId] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [openMenuToken, setOpenMenuToken] = useState(0);
  const [herdrCtl, setHerdrCtl] = useState<HerdrCtlStatus | null>(null);
  const [herdrBusy, setHerdrBusy] = useState(false);
  const [viewer, setViewer] = useState<ViewerHealth | null>(null);
  const [viewerDown, setViewerDown] = useState(false);
  const [deskReady, setDeskReady] = useState(false);
  const saveRef = useRef(0);
  const noticeRef = useRef(0);
  const followed = useRef<string | null>(null);
  const spaceRef = useRef<string | null>(null);
  /** While set, ignore runtime focus that still points at the previous space. */
  const pendingSpaceRef = useRef<string | null>(null);
  const pendingPaneRef = useRef<string | null>(null);
  const keyIdRef = useRef<string | null>(null);
  const layoutRef = useRef<LayoutDocument | null>(null);
  const closedRef = useRef<ClosedPanel[]>([]);
  const runtimeRef = useRef<RuntimeSnapshot | null>(null);
  const sessionRef = useRef<string | null>(null);
  const deskGeneration = useRef(0);
  useEffect(() => installDisplayZoom({ keyedId: () => keyIdRef.current }), []);
  const acceptDeskSaves = useRef(false);
  const deskSaveTimer = useRef(0);
  const applySpaceRef = useRef<(root: LayoutNode) => void>(() => {});
  layoutRef.current = layout;
  runtimeRef.current = runtime;
  keyIdRef.current = keyId;

  useEffect(() => installContextMenuGuard(), []);

  useEffect(() => {
    let stopped = false;
    api
      .bootstrap()
      .then(async (boot) => {
        if (stopped) return;
        const session = boot.runtime.session || tabSession();
        rememberSession(session);
        const server = await api.desk();
        if (stopped) return;
        const choice = chooseDesk(server, readLocalDesk(), deskMigrated());
        const bake = !viewerBaked();
        const desk = bake
          ? bakeStoredDesk(choice.desk, boot.layout.id, {
              addressBar: readAddressBarChoices(),
              raw: readRawChoices(),
              plugins: readPluginSubjects(),
            })
          : choice.desk;
        const changed = bake && JSON.stringify(desk) !== JSON.stringify(choice.desk);
        let stored: DeskFile = server;
        try {
          if (choice.upload || changed) {
            const saved = await api.saveDesk({
              session,
              adopt: true,
              revision: server.revision,
              pins: desk.pins,
              spaces: desk.spaces,
            });
            if (stopped) return;
            stored = saved.desk;
          } else if (bake) {
            stored = { revision: server.revision, pins: desk.pins, spaces: desk.spaces };
          }
          markDeskMigrated();
          if (bake) markViewerBaked();
        } catch (err: unknown) {
          stored = {
            revision: server.revision,
            pins: desk.pins,
            spaces: desk.spaces,
          };
          if (!stopped) setNotice(err instanceof Error ? err.message : "Could not save the desk");
        }
        if (stopped) return;
        installDesk(stored, stored.revision);
        sessionRef.current = session;
        acceptDeskSaves.current = true;
        const next = present(boot.layout);
        setLayout(next);
        setRuntime(boot.runtime);
        setDeskReady(true);
        setSelectedId(listPanels(next.root)[0]?.id ?? null);
        setError(null);
        void api.sessions().then((list) => {
          if (!stopped) setSessions(list.sessions.map((item) => item.name));
        });
      })
      .catch((err: unknown) => {
        if (!stopped) setError(err instanceof Error ? err.message : String(err));
      });
    const refreshCtl = () => {
      void api.herdrCtl().then(
        (next) => {
          if (!stopped) setHerdrCtl(next);
        },
        () => undefined,
      );
    };
    refreshCtl();
    void api.health().then(
      (next) => {
        if (!stopped) {
          setViewer(next);
          setViewerDown(false);
        }
      },
      () => {
        if (!stopped) setViewerDown(true);
      },
    );
    const refreshPlugins = () => {
      void api.plugins().then(
        (list) => {
          if (!stopped) {
            setPlugins((current) => (pluginListChanged(current, list.plugins) ? list.plugins : current));
          }
        },
        () => undefined,
      );
    };
    refreshPlugins();
    const poll = window.setInterval(() => {
      refreshPlugins();
      api
        .runtime()
        .then((next) => {
          if (pendingPaneRef.current && next.focusedPaneId === pendingPaneRef.current) pendingPaneRef.current = null;
          if (!stopped) {
            setRuntime(
              preferPendingPane(
                preferPendingSpace(next, pendingSpaceRef.current, pendingPaneRef.current),
                pendingPaneRef.current,
              ),
            );
          }
        })
        .catch(() => {
          if (!stopped) {
            setRuntime((current) =>
              current
                ? { ...current, connected: false, error: "The panels server is not responding" }
                : current,
            );
          }
        });
    }, 2000);
    const ctlPoll = window.setInterval(refreshCtl, 60_000);
    return () => {
      stopped = true;
      window.clearInterval(poll);
      window.clearInterval(ctlPoll);
      window.clearTimeout(saveRef.current);
      window.clearTimeout(noticeRef.current);
      window.clearTimeout(deskSaveTimer.current);
    };
  }, []);

  useEffect(() => {
    return subscribeDesk(() => {
      if (!acceptDeskSaves.current) return;
      window.clearTimeout(deskSaveTimer.current);
      const generation = deskGeneration.current;
      const session = sessionRef.current || "default";
      deskSaveTimer.current = window.setTimeout(() => {
        const snapshot = readLocalDesk();
        void api
          .saveDesk({
            session,
            adopt: false,
            revision: deskRevision(),
            pins: snapshot.pins,
            spaces: snapshot.spaces,
          })
          .then((result) => {
            if (generation !== deskGeneration.current) return;
            if (result.status === "stored") {
              setDeskRevision(result.desk.revision);
              return;
            }
            acceptDeskSaves.current = false;
            installDesk(result.desk, result.desk.revision);
            acceptDeskSaves.current = true;
            const space = spaceRef.current;
            if (!space) return;
            applySpaceRef.current(layoutForSpace(space, seedSpaceLayout()));
          })
          .catch((err: unknown) => {
            setNotice(err instanceof Error ? err.message : "Could not save the desk");
          });
      }, 250);
    });
  }, []);

  const remember = useCallback((next: LayoutDocument) => {
    setLayout(next);
    if (spaceRef.current) saveSpaceLayout(spaceRef.current, next.root);
    window.clearTimeout(saveRef.current);
    setNotice("Saving");
    saveRef.current = window.setTimeout(() => {
      api
        .saveLayout(next)
        .then(() => {
          setNotice("Saved");
          window.clearTimeout(noticeRef.current);
          noticeRef.current = window.setTimeout(() => setNotice(null), 1200);
        })
        .catch((err: unknown) => {
          setNotice(err instanceof Error ? err.message : "Save failed");
        });
    }, 250);
  }, []);

  /** Swap the desk for a space without waiting on Herdr or a layout save. */
  const showSpaceLayout = useCallback((doc: LayoutDocument, root: LayoutDocument["root"]) => {
    const shown = normalizeLayout(root);
    setLayout({ ...doc, root: shown });
    setSelectedId(null);
    setOpenMenuId(null);
  }, []);
  applySpaceRef.current = (root) => {
    const doc = layoutRef.current;
    if (doc) showSpaceLayout(doc, root);
  };

  /** Instant desk swap; Herdr focus runs in the background. Returns the panel that shows the pane. */
  const switchSpace = useCallback((workspaceId: string, paneId?: string): string | null => {
    const doc = layoutRef.current;
    if (!doc || !workspaceId) return null;
    const snapshot = runtimeRef.current;
    const choice = snapshot
      ? spaceReturnFocus(snapshot, workspaceId, paneId)
      : {
          request: (paneId ? { paneId } : { workspaceId }) as { paneId: string } | { workspaceId: string },
          paneId: paneId ?? null,
        };
    const displayPane = choice.paneId;

    if (spaceRef.current === workspaceId && !paneId) {
      pendingSpaceRef.current = workspaceId;
      void api.focus({ workspaceId }).catch(() => undefined);
      return null;
    }

    let landed = doc.root;
    if (spaceRef.current !== workspaceId) {
      if (spaceRef.current) saveSpaceLayout(spaceRef.current, doc.root);
      pendingSpaceRef.current = workspaceId;
      spaceRef.current = workspaceId;
      writeSpaceMap(workspaceId);
      setZoomedId(null);
      landed = paneId
        ? layoutForFocusedPane(layoutForSpace(workspaceId, seedSpaceLayout()), displayPane ?? paneId)
        : bindTerminalPane(layoutForSpace(workspaceId, seedSpaceLayout()), displayPane);
      showSpaceLayout(doc, landed);
      if (snapshot) setRuntime(markWorkspaceFocused(snapshot, workspaceId, displayPane));
    } else if (paneId && displayPane) {
      pendingSpaceRef.current = workspaceId;
      landed = layoutForFocusedPane(doc.root, displayPane);
      if (landed !== doc.root) showSpaceLayout(doc, landed);
      if (snapshot) setRuntime(markWorkspaceFocused(snapshot, workspaceId, displayPane));
    }

    if ("paneId" in choice.request) pendingPaneRef.current = choice.request.paneId;
    void api.focus(choice.request).catch(() => undefined);
    const refs = panelRefs(listPanels(landed));
    if (displayPane) return panelForPane(refs, displayPane, null)?.id ?? refs[0]?.id ?? null;
    return refs[0]?.id ?? null;
  }, [showSpaceLayout]);

  const revealRef = useRef<(paneId: string, workspaceId: string) => string | null>(() => null);
  revealRef.current = (paneId, workspaceId) => {
    const doc = layoutRef.current;
    if (!doc || !paneId) return null;
    const current = spaceRef.current;
    const targetRoot = workspaceId ? layoutForSpace(workspaceId, seedSpaceLayout()) : doc.root;
    const next = layoutForPaneFocus(current, doc.root, workspaceId, targetRoot, paneId, keyIdRef.current);
    const switched = Boolean(next.workspaceId) && next.workspaceId !== current;
    if (switched) {
      if (current) saveSpaceLayout(current, doc.root);
      pendingSpaceRef.current = next.workspaceId;
      spaceRef.current = next.workspaceId;
      writeSpaceMap(next.workspaceId);
    }
    if (switched || next.root !== doc.root) {
      showSpaceLayout(doc, next.root);
      if (next.workspaceId) saveSpaceLayout(next.workspaceId, next.root);
    }
    pendingPaneRef.current = paneId;
    const snapshot = runtimeRef.current;
    if (snapshot && next.workspaceId) setRuntime(markWorkspaceFocused(snapshot, next.workspaceId, paneId));
    setZoomedId((zoomed) => (zoomed && zoomed !== next.panelId ? null : zoomed));
    setKeyId(next.panelId);
    const page = window as Window & { __hwpFocusPanel?: (id: string) => void };
    page.__hwpFocusPanel?.(next.panelId);
    void api.focus({ paneId }).catch(() => undefined);
    return next.panelId;
  };

  useEffect(() => {
    const page = window as Window & {
      __hwpRevealPane?: (paneId: string, workspaceId: string) => string | null;
    };
    page.__hwpRevealPane = (paneId, workspaceId) => revealRef.current(paneId, workspaceId);
    return () => {
      delete page.__hwpRevealPane;
    };
  }, []);

  useEffect(() => {
    if (!layout || !keyId) return;
    const ids = listPanels(layout.root).map((panel) => panel.id);
    if (ids.includes(keyId)) return;
    setKeyId(ids[0] ?? null);
  }, [layout, keyId]);

  const focusedSpaceId =
    runtime?.focusedWorkspaceId ||
    runtime?.workspaces.find((item) => item.focused)?.workspaceId ||
    null;

  useEffect(() => {
    if (!deskReady) return;
    const doc = layoutRef.current;
    if (!doc || !focusedSpaceId) return;
    if (pendingSpaceRef.current) {
      if (pendingSpaceRef.current === focusedSpaceId) pendingSpaceRef.current = null;
      return;
    }
    if (spaceRef.current === null) {
      spaceRef.current = focusedSpaceId;
      writeSpaceMap(focusedSpaceId);
      if (!loadSpaceLayout(focusedSpaceId)) {
        const snapshot = runtimeRef.current;
        const pane =
          snapshot?.panes.find(
            (item) => item.workspaceId === focusedSpaceId && item.paneId === snapshot.focusedPaneId,
          ) ??
          snapshot?.panes.find((item) => item.workspaceId === focusedSpaceId) ??
          null;
        const seeded = bindTerminalPane(seedSpaceLayout(), pane?.paneId ?? null);
        saveSpaceLayout(focusedSpaceId, seeded);
        showSpaceLayout(doc, layoutForSpace(focusedSpaceId, seeded));
        if (pane && snapshot?.connected) followed.current = snapshot.session || "default";
        return;
      }
      showSpaceLayout(doc, layoutForSpace(focusedSpaceId, doc.root));
      return;
    }
    if (spaceRef.current === focusedSpaceId) return;
    saveSpaceLayout(spaceRef.current, doc.root);
    spaceRef.current = focusedSpaceId;
    writeSpaceMap(focusedSpaceId);
    let root = layoutForSpace(focusedSpaceId, seedSpaceLayout());
    if (!loadSpaceLayout(focusedSpaceId)) {
      const pane = runtimeRef.current ? paneOnActiveTab(runtimeRef.current, focusedSpaceId) : null;
      root = bindTerminalPane(root, pane?.paneId ?? null);
      saveSpaceLayout(focusedSpaceId, root);
    }
    showSpaceLayout(doc, root);
  }, [deskReady, focusedSpaceId, showSpaceLayout]);

  useEffect(() => {
    if (!deskReady || !runtime) return;
    const session = runtime.session || "default";
    if (sessionRef.current === session) return;
    const generation = ++deskGeneration.current;
    acceptDeskSaves.current = false;
    window.clearTimeout(deskSaveTimer.current);
    sessionRef.current = session;
    void api.desk().then((desk) => {
      if (generation !== deskGeneration.current) return;
      installDesk(desk, desk.revision);
      acceptDeskSaves.current = true;
      const space = spaceRef.current;
      if (!space) return;
      applySpaceRef.current(layoutForSpace(space, seedSpaceLayout()));
    });
  }, [deskReady, runtime]);

  useEffect(() => {
    if (!layout || !runtime?.connected) return;
    const session = runtime.session || "default";
    if (followed.current === session) return;
    const pane =
      runtime.panes.find((item) => item.paneId === runtime.focusedPaneId) ??
      runtime.panes.find((item) => item.focused) ??
      runtime.panes[0];
    const terminal = listPanels(layout.root).find((panel) => panel.panel.type === "herdr");
    followed.current = session;
    if (!terminal || terminal.panel.type !== "herdr") return;
    const bound = terminal.panel.paneId;
    if (bound && runtime.panes.some((item) => item.paneId === bound)) return;
    remember({
      ...layout,
      root: setPanel(layout.root, terminal.id, { ...terminal.panel, paneId: pane?.paneId ?? null }),
    });
  }, [layout, runtime, remember]);

  const consume = useCallback((panelId: string) => {
    setInbox((current) => ({ ...current, [panelId]: [] }));
  }, []);

  const visitRef = useRef<
    (
      panels: { panelId: string; spaceId?: string }[],
      arrange?: string,
      weights?: VisitWeights,
    ) => OpenedVisit | { error: string }
  >(() => ({
    error: "The desk could not show that panel.",
  }));
  visitRef.current = (panels, arrange, weights) => {
    const current = spaceRef.current;
    const stored = readSpaceLayouts();
    const workspaces = runtimeRef.current?.workspaces ?? [];
    const listed = new Set<string>();
    const spaces: { id: string; label: string; root: LayoutNode; current: boolean }[] = [];
    for (const workspace of workspaces) {
      const key = spaceLayoutKey(workspace.workspaceId);
      listed.add(key);
      const root =
        current === workspace.workspaceId && layoutRef.current
          ? layoutRef.current.root
          : (stored[key] ?? null);
      if (!root) continue;
      spaces.push({
        id: workspace.workspaceId,
        label: workspace.label || workspace.workspaceId,
        root,
        current: current === workspace.workspaceId,
      });
    }
    if (current && layoutRef.current && !spaces.some((space) => space.current)) {
      spaces.push({
        id: current,
        label: workspaces.find((workspace) => workspace.workspaceId === current)?.label || current,
        root: layoutRef.current.root,
        current: true,
      });
    }
    for (const [key, root] of Object.entries(stored)) {
      if (listed.has(key) || (current && spaceLayoutKey(current) === key)) continue;
      spaces.push({ id: key, label: key, root, current: false });
    }
    const opened = openVisit(spaces, panels, arrange, weights);
    if ("error" in opened) return opened;
    const openedOn = current ?? "";
    setVisit((showing) => ({
      ...opened,
      node:
        showing && showing.arrange === opened.arrange ? reuseVisit(showing.node, opened) : opened.node,
      openedOn: showing?.openedOn ?? openedOn,
    }));
    return opened;
  };

  useEffect(() => {
    const page = window as Window & {
      __hwpVisitPanel?: (
        panels: { panelId: string; spaceId?: string }[],
        arrange?: string,
        weights?: VisitWeights,
      ) => OpenedVisit | { error: string };
    };
    page.__hwpVisitPanel = (panels, arrange, weights) => visitRef.current(panels, arrange, weights);
    return () => {
      delete page.__hwpVisitPanel;
    };
  }, []);

  useEffect(() => {
    if (!visit) return;
    if ((spaceRef.current ?? "") === visit.openedOn) return;
    setVisit(null);
  }, [layout, focusedSpaceId, visit]);

  useEffect(() => {
    if (!visit) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setVisit(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [visit]);

  useEffect(() => {
    const socket = new WebSocket(wsUrl("/ws/agent"));
    socket.onmessage = (event) => {
      let msg: {
        type?: string;
        layout?: LayoutDocument;
        desk?: DeskFile;
        panelId?: string | null;
        spaceId?: string;
        arrange?: string;
        panels?: { panelId?: string; spaceId?: string }[];
        space?: string | null;
        sizes?: number[];
        columns?: number[];
        rows?: number[];
        selector?: string;
        text?: string;
        requestId?: string;
      };
      try {
        msg = JSON.parse(String(event.data)) as typeof msg;
      } catch {
        return;
      }
      const posted = (msg as { session?: string }).session;
      if (posted && posted !== tabSession()) return;
      if (msg.type === "desk" && msg.desk) {
        if (msg.desk.revision === deskRevision()) return;
        const space = spaceRef.current;
        const before = space ? layoutForSpace(space, seedSpaceLayout()) : null;
        acceptDeskSaves.current = false;
        installDesk(msg.desk, msg.desk.revision);
        acceptDeskSaves.current = true;
        if (!space) return;
        const after = layoutForSpace(space, seedSpaceLayout());
        if (!before || JSON.stringify(before) !== JSON.stringify(after)) applySpaceRef.current(after);
        return;
      }
      if (msg.type === "layout" && msg.layout) {
        window.clearTimeout(saveRef.current);
        const next = present(msg.layout);
        setLayout(next);
        if (spaceRef.current) saveSpaceLayout(spaceRef.current, next.root);
        setNotice("Updated by an agent");
        window.clearTimeout(noticeRef.current);
        noticeRef.current = window.setTimeout(() => setNotice(null), 1600);
        return;
      }
      if (msg.type === "zoom") {
        if (msg.space && spaceRef.current && msg.space !== spaceRef.current) return;
        setZoomedId(msg.panelId ?? null);
        return;
      }
      if (msg.type === "visit" && (msg.panelId || msg.panels?.length)) {
        const listed = (msg.panels ?? []).flatMap((panel) =>
          panel.panelId ? [{ panelId: panel.panelId, spaceId: panel.spaceId }] : [],
        );
        const panels = listed.length
          ? listed
          : [{ panelId: msg.panelId ?? "", spaceId: msg.spaceId }];
        const result = visitRef.current(panels, msg.arrange, {
          sizes: msg.sizes,
          columns: msg.columns,
          rows: msg.rows,
        });
        if ("error" in result) notify(result.error);
        return;
      }
      if (msg.type === "select" && msg.panelId) {
        const panelId = msg.panelId;
        setDesign(true);
        setSelectedId(panelId);
        setElement(msg.text ? { panelId, tag: msg.selector || "item", text: msg.text } : null);
        highlight(panelId, msg.selector, msg.text);
        return;
      }
      if (msg.type === "inspect" && msg.requestId && msg.panelId) {
        const requestId = msg.requestId;
        void inspectPanel(msg.panelId, msg.selector, msg.text).then((result) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "inspect-result", requestId, result }));
          }
        });
        return;
      }
      if (msg.type === "chat") {
        window.dispatchEvent(new CustomEvent("hwp-chat", { detail: msg }));
      }
    };
    return () => socket.close();
  }, []);

  const designState = useMemo(
    () => ({
      enabled: design,
      selectedId,
      element,
      selectPanel: (id: string) => {
        setSelectedId(id);
        setElement(null);
        if (layout && findPanel(layout.root, id)?.panel.type === "chat") setChatTarget(id);
      },
      selectElement: (pick: { panelId: string; tag: string; text: string }) => {
        setSelectedId(pick.panelId);
        setElement(pick);
      },
    }),
    [design, element, layout, selectedId],
  );

  if (error && !layout) {
    return (
      <div className="boot-error">
        <h1>Herdr Panels</h1>
        <p>{error}</p>
      </div>
    );
  }
  if (!layout) {
    return (
      <div className="boot-error">
        <h1>Herdr Panels</h1>
        <p>Loading workspace…</p>
      </div>
    );
  }

  const shown = zoomedId ? findPanel(layout.root, zoomedId) : null;
  const root = shown ?? layout.root;

  function edit(rootNext: LayoutDocument["root"]) {
    remember({ ...layout!, root: rootNext });
  }

  function reopenClosed() {
    const doc = layoutRef.current;
    if (!doc) return;
    const openIds = new Set(listPanels(doc.root).map((panel) => panel.id));
    const taken = takeClosedPanel(closedRef.current, openIds);
    rememberClosed(taken.stack);
    if (!taken.closed) {
      notify("No closed panel to restore");
      return;
    }
    const root = reopenPanel(doc.root, taken.closed);
    if (!root) {
      notify("No closed panel to restore");
      return;
    }
    edit(root);
    setSelectedId(taken.closed.panel.id);
  }

  function runHerdrAction(action: HerdrStatusAction) {
    if (herdrBusy) return;
    setHerdrBusy(true);
    setNotice(
      action === "start" ? "Starting Herdr…" : action === "update" ? "Updating Herdr…" : "Restarting Herdr…",
    );
    void api
      .herdrCtlAction(action)
      .then((next) => {
        if (next.runtime) setRuntime(next.runtime);
        if (next.ctl) setHerdrCtl(next.ctl);
        else void api.herdrCtl().then(setHerdrCtl, () => undefined);
        setError(null);
        setNotice(
          action === "start"
            ? "Herdr started"
            : action === "update"
              ? next.message?.split("\n")[0] || "Herdr updated"
              : "Herdr restarted",
        );
        window.clearTimeout(noticeRef.current);
        noticeRef.current = window.setTimeout(() => setNotice(null), 2400);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setNotice(null);
      })
      .finally(() => setHerdrBusy(false));
  }

  async function split(id: string, direction: "row" | "column", herdrSplit = splitHerdr) {
    const current = findPanel(layout!.root, id);
    let paneId: string | null = null;
    if (herdrSplit && current?.panel.type === "herdr" && current.panel.paneId) {
      try {
        const created = await api.splitPane(current.panel.paneId, direction === "row" ? "right" : "down");
        paneId = created.paneId;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    const panelId = freshPanelId(layout!.root);
    const created = {
      type: "panel" as const,
      id: panelId,
      title: null,
      panel: paneId ? { type: "herdr" as const, paneId, scope: "pane" as const } : defaultPanel("herdr"),
    };
    edit(splitPanel(layout!.root, id, direction, created));
    setSelectedId(panelId);
    setElement(null);
  }

  function panelChoice(type: PanelConfig["type"], pluginId?: string): PanelConfig {
    if (type === "plugin" && pluginId) {
      return plugins.some((item) => item.id === pluginId && item.controlDefault)
        ? { type: "plugin", plugin: pluginId, control: true }
        : { type: "plugin", plugin: pluginId };
    }
    if (type === "explorer") {
      const space = runtime?.workspaces.find((item) => item.focused) ?? runtime?.workspaces[0];
      const pane =
        runtime?.panes.find((item) => item.cwd && item.paneId === runtime.focusedPaneId) ??
        runtime?.panes.find((item) => item.cwd);
      return { type: "explorer", path: space?.root || pane?.cwd || "" };
    }
    return defaultPanel(type);
  }

  function rememberClosed(next: ClosedPanel[]) {
    closedRef.current = next;
  }

  function close(id: string) {
    const spaceIds = runtimeRef.current?.workspaces.map((space) => space.workspaceId) ?? [];
    const record = describeClose(layout!.root, id);
    const next = closePinned(layout!.root, id, spaceRef.current ?? "", spaceIds);
    if (!next) {
      setNotice("At least one panel stays open");
      return;
    }
    if (record) rememberClosed(pushClosedPanel(closedRef.current, record));
    edit(next);
    setSelectedId(listPanels(next)[0]?.id ?? null);
    if (openMenuId === id) setOpenMenuId(null);
    if (zoomedId === id) setZoomedId(null);
  }

  function addPanel() {
    const from =
      (selectedId && findPanel(layout!.root, selectedId)?.id) ||
      listPanels(layout!.root).at(-1)?.id;
    if (!from) return;
    const panelId = freshPanelId(layout!.root);
    edit(
      splitPanel(layout!.root, from, "row", {
        type: "panel",
        id: panelId,
        title: null,
        panel: { type: "blank" },
      }),
    );
    setSelectedId(panelId);
    setOpenMenuId(panelId);
    setOpenMenuToken((token) => token + 1);
  }

  function focusAgentPane(paneId: string): string | null {
    const snapshot = runtimeRef.current;
    const doc = layoutRef.current;
    if (!snapshot || !doc) return null;
    const pane = snapshot.panes.find((item) => item.paneId === paneId);
    if (!pane) {
      void api.focus({ paneId }).catch(() => undefined);
      return null;
    }
    if (spaceRef.current !== pane.workspaceId) return switchSpace(pane.workspaceId, pane.paneId);
    const refs = panelRefs(listPanels(doc.root));
    const target = panelForPane(refs, pane.paneId, keyIdRef.current);
    if (target?.rebind) {
      const node = findPanel(doc.root, target.id);
      if (node && node.panel.type === "herdr") {
        remember({ ...doc, root: setPanel(doc.root, target.id, { ...node.panel, paneId: pane.paneId }) });
      }
    }
    pendingPaneRef.current = pane.paneId;
    setRuntime(markWorkspaceFocused(snapshot, pane.workspaceId, pane.paneId));
    void api.focus({ paneId: pane.paneId }).catch(() => undefined);
    return target?.id ?? null;
  }

  function notify(message: string) {
    setNotice(message);
    window.clearTimeout(noticeRef.current);
    noticeRef.current = window.setTimeout(() => setNotice(null), 2400);
  }

  function addToChat(chatId: string, attachment: Attachment) {
    setInbox((current) => ({
      ...current,
      [chatId]: [...(current[chatId] ?? []), attachment].slice(-12),
    }));
    setChatTarget(chatId);
    setNotice(`Added to ${findPanel(layout!.root, chatId)?.title || "chat"}`);
  }

  return (
    <DesignProvider value={designState}>
      <PanelActionsProvider
        actions={{
          close,
          add: (id, direction) => void split(id, direction, false),
          addTab: (id) => {
            const found = findPanel(layout.root, id);
            if (found?.panel.type === "tabs" && found.panel.tabs.length >= 24) {
              setNotice("A panel can have 24 tabs");
              return;
            }
            edit(addPanelTab(layout.root, id));
          },
          use: (id, type, pluginId) => edit(assignContent(layout.root, id, panelChoice(type, pluginId))),
          edge: (id, edge) => edit(setTabEdge(layout.root, id, edge)),
          place: (sourceId, targetId, place) => edit(movePanel(layout.root, sourceId, targetId, place)),
          spawn: (id, direction, panel, title) => {
            const doc = layoutRef.current;
            if (!doc) return;
            const panelId = freshPanelId(doc.root);
            edit(splitPanel(doc.root, id, direction, { type: "panel", id: panelId, title: title || null, panel }));
          },
          rename: (id, title) => edit(mapPanel(layout.root, id, (panel) => ({ ...panel, title: title || null }))),
          fill: (id) => setZoomedId((current) => (current === id ? null : id)),
          filledId: zoomedId,
        }}
      >
      <HostProvider
        runtime={runtime}
        onRuntime={(next) =>
          setRuntime(
            preferPendingPane(
              preferPendingSpace(next, pendingSpaceRef.current, pendingPaneRef.current),
              pendingPaneRef.current,
            ),
          )
        }
        onNotice={notify}
      >
      <KeyedPanelProvider id={keyId} set={setKeyId}>
      <div className="app">
        <DeskKeyboard
          layout={layout.root}
          runtime={runtime}
          focusedId={keyId}
          zoomedId={zoomedId}
          help={help}
          onFocus={setKeyId}
          onZoom={setZoomedId}
          onSpace={switchSpace}
          onAgent={focusAgentPane}
          onNotice={notify}
          onToggleHelp={() => setHelp((open) => !open)}
          onHelp={setHelp}
          onReopen={reopenClosed}
        />
        <TopBar
          runtime={runtime}
          viewer={viewer}
          viewerDown={viewerDown}
          herdrCtl={herdrCtl}
          herdrBusy={herdrBusy}
          notice={notice}
          zoomed={Boolean(zoomedId)}
          sessions={sessions}
          selecting={selecting}
          onHerdrAction={runHerdrAction}
          onSession={(name) => {
            void api.useSession(name).then(
              (next) => {
                rememberSession(next.runtime.session || name);
                setRuntime(next.runtime);
                setError(null);
                setNotice(name);
              },
              (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
            );
          }}
          onCreateSession={(name) => {
            void api.createSession(name).then(
              async (next) => {
                rememberSession(next.runtime.session || name);
                setRuntime(next.runtime);
                const list = await api.sessions();
                setSessions(list.sessions.map((item) => item.name));
                setError(null);
                setNotice(name);
              },
              (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
            );
          }}
          onCloseSession={() => {
            const current = runtime?.session || "default";
            void api.closeSession(current).then(
              async (next) => {
                rememberSession(next.name || next.runtime.session || "default");
                setRuntime(next.runtime);
                const list = await api.sessions();
                setSessions(list.sessions.map((item) => item.name));
                setError(null);
                setNotice(next.name);
              },
              (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
            );
          }}
          onRenameSession={(name) => {
            const current = runtime?.session || "default";
            void api.renameSession(current, name).then(
              async (next) => {
                rememberSession(next.runtime.session || name);
                setRuntime(next.runtime);
                const list = await api.sessions();
                setSessions(list.sessions.map((item) => item.name));
                setError(null);
                setNotice(name);
              },
              (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
            );
          }}
          onSelect={() => setSelecting((current) => !current)}
          onAddPanel={addPanel}
          onExitZoom={() => setZoomedId(null)}
          onClearFocus={() => setKeyId(null)}
        />
        {error ? <div className="banner">{error}</div> : null}
        <main className="workspace">
          <DeskProvider
            value={{
              tabs: runtime?.tabs ?? [],
              focusedTabId: runtime?.focusedTabId ?? null,
              focusedWorkspaceId: runtime?.focusedWorkspaceId ?? null,
              plugins,
              onFocusTab: (tabId) => {
                void api.focus({ tabId });
              },
            }}
          >
          <LayoutView
            node={root}
            root={layout.root}
            openMenuId={openMenuId}
            openMenuToken={openMenuToken}
            panes={runtime?.panes ?? []}
            workspaces={runtime?.workspaces ?? []}
            agents={runtime?.agents ?? []}
            layoutId={layout.id}
            pending={inbox}
            onConsume={consume}
            onRatio={(path, ratio) => edit(setSplitRatio(layout.root, path, ratio))}
            onTracks={(path, columns, rows) => edit(setGridTracks(layout.root, path, columns, rows))}
            onPanel={(id, panel: PanelConfig, retitle) =>
              edit(assignContent(layout.root, id, panel, retitle === true))
            }
            onCloseTab={(id, tabId) => edit(closePanelTab(layout.root, id, tabId))}
            onOpenSpace={switchSpace}
            onFocusPane={focusAgentPane}
          />
          {visit ? (
            <div className="borrow-visit">
              {visit.single ? null : (
                <header className="borrow-visit-bar">
                  <button type="button" className="borrow-back" onClick={() => setVisit(null)}>
                    Back
                  </button>
                </header>
              )}
              <LayoutView
                node={visit.node}
                root={visit.node}
                panes={runtime?.panes ?? []}
                workspaces={runtime?.workspaces ?? []}
                agents={runtime?.agents ?? []}
                layoutId={layout.id}
                pending={{}}
                onConsume={() => undefined}
                onRatio={(path, ratio) =>
                  setVisit((current) =>
                    current ? { ...current, node: setSplitRatio(current.node, path, ratio) } : current,
                  )
                }
                onTracks={(path, columns, rows) =>
                  setVisit((current) =>
                    current ? { ...current, node: setGridTracks(current.node, path, columns, rows) } : current,
                  )
                }
                onPanel={(id, panel, retitle) =>
                  setVisit((current) =>
                    current
                      ? { ...current, node: assignContent(current.node, id, panel, retitle === true) }
                      : current,
                  )
                }
                onCloseTab={() => undefined}
                onFocusPane={focusAgentPane}
                borrowed={!visit.single}
                origins={visit.origins}
                onBack={visit.single ? () => setVisit(null) : undefined}
                fromSpace={visit.single ? visit.spaceLabel : undefined}
              />
            </div>
          ) : null}
          </DeskProvider>
        </main>
        {selecting ? (
          <ElementSelect
            onNotice={(message) => {
              setNotice(message);
              window.clearTimeout(noticeRef.current);
              noticeRef.current = window.setTimeout(() => setNotice(null), 1600);
            }}
            onClose={() => setSelecting(false)}
          />
        ) : null}
        {design ? (
          <DesignBar
            layout={layout}
            panes={runtime?.panes ?? []}
            workspaces={runtime?.workspaces ?? []}
            plugins={plugins}
            selectedId={selectedId}
            element={element}
            zoomedId={zoomedId}
            chatTarget={chatTarget}
            splitHerdr={splitHerdr}
            onSplitHerdr={setSplitHerdr}
            onChatTarget={setChatTarget}
            onType={(id, type) => edit(assignContent(layout.root, id, panelChoice(type), true))}
            onTitle={(id, title) => edit(mapPanel(layout.root, id, (panel) => ({ ...panel, title: title || null })))}
            onConfig={(id, panel) => edit(assignContent(layout.root, id, panel))}
            onSplit={(id, direction) => void split(id, direction)}
            onClose={close}
            onZoom={setZoomedId}
            onAdd={addToChat}
            onOpenChat={(id, attachment) => {
              const panelId = freshPanelId(layout.root);
              edit(
                splitPanel(layout.root, id, "column", {
                  type: "panel",
                  id: panelId,
                  title: "Chat",
                  panel: { type: "chat", paneId: null },
                }),
              );
              setChatTarget(panelId);
              setSelectedId(panelId);
              addToChat(panelId, attachment);
            }}
          />
        ) : null}
      </div>
      </KeyedPanelProvider>
      </HostProvider>
      </PanelActionsProvider>
    </DesignProvider>
  );
}
