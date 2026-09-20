import { z } from "zod";
import {
  IdentifierSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  SCHEMA_VERSION,
} from "./common.js";

/**
 * A transient, user-safe model presentation frame.
 *
 * This is intentionally separate from SessionEvent and the execution feed:
 * it has its own cursor, is process-local, and contains only a model-authored
 * public plan or answer preview. Older Hosts may still send the
 * `thinking_snapshot` type for reconnect compatibility, but provider-native
 * reasoning is private scratchpad data and must be dropped before rendering.
 */
export const ModelSurfaceTypeSchema = z.enum([
  "public_plan_snapshot",
  /** @deprecated Compatibility value; never render provider-private reasoning. */
  "thinking_snapshot",
  "answer_snapshot",
]);
export type ModelSurfaceType = z.infer<typeof ModelSurfaceTypeSchema>;

export const ModelSurfaceStatusSchema = z.enum([
  "streaming",
  "completed",
  "failed",
  "cancelled",
]);
export type ModelSurfaceStatus = z.infer<typeof ModelSurfaceStatusSchema>;

export const ModelSurfaceEventSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  surface_event_id: IdentifierSchema,
  project_id: IdentifierSchema,
  run_id: IdentifierSchema,
  model_call_id: IdentifierSchema,
  /** Cursor for this volatile stream only; it is not a ledger sequence. */
  cursor: z.number().int().positive(),
  occurred_at: IsoDateTimeSchema,
  type: ModelSurfaceTypeSchema,
  status: ModelSurfaceStatusSchema,
  /** Latest complete, redacted public snapshot for this model-call surface. */
  text: NonEmptyStringSchema.max(8_000),
});
export type ModelSurfaceEvent = z.infer<typeof ModelSurfaceEventSchema>;
