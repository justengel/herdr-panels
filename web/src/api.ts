import type { PluginInfo } from "./desk";
import type { DeskSnapshot } from "./deskSync";
import type { Bootstrap, ChatMessage, LayoutDocument, PanelConfig, RuntimeSnapshot } from "./types";
import { baseName as pathName, contentSegments } from "./paths";

export interface HerdrChoice {
  value: string;
  detail?: string;
}

export interface HerdrField {
  section: string;
  key: string;
  group?: string;
  audience?: "herdr" | "panels" | "both";
  label: string;
  help?: string;
  kind: "bool" | "string" | "int" | "enum" | "tokens";
  value: string | number | boolean;
  options: string[];
  choices?: HerdrChoice[];
}

export interface HerdrIntegration {
  target: string;
  label: string;
  state: string;
  available: boolean;
  command?: string;
}

export interface HerdrConfig {
  path: string;
  theme: string;
  themes: string[];
  settings: HerdrField[];
  keys: HerdrField[];
  spaceRows?: string[][];
  integrations?: HerdrIntegration[];
  integrationError?: string;
}

export interface ViewerHealth {
  ok: boolean;
  build: string;
  version: string;
  dev: boolean;
}

export interface HerdrCtlStatus {
  clientVersion?: string | null;
  channel?: string | null;
  serverRunning: boolean;
  restartNeeded: boolean;
  serverBinaryStale: boolean;
  updateAvailable: boolean;
  latestVersion?: string | null;
}

function viewerToken(): string {
  const value = (window as Window & { __HERDR_PANELS_TOKEN__?: unknown }).__HERDR_PANELS_TOKEN__;
  return typeof value === "string" ? value : "";
}

function authHeaders(): Record<string, string> {
  const token = viewerToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
      ...authHeaders(),
    },
  });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // The body was not JSON.
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface DeskFile extends DeskSnapshot {
  revision: number;
}

export interface DeskSaveResult {
  status: "stored" | "conflict" | "session";
  desk: DeskFile;
}

