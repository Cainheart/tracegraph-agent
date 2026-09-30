import {
  MemoryUseEventDataSchema,
  type MemoryUseEventData,
  type MemoryUseStage,
} from "@tracegraph/contracts";

export interface MemoryUseProjection {
  readonly memoryUseId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly modelCallId: string;
  readonly contextManifestRef: string;
  readonly status: MemoryUseStage;
  readonly dispatchIntent: Extract<MemoryUseEventData, { stage: "dispatch_intent" }>;
  readonly lastEventId: string;
}

interface MemoryUseEventEnvelope {
  readonly type: string;
  readonly event_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly turn_id?: string | undefined;
  readonly model_call_id?: string | undefined;
  readonly context_manifest_ref?: string | undefined;
  readonly data: unknown;
}

/** Replay the Run-scoped MemoryUse status stream without consulting Runtime state. */
export function replayMemoryUseStatus(events: readonly MemoryUseEventEnvelope[]): MemoryUseProjection[] {
  const projections = new Map<string, MemoryUseProjection>();
  for (const event of events) {
    if (event.type !== "memory.use_status") continue;
    const data = MemoryUseEventDataSchema.parse(event.data);
    if (data.stage === "dispatch_intent") {
      if (projections.has(data.memory_use_id)) {
        throw new TypeError(`MemoryUse ${data.memory_use_id} has more than one dispatch intent`);
      }
      if (
        event.turn_id === undefined
        || event.model_call_id === undefined
        || event.context_manifest_ref !== data.manifest_id
      ) {
        throw new TypeError("MemoryUse dispatch identity does not match its Run event envelope");
      }
      projections.set(data.memory_use_id, {
        memoryUseId: data.memory_use_id,
        projectId: event.project_id,
        runId: event.run_id,
        turnId: event.turn_id,
        modelCallId: event.model_call_id,
        contextManifestRef: data.manifest_id,
        status: data.stage,
        dispatchIntent: data,
        lastEventId: event.event_id,
      });
      continue;
    }

    const current = projections.get(data.memory_use_id);
    if (current === undefined) {
      throw new TypeError(`MemoryUse ${data.memory_use_id} status has no dispatch intent`);
    }
    if (
      event.project_id !== current.projectId
      || event.run_id !== current.runId
      || event.turn_id !== current.turnId
      || event.model_call_id !== current.modelCallId
      || event.context_manifest_ref !== current.contextManifestRef
    ) {
      throw new TypeError(`MemoryUse ${data.memory_use_id} status changed its Run identity`);
    }
    const validNext = current.status === "dispatch_intent"
      ? data.stage === "adapter_invoked" || data.stage === "unknown"
      : current.status === "adapter_invoked"
        ? data.stage === "response" || data.stage === "failed" || data.stage === "unknown"
        : false;
    if (!validNext) {
      throw new TypeError(`MemoryUse ${data.memory_use_id} has illegal status transition ${current.status} -> ${data.stage}`);
    }
    projections.set(data.memory_use_id, {
      ...current,
      status: data.stage,
      lastEventId: event.event_id,
    });
  }
  return [...projections.values()];
}
