import { z } from "zod";
import {
  ArtifactRefSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  RelativePathSchema,
  Sha256Schema,
  SourceRefSchema,
} from "./common.js";
import {
  TokenEstimateSchema,
  TokenSectionSchema,
  type TokenSection,
} from "./token.js";
import { RetrievalAttributionSchema } from "./memory.js";

/** Shared with token metering so section accounting cannot drift. */
export const ContextSectionSchema = TokenSectionSchema;
export type ContextSection = TokenSection;
export const ContextActionSchema = z.enum(["pinned", "kept", "truncated", "masked", "externalized", "retrieved"]);

const StrategyTokenThresholdSchema = z.number().int().positive().max(1_000_000);

export const ToolOutputPrunerPolicySchema = z.object({
  enabled: z.boolean(),
  threshold_tokens: StrategyTokenThresholdSchema,
  target_tokens: StrategyTokenThresholdSchema,
}).strict().superRefine((value, context) => {
  if (value.target_tokens > value.threshold_tokens) {
    context.addIssue({
      code: "custom",
      path: ["target_tokens"],
      message: "tool output pruner target must not exceed its threshold",
    });
  }
});
export type ToolOutputPrunerPolicy = z.infer<typeof ToolOutputPrunerPolicySchema>;

export const SpillPolicySchema = z.object({
  enabled: z.boolean(),
  threshold_tokens: StrategyTokenThresholdSchema,
  preview_tokens: StrategyTokenThresholdSchema,
}).strict().superRefine((value, context) => {
  if (value.preview_tokens > value.threshold_tokens) {
    context.addIssue({
      code: "custom",
      path: ["preview_tokens"],
      message: "spill preview must not exceed its threshold",
    });
  }
});
export type SpillPolicy = z.infer<typeof SpillPolicySchema>;

export const ModelSummaryPolicySchema = z.object({
  enabled: z.boolean(),
  threshold_tokens: StrategyTokenThresholdSchema,
  target_tokens: StrategyTokenThresholdSchema,
  timeout_ms: z.number().int().min(100).max(120_000),
  prompt_version: NonEmptyStringSchema.max(160),
}).strict().superRefine((value, context) => {
  if (value.target_tokens > value.threshold_tokens) {
    context.addIssue({
      code: "custom",
      path: ["target_tokens"],
      message: "model summary target must not exceed its threshold",
    });
  }
});
export type ModelSummaryPolicy = z.infer<typeof ModelSummaryPolicySchema>;

export const TieredCheckpointPolicySchema = z.object({
  enabled: z.boolean(),
  threshold_tokens: StrategyTokenThresholdSchema,
  target_tokens: StrategyTokenThresholdSchema,
}).strict().superRefine((value, context) => {
  if (value.target_tokens > value.threshold_tokens) {
    context.addIssue({
      code: "custom",
      path: ["target_tokens"],
      message: "tiered checkpoint target must not exceed its threshold",
    });
  }
});
export type TieredCheckpointPolicy = z.infer<typeof TieredCheckpointPolicySchema>;

/**
 * Optional so policies persisted before G-02 remain valid. Each strategy can
 * be configured independently without changing the legacy policy fields.
 */
export const ContextCompactionPolicySchema = z.object({
  tool_output_pruner: ToolOutputPrunerPolicySchema.optional(),
  spill: SpillPolicySchema.optional(),
  model_summary: ModelSummaryPolicySchema.optional(),
  tiered_checkpoint: TieredCheckpointPolicySchema.optional(),
}).strict();
export type ContextCompactionPolicy = z.infer<typeof ContextCompactionPolicySchema>;

/**
 * The Harness owns this policy, rather than assuming every configured model
 * accepts the same window. `window_tokens` is therefore a requested/effective
 * policy value that is emitted with every manifest for inspection.
 */
