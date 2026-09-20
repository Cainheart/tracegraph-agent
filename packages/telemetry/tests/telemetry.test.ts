import { mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryTelemetrySink,
  NoopTelemetrySink,
  OtlpHttpTelemetrySink,
  SafeTelemetry,
  TelemetryError,
  createTelemetrySink,
  loadTelemetryConfig,
  parseTelemetryConfig,
  parseTelemetryEvent,
  type TelemetryEvent,
  type TelemetryFetch,
  type TelemetrySink,
} from "../src/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("bounded telemetry state", () => {
  it("normalizes, clones, redacts, and bounds the memory sink", () => {
    const sink = new MemoryTelemetrySink({ maxEvents: 2 });
    const attributes: Record<string, string> = {
      phase: "first",
      authorization: "Bearer never-store-this",
    };
    sink.emit(logEvent("one", attributes, "token=never-store-this"));
    attributes.phase = "mutated";
    sink.emit(logEvent("two", { phase: "second" }));
    sink.emit(logEvent("three", { phase: "third" }));

    expect(sink.size).toBe(2);
    expect(sink.droppedEvents).toBe(1);
    expect(sink.snapshot().map((event) => event.name)).toEqual(["two", "three"]);
    const normalized = parseTelemetryEvent(logEvent("secret", {
      authorization: "Bearer top-secret-value",
    }, "api_key=top-secret-value"));
    expect(JSON.stringify(normalized)).not.toContain("top-secret-value");
    expect(normalized.attributes.authorization).toBe("[REDACTED]");

    const expanding = parseTelemetryEvent(logEvent("expanding", {
      detail: "token=a ".repeat(250),
    }));
    expect(String(expanding.attributes.detail)).toHaveLength(2_000);
    expect(String(expanding.attributes.detail)).not.toContain("token=a");
  });

  it("rejects unknown fields and never includes invalid content in errors", () => {
    const secret = "invalid-secret-sentinel";
    let failure: unknown;
    try {
      parseTelemetryEvent({ ...logEvent("invalid", {}), extra: secret });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "invalid_event" });
    expect(String(failure)).not.toContain(secret);
  });

  it("rejects timestamps outside the OTLP uint64 nanosecond range", () => {
    expect(() => parseTelemetryEvent({
      ...logEvent("before-epoch", {}),
      at: "1960-01-01T00:00:00.000Z",
    })).toThrowError(TelemetryError);
    expect(() => parseTelemetryEvent({
      ...logEvent("after-uint64", {}),
      at: "2554-07-21T23:34:33.710Z",
    })).toThrowError(TelemetryError);
    expect(() => parseTelemetryEvent({
      kind: "span",
      name: "overflowing-span",
      at: "2554-07-21T23:34:33.709Z",
      run_id: "run:test",
      attributes: {},
      duration_ms: 1,
      status: "ok",
    })).toThrowError(TelemetryError);
    expect(parseTelemetryEvent({
      ...logEvent("max-millisecond", {}),
      at: "2554-07-21T23:34:33.709Z",
    }).at).toBe("2554-07-21T23:34:33.709Z");
    expect(() => parseTelemetryEvent({
      kind: "metric",
      name: "empty-unit",
      at: "2026-09-19T00:00:00.000Z",
      run_id: "run:test",
      attributes: {},
      value: 1,
      unit: "",
    })).toThrowError(TelemetryError);
  });

  it("preserves token counters while redacting credential-token key segments", () => {
    const event = parseTelemetryEvent({
      kind: "metric",
      name: "model.tokens.total",
      at: "2026-09-19T00:00:00.000Z",
      run_id: "run:test",
      attributes: {
        input_tokens: 120,
        output_tokens: 30,
        tokenizer: "provider-native",
        auth_token: "private-token-value",
      },
      value: 150,
      unit: "tokens",
    });

    expect(event.attributes).toMatchObject({
      input_tokens: 120,
      output_tokens: 30,
      tokenizer: "provider-native",
      auth_token: "[REDACTED]",
    });
    expect(JSON.stringify(event)).not.toContain("private-token-value");
  });
});

