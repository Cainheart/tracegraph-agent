import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { EVAL_METRICS_DIR } from "./paths.js";

export const PERFORMANCE_METRIC_NAMES = [
  "context.built.input_tokens",
  "run.model_calls",
  "tool.call.p95_ms",
  "sse.first_byte_ms",
] as const;

export type PerformanceMetricName = (typeof PERFORMANCE_METRIC_NAMES)[number];

export const RETRIEVAL_QUALITY_METRIC_NAMES = [
  "retrieval.task_success_rate.without",
  "retrieval.task_success_rate.with",
  "retrieval.citation_accuracy.without",
  "retrieval.citation_accuracy.with",
] as const;

export type RetrievalQualityMetricName = (typeof RETRIEVAL_QUALITY_METRIC_NAMES)[number];

const EVAL_METRIC_NAMES = [
  ...PERFORMANCE_METRIC_NAMES,
  ...RETRIEVAL_QUALITY_METRIC_NAMES,
] as const;

export type EvalMetricName = (typeof EVAL_METRIC_NAMES)[number];

export interface EvalMetricObservation {
  readonly name: EvalMetricName;
  readonly value: number;
  readonly unit: "tokens" | "calls" | "ms" | "ratio";
  readonly scenario: string;
}

export interface PerformanceBaselineMetric extends EvalMetricObservation {
  readonly max: number;
  readonly rationale: string;
}

export interface PerformanceBaseline {
  readonly schema_version: "tracegraph.eval-performance-baseline.v1";
  readonly scenario: "offline-representative-run.v1";
  readonly metrics: Record<PerformanceMetricName, PerformanceBaselineMetric>;
}

const MAX_METRIC_FILE_BYTES = 16 * 1024;

export async function recordEvalMetric(observation: EvalMetricObservation): Promise<void> {
  validateObservation(observation);
  await mkdir(EVAL_METRICS_DIR, { recursive: true });
  const filename = `${observation.name.replaceAll(".", "_")}.json`;
  const target = join(EVAL_METRICS_DIR, filename);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const content = `${JSON.stringify(observation, null, 2)}\n`;
  if (Buffer.byteLength(content, "utf8") > MAX_METRIC_FILE_BYTES) {
    throw new Error("Eval metric observation exceeded its bounded report envelope");
  }
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  await rename(temporary, target);
}

export async function readPerformanceBaseline(path: string): Promise<PerformanceBaseline> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_METRIC_FILE_BYTES) {
    throw new Error("Performance baseline must be a bounded regular file");
  }
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  return parsePerformanceBaseline(parsed);
}

export async function writePerformanceBaseline(
  path: string,
  observations: Readonly<Record<PerformanceMetricName, EvalMetricObservation>>,
  previous?: PerformanceBaseline,
): Promise<PerformanceBaseline> {
  if (process.env.TRACEGRAPH_EVAL_UPDATE !== "1") {
    throw new Error("Baseline writes require explicit eval update mode");
  }
  const baseline = createUpdatedBaseline(observations, previous);
  await mkdir(dirname(path), { recursive: true });
  const target = join(dirname(path), basename(path));
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(baseline, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  await rename(temporary, target);
  return baseline;
}

export function assertMetricsWithinBaseline(
  observations: Readonly<Record<PerformanceMetricName, EvalMetricObservation>>,
  baseline: PerformanceBaseline,
): void {
  for (const name of PERFORMANCE_METRIC_NAMES) {
    const observation = observations[name];
    const expected = baseline.metrics[name];
    validateObservation(observation);
    if (observation.unit !== expected.unit || observation.scenario !== expected.scenario) {
      throw new Error(`Performance metric identity drifted for ${name}`);
    }
    if (observation.value > expected.max) {
      throw new Error(
        `Performance gate failed for ${name}: ${observation.value} ${observation.unit} exceeds ${expected.max}`,
      );
    }
  }
}

export function percentile(samples: readonly number[], quantile: number): number {
  if (samples.length === 0) throw new RangeError("Percentile requires at least one sample");
  if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) {
    throw new RangeError("Percentile quantile must be between zero and one");
  }
  const sorted = samples.map((sample) => {
    if (!Number.isFinite(sample) || sample < 0) throw new RangeError("Metric samples must be finite and nonnegative");
    return sample;
  }).sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)]!;
}

function createUpdatedBaseline(
  observations: Readonly<Record<PerformanceMetricName, EvalMetricObservation>>,
  previous?: PerformanceBaseline,
): PerformanceBaseline {
  const metrics = {} as Record<PerformanceMetricName, PerformanceBaselineMetric>;
  for (const name of PERFORMANCE_METRIC_NAMES) {
    const observation = observations[name];
    validateObservation(observation);
    const latency = observation.unit === "ms";
    metrics[name] = {
      ...observation,
      max: latency
        ? Math.max(name === "sse.first_byte_ms" ? 1_500 : 500, Math.ceil(observation.value * 5))
        : observation.value,
      rationale: previous?.metrics[name].rationale ?? defaultRationale(name),
    };
  }
  return {
    schema_version: "tracegraph.eval-performance-baseline.v1",
    scenario: "offline-representative-run.v1",
    metrics,
  };
}

function parsePerformanceBaseline(value: unknown): PerformanceBaseline {
  if (!isRecord(value)
    || value.schema_version !== "tracegraph.eval-performance-baseline.v1"
    || value.scenario !== "offline-representative-run.v1"
    || !isRecord(value.metrics)
    || Object.keys(value.metrics).sort().join("\n") !== [...PERFORMANCE_METRIC_NAMES].sort().join("\n")) {
    throw new Error("Performance baseline has an invalid envelope");
  }
  const metrics = {} as Record<PerformanceMetricName, PerformanceBaselineMetric>;
  for (const name of PERFORMANCE_METRIC_NAMES) {
    const candidate = value.metrics[name];
    if (!isRecord(candidate)) throw new Error(`Performance baseline is missing ${name}`);
    const observation = {
      name: candidate.name,
      value: candidate.value,
      unit: candidate.unit,
      scenario: candidate.scenario,
    } as EvalMetricObservation;
    validateObservation(observation);
    if (observation.name !== name
      || typeof candidate.max !== "number"
      || !Number.isFinite(candidate.max)
      || candidate.max < 0
      || typeof candidate.rationale !== "string"
      || candidate.rationale.length < 1
      || candidate.rationale.length > 1_000) {
      throw new Error(`Performance baseline metric is invalid for ${name}`);
    }
    metrics[name] = { ...observation, max: candidate.max, rationale: candidate.rationale };
  }
  return {
    schema_version: "tracegraph.eval-performance-baseline.v1",
    scenario: "offline-representative-run.v1",
    metrics,
  };
}

function validateObservation(value: EvalMetricObservation): void {
  if (!EVAL_METRIC_NAMES.includes(value.name)
    || typeof value.value !== "number"
    || !Number.isFinite(value.value)
    || value.value < 0
    || !["tokens", "calls", "ms", "ratio"].includes(value.unit)
    || typeof value.scenario !== "string"
    || value.scenario.length < 1
    || value.scenario.length > 160) {
    throw new Error("Eval metric observation is invalid");
  }
}

function defaultRationale(name: PerformanceMetricName): string {
  if (name === "context.built.input_tokens") return "Exact deterministic compacted Context size; increases require review.";
  if (name === "run.model_calls") return "Direct-answer representative Run must remain one model call.";
  if (name === "tool.call.p95_ms") return "Local bounded read_file P95 with wide CI scheduling headroom.";
  return "Loopback Host SSE first-byte latency with wide CI startup and scheduling headroom.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
