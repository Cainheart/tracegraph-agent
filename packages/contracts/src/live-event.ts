import { z } from "zod";
import {
  IdentifierSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  SCHEMA_VERSION,
} from "./common.js";

/**
 * A small, in-memory presentation event for the live execution feed.
 *
 * This is deliberately not a SessionEvent: it is not written to the JSONL
 * ledger and it never carries a provider request/response body, token delta,
 * hidden reasoning, credential, or raw tool output.  It is a safe projection
 * of a real runtime event, suitable for an SSE-connected workbench.
 */
export const LiveActivityKindSchema = z.enum(["run", "context", "model", "tool"]);
export type LiveActivityKind = z.infer<typeof LiveActivityKindSchema>;

export const LiveActivityStatusSchema = z.enum([
  "started",
  "completed",
  "failed",
  "cancelled",
  "info",
]);
export type LiveActivityStatus = z.infer<typeof LiveActivityStatusSchema>;

export const LivePublicActivitySchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  activity_id: IdentifierSchema,
  source_event_id: IdentifierSchema,
  source_event_type: NonEmptyStringSchema.max(80),
  project_id: IdentifierSchema,
  run_id: IdentifierSchema,
  sequence: z.number().int().positive(),
  occurred_at: IsoDateTimeSchema,
  kind: LiveActivityKindSchema,
  status: LiveActivityStatusSchema,
  summary: NonEmptyStringSchema.max(800),
  turn_id: IdentifierSchema.optional(),
  model_call_id: IdentifierSchema.optional(),
  operation_id: IdentifierSchema.optional(),
  action_id: IdentifierSchema.optional(),
});
export type LivePublicActivity = z.infer<typeof LivePublicActivitySchema>;
