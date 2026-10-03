import { fork, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { FramedRpcClient } from "@tracegraph/sdk/client";
import { CLIENT_PROTOCOL_VERSION } from "@tracegraph/sdk/protocol";
import {
  DesktopHostReadyMessageSchema,
  DesktopHostStartMessageSchema,
  DesktopHostStartupErrorSchema,
} from "./lifecycle-protocol.js";
import type { DesktopHostProject } from "./desktop-host.js";
import { DESKTOP_HOST_PACKAGE_VERSION } from "./identity.js";
import { DesktopHostNativeClient } from "./native-control.js";
import { curatedNodeEnvironment, DesktopHostNodeUnavailableError, resolveDesktopHostNodeExecutable } from "./node-executable.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_LIFECYCLE_TIMEOUT_MS = 60_000;

export interface LaunchDesktopHostOptions {
  readonly dataDir: string;
  readonly projects?: readonly DesktopHostProject[];
  readonly expectedHostVersion?: string;
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
}

export interface DesktopHostExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface LaunchedDesktopHost {
  readonly childProcess: ChildProcess;
  readonly client: FramedRpcClient;
  readonly native: DesktopHostNativeClient;
  readonly identity: {
    readonly package_name: "@tracegraph/desktop-host";
    readonly package_version: string;
    readonly protocol_version: string;
  };
  readonly sessionRecovery: ReturnType<typeof DesktopHostReadyMessageSchema.parse>["session_recovery"];
  readonly exit: Promise<DesktopHostExit>;
  close(): Promise<DesktopHostExit>;
}

export class DesktopHostStartupError extends Error {
  readonly code: "version_mismatch" | "invalid_start" | "startup_failed" | "setup_unavailable";

  constructor(code: DesktopHostStartupError["code"], message: string) {
    super(message);
    this.name = "DesktopHostStartupError";
    this.code = code;
  }
}

export class DesktopHostVersionMismatchError extends DesktopHostStartupError {
  constructor(expected: string, actual: string) {
    super("version_mismatch", `Desktop Host package version mismatch (expected ${expected}, received ${actual})`);
    this.name = "DesktopHostVersionMismatchError";
  }
}

/** Launches the built private Host child and binds its stdio to API-062 framed RPC. */
export async function launchDesktopHostProcess(
  options: LaunchDesktopHostOptions,
): Promise<LaunchedDesktopHost> {
  const expectedHostVersion = options.expectedHostVersion ?? DESKTOP_HOST_PACKAGE_VERSION;
  const startupTimeoutMs = boundedTimeout(options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS, "startupTimeoutMs");
  const shutdownTimeoutMs = boundedTimeout(options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS, "shutdownTimeoutMs");
  const start = DesktopHostStartMessageSchema.parse({
    kind: "start",
    expected_host_version: expectedHostVersion,
    protocol_version: CLIENT_PROTOCOL_VERSION,
    data_dir: options.dataDir,
    projects: options.projects ?? [],
  });
  const workerPath = await resolveWorkerPath();
  let nodeExecutable: string;
  try {
    nodeExecutable = await resolveDesktopHostNodeExecutable();
  } catch (error) {
    if (error instanceof DesktopHostNodeUnavailableError) {
      throw new DesktopHostStartupError("setup_unavailable", error.message);
    }
    throw error;
  }
  const childProcess = fork(workerPath, [], {
    cwd: process.cwd(),
    execPath: nodeExecutable,
    execArgv: [],
    env: curatedNodeEnvironment(process.env),
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    serialization: "json",
    windowsHide: true,
  });
  childProcess.stderr?.resume();
  const exit = observeExit(childProcess);

  let ready: ReturnType<typeof DesktopHostReadyMessageSchema.parse>;
  try {
    ready = await awaitReady(childProcess, start, startupTimeoutMs);
    if (ready.package_version !== expectedHostVersion) {
      throw new DesktopHostVersionMismatchError(expectedHostVersion, ready.package_version);
    }
    if (ready.protocol_version !== CLIENT_PROTOCOL_VERSION) {
      throw new DesktopHostStartupError(
        "version_mismatch",
        `Desktop Host protocol version mismatch (expected ${CLIENT_PROTOCOL_VERSION}, received ${ready.protocol_version})`,
      );
    }
  } catch (error) {
    await terminateChild(childProcess, exit, shutdownTimeoutMs);
    throw error;
  }

  if (childProcess.stdin === null || childProcess.stdout === null) {
    await terminateChild(childProcess, exit, shutdownTimeoutMs);
    throw new DesktopHostStartupError("startup_failed", "Desktop Host stdio pipes were not created");
  }
  const client = new FramedRpcClient({
    readable: Readable.toWeb(childProcess.stdout) as ReadableStream<Uint8Array>,
    writable: Writable.toWeb(childProcess.stdin) as WritableStream<Uint8Array>,
  });
  const native = new DesktopHostNativeClient(childProcess);

  let closePromise: Promise<DesktopHostExit> | undefined;
  return {
    childProcess,
    client,
    native,
    identity: {
      package_name: ready.package_name,
      package_version: ready.package_version,
      protocol_version: ready.protocol_version,
    },
    sessionRecovery: ready.session_recovery,
    exit,
    close() {
      closePromise ??= (async () => {
        let rpcCloseError: unknown;
        try {
          await client.close();
        } catch (error) {
          rpcCloseError = error;
        }
        let result = await waitForExit(exit, shutdownTimeoutMs);
        if (result === undefined) {
          childProcess.kill("SIGTERM");
          result = await waitForExit(exit, Math.min(shutdownTimeoutMs, 1_000));
        }
        if (result === undefined) {
          childProcess.kill("SIGKILL");
          result = await waitForExit(exit, 1_000);
        }
        if (result === undefined) throw new Error("Desktop Host did not exit after forced shutdown");
        if (rpcCloseError !== undefined) throw rpcCloseError;
        if (result.code !== 0) {
          throw new Error(`Desktop Host exited unsuccessfully (code=${String(result.code)}, signal=${String(result.signal)})`);
        }
        return result;
      })();
      return closePromise;
    },
  };
}

async function awaitReady(
  child: ChildProcess,
  start: ReturnType<typeof DesktopHostStartMessageSchema.parse>,
  timeoutMs: number,
): Promise<ReturnType<typeof DesktopHostReadyMessageSchema.parse>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new DesktopHostStartupError("startup_failed", "Desktop Host startup timed out")), timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      child.removeListener("message", onMessage);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("spawn", onSpawn);
    };
    const finish = (error?: unknown, value?: ReturnType<typeof DesktopHostReadyMessageSchema.parse>): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) reject(error);
      else resolve(value!);
    };
    const onMessage = (message: unknown): void => {
      const ready = DesktopHostReadyMessageSchema.safeParse(message);
      if (ready.success) {
        finish(undefined, ready.data);
        return;
      }
      const startupError = DesktopHostStartupErrorSchema.safeParse(message);
      if (startupError.success) {
        finish(new DesktopHostStartupError(startupError.data.code, startupError.data.message));
        return;
      }
      finish(new DesktopHostStartupError("startup_failed", "Desktop Host returned an invalid readiness message"));
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new DesktopHostStartupError("startup_failed", `Desktop Host exited before readiness (code=${String(code)}, signal=${String(signal)})`));
    };
    const onSpawn = (): void => {
      child.send(start, (error) => {
        if (error !== null) finish(new DesktopHostStartupError("startup_failed", `Could not send Desktop Host startup message: ${error.message}`));
      });
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("spawn", onSpawn);
  });
}

