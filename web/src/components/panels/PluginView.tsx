import { useEffect, useRef } from "react";
import { readPluginAddressMessage } from "../../pluginAddress";
import type { PluginOpen } from "../../viewMenu";

export type PluginHostCommand =
  | { id: number; pluginId: string; type: "address-navigate"; value: string }
  | { id: number; pluginId: string; type: "address-reload" };

export function PluginView({
  pluginId,
  title,
  modify,
  command,
  open,
  onAddress,
  onBar,
  onConfig,
}: {
  pluginId: string;
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
  onAddressRef.current = onAddress;
  onBarRef.current = onBar;
  onConfigRef.current = onConfig;
  commandRef.current = command;
  openRef.current = open;

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const message = readPluginAddressMessage(event.data);
      if (!message) return;
      if (message.type === "config") {
        onConfigRef.current(message.value);
        return;
      }
      if (!modify) return;
      if (message.type === "address") onAddressRef.current(message.value);
      else onBarRef.current({ show: message.show, replace: message.replace });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [modify]);

  const openKey = open ? `${open.view}\n${open.kind}\n${open.address}\n${JSON.stringify(open.config)}` : "";

  useEffect(() => {
    deliver(frameRef.current?.contentWindow, modify, command, openRef.current);
  }, [modify, command, openKey]);

  return (
    <iframe
      ref={frameRef}
      className="frame"
      title={title}
      sandbox="allow-scripts allow-forms allow-popups"
      src={`/plugins/${encodeURIComponent(pluginId)}`}
      onLoad={(event) => deliver(event.currentTarget.contentWindow, modify, commandRef.current, openRef.current)}
    />
  );
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
