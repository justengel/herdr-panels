import { useEffect, useState } from "react";
import { api } from "../../api";
import type { Attachment, ChatMessage, PaneView, WorkspaceView } from "../../types";

interface Props {
  layoutId: string;
  panelId: string;
  paneId?: string | null;
  pending: Attachment[];
  onConsume: (panelId: string) => void;
  panes: PaneView[];
  workspaces: WorkspaceView[];
  onPane: (paneId: string | null) => void;
}

export function ChatView({ layoutId, panelId, paneId, pending, onConsume, panes, workspaces, onPane }: Props) {
  const chatKey = `${layoutId}..${panelId}`;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chips, setChips] = useState<Attachment[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    api
      .loadChat(chatKey)
      .then((transcript) => {
        if (!stopped) setMessages(transcript.messages);
      })
      .catch((err: unknown) => {
        if (!stopped) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      stopped = true;
    };
  }, [chatKey]);

  useEffect(() => {
    const onChat = (event: Event) => {
      const detail = (event as CustomEvent<{ panelId?: string }>).detail;
      if (detail?.panelId && detail.panelId !== panelId) return;
      api
        .loadChat(chatKey)
        .then((transcript) => setMessages(transcript.messages))
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    };
    window.addEventListener("hwp-chat", onChat);
    return () => window.removeEventListener("hwp-chat", onChat);
  }, [chatKey, panelId]);

  useEffect(() => {
    if (pending.length === 0) return;
    setChips((current) => [...current, ...pending].slice(-12));
    onConsume(panelId);
  }, [pending, panelId, onConsume]);

  async function send() {
    const body = text.trim();
    if (!body && chips.length === 0) return;
    const message: ChatMessage = {
      id: `m-${Date.now().toString(36)}`,
      role: "user",
      text: body,
      attachments: chips,
      at: new Date().toISOString(),
    };
    const next = [...messages, message].slice(-200);
    setMessages(next);
    setText("");
    setChips([]);
    setError(null);
    try {
      await api.saveChat(chatKey, next);
      if (paneId) {
        await api.sendInput({ paneId, text: formatForPane(message), keys: ["enter"] });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="chat">
      <div className="chat-log">
        {messages.length === 0 ? (
          <p className="chat-empty">
            Select a panel or a component in Design mode and add it here. Link a Herdr pane when this chat should type
            into a terminal.
          </p>
        ) : (
          messages.map((message) => (
            <article key={message.id} className={`chat-message ${message.role}`}>
              {message.attachments.length > 0 ? (
                <div className="chips">
                  {message.attachments.map((item, index) => (
                    <span key={`${item.panelId}-${index}`} className="chip">
                      {item.title}
                      <small>{item.summary}</small>
                    </span>
                  ))}
                </div>
              ) : null}
              {message.text ? <p>{message.text}</p> : null}
            </article>
          ))
        )}
      </div>
      <form
        className="chat-compose"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label className="chat-target">
          <span>Pane</span>
          <select aria-label="Chat pane" value={paneId ?? ""} onChange={(event) => onPane(event.target.value || null)}>
            <option value="">Keep local</option>
            {workspaces.map((workspace) => (
              <optgroup key={workspace.workspaceId} label={workspace.label}>
                {panes
                  .filter((pane) => pane.workspaceId === workspace.workspaceId)
                  .map((pane) => (
                    <option key={pane.paneId} value={pane.paneId}>
                      {pane.paneId}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        {chips.length > 0 ? (
          <div className="chips">
            {chips.map((item, index) => (
              <button
                key={`${item.panelId}-${index}`}
                type="button"
                className="chip"
                onClick={() => setChips((current) => current.filter((_, chipIndex) => chipIndex !== index))}
              >
                {item.title}
                <small>{item.summary}</small>
              </button>
            ))}
          </div>
        ) : null}
        <div className="chat-row">
          <input
            aria-label="Chat message"
            value={text}
            placeholder={paneId ? `Message ${paneId}` : "Message"}
            onChange={(event) => setText(event.target.value)}
          />
          <button type="submit">Send</button>
        </div>
        {error ? <p className="chat-error">{error}</p> : null}
      </form>
    </div>
  );
}

function formatForPane(message: ChatMessage): string {
  const notes = message.attachments
    .map((item) => `[${item.kind}] ${item.title}: ${item.summary}`)
    .join("\n");
  return [message.text, notes].filter(Boolean).join("\n\n").slice(0, 8000);
}
