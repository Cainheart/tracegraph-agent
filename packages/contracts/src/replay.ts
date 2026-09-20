import { z } from "zod";
import {
  ArtifactRefSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  Sha256Schema,
} from "./common.js";
import {
  PendingApprovalSchema,
  PendingPlanSchema,
  RunProjectionSchema,
  RunStatusSchema,
} from "./projection.js";
import { RunModeSchema } from "./commands.js";
import { TodoItemSchema } from "./todo.js";
import { WireSessionEventSchema } from "./event.js";

export const REPLAY_SNAPSHOT_VERSION = "tracegraph.replay-snapshot.v1" as const;
export const REPLAY_DIFF_VERSION = "tracegraph.replay-diff.v1" as const;

const ReplaySequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const ReplayQuerySequenceSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** A sequence is Run-scoped, so session_id alone is deliberately insufficient. */
export const ReplaySnapshotRequestSchema = z.object({
  session_id: IdentifierSchema,
  run_id: IdentifierSchema,
  until_sequence: ReplaySequenceSchema,
}).strict();
export type ReplaySnapshotRequest = z.infer<typeof ReplaySnapshotRequestSchema>;

/**
 * Canonical, deterministic replay result. head_sequence is observation metadata
 * and is intentionally excluded from the snapshot_hash preimage by core.
 */
export const ReplaySnapshotSchema = z.object({
  schema_version: z.literal(REPLAY_SNAPSHOT_VERSION),
  session_id: IdentifierSchema,
  project_id: IdentifierSchema,
  run_id: IdentifierSchema,
  until_sequence: ReplaySequenceSchema,
  head_sequence: ReplaySequenceSchema,
  anchor_event_id: IdentifierSchema,
  anchor_event_hash: Sha256Schema,
  projection: RunProjectionSchema,
  snapshot_hash: Sha256Schema,
}).strict().superRefine((value, context) => {
  if (value.until_sequence > value.head_sequence) {
    context.addIssue({
      code: "custom",
      path: ["until_sequence"],
      message: "until_sequence cannot exceed head_sequence",
    });
  }
  if (value.projection.session_id !== value.session_id) {
    context.addIssue({
      code: "custom",
      path: ["projection", "session_id"],
      message: "projection session_id must match replay session_id",
    });
  }
  if (value.projection.project_id !== value.project_id) {
    context.addIssue({
      code: "custom",
      path: ["projection", "project_id"],
      message: "projection project_id must match replay project_id",
    });
  }
  if (value.projection.run_id !== value.run_id) {
    context.addIssue({
      code: "custom",
      path: ["projection", "run_id"],
      message: "projection run_id must match replay run_id",
    });
  }
  if (value.projection.last_sequence !== value.until_sequence) {
    context.addIssue({
      code: "custom",
      path: ["projection", "last_sequence"],
      message: "projection last_sequence must equal until_sequence",
    });
  }
  if (value.projection.todos.last_sequence !== value.until_sequence) {
    context.addIssue({
      code: "custom",
      path: ["projection", "todos", "last_sequence"],
      message: "Todo projection must cover the same replay prefix",
    });
  }
  if (value.projection.timeline.length !== value.until_sequence) {
    context.addIssue({
      code: "custom",
      path: ["projection", "timeline"],
      message: "replay timeline must contain every sequence from one through until_sequence",
    });
  }
  value.projection.timeline.forEach((event, index) => {
    if (event.sequence !== index + 1) {
      context.addIssue({
        code: "custom",
        path: ["projection", "timeline", index, "sequence"],
        message: "replay timeline sequence must be contiguous and one-based",
      });
    }
    if (
      event.session_id !== value.session_id
      || event.project_id !== value.project_id
      || event.run_id !== value.run_id
    ) {
      context.addIssue({
        code: "custom",
        path: ["projection", "timeline", index],
        message: "replay timeline event is outside the snapshot scope",
      });
    }
  });
  const anchor = value.projection.timeline.at(-1);
  if (anchor?.event_id !== value.anchor_event_id) {
    context.addIssue({
      code: "custom",
      path: ["anchor_event_id"],
      message: "anchor_event_id must identify the replay prefix tail",
    });
  }
  value.projection.artifact_refs.forEach((artifact, index) => {
    if (artifact.project_id !== value.project_id || artifact.run_id !== value.run_id) {
      context.addIssue({
        code: "custom",
        path: ["projection", "artifact_refs", index],
        message: "replay Artifact is outside the snapshot scope",
      });
    }
  });
});
export type ReplaySnapshot = z.infer<typeof ReplaySnapshotSchema>;

