import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { useTabSession, wsUrl } from "../../api";
import { diagramHtml, diagramPixelWidth, renderNote, type NoteScheme } from "../../mermaidNote";
import { CopyOnSelect } from "../CopyOnSelect";
import { noteLinkAction, openExternalUrl } from "../../externalLink";

interface Props {
  path: string;
  design?: boolean;
  onPick?: (pick: { tag: string; text: string }) => void;
}

function noteScheme(): NoteScheme {
  return document.documentElement.style.colorScheme === "light" ? "light" : "dark";
}

export function MarkdownView({ path, design = false, onPick }: Props) {
  const [text, setText] = useState("");
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionName = useTabSession();

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
  }, [path, sessionName]);

  const prepared = useMemo(() => renderNote(text), [text]);
  const html = useMemo(() => DOMPurify.sanitize(prepared.html), [prepared]);
  const [scheme, setScheme] = useState<NoteScheme>(noteScheme);
  const articleRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const onTheme = () => setScheme(noteScheme());
    window.addEventListener("herdr-theme", onTheme);
    return () => window.removeEventListener("herdr-theme", onTheme);
  }, []);

  useEffect(() => {
    const root = articleRef.current;
    if (!root || prepared.diagrams.length === 0) return;
    let stopped = false;
    const fit = () => {
      const column = root.clientWidth;
      for (const svg of root.querySelectorAll<SVGSVGElement>("svg[data-natural-width]")) {
        const target = diagramPixelWidth(Number(svg.dataset.naturalWidth), column);
        if (!target) continue;
        svg.style.width = `${target}px`;
        svg.style.height = "auto";
      }
    };
    void (async () => {
      for (const diagram of prepared.diagrams) {
        const rendered = await diagramHtml(diagram.source, scheme);
        if (stopped) return;
        const host = root.querySelector(`[data-herdr-mermaid="${diagram.id}"]`);
        if (!host) continue;
        host.innerHTML = rendered;
      }
      if (!stopped) fit();
    })();
    const observer = new ResizeObserver(() => fit());
    observer.observe(root);
    return () => {
      stopped = true;
      observer.disconnect();
    };
  }, [html, prepared, scheme]);

  if (error) return <div className="empty">{error}</div>;
  if (missing) return <div className="empty">File not found: {path}</div>;
  return (
    <CopyOnSelect>
      <article
        ref={articleRef}
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
    </CopyOnSelect>
  );
}
