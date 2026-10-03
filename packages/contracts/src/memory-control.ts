import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, NonEmptyStringSchema, Sha256Schema } from "./common.js";
import { MemoryKindV2Schema, MemoryRecordV2Schema } from "./memory.js";
import {
  MemoryConflictGroupSchema,
  MemoryFeedbackProjectionSchema,
} from "./memory-governance.js";
import { MemoryUseStageSchema } from "./memory-use.js";
import { MemoryRunEvidenceRefSchema } from "./memory.js";

/** User-authored candidate command. Owner and actor are supplied by Host. */
export const MemoryCandidateCreateRequestSchema = z.object({
  command_id: IdentifierSchema,
  kind: MemoryKindV2Schema.exclude(["legacy_unclassified"]),
  claim: NonEmptyStringSchema.max(8_000),
  normalized_key: NonEmptyStringSchema.max(500).optional(),
  project_id: IdentifierSchema.optional(),
  sensitivity: z.enum(["public", "internal", "personal", "secret"]).optional(),
  allow_model_use: z.boolean().optional(),
  /** Explicit consent for exporting this exact authored version; omitted means denied. */
  allow_export: z.boolean().optional(),
  source_description: z.string().max(500).optional(),
  retention_policy: NonEmptyStringSchema.max(200).optional(),
  valid_until: IsoDateTimeSchema.optional(),
}).strict();
export type MemoryCandidateCreateRequest = z.infer<typeof MemoryCandidateCreateRequestSchema>;

/** Core-only input for a review-gated candidate derived from a settled Run. */
export const MemoryDerivedCandidateRequestSchema = z.object({
  command_id: IdentifierSchema,
  // Identity claims must originate from the user-authored control surface.
  kind: MemoryKindV2Schema.exclude(["legacy_unclassified", "declared_identity"]),
  claim: NonEmptyStringSchema.max(8_000),
  normalized_key: NonEmptyStringSchema.max(500).optional(),
  project_id: IdentifierSchema,
  run_id: IdentifierSchema,
  source_digest: Sha256Schema,
  episode_id: IdentifierSchema,
  extractor_id: IdentifierSchema,
  inference_confidence: z.number().finite().min(0).max(1).optional(),
  evidence_refs: z.array(MemoryRunEvidenceRefSchema).min(1).max(32),
}).strict();
export type MemoryDerivedCandidateRequest = z.infer<typeof MemoryDerivedCandidateRequestSchema>;

/** Core-only, explicit import path. The Host supplies local owner and actor. */
export const MemoryCapsuleCandidateImportRequestSchema = z.object({
  command_id: IdentifierSchema,
  source_capsule_id: IdentifierSchema,
  source_capsule_digest: Sha256Schema,
  source_memory_id: IdentifierSchema,
  kind: MemoryKindV2Schema.exclude(["declared_identity"]),
  claim: NonEmptyStringSchema.max(8_000),
  normalized_key: NonEmptyStringSchema.max(500).optional(),
  project_id: IdentifierSchema.optional(),
  source_valid_from: IsoDateTimeSchema,
  source_valid_until: IsoDateTimeSchema.optional(),
  sensitivity: z.enum(["public", "internal", "personal"]),
}).strict();
export type MemoryCapsuleCandidateImportRequest = z.infer<typeof MemoryCapsuleCandidateImportRequestSchema>;

export const MemoryReviewRequestSchema = z.object({
  command_id: IdentifierSchema,
  expected_sequence: z.number().int().nonnegative(),
  action: z.enum(["review_activate", "review_reject"]),
}).strict();
export type MemoryReviewRequest = z.infer<typeof MemoryReviewRequestSchema>;

export const MemoryCorrectionRequestSchema = z.object({
  command_id: IdentifierSchema,
  expected_sequence: z.number().int().nonnegative(),
  claim: NonEmptyStringSchema.max(8_000),
  normalized_key: NonEmptyStringSchema.max(500).optional(),
  /** Fresh consent for the corrected exact version; never inherits prior consent. */
  allow_export: z.boolean().optional(),
}).strict();
export type MemoryCorrectionRequest = z.infer<typeof MemoryCorrectionRequestSchema>;

