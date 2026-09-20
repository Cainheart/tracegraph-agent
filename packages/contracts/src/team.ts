import { z } from "zod";
import {
  IdentifierSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  Sha256Schema,
} from "./common.js";
import { SubagentRunLinkSchema } from "./subagent.js";

export const MAX_TEAM_MEMBERS = 500;
export const MAX_TEAM_MAILBOX_MESSAGES = 2_000;
export const MAX_TEAM_TASKS = 500;
export const MAX_TEAM_MESSAGE_CHARS = 8_000;
export const MAX_TEAM_TASK_ACCEPTANCE_ITEMS = 32;
export const MAX_TEAM_TASK_EVIDENCE_EVENTS = 256;
export const MAX_TEAM_READ_PAGE_ITEMS = 100;
export const DEFAULT_TEAM_READ_PAGE_ITEMS = 25;

export const DEFAULT_TEAM_LIMITS = Object.freeze({
  max_parallel_workers: 4,
  heartbeat_timeout_ms: 30_000,
  max_members: MAX_TEAM_MEMBERS,
  max_mailbox_messages: 500,
  max_tasks: MAX_TEAM_TASKS,
});

export const TeamActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("lead") }).strict(),
  z.object({ kind: z.literal("user") }).strict(),
  z.object({ kind: z.literal("member"), subagent_id: IdentifierSchema }).strict(),
]);
export type TeamActor = z.infer<typeof TeamActorSchema>;

export const TeamLimitsSchema = z.object({
  max_parallel_workers: z.number().int().min(1).max(16)
    .default(DEFAULT_TEAM_LIMITS.max_parallel_workers),
  heartbeat_timeout_ms: z.number().int().min(1_000).max(3_600_000)
    .default(DEFAULT_TEAM_LIMITS.heartbeat_timeout_ms),
  max_members: z.number().int().min(1).max(MAX_TEAM_MEMBERS)
    .default(DEFAULT_TEAM_LIMITS.max_members),
  max_mailbox_messages: z.number().int().min(1).max(MAX_TEAM_MAILBOX_MESSAGES)
    .default(DEFAULT_TEAM_LIMITS.max_mailbox_messages),
  max_tasks: z.number().int().min(1).max(MAX_TEAM_TASKS)
    .default(DEFAULT_TEAM_LIMITS.max_tasks),
}).strict().superRefine((value, context) => {
  if (value.max_parallel_workers > value.max_members) {
    context.addIssue({
      code: "custom",
      path: ["max_parallel_workers"],
      message: "max_parallel_workers cannot exceed max_members",
    });
  }
});
export type TeamLimits = z.infer<typeof TeamLimitsSchema>;

export const TeamMemberStatusSchema = z.enum(["active", "lost"]);
export type TeamMemberStatus = z.infer<typeof TeamMemberStatusSchema>;

export const TEAM_COORDINATOR_ADDRESS = "coordinator" as const;

/** A team worker is always one canonical G-07 child Run, never an inline actor. */
export const TeamMemberSchema = z.object({
  link: SubagentRunLinkSchema,
  role: NonEmptyStringSchema.max(160),
  status: TeamMemberStatusSchema,
  joined_at: IsoDateTimeSchema,
  last_heartbeat_at: IsoDateTimeSchema,
  lost_at: IsoDateTimeSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.link.subagent_id === TEAM_COORDINATOR_ADDRESS) {
    context.addIssue({
      code: "custom",
      path: ["link", "subagent_id"],
      message: "team member subagent_id cannot use the reserved coordinator address",
    });
  }
  if ((value.status === "lost") !== (value.lost_at !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["lost_at"],
      message: "lost_at must be present exactly when a team member is lost",
    });
  }
  if (Date.parse(value.last_heartbeat_at) < Date.parse(value.joined_at)) {
    context.addIssue({
      code: "custom",
      path: ["last_heartbeat_at"],
      message: "last heartbeat cannot precede member join",
    });
  }
  if (
    value.lost_at !== undefined
    && Date.parse(value.lost_at) < Date.parse(value.last_heartbeat_at)
  ) {
    context.addIssue({
      code: "custom",
      path: ["lost_at"],
      message: "lost_at cannot precede the last heartbeat",
    });
  }
});
export type TeamMember = z.infer<typeof TeamMemberSchema>;

