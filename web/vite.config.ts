import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

const api = "http://127.0.0.1:4737";

function configDir(): string {
  const override = process.env.HERDR_PANELS_CONFIG?.trim();
  if (override) return override;
  const base =
    process.platform === "win32"
      ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
      : process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  const current = path.join(base, "herdr-panels");
  const earlier = path.join(base, "herdr-web-panels");
  if (fs.existsSync(current) || !fs.existsSync(earlier)) return current;
  return earlier;
}

function viewerToken(): string {
  const override = process.env.HERDR_PANELS_TOKEN?.trim();
  if (override) return override;
  try {
    return fs.readFileSync(path.join(configDir(), "auth-token"), "utf8").trim();
  } catch {
    return "";
  }
}

function authorize(req: { setHeader(name: string, value: string): void }) {
  const token = viewerToken();
  if (token) req.setHeader("Authorization", `Bearer ${token}`);
}

function proxy(ws = false): ProxyOptions {
  return {
    target: api,
    ws,
    configure(server) {
      server.on("proxyReq", authorize);
      if (ws) server.on("proxyReqWs", authorize);
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: "viewer-token",
      transformIndexHtml: {
        order: "pre",
        handler(html, ctx) {
          if (!ctx.server) return html;
          const tag = `<script>window.__HERDR_PANELS_TOKEN__=${JSON.stringify(viewerToken())}</script>`;
          return html.includes("</head>") ? html.replace("</head>", `${tag}</head>`) : `${tag}${html}`;
        },
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    fs: { allow: [".."] },
    proxy: {
      "/api": proxy(),
      "/content": proxy(),
      "/gate": proxy(),
      "/plugins": proxy(),
      "/proxy": proxy(),
      "/ws": proxy(true),
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
});