export const MemoryRevokeRequestSchema = z.object({
  command_id: IdentifierSchema,
  expected_sequence: z.number().int().nonnegative(),
}).strict();
export type MemoryRevokeRequest = z.infer<typeof MemoryRevokeRequestSchema>;

export const MemoryDeleteRequestSchema = z.object({ command_id: IdentifierSchema }).strict();
export type MemoryDeleteRequest = z.infer<typeof MemoryDeleteRequestSchema>;

export const MemoryDeleteResponseSchema = z.object({
  deletedMemoryIds: z.array(IdentifierSchema).min(1).max(2_000),
}).strict();
export type MemoryDeleteResponse = z.infer<typeof MemoryDeleteResponseSchema>;

const memoryControlDraftBase = {
  schemaVersion: z.literal("tracegraph.memory-control.v1"),
  eventType: z.literal("memory.control.commanded"),
  ownerId: IdentifierSchema,
  memoryId: IdentifierSchema,
  memoryVersion: z.number().int().positive(),
  expectedSequence: z.number().int().nonnegative(),
  actor: z.discriminatedUnion("type", [
    z.object({ type: z.literal("user"), id: IdentifierSchema }).strict(),
    z.object({ type: z.literal("system"), id: IdentifierSchema }).strict(),
  ]),
  idempotencyKey: IdentifierSchema,
  occurredAt: IsoDateTimeSchema,
};

export const MemoryControlEventDraftSchema = z.discriminatedUnion("action", [
  z.object({
    ...memoryControlDraftBase,
    action: z.literal("candidate_created"),
    contentDigest: Sha256Schema,
  }).strict(),
  z.object({
    ...memoryControlDraftBase,
    action: z.literal("derived_candidate_created"),
    contentDigest: Sha256Schema,
    episodeId: IdentifierSchema,
    sourceDigest: Sha256Schema,
  }).strict(),
  z.object({
    ...memoryControlDraftBase,
    action: z.literal("imported_candidate_created"),
    contentDigest: Sha256Schema,
    sourceCapsuleId: IdentifierSchema,
    sourceCapsuleDigest: Sha256Schema,
    sourceMemoryId: IdentifierSchema,
  }).strict(),
  z.object({
    ...memoryControlDraftBase,
    action: z.literal("corrected"),
    contentDigest: Sha256Schema,
    relatedMemoryId: IdentifierSchema,
  }).strict(),
  z.object({
    ...memoryControlDraftBase,
    action: z.literal("deleted"),
    deletedMemoryIds: z.array(IdentifierSchema).min(1).max(2_000),
    deletedScopeIds: z.array(IdentifierSchema).max(100),
  }).strict(),
]);
export type MemoryControlEventDraft = z.infer<typeof MemoryControlEventDraftSchema>;

const memoryControlEventBase = {
  schemaVersion: z.literal("tracegraph.memory-control.v1"),
  eventType: z.literal("memory.control.commanded"),
  eventId: IdentifierSchema,
  ownerId: IdentifierSchema,
  memoryId: IdentifierSchema,
  memoryVersion: z.number().int().positive(),
  sequence: z.number().int().positive(),
  actor: z.discriminatedUnion("type", [
    z.object({ type: z.literal("user"), id: IdentifierSchema }).strict(),
    z.object({ type: z.literal("system"), id: IdentifierSchema }).strict(),
  ]),
  idempotencyKey: IdentifierSchema,
  occurredAt: IsoDateTimeSchema,
  previousEventHash: Sha256Schema.optional(),
  eventHash: Sha256Schema,
};

