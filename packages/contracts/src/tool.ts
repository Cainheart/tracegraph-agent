import { z } from "zod";
import { IdentifierSchema, NonEmptyStringSchema } from "./common.js";
import { MAX_TOOL_CALLS_PER_DECISION, ReceiptStatusSchema, ToolNameSchema } from "./action.js";

/**
 * TraceGraph intentionally accepts a bounded, local JSON-Schema subset for
 * Tool input/output contracts.  Remote references and extension keywords are
 * excluded: a descriptor must be completely understandable by the Host that
 * validates it, without network resolution or provider-specific behaviour.
 */
export interface BoundedJsonSchema {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  title?: string;
  description?: string;
  properties?: Record<string, BoundedJsonSchema>;
  required?: string[];
  additionalProperties?: boolean | BoundedJsonSchema;
  items?: BoundedJsonSchema;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minProperties?: number;
  maxProperties?: number;
  anyOf?: BoundedJsonSchema[];
  oneOf?: BoundedJsonSchema[];
}

export const MAX_TOOL_SCHEMA_BYTES = 64 * 1024;
export const MAX_TOOL_SCHEMA_DEPTH = 8;
export const MAX_TOOL_SCHEMA_NODES = 256;
export const MAX_TOOL_SCHEMA_PROPERTIES = 64;

const JSON_SCHEMA_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

const JSON_SCHEMA_KEYS = new Set([
  "type",
  "title",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "default",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "anyOf",
  "oneOf",
]);

/**
 * This custom boundary uses an iterative walk rather than an unbounded lazy
 * schema, so a deeply nested untrusted descriptor cannot overflow the stack
 * before the depth limit is checked.
 */
export const BoundedJsonSchemaSchema = z.unknown().superRefine((value, context) => {
  const issue = boundedJsonSchemaIssue(value);
  if (issue !== undefined) context.addIssue({ code: "custom", message: issue });
}).transform((value) => value as BoundedJsonSchema);

const RootObjectJsonSchemaSchema = BoundedJsonSchemaSchema.refine(
  (schema) => schema.type === "object",
  { message: "Tool input/output schema root must have type object" },
);

export const ToolSideEffectSchema = z.enum(["none", "read", "write", "execute"]);
export type ToolSideEffect = z.infer<typeof ToolSideEffectSchema>;

export const ToolFailureCodeSchema = z.enum([
  "invalid_arguments",
  "timeout",
  "output_contract_violation",
  "denied",
  "internal",
]);
export type ToolFailureCode = z.infer<typeof ToolFailureCodeSchema>;

export const ToolFailureSchema = z.object({
  code: ToolFailureCodeSchema,
  business_code: NonEmptyStringSchema.max(160).optional(),
  message: NonEmptyStringSchema.max(2_000),
}).strict();
export type ToolFailure = z.infer<typeof ToolFailureSchema>;

const UniqueActionIdsSchema = z.array(IdentifierSchema)
  .min(1)
  .max(MAX_TOOL_CALLS_PER_DECISION)
  .superRefine((actionIds, context) => {
    if (new Set(actionIds).size !== actionIds.length) {
      context.addIssue({ code: "custom", message: "batch action_ids must be unique" });
    }
  });

export const ToolBatchSerializedActionSchema = z.object({
  action_id: IdentifierSchema,
  reason: NonEmptyStringSchema.max(500),
}).strict();
export type ToolBatchSerializedAction = z.infer<typeof ToolBatchSerializedActionSchema>;

