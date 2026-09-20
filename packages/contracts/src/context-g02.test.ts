import { describe, expect, it } from "vitest";
import {
  ArtifactKindSchema,
  CompactionStepSchema,
  ContextManifestSchema,
  ContextNodeSchema,
  ContextPolicySchema,
  ContextSummarySchema,
  EventTypeSchema,
  ModelUsageReportSchema,
  SpillRefSchema,
  TokenUsageObservationSchema,
  ToolNameSchema,
} from "./index.js";

const legacyPolicy = {
  window_tokens: 258_000,
  reserved_output_tokens: 32_000,
  warning_ratio: 0.7,
  compression_ratio: 0.8,
  recent_history_messages: 16,
  history_checkpoint_tokens: 4_096,
  tool_budget_ratio: 0.1,
  token_estimator: "heuristic_v2",
} as const;

const archiveRef = {
  artifact_id: "artifact:source-1",
  kind: "spilled_tool_output",
  content_hash: `sha256:${"a".repeat(64)}`,
  mime_type: "text/plain",
  byte_length: 1_024,
  project_id: "project:g02",
  run_id: "run:g02",
  created_at: "2026-09-18T00:00:00.000Z",
} as const;

const compactionManifest = {
  manifest_id: "manifest:g02",
  project_id: "project:g02",
  run_id: "run:g02",
  turn_id: "turn:g02",
  model_call_id: "model-call:decision",
  token_limit: 120,
  reserved_output_tokens: 20,
  input_tokens: 40,
  compression: {
    strategy: "none",
    applied_strategy: "strategy_chain",
    trigger: "hard_budget",
    before_tokens: 100,
    after_tokens: 40,
    original_history_tokens: 80,
    checkpoint_tokens: 0,
    preserved_recent_message_count: 2,
    compacted_history_message_count: 8,
  },
  items: [{
    item_id: "item:g02",
    section: "history",
    label: "Compacted history",
    source: { source_id: "source:g02", source_type: "user", trust: "trusted" },
    original_tokens: 100,
    included_tokens: 40,
    action: "externalized",
    reason: "strategy_chain",
  }],
  compaction_steps: [{
    strategy_id: "tool_output_pruner",
    section: "tool",
    tokens_before: 100,
    tokens_after: 80,
  }, {
    strategy_id: "spill",
    section: "tool",
    tokens_before: 80,
    tokens_after: 60,
    archived_artifact_refs: [archiveRef],
  }, {
    strategy_id: "model_summary",
    section: "history",
    tokens_before: 60,
    tokens_after: 50,
    model_call_id: "model-call:summary",
    prompt_version: "context-summary.v1",
  }, {
    strategy_id: "tiered_checkpoint",
    section: "history",
    tokens_before: 50,
    tokens_after: 40,
  }],
  nodes: [{
    node_id: "node:raw",
    section: "history",
    kind: "raw",
    content_hash: `sha256:${"b".repeat(64)}`,
    tokens: 100,
    volatile: false,
    superseded_by: "node:summary",
  }, {
    node_id: "node:summary",
    parent_node_id: "node:raw",
    section: "history",
    kind: "summary",
    content_hash: `sha256:${"c".repeat(64)}`,
    tokens: 40,
    volatile: false,
  }],
  fixed_constraints_preserved: true,
  created_at: "2026-09-18T00:00:01.000Z",
} as const;

