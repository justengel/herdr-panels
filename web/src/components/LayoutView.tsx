import { useRef } from "react";
import type { AgentView, Attachment, GridNode, LayoutNode, PaneView, PanelConfig, WorkspaceView } from "../types";
import { api } from "../api";
import { baseName, samePath } from "../paths";
import { cellNode } from "../layoutEdit";
import { useDesign } from "../design";
import { PanelChrome } from "./PanelChrome";
import { addressOf, DocumentFrame } from "./LocationBar";
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
  onPanel: (id: string, panel: PanelConfig) => void;
  onCloseTab: (id: string, tabId: string) => void;
  onFocusPane: (paneId: string) => void;
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
}: Props) {
  if (node.type === "split") {
    return (
      <div className={`split ${node.direction}`}>
        <div className="split-pane" style={paneStyle(node.ratio)}>
          <LayoutView
            node={node.first}
            path={join(path, "first")}
            panes={panes}
            workspaces={workspaces}
            agents={agents}
            layoutId={layoutId}
            pending={pending}
            onConsume={onConsume}
            onRatio={onRatio}
            onTracks={onTracks}
            onPanel={onPanel}
            onCloseTab={onCloseTab}
            onFocusPane={onFocusPane}
          />
        </div>
        <div
          className={`gutter ${node.direction}`}
          role="separator"
          aria-label="Resize panels"
          aria-orientation={node.direction === "row" ? "vertical" : "horizontal"}
          onPointerDown={(event) => startSplitDrag(event, node.direction, node.ratio, (ratio) => onRatio(path, ratio))}
        />
        <div className="split-pane" style={paneStyle(1 - node.ratio)}>
          <LayoutView
            node={node.second}
            path={join(path, "second")}
            panes={panes}
            workspaces={workspaces}
            agents={agents}
            layoutId={layoutId}
            pending={pending}
            onConsume={onConsume}
            onRatio={onRatio}
            onTracks={onTracks}
            onPanel={onPanel}
            onCloseTab={onCloseTab}
            onFocusPane={onFocusPane}
          />
        </div>
      </div>
    );
  }

  if (node.type === "grid") {
    return (
      <GridView
        node={node}
        path={path}
        panes={panes}
        workspaces={workspaces}
        agents={agents}
        layoutId={layoutId}
        pending={pending}
        onConsume={onConsume}
        onRatio={onRatio}
      onTracks={onTracks}
      onPanel={onPanel}
      onCloseTab={onCloseTab}
      onFocusPane={onFocusPane}
    />
  );
}

  return (
    <PanelView
      id={node.id}
      title={node.title}
      panel={node.panel}
      panes={panes}
      workspaces={workspaces}
      agents={agents}
      layoutId={layoutId}
      pending={pending[node.id] ?? []}
      onConsume={onConsume}
      onPanel={onPanel}
      onCloseTab={onCloseTab}
      onFocusPane={onFocusPane}
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
}: Props & { node: GridNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const columnSum = node.columns.reduce((total, value) => total + value, 0);
  const rowSum = node.rows.reduce((total, value) => total + value, 0);
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
          <LayoutView
            node={cellNode(cell)}
            path={join(path, `cell/${cell.id}`)}
            panes={panes}
            workspaces={workspaces}
            agents={agents}
            layoutId={layoutId}
            pending={pending}
            onConsume={onConsume}
            onRatio={onRatio}
            onTracks={onTracks}
            onPanel={onPanel}
            onCloseTab={onCloseTab}
            onFocusPane={onFocusPane}
          />
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
  onPanel: (id: string, panel: PanelConfig) => void;
  onCloseTab: (id: string, tabId: string) => void;
  onFocusPane: (paneId: string) => void;
}) {
  const { id, title, panel, onPanel, onCloseTab } = props;
  const design = useDesign();
  const selected = design.enabled && design.selectedId === id;
  const select = (event: React.MouseEvent<HTMLElement>) => {
    if (!design.enabled) return;
    const target = event.target as HTMLElement;
    if (target.closest("select, input, textarea, button, a")) return;
    design.selectPanel(id);
  };
  const content = activeContent(panel);
  const chrome = {
    className: selected ? "selected" : undefined,
    onClick: select,
    panelId: id,
    panelType: content.type,
    pluginId: content.type === "plugin" ? content.plugin : undefined,
    tabbed: panel.type === "tabs",
    tabEdge: panel.type === "tabs" ? panel.edge : undefined,
  };
  if (panel.type === "tabs") {
    return (
      <PanelChrome
        {...chrome}
        title={title || "Tabs"}
        kind="Tabs"
      >
        <TabGroup
          group={panel}
          onChange={(next) => onPanel(id, next)}
          onClose={(tabId) => onCloseTab(id, tabId)}
          renderContent={(tab, update) => (
            <Surface {...props} id={`${id}:${tab.id}`} panel={tab.panel} onPanel={(_id, next) => update(next)} />
          )}
        />
      </PanelChrome>
    );
  }
  const plain = panel.type === "files" || panel.type === "agents";
  return (
    <PanelChrome
      {...chrome}
      plain={plain}
      title={plain ? (panel.type === "agents" ? "agents" : "spaces") : title || heading(panel)}
      kind={kindOf(panel)}
      subtitle={panel.type === "herdr" ? herdrSubtitle(props) : undefined}
      badge={panel.type === "herdr" ? badgeText(herdrPane(props)) : undefined}
      badgeClass={panel.type === "herdr" ? badgeClass(herdrPane(props)) : undefined}
    >
      <Surface {...props} />
    </PanelChrome>
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
  onPanel: (id: string, panel: PanelConfig) => void;
  onFocusPane: (paneId: string) => void;
}) {
  const design = useDesign();
  const pick = (tag: string, text: string) => design.selectElement({ panelId: id, tag, text });
  const open = (next: PanelConfig) => onPanel(id, next);
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
      <DocumentFrame historyKey={id} address={addressOf(panel)} onOpen={open}>
        {panel.type === "markdown" ? (
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
        {panel.type === "html" ? (
          <HtmlView
            path={panel.path}
            inline={panel.inline}
            title={title || "Browser"}
            design={design.enabled}
            onPick={({ tag, text }) => pick(tag, text)}
          />
        ) : null}
        {panel.type === "file" ? <TextView path={panel.path} /> : null}
        {panel.type === "explorer" ? (
          <ExplorerView
            path={panel.path}
            roots={folderRoots(workspaces, panes)}
            showAddress={false}
            onEnter={(next) => {
              void api.resolve(next).then(open, () => onPanel(id, { ...panel, path: next }));
            }}
            onOpenFile={(target) => api.resolve(target).then(open)}
          />
        ) : null}
        {panel.type === "plugin" ? (
          <iframe className="frame" title={title || panel.plugin} src={`/plugins/${encodeURIComponent(panel.plugin)}`} />
        ) : null}
        {design.enabled && panel.type === "iframe" ? (
          <button type="button" className="design-shield" onClick={() => design.selectPanel(id)} />
        ) : null}
      </DocumentFrame>
    );
  }
  if (panel.type === "files") {
    return (
      <FilesView
        workspaces={workspaces}
        panes={panes}
        onOpen={(workspaceId) => {
          const inSpace = panes.filter((pane) => pane.workspaceId === workspaceId);
          const pane = inSpace.find((item) => item.focused) ?? inSpace[0];
          if (pane) onFocusPane(pane.paneId);
          else void api.focus({ workspaceId });
        }}
      />
    );
  }
  if (panel.type === "agents") {
    return <AgentsView agents={agents} panes={panes} workspaces={workspaces} onFocus={onFocusPane} />;
  }
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
      return "spaces";
    case "agents":
      return "agents";
    case "chat":
      return "Chat";
    default:
      return "Panel";
  }
}

function kindOf(panel: PanelConfig): string {
  if (panel.type === "html") return "Browser";
  return heading(panel);
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
