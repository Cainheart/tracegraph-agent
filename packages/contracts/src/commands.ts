import { z } from "zod";
import { IdentifierSchema, NonEmptyStringSchema } from "./common.js";
import { AttachmentUploadIdsSchema } from "./attachment.js";
import { SubmitUserInputCommandSchema } from "./steering.js";
import { WorkspaceHandleSchema } from "./workspace.js";

export const RunModeSchema = z.enum(["plan", "execute"]);
export type RunMode = z.infer<typeof RunModeSchema>;

/** Historical ledgers used `manual` for the current `execute` mode. */
export const LegacyRunModeSchema = z.enum(["plan", "manual"]);
export type LegacyRunMode = z.infer<typeof LegacyRunModeSchema>;

// `default` deliberately means "let the selected provider/model use its own
// default". It is not rewritten to a provider-specific off/none value because
// some reasoning models reject those values. The runtime records both the
// requested level and the level that was actually sent by the adapter.
export const ReasoningEffortSchema = z.enum([
  "default",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const ConversationMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: NonEmptyStringSchema.max(8_000),
});
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

export const OpenLocalProjectRequestSchema = z.object({
  command_id: IdentifierSchema,
  access: z.enum(["read_write", "read_only"]).default("read_write"),
}).strict();
export type OpenLocalProjectRequest = z.infer<typeof OpenLocalProjectRequestSchema>;

export const RevealProjectRequestSchema = z.object({
  command_id: IdentifierSchema,
}).strict();
export type RevealProjectRequest = z.infer<typeof RevealProjectRequestSchema>;

/** Host command for removing a previously selected local directory from the
 * persistent registration list. The request contains no filesystem path. */
export const RemoveProjectRequestSchema = z.object({
  command_id: IdentifierSchema,
}).strict();
export type RemoveProjectRequest = z.infer<typeof RemoveProjectRequestSchema>;

// Browser -> Host. The client can select a server-known project, but cannot
// construct or elevate the server-owned WorkspaceHandle capability.
export const StartRunRequestSchema = z.object({
  command_id: IdentifierSchema,
  session_id: IdentifierSchema.optional(),
  project_id: IdentifierSchema,
  task: NonEmptyStringSchema.max(8_000),
  mode: RunModeSchema,
  reasoning_effort: ReasoningEffortSchema.optional(),
  // The Context Manager, rather than an arbitrary UI slice, owns retention and
  // compaction. 160 bounded messages can exercise the 258K policy while still
  // placing a hard cap on a browser request.
  conversation_history: ConversationMessageSchema.array().max(160).optional(),
  /** Opaque, scope-bound staging receipts; raw attachment bytes never enter this JSON request. */
  attachment_upload_ids: AttachmentUploadIdsSchema.optional(),
}).strict();
export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;

// A plain conversation deliberately has no client-selected project, path, or
// execution mode. The Host binds it to a private empty workspace in execute
// mode; Workspace capabilities and policy still deny unavailable actions.
export const StartChatRequestSchema = StartRunRequestSchema.omit({
  project_id: true,
  mode: true,
}).strict();
export type StartChatRequest = z.infer<typeof StartChatRequestSchema>;

// Host -> Core only. Host resolves project_id to a fixed WorkspaceHandle.
export const StartRunInputSchema = z.object({
  command_id: IdentifierSchema,
  session_id: IdentifierSchema.optional(),
  project_id: IdentifierSchema,
  task: NonEmptyStringSchema.max(8_000),
  mode: RunModeSchema,
  reasoning_effort: ReasoningEffortSchema.optional(),
  conversation_history: ConversationMessageSchema.array().max(160).optional(),
  attachment_upload_ids: AttachmentUploadIdsSchema.optional(),
  workspace: WorkspaceHandleSchema,
});
export type StartRunInput = z.infer<typeof StartRunInputSchema>;

export const StartRunCommandSchema = z.object({
  type: z.literal("start_run"),
  command_id: IdentifierSchema,
  input: StartRunRequestSchema,
}).superRefine((value, context) => {
  if (value.command_id !== value.input.command_id) {
    context.addIssue({
      code: "custom",
      path: ["input", "command_id"],
      message: "nested command_id must match the command envelope",
    });
  }
});
export type StartRunCommand = z.infer<typeof StartRunCommandSchema>;

export const ApprovalCommandSchema = z.object({
  type: z.enum(["approve", "reject"]),
  command_id: IdentifierSchema,
  project_id: IdentifierSchema,
  run_id: IdentifierSchema,
  approval_id: IdentifierSchema,
  action_id: IdentifierSchema,
  reason: z.string().max(1_000).optional(),
});
export type ApprovalCommand = z.infer<typeof ApprovalCommandSchema>;

/** Browser -> Host body. The route binds project_id/run_id server-side. */
export const ApprovePlanRequestSchema = z.object({
  command_id: IdentifierSchema,
  /** Optimistic concurrency guard against approving a superseded plan. */
  plan_event_id: IdentifierSchema,
}).strict();
export type ApprovePlanRequest = z.infer<typeof ApprovePlanRequestSchema>;

/** Host -> Core command bound to one exact plan.ready revision. */
export const ApprovePlanCommandSchema = ApprovePlanRequestSchema.extend({
  type: z.literal("approve_plan"),
  project_id: IdentifierSchema,
  run_id: IdentifierSchema,
}).strict();
export type ApprovePlanCommand = z.infer<typeof ApprovePlanCommandSchema>;

export const StopRunCommandSchema = z.object({
  type: z.literal("stop"),
  command_id: IdentifierSchema,
  project_id: IdentifierSchema,
  run_id: IdentifierSchema,
  reason: z.string().max(1_000).optional(),
});
export type StopRunCommand = z.infer<typeof StopRunCommandSchema>;

/** Browser -> Host request for an explicit Action rollback. Project and Run
 * authority are deliberately absent: the Host resolves them from the
 * authenticated route and the canonical Run projection. */
export const RollbackActionRequestSchema = z.object({
  command_id: IdentifierSchema,
  force: z.boolean().default(false),
}).strict();
export type RollbackActionRequest = z.infer<typeof RollbackActionRequestSchema>;

/** Host -> Core command. Runtime still owns the disabled-by-default policy,
 * disposable-workspace rule, after-hash reconciliation, and refusal event. */
export const RollbackActionCommandSchema = z.object({
  type: z.literal("rollback_action"),
  command_id: IdentifierSchema,
  project_id: IdentifierSchema,
  run_id: IdentifierSchema,
  action_id: IdentifierSchema,
  force: z.boolean().default(false),
}).strict();
export type RollbackActionCommand = z.infer<typeof RollbackActionCommandSchema>;

/** Host -> Core input with the Host-owned filesystem capability required for
 * rollback after a process restart, when no process-local Run state remains. */
export const RollbackActionInputSchema = RollbackActionCommandSchema.extend({
  workspace: WorkspaceHandleSchema,
}).superRefine((value, context) => {
  if (value.project_id !== value.workspace.project_id) {
    context.addIssue({
      code: "custom",
      path: ["workspace", "project_id"],
      message: "workspace project_id must match rollback project_id",
    });
  }
});
export type RollbackActionInput = z.infer<typeof RollbackActionInputSchema>;

export const RunCommandSchema = z.discriminatedUnion("type", [
  StartRunCommandSchema,
  ApprovalCommandSchema,
  ApprovePlanCommandSchema,
  SubmitUserInputCommandSchema,
  StopRunCommandSchema,
  RollbackActionCommandSchema,
]);
export type RunCommand = z.infer<typeof RunCommandSchema>;
