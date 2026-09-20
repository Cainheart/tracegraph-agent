import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { LspServerConfig } from "@tracegraph/contracts";

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_BUFFER_BYTES = MAX_MESSAGE_BYTES * 2;

export interface LspDiagnosticNotification {
  readonly uri: string;
  readonly diagnostics: readonly unknown[];
}

export interface LspClientOptions {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly requestTimeoutMs?: number;
  readonly onDiagnostics?: (notification: LspDiagnosticNotification) => void | Promise<void>;
  readonly onExit?: (info: {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly expected: boolean;
  }) => void | Promise<void>;
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
    options: { cwd?: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"]; shell: false },
  ) => ChildProcessWithoutNullStreams;
}

interface JsonRpcMessage {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { code?: unknown; message?: unknown; data?: unknown };
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class LspProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LspProtocolError";
    this.code = code;
  }
}

/** Minimal, bounded Language Server Protocol client over stdio. */
export class LspStdioClient {
  readonly #config: LspServerConfig;
  readonly #options: LspClientOptions;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #diagnosticListeners = new Set<(notification: LspDiagnosticNotification) => void | Promise<void>>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #nextId = 1;
  #buffer = Buffer.alloc(0);
  #stderr = "";
  #closed = false;
  #rootUri = "";

  constructor(config: LspServerConfig, options: LspClientOptions) {
    this.#config = config;
    this.#options = options;
    if (options.onDiagnostics !== undefined) this.#diagnosticListeners.add(options.onDiagnostics);
  }

  get stderrTail(): string {
    return this.#stderr.slice(-4_000);
  }

  get running(): boolean {
    return this.#child !== undefined && !this.#closed;
  }

  onDiagnostics(listener: (notification: LspDiagnosticNotification) => void | Promise<void>): { dispose(): void } {
    this.#diagnosticListeners.add(listener);
    return { dispose: () => this.#diagnosticListeners.delete(listener) };
  }

  async start(workspaceRoot: string): Promise<void> {
    if (this.#child !== undefined && !this.#closed) {
      throw new LspProtocolError("lsp_client_started", "LSP client is already running");
    }
    const spawnProcess = this.#options.spawnProcess ?? ((command, args, options) => spawn(command, args, options));
    this.#closed = false;
    this.#buffer = Buffer.alloc(0);
    this.#stderr = "";
    this.#rootUri = pathToFileURL(resolve(workspaceRoot)).href;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnProcess(this.#config.command, this.#config.args, {
        ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
        env: this.#options.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
    } catch (error) {
      throw new LspProtocolError("lsp_spawn_failed", safeError(error));
    }
    this.#child = child;
    child.stdout.on("data", (chunk: Buffer | string) => this.#consumeStdout(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.#stderr = `${this.#stderr}${String(chunk)}`.slice(-4_000);
    });
    child.once("error", (error) => this.#failAll(new LspProtocolError("lsp_process_error", safeError(error))));
    child.once("exit", (code, signal) => {
      const expected = this.#closed;
      this.#closed = true;
      this.#failAll(new LspProtocolError(
        "lsp_process_exited",
        `LSP process exited before the request completed (${code === null ? signal ?? "unknown" : code})`,
      ));
      void Promise.resolve(this.#options.onExit?.({ code, signal, expected })).catch(() => undefined);
    });

