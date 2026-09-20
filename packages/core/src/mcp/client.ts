import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { McpToolCatalogEntrySchema, type McpServerConfig, type McpToolCatalogEntry, type McpJsonSchema } from "@tracegraph/contracts";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const MAX_LINE_BYTES = 512 * 1024;
const MAX_TOOLS_RESULT_BYTES = 2 * 1024 * 1024;

export interface McpRemoteTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: McpJsonSchema;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
}

export interface McpClientOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly requestTimeoutMs?: number;
  readonly onToolsChanged?: () => void | Promise<void>;
  readonly onExit?: (info: {
    code: number | null;
    signal: NodeJS.Signals | null;
    expected: boolean;
  }) => void | Promise<void>;
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
    options: { cwd?: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"]; shell: false },
  ) => ChildProcessWithoutNullStreams;
}

interface JsonRpcResponse {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly result?: unknown;
  readonly error?: { code?: unknown; message?: unknown; data?: unknown };
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class McpProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "McpProtocolError";
    this.code = code;
  }
}

/** One MCP server maps to one stdio JSON-RPC client. */
export class McpStdioClient {
  readonly #config: McpServerConfig;
  readonly #options: McpClientOptions;
  readonly #pending = new Map<number, PendingRequest>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #nextId = 1;
  #buffer = "";
  #stderr = "";
  #closed = false;

  constructor(config: McpServerConfig, options: McpClientOptions) {
    this.#config = config;
    this.#options = options;
  }

  get stderrTail(): string {
    return this.#stderr;
  }

  get running(): boolean {
    return this.#child !== undefined && !this.#closed;
  }

  async start(): Promise<readonly McpRemoteTool[]> {
    if (this.#child !== undefined && !this.#closed) {
      throw new McpProtocolError("mcp_client_started", "MCP client is already running");
    }
    const spawnProcess = this.#options.spawnProcess ?? ((command, args, options) => spawn(command, args, options));
    this.#closed = false;
    this.#buffer = "";
    this.#stderr = "";
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnProcess(this.#config.command, this.#config.args, {
        ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
        env: this.#options.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
    } catch (error) {
      throw new McpProtocolError("mcp_spawn_failed", safeError(error));
    }
    this.#child = child;
    child.stdout.on("data", (chunk: Buffer | string) => this.#consumeStdout(String(chunk)));
    child.stderr.on("data", (chunk: Buffer | string) => this.#consumeStderr(String(chunk)));
    child.once("error", (error) => this.#failAll(new McpProtocolError("mcp_process_error", safeError(error))));
    child.once("exit", (code, signal) => {
      const expected = this.#closed;
      this.#closed = true;
      this.#failAll(new McpProtocolError(
        "mcp_process_exited",
        `MCP process exited before the request completed (${code === null ? signal ?? "unknown" : code})`,
      ));
      void Promise.resolve(this.#options.onExit?.({ code, signal, expected })).catch(() => undefined);
    });

    try {
      await this.#request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "tracegraph-agent", version: "0.1.0-alpha.0" },
      });
      this.#notify("notifications/initialized", {});
      return await this.listTools();
    } catch (error) {
      await this.stop("initialization_failed");
      throw error;
    }
  }

  async listTools(): Promise<readonly McpRemoteTool[]> {
    const result = await this.#request("tools/list", {});
    const serialized = JSON.stringify(result);
    if (serialized.length > MAX_TOOLS_RESULT_BYTES) {
      throw new McpProtocolError("mcp_tools_too_large", "MCP tools/list response exceeds the bounded limit");
    }
    if (!isRecord(result) || !Array.isArray(result.tools) || result.tools.length > 256) {
      throw new McpProtocolError("mcp_tools_invalid", "MCP tools/list response is invalid");
    }
    return result.tools.map(parseRemoteTool);
  }

  callTool(name: string, argumentsValue: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.#request("tools/call", { name, arguments: argumentsValue }, signal);
  }

