import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { McpConfigSchema, type McpHttpServerConfig } from "@tracegraph/contracts";
import { McpHttpClient } from "./http-client.js";
import { McpManager } from "./manager.js";

async function server(handler: (request: IncomingMessage, response: ServerResponse, body: any) => void | Promise<void>) {
  const service = createServer((request, response) => { void (async () => {
    let text = ""; for await (const chunk of request) text += String(chunk);
    await handler(request, response, text ? JSON.parse(text) : undefined);
  })().catch(() => response.destroy()); });
  service.listen(0, "127.0.0.1"); await once(service, "listening");
  const address = service.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}/mcp`, close: async () => { service.closeAllConnections(); await new Promise<void>(resolve => service.close(() => resolve())); } };
}
const config = (url: string): McpHttpServerConfig => ({ name: "remote", transport: "streamable-http", url, required: false, authorization_ref: "${secret:REMOTE_TOKEN}" });
const result = (response: ServerResponse, body: any, value: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: value })); };
const tools = { tools: [{ name: "increment", description: "Increment the external counter", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } }] };

describe("Streamable HTTP MCP real external effects", () => {
  it("negotiates session, authenticates, accepts SSE and never trusts remote read-only hints", async () => {
    let counter = 0, deleted = false;
    const received: Array<{ method: string; session: string | undefined; version: string | undefined }> = [];
    const service = await server((request, response, body) => {
      expect(request.headers.authorization).toBe("Bearer private-test-value");
      if (request.method === "DELETE") { deleted = true; expect(request.headers["mcp-session-id"]).toBe("session-1"); response.writeHead(204); response.end(); return; }
      expect(request.headers.accept).toBe("application/json, text/event-stream");
      received.push({ method: body.method, session: request.headers["mcp-session-id"] as string | undefined, version: request.headers["mcp-protocol-version"] as string | undefined });
      if (body.method === "initialize") { response.setHeader("Mcp-Session-Id", "session-1"); result(response, body, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "real-test-server", version: "1" } }); }
      else if (body.method === "notifications/initialized") { response.writeHead(202); response.end(); }
      else if (body.method === "tools/list") result(response, body, tools);
      else { counter++; response.writeHead(200, { "content-type": "text/event-stream" }); response.write(`event: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\r\n\r\n`); response.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: String(counter) }] } })}\n\n`); }
    });
    const manager = new McpManager({ config: { config_version: "tracegraph.mcp.v1", servers: [config(service.url)] }, resolveSecret: async reference => { expect(reference).toBe("${secret:REMOTE_TOKEN}"); return "private-test-value"; } });
    try {
      expect((await manager.start()).servers[0]?.state).toBe("ready");
      const tool = manager.listTools()[0]!; expect(tool.side_effect).toBe("write");
      expect(await manager.callTool(tool, {})).toMatchObject({ status: "success", content: "1" });
      expect(counter).toBe(1);
      expect(received.slice(1).every(request => request.session === "session-1" && request.version === "2025-06-18")).toBe(true);
      expect(JSON.stringify(manager.snapshot())).not.toContain("private-test-value");
      await manager.stop(); expect(deleted).toBe(true);
    } finally { await manager.stop(); await service.close(); }
  });
  it("records disconnected post-dispatch writes as unknown and does not resend", async () => {
    let writes = 0;
    const service = await server((_request, response, body) => {
      if (body.method === "initialize") result(response, body, { protocolVersion: "2025-06-18" });
      else if (body.method === "notifications/initialized") { response.writeHead(202); response.end(); }
      else if (body.method === "tools/list") result(response, body, tools);
      else { writes++; response.destroy(); }
    });
    const manager = new McpManager({ config: { config_version: "tracegraph.mcp.v1", servers: [{ ...config(service.url), authorization_ref: undefined }] } });
    try { await manager.start(); const response = await manager.callTool(manager.listTools()[0]!, {}); expect(response).toMatchObject({ status: "unknown", code: "mcp_effect_unknown" }); expect(writes).toBe(1); expect(manager.history().at(-1)?.data.status).toBe("unknown"); }
    finally { await manager.stop(); await service.close(); }
  });
  it("rejects redirects and does not expose echoed remote credentials", async () => {
    let redirected = 0;
    const destination = await server((_request, response) => { redirected++; response.end(); });
    const origin = await server((_request, response) => { response.writeHead(307, { location: destination.url }); response.end("private-test-value"); });
    const client = new McpHttpClient(config(origin.url), { env: {}, authorization: "private-test-value" });
    try { await expect(client.start()).rejects.toMatchObject({ code: "mcp_transport_failed" }); expect(redirected).toBe(0); }
    finally { await client.stop(); await origin.close(); await destination.close(); }
  });
  it("isolates failed required features in product mode without changing strict legacy mode", async () => {
    const service = await server((_request, response, body) => {
      if (body.method === "initialize") result(response, body, { protocolVersion: "2025-06-18" });
      else if (body.method === "notifications/initialized") { response.writeHead(202); response.end(); }
      else result(response, body, tools);
    });
    const entries = [{ ...config(service.url), authorization_ref: undefined }, { name: "broken", transport: "stdio" as const, command: "outlive-test-command-that-does-not-exist", required: true }];
    const manager = new McpManager({ config: McpConfigSchema.parse({ config_version: "tracegraph.mcp.v1", servers: entries }), isolateStartupFailures: true });
    try { const snapshot = await manager.start(); expect(snapshot.servers.find(entry => entry.name === "remote")?.state).toBe("ready"); expect(snapshot.servers.find(entry => entry.name === "broken")?.state).toBe("degraded"); expect(manager.listTools()).toHaveLength(1); }
    finally { await manager.stop(); await service.close(); }
  });
  it("validates remote endpoint and requires credential references", () => {
    const parse = (extra: object) => McpConfigSchema.parse({ config_version: "tracegraph.mcp.v1", servers: [{ ...config("https://example.test/mcp"), ...extra }] });
    expect(() => parse({ url: "http://example.test/mcp" })).toThrow();
    expect(() => parse({ url: "https://secret@example.test/mcp" })).toThrow();
    expect(() => parse({ authorization_ref: "plaintext-token" })).toThrow();
    expect(() => parse({ command: "node" })).toThrow();
    expect(() => parse({ url: "https://example.test/mcp?api_key=secret" })).toThrow();
  });
  it.each(["timeout", "cancel"] as const)("asks to cancel a %s after dispatch, without assuming rollback or resending", async mode => {
    let writes = 0, cancelled: number | undefined, callId: number | undefined;
    let entered!: () => void;
    const dispatched = new Promise<void>(resolve => { entered = resolve; });
    const service = await server((_request, response, body) => {
      if (body.method === "initialize") result(response, body, { protocolVersion: "2025-06-18" });
      else if (body.method === "notifications/initialized") { response.writeHead(202); response.end(); }
      else if (body.method === "tools/list") result(response, body, tools);
      else if (body.method === "notifications/cancelled") { cancelled = body.params.requestId; response.writeHead(202); response.end(); }
      else { writes++; callId = body.id; entered(); /* Deliberately leave response open after the external effect. */ }
    });
    const client = new McpHttpClient({ ...config(service.url), authorization_ref: undefined }, { env: {}, requestTimeoutMs: mode === "timeout" ? 100 : 5_000 });
    const controller = new AbortController();
    try {
      await client.start();
      const call = client.callTool("increment", {}, controller.signal);
      const outcome = expect(call).rejects.toMatchObject({ code: "mcp_effect_unknown" });
      await dispatched;
      if (mode === "cancel") controller.abort();
      await outcome;
      expect(writes).toBe(1); expect(cancelled).toBe(callId);
      const preCancelled = new AbortController(); preCancelled.abort();
      await expect(client.callTool("increment", {}, preCancelled.signal)).rejects.toMatchObject({ code: "mcp_request_aborted" });
      expect(writes).toBe(1);
    } finally { await client.stop(); await service.close(); }
  });
  it("keeps a server error after an actual write unknown", async () => {
    let writes = 0;
    const service = await server((_request, response, body) => {
      if (body.method === "initialize") result(response, body, { protocolVersion: "2025-06-18" });
      else if (body.method === "notifications/initialized") { response.writeHead(202); response.end(); }
      else if (body.method === "tools/list") result(response, body, tools);
      else { writes++; response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "secret-server-error" } })); }
    });
    const client = new McpHttpClient({ ...config(service.url), authorization_ref: undefined }, { env: {} });
    try { await client.start(); await expect(client.callTool("increment", {})).rejects.toMatchObject({ code: "mcp_effect_unknown" }); expect(writes).toBe(1); }
    finally { await client.stop(); await service.close(); }
  });
});