export const ToolBatchStartedDataSchema = z.object({
  batch_id: IdentifierSchema,
  requested_count: z.number().int().min(1).max(MAX_TOOL_CALLS_PER_DECISION),
  max_concurrency: z.number().int().min(1).max(MAX_TOOL_CALLS_PER_DECISION),
  effective_concurrency: z.number().int().min(1).max(MAX_TOOL_CALLS_PER_DECISION),
  action_ids: UniqueActionIdsSchema,
  parallel_action_ids: z.array(IdentifierSchema).max(MAX_TOOL_CALLS_PER_DECISION),
  serialized_actions: z.array(ToolBatchSerializedActionSchema).max(MAX_TOOL_CALLS_PER_DECISION),
}).strict().superRefine((value, context) => {
  if (value.requested_count !== value.action_ids.length) {
    context.addIssue({ code: "custom", path: ["requested_count"], message: "requested_count must equal action_ids length" });
  }
  if (value.effective_concurrency > value.max_concurrency || value.effective_concurrency > value.requested_count) {
    context.addIssue({ code: "custom", path: ["effective_concurrency"], message: "effective concurrency exceeds its declared bound" });
  }
  const known = new Set(value.action_ids);
  const parallel = new Set(value.parallel_action_ids);
  if (parallel.size !== value.parallel_action_ids.length || value.parallel_action_ids.some((actionId) => !known.has(actionId))) {
    context.addIssue({ code: "custom", path: ["parallel_action_ids"], message: "parallel action ids must be unique members of action_ids" });
  }
  const serializedIds = value.serialized_actions.map(({ action_id: actionId }) => actionId);
  if (new Set(serializedIds).size !== serializedIds.length || serializedIds.some((actionId) => !known.has(actionId))) {
    context.addIssue({ code: "custom", path: ["serialized_actions"], message: "serialized action ids must be unique members of action_ids" });
  }
  if (serializedIds.some((actionId) => parallel.has(actionId))) {
    context.addIssue({ code: "custom", path: ["serialized_actions"], message: "an action cannot be both parallel and serialized" });
  }
  if (parallel.size + serializedIds.length !== known.size) {
    context.addIssue({
      code: "custom",
      path: ["serialized_actions"],
      message: "parallel and serialized actions must classify every batch action",
    });
  }
  if (value.effective_concurrency > Math.max(1, parallel.size)) {
    context.addIssue({
      code: "custom",
      path: ["effective_concurrency"],
      message: "effective concurrency exceeds the declared parallel action set",
    });
  }
});
export type ToolBatchStartedData = z.infer<typeof ToolBatchStartedDataSchema>;

export const ToolBatchResultSchema = z.object({
  action_id: IdentifierSchema,
  status: ReceiptStatusSchema,
  duration_ms: z.number().int().nonnegative().max(24 * 60 * 60 * 1_000),
  code: NonEmptyStringSchema.max(160),
  failure_code: ToolFailureCodeSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.status === "success" && value.failure_code !== undefined) {
    context.addIssue({ code: "custom", path: ["failure_code"], message: "successful batch result cannot have a failure_code" });
  }
});
export type ToolBatchResult = z.infer<typeof ToolBatchResultSchema>;

export const ToolBatchCompletedDataSchema = z.object({
  batch_id: IdentifierSchema,
  requested_count: z.number().int().min(1).max(MAX_TOOL_CALLS_PER_DECISION),
  completed_count: z.number().int().min(0).max(MAX_TOOL_CALLS_PER_DECISION),
  failed_count: z.number().int().min(0).max(MAX_TOOL_CALLS_PER_DECISION),
  max_concurrency: z.number().int().min(1).max(MAX_TOOL_CALLS_PER_DECISION),
  // A stop may race immediately after tool.batch_started and before the
  // scheduler starts its first member.  The completed audit fact must still
  // be able to close that durable batch with zero observed concurrency.
  effective_concurrency: z.number().int().min(0).max(MAX_TOOL_CALLS_PER_DECISION),
  total_duration_ms: z.number().int().nonnegative().max(24 * 60 * 60 * 1_000),
  action_ids: UniqueActionIdsSchema,
  results: z.array(ToolBatchResultSchema).max(MAX_TOOL_CALLS_PER_DECISION),
}).strict().superRefine((value, context) => {
  if (value.requested_count !== value.action_ids.length || value.completed_count !== value.results.length) {
    context.addIssue({ code: "custom", message: "batch counts must match action_ids and results" });
  }
  if (value.effective_concurrency > value.max_concurrency || value.effective_concurrency > value.requested_count) {
    context.addIssue({ code: "custom", path: ["effective_concurrency"], message: "effective concurrency exceeds its declared bound" });
  }
  if (value.effective_concurrency > value.completed_count) {
    context.addIssue({
      code: "custom",
      path: ["effective_concurrency"],
      message: "effective concurrency cannot exceed completed results",
    });
  }
  if (value.completed_count > 0 && value.effective_concurrency === 0) {
    context.addIssue({
      code: "custom",
      path: ["effective_concurrency"],
      message: "a batch with completed results must observe positive concurrency",
    });
  }
  if (value.failed_count !== value.results.filter(({ status }) => status !== "success").length) {
    context.addIssue({ code: "custom", path: ["failed_count"], message: "failed_count must match non-success results" });
  }
  if (value.results.some((result, index) => result.action_id !== value.action_ids[index])) {
    context.addIssue({ code: "custom", path: ["results"], message: "batch results must preserve action_ids order" });
  }
});
export type ToolBatchCompletedData = z.infer<typeof ToolBatchCompletedDataSchema>;