export const ContextPolicySchema = z.object({
  window_tokens: z.number().int().min(1_024).max(1_000_000),
  reserved_output_tokens: z.number().int().min(256).max(262_144),
  warning_ratio: z.number().min(0.5).max(0.95),
  compression_ratio: z.number().min(0.55).max(0.98),
  recent_history_messages: z.number().int().min(1).max(256),
  history_checkpoint_tokens: z.number().int().min(64).max(12_000),
  tool_budget_ratio: z.number().min(0.02).max(0.4),
  token_estimator: z.enum(["heuristic_v2", "provider_tokenizer"]),
  compaction: ContextCompactionPolicySchema.optional(),
}).superRefine((value, context) => {
  if (value.reserved_output_tokens >= value.window_tokens) {
    context.addIssue({
      code: "custom",
      path: ["reserved_output_tokens"],
      message: "reserved output must leave a positive input budget",
    });
  }
  if (value.warning_ratio >= value.compression_ratio) {
    context.addIssue({
      code: "custom",
      path: ["compression_ratio"],
      message: "compression ratio must be greater than warning ratio",
    });
  }
});
export type ContextPolicy = z.infer<typeof ContextPolicySchema>;

export const ContextBudgetStatusSchema = z.enum(["healthy", "warning", "compressed"]);
export type ContextBudgetStatus = z.infer<typeof ContextBudgetStatusSchema>;

/**
 * `strategy` below originally described only the history-checkpoint mechanism.
 * This additional field records every representation-changing compaction that
 * actually occurred, including bounded tool evidence. Keeping it separate is
 * backwards-compatible for consumers that only understand the legacy
 * checkpoint strategy while making the audit record truthful.
 */
export const ContextAppliedCompactionStrategySchema = z.enum([
  "none",
  "tiered_history_checkpoint",
  "bounded_history",
  "bounded_tool_output",
  "mixed",
  "strategy_chain",
]);
export type ContextAppliedCompactionStrategy = z.infer<typeof ContextAppliedCompactionStrategySchema>;

export const ContextBudgetSchema = z.object({
  input_budget_tokens: z.number().int().positive(),
  warning_threshold_tokens: z.number().int().nonnegative(),
  compression_threshold_tokens: z.number().int().nonnegative(),
  token_estimator: z.enum(["heuristic_v2", "provider_tokenizer"]),
  status: ContextBudgetStatusSchema,
}).superRefine((value, context) => {
  if (value.warning_threshold_tokens >= value.compression_threshold_tokens) {
    context.addIssue({
      code: "custom",
      path: ["compression_threshold_tokens"],
      message: "compression threshold must be greater than warning threshold",
    });
  }
  if (value.compression_threshold_tokens > value.input_budget_tokens) {
    context.addIssue({
      code: "custom",
      path: ["compression_threshold_tokens"],
      message: "compression threshold cannot exceed the input budget",
    });
  }
});
export type ContextBudget = z.infer<typeof ContextBudgetSchema>;

/**
 * This is an auditable description of the *context representation* change.
 * It deliberately does not contain the source conversation or model CoT.
 */
export const ContextCompressionSchema = z.object({
  /** The legacy history-checkpoint mechanism, if one was selected. */
  strategy: z.enum(["none", "tiered_history_checkpoint"]),
  /** The complete, effective compaction strategy applied to this Context. */
  // Old ContextManifest artifacts predate this field. Preserve their ability
  // to render/replay under the unchanged schema version; new writers always
  // provide the real effective strategy explicitly.
  applied_strategy: ContextAppliedCompactionStrategySchema.default("none"),
  trigger: z.enum(["within_budget", "warning_threshold", "compression_threshold", "hard_budget"]),
  before_tokens: z.number().int().nonnegative(),
  after_tokens: z.number().int().nonnegative(),
  original_history_tokens: z.number().int().nonnegative(),
  checkpoint_tokens: z.number().int().nonnegative(),
  preserved_recent_message_count: z.number().int().nonnegative(),
  compacted_history_message_count: z.number().int().nonnegative(),
});
export type ContextCompression = z.infer<typeof ContextCompressionSchema>;

