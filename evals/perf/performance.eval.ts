import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  createAgentRuntime,
  createDefaultToolRegistry,
  createReadonlyWorkspaceHandle,
  executeToolDefinition,
  removeControlledTemporaryDirectory,
  type AgentRuntime,
  type ModelAdapter,
} from "../../packages/core/dist/index.js";
import { createTraceGraphHost } from "../../packages/host/dist/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PERFORMANCE_METRIC_NAMES,
  assertMetricsWithinBaseline,
  percentile,
  readPerformanceBaseline,
  recordEvalMetric,
  writePerformanceBaseline,
  type EvalMetricObservation,
  type PerformanceBaseline,
  type PerformanceMetricName,
} from "../support/metrics.js";

const BASELINE_PATH = new URL("../baselines/performance.json", import.meta.url).pathname;
const FIXED_NOW = new Date("2026-09-19T00:00:00.000Z");
const ORIGIN = "http://127.0.0.1:4310";
const CONTEXT_TASK = "Preserve recent evidence while compacting a deliberately long conversation.";
const CONTEXT_HISTORY = Array.from({ length: 24 }, (_, index) => ({
  role: index % 2 === 0 ? "user" as const : "assistant" as const,
  content: `history-${index} ${"deterministic context evidence ".repeat(24)}`,
}));
const CONTEXT_POLICY = {
  window_tokens: 2_048,
  reserved_output_tokens: 512,
  warning_ratio: 0.55,
  compression_ratio: 0.6,
  recent_history_messages: 4,
  history_checkpoint_tokens: 128,
  tool_budget_ratio: 0.1,
  token_estimator: "heuristic_v2" as const,
};

let cleanup: (() => Promise<void>) | undefined;
let observations: Record<PerformanceMetricName, EvalMetricObservation>;
let baseline: PerformanceBaseline;

beforeAll(async () => {
  const measured = await measureRepresentativePath();
  observations = measured.observations;
  cleanup = measured.cleanup;
  const previous = await readPerformanceBaseline(BASELINE_PATH);
  baseline = process.env.TRACEGRAPH_EVAL_UPDATE === "1"
    ? await writePerformanceBaseline(BASELINE_PATH, observations, previous)
    : previous;
  await Promise.all(PERFORMANCE_METRIC_NAMES.map((name) => recordEvalMetric(observations[name])));
});

afterAll(async () => {
  await cleanup?.();
});

describe("G16 offline performance gates", () => {
  it("keeps compacted Context, model calls, tool P95, and SSE first byte within reviewable baselines", () => {
    expect(() => assertMetricsWithinBaseline(observations, baseline)).not.toThrow();
  });

  it("proves the compaction/token gate fails when its threshold is made too low", () => {
    const actual = observations["context.built.input_tokens"];
    expect(actual.value).toBeGreaterThan(0);
    const broken: PerformanceBaseline = {
      ...baseline,
      metrics: {
        ...baseline.metrics,
        "context.built.input_tokens": {
          ...baseline.metrics["context.built.input_tokens"],
          max: actual.value - 1,
        },
      },
    };
    expect(() => assertMetricsWithinBaseline(observations, broken))
      .toThrow(/context\.built\.input_tokens/u);
  });

  it("proves a latency regression cannot pass under an artificially low threshold", () => {
    const actual = observations["sse.first_byte_ms"];
    const broken: PerformanceBaseline = {
      ...baseline,
      metrics: {
        ...baseline.metrics,
        "sse.first_byte_ms": {
          ...baseline.metrics["sse.first_byte_ms"],
          max: actual.value / 2,
        },
      },
    };
    expect(() => assertMetricsWithinBaseline(observations, broken))
      .toThrow(/sse\.first_byte_ms/u);
  });
});