describe("SafeTelemetry", () => {
  it("swallows sink failures, tracks secret-free status, and does not recursively report errors", async () => {
    let emitCalls = 0;
    let flushCalls = 0;
    const sink: TelemetrySink = {
      kind: "custom",
      emit() {
        emitCalls += 1;
        throw new Error("Bearer private-export-token");
      },
      async flush() {
        flushCalls += 1;
        throw new Error("private response body");
      },
    };
    const safe = new SafeTelemetry(sink, { now: () => new Date("2026-09-19T00:00:00.000Z") });
    expect(() => safe.emit(logEvent("run", {}))).not.toThrow();
    await expect(safe.flush()).resolves.toBeUndefined();

    expect(emitCalls).toBe(2);
    expect(flushCalls).toBe(1);
    expect(safe.sinkErrors).toBe(3);
    expect(safe.status()).toEqual({
      schema_version: "tracegraph.telemetry-status.v1",
      sink: "custom",
      state: "degraded",
      error_count: 3,
      last_error_at: "2026-09-19T00:00:00.000Z",
    });
    expect(JSON.stringify(safe.status())).not.toContain("private");
  });

  it("reports a recovered sink error exactly once as telemetry.sink_errors", async () => {
    const events: TelemetryEvent[] = [];
    let shouldFail = true;
    const sink: TelemetrySink = {
      kind: "custom",
      emit(event) {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("transient");
        }
        events.push(event);
      },
      async flush() {},
    };
    const safe = new SafeTelemetry(sink, { now: () => new Date("2026-09-19T00:00:00.000Z") });
    safe.emit(logEvent("run", {}));
    await safe.flush();
    await safe.flush();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "metric",
      name: "telemetry.sink_errors",
      value: 1,
      unit: "errors",
    });
  });

  it("reports noop as disabled without external effects", async () => {
    const safe = new SafeTelemetry(new NoopTelemetrySink());
    safe.emit(logEvent("run", {}));
    await safe.flush();
    expect(safe.status()).toMatchObject({ sink: "noop", state: "disabled", error_count: 0 });
  });

  it("reflects a trusted composite sink whose public kind changes while idle", () => {
    let kind: TelemetrySink["kind"] = "noop";
    const sink: TelemetrySink = {
      get kind() { return kind; },
      emit() {},
      async flush() {},
    };
    const safe = new SafeTelemetry(sink);
    expect(safe.status()).toMatchObject({ sink: "noop", state: "disabled" });

    kind = "custom";
    expect(safe.status()).toMatchObject({ sink: "custom", state: "active" });
  });

  it("treats each same-tick flush call as a barrier for newly emitted events", async () => {
    const calls: string[] = [];
    const sink = new OtlpHttpTelemetrySink({
      endpoint: "https://collector.example.test",
      fetch: async (input) => {
        calls.push(String(input));
        return new Response(null, { status: 200 });
      },
    });
    const safe = new SafeTelemetry(sink);

    const emptyFlush = safe.flush();
    safe.emit(logEvent("same-tick", {}));
    await safe.flush();
    await emptyFlush;

    expect(calls).toEqual(["https://collector.example.test/v1/logs"]);
    expect(sink.pendingEvents).toBe(0);
  });

  it("coalesces a concurrent flush storm into one bounded follow-up", async () => {
    const releases: Array<() => void> = [];
    let flushCalls = 0;
    const sink: TelemetrySink = {
      kind: "custom",
      emit() {},
      async flush() {
        flushCalls += 1;
        await new Promise<void>((resolve) => releases.push(resolve));
      },
    };
    const safe = new SafeTelemetry(sink);

    const active = safe.flush();
    const storm = Array.from({ length: 1_000 }, () => safe.flush());
    await Promise.resolve();
    expect(flushCalls).toBe(1);
    expect(storm.every((promise) => promise === storm[0])).toBe(true);

    releases.shift()?.();
    await waitUntil(() => flushCalls === 2);
    releases.shift()?.();
    await Promise.all([active, ...storm]);

    expect(flushCalls).toBe(2);
  });

  it("serializes a sink that synchronously re-enters SafeTelemetry.flush", async () => {
    let safe!: SafeTelemetry;
    let nestedFlush: Promise<void> | undefined;
    let calls = 0;
    let active = 0;
    let peak = 0;
    const sink: TelemetrySink = {
      kind: "custom",
      emit() {},
      async flush() {
        calls += 1;
        active += 1;
        peak = Math.max(peak, active);
        if (calls === 1) nestedFlush = safe.flush();
        await Promise.resolve();
        active -= 1;
      },
    };
    safe = new SafeTelemetry(sink);

    await safe.flush();
    await nestedFlush;

    expect(calls).toBe(2);
    expect(peak).toBe(1);
  });
});

