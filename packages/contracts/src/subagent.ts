import { z } from "zod";
import {
  ArtifactRefSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  Sha256Schema,
} from "./common.js";
import { PolicyToolNameSchema } from "./permission.js";
import { ProviderReportedCostSchema, TokenConfidenceSchema } from "./token.js";

export const DEFAULT_MAX_PARALLEL_SUBAGENTS = 2;
export const DEFAULT_MAX_SUBAGENT_DEPTH = 1;
export const MAX_SUBAGENTS_PER_RUN = 500;
export const MAX_SUBAGENT_MESSAGE_CHARS = 8_000;

export const DEFAULT_SUBAGENT_LIMITS = Object.freeze({
  max_parallel_subagents: DEFAULT_MAX_PARALLEL_SUBAGENTS,
  max_depth: DEFAULT_MAX_SUBAGENT_DEPTH,
});

export const SubagentNameSchema = NonEmptyStringSchema
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u, "invalid subagent profile name");
export type SubagentName = z.infer<typeof SubagentNameSchema>;

export const SubagentContextScopeSchema = z.enum(["isolated", "fork"]);
export type SubagentContextScope = z.infer<typeof SubagentContextScopeSchema>;

export const SubagentBudgetSchema = z.object({
  max_steps: z.number().int().positive().max(1_000),
  max_tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type SubagentBudget = z.infer<typeof SubagentBudgetSchema>;

export const SubagentBudgetRequestSchema = SubagentBudgetSchema.partial()
  .strict()
  .refine((value) => value.max_steps !== undefined || value.max_tokens !== undefined, {
    message: "a requested subagent budget must set at least one limit",
  });
export type SubagentBudgetRequest = z.infer<typeof SubagentBudgetRequestSchema>;

export const SubagentLimitsSchema = z.object({
  max_parallel_subagents: z.number().int().min(1).max(16)
    .default(DEFAULT_MAX_PARALLEL_SUBAGENTS),
  max_depth: z.number().int().min(1).max(4).default(DEFAULT_MAX_SUBAGENT_DEPTH),
}).strict();
export type SubagentLimits = z.infer<typeof SubagentLimitsSchema>;

const UniqueToolAllowlistSchema = z.array(PolicyToolNameSchema)
  .max(256)
  .superRefine((tools, context) => {
    if (new Set(tools).size !== tools.length) {
      context.addIssue({ code: "custom", message: "subagent tool_allowlist entries must be unique" });
    }
  });

/** Trusted Host-side profile. Model-facing spawn input contains only its name. */
export const SubagentProfileSchema = z.object({
  name: SubagentNameSchema,
  provider_key: NonEmptyStringSchema.max(160),
  role_prompt_version: NonEmptyStringSchema.max(160),
  role_prompt_hash: Sha256Schema,
  tool_allowlist: UniqueToolAllowlistSchema,
  default_budget: SubagentBudgetSchema,
  budget_ceiling: SubagentBudgetSchema,
}).strict().superRefine((value, context) => {
  if (value.default_budget.max_steps > value.budget_ceiling.max_steps) {
    context.addIssue({
      code: "custom",
      path: ["default_budget", "max_steps"],
      message: "default max_steps cannot exceed the profile ceiling",
    });
  }
  if (value.default_budget.max_tokens > value.budget_ceiling.max_tokens) {
    context.addIssue({
      code: "custom",
      path: ["default_budget", "max_tokens"],
      message: "default max_tokens cannot exceed the profile ceiling",
    });
  }
});
export type SubagentProfile = z.infer<typeof SubagentProfileSchema>;

export const SubagentTaskPacketSchema = z.object({
  task: NonEmptyStringSchema.max(8_000),
  constraints: z.array(NonEmptyStringSchema.max(1_000)).max(32).default([]),
  acceptance_criteria: z.array(NonEmptyStringSchema.max(1_000)).max(32).default([]),
}).strict();
export type SubagentTaskPacket = z.infer<typeof SubagentTaskPacketSchema>;

/** Model-visible spawn input. Authority-bearing provider/prompt/tool fields are absent. */
export const SpawnSubagentInputSchema = z.object({
  profile_name: SubagentNameSchema,
  task_packet: SubagentTaskPacketSchema,
  context_scope: SubagentContextScopeSchema,
  budget: SubagentBudgetRequestSchema.optional(),
}).strict();
export type SpawnSubagentInput = z.infer<typeof SpawnSubagentInputSchema>;

export const SendSubagentMessageInputSchema = z.object({
  subagent_id: IdentifierSchema,
  message: NonEmptyStringSchema.max(MAX_SUBAGENT_MESSAGE_CHARS),
}).strict();
export type SendSubagentMessageInput = z.infer<typeof SendSubagentMessageInputSchema>;

export const ListSubagentsInputSchema = z.object({}).strict();
export type ListSubagentsInput = z.infer<typeof ListSubagentsInputSchema>;

export const InterruptSubagentInputSchema = z.object({
  subagent_id: IdentifierSchema,
  reason: NonEmptyStringSchema.max(1_000).optional(),
}).strict();
export type InterruptSubagentInput = z.infer<typeof InterruptSubagentInputSchema>;

/** Fully resolved immutable authority recorded by the parent and child Runs. */
export const SubagentSpecSchema = z.object({
  subagent_id: IdentifierSchema,
  parent_run_id: IdentifierSchema,
  name: SubagentNameSchema,
  provider_key: NonEmptyStringSchema.max(160),
  role_prompt_version: NonEmptyStringSchema.max(160),
  role_prompt_hash: Sha256Schema,
  tool_allowlist: UniqueToolAllowlistSchema,
  context_scope: SubagentContextScopeSchema,
  budget: SubagentBudgetSchema,
  depth: z.number().int().positive().max(4),
  fork_context_manifest_ref: IdentifierSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.context_scope === "fork" && value.fork_context_manifest_ref === undefined) {
    context.addIssue({
      code: "custom",
      path: ["fork_context_manifest_ref"],
      message: "forked subagents require an exact parent Context manifest reference",
    });
  }
  if (value.context_scope === "isolated" && value.fork_context_manifest_ref !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["fork_context_manifest_ref"],
      message: "isolated subagents cannot inherit a parent Context manifest",
    });
  }
});
export type SubagentSpec = z.infer<typeof SubagentSpecSchema>;

