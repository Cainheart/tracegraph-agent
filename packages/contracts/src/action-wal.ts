import { z } from "zod";
import {
  IdentifierSchema,
  IsoDateTimeSchema,
  RelativePathSchema,
  Sha256Schema,
} from "./common.js";
import { WorkspaceKindSchema } from "./workspace.js";

export const ACTION_WAL_FORMAT_VERSION = 1 as const;
export const RECOVERY_LEDGER_FORMAT_VERSION = 1 as const;

export const ActionWalPhaseSchema = z.enum([
  "prepare",
  "applied",
  "committed",
  "verified",
  "aborted",
]);
export type ActionWalPhase = z.infer<typeof ActionWalPhaseSchema>;

/**
 * A before image is kept outside the public ArtifactStore because rollback
 * needs the exact bytes, not a redacted rendering. `backup_ref` is opaque and
 * is deliberately absent for a path that did not exist before the action.
 */
export const ActionWalTargetSchema = z.object({
  target_path: RelativePathSchema,
  existed: z.boolean(),
  before_hash: Sha256Schema,
  after_hash: Sha256Schema,
  backup_ref: IdentifierSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.existed && value.backup_ref === undefined) {
    context.addIssue({
      code: "custom",
      path: ["backup_ref"],
      message: "an existing target requires an exact before-image backup",
    });
  }
  if (!value.existed && value.backup_ref !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["backup_ref"],
      message: "a previously absent target must not reference backup bytes",
    });
  }
});
export type ActionWalTarget = z.infer<typeof ActionWalTargetSchema>;

const ActionWalIdentityShape = {
  project_id: IdentifierSchema,
  run_id: IdentifierSchema,
  action_id: IdentifierSchema,
  workspace_handle_id: IdentifierSchema,
  // Handles are process-local and may change after restart. This stable digest
  // binds reconciliation/rollback to the same canonical workspace root without
  // persisting the user's absolute local path.
  workspace_root_hash: Sha256Schema,
  workspace_kind: WorkspaceKindSchema,
  patch_hash: Sha256Schema,
  targets: z.array(ActionWalTargetSchema).min(1).max(128),
};

function uniqueTargets(
  value: { targets: Array<{ target_path: string }> },
  context: z.core.$RefinementCtx,
): void {
  const paths = new Set<string>();
  for (let index = 0; index < value.targets.length; index += 1) {
    const path = value.targets[index]!.target_path;
    if (paths.has(path)) {
      context.addIssue({
        code: "custom",
        path: ["targets", index, "target_path"],
        message: "target paths must be unique within an action",
      });
    }
    paths.add(path);
  }
}

export const ActionWalPrepareSchema = z.object({
  ...ActionWalIdentityShape,
}).strict().superRefine((value, context) => {
  uniqueTargets(value, context);
  if (value.workspace_kind === "readonly_local") {
    context.addIssue({
      code: "custom",
      path: ["workspace_kind"],
      message: "a read-only workspace cannot have a mutating Action WAL entry",
    });
  }
  if (value.targets.length === 1 && value.targets[0]!.after_hash !== value.patch_hash) {
    context.addIssue({
      code: "custom",
      path: ["patch_hash"],
      message: "a single-target patch hash must equal the target after hash",
    });
  }
});
export type ActionWalPrepare = z.infer<typeof ActionWalPrepareSchema>;

export const ActionWalRecordSchema = z.object({
  wal_version: z.literal(ACTION_WAL_FORMAT_VERSION),
  // Per-record identity. The stable transaction key is (run_id, action_id);
  // previous_wal_id links successive records, including interleaved actions.
  wal_id: IdentifierSchema,
  sequence: z.number().int().positive(),
  ...ActionWalIdentityShape,
  phase: ActionWalPhaseSchema,
  recorded_at: IsoDateTimeSchema,
  previous_wal_id: IdentifierSchema.optional(),
  previous_record_hash: Sha256Schema.optional(),
  event_id: IdentifierSchema.optional(),
  receipt_id: IdentifierSchema.optional(),
  recovered: z.boolean().default(false),
  reason: z.string().trim().min(1).max(2_000).optional(),
  record_hash: Sha256Schema,
}).strict().superRefine((value, context) => {
  uniqueTargets(value, context);
  if (value.workspace_kind === "readonly_local") {
    context.addIssue({
      code: "custom",
      path: ["workspace_kind"],
      message: "a read-only workspace cannot have a mutating Action WAL entry",
    });
  }
  if (value.targets.length === 1 && value.targets[0]!.after_hash !== value.patch_hash) {
    context.addIssue({
      code: "custom",
      path: ["patch_hash"],
      message: "a single-target patch hash must equal the target after hash",
    });
  }
  if (value.phase === "committed") {
    if (value.event_id === undefined) {
      context.addIssue({
        code: "custom",
        path: ["event_id"],
        message: "committed requires its durable patch event id",
      });
    }
    if (value.receipt_id === undefined) {
      context.addIssue({
        code: "custom",
        path: ["receipt_id"],
        message: "committed requires its durable receipt id",
      });
    }
  }
  if (value.phase === "verified" && value.event_id === undefined) {
    context.addIssue({
      code: "custom",
      path: ["event_id"],
      message: "verified requires its durable verification event id",
    });
  }
  if (value.phase === "aborted" && value.reason === undefined) {
    context.addIssue({
      code: "custom",
      path: ["reason"],
      message: "aborted requires a reason",
    });
  }
});
export type ActionWalRecord = z.infer<typeof ActionWalRecordSchema>;

