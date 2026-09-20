import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObservationSchema, type ContextPolicy } from "@tracegraph/contracts";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "./artifact-store.js";
import {
  DeterministicContextBuilder,
  estimateTokens,
  readContextArtifact,
} from "./context.js";
import { sha256 } from "./crypto.js";
import type { TokenMeter } from "./token-meter.js";

const BASE_POLICY: ContextPolicy = {
  window_tokens: 32_000,
  reserved_output_tokens: 2_000,
  warning_ratio: 0.7,
  compression_ratio: 0.8,
  recent_history_messages: 2,
  history_checkpoint_tokens: 1_024,
  tool_budget_ratio: 0.2,
  token_estimator: "heuristic_v2",
};

describe("G-02 Context compaction strategy chain", () => {
  it("runs successful strategies in strict pruner -> spill -> model summary order", async () => {
    const { builder, artifactStore } = await fixture("ordered-chain");
    const facts = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [
      `field_${index}`,
      `tool evidence ${index} ${"x".repeat(180)}`,
    ]));
    const built = await builder.buildWithStrategies(input({
      observations: [observation("ordered", facts)],
      history: history(8, 5_000),
      policy: {
        ...BASE_POLICY,
        window_tokens: 64_000,
        reserved_output_tokens: 4_000,
        compaction: {
          tool_output_pruner: { enabled: true, threshold_tokens: 1_000, target_tokens: 800 },
          spill: { enabled: true, threshold_tokens: 1_100, preview_tokens: 32 },
          model_summary: {
            enabled: true,
            threshold_tokens: 2_000,
            target_tokens: 400,
            timeout_ms: 1_000,
            prompt_version: "summary.v1",
          },
          tiered_checkpoint: { enabled: true, threshold_tokens: 20_000, target_tokens: 1_000 },
        },
      },
    }), {
      artifactStore,
      summarize: async () => ({
        facts: ["Earlier turns established the compaction invariant."],
        open_questions: ["Confirm the final budget."],
        refs: [{ path: "src/context.ts", lines: { start: 1, end: 4 } }],
      }),
    });

    expect(built.manifest.compaction_steps?.map((step) => step.strategy_id)).toEqual([
      "tool_output_pruner",
      "spill",
      "model_summary",
    ]);
    expect(built.manifest.compression?.applied_strategy).toBe("strategy_chain");
    expect(built.manifest.input_tokens).toBeLessThanOrEqual(60_000);
    expect(built.manifest.compaction_steps?.[2]).toMatchObject({
      model_call_id: expect.any(String),
      prompt_version: "summary.v1",
    });
    expect(built.notices.map((notice) => notice.type)).toEqual([
      "context.tool_output_spilled",
      "context.summary_created",
    ]);
    const visibleItems = built.manifest.items.filter((item) => item.included_tokens > 0 && item.content !== undefined);
    expect(built.modelContext).toBe(visibleItems.map((item) => `[${item.section}] ${item.content}`).join("\n\n"));
    expect(visibleItems.reduce((sum, item) => sum + estimateTokens(item.content!), 0))
      .toBe(built.manifest.input_tokens);
    expect(built.modelContext.indexOf("Earlier turns established"))
      .toBeLessThan(built.modelContext.indexOf("spill_ref"));
    expect(built.manifest.items.find((item) => item.reason === "structured_model_summary")?.content)
      .toContain('"archive_locator":"artifact:');
  });

  it("honors independent switches and can spill without pruning or summarizing", async () => {
    const { builder, artifactStore } = await fixture("spill-only");
    const built = await builder.buildWithStrategies(input({
      observations: [observation("spill-only", { output: "large tool line\n".repeat(1_200) })],
      policy: {
        ...BASE_POLICY,
        compaction: {
          tool_output_pruner: { enabled: false, threshold_tokens: 500, target_tokens: 200 },
          spill: { enabled: true, threshold_tokens: 500, preview_tokens: 80 },
          model_summary: {
            enabled: false,
            threshold_tokens: 500,
            target_tokens: 200,
            timeout_ms: 1_000,
            prompt_version: "summary.v1",
          },
          tiered_checkpoint: { enabled: false, threshold_tokens: 500, target_tokens: 200 },
        },
      },
    }), { artifactStore });

    expect(built.manifest.compaction_steps?.map((step) => step.strategy_id)).toEqual(["spill"]);
    expect(built.manifest.items.find((item) => item.section === "tool")).toMatchObject({
      action: "externalized",
      artifact_ref: { kind: "spilled_tool_output" },
    });
    expect(built.modelContext).toContain("read_artifact");
    expect(built.modelContext).toContain("artifact:artifact:");
  });

  it("records an invalid summary and deterministically falls back to a checkpoint", async () => {
    const { builder, artifactStore } = await fixture("invalid-summary");
    const built = await builder.buildWithStrategies(input({
      history: history(6, 2_000),
      policy: summaryFallbackPolicy(10_000),
    }), {
      artifactStore,
      summarize: async () => "this is not JSON",
    });

    expect(built.notices).toContainEqual(expect.objectContaining({
      type: "context.summary_failed",
      data: expect.objectContaining({ reason: "invalid_summary", fallback: "tiered_checkpoint" }),
    }));
    expect(built.manifest.compaction_steps?.map((step) => step.strategy_id)).toEqual(["tiered_checkpoint"]);
    const checkpoint = built.manifest.items.find((item) => item.reason.includes("checkpoint_fallback"));
    expect(checkpoint?.artifact_ref?.kind).toBe("context_source_archive");
    expect(checkpoint?.content).toContain("Exact source: artifact:");
    expect(built.manifest.nodes?.some((node) => node.kind === "raw" && node.superseded_by !== undefined)).toBe(true);
  });

  it("awaits compaction_started exactly once before the first archive side effect", async () => {
    const { builder, artifactStore } = await fixture("started-before-put");
    const order: string[] = [];
    const trackedStore = {
      getInternal: artifactStore.getInternal.bind(artifactStore),
      put: async (value: Parameters<ArtifactStore["put"]>[0]) => {
        order.push("put");
        return artifactStore.put(value);
      },
    };
    await builder.buildWithStrategies(input({
      observations: [observation("started-before-put", { output: "large\n".repeat(2_000) })],
      policy: spillOnlyPolicy(),
    }), {
      artifactStore: trackedStore,
      onCompactionStarted: async () => { order.push("started"); },
    });

    expect(order[0]).toBe("started");
    expect(order.filter((item) => item === "started")).toHaveLength(1);
    expect(order).toContain("put");
  });

  it("starts before an unavailable summary but leaves short history raw without an orphan archive", async () => {
    const { builder, artifactStore } = await fixture("short-history-no-orphan");
    let puts = 0;
    const trackedStore = {
      getInternal: artifactStore.getInternal.bind(artifactStore),
      put: async (value: Parameters<ArtifactStore["put"]>[0]) => {
        puts += 1;
        return artifactStore.put(value);
      },
    };
    const lifecycle: string[] = [];
    const built = await builder.buildWithStrategies(input({
      history: [
        { role: "user", content: "old" },
        { role: "assistant", content: "recent" },
      ],
      observations: [observation("compression-pressure", { output: "工具".repeat(2_200) })],
      policy: {
        ...BASE_POLICY,
        window_tokens: 8_192,
        reserved_output_tokens: 1_024,
        warning_ratio: 0.5,
        compression_ratio: 0.55,
        recent_history_messages: 1,
        compaction: {
          tool_output_pruner: { enabled: false, threshold_tokens: 1_000, target_tokens: 500 },
          spill: { enabled: false, threshold_tokens: 1_000, preview_tokens: 100 },
          model_summary: {
            enabled: true,
            threshold_tokens: 1_000,
            target_tokens: 500,
            timeout_ms: 1_000,
            prompt_version: "summary.v1",
          },
          tiered_checkpoint: { enabled: true, threshold_tokens: 1_000, target_tokens: 500 },
        },
      },
    }), {
      artifactStore: trackedStore,
      onCompactionStarted: async () => { lifecycle.push("started"); },
    });

    expect(lifecycle).toEqual(["started"]);
    expect(puts).toBe(0);
    expect(built.manifest.compaction_steps).toEqual([]);
    expect(built.manifest.compression?.applied_strategy).toBe("none");
    expect(built.notices).toContainEqual(expect.objectContaining({
      type: "context.summary_failed",
      data: expect.objectContaining({ reason: "model_unavailable" }),
    }));
    expect(built.manifest.nodes?.filter((node) => node.section === "history").every(
      (node) => node.superseded_by === undefined,
    )).toBe(true);
  });

  it("does not write a spill artifact when its locator envelope would not reduce the item", async () => {
    const { builder, artifactStore } = await fixture("spill-preflight-no-orphan");
    let puts = 0;
    const built = await builder.buildWithStrategies(input({
      observations: [observation("tiny-spill", { output: "tiny" })],
      policy: {
        ...BASE_POLICY,
        compaction: {
          tool_output_pruner: { enabled: false, threshold_tokens: 1, target_tokens: 1 },
          spill: { enabled: true, threshold_tokens: 1, preview_tokens: 1 },
          model_summary: {
            enabled: false,
            threshold_tokens: 1_000,
            target_tokens: 500,
            timeout_ms: 1_000,
            prompt_version: "summary.v1",
          },
          tiered_checkpoint: { enabled: false, threshold_tokens: 1_000, target_tokens: 500 },
        },
      },
    }), {
      artifactStore: {
        getInternal: artifactStore.getInternal.bind(artifactStore),
        put: async (value) => {
          puts += 1;
          return artifactStore.put(value);
        },
      },
    });

    expect(puts).toBe(0);
    expect(built.notices).toEqual([]);
    expect(built.manifest.compaction_steps).toEqual([]);
  });

  it("turns a summary timeout into the same visible checkpoint fallback", async () => {
    const { builder, artifactStore } = await fixture("summary-timeout");
    const built = await builder.buildWithStrategies(input({
      history: history(6, 2_000),
      policy: summaryFallbackPolicy(100),
    }), {
      artifactStore,
      summarize: async () => new Promise<never>(() => undefined),
    });

    expect(built.notices).toContainEqual(expect.objectContaining({
      type: "context.summary_failed",
      data: expect.objectContaining({ reason: "timeout" }),
    }));
    expect(built.manifest.compaction_steps?.at(-1)?.strategy_id).toBe("tiered_checkpoint");
  });

  it("round-trips a spill locator with the exact verified content hash", async () => {
    const { builder, artifactStore } = await fixture("spill-refetch");
    const sourceObservation = observation("refetch", { output: "evidence line\n".repeat(1_000) });
    const built = await builder.buildWithStrategies(input({
      observations: [sourceObservation],
      policy: spillOnlyPolicy(),
    }), { artifactStore });
    const notice = built.notices.find((item) => item.type === "context.tool_output_spilled");
    if (notice?.type !== "context.tool_output_spilled") throw new Error("spill notice missing");

    const fetched = await readContextArtifact({
      locator: notice.data.locator,
      projectId: "project:g02",
      runId: "run:g02",
      artifactStore,
    });
    const expected = JSON.stringify({
      status: sourceObservation.status,
      summary: sourceObservation.summary,
      facts: sourceObservation.facts,
    });
    expect(fetched.content).toBe(expected);
    expect(sha256(fetched.content)).toBe(fetched.artifact.content_hash);
    expect(fetched.notice.type).toBe("context.spill_refetched");
  });

  it("spills the complete verified tool_output Artifact instead of the bounded ledger excerpt", async () => {
    const { builder, artifactStore } = await fixture("canonical-tool-artifact");
    const fullOutput = "complete source line\n".repeat(1_200);
    const sourceArtifact = await artifactStore.put({
      projectId: "project:g02",
      runId: "run:g02",
      kind: "tool_output",
      mimeType: "text/plain",
      content: fullOutput,
    });
    const sourceObservation = ObservationSchema.parse({
      ...observation("canonical-tool-artifact", {
        tool_name: "read_file",
        content_excerpt: fullOutput.slice(0, 1_000),
      }),
      artifact_refs: [sourceArtifact],
    });
    const built = await builder.buildWithStrategies(input({
      observations: [sourceObservation],
      policy: spillOnlyPolicy(),
    }), { artifactStore });
    const notice = built.notices.find((item) => item.type === "context.tool_output_spilled");
    if (notice?.type !== "context.tool_output_spilled") throw new Error("spill notice missing");
    const fetched = await readContextArtifact({
      locator: notice.data.locator,
      projectId: "project:g02",
      runId: "run:g02",
      artifactStore,
    });

    expect(fetched.content).toBe(fullOutput);
    expect(fetched.artifact.content_hash).toBe(sourceArtifact.content_hash);
    expect(built.modelContext).not.toContain(fullOutput);
    expect(JSON.stringify(built.notices)).not.toContain(fullOutput);
  });

  it("keeps a small artifact-backed tool result as a structured ModelObservation", async () => {
    const { builder, artifactStore } = await fixture("small-tool-artifact");
    const sourceArtifact = await artifactStore.put({
      projectId: "project:g02",
      runId: "run:g02",
      kind: "tool_output",
      mimeType: "text/plain",
      content: "small verified source",
    });
    const sourceObservation = ObservationSchema.parse({
      ...observation("small-tool-artifact", {
        tool_name: "read_file",
        path: "src/small.ts",
        content_excerpt: "small verified source",
      }),
      artifact_refs: [sourceArtifact],
    });
    const built = await builder.buildWithStrategies(input({
      observations: [sourceObservation],
      policy: spillOnlyPolicy(),
    }), { artifactStore });

    expect(built.notices).toHaveLength(0);
    expect(built.modelObservations).toEqual([{
      status: "success",
      summary: "Observation small-tool-artifact",
      facts: expect.objectContaining({ tool_name: "read_file", path: "src/small.ts" }),
    }]);
    expect(() => JSON.parse(built.manifest.items.find((item) => item.section === "tool")?.content ?? ""))
      .not.toThrow();
  });

  it("keeps a refetch locator even in a compacted artifact-backed observation", async () => {
    const { builder, artifactStore } = await fixture("compacted-refetch-locator");
    const sourceArtifact = await artifactStore.put({
      projectId: "project:g02",
      runId: "run:g02",
      kind: "spilled_tool_output",
      mimeType: "application/json",
      content: JSON.stringify({ items: ["exact archived Team page"] }),
    });
    const sourceObservation = ObservationSchema.parse({
      ...observation("compacted-refetch-locator", Object.fromEntries(
        Array.from({ length: 80 }, (_, index) => [`field_${index}`, `value ${index} ${"x".repeat(180)}`]),
      )),
      artifact_refs: [sourceArtifact],
    });
    const built = builder.build(input({
      observations: [sourceObservation],
      policy: {
        ...BASE_POLICY,
        window_tokens: 8_192,
        reserved_output_tokens: 1_024,
        tool_budget_ratio: 0.1,
        compaction: {
          tool_output_pruner: { enabled: false, threshold_tokens: 100, target_tokens: 64 },
          spill: { enabled: false, threshold_tokens: 100, preview_tokens: 64 },
          model_summary: {
            enabled: false,
            threshold_tokens: 100,
            target_tokens: 64,
            timeout_ms: 1_000,
            prompt_version: "summary.v1",
          },
          tiered_checkpoint: { enabled: true, threshold_tokens: 100, target_tokens: 64 },
        },
      },
    }));

    expect(built.modelObservations).toEqual([
      expect.objectContaining({
        facts: expect.objectContaining({
          context_compacted: true,
          locator: `artifact:${sourceArtifact.artifact_id}`,
        }),
      }),
    ]);
  });

  it("does not recursively re-spill a bounded read_artifact observation", async () => {
    const { builder, artifactStore } = await fixture("no-refetch-loop");
    const refetchOutput = "already refetched source\n".repeat(1_000);
    const runtimeToolArtifact = await artifactStore.put({
      projectId: "project:g02",
      runId: "run:g02",
      kind: "tool_output",
      mimeType: "text/plain",
      content: refetchOutput,
    });
    const readObservation = ObservationSchema.parse({
      ...observation("no-refetch-loop", {
        tool_name: "read_artifact",
        content_hash: sha256(refetchOutput),
        content_excerpt: refetchOutput.slice(0, 4_000),
      }),
      artifact_refs: [runtimeToolArtifact],
    });
    const built = await builder.buildWithStrategies(input({
      observations: [readObservation],
      policy: spillOnlyPolicy(),
    }), { artifactStore });

    expect(built.notices.some((notice) => notice.type === "context.tool_output_spilled")).toBe(false);
    expect(built.modelContext).toContain(sha256(refetchOutput));
    expect(built.modelContext).toContain("already refetched source");
  });

  it("labels a hard-budget tool reduction as tool instead of history", async () => {
    const { builder, artifactStore } = await fixture("tool-force-fit");
    const policy: ContextPolicy = {
      ...BASE_POLICY,
      window_tokens: 8_192,
      reserved_output_tokens: 1_024,
      compaction: {
        tool_output_pruner: { enabled: false, threshold_tokens: 1_000, target_tokens: 500 },
        spill: { enabled: false, threshold_tokens: 1_000, preview_tokens: 100 },
        model_summary: {
          enabled: false,
          threshold_tokens: 1_000,
          target_tokens: 500,
          timeout_ms: 1_000,
          prompt_version: "summary.v1",
        },
        tiered_checkpoint: { enabled: true, threshold_tokens: 1_000, target_tokens: 500 },
      },
    };
    const built = await builder.buildWithStrategies(input({
      observations: [observation("tool-force-fit", { output: "工具输出".repeat(3_000) })],
      policy,
    }), { artifactStore });

    expect(built.manifest.compaction_steps?.at(-1)).toMatchObject({
      strategy_id: "tiered_checkpoint",
      section: "tool",
    });
    expect(built.manifest.input_tokens).toBeLessThanOrEqual(7_168);
  });

  it("fits a greater-than-258K source and accounts for the entire reduction", async () => {
    const { builder, artifactStore } = await fixture("stress-300k");
    const built = await builder.buildWithStrategies(input({
      history: history(30, 10_000),
      policy: {
        ...BASE_POLICY,
        window_tokens: 258_000,
        reserved_output_tokens: 32_000,
        recent_history_messages: 16,
        history_checkpoint_tokens: 4_096,
        compaction: {
          tool_output_pruner: { enabled: false, threshold_tokens: 8_000, target_tokens: 2_000 },
          spill: { enabled: false, threshold_tokens: 12_000, preview_tokens: 800 },
          model_summary: {
            enabled: false,
            threshold_tokens: 24_000,
            target_tokens: 4_096,
            timeout_ms: 1_000,
            prompt_version: "summary.v1",
          },
          tiered_checkpoint: { enabled: true, threshold_tokens: 24_000, target_tokens: 4_096 },
        },
      },
    }), { artifactStore });
    const steps = built.manifest.compaction_steps ?? [];
    const totalReduction = steps.reduce(
      (sum, step) => sum + step.tokens_before - step.tokens_after,
      0,
    );

    expect(built.manifest.compression?.before_tokens).toBeGreaterThan(258_000);
    expect(built.manifest.input_tokens).toBeLessThanOrEqual(226_000);
    expect(totalReduction).toBe(
      (built.manifest.compression?.before_tokens ?? 0) - built.manifest.input_tokens,
    );
    expect(steps.every((step, index) => index === 0 || steps[index - 1]?.tokens_after === step.tokens_before)).toBe(true);
  });

  it("reconciles active node and checkpoint tokens to an authoritative final counter", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracegraph-g02-node-meter-"));
    let id = 0;
    const idFactory = (prefix: string) => `${prefix}:node-meter:${++id}`;
    const artifactStore = new ArtifactStore(join(root, "artifacts"), { idFactory });
    await artifactStore.initialize();
    const meter: TokenMeter = {
      initialize: async () => undefined,
      revision: () => 0,
      estimate(value) {
        const perSection = { system: 0, goal: 0, history: 0, tool: 0, repo: 0, memory: 0 };
        for (const section of value.sections) {
          perSection[section.section] += estimateTokens(section.content) * 2;
        }
        return {
          estimator_id: "test:double-counter",
          confidence: "exact",
          input_tokens: Object.values(perSection).reduce((sum, count) => sum + count, 0),
          output_tokens: 0,
          per_section: perSection,
        };
      },
      observeUsage: async () => { throw new Error("not used"); },
    };
    const builder = new DeterministicContextBuilder({ idFactory, tokenMeter: meter });
    const built = await builder.buildWithStrategies(input({
      history: history(6, 2_000),
      policy: {
        ...summaryFallbackPolicy(1_000),
        compaction: {
          ...summaryFallbackPolicy(1_000).compaction,
          model_summary: {
            enabled: false,
            threshold_tokens: 1_000,
            target_tokens: 500,
            timeout_ms: 1_000,
            prompt_version: "summary.v1",
          },
        },
      },
    }), { artifactStore });
    const activeNodes = (built.manifest.nodes ?? []).filter((node) => node.superseded_by === undefined);
    const nodeTotal = activeNodes.reduce((sum, node) => sum + node.tokens, 0);
    const nodeSections = { system: 0, goal: 0, history: 0, tool: 0, repo: 0, memory: 0 };
    for (const node of activeNodes) nodeSections[node.section] += node.tokens;
    const checkpointTokens = activeNodes.reduce(
      (sum, node) => node.kind === "checkpoint" ? sum + node.tokens : sum,
      0,
    );

    expect(nodeTotal).toBe(built.manifest.input_tokens);
    expect(nodeSections).toEqual(built.manifest.token_estimate?.per_section);
    expect(checkpointTokens).toBe(built.manifest.compression?.checkpoint_tokens);
  });
});