export const TeamRosterSchema = z.object({
  members: z.array(TeamMemberSchema).max(MAX_TEAM_MEMBERS),
  last_sequence: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  const subagentIds = value.members.map(({ link }) => link.subagent_id);
  const childRunIds = value.members.map(({ link }) => link.child_run_id);
  const childSessionIds = value.members.map(({ link }) => link.child_session_id);
  for (const [path, values] of [
    ["subagent_id", subagentIds],
    ["child_run_id", childRunIds],
    ["child_session_id", childSessionIds],
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: "custom",
        path: ["members"],
        message: `team member ${path} values must be unique`,
      });
    }
  }
});
export type TeamRoster = z.infer<typeof TeamRosterSchema>;

export const TeamMailboxAddressSchema = IdentifierSchema;
export type TeamMailboxAddress = z.infer<typeof TeamMailboxAddressSchema>;

export const MailboxMessageKindSchema = z.enum(["steer", "handoff", "question", "answer"]);
export type MailboxMessageKind = z.infer<typeof MailboxMessageKindSchema>;

/** Canonical mailbox read model. Claim fields form one atomic tuple. */
export const MailboxMessageSchema = z.object({
  message_id: IdentifierSchema,
  from: TeamMailboxAddressSchema,
  to: TeamMailboxAddressSchema,
  kind: MailboxMessageKindSchema,
  payload: NonEmptyStringSchema.max(MAX_TEAM_MESSAGE_CHARS),
  delivered_at: IsoDateTimeSchema,
  claimed_at: IsoDateTimeSchema.optional(),
  claimed_by: TeamMailboxAddressSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.from === value.to) {
    context.addIssue({ code: "custom", path: ["to"], message: "mailbox sender and recipient must differ" });
  }
  if ((value.claimed_at === undefined) !== (value.claimed_by === undefined)) {
    context.addIssue({
      code: "custom",
      path: value.claimed_at === undefined ? ["claimed_at"] : ["claimed_by"],
      message: "claimed_at and claimed_by must be present together",
    });
  }
  if (value.claimed_by !== undefined && value.claimed_by !== value.to) {
    context.addIssue({
      code: "custom",
      path: ["claimed_by"],
      message: "only the addressed recipient may claim a mailbox message",
    });
  }
  if (
    value.claimed_at !== undefined
    && Date.parse(value.claimed_at) < Date.parse(value.delivered_at)
  ) {
    context.addIssue({
      code: "custom",
      path: ["claimed_at"],
      message: "a mailbox message cannot be claimed before delivery",
    });
  }
});
export type MailboxMessage = z.infer<typeof MailboxMessageSchema>;

export const TeamMailboxProjectionSchema = z.object({
  messages: z.array(MailboxMessageSchema).max(MAX_TEAM_MAILBOX_MESSAGES),
  last_sequence: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  const ids = value.messages.map(({ message_id: messageId }) => messageId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["messages"], message: "mailbox message_id values must be unique" });
  }
});
export type TeamMailboxProjection = z.infer<typeof TeamMailboxProjectionSchema>;

export const TaskBoardStateSchema = z.enum(["open", "claimed", "done", "blocked", "cancelled"]);
export type TaskBoardState = z.infer<typeof TaskBoardStateSchema>;

const UniqueAcceptanceSchema = z.array(NonEmptyStringSchema.max(1_000))
  .min(1)
  .max(MAX_TEAM_TASK_ACCEPTANCE_ITEMS)
  .superRefine((items, context) => {
    if (new Set(items).size !== items.length) {
      context.addIssue({ code: "custom", message: "task acceptance entries must be unique" });
    }
  });

const UniqueTeamEvidenceEventIdsSchema = z.array(IdentifierSchema)
  .max(MAX_TEAM_TASK_EVIDENCE_EVENTS)
  .superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "task evidence_event_ids must be unique" });
    }
  });

/** Shared team task. `version` is the optimistic claim/mutation revision. */
export const TaskBoardItemSchema = z.object({
  task_id: IdentifierSchema,
  title: NonEmptyStringSchema.max(500),
  detail: NonEmptyStringSchema.max(4_000).optional(),
  state: TaskBoardStateSchema,
  owner: IdentifierSchema.optional(),
  acceptance: UniqueAcceptanceSchema,
  evidence_event_ids: UniqueTeamEvidenceEventIdsSchema,
  version: z.number().int().positive(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
}).strict().superRefine((value, context) => {
  const requiresOwner = value.state === "claimed" || value.state === "done" || value.state === "blocked";
  if (requiresOwner !== (value.owner !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["owner"],
      message: `${value.state} task owner consistency violation`,
    });
  }
  if (value.state === "done" && value.evidence_event_ids.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["evidence_event_ids"],
      message: "done team tasks require durable evidence",
    });
  }
  if (value.state === "open" && value.evidence_event_ids.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["evidence_event_ids"],
      message: "open team tasks cannot claim completion evidence",
    });
  }
  if (Date.parse(value.updated_at) < Date.parse(value.created_at)) {
    context.addIssue({
      code: "custom",
      path: ["updated_at"],
      message: "task updated_at cannot precede created_at",
    });
  }
});
export type TaskBoardItem = z.infer<typeof TaskBoardItemSchema>;

