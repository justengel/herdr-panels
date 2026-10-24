import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = "http://127.0.0.1:4737";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    fs: { allow: [".."] },
    proxy: {
      "/api": api,
      "/content": api,
      "/proxy": api,
      "/ws": { target: api, ws: true },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
});
