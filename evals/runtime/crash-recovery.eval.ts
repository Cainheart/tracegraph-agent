import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlSessionStore, createAgentRuntime } from "../../packages/core/dist/index.js";
import {
  ScriptedMockProvider,
  createFailingTypescriptFixture,
  createTemporaryDataDir,
  mockDecision,
} from "../../packages/test-support/dist/index.js";
import { finishDecision, startEvalInput, waitForEvalStatus } from "./helpers.js";

describe("runtime behavior: crash recovery", () => {
  it("renews stale approval authority after restart and resumes the same ledger", async () => {
    const fixture = await createFailingTypescriptFixture("eval-crash-recovery");
    const data = await createTemporaryDataDir();
    try {
      const sessionsRoot = join(data.path, "sessions");
      const firstProvider = new ScriptedMockProvider({
        decisions: [mockDecision({
          decision_id: "decision:eval-recovery-preview",
          kind: "tool_call",
          public_reason: "Create a durable preview before the simulated process loss.",
          evidence_refs: [],
          risk: "high",
          tool_call: {
            action_id: "action:eval-recovery-preview",
            tool_name: "preview_patch",
            arguments: {
              path: "src/add.ts",
              expected: "return left - right;",
              replacement: "return left + right;",
            },
          },
        })],
      });
      const firstStore = new JsonlSessionStore(sessionsRoot, { pid: 2_147_483_646 });
      const firstRuntime = await createAgentRuntime({
        dataDir: data.path,
        model: firstProvider,
        sessionStore: firstStore,
      });
      const started = await firstRuntime.startRun(startEvalInput(
        fixture.handle,
        "crash-recovery",
        "Resume an approval-bound patch after a simulated Host crash.",
      ));
      const waiting = await waitForEvalStatus(firstRuntime, started.run_id, "awaiting_approval");
      const oldApproval = waiting.pending_approval!;
      await waitForIndexedTimeline(firstStore, waiting.session_id!, waiting.timeline.length);

      const resumedProvider = new ScriptedMockProvider({
        decisions: [mockDecision(finishDecision(
          "eval-recovery-finish",
          "The recovered patch was approved with fresh authority.",
        ))],
      });
      const restartedRuntime = await createAgentRuntime({
        dataDir: data.path,
        model: resumedProvider,
        sessionStore: new JsonlSessionStore(sessionsRoot),
      });
      await restartedRuntime.markRunInterrupted({
        sessionId: waiting.session_id!,
        runId: waiting.run_id,
        projectId: waiting.project_id,
        reason: "eval_simulated_host_crash",
      });
      const resumed = await restartedRuntime.resumeRun({
        sessionId: waiting.session_id!,
        runId: waiting.run_id,
        projectId: waiting.project_id,
        commandId: "command:eval:resume-after-crash",
        workspace: fixture.handle,
      });

      expect(resumed.status).toBe("awaiting_approval");
      expect(resumed.pending_approval?.approval_id).not.toBe(oldApproval.approval_id);
      await expect(restartedRuntime.approve({
        type: "approve",
        command_id: "command:eval:stale-approval",
        project_id: waiting.project_id,
        run_id: waiting.run_id,
        approval_id: oldApproval.approval_id,
        action_id: oldApproval.action_id,
      })).rejects.toMatchObject({ code: "approval_binding_mismatch" });

      const fresh = resumed.pending_approval!;
      const completed = await restartedRuntime.approve({
        type: "approve",
        command_id: "command:eval:fresh-approval",
        project_id: waiting.project_id,
        run_id: waiting.run_id,
        approval_id: fresh.approval_id,
        action_id: fresh.action_id,
      });

      expect(completed.status).toBe("completed");
      expect(completed.timeline.filter(({ type }) => type === "run.interrupted")).toHaveLength(1);
      expect(completed.timeline.filter(({ type }) => type === "run.resumed")).toHaveLength(1);
      expect(completed.timeline.map(({ sequence }) => sequence)).toEqual(
        completed.timeline.map((_, index) => index + 1),
      );
      expect(await readFile(join(fixture.handle.real_root, "src/add.ts"), "utf8"))
        .toContain("return left + right;");
    } finally {
      await Promise.all([fixture.cleanup(), data.cleanup()]);
    }
  });
});

async function waitForIndexedTimeline(
  store: JsonlSessionStore,
  sessionId: string,
  expectedEntries: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await store.readAll(sessionId)).entries.length >= expectedEntries) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${expectedEntries} durable Session references`);
}
