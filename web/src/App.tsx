import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, wsUrl } from "./api";
import { DesignProvider } from "./design";
import { highlight, inspectPanel } from "./inspect";
import {
  addPanelTab,
  assignContent,
  closePanel,
  closePanelTab,
  defaultPanel,
  findPanel,
  freshPanelId,
  listPanels,
  mapPanel,
  movePanel,
  normalizeLayout,
  setGridTracks,
  setPanel,
  setSplitRatio,
  setTabEdge,
  splitPanel,
} from "./layoutEdit";
import { DeskProvider, type PluginInfo } from "./desk";
import { PanelActionsProvider } from "./panelActions";
import type { Attachment, LayoutDocument, PanelConfig, RuntimeSnapshot } from "./types";
import { LayoutView } from "./components/LayoutView";
import { TopBar } from "./components/TopBar";
import { DesignBar } from "./components/DesignBar";
import { ElementSelect } from "./components/ElementSelect";
import { HostProvider } from "./host";

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
  const [chatTarget, setChatTarget] = useState("");
  const [splitHerdr, setSplitHerdr] = useState(true);
  const [inbox, setInbox] = useState<Record<string, Attachment[]>>({});
  const [sessions, setSessions] = useState<string[]>([]);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [selecting, setSelecting] = useState(false);
  const saveRef = useRef(0);
  const noticeRef = useRef(0);
  const followed = useRef<string | null>(null);

  useEffect(() => {
    let stopped = false;
    api
      .bootstrap()
      .then((boot) => {
        if (stopped) return;
        const next = present(boot.layout);
        setLayout(next);
        setRuntime(boot.runtime);
        setSelectedId(listPanels(next.root)[0]?.id ?? null);
        setError(null);
        void api.sessions().then((list) => {
          if (!stopped) setSessions(list.sessions.map((item) => item.name));
        });
        void api.plugins().then((list) => {
          if (!stopped) setPlugins(list.plugins);
        });
      })
      .catch((err: unknown) => {
        if (!stopped) setError(err instanceof Error ? err.message : String(err));
      });
    const poll = window.setInterval(() => {
      api
        .runtime()
        .then((next) => {
          if (!stopped) setRuntime(next);
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
    return () => {
      stopped = true;
      window.clearInterval(poll);
      window.clearTimeout(saveRef.current);
      window.clearTimeout(noticeRef.current);
    };
  }, []);

  const remember = useCallback(
    (next: LayoutDocument) => {
      setLayout(next);
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
    },
    [],
  );

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

  useEffect(() => {
    const socket = new WebSocket(wsUrl("/ws/agent"));
    socket.onmessage = (event) => {
      let msg: {
        type?: string;
        layout?: LayoutDocument;
        panelId?: string | null;
        selector?: string;
        text?: string;
        requestId?: string;
      };
      try {
        msg = JSON.parse(String(event.data)) as typeof msg;
      } catch {
        return;
      }
      if (msg.type === "layout" && msg.layout) {
        window.clearTimeout(saveRef.current);
        setLayout(present(msg.layout));
        setNotice("Updated by an agent");
        window.clearTimeout(noticeRef.current);
        noticeRef.current = window.setTimeout(() => setNotice(null), 1600);
        return;
      }
      if (msg.type === "zoom") {
        setZoomedId(msg.panelId ?? null);
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
      title: paneId ? "Terminal" : "Panel",
      panel: paneId ? { type: "herdr" as const, paneId } : defaultPanel("herdr"),
    };
    edit(splitPanel(layout!.root, id, direction, created));
    setSelectedId(panelId);
    setElement(null);
  }

  function panelChoice(type: PanelConfig["type"], pluginId?: string): PanelConfig {
    if (type === "plugin" && pluginId) return { type: "plugin", plugin: pluginId };
    if (type === "explorer") {
      const space = runtime?.workspaces.find((item) => item.focused) ?? runtime?.workspaces[0];
      const pane =
        runtime?.panes.find((item) => item.cwd && item.paneId === runtime.focusedPaneId) ??
        runtime?.panes.find((item) => item.cwd);
      return { type: "explorer", path: space?.root || pane?.cwd || "" };
    }
    return defaultPanel(type);
  }

  function close(id: string) {
    const next = closePanel(layout!.root, id);
    if (!next) {
      setNotice("At least one panel stays open");
      return;
    }
    edit(next);
    setSelectedId(listPanels(next)[0]?.id ?? null);
    if (zoomedId === id) setZoomedId(null);
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
          use: (id, type, pluginId) => edit(assignContent(layout.root, id, panelChoice(type, pluginId), true)),
          edge: (id, edge) => edit(setTabEdge(layout.root, id, edge)),
          place: (sourceId, targetId, place) => edit(movePanel(layout.root, sourceId, targetId, place)),
          rename: (id, title) => edit(mapPanel(layout.root, id, (panel) => ({ ...panel, title: title || null }))),
        }}
      >
      <HostProvider
        runtime={runtime}
        onRuntime={setRuntime}
        onNotice={(message) => {
          setNotice(message);
          window.clearTimeout(noticeRef.current);
          noticeRef.current = window.setTimeout(() => setNotice(null), 2400);
        }}
      >
      <div className="app">
        <TopBar
          runtime={runtime}
          notice={notice}
          zoomed={Boolean(zoomedId)}
          sessions={sessions}
          selecting={selecting}
          onSession={(name) => {
            void api.useSession(name).then(
              (next) => {
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
          onExitZoom={() => setZoomedId(null)}
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
            panes={runtime?.panes ?? []}
            workspaces={runtime?.workspaces ?? []}
            agents={runtime?.agents ?? []}
            layoutId={layout.id}
            pending={inbox}
            onConsume={consume}
            onRatio={(path, ratio) => edit(setSplitRatio(layout.root, path, ratio))}
            onTracks={(path, columns, rows) => edit(setGridTracks(layout.root, path, columns, rows))}
            onPanel={(id, panel: PanelConfig) => edit(setPanel(layout.root, id, panel))}
            onCloseTab={(id, tabId) => edit(closePanelTab(layout.root, id, tabId))}
            onFocusPane={(paneId) => {
              void api.focus({ paneId });
              const terminal = listPanels(layout.root).find((panel) => panel.panel.type === "herdr");
              if (terminal && terminal.panel.type === "herdr" && terminal.panel.paneId !== paneId) {
                edit(setPanel(layout.root, terminal.id, { ...terminal.panel, paneId }));
              }
            }}
          />
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
      </HostProvider>
      </PanelActionsProvider>
    </DesignProvider>
  );
}
