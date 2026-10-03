import type { RunProjection } from "@tracegraph/contracts";
import type { AppliedPatchAction, RollbackReceipt } from "./model";

/** Only explicit scoped apply events provide an Action locator. */
export function appliedPatchActions(projection: Pick<RunProjection, "project_id" | "run_id" | "workspace_kind" | "timeline">): AppliedPatchAction[] {
  const actions = new Map<string, AppliedPatchAction>();
  for (const event of projection.timeline) {
    if (event.project_id !== projection.project_id || event.run_id !== projection.run_id || !event.action_id) continue;
    if (event.type === "patch.applied") {
      const scope = Array.isArray(event.data.scope) && event.data.scope.every((path) => typeof path === "string") ? event.data.scope as string[] : [];
      actions.set(event.action_id, { actionId: event.action_id, projectId: projection.project_id, runId: projection.run_id, workspaceKind: projection.workspace_kind, patchEventId: event.event_id, scope, state: "applied" });
    } else if (event.type === "patch.rolled_back") {
      const action = actions.get(event.action_id);
      if (action) actions.set(event.action_id, { ...action, state: "rolled_back" });
    }
  }
  return [...actions.values()];
}

export function rollbackReceipt(projection: Pick<RunProjection, "project_id" | "run_id" | "timeline">, actionId: string): RollbackReceipt | undefined {
  const event = [...projection.timeline].reverse().find((item) => item.run_id === projection.run_id && item.project_id === projection.project_id && item.action_id === actionId && (item.type === "patch.rolled_back" || item.type === "action.rollback_refused"));
  if (!event) return undefined;
  return { actionId, runId: projection.run_id, state: event.type === "patch.rolled_back" ? "rolled_back" : "refused", eventId: event.event_id, sequence: event.sequence, ...(typeof event.data.reason === "string" ? { reason: event.data.reason } : {}) };
}
