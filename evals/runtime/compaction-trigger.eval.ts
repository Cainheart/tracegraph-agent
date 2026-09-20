import { describe, expect, it } from "vitest";
import {
  createAgentRuntime,
  createDefaultToolRegistry,
  type ToolDefinition,
} from "../../packages/core/dist/index.js";
import {
  ScriptedMockProvider,
  createFailingTypescriptFixture,
  createTemporaryDataDir,
  mockDecision,
} from "../../packages/test-support/dist/index.js";
import { eventIndex, finishDecision, startEvalInput, waitForEvalStatus } from "./helpers.js";

describe("runtime behavior: compaction trigger", () => {
  it("crosses the hard budget and records a strictly reducing strategy chain", async () => {
    const fixture = await createFailingTypescriptFixture("eval-compaction-trigger");
    const data = await createTemporaryDataDir();
    try {
      const registry = createDefaultToolRegistry();
      const search = registry.get("search")!;
      registry.register({
        ...search,
        async execute() {
          return {
            status: "success" as const,
            code: "eval_oversized_evidence",
            summary: "Returned deliberately large, bounded evaluation evidence",
            facts: { output: "上下文压缩评测证据".repeat(260) },
          };
        },
      } as ToolDefinition);
      const provider = new ScriptedMockProvider({
        decisions: [
          mockDecision({
            decision_id: "decision:eval-compaction-search",
            kind: "tool_call",
            public_reason: "Collect enough bounded evidence to cross the compaction threshold.",
            evidence_refs: [],
            risk: "low",
            tool_call: {
              action_id: "action:eval-compaction-search",
              tool_name: "search",
              arguments: { pattern: "compaction" },
            },
          }),
          mockDecision(finishDecision("eval-compaction-finish", "Compaction preserved a bounded context.")),
        ],
      });
      const runtime = await createAgentRuntime({
        dataDir: data.path,
        model: provider,
        toolRegistry: registry,
        contextPolicy: {
          window_tokens: 1_024,
          reserved_output_tokens: 256,
          warning_ratio: 0.7,
          compression_ratio: 0.8,
          recent_history_messages: 16,
          history_checkpoint_tokens: 160,
          tool_budget_ratio: 0.1,
          token_estimator: "heuristic_v2",
          compaction: {
            tool_output_pruner: { enabled: true, threshold_tokens: 512, target_tokens: 256 },
            spill: { enabled: false, threshold_tokens: 512, preview_tokens: 64 },
            model_summary: {
              enabled: false,
              threshold_tokens: 512,
              target_tokens: 128,
              timeout_ms: 500,
              prompt_version: "tracegraph.context-summary.eval.v1",
            },
            tiered_checkpoint: { enabled: true, threshold_tokens: 512, target_tokens: 160 },
          },
        },
      });

      const started = await runtime.startRun(startEvalInput(
        fixture.handle,
        "compaction-trigger",
        "Exercise the hard Context budget with bounded Tool evidence.",
      ));
      const completed = await waitForEvalStatus(runtime, started.run_id, "completed");
      const compacted = completed.timeline.find((event) => (
        event.type === "context.compaction_completed"
        && event.data.applied_strategy === "strategy_chain"
      ));
      const steps = compacted?.data.steps as Array<{
        strategy_id: string;
        tokens_before: number;
        tokens_after: number;
      }> | undefined;

      expect(compacted).toBeDefined();
      expect(eventIndex(completed, "context.compaction_started"))
        .toBeLessThan(eventIndex(completed, "context.compaction_completed"));
      expect(steps?.some(({ strategy_id: strategy }) => strategy === "tool_output_pruner")).toBe(true);
      expect(steps?.every((step) => step.tokens_after < step.tokens_before)).toBe(true);
      expect(completed.timeline.filter(({ type }) => type === "model.request_started")).toHaveLength(2);
    } finally {
      await Promise.all([fixture.cleanup(), data.cleanup()]);
    }
  });
});