export const RecoveryRecipeIdSchema = z.enum([
  "replay_missing_event",
  "restore_from_backup",
  "mark_diverged",
]);
export type RecoveryRecipeId = z.infer<typeof RecoveryRecipeIdSchema>;

export const RecoveryAttemptStateSchema = z.enum([
  "started",
  "succeeded",
  "failed",
  "escalated",
]);
export type RecoveryAttemptState = z.infer<typeof RecoveryAttemptStateSchema>;

/**
 * Recovery is append-only too: a started row and its terminal row share the
 * same `recovery_id` and `attempt`. Readers materialize the latest row.
 */
export const RecoveryAttemptRecordSchema = z.object({
  recovery_version: z.literal(RECOVERY_LEDGER_FORMAT_VERSION),
  record_id: IdentifierSchema,
  recovery_id: IdentifierSchema,
  sequence: z.number().int().positive(),
  project_id: IdentifierSchema,
  run_id: IdentifierSchema,
  action_id: IdentifierSchema,
  recipe_id: RecoveryRecipeIdSchema,
  attempt: z.number().int().positive(),
  automatic: z.boolean(),
  state: RecoveryAttemptStateSchema,
  started_at: IsoDateTimeSchema,
  recorded_at: IsoDateTimeSchema,
  finished_at: IsoDateTimeSchema.optional(),
  last_failure: z.string().trim().min(1).max(2_000).optional(),
  escalation_reason: z.string().trim().min(1).max(2_000).optional(),
  previous_record_hash: Sha256Schema.optional(),
  record_hash: Sha256Schema,
}).strict().superRefine((value, context) => {
  if (value.state === "started" && value.finished_at !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["finished_at"],
      message: "a started attempt cannot have finished_at",
    });
  }
  if (
    (value.state === "started" || value.state === "succeeded")
    && value.last_failure !== undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["last_failure"],
      message: `${value.state} cannot carry last_failure`,
    });
  }
  if (value.state !== "escalated" && value.escalation_reason !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["escalation_reason"],
      message: "only an escalated attempt can carry escalation_reason",
    });
  }
  if (value.state !== "started" && value.finished_at === undefined) {
    context.addIssue({
      code: "custom",
      path: ["finished_at"],
      message: "a terminal attempt requires finished_at",
    });
  }
  if (value.state === "failed" && value.last_failure === undefined) {
    context.addIssue({
      code: "custom",
      path: ["last_failure"],
      message: "a failed attempt requires last_failure",
    });
  }
  if (value.state === "escalated" && value.escalation_reason === undefined) {
    context.addIssue({
      code: "custom",
      path: ["escalation_reason"],
      message: "an escalated attempt requires escalation_reason",
    });
  }
  if (
    value.finished_at !== undefined
    && Date.parse(value.finished_at) < Date.parse(value.started_at)
  ) {
    context.addIssue({
      code: "custom",
      path: ["finished_at"],
      message: "finished_at cannot precede started_at",
    });
  }
});
export type RecoveryAttemptRecord = z.infer<typeof RecoveryAttemptRecordSchema>;

export const RecoveryAttemptStartSchema = z.object({
  project_id: IdentifierSchema,
  run_id: IdentifierSchema,
  action_id: IdentifierSchema,
  recipe_id: RecoveryRecipeIdSchema,
  automatic: z.boolean().default(true),
}).strict();
export type RecoveryAttemptStart = z.infer<typeof RecoveryAttemptStartSchema>;

export const RecoveryAttemptFinishSchema = z.object({
  recovery_id: IdentifierSchema,
  state: z.enum(["succeeded", "failed", "escalated"]),
  last_failure: z.string().trim().min(1).max(2_000).optional(),
  escalation_reason: z.string().trim().min(1).max(2_000).optional(),
}).strict().superRefine((value, context) => {
  if (value.state === "failed" && value.last_failure === undefined) {
    context.addIssue({
      code: "custom",
      path: ["last_failure"],
      message: "a failed attempt requires last_failure",
    });
  }
  if (value.state === "escalated" && value.escalation_reason === undefined) {
    context.addIssue({
      code: "custom",
      path: ["escalation_reason"],
      message: "an escalated attempt requires escalation_reason",
    });
  }
  if (value.state === "succeeded" && value.last_failure !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["last_failure"],
      message: "succeeded cannot carry last_failure",
    });
  }
  if (value.state !== "escalated" && value.escalation_reason !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["escalation_reason"],
      message: "only escalated can carry escalation_reason",
    });
  }
});
export type RecoveryAttemptFinish = z.infer<typeof RecoveryAttemptFinishSchema>;

// A small safe default. Higher-level recovery policy may choose to require
// manual review even earlier, but cannot silently retry forever.
export const DEFAULT_MAX_AUTOMATIC_RECOVERY_ATTEMPTS = 1 as const;
