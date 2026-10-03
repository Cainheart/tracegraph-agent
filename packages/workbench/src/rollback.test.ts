import { describe, expect, it } from "vitest";
import { WireSessionEventSchema } from "@tracegraph/contracts";
import { appliedPatchActions, rollbackReceipt } from "./rollback";

const event = (type: string, sequence: number, actionId = "action:recorded", data: Record<string, unknown> = { scope: ["src/add.ts"] }) => WireSessionEventSchema.parse({ schema_version: "tracegraph.session-event.v1", event_id: `event:${sequence}`, project_id: "project:local", run_id: "run:local", sequence, occurred_at: "2026-10-03T00:00:00Z", type, summary: "Durable fixture", action_id: actionId, artifact_refs: [], data });
const fixture = (timeline: ReturnType<typeof event>[]) => ({ project_id: "project:local", run_id: "run:local", workspace_kind: "managed_local" as const, timeline });

describe("Action rollback identity and durable receipts", () => {
  it("uses an applied event's exact locator and scope, never a preview or another Run", () => {
    const preview = event("patch.preview_created", 1), applied = event("patch.applied", 2);
    const foreign = { ...event("patch.applied", 3, "action:foreign"), run_id: "run:other" };
    expect(appliedPatchActions(fixture([preview, applied, foreign]))).toEqual([{ actionId: "action:recorded", projectId: "project:local", runId: "run:local", patchEventId: "event:2", workspaceKind: "managed_local", scope: ["src/add.ts"], state: "applied" }]);
    expect(appliedPatchActions(fixture([preview]))).toEqual([]);
  });
  it("does not turn an HTTP projection or another Action's event into rollback success", () => {
    const applied = event("patch.applied", 1);
    expect(rollbackReceipt(fixture([applied, event("patch.rolled_back", 2, "action:other")]), "action:recorded")).toBeUndefined();
    const refusal = event("action.rollback_refused", 3, "action:recorded", { reason: "rollback_policy_disabled" });
    expect(rollbackReceipt(fixture([applied, refusal]), "action:recorded")).toEqual({ actionId: "action:recorded", runId: "run:local", state: "refused", eventId: "event:3", sequence: 3, reason: "rollback_policy_disabled" });
    expect(appliedPatchActions(fixture([applied, refusal]))[0]?.state).toBe("applied");
    const rollback = event("patch.rolled_back", 4);
    expect(rollbackReceipt(fixture([applied, refusal, rollback]), "action:recorded")?.state).toBe("rolled_back");
    expect(appliedPatchActions(fixture([applied, refusal, rollback]))[0]?.state).toBe("rolled_back");
  });
});