export const SubagentRunLinkSchema = z.object({
  subagent_id: IdentifierSchema,
  parent_run_id: IdentifierSchema,
  parent_session_id: IdentifierSchema,
  child_run_id: IdentifierSchema,
  child_session_id: IdentifierSchema,
}).strict().superRefine((value, context) => {
  if (value.child_run_id === value.parent_run_id) {
    context.addIssue({ code: "custom", path: ["child_run_id"], message: "child Run must differ from parent Run" });
  }
  if (value.child_session_id === value.parent_session_id) {
    context.addIssue({
      code: "custom",
      path: ["child_session_id"],
      message: "child Run requires an independent child Session",
    });
  }
});
export type SubagentRunLink = z.infer<typeof SubagentRunLinkSchema>;

export const SubagentUsageSchema = z.object({
  steps: z.number().int().nonnegative().max(1_000),
  input_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  output_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  total_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  confidence: TokenConfidenceSchema,
  costs: z.array(ProviderReportedCostSchema).max(16).default([]),
}).strict().superRefine((value, context) => {
  if (value.total_tokens !== value.input_tokens + value.output_tokens) {
    context.addIssue({
      code: "custom",
      path: ["total_tokens"],
      message: "subagent total_tokens must equal input_tokens plus output_tokens",
    });
  }
  const currencies = value.costs.map(({ currency }) => currency);
  if (new Set(currencies).size !== currencies.length) {
    context.addIssue({ code: "custom", path: ["costs"], message: "subagent costs must be unique by currency" });
  }
});
export type SubagentUsage = z.infer<typeof SubagentUsageSchema>;

