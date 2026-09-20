import { describe, expect, it } from "vitest";
import {
  MemoryTelemetrySink,
  NoopTelemetrySink,
  OtlpHttpTelemetrySink,
  type TelemetryFetch,
} from "../src/index.js";
import { runTelemetryConformance } from "../src/testing/conformance.js";

describe("telemetry sink conformance", () => {
  it("passes for noop", async () => {
    await expect(runTelemetryConformance(
      () => new NoopTelemetrySink(),
      { deliverySnapshot: () => "noop" },
    )).resolves.toMatchObject({
      sink: "noop",
      emitted: 3,
      invalid_event_rejected: true,
      flush_idempotent: true,
    });
  });

  it("passes for memory and preserves all conformance events", async () => {
    let sink: MemoryTelemetrySink | undefined;
    await expect(runTelemetryConformance(() => {
      sink = new MemoryTelemetrySink();
      return sink;
    }, {
      deliverySnapshot: (candidate) => JSON.stringify((candidate as MemoryTelemetrySink).snapshot()),
    })).resolves.toMatchObject({ sink: "memory", emitted: 3 });
    expect(sink?.snapshot().map((event) => event.kind)).toEqual(["span", "metric", "log"]);
  });

  it("passes for OTLP/HTTP and emits official JSON signal envelopes", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const mockFetch: TelemetryFetch = async (input, init = {}) => {
      calls.push({ url: String(input), init });
      return new Response(null, { status: 200 });
    };
    await expect(runTelemetryConformance(
      () => new OtlpHttpTelemetrySink({
        endpoint: "https://collector.example.test/otel",
        fetch: mockFetch,
        batchSize: 8,
      }),
      { deliverySnapshot: () => String(calls.length) },
    )).resolves.toMatchObject({ sink: "otlp_http", emitted: 3 });

    expect(calls.map((call) => call.url)).toEqual([
      "https://collector.example.test/otel/v1/traces",
      "https://collector.example.test/otel/v1/metrics",
      "https://collector.example.test/otel/v1/logs",
    ]);
    for (const call of calls) {
      expect(call.init.method).toBe("POST");
      expect(new Headers(call.init.headers).get("content-type")).toBe("application/json");
    }

    const trace = jsonBody(calls[0]!);
    const span = nestedRecord(trace, "resourceSpans", 0, "scopeSpans", 0, "spans", 0);
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/u);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/u);
    expect(span.kind).toBe(1);
    expect(span.startTimeUnixNano).toMatch(/^\d+$/u);
    expect(span.endTimeUnixNano).toMatch(/^\d+$/u);
    expect((span.status as Record<string, unknown>).code).toBe(1);

    const metric = jsonBody(calls[1]!);
    const point = nestedRecord(
      metric,
      "resourceMetrics",
      0,
      "scopeMetrics",
      0,
      "metrics",
      0,
      "gauge",
      "dataPoints",
      0,
    );
    expect(point.timeUnixNano).toMatch(/^\d+$/u);
    expect(point.asDouble).toBe(42);

    const logs = jsonBody(calls[2]!);
    const record = nestedRecord(logs, "resourceLogs", 0, "scopeLogs", 0, "logRecords", 0);
    expect(record.timeUnixNano).toMatch(/^\d+$/u);
    expect(record.severityNumber).toBe(9);
    expect(record.severityText).toBe("INFO");
  });

  it("rejects a backend that repeats delivery on an empty flush", async () => {
    let deliveries = 0;
    const retained: unknown[] = [];
    await expect(runTelemetryConformance(() => ({
      kind: "custom",
      emit(event) {
        retained.push(event);
      },
      async flush() {
        deliveries += retained.length;
      },
    }), {
      deliverySnapshot: () => String(deliveries),
    })).rejects.toThrow(/repeated delivery/u);
  });
});

function jsonBody(call: { init: RequestInit }): Record<string, unknown> {
  if (typeof call.init.body !== "string") throw new Error("Expected an OTLP JSON request body");
  return JSON.parse(call.init.body) as Record<string, unknown>;
}

function nestedRecord(root: unknown, ...path: Array<string | number>): Record<string, unknown> {
  let current = root;
  for (const part of path) {
    if (typeof part === "number") {
      if (!Array.isArray(current)) throw new Error("Expected array in OTLP payload");
      current = current[part];
    } else {
      if (typeof current !== "object" || current === null || Array.isArray(current)) {
        throw new Error("Expected object in OTLP payload");
      }
      current = (current as Record<string, unknown>)[part];
    }
  }
  if (typeof current !== "object" || current === null || Array.isArray(current)) {
    throw new Error("Expected record in OTLP payload");
  }
  return current as Record<string, unknown>;
}
