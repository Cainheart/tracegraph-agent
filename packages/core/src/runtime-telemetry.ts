import {
  ReceiptSchema,
  SandboxConfiguredDataSchema,
  SandboxDisabledDataSchema,
  SandboxEnforcedDataSchema,
  ToolBatchCompletedDataSchema,
  type SessionEvent,
} from "@tracegraph/contracts";
import type {
  TelemetryAttributes,
  TelemetryEmitter,
  TelemetryEvent,
} from "@tracegraph/telemetry";

const MAX_RECENT_EVENT_IDS = 8_192;
const MAX_OPEN_CORRELATIONS = 2_048;

interface TimedCorrelation {
  readonly startedAtMs: number;
  readonly attributes: Record<string, string | number | boolean>;
}

/**
 * Derives a deliberately small telemetry surface from committed SessionEvents.
 *
 * This projector never forwards Event summaries or arbitrary Event data. Every
 * attribute below is explicitly selected from a bounded, canonical field.
 * Telemetry remains an optional observation of the ledger, never a second
 * source of Run truth.
 */
export class RuntimeTelemetryProjector {
  readonly #emitter: TelemetryEmitter;
  readonly #recentEventIds = new Set<string>();
  readonly #recentEventOrder: string[] = [];
  readonly #modelRequests = new Map<string, TimedCorrelation>();
  readonly #modelFallbackRetries = new Map<string, boolean>();
  readonly #compactions = new Map<string, TimedCorrelation>();
  readonly #approvals = new Map<string, TimedCorrelation>();

  constructor(emitter: TelemetryEmitter) {
    this.#emitter = emitter;
  }

  record(event: SessionEvent): void {
    if (!this.#remember(event.event_id)) return;
    try {
      this.#record(event);
    } catch {
      // Projection is intentionally best-effort. A future/legacy Event payload
      // must never make a committed ledger append fail.
    }
  }

  #record(event: SessionEvent): void {
    switch (event.type) {
      case "run.created":
      case "run.started":
      case "run.interrupted":
      case "run.resumed":
      case "run.completed":
      case "run.failed":
      case "run.cancelled":
        this.#recordRunLifecycle(event);
        return;
      case "model.request_started":
        this.#recordModelStarted(event);
        return;
      case "model.decision":
      case "model.request_failed":
      case "model.output_invalid":
        this.#recordModelFinished(event);
        return;
      case "model.usage_reported":
        this.#recordModelUsage(event);
        return;
      case "tool.completed":
      case "tool.failed":
      case "tool.unknown":
        this.#recordTool(event);
        return;
      case "tool.batch_completed":
        this.#recordToolBatch(event);
        return;
      case "context.compaction_started":
        this.#recordCompactionStarted(event);
        return;
      case "context.compaction_completed":
        this.#recordCompactionCompleted(event);
        return;
      case "approval.requested":
        this.#recordApprovalRequested(event);
        return;
      case "approval.granted":
      case "approval.denied":
      case "approval.expired":
        this.#recordApprovalFinished(event);
        return;
      case "sandbox.configured":
      case "sandbox.enforced":
      case "sandbox.disabled":
        this.#recordSandbox(event);
        return;
      default:
        return;
    }
  }

