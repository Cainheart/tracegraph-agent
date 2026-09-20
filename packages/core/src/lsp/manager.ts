import {
  LspConfigSchema,
  LspDiagnosticsReceivedDataSchema,
  LspDiagnosticsRequestSchema,
  LspDiagnosticsResultSchema,
  LspDiagnosticSchema,
  LspLocationSchema,
  LspServerStatusSchema,
  LspStatusSnapshotSchema,
  LSP_CONFIG_VERSION,
  type LspConfig,
  type LspDiagnosticsRequest,
  type LspDiagnosticsResult,
  type LspLocation,
  type LspServerConfig,
  type LspServerStatus,
} from "@tracegraph/contracts";
import { constants as fsConstants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { z } from "zod";
import { sha256, stableStringify } from "../crypto.js";
import { RawToolResultSchema } from "../tool-registry.js";
import type { Disposable, TraceGraphExtension } from "../extension.js";
import type { RawToolResult, ToolDefinition } from "../types.js";
import { assertInside, resolveWorkspacePath } from "../workspace.js";
import { fileUriForPath, LspProtocolError, LspStdioClient, type LspClientOptions, type LspDiagnosticNotification } from "./client.js";

export const LSP_EXTENSION_NAME = "@tracegraph/lsp-stdio" as const;
export const LSP_EXTENSION_API_VERSION = "tracegraph.extension.v1" as const;
export const DEFAULT_LSP_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_LSP_DIAGNOSTICS_WAIT_MS = 350;

export interface LspManagerEvent {
  readonly type: "lsp.diagnostics_received" | "lsp.server_unavailable";
  readonly occurred_at: string;
  readonly data: Record<string, unknown>;
}

export interface LspDiagnosticsInput {
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly request: LspDiagnosticsRequest;
  readonly signal?: AbortSignal;
}

export interface LspManagerOptions {
  readonly config: LspConfig;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly now?: () => Date;
  readonly clientFactory?: (config: LspServerConfig, options: LspClientOptions) => LspStdioClient;
}

interface ServerRecord {
  readonly config: LspServerConfig;
  status: LspServerStatus;
}

interface SessionRecord {
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly server: ServerRecord;
  client: LspStdioClient | undefined;
  diagnostics: Map<string, ReturnType<typeof LspDiagnosticSchema.parse>[]>;
  versions: Map<string, number>;
}

const DEFAULT_LSP_CONFIG: LspConfig = LspConfigSchema.parse({
  config_version: LSP_CONFIG_VERSION,
  servers: [
    {
      name: "typescript",
      command: "typescript-language-server",
      args: ["--stdio"],
      language_ids: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
      file_extensions: [".ts", ".tsx", ".js", ".jsx"],
      request_timeout_ms: DEFAULT_LSP_REQUEST_TIMEOUT_MS,
      diagnostics_wait_ms: DEFAULT_LSP_DIAGNOSTICS_WAIT_MS,
    },
    {
      name: "pyright",
      command: "pyright-langserver",
      args: ["--stdio"],
      language_ids: ["python"],
      file_extensions: [".py"],
      request_timeout_ms: DEFAULT_LSP_REQUEST_TIMEOUT_MS,
      diagnostics_wait_ms: DEFAULT_LSP_DIAGNOSTICS_WAIT_MS,
    },
  ],
});

export function defaultLspConfig(): LspConfig {
  return LspConfigSchema.parse(structuredClone(DEFAULT_LSP_CONFIG));
}

/** Lazy, per-project LSP lifecycle and diagnostic aggregation boundary. */
export class LspManager {
  readonly #config: LspConfig;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #cwd: string | undefined;
  readonly #now: () => Date;
  readonly #clientFactory: NonNullable<LspManagerOptions["clientFactory"]>;
  readonly #servers = new Map<string, ServerRecord>();
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #listeners = new Set<(event: LspManagerEvent) => void | Promise<void>>();
  readonly #history: LspManagerEvent[] = [];

  constructor(options: LspManagerOptions) {
    this.#config = LspConfigSchema.parse(options.config);
    this.#environment = { ...(options.environment ?? process.env) };
    this.#cwd = options.cwd;
    this.#now = options.now ?? (() => new Date());
    this.#clientFactory = options.clientFactory ?? ((config, clientOptions) => new LspStdioClient(config, clientOptions));
    for (const config of this.#config.servers) {
      this.#servers.set(config.name, {
        config,
        status: this.#status(config, "stopped", 0),
      });
    }
  }

  get config(): LspConfig { return this.#config; }

  onEvent(listener: (event: LspManagerEvent) => void | Promise<void>): Disposable {
    this.#listeners.add(listener);
    return { dispose: () => { this.#listeners.delete(listener); } };
  }

  history(): readonly LspManagerEvent[] {
    return this.#history.map((event) => Object.freeze({ ...event, data: structuredClone(event.data) }));
  }

  snapshot(): ReturnType<typeof LspStatusSnapshotSchema.parse> {
    return LspStatusSnapshotSchema.parse({
      config_version: LSP_CONFIG_VERSION,
      servers: [...this.#servers.values()].map(({ status }) => status).sort((left, right) => left.name.localeCompare(right.name)),
      updated_at: this.#now().toISOString(),
    });
  }

  async diagnostics(input: LspDiagnosticsInput, eventSink?: (event: LspManagerEvent) => void | Promise<void>): Promise<LspDiagnosticsResult> {
    const request = LspDiagnosticsRequestSchema.parse(input.request);
    const workspaceRoot = await realpath(input.workspaceRoot);
    const scopedInput = workspaceRoot === input.workspaceRoot ? input : { ...input, workspaceRoot };
    const paths = [...new Set(request.paths)];
    if (paths.length === 0) {
      const cached = [...this.#sessions.values()]
        .filter((session) => session.projectId === scopedInput.projectId && session.workspaceRoot === workspaceRoot)
        .flatMap((session) => [...session.diagnostics.entries()].flatMap(([path, diagnostics]) => diagnostics.map((diagnostic) => ({ ...diagnostic, path }))));
      if (cached.length === 0) {
        return LspDiagnosticsResultSchema.parse({
          status: "unavailable",
          diagnostics: [],
          message: "No source paths were supplied and no cached LSP diagnostics are available",
        });
      }
      return this.#result(scopedInput, request, "cached", cached, 0, eventSink);
    }

    const groups = new Map<string, string[]>();
    for (const path of paths) {
      const server = this.#serverForPath(path);
      if (server === undefined) continue;
      const list = groups.get(server.config.name) ?? [];
      list.push(path);
      groups.set(server.config.name, list);
    }
    if (groups.size === 0) {
      return this.#unavailable(scopedInput, "lsp_server_unavailable", "No configured LSP server matches the requested file extensions", eventSink);
    }

    const all: ReturnType<typeof LspDiagnosticSchema.parse>[] = [];
    let filesScanned = 0;
    let availableSessions = 0;
    for (const [serverName, serverPaths] of groups) {
      const server = this.#servers.get(serverName)!;
      const session = await this.#session(scopedInput.projectId, scopedInput.workspaceRoot, server, eventSink);
      if (session === undefined) continue;
      availableSessions += 1;
      for (const path of serverPaths) {
        if (scopedInput.signal?.aborted) throw scopedInput.signal.reason instanceof Error ? scopedInput.signal.reason : new Error("LSP diagnostics were aborted");
        const absolute = await resolveWorkspacePath(this.#workspace(scopedInput), path);
        assertInside(scopedInput.workspaceRoot, absolute);
        await this.#syncDocument(session, path, absolute, scopedInput.signal);
        filesScanned += 1;
      }
      await wait(server.config.diagnostics_wait_ms, scopedInput.signal);
      for (const path of serverPaths) {
        const diagnostics = session.diagnostics.get(path) ?? [];
        all.push(...diagnostics);
      }
    }
    if (availableSessions === 0) {
      return this.#unavailable(scopedInput, "lsp_server_unavailable", "All matching LSP servers are unavailable", eventSink);
    }
    return this.#result(scopedInput, request, groups.keys().next().value ?? "unknown", all, filesScanned, eventSink);
  }

  async definition(input: { projectId: string; workspaceRoot: string; path: string; line: number; character: number; signal?: AbortSignal }): Promise<readonly LspLocation[]> {
    const server = this.#serverForPath(input.path);
    if (server === undefined) return [];
    const workspaceRoot = await realpath(input.workspaceRoot);
    const scopedInput = workspaceRoot === input.workspaceRoot ? input : { ...input, workspaceRoot };
    const session = await this.#session(scopedInput.projectId, scopedInput.workspaceRoot, this.#servers.get(server.config.name)!);
    if (session === undefined) return [];
    const absolute = await resolveWorkspacePath(this.#workspace(scopedInput), scopedInput.path);
    await this.#syncDocument(session, scopedInput.path, absolute, scopedInput.signal);
    const uri = fileUriForPath(absolute);
    const result = await session.client!.definition({ uri, line: scopedInput.line, character: scopedInput.character }, scopedInput.signal);
    return this.#locations(session, result);
  }

  async references(input: { projectId: string; workspaceRoot: string; path: string; line: number; character: number; signal?: AbortSignal }): Promise<readonly LspLocation[]> {
    const server = this.#serverForPath(input.path);
    if (server === undefined) return [];
    const workspaceRoot = await realpath(input.workspaceRoot);
    const scopedInput = workspaceRoot === input.workspaceRoot ? input : { ...input, workspaceRoot };
    const session = await this.#session(scopedInput.projectId, scopedInput.workspaceRoot, this.#servers.get(server.config.name)!);
    if (session === undefined) return [];
    const absolute = await resolveWorkspacePath(this.#workspace(scopedInput), scopedInput.path);
    await this.#syncDocument(session, scopedInput.path, absolute, scopedInput.signal);
    const uri = fileUriForPath(absolute);
    const result = await session.client!.references({ uri, line: scopedInput.line, character: scopedInput.character }, scopedInput.signal);
    return this.#locations(session, result);
  }

  async stop(): Promise<void> {
    for (const session of this.#sessions.values()) {
      if (session.client?.running === true) {
        for (const uri of session.versions.keys()) await session.client.didClose(uri).catch(() => undefined);
      }
      await session.client?.stop("host_shutdown").catch(() => undefined);
    }
    this.#sessions.clear();
    for (const record of this.#servers.values()) record.status = this.#status(record.config, "stopped", 0);
  }

  toolDefinition(): ToolDefinition {
    const manager = this;
    return {
      name: "get_diagnostics",
      description: "Read bounded semantic diagnostics from the configured Language Server for selected workspace files.",
      inputSchema: LspDiagnosticsRequestSchema,
      outputSchema: RawToolResultSchema,
      capability: "read",
      requiresApproval: false,
      timeoutMs: 30_000,
      concurrencySafe: true,
      sideEffect: "read",
      maxResultBytes: 128 * 1024,
      presentation: { callLabel: "Get LSP diagnostics", resultLabel: "LSP diagnostics" },
      async execute(input, context) {
        const diagnosticsInput = {
          projectId: context.projectId,
          workspaceRoot: context.workspace.real_root,
          request: LspDiagnosticsRequestSchema.parse(input),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        };
        // Runtime supplies the Host-owned bridge so the canonical
        // `lsp.diagnostics_received`/`lsp.server_unavailable` event is bound
        // to the current Run. Direct extension use keeps the standalone
        // manager path for embedding/tests.
        if (context.lsp !== undefined) {
          return context.lsp.getDiagnostics(input, context.signal);
        }
        const result = await manager.diagnostics(diagnosticsInput);
        return lspResultToRaw(result);
      },
      render(_input, output) { return output; },
    };
  }

  async #session(
    projectId: string,
    workspaceRoot: string,
    server: ServerRecord,
    eventSink?: (event: LspManagerEvent) => void | Promise<void>,
  ): Promise<SessionRecord | undefined> {
    const root = resolve(workspaceRoot);
    const key = `${projectId}:${server.config.name}:${root}`;
    const existing = this.#sessions.get(key);
    if (existing?.client?.running === true) return existing;
    const diagnostics = existing?.diagnostics ?? new Map();
    const versions = existing?.versions ?? new Map();
    server.status = this.#status(server.config, "spawning", diagnosticsSize(diagnostics));
    const record: SessionRecord = { projectId, workspaceRoot: root, server, client: undefined, diagnostics, versions };
    const client = this.#clientFactory(server.config, {
      workspaceRoot: root,
      env: this.#environment,
      ...(this.#cwd === undefined ? {} : { cwd: this.#cwd }),
      requestTimeoutMs: server.config.request_timeout_ms,
      onDiagnostics: (notification) => this.#onDiagnostics(record, notification),
      onExit: (info) => {
        if (info.expected) return;
        server.status = this.#status(server.config, "unavailable", diagnosticsSize(diagnostics), {
          error_code: "lsp_process_exited",
          error_message: `LSP process exited (${info.code === null ? info.signal ?? "unknown" : info.code})`,
        });
      },
    });
    record.client = client;
    this.#sessions.set(key, record);
    server.status = this.#status(server.config, "initializing", diagnosticsSize(diagnostics));
    try {
      await client.start(root);
      server.status = this.#status(server.config, "ready", diagnosticsSize(diagnostics));
      return record;
    } catch (error) {
      await client.stop("start_failed").catch(() => undefined);
      this.#sessions.delete(key);
      server.status = this.#status(server.config, "unavailable", diagnosticsSize(diagnostics), {
        error_code: error instanceof LspProtocolError ? error.code : "lsp_start_failed",
        error_message: safeMessage(error),
      });
      await this.#emit({
        type: "lsp.server_unavailable",
        occurred_at: this.#now().toISOString(),
        data: {
          project_id: projectId,
          server_name: server.config.name,
          error_code: server.status.error_code,
          message: server.status.error_message,
        },
      }, eventSink);
      return undefined;
    }
  }

  #onDiagnostics(session: SessionRecord, notification: LspDiagnosticNotification): void {
    const path = session.client?.relativePath(notification.uri);
    if (path === undefined) return;
    const parsed = notification.diagnostics.flatMap((diagnostic) => parseDiagnostic(path, diagnostic));
    session.diagnostics.set(path, parsed);
    session.server.status = this.#status(session.server.config, "ready", diagnosticsSize(session.diagnostics));
  }

  async #result(
    input: LspDiagnosticsInput,
    request: LspDiagnosticsRequest,
    serverName: string,
    diagnostics: readonly ReturnType<typeof LspDiagnosticSchema.parse>[],
    filesScanned: number,
    eventSink?: (event: LspManagerEvent) => void | Promise<void>,
  ): Promise<LspDiagnosticsResult> {
    const filtered = diagnostics
      .filter((diagnostic) => request.severity === "all" || (request.severity === "errors" ? diagnostic.severity === "error" : diagnostic.severity === "warning"))
      .sort(compareDiagnostic);
    // The ledger contract bounds both counts and the sample. Keep a stable
    // first-128 window for the summary even when the Tool asks for fewer
    // returned diagnostics.
    const boundedAll = filtered.slice(0, 128);
    const bounded = boundedAll.slice(0, request.max_items);
    const truncated = bounded.length < filtered.length;
    const counts = countDiagnostics(boundedAll);
    const summary = {
      server_name: serverName,
      files_scanned: Math.min(filesScanned, 256),
      diagnostic_count: boundedAll.length,
      ...counts,
      truncated,
      sample: bounded.slice(0, 20),
      diagnostics_hash: sha256(stableStringify(boundedAll)),
    };
    const parsedSummary = LspDiagnosticsReceivedDataSchema.parse({
      project_id: input.projectId,
      ...summary,
    });
    const event: LspManagerEvent = {
      type: "lsp.diagnostics_received",
      occurred_at: this.#now().toISOString(),
      data: parsedSummary,
    };
    await this.#emit(event, eventSink);
    return LspDiagnosticsResultSchema.parse({
      status: "available",
      summary,
      diagnostics: bounded,
    });
  }

  async #unavailable(
    input: LspDiagnosticsInput,
    errorCode: string,
    message: string,
    eventSink?: (event: LspManagerEvent) => void | Promise<void>,
  ): Promise<LspDiagnosticsResult> {
    const serverName = this.#serverForPath(input.request.paths[0] ?? "")?.config.name ?? "unknown";
    const event: LspManagerEvent = {
      type: "lsp.server_unavailable",
      occurred_at: this.#now().toISOString(),
      data: { project_id: input.projectId, server_name: serverName, error_code: errorCode, message },
    };
    await this.#emit(event, eventSink);
    return LspDiagnosticsResultSchema.parse({ status: "unavailable", diagnostics: [], message });
  }

  #serverForPath(path: string): ServerRecord | undefined {
    const extension = extname(path).toLowerCase();
    return [...this.#servers.values()].find((record) => record.config.file_extensions.includes(extension));
  }

  #workspace(input: { projectId: string; workspaceRoot: string }): Parameters<typeof resolveWorkspacePath>[0] {
    return {
      project_id: input.projectId,
      real_root: input.workspaceRoot,
      workspace_kind: "readonly_local",
      handle_id: "lsp-location",
      created_at: this.#now().toISOString(),
      capabilities: { index: true, read: true, search: true, run_command: false, preview_patch: false, commit_patch: false, test: false },
    };
  }

  #locations(session: SessionRecord, values: readonly unknown[]): readonly LspLocation[] {
    return values.flatMap((value) => {
      if (!isRecord(value)) return [];
      const uri = typeof value.uri === "string" ? value.uri : typeof value.targetUri === "string" ? value.targetUri : undefined;
      const range = value.range ?? value.targetSelectionRange;
      if (uri === undefined || !isRecord(range)) return [];
      const path = session.client?.relativePath(uri);
      if (path === undefined) return [];
      const parsed = LspLocationSchema.safeParse({ path, range });
      return parsed.success ? [parsed.data] : [];
    }).slice(0, 256);
  }

  async #syncDocument(session: SessionRecord, path: string, absolute: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("LSP document sync was aborted");
    const text = await readFile(absolute, { encoding: "utf8", ...(signal === undefined ? {} : { signal }) });
    const uri = fileUriForPath(absolute);
    const version = (session.versions.get(uri) ?? 0) + 1;
    session.versions.set(uri, version);
    if (version === 1) await session.client!.didOpen({ uri, languageId: languageIdForPath(path, session.server.config), text });
    else await session.client!.didChange({ uri, text, version });
  }

  #status(
    config: LspServerConfig,
    state: LspServerStatus["state"],
    diagnosticsCount: number,
    error?: { error_code: string; error_message: string },
  ): LspServerStatus {
    return LspServerStatusSchema.parse({
      name: config.name,
      state,
      language_ids: config.language_ids,
      file_extensions: config.file_extensions,
      diagnostics_count: Math.min(diagnosticsCount, 128),
      updated_at: this.#now().toISOString(),
      ...(error ?? {}),
    });
  }

  async #emit(event: LspManagerEvent, eventSink?: (event: LspManagerEvent) => void | Promise<void>): Promise<void> {
    this.#history.push(Object.freeze({ ...event, data: structuredClone(event.data) }));
    if (this.#history.length > 512) this.#history.splice(0, this.#history.length - 512);
    for (const listener of [...this.#listeners]) {
      try { await listener(Object.freeze({ ...event, data: structuredClone(event.data) })); } catch { /* observers cannot break LSP */ }
    }
    try { await eventSink?.(Object.freeze({ ...event, data: structuredClone(event.data) })); } catch { /* Run append is best effort at the tool boundary */ }
  }
}

