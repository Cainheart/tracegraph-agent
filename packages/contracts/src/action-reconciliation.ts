import { z } from "zod";
import {
  IdentifierSchema,
  NonEmptyStringSchema,
  Sha256Schema,
  ToolNameSchema,
} from "./common.js";

export const ExternalActionReconciliationTriggerSchema = z.enum([
  "dispatch_incomplete",
  "unknown_result",
  "timeout",
  "cancelled",
]);
export type ExternalActionReconciliationTrigger = z.infer<
  typeof ExternalActionReconciliationTriggerSchema
>;

export const ExternalActionReconciliationOutcomeSchema = z.enum([
  // The provider proves the intended business postcondition is present.
  "confirmed",
  // The provider proves the intended action did not take effect.
  "failed",
  // The provider cannot currently determine whether the action took effect.
  "unknown",
  // Evidence conflicts with the request's operation identity or intent.
  "diverged",
]);
export type ExternalActionReconciliationOutcome = z.infer<
  typeof ExternalActionReconciliationOutcomeSchema
>;

/** The durable event identity sent to a Host-owned provider; raw Tool input is never included. */
export const ExternalActionReconciliationRequestSchema = z.object({
  project_id: IdentifierSchema,
  run_id: IdentifierSchema,
  action_id: IdentifierSchema,
  operation_id: IdentifierSchema,
  tool_name: ToolNameSchema,
  trigger: ExternalActionReconciliationTriggerSchema,
}).strict();
export type ExternalActionReconciliationRequest = z.infer<
  typeof ExternalActionReconciliationRequestSchema
>;

/** A provider classification. Positive and negative claims must carry an evidence digest. */
export const ExternalActionReconciliationDecisionSchema = z.object({
  operation_id: IdentifierSchema,
  outcome: ExternalActionReconciliationOutcomeSchema,
  reason_code: IdentifierSchema,
  summary: NonEmptyStringSchema.max(2_000),
  evidence_digest: Sha256Schema.optional(),
}).strict().superRefine((value, context) => {
  if (value.outcome !== "unknown" && value.evidence_digest === undefined) {
    context.addIssue({
      code: "custom",
      path: ["evidence_digest"],
      message: `${value.outcome} requires a provider evidence digest`,
    });
  }
});
export type ExternalActionReconciliationDecision = z.infer<
  typeof ExternalActionReconciliationDecisionSchema
>;
