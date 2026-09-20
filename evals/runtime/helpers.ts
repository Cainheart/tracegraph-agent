import type { AgentRuntime } from "../../packages/core/dist/index.js";
import type { WorkspaceHandle } from "../../packages/contracts/dist/index.js";

export function startEvalInput(workspace: WorkspaceHandle, suffix: string, task: string) {
  return {
    command_id: `command:eval:${suffix}`,
    project_id: workspace.project_id,
    task,
    mode: "execute" as const,
    workspace,
  };
}

export async function waitForEvalStatus(
  runtime: AgentRuntime,
  runId: string,
  ...statuses: Array<"awaiting_approval" | "completed" | "failed" | "cancelled" | "interrupted">
) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const projection = await runtime.getProjection(runId);
    if (statuses.includes(projection.status as (typeof statuses)[number])) return projection;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${statuses.join("/")} on ${runId}`);
}

export function finishDecision(id: string, answer: string) {
  return {
    decision_id: `decision:${id}`,
    kind: "finish" as const,
    public_reason: "The offline evaluation has enough committed evidence to stop.",
    evidence_refs: [],
    risk: "none" as const,
    final_answer: answer,
  };
}

export function eventIndex(
  projection: Awaited<ReturnType<AgentRuntime["getProjection"]>>,
  type: string,
): number {
  const index = projection.timeline.findIndex((event) => event.type === type);
  if (index < 0) throw new Error(`Expected ${type} in the evaluation timeline`);
  return index;
}
