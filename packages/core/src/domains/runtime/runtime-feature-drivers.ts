import type {
  RetrievedMemoryHit,
  RetrievedExperienceHit,
  ToolName,
} from "@tracegraph/contracts";
import type { WorkspaceHandle } from "@tracegraph/contracts";
import type { ToolExecutionContext } from "../../kernel/tool/definition.js";

export const RUNTIME_FEATURE_IDS = ["memory", "experience", "team", "todo", "attachment"] as const;
export type RuntimeFeatureId = typeof RUNTIME_FEATURE_IDS[number];

const RUNTIME_FEATURE_ID_SET = new Set<string>(RUNTIME_FEATURE_IDS);

export function normalizeDisabledRuntimeFeatures(
  features: readonly RuntimeFeatureId[] | undefined,
): ReadonlySet<RuntimeFeatureId> {
  const disabled = new Set<RuntimeFeatureId>();
  for (const feature of features ?? []) {
    if (!RUNTIME_FEATURE_ID_SET.has(feature)) {
      throw new TypeError(`Unknown Runtime feature: ${String(feature)}`);
    }
    if (disabled.has(feature)) {
      throw new TypeError(`Runtime feature is listed as disabled more than once: ${feature}`);
    }
    disabled.add(feature);
  }
  return disabled;
}

export interface RuntimeFeatureTurnContext {
  readonly projectId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly task: string;
  readonly turn: number;
  readonly signal: AbortSignal;
}

export interface RuntimeFeatureTurnContribution {
  readonly retrievedMemory?: readonly RetrievedMemoryHit[];
  readonly retrievedExperience?: readonly RetrievedExperienceHit[];
}

export interface RuntimeFeatureRunCreatedContext {
  readonly projectId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly uploadIds: readonly string[];
  /** Runtime-owned durable claim, called by the Attachment contribution. */
  readonly claimAttachments: () => Promise<void>;
}

export interface RuntimeFeatureToolContext {
  readonly projectId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly workspace: WorkspaceHandle;
  readonly actionId: string;
  readonly delegation?: {
    readonly link: {
      readonly parent_run_id: string;
      readonly parent_session_id: string;
      readonly subagent_id: string;
    };
  };
}

export type RuntimeFeatureToolContribution = Pick<ToolExecutionContext, "todos" | "team">;

/**
 * A built-in Runtime feature contributes only at named lifecycle seams. It
 * does not own Run state or load code; the Runtime passes the narrow bridges
 * required for that contribution.
 */
export interface RuntimeFeatureDriver {
  readonly id: RuntimeFeatureId;
  readonly tools?: readonly ToolName[];
  readonly onRunCreated?: (context: RuntimeFeatureRunCreatedContext) => Promise<void>;
  readonly contributeTurn?: (
    context: RuntimeFeatureTurnContext,
  ) => Promise<RuntimeFeatureTurnContribution>;
  readonly contributeToolContext?: (
    context: RuntimeFeatureToolContext,
  ) => Promise<RuntimeFeatureToolContribution>;
}

export class RuntimeFeatureDriverRegistry {
  readonly #drivers = new Map<RuntimeFeatureId, RuntimeFeatureDriver>();
  readonly #disabled: ReadonlySet<RuntimeFeatureId>;
  readonly #toolOwners = new Map<ToolName, RuntimeFeatureId>();

  constructor(disabled: readonly RuntimeFeatureId[] | undefined) {
    this.#disabled = normalizeDisabledRuntimeFeatures(disabled);
  }

  register(driver: RuntimeFeatureDriver): void {
    if (!RUNTIME_FEATURE_ID_SET.has(driver.id)) {
      throw new TypeError(`Unknown Runtime feature driver: ${String(driver.id)}`);
    }
    if (this.#drivers.has(driver.id)) {
      throw new TypeError(`Runtime feature driver is already registered: ${driver.id}`);
    }
    const tools = new Set<ToolName>();
    for (const tool of driver.tools ?? []) {
      const owner = this.#toolOwners.get(tool);
      if (owner !== undefined) {
        throw new TypeError(`Runtime Tool ${tool} is already owned by feature ${owner}`);
      }
      if (tools.has(tool)) throw new TypeError(`Runtime Tool ${tool} is listed more than once for ${driver.id}`);
      tools.add(tool);
    }
    for (const tool of tools) this.#toolOwners.set(tool, driver.id);
    this.#drivers.set(driver.id, driver);
  }

  isEnabled(feature: RuntimeFeatureId): boolean {
    return this.#drivers.has(feature) && !this.#disabled.has(feature);
  }

  isToolEnabled(tool: ToolName): boolean {
    const owner = this.#toolOwners.get(tool);
    return owner === undefined || this.isEnabled(owner);
  }

  disabledOwnerForTool(tool: ToolName): RuntimeFeatureId | undefined {
    const owner = this.#toolOwners.get(tool);
    return owner !== undefined && !this.isEnabled(owner) ? owner : undefined;
  }

  async onRunCreated(context: RuntimeFeatureRunCreatedContext): Promise<void> {
    for (const [feature, driver] of this.#drivers) {
      if (this.isEnabled(feature)) await driver.onRunCreated?.(context);
    }
  }

  async contributeTurn(context: RuntimeFeatureTurnContext): Promise<RuntimeFeatureTurnContribution> {
    const retrievedMemory: RetrievedMemoryHit[] = [];
    const retrievedExperience: RetrievedExperienceHit[] = [];
    for (const [feature, driver] of this.#drivers) {
      if (!this.isEnabled(feature)) continue;
      const contribution = await driver.contributeTurn?.(context);
      if (contribution?.retrievedMemory !== undefined) {
        retrievedMemory.push(...contribution.retrievedMemory);
      }
      if (contribution?.retrievedExperience !== undefined) {
        retrievedExperience.push(...contribution.retrievedExperience);
      }
    }
    return { retrievedMemory, retrievedExperience };
  }

  async contributeToolContext(context: RuntimeFeatureToolContext): Promise<RuntimeFeatureToolContribution> {
    let todos: RuntimeFeatureToolContribution["todos"];
    let team: RuntimeFeatureToolContribution["team"];
    for (const [feature, driver] of this.#drivers) {
      if (!this.isEnabled(feature)) continue;
      const next = await driver.contributeToolContext?.(context);
      if (next?.todos !== undefined) {
        if (todos !== undefined) throw new Error("More than one Runtime feature contributed Todo tools");
        todos = next.todos;
      }
      if (next?.team !== undefined) {
        if (team !== undefined) throw new Error("More than one Runtime feature contributed Team tools");
        team = next.team;
      }
    }
    return {
      ...(todos === undefined ? {} : { todos }),
      ...(team === undefined ? {} : { team }),
    };
  }
}
