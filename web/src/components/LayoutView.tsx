import { useRef, useState } from "react";
import type { AgentView, Attachment, GridNode, LayoutNode, PaneView, PanelConfig, WorkspaceView } from "../types";
import { api } from "../api";
import { baseName, samePath } from "../paths";
import { openFileBeside } from "../fileOpen";
import { isDefaultPanelTitle } from "../openTitle";
import { pluginAddressBar } from "../pluginAddress";
import { carryAddressBar, hostAddressBarVisible, setAddressBar, supportsAddressBar } from "../addressBar";
import { carryRaw, showsRawText } from "../rawText";
import { adoptPluginAddress, menuFor, pluginOpenMessage, showViewer, viewerName } from "../viewMenu";
import { climbExplorer, explorerRootFor, resolveWorkspacePath, workspaceDirectory } from "../explorerRoot";
import { canPinPanel, findPin, pinApplies, upsertPin } from "../pins";
import { unpinEverywhere, unpinHere } from "../spaceLayout";
import { openTerminalPane } from "../openTerminal";
import { terminalHereCwd } from "../terminalHere";
import { cellNode, listPanels } from "../layoutEdit";
import { useDesign } from "../design";
import { useDesk } from "../desk";
import { usePanelActions } from "../panelActions";
import { PanelChrome } from "./PanelChrome";
import { addressOf, DocumentFrame } from "./LocationBar";
import { OpenAddressDialog } from "./OpenAddressDialog";
import { PinDialog, type PinDialogResult } from "./PinDialog";
import { TabGroup } from "./TabGroup";
import { SpaceMirror } from "./panels/SpaceMirror";
import { MarkdownView } from "./panels/MarkdownView";
import { IframeView } from "./panels/IframeView";
import { HtmlView } from "./panels/HtmlView";
import { ChatView } from "./panels/ChatView";
import { ExplorerView } from "./panels/ExplorerView";
import { FilesView } from "./panels/FilesView";
import { TextView } from "./panels/TextView";
import { AgentsView } from "./panels/AgentsView";
import { PluginView, type PluginHostCommand } from "./panels/PluginView";

interface Props {
  node: LayoutNode;
  path?: string;
  panes: PaneView[];
  workspaces: WorkspaceView[];
  agents: AgentView[];
  layoutId: string;
  pending: Record<string, Attachment[]>;
  onConsume: (panelId: string) => void;
  onRatio: (path: string, ratio: number) => void;
  onTracks: (path: string, columns: number[], rows: number[]) => void;
  onPanel: (id: string, panel: PanelConfig, retitle?: boolean) => void;
  onCloseTab: (id: string, tabId: string) => void;
  onFocusPane: (paneId: string) => void;
  onOpenSpace?: (workspaceId: string) => void;
  onBack?: () => void;
  fromSpace?: string;
  borrowed?: boolean;
  origins?: Record<string, string>;
  openMenuId?: string | null;
  openMenuToken?: number;
  root?: LayoutNode;
}

export function LayoutView({
  node,
  path = "",
  panes,
  workspaces,
  agents,
  layoutId,
  pending,
  onConsume,
  onRatio,
  onTracks,
  onPanel,
  onCloseTab,
  onFocusPane,
  onOpenSpace,
  onBack,
  fromSpace,
  borrowed,
  origins,
  openMenuId = null,
  openMenuToken = 0,
  root,
}: Props) {
  const tree = root ?? node;
  const shared = {
    panes,
    workspaces,
    agents,
    layoutId,
    pending,
    onConsume,
    onRatio,
    onTracks,
    onPanel,
    onCloseTab,
    onFocusPane,
    onOpenSpace,
    borrowed,
    origins,
    openMenuId,
    openMenuToken,
    root: tree,
  };
  if (node.type === "split") {
    return (
      <div className={`split ${node.direction}`}>
        <div className="split-pane" style={paneStyle(node.ratio)}>
          <LayoutView {...shared} node={node.first} path={join(path, "first")} />
        </div>
        <div
          className={`gutter ${node.direction}`}
          role="separator"
          aria-label="Resize panels"
          aria-orientation={node.direction === "row" ? "vertical" : "horizontal"}
          onPointerDown={(event) => startSplitDrag(event, node.direction, node.ratio, (ratio) => onRatio(path, ratio))}
        />
        <div className="split-pane" style={paneStyle(1 - node.ratio)}>
          <LayoutView {...shared} node={node.second} path={join(path, "second")} />
        </div>
      </div>
    );
  }

  if (node.type === "grid") {
    return <GridView {...shared} node={node} path={path} />;
  }

  return (
    <PanelView
      {...shared}
      id={node.id}
      title={node.title}
      panel={node.panel}
      pending={pending[node.id] ?? []}
      onBack={onBack}
      fromSpace={fromSpace ?? origins?.[node.id]}
      borrowed={borrowed}
    />
  );
}

