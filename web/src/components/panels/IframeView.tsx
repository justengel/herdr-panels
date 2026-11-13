import { useEffect, useRef, useState } from "react";
import { api, frameSrc } from "../../api";
import {
  adoptBrowser,
  browserBlocked,
  closeBrowser,
  browserBounds,
  browserSlotKey,
  desktopHost,
  isRemotePage,
  menuCuts,
  menuObstacles,
  nativePopupUsesStill,
  placeBrowser,
  browserLoadPending,
  snapshotBrowser,
  takeBrowserLoad,
} from "../../desktopBrowser";
import { panelZoom, subscribeZoom } from "../../displayZoom";
import { visualBox } from "../../zoomSpace";
import {
  browserLeader,
  claimMovingBrowser,
  dropBrowser,
  holdBrowser,
  useBrowserRole,
  useKeptIds,
  useStayFill,
  useVisitIds,
} from "../../browserPlace";

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
  const ids = useVisitIds();
  const keptIds = useKeptIds();
  const role = useBrowserRole();
  const stayId = useStayFill();
  const place = browserLeader(role, ids, keptIds, panelId, stayId);
  const leaderRef = useRef(place.leader);
  const hideRef = useRef(place.hide);
  leaderRef.current = place.leader;
  hideRef.current = place.hide;
  const lastRef = useRef("");
  const forceRef = useRef(false);
  const coverRef = useRef(false);
  const coverUrl = useRef("");
  const [note, setNote] = useState("Opening…");

  useEffect(() => {
    lastRef.current = "";
  }, [place.leader, place.hide, url]);

  useEffect(() => {
    const label = `browser-${panelId}`;
    const onLoad = (event: Event) => {
      const detail = (event as CustomEvent<{ label?: string }>).detail;
      if (!detail || detail.label !== label) return;
      forceRef.current = true;
      lastRef.current = "";
    };
    window.addEventListener("herdr-browser-load", onLoad);
    if (browserLoadPending(label)) {
      forceRef.current = true;
      lastRef.current = "";
    }
    return () => window.removeEventListener("herdr-browser-load", onLoad);
  }, [panelId]);

  useEffect(() => {
    const label = `browser-${panelId}`;
    // A drop onto a tab changes this label. Claim the page that is closing so the
    // native webview moves with it. Opening a second one leaves the tab blank, and
    // the address-bar reload only moves that blank view unless it is asked to load again.
    const { generation, reload } = holdBrowser(label);
    const moved = claimMovingBrowser(url, label);
    let stopped = false;
    let frame = 0;
    let refresh = reload;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const node = hole.current;
      if (!node || stopped || !leaderRef.current) return;
      const bounds = browserBounds(
        visualBox(node),
        suspendedRef.current || hideRef.current || browserBlocked(),
      );
      const cuts = bounds ? menuCuts(bounds, menuObstacles()) : [];
      const cover = bounds !== null && nativePopupUsesStill(navigator.userAgent, cuts);
      if (cover) {
        if (!coverRef.current) {
          coverRef.current = true;
          const shotWidth = bounds.width;
          const shotHeight = bounds.height;
          void snapshotBrowser(label, shotWidth, shotHeight)
            .then((blob) => {
              if (stopped || !coverRef.current) return;
              const holeNode = hole.current;
              if (holeNode && blob) {
                if (coverUrl.current) URL.revokeObjectURL(coverUrl.current);
                coverUrl.current = URL.createObjectURL(blob);
                holeNode.style.backgroundImage = `url("${coverUrl.current}")`;
                holeNode.style.backgroundSize = "100% 100%";
                holeNode.style.backgroundRepeat = "no-repeat";
              }
              return true;
            })
            .catch(() => true)
            .then((ready) => {
              if (!ready || stopped || !coverRef.current) return;
              lastRef.current = "covered";
              setNote("");
              void placeBrowser(label, url, null, generation, [], false);
            });
        }
        return;
      }
      if (coverRef.current) {
        coverRef.current = false;
        if (node.style.backgroundImage) node.style.backgroundImage = "";
        if (coverUrl.current) {
          URL.revokeObjectURL(coverUrl.current);
          coverUrl.current = "";
        }
        lastRef.current = "";
      }
      const key = browserSlotKey(bounds, cuts);
      const again = Boolean(bounds && (refresh || forceRef.current || browserLoadPending(label)));
      if (key === lastRef.current && !again) return;
      lastRef.current = key;
      if (again) {
        refresh = false;
        forceRef.current = false;
        takeBrowserLoad(label);
      }
      void placeBrowser(label, url, bounds, generation, cuts, again).then(
        () => {
          if (stopped) return;
          setNote(bounds ? "" : "Hidden while the desk is using this area.");
        },
        (err: unknown) => {
          if (!stopped) setNote(err instanceof Error ? err.message : String(err));
        },
      );
    };
    const begin = async () => {
      if (moved) {
        try {
          await adoptBrowser(moved.from, label, generation);
        } catch {
          void closeBrowser(moved.from, moved.generation);
        }
      }
      if (!stopped) {
        frame = requestAnimationFrame(tick);
        pushZoom();
      }
    };
    const pushZoom = () => {
      const owner = hole.current?.closest("[data-panel-id]")?.getAttribute("data-panel-id") ?? panelId;
      void desktopHost()
        ?.invoke("set_browser_zoom", { label, scale: panelZoom(owner) })
        .catch((err: unknown) => {
          console.error(err);
        });
    };
    void begin();
    const unsubscribe = subscribeZoom(pushZoom);
    return () => {
      stopped = true;
      unsubscribe();
      cancelAnimationFrame(frame);
      if (coverUrl.current) URL.revokeObjectURL(coverUrl.current);
      dropBrowser(label, generation, url);
    };
  }, [panelId, url]);

  return (
    <div ref={hole} className="frame browser-hole" data-browser-label={`browser-${panelId}`}>
      {note ? <div className="empty">{note}</div> : null}
    </div>
  );
}

function FramedPage({ url, proxy, title }: { url: string; proxy: boolean; title: string }) {
  const [ready, setReady] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    setReady(false);
    setRefusal(null);
    setSrc(null);
    setError(null);
    let raw: string;
    try {
      raw = frameSrc(url, proxy);
    } catch {
      setError("This iframe URL is invalid.");
      return;
    }
    const open = (next: string) => {
      if (stopped) return;
      setSrc(next);
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
    };
    if (raw.startsWith("/content/") || raw.startsWith("/proxy/")) {
      api.framePass(raw).then(
        (gated) => open(gated),
        () => {
          if (!stopped) {
            setError("This panel could not be opened.");
            setReady(true);
          }
        },
      );
    } else {
      open(raw);
    }
    return () => {
      stopped = true;
    };
  }, [url, proxy]);

  if (error) return <div className="empty">{error}</div>;
  if (!ready || !src) return <div className="empty">Opening…</div>;
  if (refusal) return <div className="empty">{refusal}</div>;
  const local = proxy || src.startsWith("/");
  const sandbox = local
    ? "allow-scripts allow-forms allow-popups"
    : "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin";
  return <iframe className="frame" title={title} src={src} sandbox={sandbox} />;
}
