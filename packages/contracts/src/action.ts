import { z } from "zod";
import {
  ArtifactRefSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  RelativePathSchema,
  Sha256Schema,
  SourceRefSchema,
  ToolNameSchema,
  type ToolName,
} from "./common.js";

export { ToolNameSchema, type ToolName } from "./common.js";

export const BUILTIN_TOOL_NAMES = [
  "read_file",
  "list_dir",
  "search",
  "read_artifact",
  "list_artifacts",
  "preview_patch",
  "commit_patch",
  "run_test",
  "todo_read",
  "todo_write",
  "spawn_subagent",
  "send_subagent_message",
  "list_subagents",
  "interrupt_subagent",
  "team_read",
  "team_task_write",
  "team_mailbox_send",
  "team_mailbox_claim",
  "team_heartbeat",
  "load_skill",
] as const satisfies readonly ToolName[];
export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

export const MAX_TOOL_CALLS_PER_DECISION = 16;

export const ToolCallSchema = z.object({
  action_id: IdentifierSchema,
  tool_name: ToolNameSchema,
  arguments: z.record(z.string(), z.unknown()),
}).strict();
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const DecisionSchema = z.object({
  decision_id: IdentifierSchema,
  kind: z.enum(["tool_call", "finish"]),
  public_reason: NonEmptyStringSchema.max(2_000),
  evidence_refs: z.array(SourceRefSchema).default([]),
  risk: z.enum(["none", "low", "medium", "high"]),
  expected_effect: z.string().max(1_000).optional(),
  tool_call: ToolCallSchema.optional(),
  tool_calls: z.array(ToolCallSchema).min(1).max(MAX_TOOL_CALLS_PER_DECISION).optional(),
  final_answer: z.string().max(8_000).optional(),
}).superRefine((value, context) => {
  if (value.kind === "tool_call") {
    const hasSingleCall = value.tool_call !== undefined;
    const hasBatch = value.tool_calls !== undefined;
    if (hasSingleCall === hasBatch) {
      context.addIssue({
        code: "custom",
        path: hasSingleCall ? ["tool_calls"] : ["tool_call"],
        message: "tool_call decisions require exactly one of tool_call or tool_calls",
      });
    }
    if (value.final_answer !== undefined) {
      context.addIssue({ code: "custom", path: ["final_answer"], message: "tool_call decisions cannot include final_answer" });
    }
    if (value.tool_calls !== undefined) {
      const actionIds = value.tool_calls.map(({ action_id: actionId }) => actionId);
      if (new Set(actionIds).size !== actionIds.length) {
        context.addIssue({ code: "custom", path: ["tool_calls"], message: "tool_calls action_id values must be unique" });
      }
    }
  }
  if (value.kind === "finish") {
    if (value.final_answer === undefined) {
      context.addIssue({ code: "custom", path: ["final_answer"], message: "final_answer is required" });
    }
    if (value.tool_call !== undefined) {
      context.addIssue({ code: "custom", path: ["tool_call"], message: "finish decisions cannot include tool_call" });
    }
    if (value.tool_calls !== undefined) {
      context.addIssue({ code: "custom", path: ["tool_calls"], message: "finish decisions cannot include tool_calls" });
    }
  }
});
export type Decision = z.infer<typeof DecisionSchema>;

export const ValidatedActionSchema = z.object({
  action_id: IdentifierSchema,
  tool_name: ToolNameSchema,
  arguments: z.record(z.string(), z.unknown()),
  project_id: IdentifierSchema,
  run_id: IdentifierSchema,
  workspace_handle_id: IdentifierSchema,
  validated_at: IsoDateTimeSchema,
  approval_id: IdentifierSchema.optional(),
  approval_token_id: IdentifierSchema.optional(),
  action_digest: Sha256Schema.optional(),
  policy_digest: Sha256Schema.optional(),
});
export type ValidatedAction = z.infer<typeof ValidatedActionSchema>;

/** New approval-bound writes must carry every binding; optional fields above only read legacy records. */
export const ApprovalBoundValidatedActionSchema = ValidatedActionSchema.extend({
  approval_id: IdentifierSchema,
  approval_token_id: IdentifierSchema,
  action_digest: Sha256Schema,
  policy_digest: Sha256Schema,
}).strict();
export type ApprovalBoundValidatedAction = z.infer<typeof ApprovalBoundValidatedActionSchema>;

