import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAgentRuntime,
  type SandboxExecutionResult,
  type SandboxRunRequest,
  type SandboxRunner,
} from "../../packages/core/dist/index.js";
import type { SandboxReport } from "../../packages/contracts/dist/index.js";
import {
  ScriptedMockProvider,
  createFailingTypescriptFixture,
  createTemporaryDataDir,
  mockDecision,
} from "../../packages/test-support/dist/index.js";
import { eventIndex, startEvalInput, waitForEvalStatus } from "./helpers.js";

describe("runtime behavior: sandbox refusal", () => {
  it("permits a reviewable preview but rejects mutation before approval in read-only mode", async () => {
    const fixture = await createFailingTypescriptFixture("eval-sandbox-refusal");
    const data = await createTemporaryDataDir();
    try {
      const runner = new ReadOnlySandboxRunner();
      const provider = new ScriptedMockProvider({
        decisions: [mockDecision({
          decision_id: "decision:eval-readonly-preview",
          kind: "tool_call",
          public_reason: "Preview a change without widening read-only authority.",
          evidence_refs: [],
          risk: "high",
          tool_call: {
            action_id: "action:eval-readonly-preview",
            tool_name: "preview_patch",
            arguments: {
              path: "src/add.ts",
              expected: "return left - right;",
              replacement: "return left + right;",
            },
          },
        })],
      });
      const runtime = await createAgentRuntime({
        dataDir: data.path,
        model: provider,
        sandboxMode: "read-only",
        sandboxRunner: runner,
      });
      const started = await runtime.startRun(startEvalInput(
        fixture.handle,
        "sandbox-refusal",
        "Attempt a mutation while the Host policy is read-only.",
      ));
      const failed = await waitForEvalStatus(runtime, started.run_id, "failed");

      expect(failed.failure_code).toBe("sandbox_denied");
      expect(failed.timeline.find(({ type }) => type === "tool.completed")?.data).toMatchObject({
        receipt: { tool_name: "preview_patch", status: "success" },
      });
      expect(eventIndex(failed, "tool.completed")).toBeLessThan(eventIndex(failed, "policy.denied"));
      expect(eventIndex(failed, "policy.denied")).toBeLessThan(eventIndex(failed, "run.failed"));
      expect(failed.timeline.some(({ type }) => type === "approval.requested")).toBe(false);
      expect(failed.timeline.some(({ type }) => type === "patch.applied")).toBe(false);
      expect(runner.runRequests).toHaveLength(0);
      expect(await readFile(join(fixture.handle.real_root, "src/add.ts"), "utf8"))
        .toContain("return left - right;");
    } finally {
      await Promise.all([fixture.cleanup(), data.cleanup()]);
    }
  });
});

class ReadOnlySandboxRunner implements SandboxRunner {
  readonly runRequests: SandboxRunRequest[] = [];

  async probe(): Promise<SandboxReport> {
    return {
      report_version: 1,
      mode: "read-only",
      enforcement: "full",
      platform: process.platform === "win32" ? "win32" : process.platform === "linux" ? "linux" : "darwin",
      mechanisms: ["eval:read-only-filesystem", "eval:network-denied"],
      unmet_constraints: [],
    };
  }

  async run(request: SandboxRunRequest): Promise<SandboxExecutionResult> {
    this.runRequests.push(request);
    throw new Error("The read-only policy evaluation must refuse before child execution");
  }
}