export function createLspToolsExtension(manager: LspManager): TraceGraphExtension {
  return {
    name: LSP_EXTENSION_NAME,
    api_version: LSP_EXTENSION_API_VERSION,
    activate(context) { context.registerTool(manager.toolDefinition()); },
    async deactivate() { await manager.stop(); },
  };
}

export async function readLspConfig(path: string): Promise<LspConfig> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return defaultLspConfig();
    throw new Error(`LSP config must be a regular, non-symlink file: ${path}`, { cause: error });
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`LSP config must be a regular file: ${path}`);
    if (stat.size > 128 * 1024) throw new Error(`LSP config exceeds 128 KiB: ${path}`);
    return LspConfigSchema.parse(JSON.parse(await handle.readFile({ encoding: "utf8" })));
  } catch (error) {
    if (error instanceof z.ZodError) throw new Error(`LSP config is invalid: ${error.message}`, { cause: error });
    throw error;
  } finally {
    await handle.close();
  }
}

export function lspResultToRaw(result: LspDiagnosticsResult): RawToolResult {
  if (result.status === "unavailable") {
    return { status: "unknown", code: "lsp_unavailable", summary: result.message ?? "LSP server is unavailable", facts: { status: result.status } };
  }
  return {
    status: "success",
    code: "lsp_diagnostics_received",
    summary: result.summary === undefined
      ? "LSP diagnostics received"
      : `${result.summary.diagnostic_count} semantic diagnostic(s) received`,
    content: JSON.stringify(result.diagnostics, null, 2),
    mimeType: "application/json",
    facts: { summary: result.summary, diagnostics: result.diagnostics },
  };
}

