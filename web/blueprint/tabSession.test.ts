import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, rememberSession, tabSession, wsUrl } from "../src/api";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe("tab session", () => {
  beforeEach(() => {
    vi.stubGlobal("sessionStorage", memoryStorage());
    vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1:9" });
    vi.stubGlobal("window", {});
  });

  it("starts a new tab at default and keeps that tab's name", () => {
    expect(tabSession()).toBe("default");
    rememberSession("testing");
    expect(tabSession()).toBe("testing");
    rememberSession("  ");
    expect(tabSession()).toBe("default");
  });

  it("tells an open view when this tab changes session", () => {
    let heard = 0;
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    target.addEventListener("herdr-tab-session", () => {
      heard += 1;
    });
    rememberSession("testing");
    expect(heard).toBe(1);
    expect(tabSession()).toBe("testing");
  });

  it("sends the tab session on requests and sockets", async () => {
    rememberSession("testing");
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await api.health();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("X-Herdr-Session")).toBe("testing");
    expect(wsUrl("/ws/terminal")).toBe("ws://127.0.0.1:9/ws/terminal?session=testing");
    expect(wsUrl("/ws/terminal?paneId=w1%3Ap1")).toBe(
      "ws://127.0.0.1:9/ws/terminal?paneId=w1%3Ap1&session=testing",
    );
  });
});
