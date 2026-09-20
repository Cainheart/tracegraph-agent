import { z } from "zod";
import {
  IdentifierSchema,
  NonEmptyStringSchema,
  RelativePathSchema,
  Sha256Schema,
} from "./common.js";

/** G-12's deliberately small, Host-owned LSP configuration surface. */
export const LSP_CONFIG_VERSION = "tracegraph.lsp.v1" as const;
export const LSP_SERVER_NAME_SCHEMA = IdentifierSchema.max(96).regex(
  /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u,
  "invalid LSP server name",
);
export const MAX_LSP_SERVERS = 16;
export const MAX_LSP_SERVER_ARGS = 32;
export const MAX_LSP_LANGUAGE_IDS = 32;
export const MAX_LSP_FILE_EXTENSIONS = 32;
export const MAX_LSP_DIAGNOSTICS = 128;
export const MAX_LSP_DIAGNOSTIC_SAMPLE = 20;

const LSP_EXTENSION_SCHEMA = z.string()
  .trim()
  .min(2)
  .max(16)
  .regex(/^\.[A-Za-z0-9][A-Za-z0-9._-]*$/u, "invalid LSP file extension");

/** Commands are always spawned with shell:false by the Core client. */
export const LspServerConfigSchema = z.object({
  name: LSP_SERVER_NAME_SCHEMA,
  command: NonEmptyStringSchema.max(512),
  args: z.array(z.string().max(2_000)).max(MAX_LSP_SERVER_ARGS).default([]),
  language_ids: z.array(NonEmptyStringSchema.max(80)).max(MAX_LSP_LANGUAGE_IDS).min(1),
  file_extensions: z.array(LSP_EXTENSION_SCHEMA).max(MAX_LSP_FILE_EXTENSIONS).min(1),
  request_timeout_ms: z.number().int().min(100).max(120_000).default(15_000),
  diagnostics_wait_ms: z.number().int().min(0).max(10_000).default(350),
}).strict();
export type LspServerConfig = z.infer<typeof LspServerConfigSchema>;

export const LspConfigSchema = z.object({
  config_version: z.literal(LSP_CONFIG_VERSION),
  servers: z.array(LspServerConfigSchema).max(MAX_LSP_SERVERS).superRefine((servers, context) => {
    const names = new Set<string>();
    const extensions = new Map<string, string>();
    servers.forEach((server, index) => {
      if (names.has(server.name)) {
        context.addIssue({ code: "custom", path: [index, "name"], message: "LSP server names must be unique" });
      }
      names.add(server.name);
      if (new Set(server.language_ids).size !== server.language_ids.length) {
        context.addIssue({ code: "custom", path: [index, "language_ids"], message: "language_ids must be unique" });
      }
      if (new Set(server.file_extensions).size !== server.file_extensions.length) {
        context.addIssue({ code: "custom", path: [index, "file_extensions"], message: "file_extensions must be unique" });
      }
      for (const extension of server.file_extensions) {
        const previous = extensions.get(extension);
        if (previous !== undefined && previous !== server.name) {
          context.addIssue({
            code: "custom",
            path: [index, "file_extensions"],
            message: `file extension ${extension} is already owned by ${previous}`,
          });
        }
        extensions.set(extension, server.name);
      }
    });
  }),
}).strict();
export type LspConfig = z.infer<typeof LspConfigSchema>;

export const LspServerStateSchema = z.enum([
  "stopped",
  "spawning",
  "initializing",
  "ready",
  "degraded",
  "unavailable",
]);
export type LspServerState = z.infer<typeof LspServerStateSchema>;

export const LspServerStatusSchema = z.object({
  name: LSP_SERVER_NAME_SCHEMA,
  state: LspServerStateSchema,
  language_ids: z.array(NonEmptyStringSchema.max(80)).max(MAX_LSP_LANGUAGE_IDS),
  file_extensions: z.array(LSP_EXTENSION_SCHEMA).max(MAX_LSP_FILE_EXTENSIONS),
  diagnostics_count: z.number().int().nonnegative().max(MAX_LSP_DIAGNOSTICS),
  updated_at: z.iso.datetime({ offset: true }),
  error_code: NonEmptyStringSchema.max(160).optional(),
  error_message: NonEmptyStringSchema.max(1_000).optional(),
}).strict().superRefine((value, context) => {
  if ((value.state === "degraded" || value.state === "unavailable") !== (value.error_code !== undefined)) {
    context.addIssue({ code: "custom", path: ["error_code"], message: "degraded/unavailable status requires an error" });
  }
  if ((value.error_code === undefined) !== (value.error_message === undefined)) {
    context.addIssue({ code: "custom", path: ["error_message"], message: "error fields must appear together" });
  }
});
export type LspServerStatus = z.infer<typeof LspServerStatusSchema>;

export const LspStatusSnapshotSchema = z.object({
  config_version: z.literal(LSP_CONFIG_VERSION),
  servers: z.array(LspServerStatusSchema).max(MAX_LSP_SERVERS),
  updated_at: z.iso.datetime({ offset: true }),
}).strict();
export type LspStatusSnapshot = z.infer<typeof LspStatusSnapshotSchema>;

export const LspPositionSchema = z.object({
  line: z.number().int().nonnegative().max(10_000_000),
  character: z.number().int().nonnegative().max(10_000_000),
}).strict();
export type LspPosition = z.infer<typeof LspPositionSchema>;

