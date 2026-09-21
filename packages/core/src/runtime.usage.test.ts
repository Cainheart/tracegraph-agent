import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceHandleSchema, type WorkspaceHandle } from "@tracegraph/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentRuntime, type AgentRuntime } from "./runtime.js";
import type { TokenMeter } from "./token-meter.js";
import { ModelRequestError, type ModelAdapter } from "./types.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
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
    const runtime = await createAgentRuntime({ dataDir: harness.dataDir, model });

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
    const runtime = await createAgentRuntime({ dataDir: harness.dataDir, model });

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
    const runtime = await createAgentRuntime({ dataDir: harness.dataDir, model });

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
    const runtime = await createAgentRuntime({
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
    const runtime = await createAgentRuntime({ dataDir: harness.dataDir, model });

    const started = await runtime.startRun(startInput(harness.workspace, "command:usage-failure"));
    const failed = await waitForTerminal(runtime, started.run_id);
    const types = failed.timeline.map((event) => event.type);

    expect(failed.status).toBe("failed");
    expect(types).toContain("model.usage_reported");
    expect(types).toContain("model.request_failed");
    expect(types.indexOf("model.usage_reported")).toBeLessThan(types.indexOf("model.request_failed"));
    expect(types.indexOf("model.request_failed")).toBeLessThan(types.indexOf("run.failed"));
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
