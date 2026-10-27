import type { Attachment, LayoutDocument, PaneView, PanelConfig, WorkspaceView } from "../types";
import { findPanel, listPanels, panelKind, panelSummary } from "../layoutEdit";

interface Props {
  layout: LayoutDocument;
  panes: PaneView[];
  workspaces: WorkspaceView[];
  selectedId: string | null;
  element: { panelId: string; tag: string; text: string } | null;
  zoomedId: string | null;
  chatTarget: string;
  splitHerdr: boolean;
  onSplitHerdr: (value: boolean) => void;
  onChatTarget: (id: string) => void;
  onType: (id: string, type: PanelConfig["type"]) => void;
  onTitle: (id: string, title: string) => void;
  onConfig: (id: string, panel: PanelConfig) => void;
  onSplit: (id: string, direction: "row" | "column") => void;
  onClose: (id: string) => void;
  onZoom: (id: string | null) => void;
  onAdd: (chatId: string, attachment: Attachment) => void;
  onOpenChat: (id: string, attachment: Attachment) => void;
}

export function DesignBar(props: Props) {
  const panel = props.selectedId ? findPanel(props.layout.root, props.selectedId) : null;
  const chats = listPanels(props.layout.root).filter((item) => item.panel.type === "chat");
  const selection = attachmentFor(props, panel);
  const herdrPane = panel?.panel.type === "herdr" ? panel.panel.paneId : null;

  return (
    <aside className="design-bar" aria-label="Design">
      {!panel || !selection ? (
        <p className="design-hint">Select a panel. In notes and HTML views, select a heading or another element.</p>
      ) : (
        <>
          <div className="design-select">
            <strong>{selection.title}</strong>
            <span>{selection.summary}</span>
          </div>
          <label>
            Title
            <input
              aria-label="Panel title"
              value={panel.title ?? ""}
              onChange={(event) => props.onTitle(panel.id, event.target.value)}
            />
          </label>
          <label>
            Type
            <select
              aria-label="Panel type"
              value={shownType(panel.panel)}
              onChange={(event) => props.onType(panel.id, event.target.value as PanelConfig["type"])}
            >
              <option value="herdr">Terminal</option>
              <option value="iframe">Browser</option>
              <option value="markdown">Markdown</option>
              <option value="html">HTML</option>
              <option value="plugin">Plugin</option>
              <option value="files">Spaces</option>
              <option value="agents">Agents</option>
              <option value="explorer">Files</option>
              <option value="file">File</option>
            </select>
          </label>
          <ConfigFields panelId={panel.id} panel={shownConfig(panel.panel)} panes={props.panes} workspaces={props.workspaces} onConfig={props.onConfig} />
          <div className="design-actions">
            <button type="button" onClick={() => props.onSplit(panel.id, "row")}>
              Split right
            </button>
            <button type="button" onClick={() => props.onSplit(panel.id, "column")}>
              Split down
            </button>
            <button type="button" onClick={() => props.onClose(panel.id)}>
              Close
            </button>
            <button type="button" onClick={() => props.onZoom(props.zoomedId === panel.id ? null : panel.id)}>
              {props.zoomedId === panel.id ? "Show the desk" : "Fill screen"}
            </button>
            {herdrPane ? (
              <label className="check">
                <input
                  type="checkbox"
                  checked={props.splitHerdr}
                  onChange={(event) => props.onSplitHerdr(event.target.checked)}
                />
                Split the Herdr pane too
              </label>
            ) : null}
            {chats.length > 0 ? (
              <label>
                Add to
                <select aria-label="Chat target" value={props.chatTarget} onChange={(event) => props.onChatTarget(event.target.value)}>
                  {chats.map((chat) => (
                    <option key={chat.id} value={chat.id}>
                      {chat.title || "Chat"}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {chats.length > 0 ? (
              <button
                type="button"
                className="primary"
                onClick={() => {
                  const target = chats.some((chat) => chat.id === props.chatTarget) ? props.chatTarget : chats[0].id;
                  props.onAdd(target, selection);
                }}
              >
                Add to chat
              </button>
            ) : null}
          </div>
        </>
      )}
    </aside>
  );
}

function ConfigFields({
  panelId,
  panel,
  panes,
  workspaces,
  onConfig,
}: {
  panelId: string;
  panel: PanelConfig;
  panes: PaneView[];
  workspaces: WorkspaceView[];
  onConfig: (id: string, panel: PanelConfig) => void;
}) {
  if (panel.type === "herdr" || panel.type === "chat") {
    return (
      <label>
        Pane
        <select
          aria-label="Linked pane"
          value={panel.paneId ?? ""}
          onChange={(event) => onConfig(panelId, { ...panel, paneId: event.target.value || null })}
        >
          <option value="">{panel.type === "chat" ? "Keep local" : "Select pane"}</option>
          {paneOptions(panes, workspaces)}
        </select>
      </label>
    );
  }
  if (panel.type === "plugin") {
    return (
      <label>
        Plugin
        <input
          aria-label="Plugin id"
          value={panel.plugin}
          onChange={(event) => onConfig(panelId, { type: "plugin", plugin: event.target.value })}
        />
      </label>
    );
  }
  if (panel.type === "files" || panel.type === "agents" || panel.type === "tabs") return null;
  if (panel.type === "explorer" || panel.type === "file") {
    return (
      <label>
        {panel.type === "explorer" ? "Folder" : "File"}
        <input
          aria-label={panel.type === "explorer" ? "Folder" : "File"}
          value={panel.path}
          onChange={(event) => onConfig(panelId, { ...panel, path: event.target.value })}
        />
      </label>
    );
  }
  if (panel.type === "markdown") {
    return (
      <label>
        File
        <input
          aria-label="Markdown path"
          value={panel.path}
          onChange={(event) => onConfig(panelId, { ...panel, path: event.target.value })}
        />
      </label>
    );
  }
  if (panel.type === "iframe") {
    return (
      <label>
        URL
        <input
          aria-label="Browser URL"
          value={panel.url}
          onChange={(event) => onConfig(panelId, { ...panel, url: event.target.value })}
        />
      </label>
    );
  }
  if (panel.type === "blank") return null;
  if (panel.type !== "html") return null;
  return (
    <>
      <label>
        HTML file
        <input
          aria-label="HTML path"
          value={panel.path ?? ""}
          placeholder="panels/session-board.html"
          onChange={(event) => onConfig(panelId, { ...panel, path: event.target.value, inline: null })}
        />
      </label>
      <label>
        <input
          type="checkbox"
          aria-label="Allow typing into Herdr"
          checked={Boolean(panel.control)}
          onChange={(event) => onConfig(panelId, { ...panel, control: event.target.checked })}
        />
        Allow this panel to type into Herdr
      </label>
    </>
  );
}

function shownConfig(panel: PanelConfig): PanelConfig {
  if (panel.type !== "tabs") return panel;
  return panel.tabs.find((tab) => tab.id === panel.active)?.panel ?? panel.tabs[0]?.panel ?? panel;
}

function shownType(panel: PanelConfig): PanelConfig["type"] {
  const shown = shownConfig(panel);
  return shown.type === "html" ? "iframe" : shown.type;
}

function paneOptions(panes: PaneView[], workspaces: WorkspaceView[]) {
  return workspaces.map((workspace) => (
    <optgroup key={workspace.workspaceId} label={workspace.label}>
      {panes
        .filter((pane) => pane.workspaceId === workspace.workspaceId)
        .map((pane) => (
          <option key={pane.paneId} value={pane.paneId}>
            {pane.paneId}
          </option>
        ))}
    </optgroup>
  ));
}

function attachmentFor(props: Props, panel: ReturnType<typeof findPanel>): Attachment | null {
  if (!panel) return null;
  if (props.element && props.element.panelId === panel.id && props.element.text) {
    return {
      panelId: panel.id,
      kind: props.element.tag,
      title: panel.title || panelKind(panel.panel),
      summary: `${props.element.tag}: ${props.element.text}`.slice(0, 500),
    };
  }
  return {
    panelId: panel.id,
    kind: panel.panel.type,
    title: panel.title || panelKind(panel.panel),
    summary: panelSummary(panel).slice(0, 500),
  };
}