export const api = {
  health: () => request<ViewerHealth>("/api/health"),
  bootstrap: () => request<Bootstrap>("/api/bootstrap"),
  runtime: () => request<RuntimeSnapshot>("/api/runtime"),
  saveLayout: (layout: LayoutDocument) =>
    request<LayoutDocument>(`/api/layouts/${encodeURIComponent(layout.id)}`, {
      method: "PUT",
      body: JSON.stringify(layout),
    }),
  desk: () => request<DeskFile>("/api/desk"),
  saveDesk: (body: DeskFile & { session: string; adopt?: boolean }) =>
    request<DeskSaveResult>("/api/desk", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  setActive: (id: string) =>
    request<{ layout: LayoutDocument }>("/api/active", {
      method: "PUT",
      body: JSON.stringify({ id }),
    }),
  sendInput: (body: { paneId: string; text?: string; keys?: string[] }) =>
    request<void>("/api/terminal/input", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  readScreen: (paneId: string, source = "visible") =>
    request<{ text: string; truncated: boolean; revision: number }>(
      `/api/terminal/${encodeURIComponent(paneId)}/screen?source=${encodeURIComponent(source)}`,
    ),
  splitPane: (paneId: string, direction: "right" | "down") =>
    request<{ paneId: string }>("/api/terminal/split", {
      method: "POST",
      body: JSON.stringify({ paneId, direction }),
    }),
  loadChat: (id: string) => request<{ messages: ChatMessage[] }>(`/api/chats/${encodeURIComponent(id)}`),
  saveChat: (id: string, messages: ChatMessage[]) =>
    request<void>(`/api/chats/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ messages }),
    }),
  tree: (path: string) =>
    request<{ path: string; entries: { name: string; path: string; kind: "dir" | "file" }[] }>(
      `/api/tree?path=${encodeURIComponent(path)}`,
    ),
  localOpen: (body: { path: string; action: "browser" | "terminal" }) =>
    request<{ ok: boolean }>("/api/local-open", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  focus: (body: { paneId?: string; workspaceId?: string; tabId?: string }) =>
    request<void>("/api/session/focus", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  plugins: () => request<{ plugins: PluginInfo[] }>("/api/plugins", { cache: "no-store" }),
  pluginBridge: (
    pluginId: string,
    body: { panelId: string; method: string; params?: Record<string, unknown> },
  ) =>
    request<unknown>(`/api/plugins/${encodeURIComponent(pluginId)}/bridge`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  closeSession: (name: string) =>
    request<{ name: string; runtime: RuntimeSnapshot }>("/api/sessions/close", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  sessions: () => request<{ sessions: { name: string }[] }>("/api/sessions"),
  useSession: (name: string) =>
    request<{ name: string; runtime: RuntimeSnapshot }>("/api/sessions", {
      method: "PUT",
      body: JSON.stringify({ name }),
    }),
  createSession: (name: string) =>
    request<{ name: string; runtime: RuntimeSnapshot }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  renameSession: (name: string, to: string) =>
    request<{ name: string; runtime: RuntimeSnapshot }>("/api/sessions/rename", {
      method: "POST",
      body: JSON.stringify({ name, to }),
    }),
  herdrConfig: () => request<HerdrConfig>("/api/herdr/config"),
  saveHerdrConfig: (body: {
    theme?: string;
    settings?: Record<string, string | number | boolean>;
    keys?: Record<string, string>;
    reload?: boolean;
    integration?: { target: string; action: "install" | "uninstall" };
  }) =>
    request<HerdrConfig>("/api/herdr/config", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  herdrAction: (body: {
    action: string;
    workspaceId?: string;
    tabId?: string;
    paneId?: string;
    label?: string;
    direction?: string;
    beforeWorkspaceId?: string;
    insertIndex?: number;
    focus?: boolean;
  }) =>
    request<{ ok: boolean }>("/api/herdr/action", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  herdrCtl: () => request<HerdrCtlStatus>("/api/herdr/ctl"),
  herdrCtlAction: (action: "start" | "update" | "restart") =>
    request<{
      name?: string;
      runtime?: RuntimeSnapshot;
      message?: string;
      ctl?: HerdrCtlStatus;
    }>("/api/herdr/ctl", {
      method: "POST",
      body: JSON.stringify({ action }),
    }),
  resolve: (target: string) =>
    request<{ panel: PanelConfig }>("/api/agent/resolve", {
      method: "POST",
      body: JSON.stringify({ target }),
    }).then((body) => body.panel),
  /** Native file picker. Starts in `directory` when it is a folder, or its parent when a file. */
  pickFile: (directory?: string | null) =>
    request<{ path: string | null }>("/api/pick-file", {
      method: "POST",
      body: JSON.stringify({ directory: directory || null }),
    }).then((body) => body.path),
  /** System save dialog. `null` means the person cancelled and nothing was written. */
  savePng: async (blob: Blob, name: string) => {
    const response = await fetch("/api/save-png", {
      method: "POST",
      headers: {
        ...authHeaders(),
        "Content-Type": "image/png",
        "X-Screenshot-Name": name,
      },
      body: blob,
    });
    if (!response.ok) {
      let message = response.statusText || "Could not save the screenshot";
      try {
        const payload = (await response.json()) as { error?: string };
        if (payload.error) message = payload.error;
      } catch {
        // The body was not JSON.
      }
      throw new Error(message);
    }
    const payload = (await response.json()) as { path?: string | null };
    return payload.path ?? null;
  },
  frame: (url: string) =>
    request<{ allowed: boolean; reason?: string }>(`/api/frame?url=${encodeURIComponent(url)}`),
  framePass: (path: string) =>
    request<{ src: string }>("/api/frame-pass", {
      method: "POST",
      body: JSON.stringify({ path }),
    }).then((body) => body.src),
  open: (body: {
    target: string;
    panelId?: string;
    from?: string;
    direction?: "right" | "down";
    reuse?: boolean;
    title?: string;
  }) =>
    request<{ panelId: string; created: boolean }>("/api/agent/open", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

export function wsUrl(path: string): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const token = viewerToken();
  const authed = token
    ? `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`
    : path;
  return `${protocol}//${location.host}${authed}`;
}

export function contentUrl(path: string, bridge = false): string {
  const encoded = contentSegments(path)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return bridge ? `/content/${encoded}?bridge=1` : `/content/${encoded}`;
}

export function frameSrc(url: string, proxy: boolean): string {
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  if (!proxy) return url;
  const parsed = new URL(url);
  const scheme = parsed.protocol.replace(":", "");
  const tail = `${parsed.pathname.replace(/^\//, "")}${parsed.search}`;
  return `/proxy/${scheme}/${parsed.host}/${tail}`;
}

export function baseName(path: string | null | undefined): string {
  return pathName(path);
}