function GridView({
  node,
  path = "",
  panes,
  workspaces,
  agents,
  layoutId,
  pending,
  onConsume,
  onRatio,
  onTracks,
  onPanel,
  onCloseTab,
  onFocusPane,
  onOpenSpace,
  borrowed,
  origins,
  openMenuId = null,
  openMenuToken = 0,
  root,
}: Props & { node: GridNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const columnSum = node.columns.reduce((total, value) => total + value, 0);
  const rowSum = node.rows.reduce((total, value) => total + value, 0);
  const shared = {
    panes,
    workspaces,
    agents,
    layoutId,
    pending,
    onConsume,
    onRatio,
    onTracks,
    onPanel,
    onCloseTab,
    onFocusPane,
    onOpenSpace,
    borrowed,
    origins,
    openMenuId,
    openMenuToken,
    root,
  };
  return (
    <div
      className="grid"
      ref={ref}
      style={{
        gridTemplateColumns: node.columns.map((weight) => `${weight}fr`).join(" "),
        gridTemplateRows: node.rows.map((weight) => `${weight}fr`).join(" "),
      }}
    >
      {node.cells.map((cell) => (
        <div
          key={cell.id}
          style={{
            gridColumn: `${cell.column + 1} / span ${cell.colSpan || 1}`,
            gridRow: `${cell.row + 1} / span ${cell.rowSpan || 1}`,
            minWidth: 0,
            minHeight: 0,
          }}
        >
          <LayoutView {...shared} node={cellNode(cell)} path={join(path, `cell/${cell.id}`)} />
        </div>
      ))}
      {node.columns.slice(0, -1).map((_, index) => {
        const before = node.columns.slice(0, index + 1).reduce((total, value) => total + value, 0);
        return (
          <div
            key={`col-${index}`}
            className="grid-gutter vertical"
            role="separator"
            aria-label="Resize columns"
            aria-orientation="vertical"
            style={{ left: `calc(${(before / columnSum) * 100}% - 3px)` }}
            onPointerDown={(event) =>
              startTrackDrag(event, "row", ref.current, node.columns, index, (columns) =>
                onTracks(path, columns, node.rows),
              )
            }
          />
        );
      })}
      {node.rows.slice(0, -1).map((_, index) => {
        const before = node.rows.slice(0, index + 1).reduce((total, value) => total + value, 0);
        return (
          <div
            key={`row-${index}`}
            className="grid-gutter horizontal"
            role="separator"
            aria-label="Resize rows"
            aria-orientation="horizontal"
            style={{ top: `calc(${(before / rowSum) * 100}% - 3px)` }}
            onPointerDown={(event) =>
              startTrackDrag(event, "column", ref.current, node.rows, index, (rows) =>
                onTracks(path, node.columns, rows),
              )
            }
          />
        );
      })}
    </div>
  );
}

function PanelView(props: {
  id: string;
  title?: string | null;
  panel: PanelConfig;
  panes: PaneView[];
  workspaces: WorkspaceView[];
  agents: AgentView[];
  layoutId: string;
  pending: Attachment[];
  onConsume: (panelId: string) => void;
  onPanel: (id: string, panel: PanelConfig, retitle?: boolean) => void;
  onCloseTab: (id: string, tabId: string) => void;
  onFocusPane: (paneId: string) => void;
  onOpenSpace?: (workspaceId: string) => void;
  onBack?: () => void;
  fromSpace?: string;
  borrowed?: boolean;
  openMenuId?: string | null;
  openMenuToken?: number;
  root?: LayoutNode;
}) {
  const { id, title, panel, panes, workspaces, onPanel, onCloseTab, openMenuId, openMenuToken, root, onBack, fromSpace, borrowed } =
    props;
  const design = useDesign();
  const desk = useDesk();
  const panelActions = usePanelActions();
  const [opening, setOpening] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [pinTick, setPinTick] = useState(0);
  const selected = design.enabled && design.selectedId === id;
  const select = (event: React.MouseEvent<HTMLElement>) => {
    if (!design.enabled) return;
    const target = event.target as HTMLElement;
    if (target.closest("select, input, textarea, button, a")) return;
    design.selectPanel(id);
  };
  const content = activeContent(panel);
  const plugin = content.type === "plugin" ? desk.plugins.find((item) => item.id === content.plugin) : undefined;
  const addressBar = supportsAddressBar(content)
    ? hostAddressBarVisible(content, pluginAddressBar(plugin))
    : undefined;
  const canClose = !root || listPanels(root).length > 1;
  const blank = content.type === "blank";
  const allowPin = canPinPanel(content);
  void pinTick;
  const pinned = findPin(id);
  const activeSpace = workspaces.find((item) => item.focused) ?? workspaces[0];
  const menuPanes = panes.map((pane) => ({
    paneId: pane.paneId,
    label: pane.label || pane.title || pane.agentName || baseName(pane.cwd || "") || pane.paneId,
    cwd: pane.cwd,
    workspaceId: pane.workspaceId,
  }));
  const chrome = {
    className: selected ? "selected" : undefined,
    onClick: select,
    panelId: id,
    panelType: content.type,
    pluginId: content.type === "plugin" ? content.plugin : undefined,
    tabbed: panel.type === "tabs",
    tabEdge: panel.type === "tabs" ? panel.edge : undefined,
    addressBar,
    canClose,
    openMenuToken: openMenuId === id ? openMenuToken : undefined,
    onMenuDismiss: blank && canClose ? () => panelActions.close(id) : undefined,
    allowPin,
    pinLabel: pinned ? "Pinned…" : "Pin…",
    onPin: allowPin && !onBack && !borrowed ? () => setPinning(true) : undefined,
    onBack,
    fromSpace,
    borrowed,
    onAddressBar:
      addressBar === undefined
        ? undefined
        : (show: boolean) => {
            onPanel(id, setAddressBar(panel, show));
          },
    entries: menuFor(content, desk.plugins, {
      panes: menuPanes,
      workspaceId: activeSpace?.workspaceId ?? null,
    }),
    onView: (choice: string) => {
      if (choice === "open") {
        setOpening(true);
        return;
      }
      if (choice === "terminal" || choice === "pane:new") {
        const current = content.type === "herdr" ? content.paneId : null;
        const focused = panes.find((item) => item.focused) ?? panes[0];
        const source = current || focused?.paneId;
        if (!source) {
          onPanel(id, { type: "herdr", paneId: null });
          return;
        }
        const here = choice === "terminal" ? terminalHereCwd(content) : null;
        const cwd =
          here ||
          (choice === "terminal" ? activeSpace?.root || focused?.cwd || null : null);
        void openTerminalPane(source, cwd).then(
          (paneId) => onPanel(id, { type: "herdr", paneId }),
          () => onPanel(id, { type: "herdr", paneId: null }),
        );
        return;
      }
      const next = showViewer(panel, choice, desk.plugins, {
        workspaceRoot: workspaceDirectory(activeSpace, panes),
      });
      const retitle = choice === "spaces" || choice === "agents";
      onPanel(id, next, retitle);
    },
  };
  function applyPin(result: PinDialogResult) {
    setPinning(false);
    const spaceIds = workspaces.map((space) => space.workspaceId);
    if (result.action === "unpin-all") {
      if (root) {
        const next = unpinEverywhere(root, id);
        if (next !== root) panelActions.close(id);
      }
      setPinTick((tick) => tick + 1);
      return;
    }
    if (result.action === "unpin-space") {
      if (activeSpace?.workspaceId && root && unpinHere(root, id, activeSpace.workspaceId, spaceIds)) {
        panelActions.close(id);
      }
      setPinTick((tick) => tick + 1);
      return;
    }
    const pin = {
      id,
      title: title || heading(content),
      panel: content,
      mode: result.mode,
      spaces: result.spaces,
    };
    upsertPin(pin);
    if (activeSpace?.workspaceId && root && !pinApplies(pin, activeSpace.workspaceId)) {
      panelActions.close(id);
    }
    setPinTick((tick) => tick + 1);
  }
  if (panel.type === "tabs") {
    return (
      <>
        <PanelChrome {...chrome} title={title || "Tabs"} kind="Tabs" viewer={viewerName(content, plugin?.title)}>
          <TabGroup
            group={panel}
            onChange={(next) => onPanel(id, next)}
            onClose={(tabId) => onCloseTab(id, tabId)}
            renderContent={(tab, update) => (
              <Surface {...props} id={`${id}:${tab.id}`} panel={tab.panel} onPanel={(_id, next) => update(next)} />
            )}
          />
        </PanelChrome>
        <PinDialog
          open={pinning}
          panelTitle={title || "Tabs"}
          current={pinned}
          spaces={workspaces.map((space) => ({ id: space.workspaceId, name: space.label }))}
          activeSpaceId={activeSpace?.workspaceId ?? null}
          preferAllSpaces={content.type === "files" || content.type === "agents"}
          onClose={() => setPinning(false)}
          onApply={applyPin}
        />
      </>
    );
  }
  const panelTitle =
    (panel.type === "files" || panel.type === "agents") && (!title || title === "Panel")
      ? heading(panel)
      : title || heading(panel);
  return (
    <>
      <PanelChrome
        {...chrome}
        title={panelTitle}
        kind={kindOf(panel)}
        viewer={viewerName(content, plugin?.title)}
        subtitle={panel.type === "herdr" ? herdrSubtitle(props) : undefined}
        badge={panel.type === "herdr" ? badgeText(herdrPane(props)) : undefined}
        badgeClass={panel.type === "herdr" ? badgeClass(herdrPane(props)) : undefined}
      >
        <Surface {...props} />
      </PanelChrome>
      {opening ? (
        <OpenAddressDialog
          onCancel={() => setOpening(false)}
          onOpen={(address) => {
            setOpening(false);
            const retitle = isDefaultPanelTitle(title);
            void api.resolve(address).then(
              (resolved) =>
                onPanel(id, carryRaw(panel, carryAddressBar(panel, resolved)), retitle),
              () => onPanel(id, { type: "iframe", url: address, proxy: false }, retitle),
            );
          }}
        />
      ) : null}
      <PinDialog
        open={pinning}
        panelTitle={panelTitle}
        current={pinned}
        spaces={workspaces.map((space) => ({ id: space.workspaceId, name: space.label }))}
        activeSpaceId={activeSpace?.workspaceId ?? null}
        preferAllSpaces={content.type === "files" || content.type === "agents"}
        onClose={() => setPinning(false)}
        onApply={applyPin}
      />
    </>
  );
}

function Surface({
  id,
  title,
  panel,
  panes,
  workspaces,
  agents,
  layoutId,
  pending,
  onConsume,
  onPanel,
  onFocusPane,
  onOpenSpace,
}: {
  id: string;
  title?: string | null;
  panel: PanelConfig;
  panes: PaneView[];
  workspaces: WorkspaceView[];
  agents: AgentView[];
  layoutId: string;
  pending: Attachment[];
  onConsume: (panelId: string) => void;
  onPanel: (id: string, panel: PanelConfig, retitle?: boolean) => void;
  onFocusPane: (paneId: string) => void;
  onOpenSpace?: (workspaceId: string) => void;
}) {
  const design = useDesign();
  if (panel.type === "tabs") {
    return <div className="empty">Tab groups cannot be nested.</div>;
  }
  if (panel.type === "herdr") {
    return (
      <div className="fill">
        <SpaceMirror panes={panes} workspaces={workspaces} onFocusPane={onFocusPane} />
        {design.enabled ? <button type="button" className="design-shield" onClick={() => design.selectPanel(id)} /> : null}
      </div>
    );
  }
  if (panel.type === "markdown" || panel.type === "iframe" || panel.type === "html" || panel.type === "file" || panel.type === "explorer" || panel.type === "plugin") {
    return (
      <DocumentSurface
        id={id}
        title={title}
        panel={panel}
        panes={panes}
        workspaces={workspaces}
        onPanel={onPanel}
      />
    );
  }
  if (panel.type === "files") {
    return (
      <FilesView
        workspaces={workspaces}
        panes={panes}
        onOpen={(workspaceId) => {
          if (onOpenSpace) {
            onOpenSpace(workspaceId);
            return;
          }
          void api.focus({ workspaceId });
        }}
      />
    );
  }
  if (panel.type === "agents") {
    return <AgentsView agents={agents} panes={panes} workspaces={workspaces} onFocus={onFocusPane} />;
  }
  if (panel.type === "blank") {
    return <div className="empty">Open a file, URL, or desk tool.</div>;
  }
  if (panel.type === "chat") {
    return (
      <ChatView
        layoutId={layoutId}
        panelId={id}
        paneId={panel.paneId}
        pending={pending}
        onConsume={onConsume}
        panes={panes}
        workspaces={workspaces}
        onPane={(paneId) => onPanel(id, { ...panel, paneId })}
      />
    );
  }
  return <div className="empty">Unknown panel.</div>;
}

function DocumentSurface({
  id,
  title,
  panel,
  panes,
  workspaces,
  onPanel,
}: {
  id: string;
  title?: string | null;
  panel: PanelConfig;
  panes: PaneView[];
  workspaces: WorkspaceView[];
  onPanel: (id: string, panel: PanelConfig, retitle?: boolean) => void;
}) {
  const design = useDesign();
  const plugins = useDesk().plugins;
  const pluginId = panel.type === "plugin" ? panel.plugin : "";
  const bar = pluginAddressBar(plugins.find((item) => item.id === pluginId));
  const [pluginAddress, setPluginAddress] = useState<{ id: string; value: string } | null>(null);
  const commandId = useRef(0);
  const [command, setCommand] = useState<PluginHostCommand | null>(null);
  const pick = (tag: string, text: string) => design.selectElement({ panelId: id, tag, text });
  const open = (next: PanelConfig) => onPanel(id, carryRaw(panel, carryAddressBar(panel, next)));
  const space = workspaces.find((item) => item.focused) ?? workspaces[0];
  const workspaceRoot = workspaceDirectory(space, panes);
  const climbed = panel.type === "explorer" ? climbExplorer(panel) : null;
  const shown = hostAddressBarVisible(panel, bar);
  const override = pluginAddress?.id === pluginId ? pluginAddress.value : null;
  const address = panel.type === "plugin" && override !== null ? override : addressOf(panel);
  const modify = panel.type === "plugin" && bar.modify;
  const liveCommand = command && command.pluginId === pluginId ? command : null;

  function enter(next: string) {
    void api.resolve(next).then(
      (resolved) => {
        if (panel.type !== "explorer") {
          open(resolved);
          return;
        }
        const stayed = keepExplorer(panel, resolved, workspaceRoot);
        if (stayed) onPanel(id, stayed);
        else open(resolved);
      },
      () => {
        if (panel.type !== "explorer") return;
        onPanel(id, keepExplorerAddress(panel, next, workspaceRoot, "directory"));
      },
    );
  }

  function navigatePlugin(value: string) {
    setPluginAddress({ id: pluginId, value });
    commandId.current += 1;
    setCommand({ id: commandId.current, pluginId, type: "address-navigate", value });
  }

  function reloadPlugin() {
    commandId.current += 1;
    setCommand({ id: commandId.current, pluginId, type: "address-reload" });
  }

  return (
    <DocumentFrame
      historyKey={id}
      address={address}
      onOpen={open}
      visible={shown}
      canUp={climbed !== null}
      onUp={
        climbed
          ? () => {
              onPanel(id, climbed);
            }
          : undefined
      }
      onPluginNavigate={modify ? navigatePlugin : undefined}
      onPluginReload={modify ? reloadPlugin : undefined}
    >
      {panel.type === "markdown" && !showsRawText(panel) ? (
        <MarkdownView path={panel.path} design={design.enabled} onPick={({ tag, text }) => pick(tag, text)} />
      ) : null}
      {panel.type === "iframe" ? (
        panel.url ? (
          <IframeView
            url={panel.url}
            proxy={panel.proxy}
            title={title || "Browser"}
            panelId={id}
            suspended={design.enabled}
          />
        ) : (
          <div className="empty">Enter a URL, a file, or plugin:id.</div>
        )
      ) : null}
      {panel.type === "html" && !showsRawText(panel) ? (
        <HtmlView
          path={panel.path}
          inline={panel.inline}
          title={title || "Browser"}
          control={panel.control}
          design={design.enabled}
          onPick={({ tag, text }) => pick(tag, text)}
        />
      ) : null}
      {showsRawText(panel) && (panel.type === "markdown" || panel.type === "html" || panel.type === "file") ? (
        panel.type === "html" && !panel.path ? (
          <TextView text={panel.inline ?? ""} />
        ) : (
          <TextView path={panel.type === "html" ? panel.path ?? "" : panel.path} />
        )
      ) : null}
      {panel.type === "explorer" ? (
        <ExplorerView
          panelId={id}
          path={explorerRootFor(panel.focus || panel.path, workspaceRoot)}
          focus={panel.focus}
          highlight={panel.focus || panel.path}
          roots={folderRoots(workspaces, panes)}
          showAddress={false}
          onEnter={enter}
          onOpenFile={(target) => api.open(openFileBeside(id, target))}
        />
      ) : null}
      {panel.type === "plugin" ? (
        <PluginView
          pluginId={panel.plugin}
          panelId={id}
          title={title || panel.plugin}
          modify={bar.modify}
          command={liveCommand}
          open={pluginOpenMessage(panel)}
          onAddress={(value) => {
            setPluginAddress({ id: panel.plugin, value });
            if (panel.type !== "plugin") return;
            const current = panel;
            void api.resolve(value).then((resolved) => {
              const next = adoptPluginAddress(current, resolved);
              if (!next) return;
              onPanel(id, next);
            }, () => undefined);
          }}
          onConfig={(value) => {
            if (panel.type !== "plugin") return;
            onPanel(id, { ...panel, config: value });
          }}
          onBar={(next) => {
            const show = next.show && !next.replace;
            onPanel(id, setAddressBar(panel, show));
          }}
        />
      ) : null}
      {design.enabled && panel.type === "iframe" ? (
        <button type="button" className="design-shield" onClick={() => design.selectPanel(id)} />
      ) : null}
    </DocumentFrame>
  );
}

function activeContent(panel: PanelConfig): PanelConfig {
  if (panel.type !== "tabs") return panel;
  return panel.tabs.find((tab) => tab.id === panel.active)?.panel ?? panel.tabs[0]?.panel ?? panel;
}

function heading(panel: PanelConfig): string {
  switch (panel.type) {
    case "herdr":
      return "Terminal";
    case "markdown":
      return "Notes";
    case "iframe":
    case "html":
      return "Browser";
    case "plugin":
      return "Plugin";
    case "explorer":
      return "Files";
    case "file":
      return "File";
    case "tabs":
      return "Tabs";
    case "files":
      return "Spaces";
    case "agents":
      return "Agents";
    case "chat":
      return "Chat";
    case "blank":
      return "";
    default:
      return "Panel";
  }
}

function kindOf(panel: PanelConfig): string {
  if (panel.type === "html") return "Browser";
  return heading(panel);
}

function keepExplorer(
  current: Extract<PanelConfig, { type: "explorer" }>,
  resolved: PanelConfig,
  workspaceRoot: string | null,
): PanelConfig | null {
  if (resolved.type === "explorer") return keepExplorerAddress(current, resolved.path, workspaceRoot, "directory");
  if (resolved.type === "markdown" || resolved.type === "file") {
    return keepExplorerAddress(current, resolved.path, workspaceRoot, "file");
  }
  if (resolved.type === "html" && resolved.path) {
    return keepExplorerAddress(current, resolved.path, workspaceRoot, "file");
  }
  return null;
}

function keepExplorerAddress(
  current: Extract<PanelConfig, { type: "explorer" }>,
  address: string,
  workspaceRoot: string | null,
  kind: "file" | "directory",
): Extract<PanelConfig, { type: "explorer" }> {
  const located = resolveWorkspacePath(address, workspaceRoot);
  const next: Extract<PanelConfig, { type: "explorer" }> =
    kind === "file"
      ? { type: "explorer", path: explorerRootFor(located, workspaceRoot), focus: located }
      : { type: "explorer", path: located };
  if (typeof current.addressBar === "boolean") next.addressBar = current.addressBar;
  return next;
}

function herdrPane(props: { panel: PanelConfig; panes: PaneView[]; workspaces: WorkspaceView[] }): PaneView | undefined {
  const panel = props.panel;
  if (panel.type !== "herdr") return undefined;
  const space = props.workspaces.find((item) => item.focused) ?? props.workspaces[0];
  return (
    props.panes.find((item) => item.paneId === panel.paneId) ??
    props.panes.find((item) => item.focused) ??
    props.panes.find((item) => item.workspaceId === space?.workspaceId)
  );
}

function herdrSubtitle(props: { panel: PanelConfig; panes: PaneView[]; workspaces: WorkspaceView[] }): string | undefined {
  const space = props.workspaces.find((item) => item.focused) ?? props.workspaces[0];
  return space?.label;
}

function folderRoots(workspaces: WorkspaceView[], panes: PaneView[]) {
  const roots: { path: string; label: string }[] = [];
  for (const workspace of workspaces) {
    if (workspace.root) roots.push({ path: workspace.root, label: workspace.label });
  }
  for (const pane of panes) {
    if (!pane.cwd) continue;
    if (roots.some((root) => sameFolder(root.path, pane.cwd!) || sameFolder(pane.cwd!, root.path))) continue;
    roots.push({ path: pane.cwd, label: baseName(pane.cwd) || pane.cwd });
  }
  return roots;
}

function sameFolder(path: string, root: string) {
  return samePath(path, root);
}

function badgeText(pane: PaneView | undefined): string {
  if (!pane) return "unbound";
  const name = pane.agentName || pane.agent;
  if (!name && pane.agentStatus === "unknown") return "shell";
  if (name) return `${name} · ${pane.agentStatus}`;
  return pane.agentStatus;
}

function badgeClass(pane: PaneView | undefined): string {
  if (!pane) return "badge-unknown";
  if (!pane.agent && !pane.agentName && pane.agentStatus === "unknown") return "badge-shell";
  return `badge-${pane.agentStatus}`;
}

function capturePointer(event: React.PointerEvent<HTMLDivElement>) {
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch {
    // Capture needs an active pointer. Window listeners still track the drag.
  }
}

function paneStyle(share: number): { flex: number } {
  return { flex: share };
}

function join(path: string, side: string): string {
  return path ? `${path}/${side}` : side;
}

function startSplitDrag(
  event: React.PointerEvent<HTMLDivElement>,
  direction: "row" | "column",
  startRatio: number,
  commit: (ratio: number) => void,
) {
  event.preventDefault();
  const parent = event.currentTarget.parentElement;
  if (!parent) return;
  const bounds = parent.getBoundingClientRect();
  const start = direction === "row" ? event.clientX : event.clientY;
  const size = direction === "row" ? bounds.width : bounds.height;
  capturePointer(event);
  const move = (ev: PointerEvent) => {
    const point = direction === "row" ? ev.clientX : ev.clientY;
    commit(startRatio + (point - start) / size);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function startTrackDrag(
  event: React.PointerEvent<HTMLDivElement>,
  axis: "row" | "column",
  grid: HTMLDivElement | null,
  tracks: number[],
  index: number,
  commit: (tracks: number[]) => void,
) {
  if (!grid) return;
  event.preventDefault();
  capturePointer(event);
  const bounds = grid.getBoundingClientRect();
  const start = axis === "row" ? event.clientX : event.clientY;
  const size = axis === "row" ? bounds.width : bounds.height;
  const startTracks = [...tracks];
  const sum = startTracks.reduce((total, value) => total + value, 0);
  const pair = startTracks[index] + startTracks[index + 1];
  const move = (ev: PointerEvent) => {
    const point = axis === "row" ? ev.clientX : ev.clientY;
    const delta = ((point - start) / size) * sum;
    let left = startTracks[index] + delta;
    let right = pair - left;
    const min = 0.2;
    if (left < min) {
      left = min;
      right = pair - min;
    }
    if (right < min) {
      right = min;
      left = pair - min;
    }
    const next = [...startTracks];
    next[index] = left;
    next[index + 1] = right;
    commit(next);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