/** Host authority is deliberately outside the canonical snapshot and its hash. */
export const ReplaySessionResponseSchema = z.object({
  replay_id: IdentifierSchema,
  replay_token: z.string().min(32).max(512),
  expires_at: IsoDateTimeSchema,
  snapshot: ReplaySnapshotSchema,
}).strict();
export type ReplaySessionResponse = z.infer<typeof ReplaySessionResponseSchema>;

export const ReplayDiffQuerySchema = z.object({
  session_id: IdentifierSchema,
  run_id: IdentifierSchema,
  from: ReplayQuerySequenceSchema,
  to: ReplayQuerySequenceSchema,
}).strict();
export type ReplayDiffQuery = z.infer<typeof ReplayDiffQuerySchema>;

const ReplayEventSetDiffSchema = z.object({
  added: z.array(WireSessionEventSchema),
  removed: z.array(WireSessionEventSchema),
}).strict();

const ReplayArtifactChangeSchema = z.object({
  artifact_id: IdentifierSchema,
  before: ArtifactRefSchema,
  after: ArtifactRefSchema,
}).strict();

const ReplayEvidenceDiffSchema = z.object({
  added: z.array(ArtifactRefSchema),
  removed: z.array(ArtifactRefSchema),
  changed: z.array(ReplayArtifactChangeSchema),
}).strict();

const ReplayTodoChangeSchema = z.object({
  todo_id: IdentifierSchema,
  before: TodoItemSchema,
  after: TodoItemSchema,
}).strict();

const ReplayTodoDiffSchema = z.object({
  added: z.array(TodoItemSchema),
  removed: z.array(TodoItemSchema),
  changed: z.array(ReplayTodoChangeSchema),
}).strict();

const ReplayApprovalDiffSchema = z.object({
  changed: z.boolean(),
  before: PendingApprovalSchema.optional(),
  after: PendingApprovalSchema.optional(),
}).strict();

const ReplayPendingPlanDiffSchema = z.object({
  changed: z.boolean(),
  before: PendingPlanSchema.optional(),
  after: PendingPlanSchema.optional(),
}).strict();

const ReplayRunStatusChangeSchema = z.object({
  before: RunStatusSchema,
  after: RunStatusSchema,
}).strict();

const ReplayRunModeChangeSchema = z.object({
  before: RunModeSchema,
  after: RunModeSchema,
}).strict();

export const ReplayDiffSchema = z.object({
  schema_version: z.literal(REPLAY_DIFF_VERSION),
  session_id: IdentifierSchema,
  project_id: IdentifierSchema,
  run_id: IdentifierSchema,
  head_sequence: ReplaySequenceSchema,
  from_sequence: ReplaySequenceSchema,
  to_sequence: ReplaySequenceSchema,
  direction: z.enum(["forward", "backward", "same"]),
  from_snapshot_hash: Sha256Schema,
  to_snapshot_hash: Sha256Schema,
  events: ReplayEventSetDiffSchema,
  evidence: ReplayEvidenceDiffSchema,
  tool_results: ReplayEventSetDiffSchema,
  todos: ReplayTodoDiffSchema,
  approval: ReplayApprovalDiffSchema,
  pending_plan: ReplayPendingPlanDiffSchema,
  status: ReplayRunStatusChangeSchema.optional(),
  mode: ReplayRunModeChangeSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.from_sequence > value.head_sequence || value.to_sequence > value.head_sequence) {
    context.addIssue({
      code: "custom",
      path: ["head_sequence"],
      message: "diff endpoints cannot exceed head_sequence",
    });
  }
  const expectedDirection = value.from_sequence === value.to_sequence
    ? "same"
    : value.from_sequence < value.to_sequence
      ? "forward"
      : "backward";
  if (value.direction !== expectedDirection) {
    context.addIssue({
      code: "custom",
      path: ["direction"],
      message: "diff direction must match from_sequence and to_sequence",
    });
  }
});
export type ReplayDiff = z.infer<typeof ReplayDiffSchema>;
