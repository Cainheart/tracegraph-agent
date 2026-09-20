import { randomBytes } from "node:crypto";
import { TelemetryError } from "../errors.js";
import type { TelemetrySink } from "../sink.js";
import type { TelemetryAttributes, TelemetryEvent } from "../types.js";
import { parseTelemetryEvent } from "../validation.js";

export const DEFAULT_OTLP_MAX_QUEUE_SIZE = 512;
export const MAX_OTLP_QUEUE_SIZE = 10_000;
export const DEFAULT_OTLP_BATCH_SIZE = 64;
export const MAX_OTLP_BATCH_SIZE = 256;
export const DEFAULT_OTLP_TIMEOUT_MS = 5_000;
export const MAX_OTLP_TIMEOUT_MS = 60_000;
export const MAX_OTLP_HEADERS = 16;
export const MAX_OTLP_HEADER_NAME_CHARS = 80;
export const MAX_OTLP_HEADER_VALUE_CHARS = 2_000;
export const MAX_OTLP_RESPONSE_BYTES = 64 * 1024;

export type TelemetryFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface OtlpHttpTelemetrySinkOptions {
  readonly endpoint: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: TelemetryFetch;
  readonly maxQueueSize?: number;
  readonly batchSize?: number;
  readonly timeoutMs?: number;
  readonly resourceAttributes?: TelemetryAttributes;
}

export class OtlpHttpTelemetrySink implements TelemetrySink {
  readonly kind = "otlp_http" as const;
  readonly #endpoint: string;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #fetch: TelemetryFetch;
  readonly #maxQueueSize: number;
  readonly #batchSize: number;
  readonly #timeoutMs: number;
  readonly #resourceAttributes: TelemetryAttributes;
  readonly #queue: TelemetryEvent[] = [];
  #inFlightCount = 0;
  #flushPromise: Promise<void> | undefined;
  #pendingFlush: DeferredFlush | undefined;

  constructor(options: OtlpHttpTelemetrySinkOptions) {
    this.#endpoint = normalizeEndpoint(options.endpoint);
    this.#headers = normalizeHeaders(options.headers ?? {});
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#maxQueueSize = boundedInteger(
      options.maxQueueSize ?? DEFAULT_OTLP_MAX_QUEUE_SIZE,
      1,
      MAX_OTLP_QUEUE_SIZE,
    );
    this.#batchSize = boundedInteger(
      options.batchSize ?? Math.min(DEFAULT_OTLP_BATCH_SIZE, this.#maxQueueSize),
      1,
      Math.min(MAX_OTLP_BATCH_SIZE, this.#maxQueueSize),
    );
    this.#timeoutMs = boundedInteger(options.timeoutMs ?? DEFAULT_OTLP_TIMEOUT_MS, 100, MAX_OTLP_TIMEOUT_MS);
    this.#resourceAttributes = normalizeResourceAttributes(options.resourceAttributes ?? {});
  }

  get pendingEvents(): number {
    return this.#queue.length + this.#inFlightCount;
  }

  emit(event: TelemetryEvent): void {
    const normalized = parseTelemetryEvent(event);
    if (this.pendingEvents >= this.#maxQueueSize) {
      throw new TelemetryError("queue_full", "Telemetry export queue is full");
    }
    this.#queue.push(normalized);
  }

  flush(): Promise<void> {
    if (this.#flushPromise !== undefined) {
      // Bound concurrent flush coordination to the active drain plus one
      // shared follow-up barrier; do not build a promise chain per caller.
      this.#pendingFlush ??= createDeferredFlush();
      return this.#pendingFlush.promise;
    }
    return this.#startFlush();
  }

