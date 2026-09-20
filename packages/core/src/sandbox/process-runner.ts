import { spawn } from "node:child_process";

const PROCESS_KILL_GRACE_MS = 250;

export interface BoundedProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  aborted: boolean;
}

export interface BoundedProcessOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

/**
 * Spawn one command without a shell and keep its complete process group inside
 * the same timeout/output/abort boundary.  On POSIX, the delayed SIGKILL is
 * deliberately retained after the group leader exits: a descendant may have
 * ignored SIGTERM even though the direct child has already closed.
 */
export async function runBoundedProcess(
  executable: string,
  args: readonly string[],
  options: BoundedProcessOptions,
): Promise<BoundedProcessResult> {
  validateProcessInput(executable, args, options);
  if (options.signal?.aborted) return emptyProcessResult({ aborted: true });

  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" },
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let size = 0;
    let timedOut = false;
    let truncated = false;
    let aborted = false;
    let closed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const terminate = (reason: "timeout" | "output" | "abort") => {
      if (reason === "timeout") timedOut = true;
      if (reason === "output") truncated = true;
      if (reason === "abort") aborted = true;
      if (closed || killTimer !== undefined) return;
      signalProcessTree(child.pid, "SIGTERM", () => child.kill("SIGTERM"));
      killTimer = setTimeout(() => {
        if (process.platform !== "win32" || !closed) {
          signalProcessTree(child.pid, "SIGKILL", () => child.kill("SIGKILL"));
        }
      }, PROCESS_KILL_GRACE_MS);
    };

    const capture = (target: "stdout" | "stderr", chunk: Buffer) => {
      const remaining = Math.max(0, options.maxOutputBytes - size);
      const visible = chunk.subarray(0, remaining).toString("utf8");
      size += Buffer.byteLength(visible);
      if (target === "stdout") stdout += visible;
      else stderr += visible;
      if (chunk.byteLength > remaining) terminate("output");
    };

    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
    const timer = setTimeout(() => terminate("timeout"), options.timeoutMs);
    const onAbort = () => terminate("abort");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.once("error", (error) => {
      closed = true;
      clearTimeout(timer);
      if (killTimer !== undefined && process.platform === "win32") clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (exitCode) => {
      closed = true;
      clearTimeout(timer);
      if (killTimer !== undefined && process.platform === "win32") clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ exitCode, stdout, stderr, timedOut, truncated, aborted });
    });
  });
}

function validateProcessInput(
  executable: string,
  args: readonly string[],
  options: BoundedProcessOptions,
): void {
  assertSafeProcessString("executable", executable);
  assertSafeProcessString("cwd", options.cwd);
  for (const argument of args) assertSafeProcessString("argument", argument);
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0) {
    throw new TypeError("maxOutputBytes must be a positive safe integer");
  }
}

function assertSafeProcessString(label: string, value: string): void {
  if (value.length === 0) throw new TypeError(`${label} must not be empty`);
  if (value.includes("\0")) throw new TypeError(`${label} must not contain NUL`);
}

function emptyProcessResult(overrides: Partial<BoundedProcessResult>): BoundedProcessResult {
  return {
    exitCode: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    truncated: false,
    aborted: false,
    ...overrides,
  };
}

function signalProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals,
  fallback: () => void,
): void {
  if (pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // A very young detached child may not have entered its process group
      // yet. Falling back to the direct child is always safer than leaving it
      // alive; calling kill on an already-closed child is harmless.
      fallback();
      return;
    }
  }
  fallback();
}