export const LspRangeSchema = z.object({
  start: LspPositionSchema,
  end: LspPositionSchema,
}).strict();
export type LspRange = z.infer<typeof LspRangeSchema>;

export const LspDiagnosticSeveritySchema = z.enum(["error", "warning", "information", "hint"]);
export type LspDiagnosticSeverity = z.infer<typeof LspDiagnosticSeveritySchema>;

export const LspDiagnosticSchema = z.object({
  path: RelativePathSchema,
  range: LspRangeSchema,
  severity: LspDiagnosticSeveritySchema,
  message: NonEmptyStringSchema.max(2_000),
  code: z.union([z.string().trim().min(1).max(160), z.number().int()]).optional(),
  source: z.string().trim().min(1).max(160).optional(),
}).strict();
export type LspDiagnostic = z.infer<typeof LspDiagnosticSchema>;

export const LspDiagnosticsSummarySchema = z.object({
  server_name: LSP_SERVER_NAME_SCHEMA,
  files_scanned: z.number().int().nonnegative().max(256),
  diagnostic_count: z.number().int().nonnegative().max(MAX_LSP_DIAGNOSTICS),
  error_count: z.number().int().nonnegative().max(MAX_LSP_DIAGNOSTICS),
  warning_count: z.number().int().nonnegative().max(MAX_LSP_DIAGNOSTICS),
  information_count: z.number().int().nonnegative().max(MAX_LSP_DIAGNOSTICS),
  hint_count: z.number().int().nonnegative().max(MAX_LSP_DIAGNOSTICS),
  truncated: z.boolean(),
  sample: z.array(LspDiagnosticSchema).max(MAX_LSP_DIAGNOSTIC_SAMPLE),
  diagnostics_hash: Sha256Schema,
}).strict().superRefine((value, context) => {
  if (value.diagnostic_count < value.error_count + value.warning_count + value.information_count + value.hint_count) {
    context.addIssue({ code: "custom", path: ["diagnostic_count"], message: "diagnostic_count must cover all severities" });
  }
  if (value.sample.length > value.diagnostic_count) {
    context.addIssue({ code: "custom", path: ["sample"], message: "sample cannot exceed diagnostic_count" });
  }
});
export type LspDiagnosticsSummary = z.infer<typeof LspDiagnosticsSummarySchema>;

export const LspDiagnosticsRequestSchema = z.object({
  paths: z.array(RelativePathSchema).max(64).default([]),
  max_items: z.number().int().min(1).max(MAX_LSP_DIAGNOSTICS).default(50),
  severity: z.enum(["all", "errors", "warnings"]).default("all"),
}).strict();
export type LspDiagnosticsRequest = z.infer<typeof LspDiagnosticsRequestSchema>;

/** Full tool output is bounded separately from the ledger summary sample. */
export const LspDiagnosticsResultSchema = z.object({
  status: z.enum(["available", "unavailable"]),
  summary: LspDiagnosticsSummarySchema.optional(),
  diagnostics: z.array(LspDiagnosticSchema).max(MAX_LSP_DIAGNOSTICS).default([]),
  message: NonEmptyStringSchema.max(1_000).optional(),
}).strict().superRefine((value, context) => {
  if (value.status === "available" && value.summary === undefined) {
    context.addIssue({ code: "custom", path: ["summary"], message: "available diagnostics require a summary" });
  }
  if (value.status === "unavailable" && value.message === undefined) {
    context.addIssue({ code: "custom", path: ["message"], message: "unavailable diagnostics require a message" });
  }
});
export type LspDiagnosticsResult = z.infer<typeof LspDiagnosticsResultSchema>;

export const LspDiagnosticsReceivedDataSchema = z.object({
  project_id: IdentifierSchema,
  server_name: LSP_SERVER_NAME_SCHEMA,
  files_scanned: z.number().int().nonnegative().max(256),
  diagnostic_count: z.number().int().nonnegative().max(MAX_LSP_DIAGNOSTICS),
  error_count: z.number().int().nonnegative().max(MAX_LSP_DIAGNOSTICS),
  warning_count: z.number().int().nonnegative().max(MAX_LSP_DIAGNOSTICS),
  information_count: z.number().int().nonnegative().max(MAX_LSP_DIAGNOSTICS),
  hint_count: z.number().int().nonnegative().max(MAX_LSP_DIAGNOSTICS),
  truncated: z.boolean(),
  sample: z.array(LspDiagnosticSchema).max(MAX_LSP_DIAGNOSTIC_SAMPLE),
  diagnostics_hash: Sha256Schema,
}).strict();
export type LspDiagnosticsReceivedData = z.infer<typeof LspDiagnosticsReceivedDataSchema>;

export const LspServerUnavailableDataSchema = z.object({
  project_id: IdentifierSchema,
  server_name: LSP_SERVER_NAME_SCHEMA,
  error_code: NonEmptyStringSchema.max(160),
  message: NonEmptyStringSchema.max(1_000),
}).strict();
export type LspServerUnavailableData = z.infer<typeof LspServerUnavailableDataSchema>;

export const LspLocationSchema = z.object({
  path: RelativePathSchema,
  range: LspRangeSchema,
}).strict();
export type LspLocation = z.infer<typeof LspLocationSchema>;
