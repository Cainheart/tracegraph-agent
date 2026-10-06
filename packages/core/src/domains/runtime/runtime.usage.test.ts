import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceHandleSchema, type WorkspaceHandle } from "@tracegraph/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentRuntime, type AgentRuntime } from "./runtime.js";
import type { TokenMeter } from "@tracegraph/context";
import { ModelRequestError, type ModelAdapter } from "../../kernel/types.js";

const cleanups: Array<() => Promise<void>> = [];

type TrackedRuntime = Awaited<ReturnType<typeof createAgentRuntime>>;

const trackedRuntimes: TrackedRuntime[] = [];

/** Registers a Runtime so teardown drains its nonblocking background work before its data directory goes away. */
async function createTrackedRuntime(
  options: Parameters<typeof createAgentRuntime>[0],
): Promise<TrackedRuntime> {
  const runtime = await createAgentRuntime(options);
  trackedRuntimes.push(runtime);
  return runtime;
}

afterEach(async () => {
  await Promise.all(trackedRuntimes.splice(0).map((runtime) => runtime.shutdownBackgroundWork?.()));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("runtime provider usage accounting", () => {
  it("does not advertise workspace tools to a capability-free plain chat Run", async () => {
    const harness = await createHarness();
    let visibleTools: readonly string[] = [];
    const model: ModelAdapter = {
      name: "plain-chat-catalog-adapter",
      async decide(input) {
        visibleTools = input.toolSchemas.map(({ name }) => name);
        return finishDecision("plain-chat-catalog");
      },
    };
    const runtime = await createTrackedRuntime({ dataDir: harness.dataDir, model });

    const started = await runtime.startRun(startInput(harness.workspace, "command:plain-chat-catalog"));
    const completed = await waitForTerminal(runtime, started.run_id);

    expect(completed.status).toBe("completed");
    expect(visibleTools).not.toEqual(expect.arrayContaining([
      "read_file",
      "list_dir",
      "search",
      "run_command",
      "preview_patch",
      "commit_patch",
      "run_test",
    ]));
  });

  it("persists initial and repair usage before the decision and emits an estimate anomaly", async () => {
    const harness = await createHarness();
    let manifestInputTokens = 0;
    const model: ModelAdapter = {
      name: "usage-reporting-adapter",
      usageIdentity: () => ({ provider: "openai", model: "gpt-usage-test" }),
      async decide(input) {
        manifestInputTokens = input.contextManifest.input_tokens;
        const reportedInput = manifestInputTokens * 2;
        input.onUsage?.({
          provider: "openai",
          model: "gpt-usage-test",
          input_tokens: reportedInput,
          output_tokens: 11,
          cached_input_tokens: Math.min(3, reportedInput),
          total_tokens: reportedInput + 11,
          request_kind: "initial",
          request_sequence: 1,
        });
        input.onUsage?.({
          provider: "openai",
          model: "gpt-usage-test",
          input_tokens: 14,
          output_tokens: 6,
          total_tokens: 20,
          request_kind: "repair",
          request_sequence: 2,
          provider_reported_cost: { amount: 0.0012, currency: "USD" },
        });
        return finishDecision("usage-success");
      },
    };
    const runtime = await createTrackedRuntime({ dataDir: harness.dataDir, model });

    const started = await runtime.startRun(startInput(harness.workspace, "command:usage-success"));
    const completed = await waitForTerminal(runtime, started.run_id);
    const context = completed.timeline.find((event) => event.type === "context.built");
    const usageEvents = completed.timeline.filter((event) => event.type === "model.usage_reported");
    const initial = usageEvents.find((event) => event.data.request_kind === "initial");
    const repair = usageEvents.find((event) => event.data.request_kind === "repair");
    const anomaly = completed.timeline.find((event) => event.type === "model.usage_anomaly");
    const types = completed.timeline.map((event) => event.type);
    const estimate = context?.data.token_estimate as {
      input_tokens: number;
      estimator_id: string;
      confidence: string;
      per_section: Record<string, number>;
    };

    expect(completed.status).toBe("completed");
    expect(manifestInputTokens).toBeGreaterThan(0);
    expect(estimate).toMatchObject({
      input_tokens: manifestInputTokens,
      estimator_id: "heuristic_v2",
      confidence: "estimated",
    });
    expect(Object.values(estimate.per_section).reduce((sum, count) => sum + count, 0))
      .toBe(manifestInputTokens);
    expect(initial?.data).toMatchObject({
      provider: "openai",
      model: "gpt-usage-test",
      estimated_input_tokens: manifestInputTokens,
      input_tokens: manifestInputTokens * 2,
      delta_ratio: 2,
      anomaly: true,
      calibration_applied: true,
      cost_status: "unavailable",
    });
    expect(repair?.data).toMatchObject({
      request_kind: "repair",
      request_sequence: 2,
      calibration_applied: false,
      cost_status: "provider_reported",
      provider_reported_cost: { amount: 0.0012, currency: "USD" },
    });
    expect(repair?.data).not.toHaveProperty("delta_ratio");
    expect(repair?.data).not.toHaveProperty("calibration_revision");
    expect(repair?.data).not.toHaveProperty("estimated_input_tokens");
    expect(anomaly?.data).toMatchObject({
      request_kind: "initial",
      delta_ratio: 2,
      anomaly: true,
    });
    expect(types.indexOf("model.request_started")).toBeLessThan(types.indexOf("model.usage_reported"));
    expect(types.indexOf("model.usage_reported")).toBeLessThan(types.indexOf("model.decision"));
    expect(completed.timeline.map((event) => event.sequence)).toEqual(
      completed.timeline.map((_, index) => index + 1),
    );
  });

  it("completes normally when an adapter reports no usage", async () => {
    const harness = await createHarness();
    const model: ModelAdapter = {
      name: "usage-optional-adapter",
      async decide() {
        return finishDecision("usage-absent");
      },
    };
    const runtime = await createTrackedRuntime({ dataDir: harness.dataDir, model });

    const started = await runtime.startRun(startInput(harness.workspace, "command:usage-absent"));
    const completed = await waitForTerminal(runtime, started.run_id);

    expect(completed.status).toBe("completed");
    expect(completed.timeline.some((event) => event.type === "model.usage_reported")).toBe(false);
    expect(completed.timeline.some((event) => event.type === "model.usage_anomaly")).toBe(false);
  });

  it("degrades safely when calibration initialization and observation are unavailable", async () => {
    const harness = await createHarness();
    const unavailableMeter: TokenMeter = {
      initialize: async () => { throw new Error("calibration store unavailable"); },
      revision: () => 0,
      estimate: () => { throw new Error("counter unavailable"); },
      observeUsage: async () => { throw new Error("calibration write unavailable"); },
    };
    const model: ModelAdapter = {
      name: "usage-with-unavailable-meter",
      usageIdentity: () => ({ provider: "custom", model: "custom-usage-model" }),
      async decide(input) {
        input.onUsage?.({
          provider: "custom",
          model: "custom-usage-model",
          input_tokens: input.contextManifest.input_tokens,
          output_tokens: 4,
          total_tokens: input.contextManifest.input_tokens + 4,
          request_kind: "initial",
          request_sequence: 1,
        });
        return finishDecision("meter-unavailable");
      },
    };
    const runtime = await createTrackedRuntime({
      dataDir: harness.dataDir,
      model,
      tokenMeter: unavailableMeter,
    });

    const started = await runtime.startRun(startInput(harness.workspace, "command:meter-unavailable"));
    const completed = await waitForTerminal(runtime, started.run_id);
    const context = completed.timeline.find((event) => event.type === "context.built");
    const usage = completed.timeline.find((event) => event.type === "model.usage_reported");

    expect(completed.status).toBe("completed");
    expect(context?.data.token_estimate).toMatchObject({
      estimator_id: "heuristic_v2",
      confidence: "estimated",
    });
    expect(usage?.data).toMatchObject({
      provider: "custom",
      model: "custom-usage-model",
      confidence: "provider_reported",
      calibration_applied: false,
      delta_ratio: 1,
      anomaly: false,
      cost_status: "unavailable",
    });
  });

  it("flushes provider usage before a model request failure", async () => {
    const harness = await createHarness();
    const model: ModelAdapter = {
      name: "failing-usage-adapter",
      usageIdentity: () => ({ provider: "anthropic", model: "claude-usage-test" }),
      async decide(input) {
        const reportedInput = input.contextManifest.input_tokens;
        input.onUsage?.({
          provider: "anthropic",
          model: "claude-usage-test",
          input_tokens: reportedInput,
          output_tokens: 2,
          total_tokens: reportedInput + 2,
          request_kind: "initial",
          request_sequence: 1,
        });
        throw new ModelRequestError("model_http_503", "Provider unavailable");
      },
    };
    const runtime = await createTrackedRuntime({ dataDir: harness.dataDir, model });

    const started = await runtime.startRun(startInput(harness.workspace, "command:usage-failure"));
    const failed = await waitForTerminal(runtime, started.run_id);
    const types = failed.timeline.map((event) => event.type);

    expect(failed.status).toBe("failed");
    expect(types).toContain("model.usage_reported");
    expect(types).toContain("model.request_failed");
    expect(types.indexOf("model.usage_reported")).toBeLessThan(types.indexOf("model.request_failed"));
    expect(types.indexOf("model.request_failed")).toBeLessThan(types.indexOf("run.failed"));
  });

  it("retries transient model provider failures with a bounded, durable schedule", async () => {
    const harness = await createHarness();
    let calls = 0;
    const model: ModelAdapter = {
      name: "transient-retry-adapter",
      async decide() {
        calls += 1;
        if (calls < 3) throw new ModelRequestError("model_http_503", "Provider unavailable");
        return finishDecision("transient-retry-success");
      },
    };
    const runtime = await createTrackedRuntime({ dataDir: harness.dataDir, model });

    const started = await runtime.startRun(startInput(harness.workspace, "command:transient-retry"));
    const completed = await waitForTerminal(runtime, started.run_id);
    const retries = completed.timeline.filter((event) => event.type === "model.retry_scheduled");
    const requestStart = completed.timeline.find((event) => event.type === "model.request_started");
    const decision = completed.timeline.find((event) => event.type === "model.decision");

    expect(completed.status).toBe("completed");
    expect(calls).toBe(3);
    expect(retries.map(({ data }) => data)).toEqual([
      {
        retry_scope: "model_provider",
        attempt: 1,
        next_attempt: 2,
        max_attempts: 6,
        delay_ms: 500,
        reason_code: "http_503",
      },
      {
        retry_scope: "model_provider",
        attempt: 2,
        next_attempt: 3,
        max_attempts: 6,
        delay_ms: 1_000,
        reason_code: "http_503",
      },
    ]);
    expect(requestStart?.data.retry_taxonomy).toMatchObject({
      model_provider: { max_attempts: 6, base_backoff_ms: 500, max_backoff_ms: 10_000 },
      tool: { max_automatic_dispatch_attempts: 1, replay_policy: "disabled" },
      action: { max_dispatch_attempts_per_operation: 1, unknown_outcome: "reconcile_only" },
    });
    expect(decision?.data).toMatchObject({
      provider_attempts: 3,
      provider_retry_count: 2,
      provider_retry_delays_ms: [500, 1_000],
    });
  });

  it.each(["model_http_401", "model_http_400"])("does not retry permanent provider error %s", async (code) => {
    const harness = await createHarness();
    let calls = 0;
    const model: ModelAdapter = {
      name: "permanent-error-adapter",
      async decide() {
        calls += 1;
        throw new ModelRequestError(code, "Provider rejected the request");
      },
    };
    const runtime = await createTrackedRuntime({ dataDir: harness.dataDir, model });

    const started = await runtime.startRun(startInput(harness.workspace, `command:${code}`));
    const failed = await waitForTerminal(runtime, started.run_id);

    expect(failed.status).toBe("failed");
    expect(calls).toBe(1);
    expect(failed.timeline.some((event) => event.type === "model.retry_scheduled")).toBe(false);
  });

  it("does not retry after provider usage has been reported", async () => {
    const harness = await createHarness();
    let calls = 0;
    const model: ModelAdapter = {
      name: "usage-reported-transient-error-adapter",
      async decide(input) {
        calls += 1;
        input.onUsage?.({
          provider: "custom",
          model: "reported-before-error",
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          request_kind: "initial",
          request_sequence: 1,
        });
        throw new ModelRequestError("model_http_503", "Provider unavailable after response");
      },
    };
    const runtime = await createTrackedRuntime({ dataDir: harness.dataDir, model });

    const started = await runtime.startRun(startInput(harness.workspace, "command:usage-retry-boundary"));
    const failed = await waitForTerminal(runtime, started.run_id);

    expect(failed.status).toBe("failed");
    expect(calls).toBe(1);
    expect(failed.timeline.some((event) => event.type === "model.retry_scheduled")).toBe(false);
    expect(failed.timeline.filter((event) => event.type === "model.usage_reported")).toHaveLength(1);
  });

  it("cancels during provider backoff without dispatching another attempt", async () => {
    const harness = await createHarness();
    let calls = 0;
    const model: ModelAdapter = {
      name: "cancel-provider-backoff-adapter",
      async decide() {
        calls += 1;
        throw new ModelRequestError("model_http_503", "Provider unavailable");
      },
    };
    const runtime = await createTrackedRuntime({ dataDir: harness.dataDir, model });

    const started = await runtime.startRun(startInput(harness.workspace, "command:cancel-provider-backoff"));
    await waitForEventType(runtime, started.run_id, "model.retry_scheduled");
    await runtime.submitUserInput({
      type: "submit_user_input",
      command_id: "command:cancel-provider-backoff:cancel",
      input_id: "input:cancel-provider-backoff",
      project_id: started.project_id,
      run_id: started.run_id,
      kind: "cancel",
      body: "Cancel this run",
      actor: "user",
    });
    const cancelled = await waitForTerminal(runtime, started.run_id);

    expect(cancelled.status).toBe("cancelled");
    expect(calls).toBe(1);
    expect(cancelled.timeline.filter((event) => event.type === "model.retry_scheduled")).toHaveLength(1);
    expect(cancelled.timeline.some((event) => event.type === "model.request_failed")).toBe(false);
  });
});

async function createHarness(): Promise<{ dataDir: string; workspace: WorkspaceHandle }> {
  const root = await mkdtemp(join(tmpdir(), "tracegraph-runtime-usage-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  return {
    dataDir: join(root, "data"),
    workspace: WorkspaceHandleSchema.parse({
      handle_id: "workspace:usage-test",
      project_id: "project:usage-test",
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
      created_at: "2026-09-18T00:00:00.000Z",
    }),
  };
}

function startInput(workspace: WorkspaceHandle, commandId: string) {
  return {
    command_id: commandId,
    project_id: workspace.project_id,
    task: "Return a direct answer after accounting for provider usage.",
    mode: "execute" as const,
    workspace,
  };
}

function finishDecision(suffix: string) {
  return {
    decision_id: `decision:${suffix}`,
    kind: "finish" as const,
    public_reason: "The direct response is ready.",
    evidence_refs: [],
    risk: "none" as const,
    final_answer: "Completed.",
  };
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

async function waitForEventType(runtime: AgentRuntime, runId: string, type: "model.retry_scheduled"): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const projection = await runtime.getProjection(runId);
    if (projection.timeline.some((event) => event.type === type)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${type}`);
}
