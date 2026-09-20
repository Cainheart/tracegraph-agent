import { analyzeCodeGraph, diffGraphSnapshots } from "@tracegraph/codegraph";
import type { CodeGraphProvider } from "@tracegraph/core";

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
  };
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