export const SubagentResultStatusSchema = z.enum([
  "completed",
  "failed",
  "interrupted",
  "budget_exceeded",
]);
export type SubagentResultStatus = z.infer<typeof SubagentResultStatusSchema>;

export const SubagentResultSchema = z.object({
  subagent_id: IdentifierSchema,
  child_run_id: IdentifierSchema,
  status: SubagentResultStatusSchema,
  summary: NonEmptyStringSchema.max(8_000),
  artifact_refs: z.array(ArtifactRefSchema).max(64).default([]),
  usage: SubagentUsageSchema.optional(),
}).strict();
export type SubagentResult = z.infer<typeof SubagentResultSchema>;

export const SubagentStartedDataSchema = z.object({
  link: SubagentRunLinkSchema,
  spec: SubagentSpecSchema,
  limits: SubagentLimitsSchema,
  task_packet_hash: Sha256Schema,
}).strict().superRefine((value, context) => {
  if (value.spec.subagent_id !== value.link.subagent_id) {
    context.addIssue({ code: "custom", path: ["spec", "subagent_id"], message: "spec must match the Run link" });
  }
  if (value.spec.parent_run_id !== value.link.parent_run_id) {
    context.addIssue({ code: "custom", path: ["spec", "parent_run_id"], message: "spec must match the Run link" });
  }
  if (value.spec.depth > value.limits.max_depth) {
    context.addIssue({ code: "custom", path: ["spec", "depth"], message: "subagent depth exceeds the effective limit" });
  }
});
export type SubagentStartedData = z.infer<typeof SubagentStartedDataSchema>;

export const SubagentMessageSchema = z.object({
  message_id: IdentifierSchema,
  kind: z.enum(["initial_task", "message"]),
  actor: z.literal("parent_agent"),
  body: NonEmptyStringSchema.max(MAX_SUBAGENT_MESSAGE_CHARS),
  body_hash: Sha256Schema,
  sent_at: IsoDateTimeSchema,
}).strict();
export type SubagentMessage = z.infer<typeof SubagentMessageSchema>;

export const SubagentMessageSentDataSchema = z.object({
  link: SubagentRunLinkSchema,
  message: SubagentMessageSchema,
  _internal_message_digest: Sha256Schema.optional(),
}).strict();
export type SubagentMessageSentData = z.infer<typeof SubagentMessageSentDataSchema>;

const ChildTerminalProofShape = {
  child_terminal_event_id: IdentifierSchema,
  child_terminal_event_hash: Sha256Schema,
};

export const SubagentCompletedDataSchema = z.object({
  link: SubagentRunLinkSchema,
  result: SubagentResultSchema.extend({ status: z.literal("completed") }),
  ...ChildTerminalProofShape,
}).strict().superRefine(resultMatchesLink);
export type SubagentCompletedData = z.infer<typeof SubagentCompletedDataSchema>;

export const SubagentFailedDataSchema = z.object({
  link: SubagentRunLinkSchema,
  result: SubagentResultSchema.extend({ status: z.enum(["failed", "budget_exceeded"]) }),
  reason: NonEmptyStringSchema.max(160),
  failure_stage: z.enum(["launch", "execution"]),
  child_terminal_event_id: IdentifierSchema.optional(),
  child_terminal_event_hash: Sha256Schema.optional(),
}).strict().superRefine((value, context) => {
  resultMatchesLink(value, context);
  if ((value.child_terminal_event_id === undefined) !== (value.child_terminal_event_hash === undefined)) {
    context.addIssue({ code: "custom", path: ["child_terminal_event_id"], message: "child terminal proof is an atomic pair" });
  }
  if (value.failure_stage === "execution" && value.child_terminal_event_id === undefined) {
    context.addIssue({ code: "custom", path: ["child_terminal_event_id"], message: "execution failures require child terminal proof" });
  }
  if (value.failure_stage === "launch" && value.child_terminal_event_id !== undefined) {
    context.addIssue({ code: "custom", path: ["child_terminal_event_id"], message: "launch failures cannot claim child terminal proof" });
  }
  if ((value.result.status === "budget_exceeded") !== (value.reason === "budget_exceeded")) {
    context.addIssue({ code: "custom", path: ["reason"], message: "budget_exceeded status and reason must agree" });
  }
});
export type SubagentFailedData = z.infer<typeof SubagentFailedDataSchema>;

