import {
  BoundedJsonSchemaSchema,
  ModelToolSchema,
  ToolCallSchema,
  ToolDescriptorSchema,
  ValidatedActionSchema,
  toModelToolSchema,
  type BoundedJsonSchema,
  type ModelTool,
  type RunMode,
  type SandboxMode,
  type ToolCall,
  type ToolDescriptor,
  type ToolName,
  type ValidatedAction,
  type WorkspaceHandle,
} from "@tracegraph/contracts";
import { z } from "zod";

import { ActionRejectedError } from "./errors.js";
import { MIN_TOOL_RESULT_ENVELOPE_BYTES } from "./constants.js";
import type { ToolDefinition } from "./definition.js";
import { isPlainObject } from "./utils.js";

type AnyToolDefinition = ToolDefinition<any, any>;

/** Registry mechanics only; Core supplies the actual built-in definitions. */
export class ToolRegistry {
  readonly #definitions = new Map<ToolName, AnyToolDefinition>();
  readonly #descriptors = new Map<ToolName, ToolDescriptor>();
  readonly #tokens = new Map<ToolName, symbol>();

  constructor(definitions: readonly AnyToolDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): { dispose(): void } {
    const descriptor = toolDescriptor(definition);
    const previousDefinition = this.#definitions.get(definition.name);
    const previousDescriptor = this.#descriptors.get(definition.name);
    const previousToken = this.#tokens.get(definition.name);
    const token = Symbol(definition.name);
    this.#definitions.set(definition.name, definition as unknown as AnyToolDefinition);
    this.#descriptors.set(definition.name, descriptor);
    this.#tokens.set(definition.name, token);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.#tokens.get(definition.name) !== token) return;
        if (previousDefinition === undefined || previousDescriptor === undefined) {
          this.#definitions.delete(definition.name);
          this.#descriptors.delete(definition.name);
          this.#tokens.delete(definition.name);
          return;
        }
        this.#definitions.set(definition.name, previousDefinition);
        this.#descriptors.set(definition.name, previousDescriptor);
        if (previousToken === undefined) this.#tokens.delete(definition.name);
        else this.#tokens.set(definition.name, previousToken);
      },
    };
  }

  get(name: ToolName): AnyToolDefinition | undefined {
    return this.#definitions.get(name);
  }

  list(): readonly AnyToolDefinition[] {
    return [...this.#definitions.values()];
  }

  descriptors(): readonly ToolDescriptor[] {
    return [...this.#descriptors.values()];
  }

  /** Explicit projection keeps Host-only executors and policies model-private. */
  modelSchemas(allowlist?: ReadonlySet<ToolName>): readonly ModelTool[] {
    return this.descriptors()
      .filter((descriptor) => allowlist === undefined || allowlist.has(descriptor.name))
      .map((descriptor) => ModelToolSchema.parse(toModelToolSchema(descriptor)));
  }
}

function toolDescriptor<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): ToolDescriptor {
  if (definition.maxResultBytes < MIN_TOOL_RESULT_ENVELOPE_BYTES) {
    throw new RangeError(`maxResultBytes must be at least ${MIN_TOOL_RESULT_ENVELOPE_BYTES}`);
  }
  return ToolDescriptorSchema.parse({
    ...(definition.workspaceIndependent===undefined?{}:{workspace_independent:definition.workspaceIndependent}),
    name: definition.name,
    description: definition.description,
    input_schema: definition.modelInputSchema === undefined
      ? boundedJsonSchema(definition.inputSchema)
      : BoundedJsonSchemaSchema.parse(definition.modelInputSchema),
    output_schema: boundedJsonSchema(definition.outputSchema),
    timeout_ms: definition.timeoutMs,
    concurrency_safe: definition.concurrencySafe,
    side_effect: definition.sideEffect,
    max_result_bytes: definition.maxResultBytes,
  });
}

function boundedJsonSchema(schema: z.ZodType): BoundedJsonSchema {
  const generated = z.toJSONSchema(schema);
  return BoundedJsonSchemaSchema.parse(normalizeGeneratedJsonSchema(generated));
}