export const ToolDescriptorSchema = z.object({
  name: ToolNameSchema,
  description: NonEmptyStringSchema.max(2_000),
  input_schema: RootObjectJsonSchemaSchema,
  output_schema: RootObjectJsonSchemaSchema,
  timeout_ms: z.number().int().min(10).max(300_000),
  concurrency_safe: z.boolean(),
  side_effect: ToolSideEffectSchema,
  max_result_bytes: z.number().int().positive().max(8 * 1024 * 1024),
}).strict();
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;

/** The only Tool fields that may cross the model-provider boundary. */
export const MODEL_TOOL_SCHEMA_KEYS = ["name", "description", "input_schema"] as const;

/** Host policy and output-validation fields must never be sent to a model. */
export const HOST_ONLY_TOOL_DESCRIPTOR_KEYS = [
  "output_schema",
  "timeout_ms",
  "concurrency_safe",
  "side_effect",
  "max_result_bytes",
] as const;

export const ModelToolSchema = z.object({
  name: ToolNameSchema,
  description: NonEmptyStringSchema.max(2_000),
  input_schema: RootObjectJsonSchemaSchema,
}).strict();
export type ModelTool = z.infer<typeof ModelToolSchema>;

/**
 * Explicit projection prevents newly-added Host fields from leaking merely
 * because a descriptor was spread into a provider request.
 */
export function toModelToolSchema(descriptor: ToolDescriptor): ModelTool {
  return ModelToolSchema.parse({
    name: descriptor.name,
    description: descriptor.description,
    input_schema: descriptor.input_schema,
  });
}

