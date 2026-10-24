import type { Bootstrap, ChatMessage, LayoutDocument, PanelConfig, RuntimeSnapshot } from "./types";

export interface HerdrField {
  section: string;
  key: string;
  group?: string;
  label: string;
  kind: "bool" | "string" | "int" | "enum";
  value: string | number | boolean;
  options: string[];
}

export interface HerdrConfig {
  path: string;
  theme: string;
  themes: string[];
  settings: HerdrField[];
  keys: HerdrField[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
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

export const api = {
  bootstrap: () => request<Bootstrap>("/api/bootstrap"),
  runtime: () => request<RuntimeSnapshot>("/api/runtime"),
  saveLayout: (layout: LayoutDocument) =>
    request<LayoutDocument>(`/api/layouts/${encodeURIComponent(layout.id)}`, {
      method: "PUT",
      body: JSON.stringify(layout),
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
  focus: (body: { paneId?: string; workspaceId?: string; tabId?: string }) =>
    request<void>("/api/session/focus", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  plugins: () => request<{ plugins: { id: string; title: string }[] }>("/api/plugins"),
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
  }) =>
    request<{ ok: boolean }>("/api/herdr/action", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  resolve: (target: string) =>
    request<{ panel: PanelConfig }>("/api/agent/resolve", {
      method: "POST",
      body: JSON.stringify({ target }),
    }).then((body) => body.panel),
  frame: (url: string) =>
    request<{ allowed: boolean; reason?: string }>(`/api/frame?url=${encodeURIComponent(url)}`),
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
  return `${protocol}//${location.host}${path}`;
}

export function contentUrl(path: string, bridge = false): string {
  const encoded = path
    .split("/")
    .filter((part) => part.length > 0)
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
  if (!path) return "";
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