async function measureRepresentativePath(): Promise<{
  observations: Record<PerformanceMetricName, EvalMetricObservation>;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "tracegraph-g16-perf-"));
  const workspaceRoot = join(root, "workspace");
  const dataDir = join(root, "data");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, "probe.txt"), "bounded offline probe\n", "utf8");
  const workspace = await createReadonlyWorkspaceHandle({
    projectId: "project:g16-performance",
    root: workspaceRoot,
  });

  const model: ModelAdapter = {
    name: "g16-offline-direct-answer",
    async decide() {
      return {
        decision_id: "decision:g16-finish",
        kind: "finish",
        public_reason: "The deterministic offline answer is ready.",
        evidence_refs: [],
        risk: "none",
        final_answer: "Completed offline.",
      };
    },
  };
  const runtime = await createAgentRuntime({
    dataDir,
    model,
    now: () => FIXED_NOW,
    idFactory: sequentialIds(),
    contextPolicy: CONTEXT_POLICY,
  });
  const started = await runtime.startRun({
    command_id: "command:g16-performance",
    project_id: workspace.project_id,
    task: CONTEXT_TASK,
    mode: "execute",
    workspace,
    conversation_history: CONTEXT_HISTORY,
  });
  const completed = await waitForTerminal(runtime, started.run_id);
  const contextBuilt = completed.timeline.find((event) => event.type === "context.built");
  const inputTokens = contextBuilt?.data.input_tokens;
  const compression = contextBuilt?.data.compression as { applied_strategy?: unknown } | undefined;
  if (typeof inputTokens !== "number" || compression?.applied_strategy === undefined
    || compression.applied_strategy === "none") {
    throw new Error("G16 Runtime fixture no longer emits a compacted context.built metric");
  }
  const modelCalls = completed.timeline.filter((event) => event.type === "model.request_started").length;
  const toolP95 = await measureToolP95(workspace);
  const sseFirstByte = await measureSseFirstByte(runtime, workspace, completed.run_id);

  return {
    observations: {
      "context.built.input_tokens": metric(
        "context.built.input_tokens",
        inputTokens,
        "tokens",
        "compacted-context",
      ),
      "run.model_calls": metric("run.model_calls", modelCalls, "calls", "direct-answer-run"),
      "tool.call.p95_ms": metric("tool.call.p95_ms", toolP95, "ms", "bounded-read-file"),
      "sse.first_byte_ms": metric("sse.first_byte_ms", sseFirstByte, "ms", "loopback-ledger-stream"),
    },
    cleanup: () => removeControlledTemporaryDirectory(root),
  };
}

async function measureToolP95(workspace: Awaited<ReturnType<typeof createReadonlyWorkspaceHandle>>): Promise<number> {
  const definition = createDefaultToolRegistry().get("read_file");
  if (definition === undefined) throw new Error("read_file tool is unavailable");
  const samples: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    const start = performance.now();
    const result = await executeToolDefinition(definition, { path: "probe.txt" }, {
      projectId: workspace.project_id,
      runId: "run:g16-tool-performance",
      workspace,
      sandboxMode: "read-only",
    });
    samples.push(performance.now() - start);
    if (result.status !== "success") throw new Error(`read_file performance fixture failed: ${result.code}`);
  }
  return rounded(percentile(samples, 0.95));
}

async function measureSseFirstByte(
  runtime: AgentRuntime,
  workspace: Awaited<ReturnType<typeof createReadonlyWorkspaceHandle>>,
  runId: string,
): Promise<number> {
  const host = await createTraceGraphHost({
    runtime,
    projects: [{ label: "G16 offline performance", workspace }],
    capabilityToken: "g16-loopback-capability",
    allowedOrigins: [ORIGIN],
    logger: false,
  });
  const address = await host.listen({ port: 0, host: "127.0.0.1" });
  const controller = new AbortController();
  try {
    const start = performance.now();
    const response = await fetch(`${address}/api/runs/${encodeURIComponent(runId)}/events/stream?after_sequence=0`, {
      headers: {
        authorization: `Bearer ${host.token}`,
        origin: ORIGIN,
      },
      signal: controller.signal,
    });
    if (!response.ok || response.body === null) throw new Error(`SSE fixture returned HTTP ${response.status}`);
    const first = await response.body.getReader().read();
    if (first.done || first.value.byteLength === 0) throw new Error("SSE fixture returned no first byte");
    return rounded(performance.now() - start);
  } finally {
    controller.abort();
    await host.close();
  }
}

async function waitForTerminal(runtime: AgentRuntime, runId: string) {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    const projection = await runtime.getProjection(runId);
    if (["completed", "failed", "cancelled"].includes(projection.status)) return projection;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for the G16 performance Run");
}

function sequentialIds(): (prefix: string) => string {
  let sequence = 0;
  return (prefix) => `${prefix}:g16-${++sequence}`;
}

function metric(
  name: PerformanceMetricName,
  value: number,
  unit: EvalMetricObservation["unit"],
  scenario: string,
): EvalMetricObservation {
  return { name, value, unit, scenario };
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}
