import {
  BoundedJsonSchemaSchema,
  MCP_CONFIG_VERSION,
  McpConfigSchema,
  McpServerConfigSchema,
  McpServerFailedDataSchema,
  McpServerStartedDataSchema,
  McpServerStatusSchema,
  McpServerStoppedDataSchema,
  McpToolsChangedDataSchema,
  McpToolCalledDataSchema,
  McpToolCatalogEntrySchema,
  McpStatusSnapshotSchema,
  type McpConfig,
  type McpJsonSchema,
  type McpServerConfig,
  type McpServerStatus,
  type McpToolCatalogEntry,
  type McpToolsChangedData,
} from "@tracegraph/contracts";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";
import { sha256 } from "../crypto.js";
import { RawToolResultSchema } from "../tool-registry.js";
import type { Disposable, TraceGraphExtension } from "../extension.js";
import type { McpToolBridge, RawToolResult, ToolDefinition } from "../types.js";
import { McpProtocolError, McpStdioClient, type McpClientOptions, type McpRemoteTool } from "./client.js";

export const MCP_EXTENSION_NAME = "@tracegraph/mcp-stdio" as const;
export const MCP_EXTENSION_API_VERSION = "tracegraph.extension.v1" as const;
export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 30_000;

export interface McpManagerEvent {
  readonly type:
    | "mcp.server_started"
    | "mcp.server_failed"
    | "mcp.server_stopped"
    | "mcp.tools_changed"
    | "mcp.tool_called";
  readonly occurred_at: string;
  readonly data: Record<string, unknown>;
}

export interface McpManagerOptions {
  readonly config: McpConfig;
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly resolveSecret?: (reference: string) => Promise<string>;
  readonly now?: () => Date;
  readonly requestTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
  readonly clientFactory?: (
    config: McpServerConfig,
    options: McpClientOptions,
  ) => McpStdioClient;
}

interface ServerRecord {
  readonly config: McpServerConfig;
  client: McpStdioClient | undefined;
  status: McpServerStatus;
  tools: Map<string, McpToolCatalogEntry>;
}

export class McpStartupError extends Error {
  readonly serverName: string;
  readonly required: boolean;
  readonly code: string;

  constructor(serverName: string, required: boolean, code: string, message: string) {
    super(message);
    this.name = "McpStartupError";
    this.serverName = serverName;
    this.required = required;
    this.code = code;
  }
}

/**
 * Process-local MCP lifecycle manager. It owns one stdio client per server,
 * keeps optional failures degraded, and exposes only bounded catalog/status
 * data to the rest of TraceGraph.
 */
export class McpManager {
  readonly #config: McpConfig;
  readonly #cwd: string | undefined;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #resolveSecret: (reference: string) => Promise<string>;
  readonly #now: () => Date;
  readonly #requestTimeoutMs: number;
  readonly #toolTimeoutMs: number;
  readonly #clientFactory: NonNullable<McpManagerOptions["clientFactory"]>;
  readonly #servers = new Map<string, ServerRecord>();
  readonly #listeners = new Set<(event: McpManagerEvent) => void | Promise<void>>();
  readonly #history: McpManagerEvent[] = [];
  #mutationQueue: Promise<void> = Promise.resolve();
  #started = false;