export const PatchPreviewSchema = z.object({
  preview_id: IdentifierSchema,
  action_id: IdentifierSchema,
  path: RelativePathSchema,
  diff: NonEmptyStringSchema,
  base_hash: Sha256Schema,
  patch_hash: Sha256Schema,
  scope: z.array(RelativePathSchema).min(1),
  expires_at: IsoDateTimeSchema,
  artifact_ref: ArtifactRefSchema.optional(),
});
export type PatchPreview = z.infer<typeof PatchPreviewSchema>;

export const ApprovalGrantSchema = z.object({
  approval_id: IdentifierSchema,
  action_id: IdentifierSchema,
  base_hash: Sha256Schema,
  patch_hash: Sha256Schema,
  scope: z.array(RelativePathSchema).min(1),
  expires_at: IsoDateTimeSchema,
  granted_at: IsoDateTimeSchema,
  consumed_at: IsoDateTimeSchema.optional(),
  token_id: IdentifierSchema.optional(),
  action_digest: Sha256Schema.optional(),
  policy_digest: Sha256Schema.optional(),
  outcome: z.literal("allowed-once").optional(),
  single_use: z.literal(true).optional(),
});
export type ApprovalGrant = z.infer<typeof ApprovalGrantSchema>;

const BoundApprovalScopeSchema = z.array(RelativePathSchema).min(1).max(64).superRefine((scope, context) => {
  if (new Set(scope).size !== scope.length) {
    context.addIssue({ code: "custom", message: "approval scope entries must be unique" });
  }
});

export const ApprovalBoundGrantSchema = z.object({
  approval_id: IdentifierSchema,
  action_id: IdentifierSchema,
  token_id: IdentifierSchema,
  action_digest: Sha256Schema,
  policy_digest: Sha256Schema,
  base_hash: Sha256Schema,
  patch_hash: Sha256Schema,
  scope: BoundApprovalScopeSchema,
  expires_at: IsoDateTimeSchema,
  granted_at: IsoDateTimeSchema,
  consumed_at: IsoDateTimeSchema,
  outcome: z.literal("allowed-once"),
  single_use: z.literal(true),
}).strict().superRefine((value, context) => {
  const grantedAt = Date.parse(value.granted_at);
  const consumedAt = Date.parse(value.consumed_at);
  const expiresAt = Date.parse(value.expires_at);
  if (consumedAt < grantedAt) {
    context.addIssue({ code: "custom", path: ["consumed_at"], message: "approval cannot be consumed before it is granted" });
  }
  if (consumedAt > expiresAt) {
    context.addIssue({ code: "custom", path: ["consumed_at"], message: "approval cannot be consumed after it expires" });
  }
});
export type ApprovalBoundGrant = z.infer<typeof ApprovalBoundGrantSchema>;

export const ReceiptStatusSchema = z.enum(["success", "failure", "unknown"]);
export type ReceiptStatus = z.infer<typeof ReceiptStatusSchema>;

export const ReceiptSchema = z.object({
  receipt_id: IdentifierSchema,
  action_id: IdentifierSchema,
  tool_name: ToolNameSchema,
  status: ReceiptStatusSchema,
  transport_status: z.enum(["success", "failure", "unknown"]),
  business_status: ReceiptStatusSchema,
  code: NonEmptyStringSchema,
  summary: NonEmptyStringSchema.max(2_000),
  started_at: IsoDateTimeSchema,
  completed_at: IsoDateTimeSchema,
  duration_ms: z.number().int().nonnegative(),
  artifact_refs: z.array(ArtifactRefSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type Receipt = z.infer<typeof ReceiptSchema>;

export const ObservationSchema = z.object({
  observation_id: IdentifierSchema,
  action_id: IdentifierSchema,
  receipt_id: IdentifierSchema,
  status: ReceiptStatusSchema,
  summary: NonEmptyStringSchema.max(4_000),
  facts: z.record(z.string(), z.unknown()).default({}),
  artifact_refs: z.array(ArtifactRefSchema).default([]),
  created_at: IsoDateTimeSchema,
});
export type Observation = z.infer<typeof ObservationSchema>;
