import { z } from "zod";
import { IdentifierSchema } from "./common.js";
import { ExperienceControlListResponseSchema, ExperienceLifecycleReviewRequestSchema, ExperienceLifecycleReviewResponseSchema } from "./experience-lifecycle.js";
import {
  MemoryCandidateCreateRequestSchema,
  MemoryControlItemSchema,
  MemoryControlListResponseSchema,
  MemoryCorrectionRequestSchema,
  MemoryDeleteRequestSchema,
  MemoryDeleteResponseSchema,
  MemoryReviewRequestSchema,
  MemoryRevokeRequestSchema,
} from "./memory-control.js";

/** Query vocabulary shared by Web HTTP adapters and private Desktop RPC. */
export const MemoryExperienceControlQuerySchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("memory.list") }).strict(),
  z.object({ operation: z.literal("experience.list") }).strict(),
]);
export type MemoryExperienceControlQuery = z.infer<typeof MemoryExperienceControlQuerySchema>;

/** Domain command payloads; owner/actor and allowed scope are Host authority. */
export const MemoryExperienceControlCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("memory.create"), input: MemoryCandidateCreateRequestSchema }).strict(),
  z.object({ type: z.literal("memory.review"), memory_id: IdentifierSchema, input: MemoryReviewRequestSchema }).strict(),
  z.object({ type: z.literal("memory.correct"), memory_id: IdentifierSchema, input: MemoryCorrectionRequestSchema }).strict(),
  z.object({ type: z.literal("memory.revoke"), memory_id: IdentifierSchema, input: MemoryRevokeRequestSchema }).strict(),
  z.object({ type: z.literal("memory.delete"), memory_id: IdentifierSchema, input: MemoryDeleteRequestSchema }).strict(),
  z.object({ type: z.literal("experience.review"), case_id: IdentifierSchema, input: ExperienceLifecycleReviewRequestSchema }).strict(),
]);
export type MemoryExperienceControlCommand = z.infer<typeof MemoryExperienceControlCommandSchema>;

export const MemoryExperienceControlReplySchema = z.discriminatedUnion("resource", [
  z.object({ resource: z.literal("memory_control"), value: MemoryControlListResponseSchema }).strict(),
  z.object({ resource: z.literal("memory_item"), value: MemoryControlItemSchema }).strict(),
  z.object({ resource: z.literal("memory_delete"), value: MemoryDeleteResponseSchema }).strict(),
  z.object({ resource: z.literal("experience_cases"), value: ExperienceControlListResponseSchema }).strict(),
  z.object({ resource: z.literal("experience_case"), value: ExperienceLifecycleReviewResponseSchema }).strict(),
]);
export type MemoryExperienceControlReply = z.infer<typeof MemoryExperienceControlReplySchema>;
