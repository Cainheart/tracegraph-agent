import { z } from "zod";
import { IdentifierSchema, NonEmptyStringSchema, Sha256Schema } from "./common.js";
import { RetrievalAttributionSchema, MemoryVersionReferenceSchema } from "./memory.js";
import { TokenEstimateSchema } from "./token.js";

export const MemoryUseStageSchema = z.enum([
  "dispatch_intent",
  "adapter_invoked",
  "response",
  "failed",
  "unknown",
]);
export type MemoryUseStage = z.infer<typeof MemoryUseStageSchema>;

/** Content-free link from a final Context item to its retrieved Memory version. */
export const MemoryUseItemSchema = z.object({
  context_item_id: IdentifierSchema,
  memory_ref: MemoryVersionReferenceSchema,
  retrieval: RetrievalAttributionSchema,
  content_digest: Sha256Schema,
  included_tokens: z.number().int().positive(),
}).strict().superRefine((value, context) => {
  if (value.retrieval.memory_ref === undefined) {
    context.addIssue({ code: "custom", path: ["retrieval", "memory_ref"], message: "MemoryUse requires canonical Memory identity" });
  } else if (
    value.retrieval.memory_ref.memory_id !== value.memory_ref.memory_id
    || value.retrieval.memory_ref.version !== value.memory_ref.version
    || value.retrieval.memory_ref.content_hash !== value.memory_ref.content_hash
  ) {
    context.addIssue({ code: "custom", path: ["memory_ref"], message: "MemoryUse identity must match retrieval provenance" });
  }
  if (value.retrieval.injected_tokens !== value.included_tokens) {
    context.addIssue({ code: "custom", path: ["included_tokens"], message: "MemoryUse token count must match the selected Context item" });
  }
});
export type MemoryUseItem = z.infer<typeof MemoryUseItemSchema>;

const MemoryUseEventBaseShape = { memory_use_id: IdentifierSchema };

/**
 * One append-only MemoryUse status fact. The dispatch intent carries the
 * exact request digests and selected Memory references; later status events
 * carry no Memory claim text or Provider response body.
 */
export const MemoryUseEventDataSchema = z.discriminatedUnion("stage", [
  z.object({
    ...MemoryUseEventBaseShape,
    stage: z.literal("dispatch_intent"),
    manifest_id: IdentifierSchema,
    rendered_context_digest: Sha256Schema,
    token_estimate: TokenEstimateSchema,
    memory_items: z.array(MemoryUseItemSchema).min(1).max(100),
  }).strict(),
  z.object({
    ...MemoryUseEventBaseShape,
    stage: z.literal("adapter_invoked"),
    adapter_name: NonEmptyStringSchema.max(160),
  }).strict(),
  z.object({
    ...MemoryUseEventBaseShape,
    stage: z.literal("response"),
  }).strict(),
  z.object({
    ...MemoryUseEventBaseShape,
    stage: z.literal("failed"),
    reason: z.enum(["request_failed", "adapter_error", "invalid_response", "usage_rejected"]),
  }).strict(),
  z.object({
    ...MemoryUseEventBaseShape,
    stage: z.literal("unknown"),
    reason: z.enum(["run_interrupted", "aborted", "outcome_unobserved"]),
  }).strict(),
]);
export type MemoryUseEventData = z.infer<typeof MemoryUseEventDataSchema>;