/** A stable node in the append-only Context representation graph. */
export const ContextNodeSchema = z.object({
  node_id: IdentifierSchema,
  parent_node_id: IdentifierSchema.optional(),
  section: ContextSectionSchema,
  kind: z.enum(["raw", "summary", "spill_ref", "checkpoint", "retrieved"]),
  content_hash: Sha256Schema,
  tokens: z.number().int().nonnegative(),
  volatile: z.boolean(),
  superseded_by: IdentifierSchema.optional(),
  retrieval: RetrievalAttributionSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.parent_node_id === value.node_id) {
    context.addIssue({
      code: "custom",
      path: ["parent_node_id"],
      message: "a Context node cannot be its own parent",
    });
  }
  if (value.superseded_by === value.node_id) {
    context.addIssue({
      code: "custom",
      path: ["superseded_by"],
      message: "a Context node cannot supersede itself",
    });
  }
  if (value.kind === "retrieved" && (value.section !== "memory" || value.retrieval === undefined)) {
    context.addIssue({
      code: "custom",
      path: ["retrieval"],
      message: "retrieved Context nodes require memory provenance",
    });
  }
  if (value.kind === "retrieved" && value.retrieval?.injected_tokens !== value.tokens) {
    context.addIssue({
      code: "custom",
      path: ["tokens"],
      message: "retrieved node tokens must match retrieval evidence",
    });
  }
  if (value.kind !== "retrieved" && value.retrieval !== undefined) {
    context.addIssue({ code: "custom", path: ["retrieval"], message: "only retrieved nodes carry retrieval provenance" });
  }
});
export type ContextNode = z.infer<typeof ContextNodeSchema>;

/** Opaque locator returned to the model after a large tool output is spilled. */
export const SpillRefSchema = z.object({
  artifact_id: IdentifierSchema,
  kind: z.literal("spilled_tool_output"),
  locator: NonEmptyStringSchema.max(2_000),
  bytes: z.number().int().positive(),
  preview_tokens: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  if (value.locator !== `artifact:${value.artifact_id}`) {
    context.addIssue({
      code: "custom",
      path: ["locator"],
      message: "spill locator must equal artifact:<artifact_id>",
    });
  }
});
export type SpillRef = z.infer<typeof SpillRefSchema>;

export const ContextSummaryRefSchema = z.object({
  path: RelativePathSchema,
  lines: z.object({
    start: z.number().int().positive(),
    end: z.number().int().positive(),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.lines.end < value.lines.start) {
    context.addIssue({
      code: "custom",
      path: ["lines", "end"],
      message: "summary reference end line must not precede its start line",
    });
  }
});
export type ContextSummaryRef = z.infer<typeof ContextSummaryRefSchema>;

/** Structured, source-addressable output required from the summary model. */
export const ContextSummarySchema = z.object({
  facts: z.array(NonEmptyStringSchema.max(4_000)).max(512),
  open_questions: z.array(NonEmptyStringSchema.max(4_000)).max(256),
  refs: z.array(ContextSummaryRefSchema).max(512),
}).strict();
export type ContextSummary = z.infer<typeof ContextSummarySchema>;

export const CompactionStrategyIdSchema = z.enum([
  "tool_output_pruner",
  "spill",
  "model_summary",
  "tiered_checkpoint",
]);
export type CompactionStrategyId = z.infer<typeof CompactionStrategyIdSchema>;

/** One successful, auditable reduction in the ordered compaction chain. */
export const CompactionStepSchema = z.object({
  strategy_id: CompactionStrategyIdSchema,
  section: ContextSectionSchema,
  tokens_before: z.number().int().nonnegative(),
  tokens_after: z.number().int().nonnegative(),
  model_call_id: IdentifierSchema.optional(),
  prompt_version: NonEmptyStringSchema.max(160).optional(),
  archived_artifact_refs: z.array(ArtifactRefSchema).default([]),
}).strict().superRefine((value, context) => {
  if (value.tokens_after >= value.tokens_before) {
    context.addIssue({
      code: "custom",
      path: ["tokens_after"],
      message: "compaction step must strictly reduce token usage",
    });
  }
  if (value.strategy_id === "model_summary") {
    if (value.model_call_id === undefined) {
      context.addIssue({
        code: "custom",
        path: ["model_call_id"],
        message: "model summary steps require a model_call_id",
      });
    }
    if (value.prompt_version === undefined) {
      context.addIssue({
        code: "custom",
        path: ["prompt_version"],
        message: "model summary steps require a prompt_version",
      });
    }
  }
});
export type CompactionStep = z.infer<typeof CompactionStepSchema>;

export const ContextManifestItemSchema = z.object({
  item_id: IdentifierSchema,
  section: ContextSectionSchema,
  label: NonEmptyStringSchema,
  source: SourceRefSchema,
  original_tokens: z.number().int().nonnegative(),
  included_tokens: z.number().int().nonnegative(),
  action: ContextActionSchema,
  reason: NonEmptyStringSchema,
  content: z.string().max(12_000).optional(),
  artifact_ref: ArtifactRefSchema.optional(),
  retrieval: RetrievalAttributionSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.action === "retrieved") {
    if (value.section !== "memory" || value.retrieval === undefined || value.content === undefined) {
      context.addIssue({ code: "custom", path: ["retrieval"], message: "retrieved items require memory content and provenance" });
    } else if (value.retrieval.injected_tokens !== value.included_tokens) {
      context.addIssue({ code: "custom", path: ["included_tokens"], message: "retrieval token evidence must match included tokens" });
    }
  } else if (value.retrieval !== undefined) {
    context.addIssue({ code: "custom", path: ["retrieval"], message: "only retrieved items carry retrieval provenance" });
  }
});
export type ContextManifestItem = z.infer<typeof ContextManifestItemSchema>;

