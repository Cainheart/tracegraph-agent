import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { TelemetryError } from "./errors.js";
import type { TelemetrySink } from "./sink.js";
import { MemoryTelemetrySink } from "./sinks/memory.js";
import { NoopTelemetrySink } from "./sinks/noop.js";
import {
  OtlpHttpTelemetrySink,
  type TelemetryFetch,
} from "./sinks/otlp.js";
import type { TelemetryAttributes } from "./types.js";
import { parseTelemetryEvent } from "./validation.js";

export const MAX_TELEMETRY_CONFIG_BYTES = 65_536;
export const DEFAULT_OTLP_ENDPOINT_ENV = "OTEL_EXPORTER_OTLP_ENDPOINT";

export interface NoopTelemetryConfig {
  readonly sink: "noop";
}

export interface MemoryTelemetryConfig {
  readonly sink: "memory";
  readonly max_events?: number;
}

export interface OtlpHttpTelemetryConfig {
  readonly sink: "otlp_http";
  readonly endpoint_env?: string;
  readonly authorization_ref?: `\${secret:${string}}`;
  readonly max_queue_size?: number;
  readonly batch_size?: number;
  readonly timeout_ms?: number;
  readonly resource_attributes?: TelemetryAttributes;
}

export type TelemetryConfig = NoopTelemetryConfig | MemoryTelemetryConfig | OtlpHttpTelemetryConfig;

export const DEFAULT_TELEMETRY_CONFIG: NoopTelemetryConfig = Object.freeze({ sink: "noop" });

export interface CreateTelemetrySinkOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly resolveSecret?: (name: string) => string | undefined | Promise<string | undefined>;
  readonly resolvedOtlp?: {
    readonly endpoint: string;
    readonly authorization?: string;
  };
  readonly fetch?: TelemetryFetch;
}

export function parseTelemetryConfig(input: unknown): TelemetryConfig {
  if (input === undefined || input === null) return DEFAULT_TELEMETRY_CONFIG;
  if (!isPlainRecord(input) || typeof input.sink !== "string") throw invalidConfig();
  if (input.sink === "noop") {
    assertOnlyKeys(input, new Set(["sink"]));
    return DEFAULT_TELEMETRY_CONFIG;
  }
  if (input.sink === "memory") {
    assertOnlyKeys(input, new Set(["sink", "max_events"]));
    const maxEvents = optionalInteger(input.max_events, 1, 10_000);
    return Object.freeze({
      sink: "memory",
      ...(maxEvents === undefined ? {} : { max_events: maxEvents }),
    });
  }
  if (input.sink !== "otlp_http") throw invalidConfig();
  assertOnlyKeys(input, new Set([
    "sink",
    "endpoint_env",
    "authorization_ref",
    "max_queue_size",
    "batch_size",
    "timeout_ms",
    "resource_attributes",
  ]));
  const endpointEnv = optionalEnvName(input.endpoint_env);
  const authorizationRef = optionalSecretReference(input.authorization_ref);
  const maxQueueSize = optionalInteger(input.max_queue_size, 1, 10_000);
  const batchSize = optionalInteger(input.batch_size, 1, 256);
  if (batchSize !== undefined && maxQueueSize !== undefined && batchSize > maxQueueSize) throw invalidConfig();
  const timeoutMs = optionalInteger(input.timeout_ms, 100, 60_000);
  const resourceAttributes = input.resource_attributes === undefined
    ? undefined
    : normalizeResourceAttributes(input.resource_attributes);
  return Object.freeze({
    sink: "otlp_http",
    ...(endpointEnv === undefined ? {} : { endpoint_env: endpointEnv }),
    ...(authorizationRef === undefined ? {} : { authorization_ref: authorizationRef }),
    ...(maxQueueSize === undefined ? {} : { max_queue_size: maxQueueSize }),
    ...(batchSize === undefined ? {} : { batch_size: batchSize }),
    ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
    ...(resourceAttributes === undefined ? {} : { resource_attributes: resourceAttributes }),
  });
}

