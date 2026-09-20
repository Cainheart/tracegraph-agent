import { z } from "zod";
import {
  IdentifierSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  RelativePathSchema,
  Sha256Schema,
} from "./common.js";
import { LspDiagnosticsSummarySchema } from "./lsp.js";

/** Bounded, replay-safe semantic CodeGraph projection introduced by G-20. */
export const CODE_INTEL_VERSION = "tracegraph.code-intel.v1" as const;
export const MAX_CODE_INTEL_CHANGED_FILES = 128;
export const MAX_CODE_INTEL_CHANGED_SYMBOLS = 128;

export const CodeIntelSymbolKindSchema = z.enum([
  "class",
  "enum",
  "function",
  "interface",
  "namespace",
  "type",
  "variable",
]);
export type CodeIntelSymbolKind = z.infer<typeof CodeIntelSymbolKindSchema>;

export const ChangedSymbolSchema = z.object({
  symbol_id: IdentifierSchema,
  name: NonEmptyStringSchema.max(256),
  kind: CodeIntelSymbolKindSchema,
  file_path: RelativePathSchema,
  line: z.number().int().positive(),
  end_line: z.number().int().positive().optional(),
  change: z.enum(["added", "removed", "changed"]),
}).strict().superRefine((value, context) => {
  if (value.end_line !== undefined && value.end_line < value.line) {
    context.addIssue({ code: "custom", path: ["end_line"], message: "end_line cannot precede line" });
  }
});
export type ChangedSymbol = z.infer<typeof ChangedSymbolSchema>;

const GitCommitSchema = z.string().regex(
  /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u,
  "Git commit must be a full SHA-1 or SHA-256 object id",
);

/**
 * The Host/composition captures this through fixed read-only git argv. It
 * intentionally excludes remotes, absolute paths, and raw status output.
 */
export const GitBaseContextSchema = z.object({
  status: z.enum(["available", "unavailable"]),
  base_commit: GitCommitSchema.optional(),
  branch: NonEmptyStringSchema.max(256).optional(),
  dirty: z.boolean().optional(),
  worktree_fingerprint: Sha256Schema.optional(),
  captured_at: IsoDateTimeSchema,
  reason: NonEmptyStringSchema.max(160).optional(),
}).strict().superRefine((value, context) => {
  if (value.status === "available") {
    if (value.base_commit === undefined || value.dirty === undefined || value.worktree_fingerprint === undefined) {
      context.addIssue({ code: "custom", message: "available git context requires base_commit, dirty, and worktree_fingerprint" });
    }
    if (value.reason !== undefined) {
      context.addIssue({ code: "custom", path: ["reason"], message: "available git context cannot include a reason" });
    }
  } else if (
    value.base_commit !== undefined
    || value.branch !== undefined
    || value.dirty !== undefined
    || value.worktree_fingerprint !== undefined
  ) {
    context.addIssue({ code: "custom", message: "unavailable git context cannot claim repository state" });
  }
});
export type GitBaseContext = z.infer<typeof GitBaseContextSchema>;

export const CodeIntelStaleBaseSchema = z.object({
  expected: GitBaseContextSchema,
  actual: GitBaseContextSchema,
  detected_at: IsoDateTimeSchema,
  reason: z.enum(["base_commit_changed", "branch_changed", "worktree_changed", "git_context_unavailable"]),
  requires_reapproval: z.literal(true),
}).strict().superRefine((value, context) => {
  if (value.expected.status !== "available") {
    context.addIssue({
      code: "custom",
      path: ["expected", "status"],
      message: "a stale Git base requires an available expected Git context",
    });
  }

  if (value.reason === "git_context_unavailable") {
    if (value.actual.status !== "unavailable") {
      context.addIssue({
        code: "custom",
        path: ["actual", "status"],
        message: "git_context_unavailable requires an unavailable actual Git context",
      });
    }
    return;
  }

  if (value.actual.status !== "available") {
    context.addIssue({
      code: "custom",
      path: ["actual", "status"],
      message: `${value.reason} requires an available actual Git context`,
    });
    return;
  }

  if (value.expected.status !== "available") return;

  const field = value.reason === "base_commit_changed"
    ? "base_commit"
    : value.reason === "branch_changed"
      ? "branch"
      : "worktree_fingerprint";
  if (value.expected[field] === value.actual[field]) {
    context.addIssue({
      code: "custom",
      path: ["actual", field],
      message: `${value.reason} requires a changed ${field}`,
    });
  }
});
export type CodeIntelStaleBase = z.infer<typeof CodeIntelStaleBaseSchema>;

export const CodeIntelUpdatedDataSchema = z.object({
  project_id: IdentifierSchema,
  phase: z.enum(["baseline", "post_patch"]),
  git_context: GitBaseContextSchema,
  base_snapshot_id: IdentifierSchema.optional(),
  result_snapshot_id: IdentifierSchema.optional(),
  changed_files: z.array(RelativePathSchema).max(MAX_CODE_INTEL_CHANGED_FILES),
  changed_files_truncated: z.boolean().default(false),
  changed_symbols: z.array(ChangedSymbolSchema).max(MAX_CODE_INTEL_CHANGED_SYMBOLS),
  changed_symbols_truncated: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (value.phase === "baseline" && (value.changed_files.length !== 0 || value.changed_symbols.length !== 0)) {
    context.addIssue({ code: "custom", message: "baseline code intel cannot contain changed files or symbols" });
  }
  if (value.phase === "post_patch" && (value.base_snapshot_id === undefined || value.result_snapshot_id === undefined)) {
    context.addIssue({ code: "custom", message: "post_patch code intel requires both graph snapshot ids" });
  }
  if (new Set(value.changed_files).size !== value.changed_files.length) {
    context.addIssue({ code: "custom", path: ["changed_files"], message: "changed_files must be unique" });
  }
  if (new Set(value.changed_symbols.map(({ symbol_id }) => symbol_id)).size !== value.changed_symbols.length) {
    context.addIssue({ code: "custom", path: ["changed_symbols"], message: "changed_symbols must be unique" });
  }
});
export type CodeIntelUpdatedData = z.infer<typeof CodeIntelUpdatedDataSchema>;

export const CodeStaleBaseDetectedDataSchema = z.object({
  project_id: IdentifierSchema,
  stale_base: CodeIntelStaleBaseSchema,
}).strict();
export type CodeStaleBaseDetectedData = z.infer<typeof CodeStaleBaseDetectedDataSchema>;

export const CodeIntelProjectionSchema = z.object({
  version: z.literal(CODE_INTEL_VERSION),
  git_context: GitBaseContextSchema,
  base_snapshot_id: IdentifierSchema.optional(),
  result_snapshot_id: IdentifierSchema.optional(),
  changed_files: z.array(RelativePathSchema).max(MAX_CODE_INTEL_CHANGED_FILES),
  changed_files_truncated: z.boolean(),
  changed_symbols: z.array(ChangedSymbolSchema).max(MAX_CODE_INTEL_CHANGED_SYMBOLS),
  changed_symbols_truncated: z.boolean(),
  diagnostics_summary: LspDiagnosticsSummarySchema.optional(),
  stale_base: CodeIntelStaleBaseSchema.optional(),
}).strict();
export type CodeIntelProjection = z.infer<typeof CodeIntelProjectionSchema>;