  constructor(options: McpManagerOptions) {
    this.#config = McpConfigSchema.parse(options.config);
    this.#cwd = options.cwd;
    this.#environment = { ...(options.environment ?? process.env) };
    this.#resolveSecret = options.resolveSecret ?? (async () => {
      throw new Error("MCP secret resolver is unavailable");
    });
    this.#now = options.now ?? (() => new Date());
    this.#requestTimeoutMs = boundedTimeout(options.requestTimeoutMs ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS, "requestTimeoutMs");
    this.#toolTimeoutMs = boundedTimeout(options.toolTimeoutMs ?? DEFAULT_MCP_TOOL_TIMEOUT_MS, "toolTimeoutMs");
    this.#clientFactory = options.clientFactory ?? ((config, clientOptions) => new McpStdioClient(config, clientOptions));
    for (const config of this.#config.servers) {
      this.#servers.set(config.name, {
        config,
        client: undefined,
        status: this.#status(config, "stopped", [], {
          error_code: "mcp_not_started",
          error_message: "MCP server has not been started",
        }),
        tools: new Map(),
      });
    }
  }

  get config(): McpConfig {
    return this.#config;
  }

  get toolTimeoutMs(): number {
    return this.#toolTimeoutMs;
  }

  onEvent(listener: (event: McpManagerEvent) => void | Promise<void>): Disposable {
    this.#listeners.add(listener);
    return { dispose: () => { this.#listeners.delete(listener); } };
  }

  listStatuses(): readonly McpServerStatus[] {
    return [...this.#servers.values()]
      .map(({ status }) => McpServerStatusSchema.parse(structuredClone(status)))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  snapshot(): ReturnType<typeof McpStatusSnapshotSchema.parse> {
    return McpStatusSnapshotSchema.parse({
      config_version: MCP_CONFIG_VERSION,
      servers: this.listStatuses(),
      updated_at: this.#now().toISOString(),
    });
  }

  listTools(): readonly McpToolCatalogEntry[] {
    return [...this.#servers.values()]
      .flatMap(({ tools }) => [...tools.values()])
      .sort((left, right) => left.qualified_name.localeCompare(right.qualified_name));
  }

  history(): readonly McpManagerEvent[] {
    return this.#history.map((event) => Object.freeze({
      ...event,
      data: structuredClone(event.data),
    }));
  }

  async start(): Promise<ReturnType<typeof McpStatusSnapshotSchema.parse>> {
    return this.#serialize(async () => {
      if (this.#started) return this.snapshot();
      this.#started = true;
      const started: ServerRecord[] = [];
      try {
        for (const record of this.#servers.values()) {
          try {
            await this.#startRecord(record);
            if (record.status.state === "ready") started.push(record);
          } catch (error) {
            if (record.config.required) {
              for (const previous of started.reverse()) await this.#stopRecord(previous, "required_server_failed");
              this.#started = false;
              throw error;
            }
          }
        }
        return this.snapshot();
      } catch (error) {
        this.#started = false;
        throw error;
      }
    });
  }

  async restart(serverName: string): Promise<McpServerStatus> {
    return this.#serialize(async () => {
      const record = this.#servers.get(serverName);
      if (record === undefined) throw new McpStartupError(serverName, false, "mcp_server_not_found", `MCP server ${serverName} is not configured`);
      await this.#stopRecord(record, "restart");
      try {
        await this.#startRecord(record);
      } catch (error) {
        if (record.config.required) throw error;
        // Optional servers are intentionally restartable without turning a
        // working Host into a failed command when the external process is
        // still unavailable. The degraded status is the durable answer.
      }
      return McpServerStatusSchema.parse(structuredClone(record.status));
    });
  }

  async stop(): Promise<void> {
    await this.#serialize(async () => {
      for (const record of this.#servers.values()) await this.#stopRecord(record, "host_shutdown");
      this.#started = false;
    });
  }

  async callTool(
    entry: McpToolCatalogEntry,
    argumentsValue: Record<string, unknown>,
    signal?: AbortSignal,
    eventSink?: (event: McpManagerEvent) => void | Promise<void>,
  ): Promise<RawToolResult> {
    const record = this.#servers.get(entry.server_name);
    const startedAt = Date.now();
    let result: RawToolResult;
    if (record === undefined || record.client === undefined || record.status.state !== "ready") {
      result = { status: "unknown", code: "mcp_server_unavailable", summary: `MCP server ${entry.server_name} is not ready` };
    } else {
      try {
        const raw = await record.client.callTool(entry.name, argumentsValue, signal);
        result = renderMcpResult(entry, raw);
      } catch (error) {
        result = {
          status: "failure",
          code: error instanceof McpProtocolError ? error.code : "mcp_call_failed",
          summary: safeMessage(error),
        };
      }
    }
    const resultBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    const data = McpToolCalledDataSchema.parse({
      server_name: entry.server_name,
      tool_name: entry.name,
      qualified_name: entry.qualified_name,
      arguments_hash: sha256(JSON.stringify(argumentsValue)),
      duration_ms: Math.max(0, Date.now() - startedAt),
      result_bytes: resultBytes,
      status: result.status,
      code: result.code,
    });
    await this.#emit({ type: "mcp.tool_called", occurred_at: this.#now().toISOString(), data });
    await eventSink?.({ type: "mcp.tool_called", occurred_at: this.#now().toISOString(), data });
    return result;
  }

  toolDefinition(entry: McpToolCatalogEntry): ToolDefinition {
    const manager = this;
    return {
      name: entry.qualified_name,
      description: `MCP ${entry.server_name} tool: ${entry.description}`,
      inputSchema: z.record(z.string(), z.unknown()),
      modelInputSchema: entry.input_schema,
      outputSchema: RawToolResultSchema,
      capability: "read",
      requiresApproval: false,
      timeoutMs: this.#toolTimeoutMs,
      concurrencySafe: entry.side_effect === "none" || entry.side_effect === "read",
      sideEffect: entry.side_effect,
      maxResultBytes: 128 * 1024,
      presentation: {
        callLabel: `MCP ${entry.server_name}/${entry.name}`,
        resultLabel: `MCP ${entry.name} result`,
      },
      async execute(input, context) {
        const bridge = context.mcp as McpToolBridge | undefined;
        return bridge === undefined
          ? manager.callTool(entry, input as Record<string, unknown>, context.signal)
          : bridge.call(entry, input as Record<string, unknown>, context.signal);
      },
      render(_input, output) { return output; },
    };
  }

  async #startRecord(record: ServerRecord): Promise<void> {
    const config = McpServerConfigSchema.parse(record.config);
    record.status = this.#status(config, "spawning", []);
    const environment = await this.#resolveEnvironment(config.env);
    const client = this.#clientFactory(config, {
      ...(this.#cwd === undefined ? {} : { cwd: this.#cwd }),
      env: { ...this.#environment, ...environment },
      requestTimeoutMs: this.#requestTimeoutMs,
      onToolsChanged: () => this.#serialize(() => this.#refreshRecord(record)),
      onExit: (info) => this.#serialize(async () => {
        if (info.expected || record.client !== client || record.status.state !== "ready") return;
        const removed = [...record.tools.values()].map(({ qualified_name }) => qualified_name).sort();
        record.client = undefined;
        record.tools.clear();
        record.status = this.#status(config, "degraded", [], {
          error_code: "mcp_process_exited",
          error_message: `MCP process exited (${info.code === null ? info.signal ?? "unknown" : info.code})`,
        });
        if (removed.length > 0) {
          await this.#emit({
            type: "mcp.tools_changed",
            occurred_at: this.#now().toISOString(),
            data: McpToolsChangedDataSchema.parse({
              server_name: config.name,
              added: [],
              removed,
              tool_count: 0,
            }),
          });
        }
        await this.#emit({
          type: "mcp.server_failed",
          occurred_at: this.#now().toISOString(),
          data: McpServerFailedDataSchema.parse({
            server_name: config.name,
            required: config.required,
            error_code: "mcp_process_exited",
          }),
        });
      }),
    });
    record.client = client;
    record.status = this.#status(config, "initializing", []);
    try {
      const remoteTools = await client.start();
      const mapped = mapTools(config, remoteTools);
      record.tools.clear();
      for (const entry of mapped) record.tools.set(entry.name, entry);
      record.status = this.#status(config, "ready", mapped);
      await this.#emit({
        type: "mcp.server_started",
        occurred_at: this.#now().toISOString(),
        data: McpServerStartedDataSchema.parse({
          server_name: config.name,
          required: config.required,
          transport: config.transport,
          tool_count: mapped.length,
        }),
      });
    } catch (error) {
      const code = error instanceof McpProtocolError ? error.code : "mcp_start_failed";
      const stderrTail = client.stderrTail;
      await client.stop("start_failed").catch(() => undefined);
      record.client = undefined;
      record.tools.clear();
      record.status = this.#status(config, "degraded", [], {
        error_code: code,
        error_message: safeMessage(error),
        ...(stderrTail ? { stderr_tail: stderrTail } : {}),
      });
      await this.#emit({
        type: "mcp.server_failed",
        occurred_at: this.#now().toISOString(),
        data: McpServerFailedDataSchema.parse({
          server_name: config.name,
          required: config.required,
          error_code: code,
          ...(stderrTail ? { stderr_tail: stderrTail } : {}),
        }),
      });
      throw new McpStartupError(config.name, config.required, code, `${config.name}: ${safeMessage(error)}${stderrTail ? `; stderr: ${stderrTail}` : ""}`);
    }
  }

  async #stopRecord(record: ServerRecord, reason: string): Promise<void> {
    const client = record.client;
    if (client !== undefined) await client.stop(reason).catch(() => undefined);
    record.client = undefined;
    record.tools.clear();
    record.status = this.#status(record.config, "stopped", [], {
      error_code: "mcp_server_stopped",
      error_message: reason,
    });
    await this.#emit({
      type: "mcp.server_stopped",
      occurred_at: this.#now().toISOString(),
      data: McpServerStoppedDataSchema.parse({ server_name: record.config.name, reason }),
    });
  }

  async #refreshRecord(record: ServerRecord): Promise<void> {
    if (record.client === undefined || record.status.state !== "ready") return;
    try {
      const mapped = mapTools(record.config, await record.client.listTools());
      const before = new Set([...record.tools.values()].map(({ qualified_name }) => qualified_name));
      const after = new Set(mapped.map(({ qualified_name }) => qualified_name));
      record.tools.clear();
      for (const entry of mapped) record.tools.set(entry.name, entry);
      record.status = this.#status(record.config, "ready", mapped);
      const data: McpToolsChangedData = McpToolsChangedDataSchema.parse({
        server_name: record.config.name,
        added: [...after].filter((name) => !before.has(name)).sort(),
        removed: [...before].filter((name) => !after.has(name)).sort(),
        tool_count: mapped.length,
      });
      await this.#emit({ type: "mcp.tools_changed", occurred_at: this.#now().toISOString(), data });
    } catch (error) {
      const code = error instanceof McpProtocolError ? error.code : "mcp_tools_refresh_failed";
      const removed = [...record.tools.values()].map(({ qualified_name }) => qualified_name).sort();
      record.tools.clear();
      record.status = this.#status(record.config, "degraded", [...record.tools.values()], {
        error_code: code,
        error_message: safeMessage(error),
      });
      if (removed.length > 0) {
        await this.#emit({
          type: "mcp.tools_changed",
          occurred_at: this.#now().toISOString(),
          data: McpToolsChangedDataSchema.parse({
            server_name: record.config.name,
            added: [],
            removed,
            tool_count: 0,
          }),
        });
      }
      await this.#emit({
        type: "mcp.server_failed",
        occurred_at: this.#now().toISOString(),
        data: McpServerFailedDataSchema.parse({
          server_name: record.config.name,
          required: record.config.required,
          error_code: code,
        }),
      });
    }
  }

  async #resolveEnvironment(values: Record<string, string>): Promise<Record<string, string>> {
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      const match = /^\$\{secret:([A-Z][A-Z0-9_]*)\}$/u.exec(value);
      resolved[key] = match === null ? value : await this.#resolveSecret(value);
    }
    return resolved;
  }

  #status(
    config: McpServerConfig,
    state: McpServerStatus["state"],
    tools: readonly McpToolCatalogEntry[],
    error?: { error_code: string; error_message: string; stderr_tail?: string },
  ): McpServerStatus {
    return McpServerStatusSchema.parse({
      name: config.name,
      required: config.required,
      transport: config.transport,
      state,
      tool_count: tools.length,
      tools,
      updated_at: this.#now().toISOString(),
      ...(error ?? {}),
    });
  }

  async #emit(event: McpManagerEvent): Promise<void> {
    this.#history.push(Object.freeze({ ...event, data: structuredClone(event.data) }));
    if (this.#history.length > 512) this.#history.splice(0, this.#history.length - 512);
    for (const listener of [...this.#listeners]) {
      try { await listener(Object.freeze({ ...event, data: structuredClone(event.data) })); }
      catch { /* an observer cannot break MCP lifecycle */ }
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationQueue.then(operation, operation);
    this.#mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function createMcpToolsExtension(manager: McpManager): TraceGraphExtension {
  const registrations = new Map<string, Disposable>();
  let context: Parameters<TraceGraphExtension["activate"]>[0] | undefined;
  let listener: Disposable | undefined;
  const sync = async (): Promise<void> => {
    if (context === undefined) return;
    const next = new Map(manager.listTools().map((entry) => [entry.qualified_name, entry]));
    for (const [name, disposable] of [...registrations]) {
      if (next.has(name)) continue;
      try { await disposable.dispose(); } catch { return; }
      registrations.delete(name);
    }
    for (const [name, entry] of next) {
      if (registrations.has(name)) continue;
      try { registrations.set(name, context.registerTool(manager.toolDefinition(entry))); }
      catch { /* active Run leases defer the next refresh/restart */ }
    }
  };
  return {
    name: MCP_EXTENSION_NAME,
    api_version: MCP_EXTENSION_API_VERSION,
    async activate(nextContext) {
      context = nextContext;
      await sync();
      listener = manager.onEvent((event) => event.type === "mcp.tools_changed" ? sync() : undefined);
    },
    async deactivate() {
      listener?.dispose();
      listener = undefined;
      for (const registration of registrations.values()) await Promise.resolve(registration.dispose()).catch(() => undefined);
      registrations.clear();
      context = undefined;
    },
  };
}

export async function readMcpConfig(path: string): Promise<McpConfig> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return McpConfigSchema.parse({ config_version: MCP_CONFIG_VERSION, servers: [] });
    throw new Error(`MCP config must be a regular, non-symlink file: ${path}`, { cause: error });
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`MCP config must be a regular file: ${path}`);
    if (stat.size > 256 * 1024) throw new Error(`MCP config exceeds 256 KiB: ${path}`);
    const parsed = JSON.parse(await handle.readFile({ encoding: "utf8" }));
    return McpConfigSchema.parse(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) throw new Error(`MCP config is invalid: ${error.message}`, { cause: error });
    throw error;
  } finally {
    await handle.close();
  }
}

