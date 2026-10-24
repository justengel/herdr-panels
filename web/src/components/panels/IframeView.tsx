import { useEffect, useState } from "react";
import { api, frameSrc } from "../../api";

interface Props {
  url: string;
  proxy?: boolean;
  title: string;
}

export function IframeView({ url, proxy = false, title }: Props) {
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
