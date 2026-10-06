import { z } from "zod";
import { RelativePathSchema, IdentifierSchema, Sha256Schema } from "./common.js";

export const DeliveryGoalRequirementsSchema=z.object({goal_id:IdentifierSchema,approved_proposal_revision:z.number().int().positive(),objective:z.string().min(1).max(8_000),done_conditions:z.array(z.string().min(1).max(1_000)).min(1).max(32)}).strict();
export type DeliveryGoalRequirements=z.infer<typeof DeliveryGoalRequirementsSchema>;
/** Scoped readonly evidence, not a new executable plan or privilege grant. */
export const DeliveryReviewPacketSchema=z.object({
  schema_version:z.literal("outlive.delivery-requirements.v1"),complete:z.literal(true),
  project_id:IdentifierSchema,parent_run_id:IdentifierSchema,source_event_id:IdentifierSchema,source_event_hash:Sha256Schema,
  initial_task:z.string().min(1).max(8_000),
  initial_context:z.array(z.object({role:z.enum(["user","assistant"]),content:z.string().min(1).max(8_000)}).strict()).max(160),
  consumed_guidance:z.array(z.object({input_id:IdentifierSchema,queued_event_id:IdentifierSchema,consumed_event_id:IdentifierSchema,body:z.string().max(8_000)}).strict()).max(1_000),
  approved_goal:DeliveryGoalRequirementsSchema.optional(),
  verification_receipts:z.array(z.object({event_id:IdentifierSchema,event_hash:Sha256Schema,tool_name:z.enum(["run_test","run_project_command"]),status:z.enum(["tool.completed","tool.failed","tool.unknown"]),code:z.string(),path:z.string().optional(),command:z.string().optional(),artifact_refs:z.array(z.object({locator:z.string(),content_hash:Sha256Schema}).strict()).max(32)}).strict()).max(1_000),
}).strict();
export type DeliveryReviewPacket=z.infer<typeof DeliveryReviewPacketSchema>;

/** A model report is untrusted until Runtime binds it to a real readonly child. */
export const DeliveryReviewResultSchema = z.object({
  verdict: z.enum(["passed", "blocked", "inconclusive"]),
  reviewed_paths: z.array(RelativePathSchema).min(1).max(32)
    .refine(paths => new Set(paths).size === paths.length, "Reviewed paths must be distinct"),
  findings: z.array(z.object({
    severity: z.enum(["blocking", "warning"]),
    path: RelativePathSchema,
    line: z.number().int().positive().max(1_000_000).optional(),
    summary: z.string().trim().min(1).max(1_000),
  }).strict()).max(20),
}).strict().superRefine((value, context) => {
  if (value.verdict === "passed" && value.findings.some(finding => finding.severity === "blocking")) {
    context.addIssue({code: "custom", message: "Passing review cannot contain blocking findings"});
  }
  if (value.verdict === "blocked" && !value.findings.some(finding => finding.severity === "blocking")) {
    context.addIssue({code: "custom", message: "Blocked review requires a concrete blocking finding"});
  }
  if (value.findings.some(finding => !value.reviewed_paths.includes(finding.path))) {
    context.addIssue({code: "custom", message: "Findings must refer to reviewed paths"});
  }
});
export type DeliveryReviewResult = z.infer<typeof DeliveryReviewResultSchema>;
