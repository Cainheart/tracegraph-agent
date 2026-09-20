import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalRetrieval } from "../../packages/retrieval/dist/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RETRIEVAL_QUALITY_METRIC_NAMES,
  recordEvalMetric,
  type EvalMetricObservation,
  type RetrievalQualityMetricName,
} from "../support/metrics.js";

const PROJECT_ID = "project:g21-quality";

interface RetrievalTask {
  readonly query: string;
  readonly expectedCommand: string;
  readonly sourcePath: string;
  readonly commandLine: number;
  readonly document: string;
}

interface RetrievalQuality {
  readonly taskSuccessRate: number;
  readonly citationAccuracy: number;
}

const TASKS: readonly RetrievalTask[] = [
  {
    query: "CLI end to end verification command",
    expectedCommand: "pnpm --filter @tracegraph/cli test:e2e",
    sourcePath: "docs/cli-verification.md",
    commandLine: 4,
    document: [
      "# CLI verification",
      "",
      "Run the canonical CLI end to end verification command:",
      "pnpm --filter @tracegraph/cli test:e2e",
      "",
    ].join("\n"),
  },
  {
    query: "release artifact consistency validation command",
    expectedCommand: "pnpm release:check",
    sourcePath: "docs/release-verification.md",
    commandLine: 4,
    document: [
      "# Release artifact consistency",
      "",
      "Validate the bounded private release artifact with:",
      "pnpm release:check",
      "",
    ].join("\n"),
  },
  {
    query: "production source coverage gate command",
    expectedCommand: "pnpm coverage",
    sourcePath: "docs/coverage-verification.md",
    commandLine: 4,
    document: [
      "# Production source coverage gate",
      "",
      "Run the production source coverage gate with:",
      "pnpm coverage",
      "",
    ].join("\n"),
  },
] as const;

let root = "";
let observations: Readonly<Record<RetrievalQualityMetricName, EvalMetricObservation>>;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "tracegraph-g21-quality-"));
  const retrieval = createLocalRetrieval({ dataDir: root });
  for (const task of TASKS) {
    await retrieval.ingest({
      project_id: PROJECT_ID,
      source_path: task.sourcePath,
      content: task.document,
    });
  }

  const withoutRetrieval = scoreWithoutRetrieval(TASKS);
  const withRetrieval = await scoreWithRetrieval(retrieval, TASKS);
  observations = {
    "retrieval.task_success_rate.without": metric(
      "retrieval.task_success_rate.without",
      withoutRetrieval.taskSuccessRate,
    ),
    "retrieval.task_success_rate.with": metric(
      "retrieval.task_success_rate.with",
      withRetrieval.taskSuccessRate,
    ),
    "retrieval.citation_accuracy.without": metric(
      "retrieval.citation_accuracy.without",
      withoutRetrieval.citationAccuracy,
    ),
    "retrieval.citation_accuracy.with": metric(
      "retrieval.citation_accuracy.with",
      withRetrieval.citationAccuracy,
    ),
  };
  await Promise.all(RETRIEVAL_QUALITY_METRIC_NAMES.map((name) => recordEvalMetric(observations[name])));
});

afterAll(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
});

describe("G21 production retrieval quality", () => {
  it("reports task success and citation accuracy with and without retrieval", () => {
    expect(observations["retrieval.task_success_rate.without"].value).toBe(0);
    expect(observations["retrieval.citation_accuracy.without"].value).toBe(0);
    expect(observations["retrieval.task_success_rate.with"].value).toBe(1);
    expect(observations["retrieval.citation_accuracy.with"].value).toBe(1);
  });

  it("fails the quality comparison if retrieval does not improve both dimensions", () => {
    const withoutTask = observations["retrieval.task_success_rate.without"].value;
    const withTask = observations["retrieval.task_success_rate.with"].value;
    const withoutCitation = observations["retrieval.citation_accuracy.without"].value;
    const withCitation = observations["retrieval.citation_accuracy.with"].value;
    expect(withTask).toBeGreaterThan(withoutTask);
    expect(withCitation).toBeGreaterThan(withoutCitation);
  });
});

function scoreWithoutRetrieval(tasks: readonly RetrievalTask[]): RetrievalQuality {
  // Same deterministic task, but only a generic fallback is available. It
  // cannot know this repository's command or cite a source line.
  const fallbackCommand = "npm test";
  return {
    taskSuccessRate: rate(tasks.map((task) => fallbackCommand === task.expectedCommand)),
    citationAccuracy: 0,
  };
}

async function scoreWithRetrieval(
  retrieval: ReturnType<typeof createLocalRetrieval>,
  tasks: readonly RetrievalTask[],
): Promise<RetrievalQuality> {
  const taskOutcomes: boolean[] = [];
  const citationOutcomes: boolean[] = [];
  for (const task of tasks) {
    const response = await retrieval.search({
      project_id: PROJECT_ID,
      query: task.query,
      top_k: 1,
    });
    const hit = response.hits[0];
    taskOutcomes.push(hit?.content.includes(task.expectedCommand) === true);
    if (hit === undefined) {
      citationOutcomes.push(false);
      continue;
    }
    const source = await retrieval.readChunk({
      project_id: PROJECT_ID,
      chunk_id: hit.chunk_id,
    });
    citationOutcomes.push(
      source !== undefined
      && source.content === hit.content
      && hit.source_path === task.sourcePath
      && hit.start_line <= task.commandLine
      && hit.end_line >= task.commandLine,
    );
  }
  return {
    taskSuccessRate: rate(taskOutcomes),
    citationAccuracy: rate(citationOutcomes),
  };
}

function rate(outcomes: readonly boolean[]): number {
  return outcomes.filter(Boolean).length / outcomes.length;
}

function metric(name: RetrievalQualityMetricName, value: number): EvalMetricObservation {
  return {
    name,
    value,
    unit: "ratio",
    scenario: "g21-local-jsonl-bm25-production-chain.v1",
  };
}
