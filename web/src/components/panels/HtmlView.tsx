import { useEffect, useRef } from "react";
import frameKeys from "../../../../assets/frame-keys.js?raw";
import frameSelect from "../../../../assets/frame-select.js?raw";
import bridge from "../../../../assets/panel-bridge.js?raw";
import { api, contentUrl } from "../../api";
import { desktopHost } from "../../desktopBrowser";
import { openableHttpUrl, openExternalUrl } from "../../externalLink";
import { CONTROL_OFF_MESSAGE } from "../../controlHint";
import { isHerdrPaneId } from "../../paneId";

interface Props {
  path?: string | null;
  inline?: string | null;
  title: string;
  control?: boolean;
  design?: boolean;
  onPick?: (pick: { tag: string; text: string }) => void;
}

interface BridgeMessage {
  source: string;
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export function HtmlView({ path, inline, title, control = false, design = false, onPick }: Props) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const pickRef = useRef(onPick);
  const controlRef = useRef(control);
  pickRef.current = onPick;
  controlRef.current = control;

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      const message = event.data as BridgeMessage & { type?: string; tag?: string; text?: string };
      if (message?.source === "hwp-panel" && message.type === "pick") {
        pickRef.current?.({ tag: String(message.tag ?? "element"), text: String(message.text ?? "") });
        return;
      }
      if (!message || message.source !== "hwp-panel" || typeof message.id !== "number") return;
      void fulfill(message, controlRef.current)
        .then((result) => {
          frame.contentWindow?.postMessage({ source: "hwp-host", id: message.id, ok: true, result }, "*");
        })
        .catch((error: unknown) => {
          const text = error instanceof Error ? error.message : String(error);
          frame.contentWindow?.postMessage({ source: "hwp-host", id: message.id, ok: false, error: text }, "*");
        });
    };
    window.addEventListener("message", onMessage);
    let cancelled = false;
    if (path) {
      const target = contentUrl(path, false);
      void api
        .framePass(target)
        .then(async (src) => {
          const response = await fetch(src);
          if (!response.ok) throw new Error("The page could not be loaded");
          return { src, html: await response.text() };
        })
        .then(
          ({ src, html }) => {
            const node = frameRef.current;
            if (cancelled || !node) return;
            node.removeAttribute("src");
            delete node.dataset.selectBridge;
            node.srcdoc = pageWithBridge(html, directoryHref(src));
          },
          () => {
            if (!cancelled && frameRef.current) frameRef.current.removeAttribute("src");
          },
        );
    } else if (inline) {
      frame.removeAttribute("src");
      frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><script>${frameKeys}\n${frameSelect}\n${bridge}</script></head><body>${inline}</body></html>`;
    }
    return () => {
      cancelled = true;
      window.removeEventListener("message", onMessage);
    };
  }, [path, inline]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const publish = () => {
      frame.contentWindow?.postMessage({ source: "hwp-host", type: "design", enabled: design }, "*");
    };
    frame.addEventListener("load", publish);
    publish();
    return () => frame.removeEventListener("load", publish);
  }, [design, path, inline]);

  return (
    <iframe
      ref={frameRef}
      className="frame"
      title={title}
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      onLoad={() => {
        const frame = frameRef.current?.contentWindow;
        const arm = (window as Window & { __hwpArmFrame?: (frame: Window) => void }).__hwpArmFrame;
        if (frame) arm?.(frame);
      }}
    />
  );
}

function directoryHref(src: string): string {
  const url = new URL(src, window.location.href);
  url.search = "";
  url.hash = "";
  return `${url.origin}${url.pathname.replace(/[^/]*$/, "")}`;
}

function pageWithBridge(html: string, baseHref: string): string {
  const base = /<base\b/i.test(html)
    ? ""
    : `<base href="${baseHref.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">`;
  const script = `<script>${frameKeys}\n${frameSelect}\n${bridge}</script>`;
  const lower = html.toLowerCase();
  const start = lower.indexOf("<head");
  if (start >= 0) {
    const end = html.indexOf(">", start);
    if (end >= 0) return `${html.slice(0, end + 1)}${base}${script}${html.slice(end + 1)}`;
  }
  return `<!doctype html><html><head><meta charset="utf-8">${base}${script}</head><body>${html}</body></html>`;
}

async function fulfill(message: BridgeMessage, control: boolean): Promise<unknown> {
  const params = message.params ?? {};
  switch (message.method) {
    case "status":
    case "listPanes":
      return api.runtime();
    case "sendText":
    case "sendKeys":
      if (!control) throw new Error(CONTROL_OFF_MESSAGE);
      if (message.method === "sendText") {
        await api.sendInput({
          paneId: String(params.paneId ?? ""),
          text: String(params.text ?? ""),
        });
      } else {
        await api.sendInput({
          paneId: String(params.paneId ?? ""),
          keys: Array.isArray(params.keys) ? params.keys.map(String) : [],
        });
      }
      return { ok: true };
    case "readPane":
      return api.readScreen(String(params.paneId ?? ""), String(params.source ?? "visible"));
    case "listPanels":
    case "openPanel":
    case "updatePanel":
    case "closePanel":
    case "movePanel":
    case "resizePanel":
    case "fillPanel":
    case "showDesk":
    case "visitPanel":
      throw new Error("This panel cannot change the desk");
    case "setZoom":
      throw new Error("This panel cannot change the window zoom");
    case "openExternal": {
      const url = openableHttpUrl(String(params.url ?? ""));
      if (!url) throw new Error("only http and https links can be opened");
      if (desktopHost()) {
        const opened = await openExternalUrl(url);
        return { url: opened, opened: true };
      }
      return { url };
    }
    case "scrollPane":
      throw new Error("This panel cannot scroll a pane");
    case "focusPane": {
      if (!control) throw new Error(CONTROL_OFF_MESSAGE);
      const paneId = String(params.paneId ?? "");
      if (!isHerdrPaneId(paneId)) throw new Error("invalid pane id");
      const runtime = await api.runtime();
      if (!runtime.panes.some((pane) => pane.paneId === paneId)) throw new Error("pane was not found");
      await api.focus({ paneId });
      return { ok: true };
    }
    default:
      throw new Error(`Unknown bridge method: ${message.method}`);
  }
}
