import { ObservationSchema } from "@tracegraph/contracts";
import { describe, expect, it } from "vitest";
import { DeterministicContextBuilder, estimateTokens } from "./context.js";
import type { TokenMeter } from "./token-meter.js";

describe("deterministic context assembly", () => {
  it("records the default 258K policy, reserve, and budget thresholds in every manifest", () => {
    const builder = new DeterministicContextBuilder({ idFactory: (prefix) => `${prefix}:default-policy` });
    const built = builder.build({
      projectId: "project:policy",
      runId: "run:policy",
      turnId: "turn:policy",
      modelCallId: "model-call:policy",
      task: "Explain the context budget",
      workspaceKind: "managed_local",
      observations: [],
    });

    expect(built.manifest).toMatchObject({
      token_limit: 258_000,
      reserved_output_tokens: 32_000,
      budget: {
        input_budget_tokens: 226_000,
        warning_threshold_tokens: 158_200,
        compression_threshold_tokens: 180_800,
        token_estimator: "heuristic_v2",
        status: "healthy",
      },
      compression: {
        strategy: "none",
        applied_strategy: "none",
        trigger: "within_budget",
      },
    });
  });

  it("uses a calibrated meter for every section without presenting calibration as exact tokenization", () => {
    const identities: Array<{ provider: string; model: string }> = [];
    const meter: TokenMeter = {
      initialize: async () => undefined,
      revision: () => 7,
      estimate(input) {
        identities.push({ provider: input.provider, model: input.model });
        const perSection = { system: 0, goal: 0, history: 0, tool: 0, repo: 0, memory: 0 };
        for (const item of input.sections) perSection[item.section] += estimateTokens(item.content) * 2;
        return {
          estimator_id: "heuristic_v2:calibrated",
          confidence: "calibrated",
          input_tokens: Object.values(perSection).reduce((total, count) => total + count, 0),
          output_tokens: 0,
          per_section: perSection,
        };
      },
      observeUsage: async () => { throw new Error("not used in Context construction"); },
    };
    const builder = new DeterministicContextBuilder({
      tokenMeter: meter,
      idFactory: (prefix) => `${prefix}:calibrated`,
    });
    const built = builder.build({
      projectId: "project:calibrated",
      runId: "run:calibrated",
      turnId: "turn:calibrated",
      modelCallId: "model-call:calibrated",
      task: "Explain calibrated accounting",
      workspaceKind: "managed_local",
      conversationHistory: [{ role: "user", content: "Earlier context" }],
      observations: [],
      tokenMeterIdentity: { provider: "openai", model: "gpt-test" },
      contextPolicy: {
        window_tokens: 8_192,
        reserved_output_tokens: 1_024,
        warning_ratio: 0.7,
        compression_ratio: 0.8,
        recent_history_messages: 16,
        history_checkpoint_tokens: 256,
        tool_budget_ratio: 0.1,
        // A requested policy value cannot turn a calibrated estimate into an
        // exact provider-tokenizer claim.
        token_estimator: "provider_tokenizer",
      },
    });

    expect(identities).toEqual([
      { provider: "openai", model: "gpt-test" },
      { provider: "openai", model: "gpt-test" },
    ]);
    expect(built.manifest.token_estimate).toMatchObject({
      estimator_id: "heuristic_v2:calibrated",
      confidence: "calibrated",
      input_tokens: built.manifest.input_tokens,
    });
    expect(built.manifest.budget?.token_estimator).toBe("heuristic_v2");
    expect(Object.values(built.manifest.token_estimate!.per_section).reduce((sum, count) => sum + count, 0))
      .toBe(built.manifest.input_tokens);
    expect(built.manifest.items.reduce((sum, item) => sum + item.included_tokens, 0))
      .toBe(built.manifest.input_tokens);
  });

  it("falls back when an injected meter cannot describe the final visible Context", () => {
    let calls = 0;
    const meter: TokenMeter = {
      initialize: async () => undefined,
      revision: () => 0,
      estimate(input) {
        calls += 1;
        if (calls === 1) {
          const perSection = { system: 0, goal: 0, history: 0, tool: 0, repo: 0, memory: 0 };
          for (const item of input.sections) perSection[item.section] += estimateTokens(item.content);
          return {
            estimator_id: "custom:non-additive",
            confidence: "estimated",
            input_tokens: Object.values(perSection).reduce((total, count) => total + count, 0),
            output_tokens: 0,
            per_section: perSection,
          };
        }
        // Structurally valid, but it assigns tokens to absent repo content and
        // exceeds the available budget. Neither defect may fail the Run.
        return {
          estimator_id: "custom:non-additive",
          confidence: "exact",
          input_tokens: 9_000,
          output_tokens: 0,
          per_section: { system: 0, goal: 0, history: 0, tool: 0, repo: 9_000, memory: 0 },
        };
      },
      observeUsage: async () => { throw new Error("not used in Context construction"); },
    };
    const builder = new DeterministicContextBuilder({
      tokenMeter: meter,
      idFactory: (prefix) => `${prefix}:meter-fallback`,
    });

    const built = builder.build({
      projectId: "project:meter-fallback",
      runId: "run:meter-fallback",
      turnId: "turn:meter-fallback",
      modelCallId: "model-call:meter-fallback",
      task: "Keep optional accounting non-fatal",
      workspaceKind: "readonly_local",
      observations: [],
      tokenMeterIdentity: { provider: "custom", model: "non-additive" },
      contextPolicy: {
        window_tokens: 8_192,
        reserved_output_tokens: 1_024,
        warning_ratio: 0.7,
        compression_ratio: 0.8,
        recent_history_messages: 16,
        history_checkpoint_tokens: 256,
        tool_budget_ratio: 0.1,
        token_estimator: "provider_tokenizer",
      },
    });

    expect(calls).toBe(2);
    expect(built.manifest.token_estimate).toMatchObject({
      estimator_id: "heuristic_v2",
      confidence: "estimated",
    });
    expect(built.manifest.input_tokens).toBeLessThanOrEqual(7_168);
  });

  it("creates a tiered checkpoint above the compression threshold while retaining the latest 16 turns", () => {
    const builder = new DeterministicContextBuilder({ idFactory: (prefix) => `${prefix}:checkpoint` });
    const massiveHistory = Array.from({ length: 18 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      // CJK is intentionally used here: each character needs a conservative
      // accounting path instead of the previous length / 4 approximation.
      content: `第${index + 1}轮历史：${"上下文压缩验证".repeat(1_700)}`,
    }));

    const built = builder.build({
      projectId: "project:checkpoint",
      runId: "run:checkpoint",
      turnId: "turn:checkpoint",
      modelCallId: "model-call:checkpoint",
      task: "Continue the discussion without losing the most recent turns",
      workspaceKind: "managed_local",
      conversationHistory: massiveHistory,
      observations: [],
    });

    const historyItems = built.manifest.items.filter((item) => item.section === "history");
    const checkpoint = historyItems.find((item) => item.reason.includes("tiered_history_checkpoint"));
    const recentItems = historyItems.filter((item) => item.reason !== checkpoint?.reason);

    expect(built.manifest.compression).toMatchObject({
      strategy: "tiered_history_checkpoint",
      applied_strategy: "tiered_history_checkpoint",
      trigger: "compression_threshold",
      preserved_recent_message_count: 16,
      compacted_history_message_count: 2,
    });
    expect(built.manifest.budget?.status).toBe("compressed");
    expect(checkpoint).toMatchObject({
      action: "truncated",
      original_tokens: expect.any(Number),
      included_tokens: expect.any(Number),
    });
    expect(recentItems).toHaveLength(16);
    expect(recentItems.map((item) => item.label)).toEqual([
      "Earlier user message",
      "Earlier assistant answer",
      "Earlier user message",
      "Earlier assistant answer",
      "Earlier user message",
      "Earlier assistant answer",
      "Earlier user message",
      "Earlier assistant answer",
      "Earlier user message",
      "Earlier assistant answer",
      "Earlier user message",
      "Earlier assistant answer",
      "Earlier user message",
      "Earlier assistant answer",
      "Earlier user message",
      "Earlier assistant answer",
    ]);
  });

  it("uses a conservative heuristic for Chinese and source code instead of the old character/4 estimate", () => {
    const chinese = "上下文压缩需要保留最近十六轮消息，并且可以追溯。";
    const sourceCode = "export function add(left: number, right: number) { return left + right; }";

    expect(estimateTokens(chinese)).toBeGreaterThan(Math.ceil(chinese.length / 4));
    expect(estimateTokens(sourceCode)).toBeGreaterThan(Math.ceil(sourceCode.length / 4));
    expect(estimateTokens(`${chinese}\n${sourceCode}`)).toBeGreaterThan(estimateTokens(chinese));
  });

  it("records tool-only compaction even when no history checkpoint is needed", () => {
    const builder = new DeterministicContextBuilder({ idFactory: (prefix) => `${prefix}:tool-only` });
    const observation = ObservationSchema.parse({
      observation_id: "observation:oversized-tool",
      action_id: "action:oversized-tool",
      receipt_id: "receipt:oversized-tool",
      status: "success",
      summary: "The tool returned a large result",
      facts: { output: "上下文工具结果".repeat(160) },
      artifact_refs: [],
      created_at: "2026-09-17T00:00:00.000Z",
    });

    const built = builder.build({
      projectId: "project:tool-only",
      runId: "run:tool-only",
      turnId: "turn:tool-only",
      modelCallId: "model-call:tool-only",
      task: "Inspect the oversized tool result safely",
      workspaceKind: "managed_local",
      observations: [observation],
      contextPolicy: {
        window_tokens: 1_024,
        reserved_output_tokens: 256,
        warning_ratio: 0.7,
        compression_ratio: 0.8,
        recent_history_messages: 16,
        history_checkpoint_tokens: 160,
        tool_budget_ratio: 0.1,
        token_estimator: "heuristic_v2",
      },
    });

    expect(built.manifest.budget?.status).toBe("compressed");
    expect(built.manifest.compression).toMatchObject({
      strategy: "none",
      applied_strategy: "bounded_tool_output",
      trigger: "hard_budget",
      compacted_history_message_count: 0,
    });
    expect(built.manifest.items.find((item) => item.section === "tool")?.action).toBe("truncated");
    expect(built.modelContext).not.toContain("上下文工具结果".repeat(160));
  });

  it("accounts prior conversation turns in the inspectable context manifest", () => {
    let id = 0;
    const builder = new DeterministicContextBuilder({ idFactory: (prefix) => `${prefix}:${++id}` });
    const built = builder.build({
      projectId: "project:test",
      runId: "run:followup",
      turnId: "turn:followup",
      modelCallId: "model-call:followup",
      task: "How does that apply here?",
      workspaceKind: "managed_local",
      conversationHistory: [
        { role: "user", content: "What is memory?" },
        { role: "assistant", content: "Memory preserves useful prior information." },
      ],
      observations: [],
    });

    const history = built.manifest.items.filter((item) => item.section === "history");
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({ label: "Earlier assistant answer", source: { trust: "untrusted" } });
    expect(built.modelContext).toContain("Memory preserves useful prior information.");
    expect(built.manifest.input_tokens).toBe(built.manifest.items.reduce((sum, item) => sum + item.included_tokens, 0));
  });
  it("makes bounded tool evidence visible to the model and accounts for every token", () => {
    let id = 0;
    const builder = new DeterministicContextBuilder({
      idFactory: (prefix) => `${prefix}:${++id}`,
      now: () => new Date("2026-09-16T00:00:00.000Z"),
    });
    const observation = ObservationSchema.parse({
      observation_id: "observation:read",
      action_id: "action:read",
      receipt_id: "receipt:read",
      status: "success",
      summary: "Read src/add.ts",
      facts: {
        tool_name: "read_file",
        path: "src/add.ts",
        content_excerpt: "export function add(left: number, right: number) { return left - right; }",
      },
      artifact_refs: [],
      created_at: "2026-09-16T00:00:00.000Z",
    });

    const built = builder.build({
      projectId: "project:test",
      runId: "run:test",
      turnId: "turn:test",
      modelCallId: "model-call:test",
      task: "Repair the fixture",
      workspaceKind: "disposable_fixture",
      observations: [observation],
    });

    expect(built.modelObservations).toHaveLength(1);
    expect(JSON.stringify(built.modelObservations)).toContain("return left - right;");
    expect(built.modelContext).toContain("return left - right;");
    expect(built.manifest.input_tokens).toBe(
      built.manifest.items.reduce((total, item) => total + item.included_tokens, 0),
    );
  });

  it("keeps a large observation as a valid structured summary in both model channels", () => {
    let id = 0;
    const builder = new DeterministicContextBuilder({ idFactory: (prefix) => `${prefix}:${++id}` });
    const observation = ObservationSchema.parse({
      observation_id: "observation:large",
      action_id: "action:large",
      receipt_id: "receipt:large",
      status: "success",
      summary: "Large untrusted output",
      facts: { tool_name: "read_file", content_excerpt: "x".repeat(10_000) },
      artifact_refs: [],
      created_at: "2026-09-16T00:00:00.000Z",
    });

    const built = builder.build({
      projectId: "project:test",
      runId: "run:test",
      turnId: "turn:test",
      modelCallId: "model-call:test",
      task: "Inspect safely",
      workspaceKind: "readonly_local",
      observations: [observation],
      tokenLimit: 150,
      reservedOutputTokens: 20,
    });

    const toolItem = built.manifest.items.find((item) => item.section === "tool");
    expect(toolItem?.action).toBe("truncated");
    expect(toolItem?.included_tokens).toBeGreaterThan(0);
    expect(built.modelObservations).toHaveLength(1);
    expect(built.modelObservations[0]).toMatchObject({
      status: "success",
      summary: "Large untrusted output",
      facts: {
        observation_id: "observation:large",
        context_compacted: true,
      },
    });
    expect(() => JSON.parse(toolItem?.content ?? "")).not.toThrow();
    expect(built.modelContext).toContain('"context_compacted":true');
    expect(built.modelContext).not.toContain("x".repeat(10_000));
  });

  it("retains a bounded read excerpt when other tool facts force compaction", () => {
    let id = 0;
    const builder = new DeterministicContextBuilder({ idFactory: (prefix) => `${prefix}:${++id}` });
    const observation = ObservationSchema.parse({
      observation_id: "observation:read-with-large-facts",
      action_id: "action:read-with-large-facts",
      receipt_id: "receipt:read-with-large-facts",
      status: "success",
      summary: "Read README.md",
      facts: {
        tool_name: "read_file",
        path: "README.md",
        content_excerpt: "# TraceGraph\n\nThis excerpt must remain available to the model.".repeat(60),
        matches: Array.from({ length: 700 }, (_, index) => ({ path: `src/file-${index}.ts`, line: index + 1 })),
      },
      artifact_refs: [],
      created_at: "2026-09-16T00:00:00.000Z",
    });

    const built = builder.build({
      projectId: "project:read-excerpt",
      runId: "run:read-excerpt",
      turnId: "turn:read-excerpt",
      modelCallId: "model-call:read-excerpt",
      task: "Introduce the project",
      workspaceKind: "managed_local",
      observations: [observation],
    });

    expect(built.manifest.items.find((item) => item.section === "tool")?.action).toBe("truncated");
    expect(JSON.stringify(built.modelObservations)).toContain("This excerpt must remain available to the model.");
    expect(built.modelContext).toContain("This excerpt must remain available to the model.");
  });

  it("externalizes oversized facts while preserving their artifact reference", () => {
    let id = 0;
    const builder = new DeterministicContextBuilder({ idFactory: (prefix) => `${prefix}:${++id}` });
    const observation = ObservationSchema.parse({
      observation_id: "observation:artifact",
      action_id: "action:artifact",
      receipt_id: "receipt:artifact",
      status: "success",
      summary: "Large search output",
      facts: { matches: Array.from({ length: 1_000 }, (_, index) => ({ index })) },
      artifact_refs: [{
        artifact_id: "artifact:search",
        kind: "tool_output",
        content_hash: `sha256:${"a".repeat(64)}`,
        mime_type: "application/json",
        byte_length: 100_000,
        project_id: "project:test",
        run_id: "run:test",
        created_at: "2026-09-16T00:00:00.000Z",
      }],
      created_at: "2026-09-16T00:00:00.000Z",
    });

    const built = builder.build({
      projectId: "project:test",
      runId: "run:test",
      turnId: "turn:test",
      modelCallId: "model-call:test",
      task: "Inspect safely",
      workspaceKind: "readonly_local",
      observations: [observation],
      tokenLimit: 180,
      reservedOutputTokens: 20,
    });

    const toolItem = built.manifest.items.find((item) => item.section === "tool");
    expect(toolItem?.action).toBe("externalized");
    expect(toolItem?.artifact_ref?.artifact_id).toBe("artifact:search");
    expect(built.modelObservations[0]?.facts).toMatchObject({ context_compacted: true });
    expect(JSON.stringify(built.modelObservations[0]?.facts)).toContain("artifact:search");
    expect(() => JSON.parse(toolItem?.content ?? "")).not.toThrow();
  });
});
