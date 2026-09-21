import { z } from "zod";
import { IsoDateTimeSchema } from "./common.js";

/** Public, aggregate usage data exposed by the local Host. Secret and billing
 * credential details never cross this contract boundary. */
export const USAGE_SCHEMA_VERSION = "tracegraph.usage.v1" as const;

export const UsageCostSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/u),
  amount: z.number().finite().nonnegative(),
}).strict();
export type UsageCost = z.infer<typeof UsageCostSchema>;

export const UsageSnapshotSchema = z.object({
  schema_version: z.literal(USAGE_SCHEMA_VERSION),
  generated_at: IsoDateTimeSchema,
  source: z.enum(["ledger", "unavailable"]),
  run_count: z.number().int().nonnegative(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cached_input_tokens: z.number().int().nonnegative(),
  reasoning_output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  costs: z.array(UsageCostSchema).max(16),
}).strict();
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;

export const DEFAULT_USAGE_SNAPSHOT: Readonly<UsageSnapshot> = Object.freeze(
  UsageSnapshotSchema.parse({
    schema_version: USAGE_SCHEMA_VERSION,
    generated_at: new Date(0).toISOString(),
    source: "unavailable",
    run_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
    costs: [],
  }),
);