function normalizeGeneratedJsonSchema(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    if (key === "$schema" || key === "propertyNames") continue;
    if (key === "exclusiveMinimum" && typeof member === "number" && Number.isInteger(member)) {
      normalized.minimum = member + 1;
      continue;
    }
    if (key === "properties" && isPlainObject(member)) {
      normalized.properties = Object.fromEntries(
        Object.entries(member).map(([name, child]) => [name, normalizeGeneratedJsonSchema(child)]),
      );
      continue;
    }
    if (key === "additionalProperties" && isPlainObject(member)) {
      normalized.additionalProperties = Object.keys(member).length === 0
        ? true
        : normalizeGeneratedJsonSchema(member);
      continue;
    }
    if (key === "items") {
      normalized.items = normalizeGeneratedJsonSchema(member);
      continue;
    }
    if ((key === "anyOf" || key === "oneOf") && Array.isArray(member)) {
      normalized[key] = member.map(normalizeGeneratedJsonSchema);
      continue;
    }
    normalized[key] = member;
  }
  return normalized;
}

export interface ValidateToolCallInput {
  call: ToolCall;
  registry: ToolRegistry;
  projectId: string;
  runId: string;
  workspace: WorkspaceHandle;
  mode: RunMode;
  sandboxMode: SandboxMode;
  now: Date;
  approvalId?: string;
  approvalTokenId?: string;
  actionDigest?: string;
  policyDigest?: string;
  /** Core Runtime already evaluated all hard constraints for this Run. */
  policyPrevalidated?: boolean;
}

export function validateToolCall(input: ValidateToolCallInput): {
  action: ValidatedAction;
  parsedInput: unknown;
  definition: AnyToolDefinition;
} {
  const call = ToolCallSchema.parse(input.call);
  const definition = input.registry.get(call.tool_name);
  if (definition === undefined) {
    throw new ActionRejectedError("tool_not_registered", `Tool ${call.tool_name} is not registered`);
  }
  const parsedInput = definition.inputSchema.safeParse(call.arguments);
  if (!parsedInput.success) {
    throw new ActionRejectedError("schema_invalid", parsedInput.error.message);
  }
  if (input.policyPrevalidated !== true) {
    if (
      call.tool_name !== "read_artifact"
      && call.tool_name !== "list_artifacts"
      && call.tool_name !== "todo_read"
      && call.tool_name !== "todo_write"
      && definition.workspaceIndependent !== true
      && !input.workspace.capabilities[definition.capability]
    ) {
      throw new ActionRejectedError("capability_denied", `${definition.capability} is disabled by WorkspaceHandle`);
    }
    if (input.mode === "plan" && !planModeDefinitionAllowed(definition)) {
      throw new ActionRejectedError("plan_mode_denied", `${call.tool_name} is not available in plan mode`);
    }
    if (input.sandboxMode === "read-only" && definition.sideEffect === "write") {
      throw new ActionRejectedError(
        "sandbox_denied",
        `${call.tool_name} cannot write while the Host sandbox mode is read-only`,
      );
    }
    if (definition.requiresApproval && input.approvalId === undefined) {
      throw new ActionRejectedError("approval_required", `${call.tool_name} requires a one-time approval`);
    }
  }
  return {
    definition,
    parsedInput: parsedInput.data,
    action: ValidatedActionSchema.parse({
      action_id: call.action_id,
      tool_name: call.tool_name,
      arguments: call.arguments,
      project_id: input.projectId,
      run_id: input.runId,
      workspace_handle_id: input.workspace.handle_id,
      validated_at: input.now.toISOString(),
      ...(input.approvalId === undefined ? {} : { approval_id: input.approvalId }),
      ...(input.approvalTokenId === undefined ? {} : { approval_token_id: input.approvalTokenId }),
      ...(input.actionDigest === undefined ? {} : { action_digest: input.actionDigest }),
      ...(input.policyDigest === undefined ? {} : { policy_digest: input.policyDigest }),
    }),
  };
}

function planModeDefinitionAllowed(definition: ToolDefinition): boolean {
  if (definition.name === "todo_write") return definition.sideEffect === "none";
  return ["read_file", "list_dir", "search", "read_artifact", "list_artifacts", "todo_read"].includes(definition.name)
    && (definition.sideEffect === "none" || definition.sideEffect === "read")
    && (definition.capability === "read" || definition.capability === "search");
}
