import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Source development also attaches to an already-running installed owner.
// Only the public loopback address is used; discovery credentials never enter
// the renderer or proxy headers.
function developmentGateway(): string {
  try {
    const root=process.env.OUTLIVE_PROFILE_ROOT ?? join(homedir(),".outlive","profiles","default");
    const record=JSON.parse(readFileSync(join(root,"discovery.json"),"utf8")) as {http_address?:unknown};
    if(typeof record.http_address!=="string")throw new Error("No gateway address");
    const url=new URL(record.http_address);
    if(url.protocol!=="http:" || url.hostname!=="127.0.0.1" || !url.port || url.username || url.password || url.pathname!=="/" || url.search || url.hash)throw new Error("Invalid development gateway");
    return url.origin;
  } catch { return "http://127.0.0.1:4311"; }
}
const gateway=developmentGateway();

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
        target: gateway,
        configure(proxy) {
          // Browser requests are same-origin with Vite, so they do not carry
          // an Origin header. Inject the exact dev-server origin at this
          // trusted reverse-proxy boundary; the Host allowlist remains strict.
          proxy.on("proxyReq", (proxyRequest) => {
            proxyRequest.setHeader("origin", gateway);
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