export const MemoryControlEventSchema = z.discriminatedUnion("action", [
  z.object({
    ...memoryControlEventBase,
    action: z.literal("candidate_created"),
    contentDigest: Sha256Schema,
  }).strict(),
  z.object({
    ...memoryControlEventBase,
    action: z.literal("derived_candidate_created"),
    contentDigest: Sha256Schema,
    episodeId: IdentifierSchema,
    sourceDigest: Sha256Schema,
  }).strict(),
  z.object({
    ...memoryControlEventBase,
    action: z.literal("imported_candidate_created"),
    contentDigest: Sha256Schema,
    sourceCapsuleId: IdentifierSchema,
    sourceCapsuleDigest: Sha256Schema,
    sourceMemoryId: IdentifierSchema,
  }).strict(),
  z.object({
    ...memoryControlEventBase,
    action: z.literal("corrected"),
    contentDigest: Sha256Schema,
    relatedMemoryId: IdentifierSchema,
  }).strict(),
  z.object({
    ...memoryControlEventBase,
    action: z.literal("deleted"),
    deletedMemoryIds: z.array(IdentifierSchema).min(1).max(2_000),
    deletedScopeIds: z.array(IdentifierSchema).max(100),
  }).strict(),
]);
export type MemoryControlEvent = z.infer<typeof MemoryControlEventSchema>;

export const MemoryUseRequestSummarySchema = z.object({
  runId: IdentifierSchema,
  memoryUseId: IdentifierSchema,
  memoryVersion: z.number().int().positive(),
  contextManifestId: IdentifierSchema,
  stage: MemoryUseStageSchema,
  occurredAt: IsoDateTimeSchema,
}).strict();
export type MemoryUseRequestSummary = z.infer<typeof MemoryUseRequestSummarySchema>;

export const MemoryControlItemSchema = z.object({
  record: MemoryRecordV2Schema,
  lifecycleSequence: z.number().int().nonnegative(),
  feedback: MemoryFeedbackProjectionSchema,
  memoryUseRequests: z.array(MemoryUseRequestSummarySchema).max(500),
}).strict();
export type MemoryControlItem = z.infer<typeof MemoryControlItemSchema>;

/** Content-free, inspectable result of deterministic scope-local consolidation. */
export const MemoryConsolidationResultSchema = z.object({
  action: z.enum(["candidate", "unchanged"]),
  requestDigest: Sha256Schema,
  memoryId: IdentifierSchema,
  comparedMemoryIds: z.array(IdentifierSchema).max(32),
  sourceRunIds: z.array(IdentifierSchema).min(1).max(128),
}).strict();
export type MemoryConsolidationResult = z.infer<typeof MemoryConsolidationResultSchema>;

/** Operational projection only; canonical Run and candidate facts remain in the Ledger. */
export const MemoryBackgroundJobSchema = z.object({
  runId: IdentifierSchema,
  projectId: IdentifierSchema,
  sourceDigest: Sha256Schema.optional(),
  status: z.enum(["waiting", "running", "retry", "complete", "exhausted"]),
  attempts: z.number().int().nonnegative().max(5),
  nextAttemptAt: IsoDateTimeSchema.optional(),
  candidateCount: z.number().int().nonnegative().max(8),
  lastErrorCode: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/u).optional(),
  updatedAt: IsoDateTimeSchema,
  consolidationResults: z.array(MemoryConsolidationResultSchema).max(8),
  /** Legacy v1 counts covered attempted proposals and had no result references. */
  resultDetailsAvailable: z.boolean(),
}).strict();
export type MemoryBackgroundJob = z.infer<typeof MemoryBackgroundJobSchema>;

export const MemoryControlListResponseSchema = z.object({
  items: z.array(MemoryControlItemSchema).max(2_000),
  conflicts: z.array(MemoryConflictGroupSchema).max(500),
  backgroundJobs: z.array(MemoryBackgroundJobSchema).max(100).optional(),
  /** True while the disposable historical job index is incomplete. */
  backgroundJobsLoading: z.boolean().optional(),
}).strict();
export type MemoryControlListResponse = z.infer<typeof MemoryControlListResponseSchema>;