function mapTools(config: McpServerConfig, remoteTools: readonly McpRemoteTool[]): McpToolCatalogEntry[] {
  const allow = config.tool_policy?.allow === undefined ? undefined : new Set(config.tool_policy.allow);
  const deny = new Set(config.tool_policy?.deny ?? []);
  const mapped: McpToolCatalogEntry[] = [];
  const qualified = new Set<string>();
  for (const remote of remoteTools) {
    if (allow !== undefined && !allow.has(remote.name)) continue;
    if (deny.has(remote.name)) continue;
    const qualifiedName = qualifiedMcpToolName(config.name, remote.name);
    if (qualified.has(qualifiedName)) throw new McpProtocolError("mcp_tool_name_conflict", `MCP tool name conflict: ${qualifiedName}`);
    qualified.add(qualifiedName);
    const inputSchema = BoundedJsonSchemaSchema.parse(remote.inputSchema);
    if (inputSchema.type !== "object") throw new McpProtocolError("mcp_tool_schema_invalid", `MCP tool ${remote.name} input must be an object`);
    const sideEffect = remote.destructiveHint === true ? "write" : remote.readOnlyHint === true ? "read" : "write";
    mapped.push(McpToolCatalogEntrySchema.parse({
      server_name: config.name,
      name: remote.name,
      qualified_name: qualifiedName,
      description: remote.description,
      input_schema: inputSchema,
      side_effect: sideEffect,
      ...(remote.readOnlyHint === undefined ? {} : { read_only_hint: remote.readOnlyHint }),
      ...(remote.destructiveHint === undefined ? {} : { destructive_hint: remote.destructiveHint }),
    }));
  }
  return mapped.sort((left, right) => left.qualified_name.localeCompare(right.qualified_name));
}

