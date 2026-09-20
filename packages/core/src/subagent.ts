import {
  SubagentProfileSchema,
  ToolNameSchema,
  type SubagentBudget,
  type SubagentProfile,
  type ToolName,
} from "@tracegraph/contracts";
import { sha256 } from "./crypto.js";
import type { ModelAdapter } from "./types.js";

export const DEFAULT_MAX_PARALLEL_SUBAGENTS = 2;
export const DEFAULT_MAX_SUBAGENT_DEPTH = 1;
export const DEFAULT_SUBAGENT_MAX_STEPS = 6;
export const DEFAULT_SUBAGENT_MAX_TOKENS = 16_000;

export const DEFAULT_READONLY_SUBAGENT_TOOLS = Object.freeze([
  "read_file",
  "list_dir",
  "search",
  "read_artifact",
  "list_artifacts",
  "team_read",
  "team_task_write",
  "team_mailbox_send",
  "team_mailbox_claim",
  "team_heartbeat",
] satisfies readonly ToolName[]);

export interface SubagentProfileRegistration {
  /** Stable, model-selectable key. The registry itself remains Host-owned. */
  readonly name: string;
  readonly providerKey: string;
  readonly rolePromptVersion: string;
  readonly rolePrompt: string;
  readonly toolAllowlist: readonly ToolName[];
  readonly defaultBudget?: SubagentBudget;
  readonly budgetCeiling?: SubagentBudget;
  /** Optional profile-specific provider. Missing means inherit the root adapter. */
  readonly model?: ModelAdapter;
}

export interface ResolvedSubagentProfile {
  readonly name: string;
  readonly providerKey: string;
  readonly rolePromptVersion: string;
  readonly rolePrompt: string;
  readonly rolePromptHash: `sha256:${string}`;
  readonly toolAllowlist: readonly ToolName[];
  readonly defaultBudget: SubagentBudget;
  readonly budgetCeiling: SubagentBudget;
  readonly model: ModelAdapter;
}

/**
 * Trusted profile registry. Untrusted model input may select `name`, but it
 * can never supply provider credentials, a role prompt, or an allowlist.
 */
export class SubagentRegistry {
  readonly #profiles = new Map<string, Readonly<SubagentProfileRegistration>>();

  constructor(profiles: readonly SubagentProfileRegistration[] = []) {
    for (const profile of profiles) this.register(profile);
  }

  static withReadonlyDefault(parentModel?: ModelAdapter): SubagentRegistry {
    return new SubagentRegistry([{
      name: "readonly",
      providerKey: "parent",
      rolePromptVersion: "tracegraph.subagent.readonly.v1",
      rolePrompt: [
        "You are a bounded read-only TraceGraph subagent.",
        "Complete only the delegated task packet, use only the exposed tools,",
        "and return a concise evidence-backed result to the parent agent.",
      ].join(" "),
      toolAllowlist: DEFAULT_READONLY_SUBAGENT_TOOLS,
      defaultBudget: {
        max_steps: DEFAULT_SUBAGENT_MAX_STEPS,
        max_tokens: DEFAULT_SUBAGENT_MAX_TOKENS,
      },
      budgetCeiling: {
        max_steps: DEFAULT_SUBAGENT_MAX_STEPS,
        max_tokens: DEFAULT_SUBAGENT_MAX_TOKENS,
      },
      ...(parentModel === undefined ? {} : { model: parentModel }),
    }]);
  }

