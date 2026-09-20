import { z } from "zod";
import {
  BoundedJsonSchemaSchema,
  ToolSideEffectSchema,
  type BoundedJsonSchema,
} from "./tool.js";
import {
  IdentifierSchema,
  NonEmptyStringSchema,
  Sha256Schema,
  ToolNameSchema,
} from "./common.js";
import { SecretReferenceSchema } from "./credentials.js";

export const MCP_CONFIG_VERSION = "tracegraph.mcp.v1" as const;
export const MCP_TRANSPORT_SCHEMA = z.literal("stdio");
export const MCP_SERVER_NAME_SCHEMA = IdentifierSchema.max(96).regex(
  /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u,
  "invalid MCP server name",
);
export const MCP_REMOTE_TOOL_NAME_SCHEMA = NonEmptyStringSchema.max(160);
export const MCP_QUALIFIED_TOOL_NAME_SCHEMA = ToolNameSchema;
export const MAX_MCP_SERVERS = 32;
export const MAX_MCP_TOOLS_PER_SERVER = 256;
export const MAX_MCP_ENV_ENTRIES = 64;
export const MAX_MCP_STDERR_TAIL = 4_000;

const MCP_ENV_KEY_SCHEMA = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u).max(160);
const MCP_ENV_VALUE_SCHEMA = z.string().max(4_000);

/**
 * MCP configuration is deliberately a small data contract. The command is
 * executed without a shell; secret-looking environment keys must use the
 * G-19 `${secret:NAME}` reference form rather than persisting plaintext.
 */
export const McpServerConfigSchema = z.object({
  name: MCP_SERVER_NAME_SCHEMA,
  command: NonEmptyStringSchema.max(512),
  args: z.array(z.string().max(2_000)).max(64).default([]),
  env: z.record(MCP_ENV_KEY_SCHEMA, MCP_ENV_VALUE_SCHEMA).superRefine((values, context) => {
    if (Object.keys(values).length > MAX_MCP_ENV_ENTRIES) {
      context.addIssue({ code: "custom", message: `env exceeds ${MAX_MCP_ENV_ENTRIES} entries` });
    }
    for (const [key, value] of Object.entries(values)) {
      if (/(?:TOKEN|SECRET|PASSWORD|PASS|KEY|CREDENTIAL)/iu.test(key)) {
        const parsed = SecretReferenceSchema.safeParse(value);
        if (!parsed.success) {
          context.addIssue({
            code: "custom",
            path: [key],
            message: "secret-looking MCP environment values must use ${secret:NAME}",
          });
        }
      }
    }
  }).default({}),
  required: z.boolean().default(false),
  transport: MCP_TRANSPORT_SCHEMA.default("stdio"),
  tool_policy: z.object({
    allow: z.array(MCP_REMOTE_TOOL_NAME_SCHEMA).max(MAX_MCP_TOOLS_PER_SERVER).optional(),
    deny: z.array(MCP_REMOTE_TOOL_NAME_SCHEMA).max(MAX_MCP_TOOLS_PER_SERVER).optional(),
  }).strict().optional(),
}).strict();
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const McpConfigSchema = z.object({
  config_version: z.literal(MCP_CONFIG_VERSION),
  servers: z.array(McpServerConfigSchema).max(MAX_MCP_SERVERS).superRefine((servers, context) => {
    const names = new Set<string>();
    servers.forEach((server, index) => {
      if (names.has(server.name)) {
        context.addIssue({ code: "custom", path: [index, "name"], message: "MCP server names must be unique" });
      }
      names.add(server.name);
      if (server.tool_policy?.allow !== undefined && new Set(server.tool_policy.allow).size !== server.tool_policy.allow.length) {
        context.addIssue({ code: "custom", path: [index, "tool_policy", "allow"], message: "allow entries must be unique" });
      }
      if (server.tool_policy?.deny !== undefined && new Set(server.tool_policy.deny).size !== server.tool_policy.deny.length) {
        context.addIssue({ code: "custom", path: [index, "tool_policy", "deny"], message: "deny entries must be unique" });
      }
    });
  }),
}).strict();
export type McpConfig = z.infer<typeof McpConfigSchema>;

export const McpServerStateSchema = z.enum([
  "spawning",
  "initializing",
  "ready",
  "degraded",
  "stopped",
]);
export type McpServerState = z.infer<typeof McpServerStateSchema>;

export const McpToolCatalogEntrySchema = z.object({
  server_name: MCP_SERVER_NAME_SCHEMA,
  name: MCP_REMOTE_TOOL_NAME_SCHEMA,
  qualified_name: MCP_QUALIFIED_TOOL_NAME_SCHEMA,
  description: NonEmptyStringSchema.max(2_000),
  input_schema: BoundedJsonSchemaSchema,
  side_effect: ToolSideEffectSchema,
  read_only_hint: z.boolean().optional(),
  destructive_hint: z.boolean().optional(),
}).strict();
export type McpToolCatalogEntry = z.infer<typeof McpToolCatalogEntrySchema>;

