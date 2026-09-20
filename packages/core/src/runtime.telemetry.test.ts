import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ReceiptSchema,
  SessionEventSchema,
  WorkspaceHandleSchema,
  isTerminalEventType,
  type EventType,
  type SessionEvent,
  type WorkspaceHandle,
} from "@tracegraph/contracts";
import {
  SafeTelemetry,
  type TelemetryEvent,
  type TelemetrySink,
} from "@tracegraph/telemetry";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlEventLedger } from "./event-ledger.js";
import { createAgentRuntime, type AgentRuntime } from "./runtime.js";
import { RuntimeTelemetryProjector } from "./runtime-telemetry.js";
import { JsonlSessionStore, type SessionStore } from "./session-store.js";
import type { ModelAdapter } from "./types.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("runtime telemetry", () => {
  it("defaults to a disabled zero-I/O sink", async () => {
    const harness = await createHarness("noop");
    const runtime = await createAgentRuntime({ dataDir: harness.dataDir });

    expect(runtime.getTelemetryStatus()).toEqual({
      schema_version: "tracegraph.telemetry-status.v1",
      sink: "noop",
      state: "disabled",
      error_count: 0,
    });
    await expect(runtime.flushTelemetry()).resolves.toBeUndefined();
  });

  it("derives bounded telemetry from committed Events and flushes after a terminal Event", async () => {
    const harness = await createHarness("success");
    const sink = new RecordingSink();
    let decisionCount = 0;
    const model: ModelAdapter = {
      name: "telemetry-adapter",
      usageIdentity: () => ({ provider: "openai", model: "gpt-telemetry-test" }),
      publicRequestMetadata: () => ({
        adapter: "telemetry-adapter",
        provider: "openai",
        model: "gpt-telemetry-test",
        requested_reasoning_effort: "default",
        reasoning_configuration: "provider_default",
      }),
      async decide(input) {
        input.onUsage?.({
          provider: "openai",
          model: "gpt-telemetry-test",
          input_tokens: input.contextManifest.input_tokens,
          output_tokens: 7,
          cached_input_tokens: Math.min(2, input.contextManifest.input_tokens),
          total_tokens: input.contextManifest.input_tokens + 7,
          request_kind: "initial",
          request_sequence: 1,
          provider_reported_cost: { amount: 0.0025, currency: "USD" },
        });
        input.onUsage?.({
          provider: "openai",
          model: "gpt-telemetry-test",
          input_tokens: 3,
          output_tokens: 2,
          total_tokens: 5,
          request_kind: "repair",
          request_sequence: 2,
        });
        decisionCount += 1;
        if (decisionCount === 1) {
          return {
            decision_id: "decision:telemetry-tool",
            kind: "tool_call",
            public_reason: "Read the canonical Todo projection.",
            evidence_refs: [],
            risk: "low",
            expected_effect: "Produce bounded Tool evidence.",
            tool_call: {
              action_id: "action:telemetry-todo-read",
              tool_name: "todo_read",
              arguments: {},
            },
          };
        }
        return {
          decision_id: "decision:telemetry-success",
          kind: "finish",
          public_reason: "PRIVATE_PUBLIC_PLAN_MARKER",
          evidence_refs: [],
          risk: "none",
          final_answer: "PRIVATE_FINAL_ANSWER_MARKER",
        };
      },
    };
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      telemetrySink: sink,
      model,
    });

    const started = await runtime.startRun({
      command_id: "command:telemetry-success",
      project_id: harness.workspace.project_id,
      task: "PRIVATE_TASK_MARKER",
      mode: "execute",
      workspace: harness.workspace,
    });
    const completed = await waitForTerminal(runtime, started.run_id);
    await runtime.flushTelemetry();

    expect(completed.status).toBe("completed");
    expect(sink.flushCalls).toBeGreaterThanOrEqual(1);
    expect(runtime.getTelemetryStatus()).toEqual({
      schema_version: "tracegraph.telemetry-status.v1",
      sink: "custom",
      state: "active",
      error_count: 0,
    });
    expect(sink.events.map((event) => event.name)).toEqual(expect.arrayContaining([
      "run.lifecycle",
      "sandbox.configuration",
      "model.request",
      "model.tokens.total",
      "model.cost",
      "model.call",
      "tool.call",
    ]));
    expect(sink.events.some((event) => event.kind === "log"
      && event.name === "run.lifecycle"
      && event.attributes.event_type === "run.completed")).toBe(true);
    expect(sink.events.find((event) => event.name === "model.tokens.total")).toMatchObject({
      kind: "metric",
      unit: "tokens",
      attributes: {
        provider: "openai",
        model: "gpt-telemetry-test",
        input_tokens: expect.any(Number),
        output_tokens: 7,
        fallback_retry: false,
      },
    });
    expect(sink.events.some((event) => event.name === "model.tokens.total"
      && event.attributes.fallback_retry === true)).toBe(true);
    expect(sink.events.find((event) => event.name === "model.call")).toMatchObject({
      kind: "span",
      attributes: { fallback_retry: true },
    });
    expect(sink.events.find((event) => event.name === "tool.call")).toMatchObject({
      kind: "span",
      attributes: {
        tool_name: "todo_read",
        output_bytes: expect.any(Number),
      },
    });
    const outputBytes = sink.events.find((event) => event.name === "tool.call")?.attributes.output_bytes;
    expect(typeof outputBytes === "number" && outputBytes > 0).toBe(true);
    expect(JSON.stringify(sink.events)).not.toContain("PRIVATE_TASK_MARKER");
    expect(JSON.stringify(sink.events)).not.toContain("PRIVATE_PUBLIC_PLAN_MARKER");
    expect(JSON.stringify(sink.events)).not.toContain("PRIVATE_FINAL_ANSWER_MARKER");
    expect(JSON.stringify(sink.events)).not.toContain(harness.workspace.real_root);
  });

  it("keeps a terminal Run canonical when emit and flush both throw", async () => {
    const harness = await createHarness("failure-isolation");
    const sink = new ThrowingSink();
    const model: ModelAdapter = {
      name: "telemetry-throw-test",
      async decide() {
        return {
          decision_id: "decision:telemetry-throw-test",
          kind: "finish",
          public_reason: "Finish even though telemetry fails.",
          evidence_refs: [],
          risk: "none",
          final_answer: "Canonical completion survives.",
        };
      },
    };
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      telemetrySink: sink,
      model,
    });

    const started = await runtime.startRun({
      command_id: "command:telemetry-throw-test",
      project_id: harness.workspace.project_id,
      task: "Complete despite a broken telemetry transport.",
      mode: "execute",
      workspace: harness.workspace,
    });
    const completed = await waitForTerminal(runtime, started.run_id);
    await expect(runtime.flushTelemetry()).resolves.toBeUndefined();

    expect(completed.status).toBe("completed");
    expect(completed.timeline.at(-1)?.type).toBe("run.completed");
    expect(sink.flushCalls).toBeGreaterThanOrEqual(1);
    expect(runtime.getTelemetryStatus()).toMatchObject({
      schema_version: "tracegraph.telemetry-status.v1",
      sink: "custom",
      state: "degraded",
      error_count: expect.any(Number),
      last_error_at: expect.any(String),
    });
    expect(runtime.getTelemetryStatus().error_count).toBeGreaterThan(0);
    expect(JSON.stringify(completed.timeline)).not.toContain("SINK_FAILURE_PRIVATE_MARKER");
  });

  it("starts terminal flush before a derived Session index failure", async () => {
    const harness = await createHarness("terminal-index-failure");
    const sink = new RecordingSink();
    const failing = terminalIndexFailingStore(harness.dataDir);
    const model: ModelAdapter = {
      name: "telemetry-terminal-index-failure",
      async decide() {
        return {
          decision_id: "decision:terminal-index-failure",
          kind: "finish",
          public_reason: "Finish before the derived Session index fault.",
          evidence_refs: [],
          risk: "none",
          final_answer: "The Ledger remains canonical.",
        };
      },
    };
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      sessionStore: failing.store,
      telemetrySink: sink,
      model,
    });

    const started = await runtime.startRun({
      command_id: "command:terminal-index-failure",
      project_id: harness.workspace.project_id,
      task: "Prove the terminal export ordering.",
      mode: "execute",
      workspace: harness.workspace,
    });
    const completed = await waitForTerminal(runtime, started.run_id);
    await waitUntil(() => failing.terminalFailures() === 1);

    expect(completed.status).toBe("completed");
    expect(completed.timeline.at(-1)?.type).toBe("run.completed");
    expect(failing.terminalFailures()).toBe(1);
    expect(sink.flushCalls).toBeGreaterThanOrEqual(1);
  });

  it("uses an explicit attribute allowlist and deduplicates replayed ledger Events", () => {
    const sink = new RecordingSink();
    const safe = new SafeTelemetry(sink);
    const projector = new RuntimeTelemetryProjector(safe);
    const receipt = ReceiptSchema.parse({
      receipt_id: "receipt:allowlist",
      action_id: "action:allowlist",
      tool_name: "read_file",
      status: "success",
      transport_status: "success",
      business_status: "success",
      code: "ok",
      summary: "PRIVATE_RECEIPT_SUMMARY_MARKER",
      started_at: "2026-09-19T00:00:00.000Z",
      completed_at: "2026-09-19T00:00:00.025Z",
      duration_ms: 25,
      artifact_refs: [],
      metadata: {
        path: "PRIVATE_PATH_MARKER",
        output_bytes: 321,
        // Planned batch eligibility below says two calls may run together,
        // but the Receipt is the source of the actual execution fact.
        execution_parallel: false,
      },
    });
    const batchStarted = sessionEvent("tool.batch_started", 1, {
      batch_id: "batch:allowlist",
      requested_count: 2,
      max_concurrency: 2,
      effective_concurrency: 2,
      action_ids: ["action:allowlist", "action:parallel-peer"],
      parallel_action_ids: ["action:allowlist", "action:parallel-peer"],
      serialized_actions: [],
    });
    const toolEvent = sessionEvent("tool.completed", 2, {
      receipt,
      observation: {
        summary: "PRIVATE_OBSERVATION_MARKER",
        facts: { path: "PRIVATE_PATH_MARKER" },
      },
      explanation: "PRIVATE_EXPLANATION_MARKER",
    }, {
      action_id: "action:allowlist",
    });
    const approvalRequested = sessionEvent("approval.requested", 3, {
      approval_id: "approval:allowlist",
      action_id: "action:allowlist",
      tool_name: "commit_patch",
      explanation: "PRIVATE_APPROVAL_EXPLANATION_MARKER",
      path: "PRIVATE_APPROVAL_PATH_MARKER",
    });
    const approvalDenied = sessionEvent("approval.denied", 4, {
      approval_id: "approval:allowlist",
      action_id: "action:allowlist",
      reason: "rejected",
      explanation: "PRIVATE_DENIAL_EXPLANATION_MARKER",
    });
    const compactionStarted = sessionEvent("context.compaction_started", 5, {
      strategy: "strategy_chain",
      trigger: "threshold",
      before_tokens: 1_000,
      source_text: "PRIVATE_COMPACTION_SOURCE_MARKER",
    }, {
      model_call_id: "model-call:compaction",
      turn_id: "turn:compaction",
    });
    const compactionCompleted = sessionEvent("context.compaction_completed", 6, {
      strategy: "strategy_chain",
      applied_strategy: "tiered_checkpoint",
      trigger: "threshold",
      before_tokens: 1_000,
      after_tokens: 600,
      checkpoint_tokens: 120,
      preserved_recent_message_count: 2,
      compacted_history_message_count: 8,
      steps: [{ summary: "PRIVATE_COMPACTION_STEP_MARKER" }],
    }, {
      model_call_id: "model-call:compaction",
      turn_id: "turn:compaction",
    });
    const batchCompleted = sessionEvent("tool.batch_completed", 7, {
      batch_id: "batch:allowlist",
      requested_count: 2,
      completed_count: 2,
      failed_count: 0,
      max_concurrency: 2,
      effective_concurrency: 2,
      total_duration_ms: 30,
      action_ids: ["action:allowlist", "action:parallel-peer"],
      results: [{
        action_id: "action:allowlist",
        status: "success",
        duration_ms: 25,
        code: "ok",
      }, {
        action_id: "action:parallel-peer",
        status: "success",
        duration_ms: 20,
        code: "ok",
      }],
    });
    const interrupted = sessionEvent("run.interrupted", 8, {
      previous_status: "running",
      awaiting_approval: false,
      reason: "PRIVATE_INTERRUPTION_REASON_MARKER",
    });
    const resumed = sessionEvent("run.resumed", 9, {
      restored_status: "interrupted",
      view_only: true,
    });
    const incompleteBatch = sessionEvent("tool.batch_completed", 10, {
      batch_id: "batch:incomplete",
      requested_count: 2,
      completed_count: 1,
      failed_count: 0,
      max_concurrency: 2,
      effective_concurrency: 1,
      total_duration_ms: 12,
      action_ids: ["action:one", "action:two"],
      results: [{
        action_id: "action:one",
        status: "success",
        duration_ms: 10,
        code: "ok",
      }],
    });

    projector.record(batchStarted);
    projector.record(toolEvent);
    projector.record(toolEvent);
    projector.record(approvalRequested);
    projector.record(approvalDenied);
    projector.record(compactionStarted);
    projector.record(compactionCompleted);
    projector.record(batchCompleted);
    projector.record(interrupted);
    projector.record(resumed);
    projector.record(incompleteBatch);

    expect(sink.events.filter((event) => event.name === "tool.call")).toHaveLength(1);
    expect(sink.events.find((event) => event.name === "tool.call")).toMatchObject({
      kind: "span",
      at: "2026-09-19T00:00:00.000Z",
      duration_ms: 25,
      status: "ok",
      attributes: {
        tool_name: "read_file",
        action_id: "action:allowlist",
        parallel: false,
        output_bytes: 321,
        artifact_bytes: 0,
      },
    });
    expect(sink.events.filter((event) => event.name === "run.lifecycle")).toEqual([
      expect.objectContaining({
        kind: "log",
        severity: "warn",
        attributes: expect.objectContaining({
          event_type: "run.interrupted",
          status: "interrupted",
          previous_status: "running",
        }),
      }),
      expect.objectContaining({
        kind: "log",
        severity: "info",
        attributes: expect.objectContaining({
          event_type: "run.resumed",
          status: "resumed",
          restored_status: "interrupted",
          view_only: true,
        }),
      }),
    ]);
    expect(sink.events.find((event) => event.name === "approval.wait")).toMatchObject({
      kind: "span",
      at: "2026-09-19T00:00:03.000Z",
      duration_ms: 1_000,
      status: "error",
      attributes: {
        approval_id: "approval:allowlist",
        action_id: "action:allowlist",
        tool_name: "commit_patch",
        reason: "rejected",
      },
    });
    expect(sink.events.find((event) => event.name === "context.compaction")).toMatchObject({
      kind: "span",
      at: "2026-09-19T00:00:05.000Z",
      duration_ms: 1_000,
      status: "ok",
      attributes: {
        before_tokens: 1_000,
        after_tokens: 600,
        tokens_saved: 400,
      },
    });
    expect(sink.events.find((event) => event.name === "tool.batch")).toMatchObject({
      kind: "span",
      at: "2026-09-19T00:00:06.970Z",
      duration_ms: 30,
      status: "ok",
      attributes: {
        requested_count: 2,
        completed_count: 2,
        failed_count: 0,
        effective_concurrency: 2,
      },
    });
    expect(sink.events.find((event) => (
      event.name === "tool.batch" && event.attributes.batch_id === "batch:incomplete"
    ))).toMatchObject({
      kind: "span",
      status: "error",
      attributes: {
        requested_count: 2,
        completed_count: 1,
        failed_count: 0,
        effective_concurrency: 1,
      },
    });
    const serialized = JSON.stringify(sink.events);
    for (const marker of [
      "PRIVATE_EVENT_SUMMARY_MARKER",
      "PRIVATE_RECEIPT_SUMMARY_MARKER",
      "PRIVATE_OBSERVATION_MARKER",
      "PRIVATE_PATH_MARKER",
      "PRIVATE_EXPLANATION_MARKER",
      "PRIVATE_APPROVAL_EXPLANATION_MARKER",
      "PRIVATE_APPROVAL_PATH_MARKER",
      "PRIVATE_DENIAL_EXPLANATION_MARKER",
      "PRIVATE_COMPACTION_SOURCE_MARKER",
      "PRIVATE_COMPACTION_STEP_MARKER",
      "PRIVATE_INTERRUPTION_REASON_MARKER",
    ]) expect(serialized).not.toContain(marker);
  });
});