export const SubagentInterruptedDataSchema = z.object({
  link: SubagentRunLinkSchema,
  result: SubagentResultSchema.extend({ status: z.literal("interrupted") }),
  reason: NonEmptyStringSchema.max(1_000),
  ...ChildTerminalProofShape,
}).strict().superRefine(resultMatchesLink);
export type SubagentInterruptedData = z.infer<typeof SubagentInterruptedDataSchema>;

/** Private recovery payload added by run_recovery_state v4. */
export const SubagentOrchestrationRecoverySchema = z.object({
  depth: z.number().int().nonnegative().max(4),
  limits: SubagentLimitsSchema,
  delegation: SubagentStartedDataSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.depth > value.limits.max_depth) {
    context.addIssue({ code: "custom", path: ["depth"], message: "recovered agent depth exceeds its limit" });
  }
  if (value.depth === 0 && value.delegation !== undefined) {
    context.addIssue({ code: "custom", path: ["delegation"], message: "a root Run cannot have a parent delegation" });
  }
  if (value.depth > 0 && value.delegation === undefined) {
    context.addIssue({ code: "custom", path: ["delegation"], message: "a child Run requires its durable delegation" });
  }
  if (value.delegation !== undefined) {
    if (value.delegation.spec.depth !== value.depth) {
      context.addIssue({ code: "custom", path: ["delegation", "spec", "depth"], message: "delegation depth must match recovery depth" });
    }
    if (!sameLimits(value.delegation.limits, value.limits)) {
      context.addIssue({ code: "custom", path: ["delegation", "limits"], message: "delegation limits must match recovery limits" });
    }
  }
});
export type SubagentOrchestrationRecovery = z.infer<typeof SubagentOrchestrationRecoverySchema>;

export const SubagentProjectionStatusSchema = SubagentResultStatusSchema.or(z.literal("running"));
export type SubagentProjectionStatus = z.infer<typeof SubagentProjectionStatusSchema>;

export const SubagentProjectionItemSchema = z.object({
  link: SubagentRunLinkSchema,
  name: SubagentNameSchema,
  provider_key: NonEmptyStringSchema.max(160),
  role_prompt_version: NonEmptyStringSchema.max(160),
  role_prompt_hash: Sha256Schema,
  tool_allowlist: UniqueToolAllowlistSchema,
  context_scope: SubagentContextScopeSchema,
  budget: SubagentBudgetSchema,
  depth: z.number().int().positive().max(4),
  status: SubagentProjectionStatusSchema,
  started_event_id: IdentifierSchema,
  started_at: IsoDateTimeSchema,
  message_count: z.number().int().nonnegative(),
  initial_message_event_id: IdentifierSchema.optional(),
  last_message_at: IsoDateTimeSchema.optional(),
  terminal_event_id: IdentifierSchema.optional(),
  child_terminal_event_id: IdentifierSchema.optional(),
  child_terminal_event_hash: Sha256Schema.optional(),
  finished_at: IsoDateTimeSchema.optional(),
  failure_reason: NonEmptyStringSchema.max(1_000).optional(),
  result: SubagentResultSchema.optional(),
}).strict().superRefine((value, context) => {
  const terminal = value.status !== "running";
  for (const [field, member] of [
    ["terminal_event_id", value.terminal_event_id],
    ["finished_at", value.finished_at],
    ["result", value.result],
  ] as const) {
    if (terminal !== (member !== undefined)) {
      context.addIssue({ code: "custom", path: [field], message: "terminal subagent projection fields must be present together" });
    }
  }
  if ((value.child_terminal_event_id === undefined) !== (value.child_terminal_event_hash === undefined)) {
    context.addIssue({ code: "custom", path: ["child_terminal_event_id"], message: "child terminal proof is an atomic pair" });
  }
  if (value.status !== "failed" && terminal && value.child_terminal_event_id === undefined) {
    context.addIssue({ code: "custom", path: ["child_terminal_event_id"], message: "terminal child execution requires canonical proof" });
  }
  if (value.result !== undefined && value.result.status !== value.status) {
    context.addIssue({ code: "custom", path: ["result", "status"], message: "result status must match projected status" });
  }
  const failed = value.status === "failed"
    || value.status === "budget_exceeded"
    || value.status === "interrupted";
  if (failed !== (value.failure_reason !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["failure_reason"],
      message: "failed or interrupted subagents require a failure reason",
    });
  }
  if (value.result !== undefined) {
    if (value.result.subagent_id !== value.link.subagent_id) {
      context.addIssue({ code: "custom", path: ["result", "subagent_id"], message: "result must match projected subagent" });
    }
    if (value.result.child_run_id !== value.link.child_run_id) {
      context.addIssue({ code: "custom", path: ["result", "child_run_id"], message: "result must match projected child Run" });
    }
  }
  if ((value.initial_message_event_id === undefined) !== (value.message_count === 0)) {
    context.addIssue({ code: "custom", path: ["initial_message_event_id"], message: "message_count and initial message must agree" });
  }
});
export type SubagentProjectionItem = z.infer<typeof SubagentProjectionItemSchema>;

