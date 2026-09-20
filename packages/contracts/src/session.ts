import { z } from "zod";
import { ToolCallSchema } from "./action.js";
import {
  ConversationMessageSchema,
  LegacyRunModeSchema,
  ReasoningEffortSchema,
  RunModeSchema,
} from "./commands.js";
import { IdentifierSchema, IsoDateTimeSchema, NonEmptyStringSchema } from "./common.js";
import { EffectivePermissionPolicySchema } from "./permission.js";
import { PendingApprovalSchema } from "./projection.js";
import { SubagentOrchestrationRecoverySchema } from "./subagent.js";
import { ExtensionRunSnapshotSchema } from "./extension.js";
import { SkillNameSchema } from "./skill.js";

/** Current on-disk JSONL session format. Older records are migrated by core. */
export const SESSION_FORMAT_VERSION = 1 as const;

export const SessionTitleSchema = NonEmptyStringSchema.max(200);

export const SessionHeaderSchema = z.object({
  kind: z.literal("header"),
  session_version: z.literal(SESSION_FORMAT_VERSION),
  session_id: IdentifierSchema,
  project_id: IdentifierSchema,
  created_at: IsoDateTimeSchema,
  title: SessionTitleSchema.optional(),
  parent_session_id: IdentifierSchema.optional(),
  run_ids: z.array(IdentifierSchema).max(10_000).default([]),
}).strict().superRefine((value, context) => {
  if (value.parent_session_id === value.session_id) {
    context.addIssue({
      code: "custom",
      path: ["parent_session_id"],
      message: "a Session cannot be its own parent",
    });
  }
});
export type SessionHeader = z.infer<typeof SessionHeaderSchema>;

/**
 * A session deliberately stores only a pointer to a canonical ledger event.
 * The strict schema prevents an event body or other unbounded payload from
 * becoming a second, divergent copy of ledger data.
 */
export const SessionEventReferenceSchema = z.object({
  kind: z.literal("event_ref"),
  session_version: z.literal(SESSION_FORMAT_VERSION),
  entry_id: IdentifierSchema,
  parent_entry_id: IdentifierSchema.optional(),
  created_at: IsoDateTimeSchema,
  event_ref: z.object({
    event_id: IdentifierSchema,
    run_id: IdentifierSchema,
    sequence: z.number().int().positive(),
  }).strict(),
}).strict();
export type SessionEventReference = z.infer<typeof SessionEventReferenceSchema>;

export const SessionRecordSchema = z.discriminatedUnion("kind", [
  SessionHeaderSchema,
  SessionEventReferenceSchema,
]);
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

export const SessionReadResultSchema = z.object({
  header: SessionHeaderSchema,
  entries: z.array(SessionEventReferenceSchema),
  truncated: z.boolean(),
}).strict();
export type SessionReadResult = z.infer<typeof SessionReadResultSchema>;

export const SessionSummarySchema = z.object({
  session_id: IdentifierSchema,
  project_id: IdentifierSchema,
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
  title: SessionTitleSchema.optional(),
  parent_session_id: IdentifierSchema.optional(),
  run_ids: z.array(IdentifierSchema),
  entry_count: z.number().int().nonnegative(),
}).strict();
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const SessionListQuerySchema = z.object({
  project_id: IdentifierSchema.optional(),
  q: z.string().trim().min(1).max(200).optional(),
  // Ordinary history is root-only so delegated child Sessions do not become
  // top-level conversation entries. Internal inspectors may opt in to all.
  view: z.enum(["roots", "all"]).default("roots"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/u, "invalid session cursor").optional(),
}).strict();
export type SessionListQuery = z.infer<typeof SessionListQuerySchema>;

export const SessionListResponseSchema = z.object({
  sessions: z.array(SessionSummarySchema),
  next_cursor: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/u).optional(),
}).strict();
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;

export const SessionRenameRequestSchema = z.object({
  title: SessionTitleSchema,
}).strict();
export type SessionRenameRequest = z.infer<typeof SessionRenameRequestSchema>;

export const SessionDeleteResponseSchema = z.object({
  session_id: IdentifierSchema,
  deleted: z.literal(true),
}).strict();
export type SessionDeleteResponse = z.infer<typeof SessionDeleteResponseSchema>;

export const SessionResumeRequestSchema = z.object({
  command_id: IdentifierSchema,
}).strict();
export type SessionResumeRequest = z.infer<typeof SessionResumeRequestSchema>;

export const SessionResumeResponseSchema = z.object({
  session_id: IdentifierSchema,
  project_id: IdentifierSchema,
  run_id: IdentifierSchema,
  status: z.enum(["resumed", "awaiting_approval", "awaiting_plan_approval"]),
  resumed_at: IsoDateTimeSchema,
}).strict();
export type SessionResumeResponse = z.infer<typeof SessionResumeResponseSchema>;

