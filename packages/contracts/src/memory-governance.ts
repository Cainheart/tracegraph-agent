import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, Sha256Schema } from "./common.js";
import { MemoryStatusV2Schema } from "./memory.js";

export const MemoryUseFeedbackValueSchema = z.enum([
  "helpful",
  "irrelevant",
  "incorrect",
  "stale",
]);
export type MemoryUseFeedbackValue = z.infer<typeof MemoryUseFeedbackValueSchema>;

export const MemoryFeedbackActorSchema = z.object({
  type: z.literal("user"),
  id: IdentifierSchema,
}).strict();

export const MemoryUseFeedbackCommandSchema = z.object({
  memoryVersion: z.number().int().positive(),
  runId: IdentifierSchema,
  memoryUseId: IdentifierSchema,
  contextManifestId: IdentifierSchema,
  feedback: MemoryUseFeedbackValueSchema,
  actor: MemoryFeedbackActorSchema,
  expectedSequence: z.number().int().nonnegative(),
  idempotencyKey: IdentifierSchema,
}).strict();
export type MemoryUseFeedbackCommand = z.infer<typeof MemoryUseFeedbackCommandSchema>;

export const MemoryFeedbackReviewDismissalCommandSchema = z.object({
  memoryVersion: z.number().int().positive(),
  feedbackEventId: IdentifierSchema,
  actor: MemoryFeedbackActorSchema,
  expectedSequence: z.number().int().nonnegative(),
  idempotencyKey: IdentifierSchema,
}).strict();
export type MemoryFeedbackReviewDismissalCommand = z.infer<typeof MemoryFeedbackReviewDismissalCommandSchema>;

const memoryFeedbackEventBase = {
  schemaVersion: z.literal("tracegraph.memory-feedback.v1"),
  eventType: z.literal("memory.feedback"),
  eventId: IdentifierSchema,
  ownerId: IdentifierSchema,
  memoryId: IdentifierSchema,
  memoryVersion: z.number().int().positive(),
  sequence: z.number().int().positive(),
  actor: MemoryFeedbackActorSchema,
  idempotencyKey: IdentifierSchema,
  occurredAt: IsoDateTimeSchema,
  previousEventHash: Sha256Schema.optional(),
  eventHash: Sha256Schema,
};

const memoryFeedbackDraftBase = {
  schemaVersion: z.literal("tracegraph.memory-feedback.v1"),
  eventType: z.literal("memory.feedback"),
  ownerId: IdentifierSchema,
  memoryId: IdentifierSchema,
  memoryVersion: z.number().int().positive(),
  expectedSequence: z.number().int().nonnegative(),
  actor: MemoryFeedbackActorSchema,
  idempotencyKey: IdentifierSchema,
  occurredAt: IsoDateTimeSchema,
};

export const MemoryFeedbackEventDraftSchema = z.discriminatedUnion("action", [
  z.object({
    ...memoryFeedbackDraftBase,
    action: z.literal("reported"),
    runId: IdentifierSchema,
    memoryUseId: IdentifierSchema,
    contextManifestId: IdentifierSchema,
    feedback: MemoryUseFeedbackValueSchema,
  }).strict(),
  z.object({
    ...memoryFeedbackDraftBase,
    action: z.literal("review_dismissed"),
    feedbackEventId: IdentifierSchema,
  }).strict(),
]);
export type MemoryFeedbackEventDraft = z.infer<typeof MemoryFeedbackEventDraftSchema>;

export const MemoryFeedbackEventSchema = z.discriminatedUnion("action", [
  z.object({
    ...memoryFeedbackEventBase,
    action: z.literal("reported"),
    runId: IdentifierSchema,
    memoryUseId: IdentifierSchema,
    contextManifestId: IdentifierSchema,
    feedback: MemoryUseFeedbackValueSchema,
  }).strict(),
  z.object({
    ...memoryFeedbackEventBase,
    action: z.literal("review_dismissed"),
    feedbackEventId: IdentifierSchema,
  }).strict(),
]);
export type MemoryFeedbackEvent = z.infer<typeof MemoryFeedbackEventSchema>;

export const MemoryFeedbackReviewSchema = z.object({
  feedbackEventId: IdentifierSchema,
  memoryId: IdentifierSchema,
  memoryVersion: z.number().int().positive(),
  feedback: z.enum(["incorrect", "stale"]),
  runId: IdentifierSchema,
  memoryUseId: IdentifierSchema,
  contextManifestId: IdentifierSchema,
  occurredAt: IsoDateTimeSchema,
}).strict();
export type MemoryFeedbackReview = z.infer<typeof MemoryFeedbackReviewSchema>;

export const MemoryFeedbackProjectionSchema = z.object({
  ownerId: IdentifierSchema,
  memoryId: IdentifierSchema,
  memoryVersion: z.number().int().positive(),
  sequence: z.number().int().nonnegative(),
  feedbackCounts: z.object({
    helpful: z.number().int().nonnegative(),
    irrelevant: z.number().int().nonnegative(),
    incorrect: z.number().int().nonnegative(),
    stale: z.number().int().nonnegative(),
  }).strict(),
  reviewRequired: z.array(MemoryFeedbackReviewSchema).max(500),
}).strict();
export type MemoryFeedbackProjection = z.infer<typeof MemoryFeedbackProjectionSchema>;

export const MemoryConflictParticipantSchema = z.object({
  memoryId: IdentifierSchema,
  version: z.number().int().positive(),
  status: MemoryStatusV2Schema,
}).strict();
export type MemoryConflictParticipant = z.infer<typeof MemoryConflictParticipantSchema>;

/** Content-free derived group; claims and normalized keys are not copied. */
export const MemoryConflictGroupSchema = z.object({
  conflictId: IdentifierSchema,
  ownerId: IdentifierSchema,
  normalizedKeyDigest: Sha256Schema,
  participants: z.array(MemoryConflictParticipantSchema).min(2).max(100),
}).strict();
export type MemoryConflictGroup = z.infer<typeof MemoryConflictGroupSchema>;

export const MemoryRecallBlockReasonSchema = z.enum([
  "not_active",
  "owner_mismatch",
  "scope_mismatch",
  "not_yet_valid",
  "expired",
  "model_use_disabled",
  "consent_missing",
  "sensitivity_blocked",
  "source_untrusted",
  "unresolved_conflict",
  "feedback_requires_review",
]);
export type MemoryRecallBlockReason = z.infer<typeof MemoryRecallBlockReasonSchema>;

export const MemoryRecallGateItemSchema = z.object({
  memoryId: IdentifierSchema,
  version: z.number().int().positive(),
}).strict();
export type MemoryRecallGateItem = z.infer<typeof MemoryRecallGateItemSchema>;

export const MemoryRecallGateBlockSchema = MemoryRecallGateItemSchema.extend({
  reason: MemoryRecallBlockReasonSchema,
}).strict();
export type MemoryRecallGateBlock = z.infer<typeof MemoryRecallGateBlockSchema>;

export const MemoryRecallGateResultSchema = z.object({
  eligible: z.array(MemoryRecallGateItemSchema).max(1_000),
  blocked: z.array(MemoryRecallGateBlockSchema).max(1_000),
  conflicts: z.array(MemoryConflictGroupSchema).max(500),
  feedbackReviewRequired: z.array(MemoryFeedbackReviewSchema).max(1_000),
}).strict();
export type MemoryRecallGateResult = z.infer<typeof MemoryRecallGateResultSchema>;