class RecordingSink implements TelemetrySink {
  readonly kind = "custom" as const;
  readonly events: TelemetryEvent[] = [];
  flushCalls = 0;

  emit(event: TelemetryEvent): void {
    this.events.push(event);
  }

  async flush(): Promise<void> {
    this.flushCalls += 1;
  }
}

class ThrowingSink implements TelemetrySink {
  readonly kind = "custom" as const;
  flushCalls = 0;

  emit(_event: TelemetryEvent): void {
    throw new Error("SINK_FAILURE_PRIVATE_MARKER");
  }

  async flush(): Promise<void> {
    this.flushCalls += 1;
    throw new Error("SINK_FAILURE_PRIVATE_MARKER");
  }
}

function terminalIndexFailingStore(dataDir: string): {
  readonly store: SessionStore;
  readonly terminalFailures: () => number;
} {
  const delegate = new JsonlSessionStore(join(dataDir, "sessions"));
  const ledger = new JsonlEventLedger(join(dataDir, "events"));
  let terminalFailures = 0;
  const store: SessionStore = {
    initialize: () => delegate.initialize(),
    create: (header) => delegate.create(header),
    async append(sessionId, entry, lease) {
      const event = (await ledger.list(entry.event_ref.run_id))
        .find((candidate) => candidate.event_id === entry.event_ref.event_id);
      if (event !== undefined && isTerminalEventType(event.type)) {
        terminalFailures += 1;
        throw new Error("Injected derived Session index failure");
      }
      await delegate.append(sessionId, entry, lease);
    },
    readAll: (sessionId, lease) => delegate.readAll(sessionId, lease),
    list: (query, allowedProjectIds) => delegate.list(query, allowedProjectIds),
    rename: (sessionId, title, lease) => delegate.rename(sessionId, title, lease),
    delete: (sessionId, lease) => delegate.delete(sessionId, lease),
    acquireLease: (sessionId) => delegate.acquireLease(sessionId),
  };
  return { store, terminalFailures: () => terminalFailures };
}

