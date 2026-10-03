import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { devNull } from "node:os";
import { promisify } from "node:util";
import { analyzeCodeGraph, diffGraphSnapshots } from "@tracegraph/codegraph";
import { GitBaseContextSchema } from "@tracegraph/contracts";
import type { CodeGraphProvider } from "@tracegraph/core";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 64 * 1024;

export function createCodeGraphProvider(): CodeGraphProvider {
  return {
    async createSnapshot({ projectId, workspaceRoot, signal }) {
      return (
        await analyzeCodeGraph({
          project_id: projectId,
          workspace_root: workspaceRoot,
          ...(signal === undefined ? {} : { signal }),
        })
      ).snapshot;
    },
    async createDelta({ base, result, patchEventId, signal }) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("CodeGraph delta was aborted");
      }
      return diffGraphSnapshots(base, result, {
        ...(patchEventId === undefined ? {} : { patch_event_id: patchEventId }),
      });
    },
    async captureGitContext({ workspaceRoot, signal }) {
      if (signal?.aborted) throw gitAbortReason(signal);
      const capturedAt = new Date().toISOString();
      let root: string;
      try {
        root = await realpath(workspaceRoot);
      } catch {
        if (signal?.aborted) throw gitAbortReason(signal);
        return unavailableGitContext(capturedAt, "workspace_unavailable");
      }
      try {
        const inside = await runReadOnlyGit(root, ["rev-parse", "--is-inside-work-tree"], signal);
        if (inside.trim() !== "true") return unavailableGitContext(capturedAt, "not_git_repository");
      } catch {
        if (signal?.aborted) throw gitAbortReason(signal);
        return unavailableGitContext(capturedAt, "not_git_repository");
      }
      try {
        const [baseCommit, status] = await Promise.all([
          runReadOnlyGit(root, ["rev-parse", "HEAD"], signal),
          // Include untracked paths in the hash as well: a newly added source
          // file can change the static graph just as a tracked edit can.
          runReadOnlyGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"], signal),
        ]);
        const branch = await runReadOnlyGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal)
          .then((value) => value.trim() || undefined)
          .catch((error: unknown) => {
            if (signal?.aborted) throw error;
            return undefined;
          });
        return GitBaseContextSchema.parse({
          status: "available",
          base_commit: baseCommit.trim(),
          ...(branch === undefined ? {} : { branch }),
          dirty: status.length > 0,
          worktree_fingerprint: sha256(status),
          captured_at: capturedAt,
        });
      } catch {
        if (signal?.aborted) throw gitAbortReason(signal);
        return unavailableGitContext(capturedAt, "git_probe_failed");
      }
    },
  };
}

/**
 * This is not a model Tool. The composition root runs only this fixed,
 * read-only argv set against Runtime's canonical workspace root. No shell,
 * remote, raw Git output, global config, or repository-configured fsmonitor
 * command crosses the seam.
 */
async function runReadOnlyGit(
  workspaceRoot: string,
  args: readonly string[],
  signal: AbortSignal | undefined,
): Promise<string> {
  const result = await execFileAsync("git", [
    "-c", `core.hooksPath=${devNull}`,
    // `git status` may otherwise honor a repository's core.fsmonitor command.
    // This is a bounded local-state probe, not an extension execution surface.
    "-c", "core.fsmonitor=false",
    "-C", workspaceRoot,
    ...args,
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: devNull,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      LANG: "C",
    },
    maxBuffer: GIT_MAX_BUFFER,
    shell: false,
    signal,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  return result.stdout;
}

function unavailableGitContext(capturedAt: string, reason: string) {
  return GitBaseContextSchema.parse({
    status: "unavailable",
    captured_at: capturedAt,
    reason,
  });
}

function gitAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Git context probe was aborted");
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/** Keep telemetry's final best-effort barrier behind the HTTP close boundary. */
export const DEFAULT_TELEMETRY_SHUTDOWN_TIMEOUT_MS = 5_000;

export async function closeHostAndFlushTelemetry(
  closeHost: () => Promise<void>,
  flushTelemetry: () => Promise<void>,
  telemetryTimeoutMs = DEFAULT_TELEMETRY_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  let closeFailure: unknown;
  try {
    await closeHost();
  } catch (error) {
    closeFailure = error;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const flushOutcome = Promise.resolve()
    .then(flushTelemetry)
    .then(
      () => ({ kind: "completed" as const }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
  const deadline = new Promise<{ kind: "timed_out" }>((resolve) => {
    timeout = setTimeout(() => resolve({ kind: "timed_out" }), Math.max(1, telemetryTimeoutMs));
  });
  const outcome = await Promise.race([flushOutcome, deadline]);
  if (timeout !== undefined) clearTimeout(timeout);

  if (closeFailure !== undefined) throw closeFailure;
  if (outcome.kind === "failed") throw outcome.error;
  // A timeout deliberately resolves: telemetry is a best-effort sidecar and
  // cannot hold process shutdown open indefinitely.
  if (outcome.kind === "timed_out") return;
}