  register(input: SubagentProfileRegistration): void {
    const name = boundedKey(input.name, "profile name");
    const providerKey = boundedKey(input.providerKey, "provider key");
    const rolePromptVersion = boundedKey(input.rolePromptVersion, "role prompt version");
    const rolePrompt = input.rolePrompt.trim();
    if (rolePrompt.length === 0 || rolePrompt.length > 8_000) {
      throw new RangeError("subagent role prompt must contain 1..8000 characters");
    }
    const toolAllowlist = [...new Set(input.toolAllowlist.map((name_) => ToolNameSchema.parse(name_)))];
    if (toolAllowlist.length === 0) throw new RangeError("subagent tool allowlist must not be empty");
    const publicProfile = SubagentProfileSchema.parse({
      name,
      provider_key: providerKey,
      role_prompt_version: rolePromptVersion,
      role_prompt_hash: sha256(rolePrompt),
      tool_allowlist: toolAllowlist,
      default_budget: input.defaultBudget ?? {
        max_steps: DEFAULT_SUBAGENT_MAX_STEPS,
        max_tokens: DEFAULT_SUBAGENT_MAX_TOKENS,
      },
      budget_ceiling: input.budgetCeiling ?? input.defaultBudget ?? {
        max_steps: DEFAULT_SUBAGENT_MAX_STEPS,
        max_tokens: DEFAULT_SUBAGENT_MAX_TOKENS,
      },
    });
    if (this.#profiles.has(name)) throw new Error(`subagent profile ${name} is already registered`);
    this.#profiles.set(name, Object.freeze({
      name,
      providerKey,
      rolePromptVersion,
      rolePrompt,
      toolAllowlist: Object.freeze([...publicProfile.tool_allowlist] as ToolName[]),
      defaultBudget: publicProfile.default_budget,
      budgetCeiling: publicProfile.budget_ceiling,
      ...(input.model === undefined ? {} : { model: input.model }),
    }));
  }

  resolve(nameValue: string, parentModel: ModelAdapter): ResolvedSubagentProfile {
    const name = boundedKey(nameValue, "profile name");
    const profile = this.#profiles.get(name);
    if (profile === undefined) throw new SubagentDomainError("profile_not_found", `Unknown subagent profile ${name}`);
    return Object.freeze({
      name: profile.name,
      providerKey: profile.providerKey,
      rolePromptVersion: profile.rolePromptVersion,
      rolePrompt: profile.rolePrompt,
      rolePromptHash: sha256(profile.rolePrompt),
      toolAllowlist: profile.toolAllowlist,
      defaultBudget: profile.defaultBudget ?? {
        max_steps: DEFAULT_SUBAGENT_MAX_STEPS,
        max_tokens: DEFAULT_SUBAGENT_MAX_TOKENS,
      },
      budgetCeiling: profile.budgetCeiling ?? profile.defaultBudget ?? {
        max_steps: DEFAULT_SUBAGENT_MAX_STEPS,
        max_tokens: DEFAULT_SUBAGENT_MAX_TOKENS,
      },
      model: profile.model ?? parentModel,
    });
  }

  list(): readonly SubagentProfile[] {
    return [...this.#profiles.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((profile) => Object.freeze({
        name: profile.name,
        providerKey: profile.providerKey,
        rolePromptVersion: profile.rolePromptVersion,
        rolePromptHash: sha256(profile.rolePrompt),
        toolAllowlist: profile.toolAllowlist,
        defaultBudget: profile.defaultBudget ?? {
          max_steps: DEFAULT_SUBAGENT_MAX_STEPS,
          max_tokens: DEFAULT_SUBAGENT_MAX_TOKENS,
        },
        budgetCeiling: profile.budgetCeiling ?? profile.defaultBudget ?? {
          max_steps: DEFAULT_SUBAGENT_MAX_STEPS,
          max_tokens: DEFAULT_SUBAGENT_MAX_TOKENS,
        },
      }))
      .map((profile) => SubagentProfileSchema.parse({
        name: profile.name,
        provider_key: profile.providerKey,
        role_prompt_version: profile.rolePromptVersion,
        role_prompt_hash: profile.rolePromptHash,
        tool_allowlist: profile.toolAllowlist,
        default_budget: profile.defaultBudget,
        budget_ceiling: profile.budgetCeiling,
      }));
  }
}

/** Process-local fair semaphore used as the hard active-child ceiling. */
export class SubagentPermitPool {
  readonly #maximum: number;
  #active = 0;
  readonly #waiters: Array<{
    resolve(release: () => void): void;
    reject(error: Error): void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  constructor(maximum = DEFAULT_MAX_PARALLEL_SUBAGENTS) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32) {
      throw new RangeError("maxParallelSubagents must be an integer between 1 and 32");
    }
    this.#maximum = maximum;
  }

  get maximum(): number {
    return this.#maximum;
  }

  get active(): number {
    return this.#active;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (this.#active < this.#maximum) {
      this.#active += 1;
      return Promise.resolve(this.#releaseOnce());
    }
    return new Promise((resolve, reject) => {
      const waiter: {
        resolve(release: () => void): void;
        reject(error: Error): void;
        signal?: AbortSignal;
        onAbort?: () => void;
      } = { resolve, reject, ...(signal === undefined ? {} : { signal }) };
      if (signal !== undefined) {
        waiter.onAbort = () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(abortError(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.#waiters.push(waiter);
    });
  }

  #releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.#waiters.shift();
      if (waiter !== undefined) {
        if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
        waiter.resolve(this.#releaseOnce());
        return;
      }
      this.#active = Math.max(0, this.#active - 1);
    };
  }
}

export class SubagentDomainError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SubagentDomainError";
  }
}

function boundedKey(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 160 || !/^[A-Za-z0-9_.:-]+$/u.test(normalized)) {
    throw new RangeError(`${label} is invalid`);
  }
  return normalized;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Subagent permit acquisition aborted");
}