describe("telemetry configuration", () => {
  it("defaults missing configuration to noop and loads strict bounded JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracegraph-telemetry-config-"));
    temporaryRoots.push(root);
    await expect(loadTelemetryConfig(join(root, "missing.json"))).resolves.toEqual({ sink: "noop" });
    const path = join(root, "telemetry.json");
    await writeFile(path, JSON.stringify({ sink: "memory", max_events: 7 }));
    await expect(loadTelemetryConfig(path)).resolves.toEqual({ sink: "memory", max_events: 7 });
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked telemetry configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracegraph-telemetry-symlink-"));
    temporaryRoots.push(root);
    const target = join(root, "real.json");
    const link = join(root, "telemetry.json");
    await writeFile(target, JSON.stringify({ sink: "noop" }));
    await symlink(target, link);
    try {
      await expect(loadTelemetryConfig(link)).rejects.toMatchObject({ code: "invalid_config" });
    } finally {
      await unlink(link).catch(() => undefined);
    }
  });

  it("keeps the default factory noop even when OTLP environment is present", async () => {
    let fetchCalls = 0;
    const sink = await createTelemetrySink(undefined, {
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.test" },
      fetch: async () => {
        fetchCalls += 1;
        return new Response(null, { status: 200 });
      },
    });
    sink.emit(logEvent("default-noop", {}));
    await sink.flush();
    expect(sink.kind).toBe("noop");
    expect(fetchCalls).toBe(0);
  });

  it("rejects plaintext credentials and unknown config without echoing them", () => {
    const secret = "plain-secret-must-not-leak";
    for (const config of [
      { sink: "otlp_http", authorization: secret },
      { sink: "otlp_http", authorization_ref: secret },
      { sink: "otlp_http", authorization_ref: "${secret:lowercase-name}" },
      { sink: "noop", extra: secret },
    ]) {
      let failure: unknown;
      try {
        parseTelemetryConfig(config);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "invalid_config" });
      expect(String(failure)).not.toContain(secret);
    }
  });

  it("resolves endpoint from env and authorization only through a secret reference", async () => {
    const calls: RequestInit[] = [];
    const fetch: TelemetryFetch = async (_input, init = {}) => {
      calls.push(init);
      return new Response(null, { status: 200 });
    };
    const sink = await createTelemetrySink({
      sink: "otlp_http",
      authorization_ref: "${secret:OTLP_AUTH}",
    }, {
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.test" },
      resolveSecret: async (name) => name === "OTLP_AUTH" ? "Bearer private-token" : undefined,
      fetch,
    });
    sink.emit(logEvent("configured", {}));
    await sink.flush();

    expect(new Headers(calls[0]?.headers).get("authorization")).toBe("Bearer private-token");
    expect(JSON.stringify(sink)).not.toContain("private-token");
  });
});