export const ContextManifestSchema = z.object({
  manifest_id: IdentifierSchema,
  project_id: IdentifierSchema,
  run_id: IdentifierSchema,
  turn_id: IdentifierSchema,
  model_call_id: IdentifierSchema,
  token_limit: z.number().int().positive(),
  reserved_output_tokens: z.number().int().nonnegative(),
  input_tokens: z.number().int().nonnegative(),
  /**
   * Applied preflight estimate. Provider-reported post-call usage is immutable
   * follow-up evidence in `model.usage_reported`, not a rewrite of this manifest.
   */
  token_estimate: TokenEstimateSchema.optional(),
  budget: ContextBudgetSchema.optional(),
  compression: ContextCompressionSchema.optional(),
  items: z.array(ContextManifestItemSchema),
  compaction_steps: z.array(CompactionStepSchema).optional(),
  nodes: z.array(ContextNodeSchema).optional(),
  fixed_constraints_preserved: z.boolean(),
  created_at: IsoDateTimeSchema,
  artifact_ref: ArtifactRefSchema.optional(),
}).superRefine((value, context) => {
  const compactionSteps = value.compaction_steps ?? [];
  const nodes = value.nodes ?? [];
  const availableInput = value.token_limit - value.reserved_output_tokens;
  if (availableInput < 0) {
    context.addIssue({
      code: "custom",
      path: ["reserved_output_tokens"],
      message: "reserved output cannot exceed the model token limit",
    });
  }
  if (value.input_tokens > availableInput) {
    context.addIssue({
      code: "custom",
      path: ["input_tokens"],
      message: "input token usage exceeds the available context budget",
    });
  }
  if (value.budget !== undefined) {
    if (value.budget.input_budget_tokens !== availableInput) {
      context.addIssue({
        code: "custom",
        path: ["budget", "input_budget_tokens"],
        message: "input budget must equal token_limit minus reserved_output_tokens",
      });
    }
    if (value.budget.status === "healthy" && value.input_tokens >= value.budget.warning_threshold_tokens) {
      context.addIssue({
        code: "custom",
        path: ["budget", "status"],
        message: "healthy context usage must remain below the warning threshold",
      });
    }
    if (value.budget.status === "warning" && value.input_tokens < value.budget.warning_threshold_tokens) {
      context.addIssue({
        code: "custom",
        path: ["budget", "status"],
        message: "warning context usage must reach the warning threshold",
      });
    }
  }
  if (value.compression !== undefined && value.compression.after_tokens !== value.input_tokens) {
    context.addIssue({
      code: "custom",
      path: ["compression", "after_tokens"],
      message: "compression after_tokens must equal manifest input_tokens",
    });
  }
  if (compactionSteps.length > 0) {
    if (value.compression === undefined) {
      context.addIssue({
        code: "custom",
        path: ["compaction_steps"],
        message: "compaction steps require compression accounting",
      });
    } else {
      const firstStep = compactionSteps[0];
      const lastStep = compactionSteps[compactionSteps.length - 1];
      if (firstStep !== undefined && firstStep.tokens_before !== value.compression.before_tokens) {
        context.addIssue({
          code: "custom",
          path: ["compaction_steps", 0, "tokens_before"],
          message: "the first compaction step must start at compression before_tokens",
        });
      }
      if (lastStep !== undefined && lastStep.tokens_after !== value.input_tokens) {
        context.addIssue({
          code: "custom",
          path: ["compaction_steps", compactionSteps.length - 1, "tokens_after"],
          message: "the final compaction step must end at manifest input_tokens",
        });
      }
      const explainedReduction = compactionSteps.reduce(
        (total, step) => total + step.tokens_before - step.tokens_after,
        0,
      );
      if (explainedReduction !== value.compression.before_tokens - value.compression.after_tokens) {
        context.addIssue({
          code: "custom",
          path: ["compaction_steps"],
          message: "compaction step reductions must explain the manifest token reduction",
        });
      }
      if (compactionSteps.length > 1 && value.compression.applied_strategy !== "strategy_chain") {
        context.addIssue({
          code: "custom",
          path: ["compression", "applied_strategy"],
          message: "multiple compaction steps require the strategy_chain applied strategy",
        });
      }
    }
  }
  for (let index = 1; index < compactionSteps.length; index += 1) {
    const previous = compactionSteps[index - 1];
    const current = compactionSteps[index];
    if (previous !== undefined && current !== undefined && previous.tokens_after !== current.tokens_before) {
      context.addIssue({
        code: "custom",
        path: ["compaction_steps", index, "tokens_before"],
        message: "compaction steps must form a continuous token-accounting chain",
      });
    }
    if (previous !== undefined && current !== undefined) {
      const strategyOrder = {
        tool_output_pruner: 0,
        spill: 1,
        model_summary: 2,
        tiered_checkpoint: 3,
      } as const;
      if (strategyOrder[current.strategy_id] < strategyOrder[previous.strategy_id]) {
        context.addIssue({
          code: "custom",
          path: ["compaction_steps", index, "strategy_id"],
          message: "compaction strategies must follow pruner, spill, summary, checkpoint order",
        });
      }
      if (
        current.strategy_id === previous.strategy_id
        && current.strategy_id !== "tiered_checkpoint"
      ) {
        context.addIssue({
          code: "custom",
          path: ["compaction_steps", index, "strategy_id"],
          message: "only tiered checkpoint may repeat across Context sections",
        });
      }
    }
  }
  const archivedArtifactIds = new Set<string>();
  for (const [stepIndex, step] of compactionSteps.entries()) {
    for (const [artifactIndex, artifact] of step.archived_artifact_refs.entries()) {
      const path = ["compaction_steps", stepIndex, "archived_artifact_refs", artifactIndex];
      if (artifact.project_id !== value.project_id || artifact.run_id !== value.run_id) {
        context.addIssue({
          code: "custom",
          path,
          message: "compaction archive artifacts must belong to the manifest project and run",
        });
      }
      if (artifact.kind !== "spilled_tool_output" && artifact.kind !== "context_source_archive") {
        context.addIssue({
          code: "custom",
          path: [...path, "kind"],
          message: "compaction archive artifacts must use a Context archive kind",
        });
      }
      if (archivedArtifactIds.has(artifact.artifact_id)) {
        context.addIssue({
          code: "custom",
          path: [...path, "artifact_id"],
          message: "compaction archive artifacts must be unique across steps",
        });
      }
      archivedArtifactIds.add(artifact.artifact_id);
    }
  }
  const nodeIds = new Set<string>();
  for (const [index, node] of nodes.entries()) {
    if (nodeIds.has(node.node_id)) {
      context.addIssue({
        code: "custom",
        path: ["nodes", index, "node_id"],
        message: "Context node IDs must be unique",
      });
    }
    nodeIds.add(node.node_id);
  }
  for (const [index, node] of nodes.entries()) {
    if (node.parent_node_id !== undefined && !nodeIds.has(node.parent_node_id)) {
      context.addIssue({
        code: "custom",
        path: ["nodes", index, "parent_node_id"],
        message: "Context node parent must exist in the same manifest",
      });
    }
    if (node.superseded_by !== undefined && !nodeIds.has(node.superseded_by)) {
      context.addIssue({
        code: "custom",
        path: ["nodes", index, "superseded_by"],
        message: "superseding Context node must exist in the same manifest",
      });
    }
  }
  if (value.nodes !== undefined) {
    const activeNodes = nodes.filter((node) => node.superseded_by === undefined);
    const activeNodeTotal = activeNodes.reduce((total, node) => total + node.tokens, 0);
    if (activeNodeTotal !== value.input_tokens) {
      context.addIssue({
        code: "custom",
        path: ["nodes"],
        message: "active Context node tokens must equal manifest input_tokens",
      });
    }
    if (value.token_estimate !== undefined) {
      const nodeSectionTotals: Record<TokenSection, number> = {
        system: 0,
        goal: 0,
        history: 0,
        tool: 0,
        repo: 0,
        memory: 0,
      };
      for (const node of activeNodes) nodeSectionTotals[node.section] += node.tokens;
      for (const section of TokenSectionSchema.options) {
        if (nodeSectionTotals[section] !== value.token_estimate.per_section[section]) {
          context.addIssue({
            code: "custom",
            path: ["nodes"],
            message: `active Context node tokens for ${section} must match token_estimate`,
          });
        }
      }
    }
    if (value.compression !== undefined) {
      const checkpointTokens = activeNodes.reduce(
        (total, node) => node.kind === "checkpoint" ? total + node.tokens : total,
        0,
      );
      if (checkpointTokens !== value.compression.checkpoint_tokens) {
        context.addIssue({
          code: "custom",
          path: ["compression", "checkpoint_tokens"],
          message: "checkpoint token usage must equal active checkpoint node tokens",
        });
      }
    }
    const retrievedItems = value.items.filter((item) => item.action === "retrieved");
    const retrievedNodes = activeNodes.filter((node) => node.kind === "retrieved");
    for (const [index, item] of retrievedItems.entries()) {
      const matchingNode = retrievedNodes.find((node) => (
        node.retrieval !== undefined
        && item.retrieval !== undefined
        && node.retrieval.hit_id === item.retrieval.hit_id
        && node.retrieval.content_hash === item.retrieval.content_hash
        && node.tokens === item.included_tokens
      ));
      if (matchingNode === undefined) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "retrieval"],
          message: "retrieved item must have a matching active Context node",
        });
      }
    }
    for (const [index, node] of retrievedNodes.entries()) {
      if (!retrievedItems.some((item) => item.retrieval?.hit_id === node.retrieval?.hit_id)) {
        context.addIssue({
          code: "custom",
          path: ["nodes", index, "retrieval"],
          message: "retrieved node must have a matching manifest item",
        });
      }
    }
  }
  if (value.compression?.applied_strategy === "strategy_chain" && compactionSteps.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["compaction_steps"],
      message: "strategy_chain requires at least one compaction step",
    });
  }
  if (value.budget !== undefined && value.compression !== undefined) {
    const changed = value.compression.applied_strategy !== "none"
      || value.compression.strategy === "tiered_history_checkpoint";
    if ((value.budget.status === "compressed") !== changed) {
      context.addIssue({
        code: "custom",
        path: ["budget", "status"],
        message: "compressed status must match an applied Context representation change",
      });
    }
  }
  const itemTotal = value.items.reduce((total, item) => total + item.included_tokens, 0);
  if (itemTotal !== value.input_tokens) {
    context.addIssue({
      code: "custom",
      path: ["input_tokens"],
      message: "input token usage must equal the sum of included item tokens",
    });
  }
  if (value.token_estimate !== undefined) {
    if (value.token_estimate.input_tokens !== value.input_tokens) {
      context.addIssue({
        code: "custom",
        path: ["token_estimate", "input_tokens"],
        message: "token estimate input usage must equal manifest input_tokens",
      });
    }
    const itemSectionTotals: Record<TokenSection, number> = {
      system: 0,
      goal: 0,
      history: 0,
      tool: 0,
      repo: 0,
      memory: 0,
    };
    for (const item of value.items) itemSectionTotals[item.section] += item.included_tokens;
    for (const section of TokenSectionSchema.options) {
      if (value.token_estimate.per_section[section] !== itemSectionTotals[section]) {
        context.addIssue({
          code: "custom",
          path: ["token_estimate", "per_section", section],
          message: "token estimate section usage must equal visible manifest item usage",
        });
      }
    }
  }
  for (const [index, item] of value.items.entries()) {
    if (item.included_tokens > item.original_tokens) {
      context.addIssue({
        code: "custom",
        path: ["items", index, "included_tokens"],
        message: "included tokens cannot exceed original tokens",
      });
    }
    if (item.action === "masked" && item.included_tokens !== 0) {
      context.addIssue({
        code: "custom",
        path: ["items", index, "included_tokens"],
        message: "masked items cannot consume model-visible tokens",
      });
    }
  }
});
export type ContextManifest = z.infer<typeof ContextManifestSchema>;
