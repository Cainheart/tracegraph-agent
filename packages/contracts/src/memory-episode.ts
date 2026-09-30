import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, NonEmptyStringSchema } from "./common.js";
import { MemoryKindV2Schema, MemoryRunEvidenceRefSchema } from "./memory.js";

export const MemoryEpisodeOutcomeSchema = z.enum([
  "succeeded",
  "failed",
  "partial",
  "abandoned",
  "unknown",
]);
export type MemoryEpisodeOutcome = z.infer<typeof MemoryEpisodeOutcomeSchema>;

export const MemoryEpisodeSchema = z.object({
  schemaVersion: z.literal("tracegraph.memory-episode.v1"),
  episodeId: IdentifierSchema,
  projectId: IdentifierSchema,
  runId: IdentifierSchema,
  sessionId: IdentifierSchema.optional(),
  sourceRange: z.object({
    from: z.number().int().positive(),
    to: z.number().int().positive(),
  }).strict().superRefine((value, context) => {
    if (value.to < value.from) context.addIssue({ code: "custom", path: ["to"], message: "episode range must be ordered" });
  }),
  goalRefs: z.array(IdentifierSchema).max(64),
  evidenceRefs: z.array(MemoryRunEvidenceRefSchema).min(1).max(256),
  outcome: MemoryEpisodeOutcomeSchema,
  summary: NonEmptyStringSchema.max(2_000),
  boundaryReason: z.array(NonEmptyStringSchema.max(200)).min(1).max(16),
  projectorVersion: NonEmptyStringSchema.max(100),
  sourceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  settledAt: IsoDateTimeSchema,
}).strict();
export type MemoryEpisode = z.infer<typeof MemoryEpisodeSchema>;

/** Untrusted model output. Core resolves evidence sequences against the exact Run stream. */
export const MemoryEpisodeCandidateDraftSchema = z.object({
  // Identity claims must come from the user, never from behavior extraction.
  kind: MemoryKindV2Schema.exclude(["legacy_unclassified", "declared_identity"]),
  claim: NonEmptyStringSchema.max(8_000),
  normalizedKey: NonEmptyStringSchema.max(500).optional(),
  confidence: z.number().finite().min(0).max(1).optional(),
  evidenceSequences: z.array(z.number().int().positive()).min(1).max(32),
}).strict();
export type MemoryEpisodeCandidateDraft = z.infer<typeof MemoryEpisodeCandidateDraftSchema>;

export const MemoryEpisodeExtractionResultSchema = z.object({
  summary: NonEmptyStringSchema.max(2_000),
  candidates: z.array(MemoryEpisodeCandidateDraftSchema).max(8),
}).strict();
export type MemoryEpisodeExtractionResult = z.infer<typeof MemoryEpisodeExtractionResultSchema>;

/** Strict bounded wire sent to an optional extraction adapter. */
export const MemoryEpisodeExtractionInputSchema = z.object({
  projectId: IdentifierSchema,
  runId: IdentifierSchema,
  episodeId: IdentifierSchema,
  sourceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  outcome: MemoryEpisodeOutcomeSchema,
  sourceText: NonEmptyStringSchema.max(48_000),
  evidenceSequences: z.array(z.number().int().positive()).min(1).max(256),
}).strict();
export type MemoryEpisodeExtractionInput = z.infer<typeof MemoryEpisodeExtractionInputSchema>;
