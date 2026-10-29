import { useEffect, useRef } from "react";
import { api, wsUrl } from "../../api";
import { desktopHost } from "../../desktopBrowser";
import { openableHttpUrl, openExternalUrl } from "../../externalLink";
import { requestVisit } from "../../borrowPanel";
import { requestPaneReveal } from "../../deskKeys";
import { readPluginAddressMessage, readPluginBridgeCall, readPluginFileCommand } from "../../pluginAddress";
import type { PluginOpen } from "../../viewMenu";

export type PluginHostCommand =
  | { id: number; pluginId: string; type: "address-navigate"; value: string }
  | { id: number; pluginId: string; type: "address-reload" };

export function PluginView({
  pluginId,
  panelId,
  title,
  modify,
  command,
  open,
  onAddress,
  onBar,
  onConfig,
}: {
  pluginId: string;
  panelId: string;
  title: string;
  modify: boolean;
  command: PluginHostCommand | null;
  open: PluginOpen | null;
  onAddress: (value: string) => void;
  onBar: (bar: { show: boolean; replace: boolean }) => void;
  onConfig: (value: Record<string, unknown>) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const onAddressRef = useRef(onAddress);
  const onBarRef = useRef(onBar);
  const onConfigRef = useRef(onConfig);
  const commandRef = useRef(command);
  const openRef = useRef(open);
  const fileSocket = useRef<WebSocket | null>(null);
  const fileQueue = useRef<string[]>([]);
  const modifyRef = useRef(modify);
  onAddressRef.current = onAddress;
  onBarRef.current = onBar;
  onConfigRef.current = onConfig;
  commandRef.current = command;
  openRef.current = open;
  modifyRef.current = modify;

  useEffect(() => {
    const sendFile = (payload: string) => {
      const socket = fileSocket.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
        return;
      }
      fileQueue.current.push(payload);
      if (socket && socket.readyState === WebSocket.CONNECTING) return;
      const next = new WebSocket(wsUrl(`/ws/plugin-files?plugin=${encodeURIComponent(pluginId)}`));
      fileSocket.current = next;
      next.onopen = () => {
        for (const queued of fileQueue.current) next.send(queued);
        fileQueue.current = [];
      };
      next.onmessage = (event) => {
        let message: unknown;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (!message || typeof message !== "object") return;
        frameRef.current?.contentWindow?.postMessage({ ...(message as object), source: "hwp-host" }, "*");
      };
      next.onclose = () => {
        if (fileSocket.current === next) fileSocket.current = null;
      };
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const call = readPluginBridgeCall(event.data);
      if (call) {
        const frame = frameRef.current?.contentWindow;
        void api
          .pluginBridge(pluginId, { panelId, method: call.method, params: call.params })
          .then(async (result) => {
            if (call.method === "openExternal") {
              const approved =
                result && typeof result === "object" && "url" in result
                  ? openableHttpUrl(String((result as { url: unknown }).url))
                  : null;
              if (!approved) {
                frame?.postMessage(
                  {
                    source: "hwp-host",
                    id: call.id,
                    ok: false,
                    error: "only http and https links can be opened",
                  },
                  "*",
                );
                return;
              }
              if (desktopHost()) {
                try {
                  const url = await openExternalUrl(approved);
                  frame?.postMessage(
                    { source: "hwp-host", id: call.id, ok: true, result: { url, opened: true } },
                    "*",
                  );
                } catch (error: unknown) {
                  const text = error instanceof Error ? error.message : "could not open the link";
                  frame?.postMessage({ source: "hwp-host", id: call.id, ok: false, error: text }, "*");
                }
                return;
              }
              frame?.postMessage(
                { source: "hwp-host", id: call.id, ok: true, result: { url: approved } },
                "*",
              );
              return;
            }
            if (call.method === "setZoom") {
              const scale =
                result && typeof result === "object" && "scale" in result
                  ? Number((result as { scale: unknown }).scale)
                  : Number.NaN;
              if (!Number.isFinite(scale)) {
                frame?.postMessage(
                  { source: "hwp-host", id: call.id, ok: false, error: "scale is required" },
                  "*",
                );
                return;
              }
              if (!desktopHost()) {
                frame?.postMessage(
                  {
                    source: "hwp-host",
                    id: call.id,
                    ok: false,
                    error: "display zoom is only available in the desktop window",
                  },
                  "*",
                );
                return;
              }
              const owner = frameRef.current?.closest("[data-panel-id]")?.getAttribute("data-panel-id") ?? panelId;
              window.dispatchEvent(new CustomEvent("herdr-zoom-set", { detail: { scale, panelId: owner } }));
            }
            if (call.method === "visitPanel") {
              const record =
                result && typeof result === "object"
                  ? (result as {
                      panelId?: unknown;
                      spaceId?: unknown;
                      arrange?: unknown;
                      sizes?: unknown;
                      columns?: unknown;
                      rows?: unknown;
                      panels?: { panelId?: unknown; spaceId?: unknown }[];
                    })
                  : {};
              const listed = Array.isArray(record.panels)
                ? record.panels.flatMap((panel) =>
                    typeof panel?.panelId === "string"
                      ? [{ panelId: panel.panelId, spaceId: typeof panel.spaceId === "string" ? panel.spaceId : undefined }]
                      : [],
                  )
                : [];
              const panels = listed.length
                ? listed
                : [
                    {
                      panelId: typeof record.panelId === "string" ? record.panelId : String(call.params.panelId ?? ""),
                      spaceId: typeof record.spaceId === "string" ? record.spaceId : undefined,
                    },
                  ];
              const arrange = typeof record.arrange === "string" ? record.arrange : undefined;
              const shown = requestVisit(panels, arrange, {
                sizes: numberList(record.sizes),
                columns: numberList(record.columns),
                rows: numberList(record.rows),
              });
              if ("error" in shown) {
                frame?.postMessage(
                  { source: "hwp-host", id: call.id, ok: false, error: shown.error },
                  "*",
                );
                return;
              }
            }
            if (call.method === "focusPane") {
              const record =
                result && typeof result === "object"
                  ? (result as { paneId?: unknown; workspaceId?: unknown })
                  : {};
              const paneId = typeof record.paneId === "string" ? record.paneId : String(call.params.paneId ?? "");
              const workspaceId = typeof record.workspaceId === "string" ? record.workspaceId : "";
              if (!requestPaneReveal(paneId, workspaceId)) {
                frame?.postMessage(
                  {
                    source: "hwp-host",
                    id: call.id,
                    ok: false,
                    error: "The desk could not show that pane.",
                  },
                  "*",
                );
                return;
              }
            }
            frame?.postMessage({ source: "hwp-host", id: call.id, ok: true, result }, "*");
          })
          .catch((error: unknown) => {
            const text = error instanceof Error ? error.message : "request failed";
            frame?.postMessage({ source: "hwp-host", id: call.id, ok: false, error: text }, "*");
          });
        return;
      }
      const file = readPluginFileCommand(event.data);
      if (file) {
        sendFile(JSON.stringify(file));
        return;
      }
      const message = readPluginAddressMessage(event.data);
      if (!message) return;
      if (message.type === "config") {
        onConfigRef.current(message.value);
        return;
      }
      if (!modifyRef.current) return;
      if (message.type === "address") onAddressRef.current(message.value);
      else onBarRef.current({ show: message.show, replace: message.replace });
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      fileSocket.current?.close();
      fileSocket.current = null;
      fileQueue.current = [];
    };
  }, [panelId, pluginId]);

  const openKey = open ? `${open.view}\n${open.kind}\n${open.address}\n${JSON.stringify(open.config)}` : "";

  useEffect(() => {
    deliver(frameRef.current?.contentWindow, modify, command, openRef.current);
  }, [modify, command, openKey]);

  return (
    <iframe
      ref={frameRef}
      className="frame"
      title={title}
      sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
      src={`/plugins/${encodeURIComponent(pluginId)}`}
      onLoad={(event) => {
        const frame = event.currentTarget.contentWindow;
        const arm = (window as Window & { __hwpArmFrame?: (frame: Window) => void }).__hwpArmFrame;
        if (frame) arm?.(frame);
        deliver(frame, modify, commandRef.current, openRef.current);
      }}
    />
  );
}

function numberList(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const weights = value.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  return weights.length === value.length ? weights : undefined;
}

function deliver(
  frame: Window | null | undefined,
  modify: boolean,
  command: PluginHostCommand | null,
  open: PluginOpen | null,
) {
  if (!frame) return;
  if (open) {
    frame.postMessage(
      { source: "hwp-host", type: "open", view: open.view, address: open.address, kind: open.kind, config: open.config },
      "*",
    );
  }
  if (!modify || !command) return;
  if (command.type === "address-navigate") {
    frame.postMessage({ source: "hwp-host", type: "address-navigate", value: command.value }, "*");
    return;
  }
  frame.postMessage({ source: "hwp-host", type: "address-reload" }, "*");
}
