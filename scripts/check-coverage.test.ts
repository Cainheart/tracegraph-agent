import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateCoverageSummary } from "./check-coverage.mjs";

const SCRIPT_PATH = resolve(import.meta.dirname, "check-coverage.mjs");
const tempDirectories: string[] = [];

const expectedSources = [
  "apps/cli/src/index.ts",
  "packages/contracts/src/action.ts",
  "packages/core/src/context.ts",
  "packages/core/src/policy-engine.ts",
];

type LineCounts = { readonly total: number; readonly covered: number };

function coverageEntry({ total, covered }: LineCounts) {
  const percent = total === 0 ? 100 : Math.round((covered / total) * 10_000) / 100;
  return {
    lines: { total, covered, skipped: 0, pct: percent },
    statements: { total, covered, skipped: 0, pct: percent },
    functions: { total, covered, skipped: 0, pct: percent },
    branches: { total, covered, skipped: 0, pct: percent },
  };
}

function createSummary(overrides: Partial<Record<(typeof expectedSources)[number], LineCounts>> = {}) {
  const counts: Record<(typeof expectedSources)[number], LineCounts> = {
    "apps/cli/src/index.ts": { total: 100, covered: 100 },
    "packages/contracts/src/action.ts": { total: 100, covered: 90 },
    "packages/core/src/context.ts": { total: 100, covered: 90 },
    "packages/core/src/policy-engine.ts": { total: 100, covered: 90 },
    ...overrides,
  };
  const total = Object.values(counts).reduce(
    (sum, value) => ({ total: sum.total + value.total, covered: sum.covered + value.covered }),
    { total: 0, covered: 0 },
  );
  return Object.fromEntries([
    ["total", coverageEntry(total)],
    ...expectedSources.map((sourcePath) => [sourcePath, coverageEntry(counts[sourcePath])]),
  ]);
}

async function createFixture(summary: object) {
  const rootDirectory = await mkdtemp(join(tmpdir(), "tracegraph-coverage-check-"));
  tempDirectories.push(rootDirectory);
  for (const sourcePath of expectedSources) {
    const absolutePath = join(rootDirectory, sourcePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, "export const covered = true;\n", "utf8");
  }
  const summaryPath = join(rootDirectory, "coverage", "coverage-summary.json");
  await mkdir(dirname(summaryPath), { recursive: true });
  await writeFile(summaryPath, `${JSON.stringify(summary)}\n`, "utf8");
  return { rootDirectory, summaryPath };
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("coverage gate", () => {
  it("passes only when the global and every critical path threshold pass", () => {
    const result = evaluateCoverageSummary(createSummary(), {
      rootDirectory: process.cwd(),
      expectedSources,
    });

    expect(result.result).toBe("passed");
    expect(result.gates.map((gate) => [gate.id, gate.status])).toEqual([
      ["global", "passed"],
      ["packages/contracts", "passed"],
      ["packages/core/src/context.ts", "passed"],
      ["packages/core/src/policy*", "passed"],
    ]);
  });

  it.each([
    ["global", { "apps/cli/src/index.ts": { total: 1_000, covered: 0 } }],
    ["packages/contracts", { "packages/contracts/src/action.ts": { total: 100, covered: 89 } }],
    ["packages/core/src/context.ts", { "packages/core/src/context.ts": { total: 100, covered: 89 } }],
    ["packages/core/src/policy*", { "packages/core/src/policy-engine.ts": { total: 100, covered: 89 } }],
  ])("fails closed when the %s threshold regresses", (gateId, overrides) => {
    const result = evaluateCoverageSummary(createSummary(overrides), {
      rootDirectory: process.cwd(),
      expectedSources,
    });

    expect(result.result).toBe("failed");
    expect(result.gates.find((gate) => gate.id === gateId)?.status).toBe("failed");
  });

  it("does not trust a forged total or percentage field", () => {
    const summary = createSummary();
    summary.total = coverageEntry({ total: 1, covered: 1 });
    summary["packages/contracts/src/action.ts"].lines.pct = 100;
    summary["packages/contracts/src/action.ts"].lines.covered = 89;

    const result = evaluateCoverageSummary(summary, {
      rootDirectory: process.cwd(),
      expectedSources,
    });

    expect(result.result).toBe("failed");
    expect(result.errors).toContain("declared total line counts do not match the complete per-file source set");
    expect(result.gates.find((gate) => gate.id === "packages/contracts")?.status).toBe("failed");
  });

  it("fails when an expected production file is omitted from the report", () => {
    const summary = createSummary();
    delete summary["packages/core/src/context.ts"];

    const result = evaluateCoverageSummary(summary, {
      rootDirectory: process.cwd(),
      expectedSources,
    });

    expect(result.result).toBe("failed");
    expect(result.missing_sources).toEqual(["packages/core/src/context.ts"]);
  });

  it("returns a non-zero process status for an injected regression", async () => {
    const fixture = await createFixture(createSummary({
      "packages/core/src/policy-engine.ts": { total: 100, covered: 89 },
    }));

    const child = spawnSync(process.execPath, [
      SCRIPT_PATH,
      "--root",
      fixture.rootDirectory,
      "--summary",
      fixture.summaryPath,
    ], { encoding: "utf8" });

    expect(child.status).toBe(1);
    expect(JSON.parse(child.stderr)).toMatchObject({
      schema_version: "tracegraph.coverage-gate.v1",
      result: "failed",
    });
  });
});