  async stop(reason = "stopped"): Promise<void> {
    const child = this.#child;
    if (child === undefined) return;
    this.#closed = true;
    this.#failAll(new McpProtocolError("mcp_client_stopped", `MCP client stopped: ${reason}`));
    try { child.stdin.end(); } catch { /* best effort */ }
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGTERM"); } catch { /* best effort */ }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* best effort */ }
          resolve();
        }, 1_000);
        timer.unref();
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.#child = undefined;
  }

  async #request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const child = this.#child;
    if (child === undefined || this.#closed || child.stdin.destroyed) {
      throw new McpProtocolError("mcp_client_unavailable", "MCP server is not running");
    }
    const id = this.#nextId++;
    const timeoutMs = Math.max(100, this.#options.requestTimeoutMs ?? 15_000);
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new McpProtocolError("mcp_request_timeout", `MCP request ${method} timed out`));
      }, timeoutMs);
      timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
    });
    const abort = () => {
      const pending = this.#pending.get(id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(new McpProtocolError("mcp_request_aborted", `MCP request ${method} was aborted`));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    } catch (error) {
      abort();
      throw new McpProtocolError("mcp_write_failed", safeError(error));
    }
    try {
      return await promise;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  #notify(method: string, params: unknown): void {
    const child = this.#child;
    if (child === undefined || this.#closed || child.stdin.destroyed) return;
    try { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); } catch { /* process error will fail pending calls */ }
  }

  #consumeStdout(chunk: string): void {
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_LINE_BYTES * 2) {
      this.#failAll(new McpProtocolError("mcp_line_too_large", "MCP response buffer exceeds the bounded limit"));
      return;
    }
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
        this.#failAll(new McpProtocolError("mcp_line_too_large", "MCP response line exceeds the bounded limit"));
        return;
      }
      let parsed: JsonRpcResponse;
      try { parsed = JSON.parse(line) as JsonRpcResponse; }
      catch {
        this.#failAll(new McpProtocolError("mcp_invalid_json", "MCP server emitted invalid JSON"));
        return;
      }
      if (parsed.id === undefined) {
        if (parsed.jsonrpc === "2.0" && isRecord(parsed) && parsed.method === "notifications/tools/list_changed") {
          void Promise.resolve(this.#options.onToolsChanged?.()).catch(() => undefined);
        }
        continue;
      }
      if (typeof parsed.id !== "number") continue;
      const pending = this.#pending.get(parsed.id);
      if (pending === undefined) continue;
      clearTimeout(pending.timer);
      this.#pending.delete(parsed.id);
      if (parsed.error !== undefined) {
        pending.reject(new McpProtocolError(
          typeof parsed.error.code === "string" ? parsed.error.code : "mcp_remote_error",
          typeof parsed.error.message === "string" ? parsed.error.message.slice(0, 1_000) : "MCP server returned an error",
        ));
      } else {
        pending.resolve(parsed.result);
      }
    }
  }

  #consumeStderr(chunk: string): void {
    const normalized = chunk.replace(/\0/g, "");
    this.#stderr = `${this.#stderr}${normalized}`.slice(-4_000);
  }

  #failAll(error: unknown): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function parseRemoteTool(value: unknown): McpRemoteTool {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.description !== "string") {
    throw new McpProtocolError("mcp_tool_invalid", "MCP tools/list contains an invalid tool");
  }
  if (!isRecord(value.inputSchema) || value.inputSchema.type !== "object") {
    throw new McpProtocolError("mcp_tool_schema_invalid", `MCP tool ${value.name} must expose an object input schema`);
  }
  const inputSchema = value.inputSchema as McpJsonSchema;
  // The manager performs the full bounded schema validation; this local check
  // keeps the client from accepting an obviously unbounded remote reference.
  if ("$ref" in inputSchema || Object.keys(inputSchema).length > 64) {
    throw new McpProtocolError("mcp_tool_schema_invalid", `MCP tool ${value.name} exposes unsupported schema keys`);
  }
  return {
    name: value.name,
    description: value.description.slice(0, 2_000) || value.name,
    inputSchema,
    ...(isRecord(value.annotations) && typeof value.annotations.readOnlyHint === "boolean"
      ? { readOnlyHint: value.annotations.readOnlyHint }
      : {}),
    ...(isRecord(value.annotations) && typeof value.annotations.destructiveHint === "boolean"
      ? { destructiveHint: value.annotations.destructiveHint }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1_000) : "Unknown MCP process error";
}