export const SessionRecoveryReportSchema = z.object({
  scanned_sessions: z.number().int().nonnegative(),
  truncated_session_ids: z.array(IdentifierSchema),
  interrupted_run_ids: z.array(IdentifierSchema),
  reconciled_action_ids: z.array(IdentifierSchema).default([]),
  aborted_action_ids: z.array(IdentifierSchema).default([]),
  diverged_action_ids: z.array(IdentifierSchema).default([]),
  recovered_at: IsoDateTimeSchema,
}).strict();
export type SessionRecoveryReport = z.infer<typeof SessionRecoveryReportSchema>;

/** Minimal replay seed kept as a redacted Artifact, never in the session JSONL. */
export const LegacyRunRecoveryStateSchema = z.object({
  version: z.literal(1),
  kind: z.literal("run_recovery_state"),
  task: NonEmptyStringSchema.max(8_000),
  conversation_history: z.array(ConversationMessageSchema).max(160),
  mode: LegacyRunModeSchema,
  reasoning_effort: ReasoningEffortSchema,
}).strict();
export type LegacyRunRecoveryState = z.infer<typeof LegacyRunRecoveryStateSchema>;

export const BoundRunRecoveryStateSchema = z.object({
  version: z.literal(2),
  kind: z.literal("run_recovery_state"),
  task: NonEmptyStringSchema.max(8_000),
  conversation_history: z.array(ConversationMessageSchema).max(160),
  mode: LegacyRunModeSchema,
  reasoning_effort: ReasoningEffortSchema,
  effective_policy: EffectivePermissionPolicySchema,
}).strict();
export type BoundRunRecoveryState = z.infer<typeof BoundRunRecoveryStateSchema>;

/** Current recovery seed. Todo state remains canonical in the Event ledger. */
export const CurrentRunRecoveryStateSchema = z.object({
  version: z.literal(3),
  kind: z.literal("run_recovery_state"),
  task: NonEmptyStringSchema.max(8_000),
  conversation_history: z.array(ConversationMessageSchema).max(160),
  mode: RunModeSchema,
  reasoning_effort: ReasoningEffortSchema,
  effective_policy: EffectivePermissionPolicySchema,
}).strict();
export type CurrentRunRecoveryState = z.infer<typeof CurrentRunRecoveryStateSchema>;

/**
 * G-07 recovery seed. The private Artifact freezes root/child depth, effective
 * orchestration limits and (for a child) the exact parent delegation.
 */
export const CurrentRunRecoveryStateV4Schema = z.object({
  version: z.literal(4),
  kind: z.literal("run_recovery_state"),
  task: NonEmptyStringSchema.max(8_000),
  conversation_history: z.array(ConversationMessageSchema).max(160),
  mode: RunModeSchema,
  reasoning_effort: ReasoningEffortSchema,
  effective_policy: EffectivePermissionPolicySchema,
  orchestration: SubagentOrchestrationRecoverySchema,
}).strict();
export type CurrentRunRecoveryStateV4 = z.infer<typeof CurrentRunRecoveryStateV4Schema>;

/** G-17 freezes the extension generation and exact tool surface for recovery. */
export const CurrentRunRecoveryStateV5Schema = z.object({
  version: z.literal(5),
  kind: z.literal("run_recovery_state"),
  task: NonEmptyStringSchema.max(8_000),
  conversation_history: z.array(ConversationMessageSchema).max(160),
  mode: RunModeSchema,
  reasoning_effort: ReasoningEffortSchema,
  effective_policy: EffectivePermissionPolicySchema,
  orchestration: SubagentOrchestrationRecoverySchema,
  extensions: ExtensionRunSnapshotSchema,
  skills: z.object({
    registry_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    loaded_skill: SkillNameSchema.optional(),
    active_tool_names: z.array(IdentifierSchema).max(256).default([]),
  }).strict().optional(),
}).strict();
export type CurrentRunRecoveryStateV5 = z.infer<typeof CurrentRunRecoveryStateV5Schema>;

export const RunRecoveryStateSchema = z.discriminatedUnion("version", [
  LegacyRunRecoveryStateSchema,
  BoundRunRecoveryStateSchema,
  CurrentRunRecoveryStateSchema,
  CurrentRunRecoveryStateV4Schema,
  CurrentRunRecoveryStateV5Schema,
]);
export type RunRecoveryState = z.infer<typeof RunRecoveryStateSchema>;

/** Recoverable approval state references canonical action contracts. */
export const SessionPendingPatchRecoveryStateSchema = z.object({
  version: z.literal(1),
  kind: z.literal("pending_patch_recovery_state"),
  pending_approval: PendingApprovalSchema,
  preview_call: ToolCallSchema,
}).strict();
export type SessionPendingPatchRecoveryState = z.infer<typeof SessionPendingPatchRecoveryStateSchema>;
