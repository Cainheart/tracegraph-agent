export const TELEMETRY_STATUS_SCHEMA_VERSION = "tracegraph.telemetry-status.v1" as const;

export const MAX_TELEMETRY_NAME_CHARS = 160;
export const MAX_TELEMETRY_RUN_ID_CHARS = 160;
export const MAX_TELEMETRY_ATTRIBUTES = 32;
export const MAX_TELEMETRY_ATTRIBUTE_KEY_CHARS = 80;
export const MAX_TELEMETRY_ATTRIBUTE_STRING_CHARS = 2_000;
export const MAX_TELEMETRY_LOG_BODY_CHARS = 4_000;
export const MAX_TELEMETRY_UNIT_CHARS = 40;
export const MAX_TELEMETRY_SPAN_DURATION_MS = 86_400_000;

export type TelemetryAttributeValue = string | number | boolean;
export type TelemetryAttributes = Readonly<Record<string, TelemetryAttributeValue>>;

export interface TelemetryEventBase {
  readonly name: string;
  readonly at: string;
  readonly run_id: string;
  readonly attributes: TelemetryAttributes;
}

export interface SpanTelemetryEvent extends TelemetryEventBase {
  readonly kind: "span";
  readonly duration_ms: number;
  readonly status?: "unset" | "ok" | "error";
}

export interface MetricTelemetryEvent extends TelemetryEventBase {
  readonly kind: "metric";
  readonly value: number;
  readonly unit?: string;
}

export interface LogTelemetryEvent extends TelemetryEventBase {
  readonly kind: "log";
  readonly severity: "debug" | "info" | "warn" | "error";
  readonly body?: string;
}

export type TelemetryEvent = SpanTelemetryEvent | MetricTelemetryEvent | LogTelemetryEvent;

export type TelemetrySinkKind = "noop" | "memory" | "otlp_http" | "custom";
export type TelemetryState = "disabled" | "active" | "degraded";

export interface TelemetryStatus {
  readonly schema_version: typeof TELEMETRY_STATUS_SCHEMA_VERSION;
  readonly sink: TelemetrySinkKind;
  readonly state: TelemetryState;
  readonly error_count: number;
  readonly last_error_at?: string;
}
