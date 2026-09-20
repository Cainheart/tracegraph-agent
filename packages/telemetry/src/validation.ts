import { TelemetryError } from "./errors.js";
import {
  MAX_TELEMETRY_ATTRIBUTES,
  MAX_TELEMETRY_ATTRIBUTE_KEY_CHARS,
  MAX_TELEMETRY_ATTRIBUTE_STRING_CHARS,
  MAX_TELEMETRY_LOG_BODY_CHARS,
  MAX_TELEMETRY_NAME_CHARS,
  MAX_TELEMETRY_RUN_ID_CHARS,
  MAX_TELEMETRY_SPAN_DURATION_MS,
  MAX_TELEMETRY_UNIT_CHARS,
  type LogTelemetryEvent,
  type MetricTelemetryEvent,
  type SpanTelemetryEvent,
  type TelemetryAttributes,
  type TelemetryEvent,
} from "./types.js";

const COMMON_KEYS = new Set(["kind", "name", "at", "run_id", "attributes"]);
const SPAN_KEYS = new Set([...COMMON_KEYS, "duration_ms", "status"]);
const METRIC_KEYS = new Set([...COMMON_KEYS, "value", "unit"]);
const LOG_KEYS = new Set([...COMMON_KEYS, "severity", "body"]);
const OTLP_UINT64_MAX = (1n << 64n) - 1n;
const NANOS_PER_MILLISECOND = 1_000_000n;
// Match credential-bearing key *segments* without erasing legitimate counters
// such as input_tokens/output_tokens or descriptive keys such as tokenizer.
const SENSITIVE_ATTRIBUTE_KEY = /(?:^|[._-])(?:authorization|api[-_]?key|token|secret|password|passwd|cookie|credential)(?:$|[._-])/iu;
const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/gu,
  /\bAKIA[A-Z0-9]{16}\b/gu,
  /\b(?:token|secret|password|api[-_]?key)\s*[=:]\s*[^\s,;]+/giu,
] as const;

export function parseTelemetryEvent(input: unknown): TelemetryEvent {
  if (!isPlainRecord(input)) throw invalidEvent();
  const kind = input.kind;
  if (kind !== "span" && kind !== "metric" && kind !== "log") throw invalidEvent();
  assertOnlyKeys(input, kind === "span" ? SPAN_KEYS : kind === "metric" ? METRIC_KEYS : LOG_KEYS);

  const common = {
    name: boundedString(input.name, MAX_TELEMETRY_NAME_CHARS),
    at: timestamp(input.at),
    run_id: boundedString(input.run_id, MAX_TELEMETRY_RUN_ID_CHARS),
    attributes: attributes(input.attributes),
  };
  if (kind === "span") {
    const duration = finiteNumber(input.duration_ms);
    if (duration < 0 || duration > MAX_TELEMETRY_SPAN_DURATION_MS) throw invalidEvent();
    const startNanos = BigInt(Date.parse(common.at)) * NANOS_PER_MILLISECOND;
    const durationNanos = BigInt(Math.round(duration * Number(NANOS_PER_MILLISECOND)));
    if (startNanos + durationNanos > OTLP_UINT64_MAX) throw invalidEvent();
    const status = input.status;
    if (status !== undefined && status !== "unset" && status !== "ok" && status !== "error") {
      throw invalidEvent();
    }
    return Object.freeze({
      kind,
      ...common,
      duration_ms: duration,
      ...(status === undefined ? {} : { status }),
    } satisfies SpanTelemetryEvent);
  }
  if (kind === "metric") {
    const value = finiteNumber(input.value);
    const unit = input.unit;
    if (
      unit !== undefined
      && (typeof unit !== "string" || unit.length < 1 || unit.length > MAX_TELEMETRY_UNIT_CHARS)
    ) {
      throw invalidEvent();
    }
    return Object.freeze({
      kind,
      ...common,
      value,
      ...(unit === undefined ? {} : { unit: redactTelemetryText(unit).slice(0, MAX_TELEMETRY_UNIT_CHARS) }),
    } satisfies MetricTelemetryEvent);
  }
  const severity = input.severity;
  if (severity !== "debug" && severity !== "info" && severity !== "warn" && severity !== "error") {
    throw invalidEvent();
  }
  const body = input.body;
  if (body !== undefined && (typeof body !== "string" || body.length > MAX_TELEMETRY_LOG_BODY_CHARS)) {
    throw invalidEvent();
  }
  return Object.freeze({
    kind,
    ...common,
    severity,
    ...(body === undefined ? {} : { body: redactTelemetryText(body).slice(0, MAX_TELEMETRY_LOG_BODY_CHARS) }),
  } satisfies LogTelemetryEvent);
}

export function redactTelemetryText(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_VALUE_PATTERNS) redacted = redacted.replace(pattern, "[REDACTED]");
  return redacted;
}

function attributes(input: unknown): TelemetryAttributes {
  if (!isPlainRecord(input)) throw invalidEvent();
  const entries = Object.entries(input);
  if (entries.length > MAX_TELEMETRY_ATTRIBUTES) throw invalidEvent();
  const normalized: Record<string, string | number | boolean> = Object.create(null) as Record<
    string,
    string | number | boolean
  >;
  for (const [key, rawValue] of entries) {
    if (key.length < 1 || key.length > MAX_TELEMETRY_ATTRIBUTE_KEY_CHARS) throw invalidEvent();
    if (SENSITIVE_ATTRIBUTE_KEY.test(key)) {
      normalized[key] = "[REDACTED]";
      continue;
    }
    if (typeof rawValue === "string") {
      if (rawValue.length > MAX_TELEMETRY_ATTRIBUTE_STRING_CHARS) throw invalidEvent();
      normalized[key] = redactTelemetryText(rawValue).slice(0, MAX_TELEMETRY_ATTRIBUTE_STRING_CHARS);
      continue;
    }
    if (typeof rawValue === "number") {
      if (!Number.isFinite(rawValue)) throw invalidEvent();
      normalized[key] = rawValue;
      continue;
    }
    if (typeof rawValue === "boolean") {
      normalized[key] = rawValue;
      continue;
    }
    throw invalidEvent();
  }
  return Object.freeze(normalized);
}

function timestamp(input: unknown): string {
  if (typeof input !== "string" || input.length < 20 || input.length > 40) throw invalidEvent();
  const parsed = Date.parse(input);
  if (
    !Number.isFinite(parsed)
    || parsed < 0
    || BigInt(parsed) * NANOS_PER_MILLISECOND > OTLP_UINT64_MAX
  ) throw invalidEvent();
  return new Date(parsed).toISOString();
}

function boundedString(input: unknown, max: number): string {
  if (typeof input !== "string" || input.length < 1 || input.length > max) throw invalidEvent();
  return redactTelemetryText(input).slice(0, max);
}

function finiteNumber(input: unknown): number {
  if (typeof input !== "number" || !Number.isFinite(input)) throw invalidEvent();
  return input;
}

function assertOnlyKeys(input: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw invalidEvent();
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function invalidEvent(): TelemetryError {
  return new TelemetryError("invalid_event", "Telemetry event is invalid");
}
