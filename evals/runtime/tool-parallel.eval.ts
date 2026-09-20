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
import { finishDecision, startEvalInput, waitForEvalStatus } from "./helpers.js";

describe("runtime behavior: parallel tools", () => {
  it("executes one safe batch concurrently while preserving requested observation order", async () => {
    const fixture = await createFailingTypescriptFixture("eval-tool-parallel");
    const data = await createTemporaryDataDir();
    try {
      const registry = createDefaultToolRegistry();
      const search = registry.get("search")!;
      let active = 0;
      let peak = 0;
      registry.register({
        ...search,
        async execute(input: unknown) {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 20));
          active -= 1;
          return {
            status: "success" as const,
            code: "eval_parallel_complete",
            summary: "Completed one offline parallel evaluation call",
            facts: { pattern: (input as { pattern: string }).pattern },
          };
        },
      } as ToolDefinition);
      const actionIds = ["action:eval-parallel:1", "action:eval-parallel:2", "action:eval-parallel:3"];
      const provider = new ScriptedMockProvider({
        decisions: [
          mockDecision({
            decision_id: "decision:eval-parallel",
            kind: "tool_call",
            public_reason: "Read three independent facts concurrently.",
            evidence_refs: [],
            risk: "low",
            tool_calls: actionIds.map((actionId, index) => ({
              action_id: actionId,
              tool_name: "search" as const,
              arguments: { pattern: `parallel-${index}` },
            })),
          }),
          mockDecision(finishDecision("eval-parallel-finish", "Parallel evidence collection completed.")),
        ],
      });
      const runtime = await createAgentRuntime({
        dataDir: data.path,
        model: provider,
        toolRegistry: registry,
        maxToolConcurrency: 3,
      });

      const started = await runtime.startRun(startEvalInput(
        fixture.handle,
        "tool-parallel",
        "Collect three independent repository facts.",
      ));
      const completed = await waitForEvalStatus(runtime, started.run_id, "completed");
      const batch = completed.timeline.find(({ type }) => type === "tool.batch_completed");
      const toolEvents = completed.timeline.filter(({ type }) => type === "tool.completed");

      expect(peak).toBe(3);
      expect(toolEvents.map(({ action_id: actionId }) => actionId)).toEqual(actionIds);
      expect(toolEvents.every((event) => (
        (event.data.receipt as { metadata?: { execution_parallel?: boolean } }).metadata
          ?.execution_parallel === true
      ))).toBe(true);
      expect(batch?.data).toMatchObject({
        requested_count: 3,
        completed_count: 3,
        failed_count: 0,
        effective_concurrency: 3,
        action_ids: actionIds,
      });
      expect(provider.calls().map(({ channel }) => channel)).toEqual(["decision", "decision"]);
    } finally {
      await Promise.all([fixture.cleanup(), data.cleanup()]);
    }
  });
});
