import { describe, expect, it } from "vitest";
import {
  ExternalActionReconciliationDecisionSchema,
  ExternalActionReconciliationRequestSchema,
} from "./action-reconciliation.js";

const request = {
  project_id: "project:external-action",
  run_id: "run:external-action",
  action_id: "action:external-action",
  operation_id: "action:external-action",
  tool_name: "acme.remote_write",
  trigger: "unknown_result",
} as const;

describe("external Action reconciliation contract", () => {
  it("accepts a bounded request with stable action and operation identity", () => {
    expect(ExternalActionReconciliationRequestSchema.parse(request)).toEqual(request);
  });

  it.each(["confirmed", "failed", "diverged"] as const)(
    "%s requires provider evidence",
    (outcome) => {
      expect(ExternalActionReconciliationDecisionSchema.safeParse({
        operation_id: request.operation_id,
        outcome,
        reason_code: "provider_state",
        summary: "Provider returned a bounded classification",
      }).success).toBe(false);
    },
  );

  it("allows unknown without claiming evidence and rejects undeclared fields", () => {
    expect(ExternalActionReconciliationDecisionSchema.safeParse({
      operation_id: request.operation_id,
      outcome: "unknown",
      reason_code: "provider_unavailable",
      summary: "Provider could not determine the operation state",
    }).success).toBe(true);
    expect(ExternalActionReconciliationDecisionSchema.safeParse({
      operation_id: request.operation_id,
      outcome: "confirmed",
      reason_code: "provider_state",
      summary: "Provider confirmed the operation",
      evidence_digest: `sha256:${"a".repeat(64)}`,
      private_payload: "must not be persisted",
    }).success).toBe(false);
  });
});
