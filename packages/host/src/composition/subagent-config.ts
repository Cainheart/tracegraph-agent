import {
  SubagentBudgetSchema,
  SubagentLimitsSchema,
  type SubagentLimits,
  type SubagentProfile,
  type ToolName,
} from "@tracegraph/contracts";
import {
  DEFAULT_READONLY_SUBAGENT_TOOLS,
  DEFAULT_SUBAGENT_MAX_STEPS,
  DEFAULT_SUBAGENT_MAX_TOKENS,
  SubagentRegistry,
} from "@tracegraph/core";

type TrustedProfileKey = "readonly" | "code-explorer" | "evidence-reviewer";

interface TrustedProfileDefinition {
  readonly name: TrustedProfileKey;
  readonly rolePromptVersion: string;
  readonly rolePrompt: string;
  readonly toolAllowlist: readonly ToolName[];
}

/**
 * Every compiled-in worker can coordinate through the root Team ledger while
 * retaining the same read-only Workspace boundary. This authority remains
 * Host-owned and is never accepted from CLI, HTTP, or model input.
 */
const TRUSTED_TEAM_WORKER_TOOLS = Object.freeze([
  "team_read",
  "team_task_write",
  "team_mailbox_send",
  "team_mailbox_claim",
  "team_heartbeat",
] satisfies readonly ToolName[]);

const CODE_REVIEW_TOOLS = Object.freeze([
  "read_file",
  "list_dir",
  "search",
  "read_artifact",
  "list_artifacts",
  ...TRUSTED_TEAM_WORKER_TOOLS,
] satisfies readonly ToolName[]);

const TRUSTED_PROFILES: Readonly<Record<TrustedProfileKey, TrustedProfileDefinition>> = {
  readonly: {
    name: "readonly",
    rolePromptVersion: "tracegraph.subagent.readonly.v1",
    rolePrompt: [
      "You are a bounded read-only TraceGraph subagent.",
      "Complete only the delegated task packet, use only the exposed tools,",
      "and return a concise evidence-backed result to the parent agent.",
    ].join(" "),
    toolAllowlist: DEFAULT_READONLY_SUBAGENT_TOOLS,
  },
  "code-explorer": {
    name: "code-explorer",
    rolePromptVersion: "tracegraph.subagent.code-explorer.v1",
    rolePrompt: [
      "Inspect code without changing the workspace.",
      "Trace concrete definitions and call sites, cite the evidence you read,",
      "and return only findings that satisfy the delegated task packet.",
    ].join(" "),
    toolAllowlist: CODE_REVIEW_TOOLS,
  },
  "evidence-reviewer": {
    name: "evidence-reviewer",
    rolePromptVersion: "tracegraph.subagent.evidence-reviewer.v1",
    rolePrompt: [
      "Review existing TraceGraph evidence without mutating the workspace.",
      "Check claims against readable files and Artifacts, identify uncertainty,",
      "and return a bounded evidence-backed result to the parent agent.",
    ].join(" "),
    toolAllowlist: CODE_REVIEW_TOOLS,
  },
};

export interface ConfigureSubagentsOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly profilesFlag?: string | undefined;
  readonly maxParallelFlag?: string | undefined;
  readonly maxDepthFlag?: string | undefined;
  readonly maxStepsFlag?: string | undefined;
  readonly maxTokensFlag?: string | undefined;
}

export interface ConfiguredSubagents {
  /** Trusted registry passed directly to Runtime; never accepted over HTTP or model input. */
  readonly registry: SubagentRegistry;
  readonly limits: SubagentLimits;
  readonly profiles: readonly SubagentProfile[];
}

/**
 * Resolve trusted local subagent composition. Flags outrank environment, while
 * profile prompts, provider binding, and tool allowlists come exclusively from
 * the compiled-in catalog above.
 */
export function createConfiguredSubagents(
  options: ConfigureSubagentsOptions = {},
): ConfiguredSubagents {
  const environment = options.environment ?? process.env;
  const limits = SubagentLimitsSchema.parse({
    max_parallel_subagents: boundedInteger(
      options.maxParallelFlag ?? environment.TRACEGRAPH_MAX_PARALLEL_SUBAGENTS,
      "max parallel subagents",
      1,
      16,
      2,
    ),
    max_depth: boundedInteger(
      options.maxDepthFlag ?? environment.TRACEGRAPH_MAX_SUBAGENT_DEPTH,
      "max subagent depth",
      1,
      4,
      1,
    ),
  });
  const budget = SubagentBudgetSchema.parse({
    max_steps: boundedInteger(
      options.maxStepsFlag ?? environment.TRACEGRAPH_SUBAGENT_MAX_STEPS,
      "subagent max steps",
      1,
      1_000,
      DEFAULT_SUBAGENT_MAX_STEPS,
    ),
    max_tokens: boundedInteger(
      options.maxTokensFlag ?? environment.TRACEGRAPH_SUBAGENT_MAX_TOKENS,
      "subagent max tokens",
      1,
      Number.MAX_SAFE_INTEGER,
      DEFAULT_SUBAGENT_MAX_TOKENS,
    ),
  });
  const selected = parseProfileSelection(
    options.profilesFlag ?? environment.TRACEGRAPH_SUBAGENT_PROFILES ?? "readonly",
  );
  const registry = new SubagentRegistry(selected.map((name) => {
    const profile = TRUSTED_PROFILES[name];
    return {
      name: profile.name,
      providerKey: "parent",
      rolePromptVersion: profile.rolePromptVersion,
      rolePrompt: profile.rolePrompt,
      toolAllowlist: profile.toolAllowlist,
      defaultBudget: budget,
      budgetCeiling: budget,
    };
  }));
  return Object.freeze({ registry, limits, profiles: registry.list() });
}

function parseProfileSelection(value: string): readonly TrustedProfileKey[] {
  const names = [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
  if (names.length === 0) throw new TypeError("At least one trusted subagent profile must be enabled");
  return names.map((name) => {
    if (!(name in TRUSTED_PROFILES)) {
      throw new TypeError(`Unknown trusted subagent profile ${name}`);
    }
    return name as TrustedProfileKey;
  });
}

function boundedInteger(
  value: string | undefined,
  label: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}