function parseDiagnostic(path: string, value: unknown): ReturnType<typeof LspDiagnosticSchema.parse>[] {
  if (!isRecord(value) || !isRecord(value.range)) return [];
  const severity = value.severity === 1 ? "error" : value.severity === 2 ? "warning" : value.severity === 3 ? "information" : "hint";
  const parsed = LspDiagnosticSchema.safeParse({
    path,
    range: value.range,
    severity,
    message: typeof value.message === "string" ? value.message : "LSP diagnostic",
    ...(typeof value.code === "string" || typeof value.code === "number" ? { code: value.code } : {}),
    ...(typeof value.source === "string" ? { source: value.source } : {}),
  });
  return parsed.success ? [parsed.data] : [];
}

function countDiagnostics(diagnostics: readonly ReturnType<typeof LspDiagnosticSchema.parse>[]) {
  return {
    error_count: diagnostics.filter(({ severity }) => severity === "error").length,
    warning_count: diagnostics.filter(({ severity }) => severity === "warning").length,
    information_count: diagnostics.filter(({ severity }) => severity === "information").length,
    hint_count: diagnostics.filter(({ severity }) => severity === "hint").length,
  };
}

function compareDiagnostic(left: ReturnType<typeof LspDiagnosticSchema.parse>, right: ReturnType<typeof LspDiagnosticSchema.parse>): number {
  return left.path.localeCompare(right.path)
    || left.range.start.line - right.range.start.line
    || left.range.start.character - right.range.start.character
    || left.severity.localeCompare(right.severity)
    || left.message.localeCompare(right.message);
}

function diagnosticsSize(value: ReadonlyMap<string, readonly unknown[]>): number {
  return [...value.values()].reduce((total, diagnostics) => total + diagnostics.length, 0);
}

function languageIdForPath(path: string, config: LspServerConfig): string {
  const lower = path.toLowerCase();
  if (config.name === "typescript") {
    if (lower.endsWith(".tsx")) return "typescriptreact";
    if (lower.endsWith(".jsx")) return "javascriptreact";
    if (lower.endsWith(".js")) return "javascript";
  }
  return config.language_ids[0] ?? "plaintext";
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(resolvePromise, ms);
    const abort = () => {
      clearTimeout(timer);
      rejectPromise(signal?.reason instanceof Error ? signal.reason : new Error("LSP diagnostics were aborted"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "LSP server unavailable").replace(/[\r\n]+/gu, " ").slice(0, 1_000);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