export const TaskBoardProjectionSchema = z.object({
  items: z.array(TaskBoardItemSchema).max(MAX_TEAM_TASKS),
  last_sequence: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  const ids = value.items.map(({ task_id: taskId }) => taskId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["items"], message: "team task_id values must be unique" });
  }
});
export type TaskBoardProjection = z.infer<typeof TaskBoardProjectionSchema>;

/** Optional on RunProjection: ordinary and pre-G08 Runs do not have a team. */
export const TeamProjectionSchema = z.object({
  team_id: IdentifierSchema,
  coordinator_run_id: IdentifierSchema,
  limits: TeamLimitsSchema,
  created_event_id: IdentifierSchema,
  created_at: IsoDateTimeSchema,
  roster: TeamRosterSchema,
  mailbox: TeamMailboxProjectionSchema,
  task_board: TaskBoardProjectionSchema,
  last_sequence: z.number().int().positive(),
}).strict().superRefine((value, context) => {
  if (value.roster.members.length > value.limits.max_members) {
    context.addIssue({ code: "custom", path: ["roster", "members"], message: "team roster exceeds its frozen limit" });
  }
  if (value.mailbox.messages.length > value.limits.max_mailbox_messages) {
    context.addIssue({ code: "custom", path: ["mailbox", "messages"], message: "team mailbox exceeds its frozen limit" });
  }
  if (value.task_board.items.length > value.limits.max_tasks) {
    context.addIssue({ code: "custom", path: ["task_board", "items"], message: "team task board exceeds its frozen limit" });
  }
  const active = value.roster.members.filter(({ status }) => status === "active").length;
  if (active > value.limits.max_parallel_workers) {
    context.addIssue({ code: "custom", path: ["roster", "members"], message: "active members exceed max_parallel_workers" });
  }
  const memberIds = new Set(value.roster.members.map(({ link }) => link.subagent_id));
  const activeMemberIds = new Set(
    value.roster.members
      .filter(({ status }) => status === "active")
      .map(({ link }) => link.subagent_id),
  );
  value.mailbox.messages.forEach((message, index) => {
    for (const field of ["from", "to", "claimed_by"] as const) {
      const address = message[field];
      if (
        address !== undefined
        && address !== TEAM_COORDINATOR_ADDRESS
        && !memberIds.has(address)
      ) {
        context.addIssue({
          code: "custom",
          path: ["mailbox", "messages", index, field],
          message: "mailbox address must be the coordinator or a roster member",
        });
      }
    }
  });
  value.task_board.items.forEach((task, index) => {
    if (task.owner !== undefined && !memberIds.has(task.owner)) {
      context.addIssue({
        code: "custom",
        path: ["task_board", "items", index, "owner"],
        message: "team task owner must be a roster member",
      });
    }
    if (task.state === "claimed" && task.owner !== undefined && !activeMemberIds.has(task.owner)) {
      context.addIssue({
        code: "custom",
        path: ["task_board", "items", index, "owner"],
        message: "a claimed task cannot remain owned by a lost member",
      });
    }
  });
  for (const [field, lastSequence] of [
    ["roster", value.roster.last_sequence],
    ["mailbox", value.mailbox.last_sequence],
    ["task_board", value.task_board.last_sequence],
  ] as const) {
    if (lastSequence > value.last_sequence) {
      context.addIssue({
        code: "custom",
        path: [field, "last_sequence"],
        message: `${field} last_sequence cannot exceed the team projection`,
      });
    }
  }
});
export type TeamProjection = z.infer<typeof TeamProjectionSchema>;

const InternalCommandDigestShape = {
  _internal_command_digest: Sha256Schema.optional(),
};

const TeamEventScopeShape = {
  team_id: IdentifierSchema,
};

