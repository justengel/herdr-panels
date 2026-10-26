import { useEffect, useState } from "react";
import { wsUrl } from "../../api";

export function TextView({ path, text }: { path?: string; text?: string }) {
  if (text !== undefined) return <StaticText text={text} />;
  return <WatchedText path={path ?? ""} />;
}

function StaticText({ text }: { text: string }) {
  if (text.includes("\u0000")) return <div className="empty">This file is not text.</div>;
  return <pre className="file-text">{text}</pre>;
}

function WatchedText({ path }: { path: string }) {
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

  if (error) return <div className="empty">{error}</div>;
  if (missing) return <div className="empty">File not found: {path}</div>;
  if (text.includes("\u0000")) return <div className="empty">This file is not text.</div>;
  return <pre className="file-text">{text}</pre>;
}
