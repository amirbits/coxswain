import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev, Vite serves the UI with HMR and proxies the API + SSE stream to the
// Bun server (started alongside by scripts/dev.ts). The production build is
// emitted to web/dist and then embedded into the single binary.
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here, // build works regardless of the invoking cwd
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:4317", changeOrigin: true },
      // SSE: http-proxy streams responses through without buffering.
      "/events": { target: "http://127.0.0.1:4317", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