export const TeamCreatedDataSchema = z.object({
  ...TeamEventScopeShape,
  coordinator_run_id: IdentifierSchema,
  limits: TeamLimitsSchema,
  created_at: IsoDateTimeSchema,
  ...InternalCommandDigestShape,
}).strict();
export type TeamCreatedData = z.infer<typeof TeamCreatedDataSchema>;

export const TeamMemberJoinedDataSchema = z.object({
  ...TeamEventScopeShape,
  member: TeamMemberSchema,
  ...InternalCommandDigestShape,
}).strict().superRefine((value, context) => {
  if (value.member.status !== "active") {
    context.addIssue({ code: "custom", path: ["member", "status"], message: "new team members must be active" });
  }
  if (value.member.lost_at !== undefined) {
    context.addIssue({ code: "custom", path: ["member", "lost_at"], message: "new team members cannot already be lost" });
  }
});
export type TeamMemberJoinedData = z.infer<typeof TeamMemberJoinedDataSchema>;

export const TeamHeartbeatDataSchema = z.object({
  ...TeamEventScopeShape,
  member: TeamMemberSchema,
  previous_heartbeat_at: IsoDateTimeSchema,
  ...InternalCommandDigestShape,
}).strict().superRefine((value, context) => {
  if (value.member.status !== "active") {
    context.addIssue({ code: "custom", path: ["member", "status"], message: "lost members cannot heartbeat" });
  }
  if (Date.parse(value.member.last_heartbeat_at) <= Date.parse(value.previous_heartbeat_at)) {
    context.addIssue({
      code: "custom",
      path: ["member", "last_heartbeat_at"],
      message: "heartbeat must advance last_heartbeat_at",
    });
  }
});
export type TeamHeartbeatData = z.infer<typeof TeamHeartbeatDataSchema>;

const UniqueTaskIdsSchema = z.array(IdentifierSchema)
  .max(MAX_TEAM_TASKS)
  .superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "reopened_task_ids must be unique" });
    }
  });

/** Member loss and reopening all of its claimed tasks are one ledger fact. */
export const TeamMemberLostDataSchema = z.object({
  ...TeamEventScopeShape,
  member: TeamMemberSchema,
  previous_status: z.literal("active"),
  reason: z.enum(["heartbeat_timeout", "worker_terminal"]),
  lost_at: IsoDateTimeSchema,
  last_heartbeat_at: IsoDateTimeSchema,
  reopened_task_ids: UniqueTaskIdsSchema,
  ...InternalCommandDigestShape,
}).strict().superRefine((value, context) => {
  if (value.member.status !== "lost") {
    context.addIssue({ code: "custom", path: ["member", "status"], message: "team.member_lost requires a lost member" });
  }
  if (value.member.lost_at !== value.lost_at) {
    context.addIssue({ code: "custom", path: ["lost_at"], message: "lost_at must match the member snapshot" });
  }
  if (value.member.last_heartbeat_at !== value.last_heartbeat_at) {
    context.addIssue({
      code: "custom",
      path: ["last_heartbeat_at"],
      message: "last_heartbeat_at must match the member snapshot",
    });
  }
});
export type TeamMemberLostData = z.infer<typeof TeamMemberLostDataSchema>;

const UniqueMemberLostEventIdsSchema = z.array(IdentifierSchema)
  .max(MAX_TEAM_MEMBERS)
  .superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "member_lost_event_ids must be unique" });
    }
  });

/** Durable top-level receipt for a timeout sweep, including an empty sweep. */
export const TeamSweepCompletedDataSchema = z.object({
  ...TeamEventScopeShape,
  swept_at: IsoDateTimeSchema,
  member_lost_event_ids: UniqueMemberLostEventIdsSchema,
  ...InternalCommandDigestShape,
}).strict();
export type TeamSweepCompletedData = z.infer<typeof TeamSweepCompletedDataSchema>;

export const TeamMailboxDeliveredDataSchema = z.object({
  ...TeamEventScopeShape,
  message: MailboxMessageSchema,
  ...InternalCommandDigestShape,
}).strict().superRefine((value, context) => {
  if (value.message.claimed_at !== undefined) {
    context.addIssue({ code: "custom", path: ["message", "claimed_at"], message: "a delivered message cannot already be claimed" });
  }
});
export type TeamMailboxDeliveredData = z.infer<typeof TeamMailboxDeliveredDataSchema>;

