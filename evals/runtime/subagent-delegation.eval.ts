import { describe, expect, it } from "vitest";
import {
  SubagentRegistry,
  createAgentRuntime,
} from "../../packages/core/dist/index.js";
import {
  ScriptedMockProvider,
  createFailingTypescriptFixture,
  createTemporaryDataDir,
  mockDecision,
} from "../../packages/test-support/dist/index.js";
import { finishDecision, startEvalInput, waitForEvalStatus } from "./helpers.js";

describe("runtime behavior: subagent delegation", () => {
  it("records six parent receipts for two children whose ledgers replay completely", async () => {
    const fixture = await createFailingTypescriptFixture("eval-subagent-delegation");
    const data = await createTemporaryDataDir();
    try {
      const childProvider = new ScriptedMockProvider({
        name: "eval-child-provider",
        decisions: [
          mockDecision(finishDecision("eval-child-one", "Child one inspected the delegated scope.")),
          mockDecision(finishDecision("eval-child-two", "Child two inspected the delegated scope.")),
        ],
      });
      const parentProvider = new ScriptedMockProvider({
        name: "eval-parent-provider",
        decisions: [
          mockDecision({
            decision_id: "decision:eval-spawn-one",
            kind: "tool_call",
            public_reason: "Delegate the first bounded read-only inspection.",
            evidence_refs: [],
            risk: "low",
            tool_call: {
              action_id: "action:eval-spawn-one",
              tool_name: "spawn_subagent",
              arguments: {
                profile_name: "readonly",
                task_packet: {
                  task: "Inspect the source layout and report the relevant entry points.",
                  constraints: ["Do not modify files"],
                  acceptance_criteria: ["Return a concise evidence-backed summary"],
                },
                context_scope: "isolated",
              },
            },
          }),
          mockDecision({
            decision_id: "decision:eval-spawn-two",
            kind: "tool_call",
            public_reason: "Delegate the second bounded read-only inspection.",
            evidence_refs: [],
            risk: "low",
            tool_call: {
              action_id: "action:eval-spawn-two",
              tool_name: "spawn_subagent",
              arguments: {
                profile_name: "readonly",
                task_packet: {
                  task: "Inspect the test layout and report the relevant verification paths.",
                  constraints: ["Do not modify files"],
                  acceptance_criteria: ["Return a concise evidence-backed summary"],
                },
                context_scope: "isolated",
              },
            },
          }),
          mockDecision(finishDecision(
            "eval-parent-finish",
            "Both delegated inspections returned canonical results.",
          )),
        ],
      });
      const registry = new SubagentRegistry([{
        name: "readonly",
        providerKey: "eval-child",
        rolePromptVersion: "tracegraph.subagent.eval-readonly.v1",
        rolePrompt: "Inspect only the delegated task and return a concise read-only result.",
        toolAllowlist: ["read_file", "list_dir", "search"],
        defaultBudget: { max_steps: 4, max_tokens: 4_000 },
        budgetCeiling: { max_steps: 4, max_tokens: 4_000 },
        model: childProvider,
      }]);
      const runtime = await createAgentRuntime({
        dataDir: data.path,
        model: parentProvider,
        subagentRegistry: registry,
        maxParallelSubagents: 2,
        maxSubagentDepth: 1,
      });

      const started = await runtime.startRun(startEvalInput(
        fixture.handle,
        "subagent-delegation",
        "Delegate two independent read-only inspections and combine their results.",
      ));
      const parent = await waitForEvalStatus(runtime, started.run_id, "completed");
      const delegationEvents = parent.timeline.filter(({ type }) => type.startsWith("subagent."));

      expect(delegationEvents.map(({ type }) => type)).toEqual([
        "subagent.started",
        "subagent.message_sent",
        "subagent.completed",
        "subagent.started",
        "subagent.message_sent",
        "subagent.completed",
      ]);
      expect(delegationEvents).toHaveLength(6);
      expect(parent.subagents.items).toHaveLength(2);
      expect(parent.subagents.items.every(({ status }) => status === "completed")).toBe(true);

      for (const item of parent.subagents.items) {
        expect(item.link.parent_run_id).toBe(parent.run_id);
        expect(item.link.parent_session_id).toBe(parent.session_id);
        expect(item.link.child_run_id).not.toBe(parent.run_id);
        expect(item.link.child_session_id).not.toBe(parent.session_id);

        const canonicalChild = await runtime.getProjection(item.link.child_run_id);
        const replayedChild = await runtime.replay(item.link.child_run_id);
        expect(replayedChild).toEqual(canonicalChild);
        expect(canonicalChild.session_id).toBe(item.link.child_session_id);
        expect(canonicalChild.status).toBe("completed");
        expect(canonicalChild.timeline[0]?.type).toBe("run.created");
        expect(canonicalChild.timeline.at(-1)?.type).toBe("run.completed");
        expect(canonicalChild.last_sequence).toBe(canonicalChild.timeline.at(-1)?.sequence);
        expect(canonicalChild.timeline.every(({ run_id: runId }) => runId === item.link.child_run_id)).toBe(true);
      }
      expect(parentProvider.remaining()).toEqual({ decisions: 0, summaries: 0 });
      expect(childProvider.remaining()).toEqual({ decisions: 0, summaries: 0 });
    } finally {
      await Promise.all([fixture.cleanup(), data.cleanup()]);
    }
  });
});
