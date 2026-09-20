import { z } from "zod";

export const SCHEMA_VERSION = "tracegraph.session-event.v1" as const;
// G-01 adds the durable session identity and the interrupted Run state to the
// derived read model. SessionEvent v1 remains backward-compatible, while the
// projector contract changes and therefore advances independently.
// G-04 adds the explicit `needs_manual_review` projection state for an
// Action-WAL divergence. G-09 adds execute-mode migration, pending plans, and
// Todo projection. Event v1 remains append-compatible, but consumers need to
// understand the new derived state. G-14 adds the durable user-input mailbox
// and its latest consumption fact. G-07 adds the durable parent-side child Run
// projection while leaving the append-only SessionEvent envelope at v1. G-18
// adds the replayed attachment projection and advances the projector only.
// G-08 adds the optional ledger-derived Agent Team roster, mailbox, and shared
// task board. The SessionEvent envelope and private recovery artifact remain
// unchanged because every team fact is replayable from the root Run ledger.
// G-20 adds the optional semantic CodeGraph/Git baseline projection. Existing
// event envelopes remain append-compatible, while clients need the new view.
export const PROJECTOR_VERSION = "tracegraph.projector.v9" as const;

export const NonEmptyStringSchema = z.string().trim().min(1);
export const IdentifierSchema = z.string().trim().min(1).max(160);
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
/**
 * Tool names are an extensibility boundary. Built-ins keep their historical
 * short names while trusted extensions may use a namespaced name such as
 * `vendor.tool` or `vendor:tool`. The bounded grammar is shared with policy
 * rules so model output, receipts and permission evaluation cannot drift.
 */
export const ToolNameSchema = NonEmptyStringSchema
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u, "invalid tool name");
export type ToolName = z.infer<typeof ToolNameSchema>;
export const RelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/")
      && !value.startsWith("\\")
      && !/^[A-Za-z]:/u.test(value)
      && !value.split(/[\\/]/u).includes(".."),
    {
    message: "path must be workspace-relative and cannot contain '..'",
    },
  );

export const TrustLevelSchema = z.enum(["trusted", "untrusted", "quarantined"]);
export type TrustLevel = z.infer<typeof TrustLevelSchema>;

export const SourceRefSchema = z.object({
  source_id: IdentifierSchema,
  source_type: z.enum(["user", "system", "repository", "tool", "memory", "fixture"]),
  trust: TrustLevelSchema,
  artifact_ref: z.lazy(() => ArtifactRefSchema).optional(),
  description: z.string().max(500).optional(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const ArtifactKindSchema = z.enum([
  "tool_output",
  "spilled_tool_output",
  "context_source_archive",
  "patch_preview",
  "diff",
  "test_log",
  "graph_snapshot",
  "graph_delta",
  "context_manifest",
  "recovery_state",
  "report",
  "image/png",
  "image/jpeg",
  "application/pdf",
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const ArtifactRefSchema = z.object({
  artifact_id: IdentifierSchema,
  kind: ArtifactKindSchema,
  content_hash: Sha256Schema,
  mime_type: NonEmptyStringSchema,
  byte_length: z.number().int().nonnegative(),
  project_id: IdentifierSchema,
  run_id: IdentifierSchema,
  created_at: IsoDateTimeSchema,
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

const ArtifactAvailableSchema = z.object({
  status: z.literal("available"),
  artifact: ArtifactRefSchema,
  content: z.string(),
  range: z
    .object({
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    })
    .optional(),
});

const ArtifactUnavailableSchema = z.object({
  status: z.literal("unavailable"),
  artifact_id: IdentifierSchema,
  reason: z.enum(["not_found", "out_of_scope", "unsupported_mime", "too_large"]),
});

const ArtifactCorruptSchema = z.object({
  status: z.literal("corrupt"),
  artifact_id: IdentifierSchema,
  expected_hash: Sha256Schema,
  actual_hash: Sha256Schema.optional(),
  reason: NonEmptyStringSchema,
});

export const ArtifactWireResponseSchema = z.discriminatedUnion("status", [
  ArtifactAvailableSchema,
  ArtifactUnavailableSchema,
  ArtifactCorruptSchema,
]);
export type ArtifactWireResponse = z.infer<typeof ArtifactWireResponseSchema>;