export const SubagentListProjectionSchema = z.object({
  items: z.array(SubagentProjectionItemSchema).max(MAX_SUBAGENTS_PER_RUN),
  active_count: z.number().int().nonnegative().max(MAX_SUBAGENTS_PER_RUN),
  last_sequence: z.number().int().nonnegative(),
  limits: SubagentLimitsSchema,
}).strict().superRefine((value, context) => {
  const ids = value.items.map(({ link }) => link.subagent_id);
  const childRunIds = value.items.map(({ link }) => link.child_run_id);
  const childSessionIds = value.items.map(({ link }) => link.child_session_id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["items"], message: "subagent_id values must be unique" });
  }
  if (new Set(childRunIds).size !== childRunIds.length) {
    context.addIssue({ code: "custom", path: ["items"], message: "child_run_id values must be unique" });
  }
  if (new Set(childSessionIds).size !== childSessionIds.length) {
    context.addIssue({ code: "custom", path: ["items"], message: "child_session_id values must be unique" });
  }
  const active = value.items.filter(({ status }) => status === "running").length;
  if (active !== value.active_count) {
    context.addIssue({ code: "custom", path: ["active_count"], message: "active_count must equal running subagents" });
  }
  if (active > value.limits.max_parallel_subagents) {
    context.addIssue({ code: "custom", path: ["active_count"], message: "active subagents exceed the effective limit" });
  }
});
export type SubagentListProjection = z.infer<typeof SubagentListProjectionSchema>;

function resultMatchesLink(
  value: { link: SubagentRunLink; result: SubagentResult },
  context: z.RefinementCtx,
): void {
  if (value.result.subagent_id !== value.link.subagent_id) {
    context.addIssue({ code: "custom", path: ["result", "subagent_id"], message: "result must match the Run link" });
  }
  if (value.result.child_run_id !== value.link.child_run_id) {
    context.addIssue({ code: "custom", path: ["result", "child_run_id"], message: "result must match the Run link" });
  }
  value.result.artifact_refs.forEach((artifact, index) => {
    if (artifact.run_id !== value.link.child_run_id) {
      context.addIssue({
        code: "custom",
        path: ["result", "artifact_refs", index, "run_id"],
        message: "result Artifact must belong to the child Run",
      });
    }
  });
}

function sameLimits(left: SubagentLimits, right: SubagentLimits): boolean {
  return left.max_parallel_subagents === right.max_parallel_subagents
    && left.max_depth === right.max_depth;
}
