import { spawn } from "node:child_process";

import type { BoundedProcessResult } from "../../kernel/registration.js";

export type { BoundedProcessResult } from "../../kernel/registration.js";

const PROCESS_KILL_GRACE_MS = 250;

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
    let settled = false;
    let groupTerminationStarted = false;
    let closeExitCode: number | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let groupPollTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (groupPollTimer !== undefined) clearTimeout(groupPollTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const settleIfQuiescent = () => {
      if (settled || !closed) return;
      if (process.platform !== "win32" && processGroupExists(child.pid)) {
        if (!groupTerminationStarted) terminateGroup();
        pollProcessGroup();
        return;
      }
      settled = true;
      cleanup();
      resolvePromise({
        exitCode: closeExitCode,
        stdout,
        stderr,
        timedOut,
        truncated,
        aborted,
      });
    };

    const pollProcessGroup = () => {
      if (settled || process.platform === "win32") {
        settleIfQuiescent();
        return;
      }
      if (!processGroupExists(child.pid)) {
        settleIfQuiescent();
        return;
      }
      if (groupPollTimer === undefined) {
        groupPollTimer = setTimeout(() => {
          groupPollTimer = undefined;
          pollProcessGroup();
        }, 10);
      }
    };

    const terminateGroup = () => {
      if (groupTerminationStarted) return;
      groupTerminationStarted = true;
      signalProcessTree(child.pid, "SIGTERM", () => child.kill("SIGTERM"));
      killTimer = setTimeout(() => {
        // Keep escalation alive after the group leader closes. A descendant
        // may still be alive in the same process group and ignore SIGTERM.
        signalProcessTree(child.pid, "SIGKILL", () => child.kill("SIGKILL"));
        pollProcessGroup();
      }, PROCESS_KILL_GRACE_MS);
      pollProcessGroup();
    };

    const terminate = (reason: "timeout" | "output" | "abort") => {
      if (reason === "timeout") timedOut = true;
      if (reason === "output") truncated = true;
      if (reason === "abort") aborted = true;
      if (process.platform === "win32") {
        if (!closed && killTimer === undefined) {
          child.kill("SIGTERM");
          killTimer = setTimeout(() => {
            if (!closed) child.kill("SIGKILL");
          }, PROCESS_KILL_GRACE_MS);
        }
        return;
      }
      terminateGroup();
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
    onAbort = () => terminate("abort");
    timer = setTimeout(() => terminate("timeout"), options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.once("error", (error) => {
      closed = true;
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", (exitCode) => {
      closed = true;
      closeExitCode = exitCode;
      if (process.platform !== "win32" && processGroupExists(child.pid)) {
        terminateGroup();
        pollProcessGroup();
        return;
      }
      settleIfQuiescent();
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

function processGroupExists(pid: number | undefined): boolean {
  if (pid === undefined || process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    return true;
  }
}
