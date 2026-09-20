import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import type { Reporter, TestModule, TestRunEndReason } from "vitest/node";
import type { EvalMetricObservation } from "./metrics.js";
import { EVAL_METRICS_DIR, EVAL_REPORT_PATH, REPOSITORY_ROOT } from "./paths.js";

const MAX_REPORTED_TESTS = 512;
const MAX_REPORTED_METRICS = 64;
const MAX_METRIC_FILE_BYTES = 16 * 1024;
const MAX_REPORT_BYTES = 256 * 1024;

export class BoundedEvalReporter implements Reporter {
  async onTestRunEnd(
    modules: ReadonlyArray<TestModule>,
    unhandledErrors: ReadonlyArray<unknown>,
    reason: TestRunEndReason,
  ): Promise<void> {
    const allTests = modules.flatMap((module) => [...module.children.allTests()].map((test) => ({
      file: bounded(relative(REPOSITORY_ROOT, module.moduleId), 300),
      name: bounded(test.fullName, 500),
      status: test.result().state,
      duration_ms: Math.max(0, Math.round(test.diagnostic()?.duration ?? 0)),
    })));
    const tests = allTests.slice(0, MAX_REPORTED_TESTS);
    const metrics = await readMetricObservations();
    const counts = { passed: 0, failed: 0, skipped: 0, pending: 0 };
    for (const test of allTests) counts[test.status] += 1;
    const report = {
      schema_version: "tracegraph.eval-report.v1",
      generated_at: new Date().toISOString(),
      mode: process.env.TRACEGRAPH_EVAL_UPDATE === "1" ? "baseline_update" : "verify",
      result: reason,
      summary: {
        total: allTests.length,
        ...counts,
        unhandled_error_count: Math.min(unhandledErrors.length, Number.MAX_SAFE_INTEGER),
      },
      tests,
      truncated_test_count: Math.max(0, allTests.length - tests.length),
      metrics,
    };
    const content = `${JSON.stringify(report, null, 2)}\n`;
    if (Buffer.byteLength(content, "utf8") > MAX_REPORT_BYTES) {
      throw new Error("Bounded eval report exceeded its maximum size");
    }
    await mkdir(dirname(EVAL_REPORT_PATH), { recursive: true });
    const temporary = `${EVAL_REPORT_PATH}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, EVAL_REPORT_PATH);
  }
}

async function readMetricObservations(): Promise<EvalMetricObservation[]> {
  let names: string[];
  try {
    names = (await readdir(EVAL_METRICS_DIR)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const metrics: EvalMetricObservation[] = [];
  for (const name of names.slice(0, MAX_REPORTED_METRICS)) {
    const path = `${EVAL_METRICS_DIR}/${name}`;
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > MAX_METRIC_FILE_BYTES) continue;
    const parsed = JSON.parse(await readFile(path, "utf8")) as EvalMetricObservation;
    metrics.push({
      name: parsed.name,
      value: parsed.value,
      unit: parsed.unit,
      scenario: bounded(parsed.scenario, 160),
    });
  }
  return metrics;
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