  #recordRunLifecycle(event: SessionEvent): void {
    const attributes = baseAttributes(event);
    if (event.type === "run.created") {
      copyString(attributes, "mode", event.data.mode);
      copyString(attributes, "workspace_kind", event.data.workspace_kind);
      copyNumber(attributes, "conversation_message_count", event.data.conversation_message_count);
      copyNumber(attributes, "max_turns", event.data.max_turns);
    } else if (event.type === "run.started") {
      copyString(attributes, "phase", event.data.phase);
    } else if (event.type === "run.interrupted") {
      attributes.status = "interrupted";
      copyString(attributes, "previous_status", event.data.previous_status, 32);
      copyBoolean(attributes, "awaiting_approval", event.data.awaiting_approval);
    } else if (event.type === "run.resumed") {
      attributes.status = "resumed";
      copyString(attributes, "restored_status", event.data.restored_status, 32);
      copyBoolean(attributes, "view_only", event.data.view_only);
      copyBoolean(attributes, "cancellation_pending", event.data.cancellation_pending);
    } else {
      attributes.status = event.type === "run.completed"
        ? "completed"
        : event.type === "run.failed"
          ? "failed"
          : "cancelled";
      copyString(attributes, "code", event.data.code);
    }
    this.#emit({
      kind: "log",
      name: "run.lifecycle",
      at: event.occurred_at,
      run_id: event.run_id,
      attributes,
      severity: event.type === "run.failed"
        ? "error"
        : event.type === "run.cancelled" || event.type === "run.interrupted"
          ? "warn"
          : "info",
    });
    if (
      event.type === "run.completed"
      || event.type === "run.failed"
      || event.type === "run.cancelled"
      || event.type === "run.interrupted"
    ) {
      this.#clearRunCorrelations(event.run_id);
    }
  }

  #recordModelStarted(event: SessionEvent): void {
    const attributes = baseAttributes(event);
    copyIdentifier(attributes, "model_call_id", event.model_call_id);
    copyString(attributes, "adapter", event.data.adapter, 100);
    copyString(attributes, "provider", event.data.provider, 100);
    copyString(attributes, "model", event.data.model, 200);
    copyString(attributes, "requested_reasoning_effort", event.data.requested_reasoning_effort, 32);
    copyString(attributes, "applied_reasoning_effort", event.data.applied_reasoning_effort, 32);
    copyString(attributes, "reasoning_configuration", event.data.reasoning_configuration, 32);
    const key = correlationKey(event.run_id, event.model_call_id);
    if (key !== undefined) {
      setBounded(this.#modelRequests, key, {
        startedAtMs: Date.parse(event.occurred_at),
        attributes: pickAttributes(attributes, ["model_call_id", "adapter", "provider", "model"]),
      });
      setBounded(this.#modelFallbackRetries, key, false);
    }
    this.#emit({
      kind: "log",
      name: "model.request",
      at: event.occurred_at,
      run_id: event.run_id,
      attributes,
      severity: "info",
    });
  }

  #recordModelFinished(event: SessionEvent): void {
    const key = correlationKey(event.run_id, event.model_call_id);
    const started = key === undefined ? undefined : this.#modelRequests.get(key);
    const fallbackRetry = key === undefined ? undefined : this.#modelFallbackRetries.get(key);
    if (key !== undefined) this.#modelRequests.delete(key);
    if (key !== undefined) this.#modelFallbackRetries.delete(key);
    const attributes = {
      ...baseAttributes(event),
      ...(started?.attributes ?? {}),
    };
    copyIdentifier(attributes, "model_call_id", event.model_call_id);
    copyString(attributes, "adapter", event.data.adapter, 100);
    copyString(attributes, "provider", event.data.provider, 100);
    copyString(attributes, "model", event.data.model, 200);
    if (fallbackRetry !== undefined) attributes.fallback_retry = fallbackRetry;
    if (event.type === "model.decision") {
      copyString(attributes, "decision_kind", event.data.decision_kind, 32);
      copyString(attributes, "risk", event.data.risk, 32);
      copyNumber(attributes, "tool_call_count", event.data.tool_call_count);
    } else {
      attributes.failure_type = event.type === "model.request_failed" ? "request_failed" : "output_invalid";
      copyString(attributes, "code", event.data.code);
    }
    this.#emit({
      kind: "span",
      name: "model.call",
      at: spanStartAt(started?.startedAtMs, event.occurred_at),
      run_id: event.run_id,
      attributes,
      duration_ms: elapsedMs(started?.startedAtMs, event.occurred_at),
      status: event.type === "model.decision" ? "ok" : "error",
    });
  }

  #recordModelUsage(event: SessionEvent): void {
    const totalTokens = finiteNonNegative(event.data.total_tokens);
    if (totalTokens === undefined) return;
    const attributes = baseAttributes(event);
    copyIdentifier(attributes, "model_call_id", event.model_call_id);
    copyString(attributes, "provider", event.data.provider, 100);
    copyString(attributes, "model", event.data.model, 200);
    copyString(attributes, "request_kind", event.data.request_kind, 32);
    copyNumber(attributes, "request_sequence", event.data.request_sequence);
    copyNumber(attributes, "input_tokens", event.data.input_tokens);
    copyNumber(attributes, "output_tokens", event.data.output_tokens);
    copyNumber(attributes, "cached_input_tokens", event.data.cached_input_tokens);
    copyNumber(attributes, "reasoning_output_tokens", event.data.reasoning_output_tokens);
    copyString(attributes, "cost_status", event.data.cost_status, 32);
    copyBoolean(attributes, "calibration_applied", event.data.calibration_applied);
    copyBoolean(attributes, "anomaly", event.data.anomaly);
    const fallbackRetry = event.data.request_kind === "repair"
      || (typeof event.data.request_sequence === "number" && event.data.request_sequence > 1);
    attributes.fallback_retry = fallbackRetry;
    const key = correlationKey(event.run_id, event.model_call_id);
    if (key !== undefined) setBounded(this.#modelFallbackRetries, key, fallbackRetry
      || this.#modelFallbackRetries.get(key) === true);
    this.#emit({
      kind: "metric",
      name: "model.tokens.total",
      at: event.occurred_at,
      run_id: event.run_id,
      attributes,
      value: totalTokens,
      unit: "tokens",
    });

    const reportedCost = plainRecord(event.data.provider_reported_cost);
    const amount = finiteNonNegative(reportedCost?.amount);
    const currency = boundedString(reportedCost?.currency, 40);
    if (amount === undefined || currency === undefined) return;
    this.#emit({
      kind: "metric",
      name: "model.cost",
      at: event.occurred_at,
      run_id: event.run_id,
      attributes: { ...attributes, currency },
      value: amount,
      unit: currency,
    });
  }

  #recordTool(event: SessionEvent): void {
    const parsed = ReceiptSchema.safeParse(event.data.receipt);
    if (!parsed.success) return;
    const receipt = parsed.data;
    const attributes = baseAttributes(event);
    copyIdentifier(attributes, "action_id", event.action_id ?? receipt.action_id);
    attributes.tool_name = receipt.tool_name;
    attributes.receipt_status = receipt.status;
    attributes.transport_status = receipt.transport_status;
    attributes.business_status = receipt.business_status;
    attributes.code = receipt.code.slice(0, 160);
    attributes.parallel = receipt.metadata.execution_parallel === true;
    copyNumber(attributes, "output_bytes", receipt.metadata.output_bytes);
    attributes.artifact_count = event.artifact_refs.length;
    // The canonical Event exposes bytes persisted as Artifacts, not the exact
    // size of every inline Tool result. Name this evidence precisely.
    attributes.artifact_bytes = event.artifact_refs.reduce((total, artifact) => total + artifact.byte_length, 0);
    copyString(attributes, "failure_code", event.data.code);
    copyBoolean(attributes, "recovered", event.data.recovered);
    this.#emit({
      kind: "span",
      name: "tool.call",
      at: receipt.started_at,
      run_id: event.run_id,
      attributes,
      duration_ms: boundedDuration(receipt.duration_ms),
      status: event.type === "tool.completed" && receipt.status === "success" ? "ok" : "error",
    });
  }

  #recordToolBatch(event: SessionEvent): void {
    const parsed = ToolBatchCompletedDataSchema.safeParse(event.data);
    if (!parsed.success) return;
    const batch = parsed.data;
    const attributes = baseAttributes(event);
    copyIdentifier(attributes, "batch_id", batch.batch_id);
    attributes.requested_count = batch.requested_count;
    attributes.completed_count = batch.completed_count;
    attributes.failed_count = batch.failed_count;
    attributes.max_concurrency = batch.max_concurrency;
    attributes.effective_concurrency = batch.effective_concurrency;
    this.#emit({
      kind: "span",
      name: "tool.batch",
      at: inferredStartAt(event.occurred_at, batch.total_duration_ms),
      run_id: event.run_id,
      attributes,
      duration_ms: boundedDuration(batch.total_duration_ms),
      status: batch.failed_count === 0 && batch.completed_count === batch.requested_count ? "ok" : "error",
    });
  }

  #recordCompactionStarted(event: SessionEvent): void {
    const attributes = baseAttributes(event);
    copyIdentifier(attributes, "model_call_id", event.model_call_id);
    copyString(attributes, "strategy", event.data.strategy, 80);
    copyString(attributes, "trigger", event.data.trigger, 80);
    copyNumber(attributes, "before_tokens", event.data.before_tokens);
    const key = compactionKey(event);
    if (key !== undefined) {
      setBounded(this.#compactions, key, {
        startedAtMs: Date.parse(event.occurred_at),
        attributes: pickAttributes(attributes, ["model_call_id", "strategy", "trigger", "before_tokens"]),
      });
    }
    this.#emit({
      kind: "log",
      name: "context.compaction.started",
      at: event.occurred_at,
      run_id: event.run_id,
      attributes,
      severity: "info",
    });
  }

  #recordCompactionCompleted(event: SessionEvent): void {
    const key = compactionKey(event);
    const started = key === undefined ? undefined : this.#compactions.get(key);
    if (key !== undefined) this.#compactions.delete(key);
    const attributes = {
      ...baseAttributes(event),
      ...(started?.attributes ?? {}),
    };
    copyIdentifier(attributes, "model_call_id", event.model_call_id);
    copyString(attributes, "strategy", event.data.strategy, 80);
    copyString(attributes, "applied_strategy", event.data.applied_strategy, 80);
    copyString(attributes, "trigger", event.data.trigger, 80);
    copyNumber(attributes, "before_tokens", event.data.before_tokens);
    copyNumber(attributes, "after_tokens", event.data.after_tokens);
    copyNumber(attributes, "checkpoint_tokens", event.data.checkpoint_tokens);
    copyNumber(attributes, "preserved_recent_message_count", event.data.preserved_recent_message_count);
    copyNumber(attributes, "compacted_history_message_count", event.data.compacted_history_message_count);
    const before = finiteNonNegative(event.data.before_tokens);
    const after = finiteNonNegative(event.data.after_tokens);
    if (before !== undefined && after !== undefined) attributes.tokens_saved = Math.max(0, before - after);
    this.#emit({
      kind: "span",
      name: "context.compaction",
      at: spanStartAt(started?.startedAtMs, event.occurred_at),
      run_id: event.run_id,
      attributes,
      duration_ms: elapsedMs(started?.startedAtMs, event.occurred_at),
      status: "ok",
    });
  }

  #recordApprovalRequested(event: SessionEvent): void {
    const identity = approvalIdentity(event);
    const attributes = baseAttributes(event);
    copyIdentifier(attributes, "approval_id", identity.approvalId);
    copyIdentifier(attributes, "action_id", identity.actionId ?? event.action_id);
    copyString(attributes, "tool_name", identity.toolName, 160);
    if (identity.approvalId !== undefined) {
      setBounded(this.#approvals, `${event.run_id}:${identity.approvalId}`, {
        startedAtMs: Date.parse(event.occurred_at),
        attributes: pickAttributes(attributes, ["approval_id", "action_id", "tool_name"]),
      });
    }
    this.#emit({
      kind: "log",
      name: "approval.requested",
      at: event.occurred_at,
      run_id: event.run_id,
      attributes,
      severity: "info",
    });
  }

  #recordApprovalFinished(event: SessionEvent): void {
    const identity = approvalIdentity(event);
    const key = identity.approvalId === undefined ? undefined : `${event.run_id}:${identity.approvalId}`;
    const started = key === undefined ? undefined : this.#approvals.get(key);
    if (key !== undefined) this.#approvals.delete(key);
    const attributes = {
      ...baseAttributes(event),
      ...(started?.attributes ?? {}),
    };
    copyIdentifier(attributes, "approval_id", identity.approvalId);
    copyIdentifier(attributes, "action_id", identity.actionId ?? event.action_id);
    attributes.outcome = event.type === "approval.granted"
      ? "granted"
      : event.type === "approval.expired"
        ? "expired"
        : "denied";
    if (event.type === "approval.denied") copyString(attributes, "reason", event.data.reason, 80);
    this.#emit({
      kind: "span",
      name: "approval.wait",
      at: spanStartAt(started?.startedAtMs, event.occurred_at),
      run_id: event.run_id,
      attributes,
      duration_ms: elapsedMs(started?.startedAtMs, event.occurred_at),
      status: event.type === "approval.granted" ? "ok" : "error",
    });
  }

  #recordSandbox(event: SessionEvent): void {
    const attributes = baseAttributes(event);
    let severity: "info" | "warn" = "info";
    if (event.type === "sandbox.configured") {
      const parsed = SandboxConfiguredDataSchema.safeParse(event.data);
      if (!parsed.success) return;
      attributes.mode = parsed.data.mode;
      attributes.platform = parsed.data.platform;
    } else if (event.type === "sandbox.enforced") {
      const parsed = SandboxEnforcedDataSchema.safeParse(event.data);
      if (!parsed.success) return;
      attributes.mode = parsed.data.sandbox_report.mode;
      attributes.platform = parsed.data.sandbox_report.platform;
      attributes.enforcement = parsed.data.sandbox_report.enforcement;
      attributes.mechanism_count = parsed.data.sandbox_report.mechanisms.length;
      attributes.unmet_constraint_count = parsed.data.sandbox_report.unmet_constraints.length;
      severity = parsed.data.sandbox_report.enforcement === "partial" ? "warn" : "info";
    } else {
      const parsed = SandboxDisabledDataSchema.safeParse(event.data);
      if (!parsed.success) return;
      attributes.mode = parsed.data.sandbox_report.mode;
      attributes.platform = parsed.data.sandbox_report.platform;
      attributes.enforcement = parsed.data.sandbox_report.enforcement;
      attributes.reason = parsed.data.reason;
      attributes.mechanism_count = parsed.data.sandbox_report.mechanisms.length;
      attributes.unmet_constraint_count = parsed.data.sandbox_report.unmet_constraints.length;
      severity = "warn";
    }
    this.#emit({
      kind: "log",
      name: "sandbox.configuration",
      at: event.occurred_at,
      run_id: event.run_id,
      attributes,
      severity,
    });
  }

  #emit(event: TelemetryEvent): void {
    this.#emitter.emit(event);
  }

  #remember(eventId: string): boolean {
    if (this.#recentEventIds.has(eventId)) return false;
    this.#recentEventIds.add(eventId);
    this.#recentEventOrder.push(eventId);
    if (this.#recentEventOrder.length > MAX_RECENT_EVENT_IDS) {
      const oldest = this.#recentEventOrder.shift();
      if (oldest !== undefined) this.#recentEventIds.delete(oldest);
    }
    return true;
  }

  #clearRunCorrelations(runId: string): void {
    const prefix = `${runId}:`;
    for (const key of this.#modelRequests.keys()) if (key.startsWith(prefix)) this.#modelRequests.delete(key);
    for (const key of this.#modelFallbackRetries.keys()) if (key.startsWith(prefix)) this.#modelFallbackRetries.delete(key);
    for (const key of this.#compactions.keys()) if (key.startsWith(prefix)) this.#compactions.delete(key);
    for (const key of this.#approvals.keys()) if (key.startsWith(prefix)) this.#approvals.delete(key);
  }
}

function baseAttributes(event: SessionEvent): Record<string, string | number | boolean> {
  return {
    event_type: event.type,
    sequence: event.sequence,
  };
}

function approvalIdentity(event: SessionEvent): {
  approvalId?: string;
  actionId?: string;
  toolName?: string;
} {
  const candidates = [
    plainRecord(event.data),
    plainRecord(event.data.approval),
    plainRecord(event.data.token),
    plainRecord(event.data.pending_approval),
  ];
  for (const candidate of candidates) {
    const approvalId = boundedString(candidate?.approval_id, 160);
    if (approvalId === undefined) continue;
    const actionId = boundedString(candidate?.action_id, 160);
    const toolName = boundedString(candidate?.tool_name, 160);
    return {
      approvalId,
      ...(actionId === undefined ? {} : { actionId }),
      ...(toolName === undefined ? {} : { toolName }),
    };
  }
  return {};
}

function compactionKey(event: SessionEvent): string | undefined {
  return correlationKey(event.run_id, event.model_call_id ?? event.turn_id);
}

function correlationKey(runId: string, correlationId: string | undefined): string | undefined {
  return correlationId === undefined ? undefined : `${runId}:${correlationId}`;
}

function elapsedMs(startedAtMs: number | undefined, completedAt: string): number {
  if (startedAtMs === undefined || !Number.isFinite(startedAtMs)) return 0;
  const completedAtMs = Date.parse(completedAt);
  if (!Number.isFinite(completedAtMs)) return 0;
  return boundedDuration(Math.max(0, completedAtMs - startedAtMs));
}

function spanStartAt(startedAtMs: number | undefined, fallback: string): string {
  return startedAtMs === undefined || !Number.isFinite(startedAtMs)
    ? fallback
    : new Date(startedAtMs).toISOString();
}

function inferredStartAt(completedAt: string, durationMs: number): string {
  const completedAtMs = Date.parse(completedAt);
  if (!Number.isFinite(completedAtMs)) return completedAt;
  return new Date(completedAtMs - boundedDuration(durationMs)).toISOString();
}

function boundedDuration(value: number): number {
  return Math.min(86_400_000, Math.max(0, Number.isFinite(value) ? value : 0));
}

function copyIdentifier(
  target: Record<string, string | number | boolean>,
  key: string,
  value: unknown,
): void {
  copyString(target, key, value, 160);
}

function copyString(
  target: Record<string, string | number | boolean>,
  key: string,
  value: unknown,
  maximum = 160,
): void {
  const normalized = boundedString(value, maximum);
  if (normalized !== undefined) target[key] = normalized;
}

function copyNumber(
  target: Record<string, string | number | boolean>,
  key: string,
  value: unknown,
): void {
  if (typeof value === "number" && Number.isFinite(value)) target[key] = value;
}

function copyBoolean(
  target: Record<string, string | number | boolean>,
  key: string,
  value: unknown,
): void {
  if (typeof value === "boolean") target[key] = value;
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  return normalized.slice(0, maximum);
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function pickAttributes(
  source: Record<string, string | number | boolean>,
  keys: readonly string[],
): Record<string, string | number | boolean> {
  const selected: Record<string, string | number | boolean> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) selected[key] = value;
  }
  return selected;
}

function setBounded<T>(map: Map<string, T>, key: string, value: T): void {
  if (!map.has(key) && map.size >= MAX_OPEN_CORRELATIONS) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

// Compile-time assertion that all emitted attribute bags remain compatible
// with the public telemetry package contract.
const _telemetryAttributeCompatibility: TelemetryAttributes = {};
void _telemetryAttributeCompatibility;