export const TeamMailboxClaimedDataSchema = z.object({
  ...TeamEventScopeShape,
  message: MailboxMessageSchema,
  delivered_event_id: IdentifierSchema,
  ...InternalCommandDigestShape,
}).strict().superRefine((value, context) => {
  if (value.message.claimed_at === undefined) {
    context.addIssue({ code: "custom", path: ["message", "claimed_at"], message: "team.mailbox_claimed requires claim facts" });
  }
});
export type TeamMailboxClaimedData = z.infer<typeof TeamMailboxClaimedDataSchema>;

export const TeamTaskCreatedDataSchema = z.object({
  ...TeamEventScopeShape,
  task: TaskBoardItemSchema,
  ...InternalCommandDigestShape,
}).strict().superRefine((value, context) => {
  if (value.task.state !== "open" || value.task.version !== 1) {
    context.addIssue({ code: "custom", path: ["task"], message: "new team tasks must be open at version 1" });
  }
});
export type TeamTaskCreatedData = z.infer<typeof TeamTaskCreatedDataSchema>;

const TaskTransitionShape = {
  ...TeamEventScopeShape,
  task: TaskBoardItemSchema,
  previous_version: z.number().int().positive(),
  previous_owner: IdentifierSchema.optional(),
  ...InternalCommandDigestShape,
};

function requireNextTaskVersion(
  value: { task: TaskBoardItem; previous_version: number },
  context: z.RefinementCtx,
): void {
  if (value.task.version !== value.previous_version + 1) {
    context.addIssue({
      code: "custom",
      path: ["task", "version"],
      message: "team task mutation must advance version exactly once",
    });
  }
}

export const TeamTaskClaimedDataSchema = z.object({
  ...TaskTransitionShape,
  previous_state: z.literal("open"),
}).strict().superRefine((value, context) => {
  requireNextTaskVersion(value, context);
  if (value.task.state !== "claimed") {
    context.addIssue({ code: "custom", path: ["task", "state"], message: "team.task_claimed requires state=claimed" });
  }
  if (value.previous_owner !== undefined) {
    context.addIssue({ code: "custom", path: ["previous_owner"], message: "an open task cannot have a previous owner" });
  }
});
export type TeamTaskClaimedData = z.infer<typeof TeamTaskClaimedDataSchema>;

export const TeamTaskCompletedDataSchema = z.object({
  ...TaskTransitionShape,
  previous_state: z.enum(["claimed", "blocked"]),
}).strict().superRefine((value, context) => {
  requireNextTaskVersion(value, context);
  if (value.task.state !== "done") {
    context.addIssue({ code: "custom", path: ["task", "state"], message: "team.task_completed requires state=done" });
  }
  if (value.previous_owner === undefined || value.previous_owner !== value.task.owner) {
    context.addIssue({ code: "custom", path: ["previous_owner"], message: "task completion must preserve its owner" });
  }
});
export type TeamTaskCompletedData = z.infer<typeof TeamTaskCompletedDataSchema>;

export const TeamTaskBlockedDataSchema = z.object({
  ...TaskTransitionShape,
  previous_state: z.literal("claimed"),
  reason: NonEmptyStringSchema.max(1_000),
}).strict().superRefine((value, context) => {
  requireNextTaskVersion(value, context);
  if (value.task.state !== "blocked") {
    context.addIssue({ code: "custom", path: ["task", "state"], message: "team.task_blocked requires state=blocked" });
  }
  if (value.previous_owner === undefined || value.previous_owner !== value.task.owner) {
    context.addIssue({ code: "custom", path: ["previous_owner"], message: "blocked task must preserve its owner" });
  }
});
export type TeamTaskBlockedData = z.infer<typeof TeamTaskBlockedDataSchema>;

export const TeamTaskCancelledDataSchema = z.object({
  ...TaskTransitionShape,
  previous_state: z.enum(["open", "claimed", "blocked"]),
  reason: NonEmptyStringSchema.max(1_000),
}).strict().superRefine((value, context) => {
  requireNextTaskVersion(value, context);
  if (value.task.state !== "cancelled") {
    context.addIssue({ code: "custom", path: ["task", "state"], message: "team.task_cancelled requires state=cancelled" });
  }
  if (value.task.owner !== undefined) {
    context.addIssue({ code: "custom", path: ["task", "owner"], message: "cancelled tasks must release their owner" });
  }
  if ((value.previous_state === "open") !== (value.previous_owner === undefined)) {
    context.addIssue({ code: "custom", path: ["previous_owner"], message: "previous owner must agree with previous task state" });
  }
});
export type TeamTaskCancelledData = z.infer<typeof TeamTaskCancelledDataSchema>;

