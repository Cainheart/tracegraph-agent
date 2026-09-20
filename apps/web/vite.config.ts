import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Keep this app's optimizer cache isolated from shared workspace caches. It
  // also avoids broad cache cleanup when workspace links change.
  cacheDir: "node_modules/.vite-tracegraph",
  plugins: [react()],
  build: {
    // Root build first removes only manifest-owned workspace dist directories.
    // Keep Vite's own output cleanup enabled as a second defense against stale
    // hashed chunks entering a release artifact.
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 4310,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4311",
        configure(proxy) {
          // Browser requests are same-origin with Vite, so they do not carry
          // an Origin header. Inject the exact dev-server origin at this
          // trusted reverse-proxy boundary; the Host allowlist remains strict.
          proxy.on("proxyReq", (proxyRequest) => {
            proxyRequest.setHeader("origin", "http://127.0.0.1:4310");
          });
        },
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