export async function loadTelemetryConfig(filePath?: string): Promise<TelemetryConfig> {
  if (filePath === undefined) return DEFAULT_TELEMETRY_CONFIG;
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return DEFAULT_TELEMETRY_CONFIG;
    throw new TelemetryError("invalid_config", "Telemetry configuration could not be loaded");
  }
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || !Number.isSafeInteger(metadata.size)
    || metadata.size < 0
    || metadata.size > MAX_TELEMETRY_CONFIG_BYTES
  ) throw invalidConfig();
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    throw new TelemetryError("invalid_config", "Telemetry configuration could not be loaded");
  }
  let content: string;
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.dev !== metadata.dev
      || opened.ino !== metadata.ino
      || opened.size > MAX_TELEMETRY_CONFIG_BYTES
    ) throw invalidConfig();
    content = await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (Buffer.byteLength(content, "utf8") > MAX_TELEMETRY_CONFIG_BYTES) throw invalidConfig();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw invalidConfig();
  }
  return parseTelemetryConfig(parsed);
}

export async function createTelemetrySink(
  input: TelemetryConfig | unknown = DEFAULT_TELEMETRY_CONFIG,
  options: CreateTelemetrySinkOptions = {},
): Promise<TelemetrySink> {
  const config = parseTelemetryConfig(input);
  if (config.sink === "noop") return new NoopTelemetrySink();
  if (config.sink === "memory") {
    return new MemoryTelemetrySink({
      ...(config.max_events === undefined ? {} : { maxEvents: config.max_events }),
    });
  }
  const env = options.env ?? process.env;
  const endpoint = options.resolvedOtlp?.endpoint
    ?? env[config.endpoint_env ?? DEFAULT_OTLP_ENDPOINT_ENV];
  if (endpoint === undefined) throw invalidConfig();
  let authorization = options.resolvedOtlp?.authorization;
  if (authorization === undefined && config.authorization_ref !== undefined) {
    const secretName = config.authorization_ref.slice("${secret:".length, -1);
    try {
      authorization = await options.resolveSecret?.(secretName);
    } catch {
      throw invalidConfig();
    }
    if (authorization === undefined) throw invalidConfig();
  }
  return new OtlpHttpTelemetrySink({
    endpoint,
    ...(authorization === undefined ? {} : { headers: { authorization } }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(config.max_queue_size === undefined ? {} : { maxQueueSize: config.max_queue_size }),
    ...(config.batch_size === undefined ? {} : { batchSize: config.batch_size }),
    ...(config.timeout_ms === undefined ? {} : { timeoutMs: config.timeout_ms }),
    ...(config.resource_attributes === undefined ? {} : { resourceAttributes: config.resource_attributes }),
  });
}

function normalizeResourceAttributes(input: unknown): TelemetryAttributes {
  return parseTelemetryEvent({
    kind: "metric",
    name: "telemetry.config.validation",
    at: "2000-01-01T00:00:00.000Z",
    run_id: "telemetry",
    attributes: input,
    value: 0,
  }).attributes;
}

function optionalEnvName(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "string" || !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(input)) throw invalidConfig();
  return input;
}

function optionalSecretReference(input: unknown): `\${secret:${string}}` | undefined {
  if (input === undefined) return undefined;
  // Keep this grammar identical to the G-19 CredentialName/SecretReference
  // boundary without coupling the vendor-neutral package to Core.
  if (typeof input !== "string" || !/^\$\{secret:[A-Z][A-Z0-9_]{0,127}\}$/u.test(input)) {
    throw invalidConfig();
  }
  return input as `\${secret:${string}}`;
}

function optionalInteger(input: unknown, minimum: number, maximum: number): number | undefined {
  if (input === undefined) return undefined;
  if (!Number.isInteger(input) || (input as number) < minimum || (input as number) > maximum) {
    throw invalidConfig();
  }
  return input as number;
}

function assertOnlyKeys(input: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw invalidConfig();
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function invalidConfig(): TelemetryError {
  return new TelemetryError("invalid_config", "Telemetry configuration is invalid");
}