export const TeamTaskReopenedDataSchema = z.object({
  ...TaskTransitionShape,
  previous_state: z.enum(["blocked", "cancelled"]),
  reason: NonEmptyStringSchema.max(1_000),
}).strict().superRefine((value, context) => {
  requireNextTaskVersion(value, context);
  if (value.task.state !== "open") {
    context.addIssue({ code: "custom", path: ["task", "state"], message: "team.task_reopened requires state=open" });
  }
  if (value.previous_state === "blocked" && value.previous_owner === undefined) {
    context.addIssue({ code: "custom", path: ["previous_owner"], message: "a blocked task must have a previous owner" });
  }
  if (value.previous_state === "cancelled" && value.previous_owner !== undefined) {
    context.addIssue({ code: "custom", path: ["previous_owner"], message: "a cancelled task cannot have a previous owner" });
  }
});
export type TeamTaskReopenedData = z.infer<typeof TeamTaskReopenedDataSchema>;

export const TEAM_EVENT_DATA_SCHEMAS = Object.freeze({
  "team.created": TeamCreatedDataSchema,
  "team.member_joined": TeamMemberJoinedDataSchema,
  "team.heartbeat": TeamHeartbeatDataSchema,
  "team.member_lost": TeamMemberLostDataSchema,
  "team.mailbox_delivered": TeamMailboxDeliveredDataSchema,
  "team.mailbox_claimed": TeamMailboxClaimedDataSchema,
  "team.task_created": TeamTaskCreatedDataSchema,
  "team.task_claimed": TeamTaskClaimedDataSchema,
  "team.task_completed": TeamTaskCompletedDataSchema,
  "team.task_blocked": TeamTaskBlockedDataSchema,
  "team.task_cancelled": TeamTaskCancelledDataSchema,
  "team.task_reopened": TeamTaskReopenedDataSchema,
  "team.sweep_completed": TeamSweepCompletedDataSchema,
});

/** Model-visible inputs contain no project/run/team/actor/from/owner authority. */
export const TeamReadSectionSchema = z.enum(["roster", "mailbox", "task_board"]);
export type TeamReadSection = z.infer<typeof TeamReadSectionSchema>;

/**
 * Team reads are section- and item-paged so one maximum-size canonical Team
 * cannot be silently truncated by the bounded Tool-result envelope. A caller
 * pins later pages to the first page's last_sequence to avoid mixing snapshots.
 */
