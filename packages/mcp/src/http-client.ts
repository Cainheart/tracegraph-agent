import { type McpHttpServerConfig } from "@tracegraph/contracts";
import { McpProtocolError, parseRemoteTool, type McpClientOptions, type McpClientPort, type McpRemoteTool } from "./client.js";

const PROTOCOL = "2025-06-18";
const VERSIONS = new Set([PROTOCOL, "2025-03-26", "2024-11-05"]);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
type Message = Record<string, unknown>;
const record = (value: unknown): value is Message => typeof value === "object" && value !== null && !Array.isArray(value);

/** No tool-call retries: losing the response after dispatch is an unknown effect. */
export class McpHttpClient implements McpClientPort {
  readonly #config: McpHttpServerConfig;
  readonly #options: McpClientOptions;
  readonly #requests = new Set<AbortController>();
  #session: string | undefined;
  #protocol = PROTOCOL;
  #nextId = 1;
  #closed = true;
  constructor(config: McpHttpServerConfig, options: McpClientOptions) {
    this.#config = config;
    this.#options = options;
    if (options.authorization !== undefined && (!options.authorization || /[\r\n]/u.test(options.authorization))) {
      throw new McpProtocolError("mcp_credential_invalid", "The configured MCP credential is invalid");
    }
  }
  get stderrTail(): string { return ""; }
  get running(): boolean { return !this.#closed; }
  async start(): Promise<readonly McpRemoteTool[]> {
    if (!this.#closed) throw new McpProtocolError("mcp_client_started", "MCP client is already running");
    this.#closed = false;
    try {
      const result = await this.#request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "outlive-agent", version: "0.1.0-alpha.0" } });
      if (!record(result) || typeof result.protocolVersion !== "string" || !VERSIONS.has(result.protocolVersion)) {
        throw new McpProtocolError("mcp_protocol_unsupported", "The MCP server selected an unsupported protocol version");
      }
      this.#protocol = result.protocolVersion;
      await this.#request("notifications/initialized", {}, undefined, true);
      return await this.listTools();
    } catch (error) { await this.stop("initialization_failed"); throw error; }
  }
  async listTools(): Promise<readonly McpRemoteTool[]> {
    const result = await this.#request("tools/list", {});
    if (!record(result) || !Array.isArray(result.tools) || result.tools.length > 256) {
      throw new McpProtocolError("mcp_tools_invalid", "MCP tools/list response is invalid");
    }
    // Partial catalogs must not silently hide tools behind pagination.
    if (result.nextCursor !== undefined) throw new McpProtocolError("mcp_catalog_paginated", "The configured MCP catalog requires pagination beyond this client's supported scope");
    return result.tools.map(parseRemoteTool);
  }
  callTool(name: string, argumentsValue: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.#request("tools/call", { name, arguments: argumentsValue }, signal);
  }
  async stop(_reason = "stopped"): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const request of this.#requests) request.abort();
    const session = this.#session;
    this.#session = undefined;
    if (session !== undefined) {
      try {
        const response = await (this.#options.fetch ?? fetch)(this.#config.url, { method: "DELETE", headers: this.#headers(session), redirect: "error", signal: AbortSignal.timeout(2_000) });
        await response.body?.cancel();
      } catch { /* Explicit shutdown never repeats a remote operation. */ }
    }
  }
  #headers(session = this.#session): Record<string, string> {
    return { "content-type": "application/json", accept: "application/json, text/event-stream", "MCP-Protocol-Version": this.#protocol,
      ...(session === undefined ? {} : { "Mcp-Session-Id": session }),
      ...(this.#options.authorization === undefined ? {} : { authorization: `Bearer ${this.#options.authorization}` }) };
  }
  async #request(method: string, params: unknown, signal?: AbortSignal, notification = false): Promise<unknown> {
    if (this.#closed) throw new McpProtocolError("mcp_client_unavailable", "MCP server is not connected");
    if (signal?.aborted) throw new McpProtocolError("mcp_request_aborted", "MCP request was cancelled before dispatch");
    const controller = new AbortController();
    this.#requests.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, Math.max(100, this.#options.requestTimeoutMs ?? 15_000));
    timer.unref();
    const id = this.#nextId++;
    let dispatched = false;
    try {
      dispatched = true;
      const response = await (this.#options.fetch ?? fetch)(this.#config.url, {
        method: "POST", headers: this.#headers(), redirect: "error", signal: controller.signal,
        body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        // Authentication and invalid/missing session are closed rejections. Never retry here.
        if ([400, 401, 403, 404, 405].includes(response.status)) {
          throw new McpProtocolError(response.status === 401 || response.status === 403 ? "mcp_auth_required" : "mcp_request_rejected", `MCP server rejected the request (${response.status})`);
        }
        throw new McpProtocolError("mcp_effect_unknown", "MCP server did not confirm the operation outcome");
      }
      if (method === "initialize") {
        const session = response.headers.get("Mcp-Session-Id");
        if (session !== null) {
          if (!/^[\x21-\x7e]{1,1024}$/u.test(session)) throw new McpProtocolError("mcp_session_invalid", "MCP server returned an invalid session identifier");
          this.#session = session;
        }
      }
      if (notification) {
        await response.body?.cancel();
        if (response.status !== 202) throw new McpProtocolError("mcp_notification_invalid", "MCP server did not acknowledge the notification");
        return undefined;
      }
      const kind = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (kind !== "application/json" && kind !== "text/event-stream") {
        await response.body?.cancel();
        throw new McpProtocolError("mcp_response_invalid", "MCP response has an unsupported content type");
      }
      if (!response.body) throw new McpProtocolError("mcp_response_invalid", "MCP response has no body");
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let buffer = "", bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) throw new McpProtocolError("mcp_response_too_large", "MCP response exceeds the bounded limit");
          buffer += decoder.decode(chunk.value, { stream: true });
          if (kind === "application/json") continue;
          let boundary: RegExpExecArray | null;
          while ((boundary = /\r?\n\r?\n/u.exec(buffer)) !== null) {
            const event = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            const data = event.split(/\r?\n/u).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /u, "")).join("\n");
            if (!data) continue;
            const result = this.#message(JSON.parse(data), id);
            if (result !== undefined) return result.value;
          }
        }
        buffer += decoder.decode();
        if (kind === "application/json") {
          const result = this.#message(JSON.parse(buffer), id);
          if (result !== undefined) return result.value;
        }
        throw new McpProtocolError("mcp_response_incomplete", "MCP stream ended without a matching response");
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    } catch (error) {
      // Do not expose arbitrary fetch/server errors: they can echo credentials or private URLs.
      if (method === "tools/call" && dispatched && error instanceof McpProtocolError && error.code === "mcp_remote_error") {
        throw new McpProtocolError("mcp_effect_unknown", "MCP server reported an error after dispatch; inspect the external state before retrying");
      }
      if (error instanceof McpProtocolError && !["mcp_response_invalid", "mcp_response_incomplete", "mcp_response_too_large"].includes(error.code)) throw error;
      throw new McpProtocolError(method === "tools/call" && dispatched ? "mcp_effect_unknown" : controller.signal.aborted ? "mcp_request_timeout" : "mcp_transport_failed", method === "tools/call" && dispatched ? "MCP operation outcome is unknown; inspect the external state before retrying" : "MCP connection failed; check the configured address, credential and connection");
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", abort); this.#requests.delete(controller);
      // Disconnecting the stream does not cancel a remote operation. Ask explicitly,
      // while retaining unknown effect status: acknowledgement is not rollback.
      if (controller.signal.aborted && dispatched && !notification && !this.#closed) await this.#cancel(id);
    }
  }
  async #cancel(requestId: number): Promise<void> {
    try {
      const response = await (this.#options.fetch ?? fetch)(this.#config.url, {
        method: "POST", headers: this.#headers(), redirect: "error", signal: AbortSignal.timeout(1_000),
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId, reason: "Client stopped waiting for this request" } }),
      });
      await response.body?.cancel();
    } catch { /* Cancellation acknowledgement cannot settle the original effect. */ }
  }
  #message(value: unknown, id: number): { value: unknown } | undefined {
    if (!record(value) || value.jsonrpc !== "2.0") throw new McpProtocolError("mcp_response_invalid", "MCP message is invalid");
    if (value.id === undefined) {
      if (value.method === "notifications/tools/list_changed") void Promise.resolve(this.#options.onToolsChanged?.()).catch(() => undefined);
      return undefined;
    }
    if (value.id !== id) return undefined;
    if (record(value.error)) throw new McpProtocolError("mcp_remote_error", "MCP server reported an operation error; inspect server diagnostics");
    if (!("result" in value)) throw new McpProtocolError("mcp_response_invalid", "MCP response has no result");
    return { value: value.result };
  }
}