async function createHarness(name: string): Promise<{ dataDir: string; workspace: WorkspaceHandle }> {
  const root = await mkdtemp(join(tmpdir(), `tracegraph-runtime-telemetry-${name}-`));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  return {
    dataDir: join(root, "data"),
    workspace: WorkspaceHandleSchema.parse({
      handle_id: `workspace:telemetry-${name}`,
      project_id: `project:telemetry-${name}`,
      real_root: workspaceRoot,
      workspace_kind: "readonly_local",
      capabilities: {
        index: false,
        read: false,
        search: false,
        run_command: false,
        preview_patch: false,
        commit_patch: false,
        test: false,
      },
      created_at: "2026-09-19T00:00:00.000Z",
    }),
  };
}

function sessionEvent(
  type: EventType,
  sequence: number,
  data: Record<string, unknown>,
  fields: Partial<Pick<SessionEvent, "action_id" | "model_call_id" | "turn_id">> = {},
): SessionEvent {
  return SessionEventSchema.parse({
    schema_version: "tracegraph.session-event.v1",
    event_id: `event:telemetry:${sequence}`,
    type,
    project_id: "project:telemetry-allowlist",
    run_id: "run:telemetry-allowlist",
    sequence,
    occurred_at: `2026-09-19T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    attempt: 0,
    summary: "PRIVATE_EVENT_SUMMARY_MARKER",
    artifact_refs: [],
    event_hash: `sha256:${"a".repeat(64)}`,
    data,
    ...fields,
  });
}

async function waitForTerminal(runtime: AgentRuntime, runId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const projection = await runtime.getProjection(runId);
    if (["completed", "failed", "cancelled"].includes(projection.status)) return projection;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const projection = await runtime.getProjection(runId);
  throw new Error(`Timed out waiting for a terminal Run: ${JSON.stringify({
    status: projection.status,
    timeline: projection.timeline.map((event) => event.type),
  })}`);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for the injected Session index failure");
}
