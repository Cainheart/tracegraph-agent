import { z } from "zod";
import {
  IdentifierSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  Sha256Schema,
  ToolNameSchema,
} from "./common.js";
import { EventTypeSchema } from "./event.js";

export const EXTENSION_API_VERSION = "tracegraph.extension.v1" as const;
export const EXTENSION_CONFIG_VERSION = "tracegraph.extensions-config.v1" as const;
export const MAX_EXTENSIONS = 64;
export const MAX_EXTENSION_COMMAND_ARGS = 64;

export const ExtensionNameSchema = NonEmptyStringSchema
  .max(160)
  .regex(
    /^(?:@[A-Za-z0-9][A-Za-z0-9_.-]*\/)?[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/u,
    "invalid extension name",
  );
export type ExtensionName = z.infer<typeof ExtensionNameSchema>;

export const ExtensionModuleSchema = NonEmptyStringSchema
  .max(500)
  .refine((value) => !value.includes("\0"), "extension module contains NUL");

export const ExtensionConfigEntrySchema = z.object({
  name: ExtensionNameSchema,
  module: ExtensionModuleSchema,
  enabled: z.boolean().default(true),
  required: z.boolean().default(false),
}).strict();
export type ExtensionConfigEntry = z.infer<typeof ExtensionConfigEntrySchema>;

export const ExtensionConfigSchema = z.object({
  config_version: z.literal(EXTENSION_CONFIG_VERSION),
  extensions: z.array(ExtensionConfigEntrySchema).max(MAX_EXTENSIONS).superRefine((entries, context) => {
    const names = new Set<string>();
    entries.forEach((entry, index) => {
      if (names.has(entry.name)) {
        context.addIssue({ code: "custom", path: [index, "name"], message: "extension names must be unique" });
      }
      names.add(entry.name);
    });
  }),
}).strict();
export type ExtensionConfig = z.infer<typeof ExtensionConfigSchema>;

export const ExtensionStateSchema = z.enum([
  "inactive",
  "activating",
  "active",
  "deactivating",
  "failed",
  "rejected",
]);
export type ExtensionState = z.infer<typeof ExtensionStateSchema>;

export const ExtensionStatusSchema = z.object({
  name: ExtensionNameSchema,
  api_version: z.literal(EXTENSION_API_VERSION),
  state: ExtensionStateSchema,
  registration_count: z.number().int().nonnegative().max(10_000),
  generation: z.number().int().nonnegative(),
  updated_at: IsoDateTimeSchema,
  error_code: NonEmptyStringSchema.max(160).optional(),
  error_message: NonEmptyStringSchema.max(1_000).optional(),
}).strict().superRefine((value, context) => {
  if ((value.state === "failed" || value.state === "rejected") !== (value.error_code !== undefined)) {
    context.addIssue({ code: "custom", path: ["error_code"], message: "failed/rejected status requires an error" });
  }
  if ((value.error_code === undefined) !== (value.error_message === undefined)) {
    context.addIssue({ code: "custom", path: ["error_message"], message: "extension error fields must appear together" });
  }
});
export type ExtensionStatus = z.infer<typeof ExtensionStatusSchema>;

export const ExtensionReloadCommandSchema = z.object({
  command_id: IdentifierSchema,
  extension_name: ExtensionNameSchema,
  expected_config_digest: Sha256Schema.optional(),
}).strict();
export type ExtensionReloadCommand = z.infer<typeof ExtensionReloadCommandSchema>;

export const ExtensionCommandNameSchema = NonEmptyStringSchema
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u, "invalid extension command name");

export const ExtensionCommandInvocationSchema = z.object({
  command_id: IdentifierSchema,
  name: ExtensionCommandNameSchema,
  args: z.array(z.string().max(2_000)).max(MAX_EXTENSION_COMMAND_ARGS).default([]),
}).strict();
export type ExtensionCommandInvocation = z.infer<typeof ExtensionCommandInvocationSchema>;

export const ExtensionCommandResultSchema = z.object({
  command_id: IdentifierSchema,
  name: ExtensionCommandNameSchema,
  status: z.enum(["success", "failure"]),
  summary: NonEmptyStringSchema.max(2_000),
}).strict();
export type ExtensionCommandResult = z.infer<typeof ExtensionCommandResultSchema>;

export const ExtensionErrorPhaseSchema = z.enum([
  "activate",
  "deactivate",
  "dispose",
  "event_hook",
  "context_strategy",
  "telemetry_sink",
  "tool",
  "command",
]);
export type ExtensionErrorPhase = z.infer<typeof ExtensionErrorPhaseSchema>;

export const ExtensionErrorDataSchema = z.object({
  extension_name: ExtensionNameSchema,
  api_version: z.literal(EXTENSION_API_VERSION),
  phase: ExtensionErrorPhaseSchema,
  code: NonEmptyStringSchema.max(160),
  message: NonEmptyStringSchema.max(1_000),
  source_event_id: IdentifierSchema,
  source_event_type: EventTypeSchema.exclude(["extension.error"]),
}).strict();
export type ExtensionErrorData = z.infer<typeof ExtensionErrorDataSchema>;

/** Frozen into private recovery state; it contains names and digests, never code. */
export const ExtensionRunSnapshotSchema = z.object({
  api_version: z.literal(EXTENSION_API_VERSION),
  config_digest: Sha256Schema,
  generation: z.number().int().nonnegative(),
  active_extensions: z.array(ExtensionNameSchema).max(MAX_EXTENSIONS).superRefine(uniqueStrings),
  active_tool_names: z.array(ToolNameSchema).max(256).superRefine(uniqueStrings),
}).strict();
export type ExtensionRunSnapshot = z.infer<typeof ExtensionRunSnapshotSchema>;

function uniqueStrings(values: readonly string[], context: z.core.$RefinementCtx): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: "entries must be unique" });
  }
}
