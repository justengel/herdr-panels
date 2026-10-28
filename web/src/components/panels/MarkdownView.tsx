import { useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { wsUrl } from "../../api";
import { noteLinkAction, openExternalUrl } from "../../externalLink";

interface Props {
  path: string;
  design?: boolean;
  onPick?: (pick: { tag: string; text: string }) => void;
}

export function MarkdownView({ path, design = false, onPick }: Props) {
  const [text, setText] = useState("");
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | null = null;
    let timer = 0;
    const connect = () => {
      socket = new WebSocket(wsUrl(`/ws/watch?path=${encodeURIComponent(path)}`));
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as {
          type: string;
          text?: string;
          missing?: boolean;
          message?: string;
        };
        if (message.type === "content") {
          setText(message.text ?? "");
          setMissing(Boolean(message.missing));
          setError(null);
        } else if (message.type === "error") {
          setError(message.message ?? "Could not read the file");
        }
      };
      socket.onclose = () => {
        if (!stopped) timer = window.setTimeout(connect, 1000);
      };
    };
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      socket?.close();
    };
  }, [path]);

  const html = useMemo(() => {
    const parsed = marked.parse(text, { async: false, gfm: true });
    const source = typeof parsed === "string" ? parsed : "";
    return DOMPurify.sanitize(source);
  }, [text]);

  if (error) return <div className="empty">{error}</div>;
  if (missing) return <div className="empty">File not found: {path}</div>;
  return (
    <article
      className={design ? "markdown designing" : "markdown"}
      onClick={(event) => {
        if (design) {
          event.preventDefault();
          event.stopPropagation();
          const target = event.target as HTMLElement;
          const node = target.closest("h1,h2,h3,h4,h5,p,li,pre,blockquote,table") ?? target;
          const text = (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
          onPick?.({ tag: node.tagName.toLowerCase(), text });
          return;
        }
        const anchor = (event.target as HTMLElement).closest("a");
        if (!anchor?.href) return;
        const action = noteLinkAction(anchor.href, window.location.href);
        if (action === "stay") return;
        event.preventDefault();
        if (action === "open") void openExternalUrl(anchor.href).catch(() => undefined);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