function qualifiedMcpToolName(serverName: string, toolName: string): string {
  const normalized = toolName.replace(/[^A-Za-z0-9_.:-]/gu, "_");
  const qualified = `mcp_${serverName}__${normalized}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(qualified) || qualified.length > 160) {
    throw new McpProtocolError("mcp_tool_name_invalid", `MCP tool name cannot be represented: ${toolName}`);
  }
  return qualified;
}

function renderMcpResult(entry: McpToolCatalogEntry, raw: unknown): RawToolResult {
  if (!isRecord(raw)) return { status: "unknown", code: "mcp_result_invalid", summary: `MCP ${entry.name} returned an invalid result` };
  const isError = raw.isError === true;
  const chunks = Array.isArray(raw.content) ? raw.content : [];
  const text = chunks
    .filter((item): item is Record<string, unknown> => isRecord(item) && item.type === "text" && typeof item.text === "string")
    .map((item) => String(item.text))
    .join("\n");
  const structured = raw.structuredContent === undefined ? undefined : JSON.stringify(raw.structuredContent);
  const content = [text, structured].filter((value): value is string => value !== undefined && value.length > 0).join("\n");
  return {
    status: isError ? "failure" : "success",
    code: isError ? "mcp_remote_error" : "mcp_tool_completed",
    summary: isError ? `MCP ${entry.name} reported an error` : `MCP ${entry.name} completed`,
    ...(content.length === 0 ? {} : { content: content.slice(0, 120_000), mimeType: "text/plain" }),
    facts: { server_name: entry.server_name, tool_name: entry.name, is_error: isError },
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedTimeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 300_000) throw new RangeError(`${label} must be between 100 and 300000 ms`);
  return value;
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "MCP operation failed").replace(/[\r\n]+/gu, " ").slice(0, 1_000);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
