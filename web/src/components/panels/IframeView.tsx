import { useEffect, useRef, useState } from "react";
import { api, frameSrc } from "../../api";
import {
  browserBlocked,
  browserBounds,
  closeBrowser,
  desktopHost,
  fitAround,
  isRemotePage,
  menuObstacles,
  nextBrowserGeneration,
  placeBrowser,
} from "../../desktopBrowser";

interface Props {
  url: string;
  proxy?: boolean;
  title: string;
  panelId?: string;
  suspended?: boolean;
}

export function IframeView({ url, proxy = false, title, panelId, suspended = false }: Props) {
  const embedded = Boolean(panelId) && desktopHost() !== null && isRemotePage(url);
  if (embedded && panelId) {
    return <EmbeddedPage panelId={panelId} url={url} suspended={suspended} />;
  }
  return <FramedPage url={url} proxy={proxy} title={title} />;
}

function EmbeddedPage({ panelId, url, suspended }: { panelId: string; url: string; suspended: boolean }) {
  const hole = useRef<HTMLDivElement>(null);
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const [note, setNote] = useState("Opening…");

  useEffect(() => {
    const label = `browser-${panelId}`;
    const generation = nextBrowserGeneration();
    let stopped = false;
    let last = "";
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const node = hole.current;
      if (!node || stopped) return;
      const page = browserBounds(node.getBoundingClientRect(), suspendedRef.current || browserBlocked());
      const bounds = page ? fitAround(page, menuObstacles()) : null;
      const key = bounds ? `${bounds.x},${bounds.y},${bounds.width},${bounds.height}` : "hidden";
      if (key === last) return;
      last = key;
      void placeBrowser(label, url, bounds, generation).then(
        () => {
          if (stopped) return;
          setNote(bounds ? "" : "Hidden while the desk is using this area.");
        },
        (err: unknown) => {
          if (!stopped) setNote(err instanceof Error ? err.message : String(err));
        },
      );
    };
    frame = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      void closeBrowser(label, generation);
    };
  }, [panelId, url]);

  return (
    <div ref={hole} className="frame browser-hole">
      {note ? <div className="empty">{note}</div> : null}
    </div>
  );
}

function FramedPage({ url, proxy, title }: { url: string; proxy: boolean; title: string }) {
  const [ready, setReady] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  let src = url;
  let error: string | null = null;
  try {
    src = frameSrc(url, proxy);
  } catch {
    error = "This iframe URL is invalid.";
  }

  useEffect(() => {
    let stopped = false;
    setReady(false);
    setRefusal(null);
    if (!url || url.startsWith("/") || proxy) {
      setReady(true);
      return;
    }
    api.frame(url).then(
      (result) => {
        if (stopped) return;
        setRefusal(result.allowed ? null : result.reason || "This site refused to be embedded.");
        setReady(true);
      },
      () => {
        if (!stopped) setReady(true);
      },
    );
    return () => {
      stopped = true;
    };
  }, [url, proxy]);

  if (error) return <div className="empty">{error}</div>;
  if (!ready) return <div className="empty">Opening…</div>;
  if (refusal) return <div className="empty">{refusal}</div>;
  return <iframe className="frame" title={title} src={src} />;
}