describe("G-02 Context compaction contracts", () => {
  it("keeps legacy Context policies valid and accepts independent strategy configuration", () => {
    expect(ContextPolicySchema.parse(legacyPolicy).compaction).toBeUndefined();

    const parsed = ContextPolicySchema.parse({
      ...legacyPolicy,
      compaction: {
        tool_output_pruner: { enabled: true, threshold_tokens: 8_192, target_tokens: 2_048 },
        spill: { enabled: true, threshold_tokens: 16_384, preview_tokens: 1_024 },
        model_summary: {
          enabled: true,
          threshold_tokens: 32_000,
          target_tokens: 4_096,
          timeout_ms: 15_000,
          prompt_version: "context-summary.v1",
        },
        tiered_checkpoint: { enabled: true, threshold_tokens: 24_000, target_tokens: 4_096 },
      },
    });

    expect(parsed.compaction?.model_summary).toMatchObject({
      enabled: true,
      timeout_ms: 15_000,
      prompt_version: "context-summary.v1",
      target_tokens: 4_096,
    });
    expect(() => ContextPolicySchema.parse({
      ...legacyPolicy,
      compaction: {
        model_summary: {
          enabled: true,
          threshold_tokens: 1_000,
          target_tokens: 2_000,
          timeout_ms: 15_000,
          prompt_version: "context-summary.v1",
        },
      },
    })).toThrow("model summary target must not exceed its threshold");
  });

  it("validates structured summary references, spill locators, and Context nodes", () => {
    expect(ContextSummarySchema.parse({
      facts: ["The runtime persists an event before exposing the result."],
      open_questions: ["Should archived evidence be encrypted at rest?"],
      refs: [{ path: "packages/core/src/context.ts", lines: { start: 10, end: 25 } }],
    }).refs[0]?.lines).toEqual({ start: 10, end: 25 });
    expect(() => ContextSummarySchema.parse({
      facts: ["invalid range"],
      open_questions: [],
      refs: [{ path: "packages/core/src/context.ts", lines: { start: 25, end: 10 } }],
    })).toThrow("summary reference end line must not precede its start line");

    expect(SpillRefSchema.parse({
      artifact_id: "artifact:spill",
      kind: "spilled_tool_output",
      locator: "artifact:artifact:spill",
      bytes: 65_536,
      preview_tokens: 512,
    }).bytes).toBe(65_536);
    expect(() => SpillRefSchema.parse({
      artifact_id: "artifact:spill",
      kind: "spilled_tool_output",
      locator: "artifact://artifact%3Aspill",
      bytes: 65_536,
      preview_tokens: 512,
    })).toThrow("spill locator must equal artifact:<artifact_id>");
    expect(() => SpillRefSchema.parse({
      artifact_id: "artifact:spill",
      kind: "spilled_tool_output",
      locator: "artifact:artifact:other",
      bytes: 65_536,
      preview_tokens: 512,
    })).toThrow("spill locator must equal artifact:<artifact_id>");
    expect(() => ContextNodeSchema.parse({
      node_id: "node:self",
      parent_node_id: "node:self",
      section: "history",
      kind: "raw",
      content_hash: `sha256:${"d".repeat(64)}`,
      tokens: 1,
      volatile: false,
    })).toThrow("a Context node cannot be its own parent");
  });

  it("requires auditable model-summary steps and monotonic token reduction", () => {
    expect(CompactionStepSchema.parse({
      strategy_id: "model_summary",
      section: "repo",
      tokens_before: 10_000,
      tokens_after: 2_000,
      model_call_id: "model-call:summary",
      prompt_version: "context-summary.v1",
    }).archived_artifact_refs).toEqual([]);
    expect(() => CompactionStepSchema.parse({
      strategy_id: "model_summary",
      section: "repo",
      tokens_before: 10,
      tokens_after: 11,
    })).toThrow(/compaction step must strictly reduce token usage|model summary steps require/u);
    expect(() => CompactionStepSchema.parse({
      strategy_id: "spill",
      section: "tool",
      tokens_before: 10,
      tokens_after: 10,
    })).toThrow("compaction step must strictly reduce token usage");
  });

  it("accepts a continuous strategy chain whose reductions explain the manifest", () => {
    const parsed = ContextManifestSchema.parse(compactionManifest);

    expect(parsed.compaction_steps?.map((step) => step.strategy_id)).toEqual([
      "tool_output_pruner",
      "spill",
      "model_summary",
      "tiered_checkpoint",
    ]);
    expect(parsed.compaction_steps?.[0]?.archived_artifact_refs).toEqual([]);
    expect(parsed.nodes).toHaveLength(2);
  });

  it("rejects discontinuous steps and archive references outside the manifest scope", () => {
    expect(() => ContextManifestSchema.parse({
      ...compactionManifest,
      compaction_steps: compactionManifest.compaction_steps.map((step, index) => (
        index === 1 ? { ...step, tokens_before: 79 } : step
      )),
    })).toThrow("compaction steps must form a continuous token-accounting chain");

    expect(() => ContextManifestSchema.parse({
      ...compactionManifest,
      compaction_steps: compactionManifest.compaction_steps.map((step, index) => (
        index === 1
          ? { ...step, archived_artifact_refs: [{ ...archiveRef, run_id: "run:other" }] }
          : step
      )),
    })).toThrow("compaction archive artifacts must belong to the manifest project and run");

    expect(() => ContextManifestSchema.parse({
      ...compactionManifest,
      compaction_steps: compactionManifest.compaction_steps.map((step, index) => (
        index === 1
          ? { ...step, archived_artifact_refs: [{ ...archiveRef, kind: "tool_output" }] }
          : step
      )),
    })).toThrow("compaction archive artifacts must use a Context archive kind");

    expect(() => ContextManifestSchema.parse({
      ...compactionManifest,
      compaction_steps: compactionManifest.compaction_steps.map((step, index) => (
        index === 0
          ? { ...step, strategy_id: "spill" as const }
          : index === 1
            ? { ...step, strategy_id: "tool_output_pruner" as const }
            : step
      )),
    })).toThrow("compaction strategies must follow pruner, spill, summary, checkpoint order");

    expect(() => ContextManifestSchema.parse({
      ...compactionManifest,
      compaction_steps: compactionManifest.compaction_steps.map((step, index) => (
        index === 2 ? { ...step, strategy_id: "spill" as const } : step
      )),
    })).toThrow("only tiered checkpoint may repeat across Context sections");
  });

  it("keeps new manifest arrays optional for older artifacts", () => {
    const { compaction_steps: _steps, nodes: _nodes, ...legacyManifest } = compactionManifest;
    const parsed = ContextManifestSchema.parse({
      ...legacyManifest,
      compression: { ...legacyManifest.compression, applied_strategy: "none", before_tokens: 40 },
    });

    expect(parsed.compaction_steps).toBeUndefined();
    expect(parsed.nodes).toBeUndefined();
  });

  it("exposes G-02 event, artifact, tool, and summary-usage vocabulary", () => {
    expect(EventTypeSchema.options).toEqual(expect.arrayContaining([
      "context.tool_output_spilled",
      "context.summary_created",
      "context.summary_failed",
      "context.spill_refetched",
    ]));
    expect(ArtifactKindSchema.options).toEqual(expect.arrayContaining([
      "spilled_tool_output",
      "context_source_archive",
    ]));
    expect(ToolNameSchema.parse("read_artifact")).toBe("read_artifact");

    const usage = ModelUsageReportSchema.parse({
      provider: "openai",
      model: "gpt-5.6-sol",
      input_tokens: 1_000,
      output_tokens: 100,
      total_tokens: 1_100,
      request_kind: "summary",
      request_sequence: 1,
    });
    expect(usage.request_kind).toBe("summary");
    expect(TokenUsageObservationSchema.parse({
      model_call_id: "model-call:summary",
      provider: usage.provider,
      model: usage.model,
      estimator_id: "heuristic_v2",
      confidence: "provider_reported",
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      total_tokens: usage.total_tokens,
      estimated_input_tokens: 900,
      delta_ratio: 1 / 9,
      anomaly: false,
      calibration_applied: false,
      calibration_revision: 0,
      request_kind: "summary",
      request_sequence: 1,
    }).request_kind).toBe("summary");
    expect(() => ModelUsageReportSchema.parse({ ...usage, request_sequence: 2 })).toThrow(
      "summary model usage must use request_sequence 1",
    );
  });
});