export const TeamReadInputSchema = z.object({
  section: TeamReadSectionSchema.default("task_board"),
  offset: z.number().int().nonnegative().max(MAX_TEAM_MAILBOX_MESSAGES).default(0),
  limit: z.number().int().min(1).max(MAX_TEAM_READ_PAGE_ITEMS)
    .default(DEFAULT_TEAM_READ_PAGE_ITEMS),
  expected_last_sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();
export type TeamReadInput = z.infer<typeof TeamReadInputSchema>;

/**
 * Kept as a root object instead of a root union so the schema remains within
 * TraceGraph's bounded Tool JSON-Schema subset.
 */
export const TeamTaskWriteInputSchema = z.object({
  operation: z.enum(["create", "claim", "complete", "block", "cancel", "reopen"]),
  task_id: IdentifierSchema,
  title: NonEmptyStringSchema.max(500).optional(),
  detail: NonEmptyStringSchema.max(4_000).optional(),
  acceptance: UniqueAcceptanceSchema.optional(),
  expected_version: z.number().int().positive().optional(),
  evidence_event_ids: UniqueTeamEvidenceEventIdsSchema.optional(),
  reason: NonEmptyStringSchema.max(1_000).optional(),
}).strict().superRefine((value, context) => {
  const addIssue = (path: string, message: string) => {
    context.addIssue({ code: "custom", path: [path], message });
  };
  if (value.operation === "create") {
    if (value.title === undefined) addIssue("title", "create requires title");
    if (value.acceptance === undefined) addIssue("acceptance", "create requires acceptance");
    for (const field of ["expected_version", "evidence_event_ids", "reason"] as const) {
      if (value[field] !== undefined) addIssue(field, `create cannot set ${field}`);
    }
    return;
  }
  for (const field of ["title", "detail", "acceptance"] as const) {
    if (value[field] !== undefined) addIssue(field, `${value.operation} cannot change ${field}`);
  }
  if (value.expected_version === undefined) {
    addIssue("expected_version", `${value.operation} requires expected_version`);
  }
  if (value.operation === "complete") {
    if ((value.evidence_event_ids?.length ?? 0) === 0) {
      addIssue("evidence_event_ids", "complete requires durable evidence_event_ids");
    }
    if (value.reason !== undefined) addIssue("reason", "complete cannot set reason");
    return;
  }
  if (value.evidence_event_ids !== undefined) {
    addIssue("evidence_event_ids", `${value.operation} cannot set evidence_event_ids`);
  }
  if (value.operation === "claim") {
    if (value.reason !== undefined) addIssue("reason", "claim cannot set reason");
    return;
  }
  if (value.reason === undefined) addIssue("reason", `${value.operation} requires reason`);
});
export type TeamTaskWriteInput = z.infer<typeof TeamTaskWriteInputSchema>;

export const TeamMailboxSendInputSchema = z.object({
  to: TeamMailboxAddressSchema,
  kind: MailboxMessageKindSchema,
  payload: NonEmptyStringSchema.max(MAX_TEAM_MESSAGE_CHARS),
}).strict();
export type TeamMailboxSendInput = z.infer<typeof TeamMailboxSendInputSchema>;

export const TeamMailboxClaimInputSchema = z.object({
  message_id: IdentifierSchema,
}).strict();
export type TeamMailboxClaimInput = z.infer<typeof TeamMailboxClaimInputSchema>;

export const TeamHeartbeatInputSchema = z.object({}).strict();
export type TeamHeartbeatInput = z.infer<typeof TeamHeartbeatInputSchema>;

/** Browser/SDK wire envelopes keep idempotency separate from model payload. */
export const CreateTeamRequestSchema = z.object({
  command_id: IdentifierSchema,
}).strict();
export type CreateTeamRequest = z.infer<typeof CreateTeamRequestSchema>;

export const TeamTaskWriteRequestSchema = z.object({
  command_id: IdentifierSchema,
  input: TeamTaskWriteInputSchema,
}).strict();
export type TeamTaskWriteRequest = z.infer<typeof TeamTaskWriteRequestSchema>;

export const TeamMailboxSendRequestSchema = z.object({
  command_id: IdentifierSchema,
  input: TeamMailboxSendInputSchema,
}).strict();
export type TeamMailboxSendRequest = z.infer<typeof TeamMailboxSendRequestSchema>;

export const TeamMailboxClaimRequestSchema = z.object({
  command_id: IdentifierSchema,
  input: TeamMailboxClaimInputSchema,
}).strict();
export type TeamMailboxClaimRequest = z.infer<typeof TeamMailboxClaimRequestSchema>;

export const TeamHeartbeatRequestSchema = z.object({
  command_id: IdentifierSchema,
  input: TeamHeartbeatInputSchema,
}).strict();
export type TeamHeartbeatRequest = z.infer<typeof TeamHeartbeatRequestSchema>;

/** Trusted Host sweep; timeout comes only from the frozen team limits. */
export const TeamSweepLostMembersRequestSchema = z.object({
  command_id: IdentifierSchema,
}).strict();
export type TeamSweepLostMembersRequest = z.infer<typeof TeamSweepLostMembersRequestSchema>;

export const TeamReadResponseSchema = z.object({
  team: TeamProjectionSchema.optional(),
}).strict();
export type TeamReadResponse = z.infer<typeof TeamReadResponseSchema>;

export const TeamMutationResultSchema = z.object({
  command_id: IdentifierSchema,
  disposition: z.enum(["applied", "duplicate", "noop"]),
  event_ids: z.array(IdentifierSchema).max(MAX_TEAM_TASKS + MAX_TEAM_MEMBERS + 1),
  team: TeamProjectionSchema,
}).strict().superRefine((value, context) => {
  if ((value.disposition === "noop") !== (value.event_ids.length === 0)) {
    context.addIssue({
      code: "custom",
      path: ["event_ids"],
      message: "noop must have no events and applied/duplicate must reference canonical events",
    });
  }
});
export type TeamMutationResult = z.infer<typeof TeamMutationResultSchema>;

const CommandShape = {
  command_id: IdentifierSchema,
};

export const CreateTeamCommandSchema = z.object({
  ...CommandShape,
  operation: z.literal("create_team"),
}).strict();
export type CreateTeamCommand = z.infer<typeof CreateTeamCommandSchema>;

export const JoinTeamMemberCommandSchema = z.object({
  ...CommandShape,
  operation: z.literal("join_member"),
  subagent_id: IdentifierSchema,
  role: NonEmptyStringSchema.max(160),
}).strict();
export type JoinTeamMemberCommand = z.infer<typeof JoinTeamMemberCommandSchema>;

export const TeamHeartbeatCommandSchema = z.object({
  ...CommandShape,
  operation: z.literal("heartbeat"),
  subagent_id: IdentifierSchema,
}).strict();
export type TeamHeartbeatCommand = z.infer<typeof TeamHeartbeatCommandSchema>;

export const MarkTeamMemberLostCommandSchema = z.object({
  ...CommandShape,
  operation: z.literal("mark_member_lost"),
  subagent_id: IdentifierSchema,
}).strict();
export type MarkTeamMemberLostCommand = z.infer<typeof MarkTeamMemberLostCommandSchema>;

export const DeliverTeamMailboxCommandSchema = z.object({
  ...CommandShape,
  operation: z.literal("deliver_mailbox"),
  message_id: IdentifierSchema,
  to: TeamMailboxAddressSchema,
  kind: MailboxMessageKindSchema,
  payload: NonEmptyStringSchema.max(MAX_TEAM_MESSAGE_CHARS),
}).strict();
export type DeliverTeamMailboxCommand = z.infer<typeof DeliverTeamMailboxCommandSchema>;

export const ClaimTeamMailboxCommandSchema = z.object({
  ...CommandShape,
  operation: z.literal("claim_mailbox"),
  message_id: IdentifierSchema,
}).strict();
export type ClaimTeamMailboxCommand = z.infer<typeof ClaimTeamMailboxCommandSchema>;

export const CreateTeamTaskCommandSchema = z.object({
  ...CommandShape,
  operation: z.literal("create_task"),
  task_id: IdentifierSchema,
  title: NonEmptyStringSchema.max(500),
  detail: NonEmptyStringSchema.max(4_000).optional(),
  acceptance: UniqueAcceptanceSchema,
}).strict();
export type CreateTeamTaskCommand = z.infer<typeof CreateTeamTaskCommandSchema>;

export const ClaimTeamTaskCommandSchema = z.object({
  ...CommandShape,
  operation: z.literal("claim_task"),
  task_id: IdentifierSchema,
  expected_version: z.number().int().positive(),
}).strict();
export type ClaimTeamTaskCommand = z.infer<typeof ClaimTeamTaskCommandSchema>;

export const CompleteTeamTaskCommandSchema = z.object({
  ...CommandShape,
  operation: z.literal("complete_task"),
  task_id: IdentifierSchema,
  expected_version: z.number().int().positive(),
  evidence_event_ids: UniqueTeamEvidenceEventIdsSchema.min(1),
}).strict();
export type CompleteTeamTaskCommand = z.infer<typeof CompleteTeamTaskCommandSchema>;

export const BlockTeamTaskCommandSchema = z.object({
  ...CommandShape,
  operation: z.literal("block_task"),
  task_id: IdentifierSchema,
  expected_version: z.number().int().positive(),
  reason: NonEmptyStringSchema.max(1_000),
}).strict();
export type BlockTeamTaskCommand = z.infer<typeof BlockTeamTaskCommandSchema>;

export const CancelTeamTaskCommandSchema = z.object({
  ...CommandShape,
  operation: z.literal("cancel_task"),
  task_id: IdentifierSchema,
  expected_version: z.number().int().positive(),
  reason: NonEmptyStringSchema.max(1_000),
}).strict();
export type CancelTeamTaskCommand = z.infer<typeof CancelTeamTaskCommandSchema>;

export const ReopenTeamTaskCommandSchema = z.object({
  ...CommandShape,
  operation: z.literal("reopen_task"),
  task_id: IdentifierSchema,
  expected_version: z.number().int().positive(),
  reason: NonEmptyStringSchema.max(1_000),
}).strict();
export type ReopenTeamTaskCommand = z.infer<typeof ReopenTeamTaskCommandSchema>;

export const TeamCommandSchema = z.discriminatedUnion("operation", [
  CreateTeamCommandSchema,
  JoinTeamMemberCommandSchema,
  TeamHeartbeatCommandSchema,
  MarkTeamMemberLostCommandSchema,
  DeliverTeamMailboxCommandSchema,
  ClaimTeamMailboxCommandSchema,
  CreateTeamTaskCommandSchema,
  ClaimTeamTaskCommandSchema,
  CompleteTeamTaskCommandSchema,
  BlockTeamTaskCommandSchema,
  CancelTeamTaskCommandSchema,
  ReopenTeamTaskCommandSchema,
]);
export type TeamCommand = z.infer<typeof TeamCommandSchema>;
