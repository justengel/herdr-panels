export interface Settings {
  activeLayout: string;
  contentRoots: string[];
}

export interface LayoutSummary {
  id: string;
  title: string;
  description?: string | null;
}

export interface LayoutDocument {
  id: string;
  title: string;
  description?: string | null;
  root: LayoutNode;
}

export type LayoutNode = SplitNode | GridNode | PanelNode;

export interface SplitNode {
  type: "split";
  direction: "row" | "column";
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
}

export interface GridNode {
  type: "grid";
  columns: number[];
  rows: number[];
  cells: GridCell[];
}

export interface GridCell {
  id: string;
  title?: string | null;
  column: number;
  row: number;
  colSpan: number;
  rowSpan: number;
  panel?: PanelConfig;
  node?: LayoutNode;
}

export interface PanelNode {
  type: "panel";
  id: string;
  title?: string | null;
  panel: PanelConfig;
  collapsed?: boolean;
}

export type PanelConfig =
  | HerdrPanel
  | MarkdownPanel
  | IframePanel
  | HtmlPanel
  | PluginPanel
  | FilesPanel
  | AgentsPanel
  | ExplorerPanel
  | FilePanel
  | TabsPanel
  | ChatPanel;

export interface HerdrPanel {
  type: "herdr";
  paneId?: string | null;
  source?: "visible" | "recent" | null;
  lines?: number | null;
}

export interface MarkdownPanel {
  type: "markdown";
  path: string;
}

export interface IframePanel {
  type: "iframe";
  url: string;
  proxy?: boolean;
}

export interface HtmlPanel {
  type: "html";
  path?: string | null;
  inline?: string | null;
  control?: boolean;
}

export interface PluginPanel {
  type: "plugin";
  plugin: string;
  config?: Record<string, unknown>;
}

export interface FilesPanel {
  type: "files";
}

export interface AgentsPanel {
  type: "agents";
}

export interface ExplorerPanel {
  type: "explorer";
  path: string;
}

export interface FilePanel {
  type: "file";
  path: string;
}

export type TabEdge = "top" | "bottom" | "left" | "right";

export interface PanelTab {
  id: string;
  title: string;
  icon?: string | null;
  panel: PanelConfig;
}

export interface TabsPanel {
  type: "tabs";
  edge: TabEdge;
  active: string;
  tabs: PanelTab[];
}

export interface ChatPanel {
  type: "chat";
  paneId?: string | null;
}

export interface WorkspaceView {
  workspaceId: string;
  label: string;
  focused: boolean;
  root?: string | null;
  branch?: string | null;
  dirty?: boolean;
}

export interface TabView {
  tabId: string;
  workspaceId: string;
  label: string;
  focused: boolean;
}

export interface PaneView {
  paneId: string;
  workspaceId: string;
  tabId: string;
  label?: string | null;
  title?: string | null;
  cwd?: string | null;
  agentStatus: string;
  agent?: string | null;
  agentName?: string | null;
  focused: boolean;
  x?: number | null;
  y?: number | null;
  cols?: number | null;
  rows?: number | null;
}

export interface AgentView {
  paneId: string;
  name?: string | null;
  agent?: string | null;
  agentStatus: string;
  title?: string | null;
}

export interface RuntimeSnapshot {
  connected: boolean;
  error?: string | null;
  version?: string | null;
  protocol?: number | null;
  socket: string;
  session?: string;
  focusedPaneId?: string | null;
  focusedTabId?: string | null;
  focusedWorkspaceId?: string | null;
  workspaces: WorkspaceView[];
  tabs?: TabView[];
  panes: PaneView[];
  agents: AgentView[];
}

export interface Attachment {
  panelId: string;
  kind: string;
  title: string;
  summary: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  attachments: Attachment[];
  at: string;
}

export interface Bootstrap {
  configDir: string;
  settings: Settings;
  layouts: LayoutSummary[];
  layout: LayoutDocument;
  runtime: RuntimeSnapshot;
}