    try {
      const result = await this.#request("initialize", {
        processId: process.pid,
        rootUri: this.#rootUri,
        workspaceFolders: [{ uri: this.#rootUri, name: dirname(resolve(workspaceRoot)).split("/").at(-1) ?? "workspace" }],
        capabilities: {
          workspace: { workspaceFolders: true },
          textDocument: {
            synchronization: { dynamicRegistration: false, willSave: false, didSave: false, willSaveWaitUntil: false },
            publishDiagnostics: { relatedInformation: false },
          },
        },
        clientInfo: { name: "tracegraph-agent", version: "0.1.0-alpha.0" },
      });
      if (!isRecord(result)) throw new LspProtocolError("lsp_initialize_invalid", "LSP initialize response is invalid");
      this.#notify("initialized", {});
    } catch (error) {
      await this.stop("initialization_failed");
      throw error;
    }
  }

  async didOpen(input: { uri: string; languageId: string; text: string }): Promise<void> {
    this.#notify("textDocument/didOpen", {
      textDocument: {
        uri: input.uri,
        languageId: input.languageId,
        version: 1,
        text: input.text,
      },
    });
  }

  async didChange(input: { uri: string; text: string; version: number }): Promise<void> {
    this.#notify("textDocument/didChange", {
      textDocument: { uri: input.uri, version: input.version },
      contentChanges: [{ text: input.text }],
    });
  }

  async didClose(uri: string): Promise<void> {
    this.#notify("textDocument/didClose", { textDocument: { uri } });
  }

  async definition(input: { uri: string; line: number; character: number }, signal?: AbortSignal): Promise<readonly unknown[]> {
    const result = await this.#request("textDocument/definition", {
      textDocument: { uri: input.uri },
      position: { line: input.line, character: input.character },
    }, signal);
    return normalizeLocations(result);
  }

  async references(input: { uri: string; line: number; character: number }, signal?: AbortSignal): Promise<readonly unknown[]> {
    const result = await this.#request("textDocument/references", {
      textDocument: { uri: input.uri },
      position: { line: input.line, character: input.character },
      context: { includeDeclaration: true },
    }, signal);
    return normalizeLocations(result);
  }

  async stop(reason = "stopped"): Promise<void> {
    const child = this.#child;
    if (child === undefined) return;
    this.#failAll(new LspProtocolError("lsp_client_stopped", `LSP client stopped: ${reason}`));
    // LSP shutdown is a request (with an id), followed by an exit
    // notification. Keep both inside a short fence so a non-compliant or
    // hung server cannot delay Host shutdown; the process is still terminated
    // below when it does not acknowledge the request.
    if (!this.#closed && !child.stdin.destroyed) {
      try {
        const shutdown = this.#request("shutdown", null).catch(() => undefined);
        await Promise.race([
          shutdown,
          new Promise<void>((resolvePromise) => {
            const timer = setTimeout(resolvePromise, 500);
            timer.unref();
          }),
        ]);
        this.#notify("exit", null);
      } catch { /* process may already be gone */ }
    }
    this.#closed = true;
    try { child.stdin.end(); } catch { /* best effort */ }
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGTERM"); } catch { /* best effort */ }
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* best effort */ }
          resolvePromise();
        }, 1_000);
        timer.unref();
        child.once("exit", () => {
          clearTimeout(timer);
          resolvePromise();
        });
      });
    }
    this.#child = undefined;
  }

  /** Convert a server URI to a workspace-relative path without trusting it. */
  relativePath(uri: string): string | undefined {
    try {
      const absolute = fileURLToPath(uri);
      const root = fileURLToPath(this.#rootUri);
      const candidate = relative(root, absolute).replaceAll("\\", "/");
      if (candidate.length === 0 || candidate === ".." || candidate.startsWith("../") || isAbsolute(candidate)) return undefined;
      return candidate;
    } catch {
      return undefined;
    }
  }

  #request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const child = this.#child;
    if (child === undefined || this.#closed || child.stdin.destroyed) {
      return Promise.reject(new LspProtocolError("lsp_client_unavailable", "LSP server is not running"));
    }
    const id = this.#nextId++;
    const timeoutMs = Math.max(100, this.#options.requestTimeoutMs ?? this.#config.request_timeout_ms);
    const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectPromise(new LspProtocolError("lsp_request_timeout", `LSP request ${method} timed out`));
      }, timeoutMs);
      timer.unref();
      this.#pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
    });
    const abort = () => {
      const pending = this.#pending.get(id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(new LspProtocolError("lsp_request_aborted", `LSP request ${method} was aborted`));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      this.#send({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      abort();
      return Promise.reject(error);
    }
    return promise.finally(() => signal?.removeEventListener("abort", abort));
  }

  #notify(method: string, params: unknown): void {
    const child = this.#child;
    if (child === undefined || this.#closed || child.stdin.destroyed) return;
    this.#send({ jsonrpc: "2.0", method, params });
  }

  #send(message: Record<string, unknown>): void {
    const child = this.#child;
    if (child === undefined || child.stdin.destroyed) throw new LspProtocolError("lsp_write_failed", "LSP server stdin is unavailable");
    const body = Buffer.from(JSON.stringify(message), "utf8");
    if (body.byteLength > MAX_MESSAGE_BYTES) throw new LspProtocolError("lsp_message_too_large", "LSP request exceeds the bounded limit");
    child.stdin.write(Buffer.concat([
      Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii"),
      body,
    ]));
  }

  #consumeStdout(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.byteLength > MAX_BUFFER_BYTES) {
      this.#failAll(new LspProtocolError("lsp_buffer_too_large", "LSP response buffer exceeds the bounded limit"));
      return;
    }
    while (true) {
      const separator = this.#buffer.indexOf(Buffer.from("\r\n\r\n", "ascii"));
      const alternate = separator < 0 ? this.#buffer.indexOf(Buffer.from("\n\n", "ascii")) : -1;
      const headerEnd = separator >= 0 ? separator : alternate;
      if (headerEnd < 0) return;
      const delimiterLength = separator >= 0 ? 4 : 2;
      const header = this.#buffer.subarray(0, headerEnd).toString("ascii");
      const lengthLine = header.split(/\r?\n/u).find((line) => /^Content-Length\s*:/iu.test(line));
      const length = lengthLine === undefined ? NaN : Number(lengthLine.replace(/^Content-Length\s*:\s*/iu, ""));
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_MESSAGE_BYTES) {
        this.#failAll(new LspProtocolError("lsp_content_length_invalid", "LSP Content-Length is invalid"));
        return;
      }
      const bodyStart = headerEnd + delimiterLength;
      if (this.#buffer.byteLength < bodyStart + length) return;
      const body = this.#buffer.subarray(bodyStart, bodyStart + length);
      this.#buffer = this.#buffer.subarray(bodyStart + length);
      let message: JsonRpcMessage;
      try { message = JSON.parse(body.toString("utf8")) as JsonRpcMessage; }
      catch { this.#failAll(new LspProtocolError("lsp_json_invalid", "LSP response is not valid JSON")); return; }
      this.#handle(message);
    }
  }

  #handle(message: JsonRpcMessage): void {
    if (typeof message.method === "string") {
      if (message.method === "textDocument/publishDiagnostics" && isRecord(message.params)
        && typeof message.params.uri === "string" && Array.isArray(message.params.diagnostics)) {
        const notification: LspDiagnosticNotification = {
          uri: message.params.uri,
          diagnostics: message.params.diagnostics,
        };
        for (const listener of [...this.#diagnosticListeners]) {
          void Promise.resolve(listener(notification)).catch(() => undefined);
        }
      }
      return;
    }
    if (typeof message.id !== "number" || !Number.isSafeInteger(message.id)) return;
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pending.delete(message.id);
    if (message.error !== undefined) {
      pending.reject(new LspProtocolError(
        typeof message.error.code === "number" ? `lsp_rpc_${message.error.code}` : "lsp_rpc_error",
        typeof message.error.message === "string" ? message.error.message : "LSP server returned an error",
      ));
      return;
    }
    pending.resolve(message.result);
  }

  #failAll(error: unknown): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(error);
    }
  }
}

export function fileUriForPath(path: string): string {
  return pathToFileURL(resolve(path)).href;
}

function normalizeLocations(value: unknown): readonly unknown[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.slice(0, 256);
  return [value];
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "LSP operation failed").replace(/[\r\n]+/gu, " ").slice(0, 1_000);
}