describe("OTLP failure and bounds", () => {
  it("rejects unsafe URLs and CRLF headers with generic errors", () => {
    const candidates = [
      () => new OtlpHttpTelemetrySink({ endpoint: "ftp://collector.example.test" }),
      () => new OtlpHttpTelemetrySink({ endpoint: "https://user:pass@collector.example.test" }),
      () => new OtlpHttpTelemetrySink({ endpoint: "https://collector.example.test?token=secret" }),
      () => new OtlpHttpTelemetrySink({
        endpoint: "https://collector.example.test",
        headers: { authorization: "Bearer safe\r\nX-Injected: secret" },
      }),
    ];
    for (const make of candidates) {
      expect(make).toThrowError(TelemetryError);
      try {
        make();
      } catch (error) {
        expect(String(error)).not.toContain("pass");
        expect(String(error)).not.toContain("secret");
      }
    }
  });

  it("keeps retryable batches queued and never echoes collector response bodies", async () => {
    const responseSecret = "collector-secret-response";
    const fetch: TelemetryFetch = async () => new Response(responseSecret, { status: 503 });
    const sink = new OtlpHttpTelemetrySink({
      endpoint: "https://collector.example.test",
      headers: { authorization: "Bearer private-token" },
      fetch,
      maxQueueSize: 1,
    });
    sink.emit(logEvent("one", {}));
    expect(() => sink.emit(logEvent("two", {}))).toThrowError(/queue is full/u);
    let failure: unknown;
    try {
      await sink.flush();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "export_failed" });
    expect(String(failure)).not.toContain(responseSecret);
    expect(String(failure)).not.toContain("private-token");
    expect(sink.pendingEvents).toBe(1);
  });

  it("drops a non-retryable poison batch so a later event can export", async () => {
    let calls = 0;
    const sink = new OtlpHttpTelemetrySink({
      endpoint: "https://collector.example.test",
      fetch: async () => {
        calls += 1;
        return new Response(null, { status: calls === 1 ? 400 : 200 });
      },
    });
    sink.emit(logEvent("invalid-for-collector", {}));
    await expect(sink.flush()).rejects.toMatchObject({ code: "export_failed" });
    expect(sink.pendingEvents).toBe(0);

    sink.emit(logEvent("next", {}));
    await expect(sink.flush()).resolves.toBeUndefined();
    expect(calls).toBe(2);
    expect(sink.pendingEvents).toBe(0);
  });

  it("detects bounded OTLP partial success without retrying or exposing its message", async () => {
    const collectorSecret = "collector-partial-secret";
    const sink = new OtlpHttpTelemetrySink({
      endpoint: "https://collector.example.test",
      fetch: async () => new Response(JSON.stringify({
        partialSuccess: {
          rejectedDataPoints: "1",
          errorMessage: collectorSecret,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    sink.emit({
      kind: "metric",
      name: "model.tokens.total",
      at: "2026-09-19T00:00:00.000Z",
      run_id: "run:test",
      attributes: {},
      value: 1,
      unit: "tokens",
    });
    let failure: unknown;
    try {
      await sink.flush();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "export_failed" });
    expect(String(failure)).not.toContain(collectorSecret);
    expect(sink.pendingEvents).toBe(0);
  });

  it("coalesces equal metric identities into one OTLP Metric with multiple points", async () => {
    const requests: RequestInit[] = [];
    const sink = new OtlpHttpTelemetrySink({
      endpoint: "https://collector.example.test",
      fetch: async (_input, init = {}) => {
        requests.push(init);
        return new Response(null, { status: 200 });
      },
    });
    for (const [at, value] of [
      ["2026-09-19T00:00:00.000Z", 10],
      ["2026-09-19T00:00:01.000Z", 20],
    ] as const) {
      sink.emit({
        kind: "metric",
        name: "model.tokens.total",
        at,
        run_id: "run:test",
        attributes: { model: "test" },
        value,
        unit: "tokens",
      });
    }
    await sink.flush();

    const body = JSON.parse(String(requests[0]?.body)) as {
      resourceMetrics: Array<{
        scopeMetrics: Array<{
          metrics: Array<{ gauge: { dataPoints: Array<{ asDouble: number }> } }>;
        }>;
      }>;
    };
    const metrics = body.resourceMetrics[0]?.scopeMetrics[0]?.metrics;
    expect(metrics).toHaveLength(1);
    expect(metrics?.[0]?.gauge.dataPoints.map((point) => point.asDouble)).toEqual([10, 20]);
  });

  it("serializes a fetch adapter that synchronously re-enters OTLP flush", async () => {
    let sink!: OtlpHttpTelemetrySink;
    let nestedFlush: Promise<void> | undefined;
    let calls = 0;
    let active = 0;
    let peak = 0;
    sink = new OtlpHttpTelemetrySink({
      endpoint: "https://collector.example.test",
      fetch: async () => {
        calls += 1;
        active += 1;
        peak = Math.max(peak, active);
        if (calls === 1) {
          sink.emit(logEvent("reentrant-second", {}));
          nestedFlush = sink.flush();
        }
        await Promise.resolve();
        active -= 1;
        return new Response(null, { status: 200 });
      },
      batchSize: 1,
    });
    sink.emit(logEvent("reentrant-first", {}));

    await sink.flush();
    await nestedFlush;

    expect(calls).toBe(2);
    expect(peak).toBe(1);
    expect(sink.pendingEvents).toBe(0);
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for test condition");
}

function logEvent(
  name: string,
  attributes: Record<string, string>,
  body?: string,
): TelemetryEvent {
  return {
    kind: "log",
    name,
    at: "2026-09-19T00:00:00.000Z",
    run_id: "run:test",
    attributes,
    severity: "info",
    ...(body === undefined ? {} : { body }),
  };
}