  #startFlush(): Promise<void> {
    // Publish the active barrier before a custom fetch implementation can
    // synchronously re-enter flush(). This keeps even adversarial adapters
    // serialized behind the one shared follow-up barrier.
    const operation = Promise.resolve().then(() => this.#drain());
    this.#flushPromise = operation;
    void operation.finally(() => {
      if (this.#flushPromise !== operation) return;
      this.#flushPromise = undefined;
      const pending = this.#pendingFlush;
      this.#pendingFlush = undefined;
      if (pending !== undefined) {
        void this.#startFlush().then(pending.resolve, pending.reject);
      }
    }).catch(() => undefined);
    return operation;
  }

  async #drain(): Promise<void> {
    while (this.#queue.length > 0) {
      const batch = this.#queue.splice(0, this.#batchSize);
      this.#inFlightCount = batch.length;
      const retry = new Set<TelemetryEvent>();
      let failed = false;
      const exportSignal = async (
        signal: "traces" | "metrics" | "logs",
        events: readonly TelemetryEvent[],
        payload: unknown,
      ): Promise<void> => {
        if (events.length === 0) return;
        try {
          await this.#post(signal, payload);
        } catch (error) {
          failed = true;
          if (error instanceof OtlpPostError && error.retryable) {
            for (const event of events) retry.add(event);
          }
        }
      };
      const spans = batch.filter((event) => event.kind === "span");
      const metrics = batch.filter((event) => event.kind === "metric");
      const logs = batch.filter((event) => event.kind === "log");
      try {
        await exportSignal("traces", spans, tracePayload(spans, this.#resourceAttributes));
        await exportSignal("metrics", metrics, metricPayload(metrics, this.#resourceAttributes));
        await exportSignal("logs", logs, logPayload(logs, this.#resourceAttributes));
      } finally {
        this.#inFlightCount = 0;
      }
      if (retry.size > 0) {
        // Preserve the original batch order while retaining only signals for
        // which the collector explicitly permits a retry.
        this.#queue.unshift(...batch.filter((event) => retry.has(event)));
      }
      if (failed) {
        throw new TelemetryError("export_failed", "Telemetry export failed");
      }
    }
  }

  async #post(signal: "traces" | "metrics" | "logs", payload: unknown): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.#endpoint}/v1/${signal}`, {
        method: "POST",
        headers: { ...this.#headers, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (response.status !== 200) {
        throw new OtlpPostError(isRetryableStatus(response.status));
      }
      // OTLP can return HTTP 200 while rejecting part of a signal. Read only a
      // bounded JSON body, inspect the numeric rejected count, and never copy
      // collector text (including errorMessage) into errors or status.
      const body = await readBoundedBody(response);
      if (hasPartialRejection(signal, body)) throw new OtlpPostError(false);
    } catch (error) {
      if (error instanceof OtlpPostError) throw error;
      throw new OtlpPostError(true);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function tracePayload(
  events: readonly Extract<TelemetryEvent, { kind: "span" }>[],
  resourceAttributes: TelemetryAttributes,
): unknown {
  return {
    resourceSpans: [{
      resource: { attributes: otlpAttributes(resourceAttributes) },
      scopeSpans: [{
        scope: { name: "tracegraph.telemetry" },
        spans: events.map((event) => {
          const start = timeUnixNano(event.at);
          const end = (BigInt(start) + BigInt(Math.round(event.duration_ms * 1_000_000))).toString();
          return {
            traceId: randomBytes(16).toString("hex"),
            spanId: randomBytes(8).toString("hex"),
            name: event.name,
            kind: 1,
            startTimeUnixNano: start,
            endTimeUnixNano: end,
            attributes: eventAttributes(event),
            status: { code: event.status === "ok" ? 1 : event.status === "error" ? 2 : 0 },
          };
        }),
      }],
    }],
  };
}

function metricPayload(
  events: readonly Extract<TelemetryEvent, { kind: "metric" }>[],
  resourceAttributes: TelemetryAttributes,
): unknown {
  const metrics: Array<{
    readonly name: string;
    readonly unit?: string;
    readonly gauge: { readonly dataPoints: Array<Record<string, unknown>> };
  }> = [];
  const groups = new Map<string, (typeof metrics)[number]>();
  for (const event of events) {
    // An OTLP metric stream is identified by its name and unit (among other
    // scope/resource fields). Keep one Metric per identity and append points;
    // duplicate Metric messages for the same identity are semantically invalid.
    const key = JSON.stringify([event.name, event.unit ?? null]);
    let metric = groups.get(key);
    if (metric === undefined) {
      metric = {
        name: event.name,
        ...(event.unit === undefined ? {} : { unit: event.unit }),
        gauge: { dataPoints: [] },
      };
      groups.set(key, metric);
      metrics.push(metric);
    }
    metric.gauge.dataPoints.push({
      attributes: eventAttributes(event),
      timeUnixNano: timeUnixNano(event.at),
      asDouble: event.value,
    });
  }
  return {
    resourceMetrics: [{
      resource: { attributes: otlpAttributes(resourceAttributes) },
      scopeMetrics: [{
        scope: { name: "tracegraph.telemetry" },
        metrics,
      }],
    }],
  };
}

function logPayload(
  events: readonly Extract<TelemetryEvent, { kind: "log" }>[],
  resourceAttributes: TelemetryAttributes,
): unknown {
  return {
    resourceLogs: [{
      resource: { attributes: otlpAttributes(resourceAttributes) },
      scopeLogs: [{
        scope: { name: "tracegraph.telemetry" },
        logRecords: events.map((event) => ({
          timeUnixNano: timeUnixNano(event.at),
          severityNumber: severityNumber(event.severity),
          severityText: event.severity.toUpperCase(),
          body: { stringValue: event.body ?? event.name },
          attributes: eventAttributes(event),
        })),
      }],
    }],
  };
}

function eventAttributes(event: TelemetryEvent): readonly unknown[] {
  return otlpAttributes({ ...event.attributes, "tracegraph.run_id": event.run_id });
}

function otlpAttributes(attributes: TelemetryAttributes): readonly unknown[] {
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value: typeof value === "string"
      ? { stringValue: value }
      : typeof value === "boolean"
        ? { boolValue: value }
        : { doubleValue: value },
  }));
}

function timeUnixNano(at: string): string {
  return (BigInt(Date.parse(at)) * 1_000_000n).toString();
}

function severityNumber(severity: "debug" | "info" | "warn" | "error"): number {
  switch (severity) {
    case "debug": return 5;
    case "info": return 9;
    case "warn": return 13;
    case "error": return 17;
  }
}

function normalizeEndpoint(input: string): string {
  if (typeof input !== "string" || input.length < 1 || input.length > 2_000) throw invalidConfig();
  let endpoint: URL;
  try {
    endpoint = new URL(input);
  } catch {
    throw invalidConfig();
  }
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:")
    || endpoint.username.length > 0
    || endpoint.password.length > 0
    || endpoint.hash.length > 0
    || endpoint.search.length > 0
  ) throw invalidConfig();
  const path = endpoint.pathname.replace(/\/+$/u, "");
  endpoint.pathname = path;
  return endpoint.toString().replace(/\/$/u, "");
}

function normalizeHeaders(input: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const entries = Object.entries(input);
  if (entries.length > MAX_OTLP_HEADERS) throw invalidConfig();
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [rawName, value] of entries) {
    const name = rawName.toLowerCase();
    if (
      name.length < 1
      || name.length > MAX_OTLP_HEADER_NAME_CHARS
      || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name)
      || name === "content-type"
      || name === "accept"
      || typeof value !== "string"
      || value.length > MAX_OTLP_HEADER_VALUE_CHARS
      || /[\r\n]/u.test(value)
    ) throw invalidConfig();
    result[name] = value;
  }
  return Object.freeze(result);
}

function normalizeResourceAttributes(input: TelemetryAttributes): TelemetryAttributes {
  return parseTelemetryEvent({
    kind: "metric",
    name: "telemetry.resource.validation",
    at: "2000-01-01T00:00:00.000Z",
    run_id: "telemetry",
    attributes: input,
    value: 0,
  }).attributes;
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw invalidConfig();
  return value;
}

function invalidConfig(): TelemetryError {
  return new TelemetryError("invalid_config", "Telemetry sink configuration is invalid");
}

class OtlpPostError extends Error {
  constructor(readonly retryable: boolean) {
    super("Telemetry export failed");
    this.name = "OtlpPostError";
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

async function readBoundedBody(response: Response): Promise<string> {
  if (response.body === null) return "";
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null
    && /^\d+$/u.test(declaredLength)
    && Number(declaredLength) > MAX_OTLP_RESPONSE_BYTES
  ) throw new OtlpPostError(false);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_OTLP_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new OtlpPostError(false);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (bytes === 0) return "";
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(joined);
  } catch {
    throw new OtlpPostError(false);
  }
}

function hasPartialRejection(signal: "traces" | "metrics" | "logs", body: string): boolean {
  if (body.trim().length === 0) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new OtlpPostError(false);
  }
  if (!isPlainRecord(parsed)) throw new OtlpPostError(false);
  const partial = parsed.partialSuccess;
  if (partial === undefined) return false;
  if (!isPlainRecord(partial)) throw new OtlpPostError(false);
  const field = signal === "traces"
    ? "rejectedSpans"
    : signal === "metrics"
      ? "rejectedDataPoints"
      : "rejectedLogRecords";
  const value = partial[field] ?? "0";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new OtlpPostError(false);
    return value > 0;
  }
  if (typeof value !== "string" || !/^\d{1,20}$/u.test(value)) throw new OtlpPostError(false);
  return BigInt(value) > 0n;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

interface DeferredFlush {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

function createDeferredFlush(): DeferredFlush {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
