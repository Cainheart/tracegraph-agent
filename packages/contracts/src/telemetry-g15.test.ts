import { describe, expect, it } from "vitest";
import {
  DEFAULT_TELEMETRY_STATUS,
  TELEMETRY_STATUS_SCHEMA_VERSION,
  TelemetryStatusSchema,
} from "./telemetry.js";

describe("G-15 telemetry status contract", () => {
  it("accepts only bounded browser-safe sink status", () => {
    expect(DEFAULT_TELEMETRY_STATUS).toEqual({
      schema_version: "tracegraph.telemetry-status.v1",
      sink: "noop",
      state: "disabled",
      error_count: 0,
    });
    expect(TelemetryStatusSchema.parse({
      schema_version: TELEMETRY_STATUS_SCHEMA_VERSION,
      sink: "otlp_http",
      state: "degraded",
      error_count: 3,
      last_error_at: "2026-09-19T06:00:00.000Z",
    })).toMatchObject({ sink: "otlp_http", error_count: 3 });

    for (const invalid of [
      { ...DEFAULT_TELEMETRY_STATUS, schema_version: "tracegraph.telemetry-status.v2" },
      { ...DEFAULT_TELEMETRY_STATUS, sink: "file" },
      { ...DEFAULT_TELEMETRY_STATUS, state: "failed" },
      { ...DEFAULT_TELEMETRY_STATUS, error_count: -1 },
      { ...DEFAULT_TELEMETRY_STATUS, error_count: 0.5 },
      { ...DEFAULT_TELEMETRY_STATUS, last_error_at: "yesterday" },
      { ...DEFAULT_TELEMETRY_STATUS, state: "active" },
      { ...DEFAULT_TELEMETRY_STATUS, error_count: 1 },
      { ...DEFAULT_TELEMETRY_STATUS, last_error_at: "2026-09-19T06:00:00.000Z" },
      {
        ...DEFAULT_TELEMETRY_STATUS,
        sink: "otlp_http",
        state: "degraded",
        error_count: 0,
      },
      {
        ...DEFAULT_TELEMETRY_STATUS,
        sink: "otlp_http",
        state: "active",
        error_count: 2,
        last_error_at: "2026-09-19T06:00:00.000Z",
      },
    ]) {
      expect(() => TelemetryStatusSchema.parse(invalid)).toThrow();
    }
  });

  it("rejects every Host-only configuration or payload field", () => {
    const safe = {
      schema_version: TELEMETRY_STATUS_SCHEMA_VERSION,
      sink: "otlp_http" as const,
      state: "active" as const,
      error_count: 0,
    };

    for (const leaked of [
      { endpoint: "https://collector.example.test/v1/traces" },
      { headers: { authorization: "Bearer secret" } },
      { credential: "${secret:OTLP_TOKEN}" },
      { source_path: "/Users/example/.tracegraph/telemetry.json" },
      { pending_payload: { run_id: "run-private" } },
    ]) {
      expect(() => TelemetryStatusSchema.parse({ ...safe, ...leaked })).toThrow();
    }
  });
});
