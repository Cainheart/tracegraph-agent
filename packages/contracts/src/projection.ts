import { z } from "zod";
import { ArtifactRefSchema, IdentifierSchema, PROJECTOR_VERSION, SCHEMA_VERSION, Sha256Schema } from "./common.js";
import { PatchPreviewSchema } from "./action.js";
import { ReasoningEffortSchema, RunModeSchema } from "./commands.js";
import { WireSessionEventSchema } from "./event.js";
import { PermissionSnapshotSchema, PolicyToolNameSchema } from "./permission.js";
import { SandboxReportSchema } from "./sandbox.js";
import { InputQueueProjectionSchema } from "./steering.js";
import { DEFAULT_SUBAGENT_LIMITS, SubagentListProjectionSchema } from "./subagent.js";
import { TodoListSchema } from "./todo.js";
import { AttachmentListProjectionSchema } from "./attachment.js";
import { TeamProjectionSchema } from "./team.js";
import { WorkspaceKindSchema } from "./workspace.js";
import { LspDiagnosticsSummarySchema } from "./lsp.js";

export const PendingPlanSchema = z.object({
  plan_event_id: IdentifierSchema,
  todo_ids: z.array(IdentifierSchema).min(1).max(500),
}).strict();
export type PendingPlan = z.infer<typeof PendingPlanSchema>;

export const RunStatusSchema = z.enum([
  "created",
  "indexing",
  "running",
  "awaiting_plan_approval",
  "awaiting_approval",
  "needs_manual_review",
  "interrupted",
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const LegacyPendingApprovalSchema = z.object({
  approval_id: IdentifierSchema,
  action_id: IdentifierSchema,
  risk: z.enum(["low", "medium", "high"]),
  preview: PatchPreviewSchema,
}).strict();
export type LegacyPendingApproval = z.infer<typeof LegacyPendingApprovalSchema>;

/** Every new approval request is bound to the exact action and effective policy. */
export const BoundPendingApprovalSchema = LegacyPendingApprovalSchema.extend({
  tool_name: PolicyToolNameSchema,
  action_digest: Sha256Schema,
  policy_digest: Sha256Schema,
}).strict();
export type BoundPendingApproval = z.infer<typeof BoundPendingApprovalSchema>;

// Bound form is attempted first; the legacy branch exists only for replaying
// pre-G06 ledgers and recovery Artifacts.
export const PendingApprovalSchema = z.union([
  BoundPendingApprovalSchema,
  LegacyPendingApprovalSchema,
]);
export type PendingApproval = z.infer<typeof PendingApprovalSchema>;

export const RunProjectionSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  projector_version: z.literal(PROJECTOR_VERSION),
  project_id: IdentifierSchema,
  // Optional only for replaying ledgers created before the G-01 session model.
  // New runtime flows always populate it.
  session_id: IdentifierSchema.optional(),
  run_id: IdentifierSchema,
  task: z.string(),
  mode: RunModeSchema,
  reasoning_effort: ReasoningEffortSchema.optional(),
  workspace_kind: WorkspaceKindSchema,
  status: RunStatusSchema,
  last_sequence: z.number().int().nonnegative(),
  timeline: z.array(WireSessionEventSchema),
  todos: TodoListSchema.default({ items: [], last_sequence: 0 }),
  input_queue: InputQueueProjectionSchema.default({ pending: [] }),
  subagents: SubagentListProjectionSchema.default({
    items: [],
    active_count: 0,
    last_sequence: 0,
    limits: DEFAULT_SUBAGENT_LIMITS,
  }),
  attachments: AttachmentListProjectionSchema.default({ items: [], last_sequence: 0 }),
  // Ordinary and pre-G08 Runs have no team. Once team.created is durable this
  // becomes the complete replayed roster/mailbox/task-board view.
  team: TeamProjectionSchema.optional(),
  pending_plan: PendingPlanSchema.optional(),
  pending_approval: PendingApprovalSchema.optional(),
  // Optional for projections rebuilt from ledgers written before G-13.
  sandbox_report: SandboxReportSchema.optional(),
  // Optional for projections rebuilt from ledgers written before G-06.
  permission: PermissionSnapshotSchema.optional(),
  /** Latest bounded semantic diagnostics summary; raw LSP output is never projected. */
  diagnostics_summary: LspDiagnosticsSummarySchema.optional(),
  artifact_refs: z.array(ArtifactRefSchema),
  outcome: z.string().optional(),
  failure_code: z.string().optional(),
}).superRefine((value, context) => {
  for (const [index, input] of value.input_queue.pending.entries()) {
    if (input.run_id !== value.run_id) {
      context.addIssue({
        code: "custom",
        path: ["input_queue", "pending", index, "run_id"],
        message: "pending input run_id must match the projected Run",
      });
    }
  }
  for (const [index, subagent] of value.subagents.items.entries()) {
    if (subagent.link.parent_run_id !== value.run_id) {
      context.addIssue({
        code: "custom",
        path: ["subagents", "items", index, "link", "parent_run_id"],
        message: "subagent parent_run_id must match the projected Run",
      });
    }
    if (
      value.session_id !== undefined
      && subagent.link.parent_session_id !== value.session_id
    ) {
      context.addIssue({
        code: "custom",
        path: ["subagents", "items", index, "link", "parent_session_id"],
        message: "subagent parent_session_id must match the projected Session",
      });
    }
    if (subagent.depth > value.subagents.limits.max_depth) {
      context.addIssue({
        code: "custom",
        path: ["subagents", "items", index, "depth"],
        message: "subagent depth exceeds the projected limit",
      });
    }
    subagent.result?.artifact_refs.forEach((artifact, artifactIndex) => {
      if (artifact.project_id !== value.project_id || artifact.run_id !== subagent.link.child_run_id) {
        context.addIssue({
          code: "custom",
          path: ["subagents", "items", index, "result", "artifact_refs", artifactIndex],
          message: "subagent result Artifact must belong to the projected project and child Run",
        });
      }
    });
  }
  if (value.team !== undefined) {
    if (value.team.coordinator_run_id !== value.run_id) {
      context.addIssue({
        code: "custom",
        path: ["team", "coordinator_run_id"],
        message: "team coordinator_run_id must match the projected Run",
      });
    }
    const projectedSubagents = new Map(
      value.subagents.items.map((item) => [item.link.subagent_id, item.link]),
    );
    value.team.roster.members.forEach((member, index) => {
      const link = projectedSubagents.get(member.link.subagent_id);
      if (
        link === undefined
        || link.parent_run_id !== member.link.parent_run_id
        || link.child_run_id !== member.link.child_run_id
        || link.child_session_id !== member.link.child_session_id
      ) {
        context.addIssue({
          code: "custom",
          path: ["team", "roster", "members", index, "link"],
          message: "team member must match a canonical projected G-07 subagent link",
        });
      }
    });
  }
});
export type RunProjection = z.infer<typeof RunProjectionSchema>;