async function fixture(name: string): Promise<{
  builder: DeterministicContextBuilder;
  artifactStore: ArtifactStore;
}> {
  const root = await mkdtemp(join(tmpdir(), `tracegraph-g02-${name}-`));
  let id = 0;
  const idFactory = (prefix: string) => `${prefix}:${name}:${++id}`;
  const artifactStore = new ArtifactStore(join(root, "artifacts"), { idFactory });
  await artifactStore.initialize();
  return {
    artifactStore,
    builder: new DeterministicContextBuilder({
      idFactory,
      now: () => new Date("2026-09-18T00:00:00.000Z"),
    }),
  };
}

function input(options: {
  observations?: ReturnType<typeof observation>[];
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  policy?: ContextPolicy;
}) {
  return {
    projectId: "project:g02",
    runId: "run:g02",
    turnId: "turn:g02",
    modelCallId: "model-call:g02",
    task: "Build a bounded and auditable Context",
    workspaceKind: "managed_local" as const,
    observations: options.observations ?? [],
    conversationHistory: options.history ?? [],
    contextPolicy: options.policy ?? BASE_POLICY,
  };
}

function observation(id: string, facts: Record<string, unknown>) {
  return ObservationSchema.parse({
    observation_id: `observation:${id}`,
    action_id: `action:${id}`,
    receipt_id: `receipt:${id}`,
    status: "success",
    summary: `Observation ${id}`,
    facts,
    artifact_refs: [],
    created_at: "2026-09-18T00:00:00.000Z",
  });
}

