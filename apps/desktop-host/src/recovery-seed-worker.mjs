import { join } from "node:path";
import { createAgentRuntime, redactSensitiveText } from "@tracegraph/core";
import { JsonlSessionStore } from "@tracegraph/session";
import { DecisionSchema } from "@tracegraph/contracts";

let runtime;

process.once("message", async (message) => {
  try {
    const { dataDir, workspace } = message;
    const planMode = message.mode === "plan";
    let planTurns = 0;
    const sessionStore = new JsonlSessionStore(join(dataDir, "sessions"), {
      trashRoot: join(dataDir, "sessions-trash"),
      redactSensitiveText,
    });
    runtime = await createAgentRuntime({
      dataDir,
      sessionStore,
      sandboxMode: "danger-full-access",
      ...(planMode ? { model: {
        name: "desktop-plan-recovery-fixture",
        async decide() {
          planTurns += 1;
          return DecisionSchema.parse(planTurns === 1 ? {
            decision_id: "decision:todo", kind: "tool_call", public_reason: "Create a reviewable plan", evidence_refs: [], risk: "low", expected_effect: "Plan Todo",
            tool_call: { action_id: "action:todo", tool_name: "todo_write", arguments: { operation: "create", todo_id: "todo:plan", title: "Inspect before executing" } },
          } : {
            decision_id: "decision:plan-finish", kind: "finish", public_reason: "Plan ready", evidence_refs: [], risk: "none", final_answer: "Plan is ready for approval.",
          });
        },
      } } : {}),
    });
    const started = await runtime.startRun({
      command_id: "command:desktop-host-crash-seed",
      project_id: workspace.project_id,
      task: planMode ? "UX plan" : "Fix the deterministic arithmetic defect before changing files.",
      mode: planMode ? "plan" : "execute",
      workspace,
    });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const current = await runtime.getProjection(started.run_id);
      if (current.status === (planMode ? "awaiting_plan_approval" : "awaiting_approval")) {
        process.send?.({ kind: "seeded", run_id: current.run_id, session_id: current.session_id });
        return;
      }
      if (["completed", "failed", "cancelled", "interrupted"].includes(current.status)) {
        throw new Error(`Seed Run became terminal before approval: ${current.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error("Seed Run did not reach a durable pending approval in time");
  } catch (error) {
    process.send?.({ kind: "seed_error", message: error instanceof Error ? error.message : "seed failed" });
    process.exitCode = 1;
    await runtime?.shutdownBackgroundWork?.();
  }
});

process.on("disconnect", () => {
  // The parent intentionally SIGKILLs this process after the active Run is durable.
});
