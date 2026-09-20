import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "../../packages/core/dist/index.js";
import {
  ScriptedMockProvider,
  createFailingTypescriptFixture,
  createTemporaryDataDir,
  mockDecision,
} from "../../packages/test-support/dist/index.js";
import { eventIndex, finishDecision, startEvalInput, waitForEvalStatus } from "./helpers.js";

describe("runtime behavior: approval chain", () => {
  it("binds one approval to the previewed patch before applying it", async () => {
    const fixture = await createFailingTypescriptFixture("eval-approval-chain");
    const data = await createTemporaryDataDir();
    try {
      const provider = new ScriptedMockProvider({
        decisions: [
          mockDecision({
            decision_id: "decision:eval-preview",
            kind: "tool_call",
            public_reason: "Create an exact patch preview before requesting write authority.",
            evidence_refs: [],
            risk: "high",
            expected_effect: "Replace subtraction with addition.",
            tool_call: {
              action_id: "action:eval-preview",
              tool_name: "preview_patch",
              arguments: {
                path: "src/add.ts",
                expected: "return left - right;",
                replacement: "return left + right;",
              },
            },
          }),
          mockDecision(finishDecision("eval-approval-finish", "The approved patch was applied.")),
        ],
      });
      const runtime = await createAgentRuntime({ dataDir: data.path, model: provider });
      const started = await runtime.startRun(startEvalInput(
        fixture.handle,
        "approval-chain",
        "Preview and apply the arithmetic correction.",
      ));
      const waiting = await waitForEvalStatus(runtime, started.run_id, "awaiting_approval");

      expect(await readFile(join(fixture.handle.real_root, "src/add.ts"), "utf8"))
        .toContain("return left - right;");
      const pending = waiting.pending_approval;
      expect(pending).toBeDefined();

      const completed = await runtime.approve({
        type: "approve",
        command_id: "command:eval:approve-once",
        project_id: waiting.project_id,
        run_id: waiting.run_id,
        approval_id: pending!.approval_id,
        action_id: pending!.action_id,
      });

      expect(completed.status).toBe("completed");
      expect(await readFile(join(fixture.handle.real_root, "src/add.ts"), "utf8"))
        .toContain("return left + right;");
      expect(eventIndex(completed, "patch.preview_created"))
        .toBeLessThan(eventIndex(completed, "approval.requested"));
      expect(eventIndex(completed, "approval.requested"))
        .toBeLessThan(eventIndex(completed, "approval.granted"));
      expect(eventIndex(completed, "approval.granted"))
        .toBeLessThan(eventIndex(completed, "patch.applied"));
      expect(eventIndex(completed, "patch.applied"))
        .toBeLessThan(eventIndex(completed, "run.completed"));
      expect(completed.timeline.filter(({ type }) => type === "approval.granted")).toHaveLength(1);
      expect(provider.remaining()).toEqual({ decisions: 0, summaries: 0 });
    } finally {
      await Promise.all([fixture.cleanup(), data.cleanup()]);
    }
  });
});
