import { z } from "zod";
import { IsoDateTimeSchema } from "./common.js";

/** Public status schema only. OTLP endpoints, headers, credentials, config
 * source paths and buffered payloads remain Host-only. */
export const TELEMETRY_STATUS_SCHEMA_VERSION = "tracegraph.telemetry-status.v1" as const;

export const TelemetrySinkSchema = z.enum(["noop", "memory", "otlp_http", "custom"]);
export type TelemetrySink = z.infer<typeof TelemetrySinkSchema>;

export const TelemetryStateSchema = z.enum(["disabled", "active", "degraded"]);
export type TelemetryState = z.infer<typeof TelemetryStateSchema>;

export const TelemetryStatusSchema = z.object({
  schema_version: z.literal(TELEMETRY_STATUS_SCHEMA_VERSION),
  sink: TelemetrySinkSchema,
  state: TelemetryStateSchema,
  error_count: z.number().int().nonnegative(),
  last_error_at: IsoDateTimeSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.sink === "noop" && value.state !== "disabled") {
    context.addIssue({ code: "custom", path: ["state"], message: "noop telemetry must be disabled" });
  }
  if (value.sink !== "noop") {
    const expected = value.error_count === 0 ? "active" : "degraded";
    if (value.state !== expected) {
      context.addIssue({ code: "custom", path: ["state"], message: `telemetry state must be ${expected}` });
    }
  }
  if (value.error_count === 0 && value.last_error_at !== undefined) {
    context.addIssue({ code: "custom", path: ["last_error_at"], message: "healthy telemetry cannot have a last error" });
  }
  if (value.error_count > 0 && value.last_error_at === undefined) {
    context.addIssue({ code: "custom", path: ["last_error_at"], message: "telemetry errors require a timestamp" });
  }
});
export type TelemetryStatus = z.infer<typeof TelemetryStatusSchema>;

/** Naming alias for HTTP consumers that treat the status as a response body. */
export const TelemetryStatusResponseSchema = TelemetryStatusSchema;
export type TelemetryStatusResponse = TelemetryStatus;

export const DEFAULT_TELEMETRY_STATUS: Readonly<TelemetryStatus> = Object.freeze(
  TelemetryStatusSchema.parse({
    schema_version: TELEMETRY_STATUS_SCHEMA_VERSION,
    sink: "noop",
    state: "disabled",
    error_count: 0,
  }),
);