async function resolveWorkerPath(): Promise<string> {
  const candidates = [
    fileURLToPath(new URL("./worker.js", import.meta.url)),
    fileURLToPath(new URL("../dist/worker.js", import.meta.url)),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the built-package fallback used by source-level tests.
    }
  }
  throw new Error("Desktop Host worker is missing; build @tracegraph/desktop-host first");
}

function observeExit(child: ChildProcess): Promise<DesktopHostExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

async function terminateChild(child: ChildProcess, exit: Promise<DesktopHostExit>, timeoutMs: number): Promise<void> {
  if (await waitForExit(exit, 0) !== undefined) return;
  child.kill("SIGTERM");
  if (await waitForExit(exit, timeoutMs) !== undefined) return;
  child.kill("SIGKILL");
  await waitForExit(exit, 1_000);
}

async function waitForExit(exit: Promise<DesktopHostExit>, timeoutMs: number): Promise<DesktopHostExit | undefined> {
  if (timeoutMs === 0) return Promise.race([exit, Promise.resolve(undefined)]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exit,
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function boundedTimeout(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIFECYCLE_TIMEOUT_MS) {
    throw new RangeError(`${name} must be an integer from 1 to ${MAX_LIFECYCLE_TIMEOUT_MS}`);
  }
  return value;
}
