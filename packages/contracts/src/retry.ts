import { z } from "zod";

export const ModelRetryReasonCodeSchema = z.enum([
  "http_408",
  "http_425",
  "http_429",
  "http_500",
  "http_502",
  "http_503",
  "http_504",
  "transport_timeout",
  "transport_network_error",
]);
export type ModelRetryReasonCode = z.infer<typeof ModelRetryReasonCodeSchema>;

export const ModelRetryScheduledDataSchema = z.object({
  retry_scope: z.literal("model_provider"),
  attempt: z.number().int().positive().max(5),
  next_attempt: z.number().int().positive().max(6),
  max_attempts: z.literal(6),
  delay_ms: z.number().int().positive().max(10_000),
  reason_code: ModelRetryReasonCodeSchema,
}).strict().superRefine((value, context) => {
  if (value.next_attempt !== value.attempt + 1 || value.next_attempt > value.max_attempts) {
    context.addIssue({
      code: "custom",
      path: ["next_attempt"],
      message: "next_attempt must follow attempt and remain within max_attempts",
    });
  }
});
export type ModelRetryScheduledData = z.infer<typeof ModelRetryScheduledDataSchema>;