function history(count: number, characters: number) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: `第${index + 1}轮：${"上下文".repeat(Math.ceil(characters / 3)).slice(0, characters)}`,
  }));
}

function summaryFallbackPolicy(timeoutMs: number): ContextPolicy {
  return {
    ...BASE_POLICY,
    compaction: {
      tool_output_pruner: { enabled: false, threshold_tokens: 1_000, target_tokens: 500 },
      spill: { enabled: false, threshold_tokens: 1_000, preview_tokens: 100 },
      model_summary: {
        enabled: true,
        threshold_tokens: 1_000,
        target_tokens: 500,
        timeout_ms: timeoutMs,
        prompt_version: "summary.v1",
      },
      tiered_checkpoint: { enabled: true, threshold_tokens: 1_000, target_tokens: 500 },
    },
  };
}

function spillOnlyPolicy(): ContextPolicy {
  return {
    ...BASE_POLICY,
    compaction: {
      tool_output_pruner: { enabled: false, threshold_tokens: 500, target_tokens: 200 },
      spill: { enabled: true, threshold_tokens: 500, preview_tokens: 80 },
      model_summary: {
        enabled: false,
        threshold_tokens: 500,
        target_tokens: 200,
        timeout_ms: 1_000,
        prompt_version: "summary.v1",
      },
      tiered_checkpoint: { enabled: false, threshold_tokens: 500, target_tokens: 200 },
    },
  };
}