function boundedJsonSchemaIssue(value: unknown): string | undefined {
  const serializedBytes = jsonByteLength(value);
  if (serializedBytes === undefined) return "JSON Schema must be JSON-serializable";
  if (serializedBytes > MAX_TOOL_SCHEMA_BYTES) {
    return `JSON Schema exceeds ${MAX_TOOL_SCHEMA_BYTES} bytes`;
  }

  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodeCount = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    nodeCount += 1;
    if (nodeCount > MAX_TOOL_SCHEMA_NODES) {
      return `JSON Schema exceeds ${MAX_TOOL_SCHEMA_NODES} nodes`;
    }
    if (current.depth > MAX_TOOL_SCHEMA_DEPTH) {
      return `JSON Schema exceeds depth ${MAX_TOOL_SCHEMA_DEPTH}`;
    }
    if (!isPlainRecord(current.value)) return "Every JSON Schema node must be a plain object";

    const schema = current.value;
    const unknownKey = Object.keys(schema).find((key) => !JSON_SCHEMA_KEYS.has(key));
    if (unknownKey !== undefined) return `Unsupported JSON Schema keyword: ${unknownKey}`;
    if (typeof schema.type !== "string" || !JSON_SCHEMA_TYPES.has(schema.type)) {
      return "Every JSON Schema node must declare one supported type";
    }

    for (const field of ["title", "description", "pattern", "format"] as const) {
      const member = schema[field];
      if (member !== undefined && (typeof member !== "string" || member.length > 2_000)) {
        return `${field} must be a string of at most 2000 characters`;
      }
    }
    if (typeof schema.pattern === "string") {
      try {
        new RegExp(schema.pattern, "u");
      } catch {
        return "pattern must be a valid regular expression";
      }
    }

    const integerBounds = [
      "minLength",
      "maxLength",
      "minItems",
      "maxItems",
      "minProperties",
      "maxProperties",
    ] as const;
    for (const field of integerBounds) {
      const member = schema[field];
      if (member !== undefined && (!Number.isSafeInteger(member) || (member as number) < 0 || (member as number) > 8 * 1024 * 1024)) {
        return `${field} must be a bounded non-negative integer`;
      }
    }
    for (const field of ["minimum", "maximum", "multipleOf"] as const) {
      const member = schema[field];
      if (member !== undefined && (typeof member !== "number" || !Number.isFinite(member))) {
        return `${field} must be a finite number`;
      }
    }
    if (schema.multipleOf !== undefined && (schema.multipleOf as number) <= 0) {
      return "multipleOf must be greater than zero";
    }
    if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") {
      return "uniqueItems must be boolean";
    }

    if (schema.properties !== undefined) {
      if (schema.type !== "object" || !isPlainRecord(schema.properties)) {
        return "properties is allowed only as an object on type object";
      }
      const properties = Object.entries(schema.properties);
      if (properties.length > MAX_TOOL_SCHEMA_PROPERTIES) {
        return `properties exceeds ${MAX_TOOL_SCHEMA_PROPERTIES} entries`;
      }
      for (const [name, child] of properties) {
        if (name.trim().length === 0 || name.length > 160) return "property names must contain 1..160 characters";
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }

    if (schema.required !== undefined) {
      if (schema.type !== "object" || !Array.isArray(schema.required) || schema.required.length > MAX_TOOL_SCHEMA_PROPERTIES) {
        return "required must be a bounded array on type object";
      }
      if (schema.required.some((name) => typeof name !== "string" || name.length === 0 || name.length > 160)) {
        return "required entries must contain 1..160 characters";
      }
      if (new Set(schema.required).size !== schema.required.length) return "required entries must be unique";
      const declaredProperties = schema.properties;
      if (isPlainRecord(declaredProperties) && schema.required.some((name) => !(name as string in declaredProperties))) {
        return "required entries must name declared properties";
      }
    }

    if (schema.additionalProperties !== undefined) {
      if (schema.type !== "object") return "additionalProperties is allowed only on type object";
      if (typeof schema.additionalProperties !== "boolean") {
        pending.push({ value: schema.additionalProperties, depth: current.depth + 1 });
      }
    }
    if (schema.items !== undefined) {
      if (schema.type !== "array") return "items is allowed only on type array";
      pending.push({ value: schema.items, depth: current.depth + 1 });
    }

    for (const field of ["anyOf", "oneOf"] as const) {
      const branches = schema[field];
      if (branches === undefined) continue;
      if (!Array.isArray(branches) || branches.length < 1 || branches.length > 8) {
        return `${field} must contain 1..8 schemas`;
      }
      for (const child of branches) pending.push({ value: child, depth: current.depth + 1 });
    }

    if (schema.enum !== undefined) {
      if (!Array.isArray(schema.enum) || schema.enum.length < 1 || schema.enum.length > 64) {
        return "enum must contain 1..64 JSON values";
      }
      if (schema.enum.some((entry) => !isBoundedJsonValue(entry))) return "enum contains an invalid JSON value";
    }
    for (const field of ["const", "default"] as const) {
      if (schema[field] !== undefined && !isBoundedJsonValue(schema[field])) {
        return `${field} must be a bounded JSON value`;
      }
    }
  }
  return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function jsonByteLength(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return undefined;
  }
}

function isBoundedJsonValue(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    nodes += 1;
    if (nodes > MAX_TOOL_SCHEMA_NODES || current.depth > MAX_TOOL_SCHEMA_DEPTH) return false;
    if (current.value === null || typeof current.value === "string" || typeof current.value === "boolean") continue;
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) return false;
      continue;
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_TOOL_SCHEMA_PROPERTIES) return false;
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (!isPlainRecord(current.value) || Object.keys(current.value).length > MAX_TOOL_SCHEMA_PROPERTIES) return false;
    for (const child of Object.values(current.value)) pending.push({ value: child, depth: current.depth + 1 });
  }
  return true;
}