export const McpServerStatusSchema = z.object({
  name: MCP_SERVER_NAME_SCHEMA,
  required: z.boolean(),
  transport: MCP_TRANSPORT_SCHEMA,
  state: McpServerStateSchema,
  tool_count: z.number().int().nonnegative().max(MAX_MCP_TOOLS_PER_SERVER),
  tools: z.array(McpToolCatalogEntrySchema).max(MAX_MCP_TOOLS_PER_SERVER),
  updated_at: z.iso.datetime({ offset: true }),
  error_code: NonEmptyStringSchema.max(160).optional(),
  error_message: NonEmptyStringSchema.max(1_000).optional(),
  stderr_tail: z.string().max(MAX_MCP_STDERR_TAIL).optional(),
}).strict().superRefine((value, context) => {
  if (value.tool_count !== value.tools.length) {
    context.addIssue({ code: "custom", path: ["tool_count"], message: "tool_count must equal tools length" });
  }
  if ((value.state === "degraded" || value.state === "stopped") !== (value.error_code !== undefined)) {
    context.addIssue({ code: "custom", path: ["error_code"], message: "degraded/stopped status requires an error" });
  }
  if ((value.error_code === undefined) !== (value.error_message === undefined)) {
    context.addIssue({ code: "custom", path: ["error_message"], message: "error fields must appear together" });
  }
});
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>;

export const McpStatusSnapshotSchema = z.object({
  config_version: z.literal(MCP_CONFIG_VERSION),
  servers: z.array(McpServerStatusSchema).max(MAX_MCP_SERVERS),
  updated_at: z.iso.datetime({ offset: true }),
}).strict();
export type McpStatusSnapshot = z.infer<typeof McpStatusSnapshotSchema>;

export const McpRestartRequestSchema = z.object({ command_id: IdentifierSchema }).strict();
export type McpRestartRequest = z.infer<typeof McpRestartRequestSchema>;

export const McpServerStartedDataSchema = z.object({
  server_name: MCP_SERVER_NAME_SCHEMA,
  required: z.boolean(),
  transport: MCP_TRANSPORT_SCHEMA,
  tool_count: z.number().int().nonnegative().max(MAX_MCP_TOOLS_PER_SERVER),
}).strict();
export const McpServerFailedDataSchema = z.object({
  server_name: MCP_SERVER_NAME_SCHEMA,
  required: z.boolean(),
  error_code: NonEmptyStringSchema.max(160),
  stderr_tail: z.string().max(MAX_MCP_STDERR_TAIL).optional(),
}).strict();
export const McpServerStoppedDataSchema = z.object({
  server_name: MCP_SERVER_NAME_SCHEMA,
  reason: NonEmptyStringSchema.max(160),
}).strict();
export const McpToolsChangedDataSchema = z.object({
  server_name: MCP_SERVER_NAME_SCHEMA,
  added: z.array(MCP_QUALIFIED_TOOL_NAME_SCHEMA).max(MAX_MCP_TOOLS_PER_SERVER),
  removed: z.array(MCP_QUALIFIED_TOOL_NAME_SCHEMA).max(MAX_MCP_TOOLS_PER_SERVER),
  tool_count: z.number().int().nonnegative().max(MAX_MCP_TOOLS_PER_SERVER),
}).strict();
export const McpToolCalledDataSchema = z.object({
  server_name: MCP_SERVER_NAME_SCHEMA,
  tool_name: MCP_REMOTE_TOOL_NAME_SCHEMA,
  qualified_name: MCP_QUALIFIED_TOOL_NAME_SCHEMA,
  arguments_hash: Sha256Schema,
  duration_ms: z.number().int().nonnegative().max(24 * 60 * 60 * 1_000),
  result_bytes: z.number().int().nonnegative().max(8 * 1024 * 1024),
  status: z.enum(["success", "failure", "unknown"]),
  code: NonEmptyStringSchema.max(160),
}).strict();
export type McpServerStartedData = z.infer<typeof McpServerStartedDataSchema>;
export type McpServerFailedData = z.infer<typeof McpServerFailedDataSchema>;
export type McpServerStoppedData = z.infer<typeof McpServerStoppedDataSchema>;
export type McpToolsChangedData = z.infer<typeof McpToolsChangedDataSchema>;
export type McpToolCalledData = z.infer<typeof McpToolCalledDataSchema>;

export type McpJsonSchema = BoundedJsonSchema;
