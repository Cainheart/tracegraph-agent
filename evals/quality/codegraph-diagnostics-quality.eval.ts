import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  analyzeCodeGraph,
  type CodeGraphAnalysis,
  type CodeGraphDiagnostic,
} from "../../packages/codegraph/src/index.js";

const REPOSITORY_ROOT = nodePath.resolve(
  nodePath.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const FIXED_TIME = "2026-09-19T02:00:00.000Z";
const temporaryDirectories: string[] = [];

interface RepairTask {
  readonly expectedFile: string;
  readonly expectedLine: number;
  readonly expectedSpecifier: string;
}

interface RepairProposal {
  readonly file: string;
  readonly line?: number;
  readonly replacementSpecifier?: string;
  readonly editCount: number;
  readonly diagnosticCode?: CodeGraphDiagnostic["code"];
}

const QUALITY_DIMENSIONS = [
  "fault_localization",
  "repair_selection",
  "minimal_edit_scope",
  "diagnostic_traceability",
] as const;

type QualityDimension = (typeof QUALITY_DIMENSIONS)[number];

interface QualityScore {
  readonly dimensions: Readonly<Record<QualityDimension, 0 | 1>>;
  readonly total: number;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
      force: true,
      recursive: true,
    })),
  );
});

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? Number.POSITIVE_INFINITY) + 1,
        (previous[rightIndex] ?? Number.POSITIVE_INFINITY) + 1,
        (previous[rightIndex - 1] ?? Number.POSITIVE_INFINITY) + substitutionCost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? Number.POSITIVE_INFINITY;
}

function proposeRepair(
  analysis: CodeGraphAnalysis,
  includeDiagnostics: boolean,
): RepairProposal {
  const diagnostic = includeDiagnostics
    ? analysis.diagnostics.find(({ code }) => code === "static_module_unresolved")
    : undefined;
  const unresolvedSpecifier = diagnostic?.message.match(/static module '([^']+)'/u)?.[1];
  if (diagnostic?.file_path === undefined || diagnostic.line === undefined
    || unresolvedSpecifier === undefined) {
    return { file: "src/index.ts", editCount: 1 };
  }

  const missingName = nodePath.posix.basename(unresolvedSpecifier);
  const diagnosticDirectory = nodePath.posix.dirname(diagnostic.file_path);
  const candidates = analysis.snapshot.nodes
    .filter((node) => node.kind === "file" && node.file_path !== undefined)
    .filter((node) => node.file_path !== diagnostic.file_path)
    .map((node) => node.file_path as string)
    .filter((filePath) => nodePath.posix.dirname(filePath) === diagnosticDirectory)
    .sort((left, right) => {
      const distance = levenshtein(
        nodePath.posix.basename(left),
        missingName,
      ) - levenshtein(nodePath.posix.basename(right), missingName);
      return distance === 0 ? left.localeCompare(right) : distance;
    });
  const selected = candidates[0];
  if (selected === undefined) {
    return {
      file: diagnostic.file_path,
      line: diagnostic.line,
      editCount: 1,
      diagnosticCode: diagnostic.code,
    };
  }

  return {
    file: diagnostic.file_path,
    line: diagnostic.line,
    replacementSpecifier: `./${nodePath.posix.basename(selected)}`,
    editCount: 1,
    diagnosticCode: diagnostic.code,
  };
}

function scoreRepair(task: RepairTask, proposal: RepairProposal): QualityScore {
  const dimensions: QualityScore["dimensions"] = {
    fault_localization: Number(
      proposal.file === task.expectedFile && proposal.line === task.expectedLine,
    ) as 0 | 1,
    repair_selection: Number(
      proposal.replacementSpecifier === task.expectedSpecifier,
    ) as 0 | 1,
    minimal_edit_scope: Number(proposal.editCount === 1) as 0 | 1,
    diagnostic_traceability: Number(
      proposal.diagnosticCode === "static_module_unresolved",
    ) as 0 | 1,
  };
  const total = QUALITY_DIMENSIONS.reduce(
    (sum, dimension) => sum + dimensions[dimension],
    0,
  ) / QUALITY_DIMENSIONS.length;
  return { dimensions, total };
}

describe("G16 quality comparison: CodeGraph diagnostics", () => {
  it("improves fault localization and repair choice on the real failing fixture", async () => {
    const workspace = await fs.mkdtemp(nodePath.join(tmpdir(), "tracegraph-g16-codegraph-"));
    temporaryDirectories.push(workspace);
    await fs.cp(
      nodePath.join(REPOSITORY_ROOT, "examples/failing-typescript-repo"),
      workspace,
      { recursive: true },
    );
    await fs.writeFile(
      nodePath.join(workspace, "src/pricing.ts"),
      "export const calculateTotal = (amount: number): number => amount;\n",
      "utf8",
    );
    await fs.writeFile(
      nodePath.join(workspace, "src/checkout.ts"),
      [
        'import { calculateTotal } from "./prcing.ts";',
        "export const checkout = (amount: number): number => calculateTotal(amount);",
        "",
      ].join("\n"),
      "utf8",
    );

    const analysis = await analyzeCodeGraph({
      workspace_root: workspace,
      project_id: "project:g16-codegraph-quality",
      created_at: FIXED_TIME,
    });
    const task: RepairTask = {
      expectedFile: "src/checkout.ts",
      expectedLine: 1,
      expectedSpecifier: "./pricing.ts",
    };
    const baseline = scoreRepair(task, proposeRepair(analysis, false));
    const augmented = scoreRepair(task, proposeRepair(analysis, true));

    expect(analysis.coverage.status).toBe("partial");
    expect(analysis.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "static_module_unresolved",
        file_path: task.expectedFile,
        line: task.expectedLine,
      }),
    ]));
    expect(baseline).toEqual({
      dimensions: {
        fault_localization: 0,
        repair_selection: 0,
        minimal_edit_scope: 1,
        diagnostic_traceability: 0,
      },
      total: 0.25,
    });
    expect(augmented).toEqual({
      dimensions: {
        fault_localization: 1,
        repair_selection: 1,
        minimal_edit_scope: 1,
        diagnostic_traceability: 1,
      },
      total: 1,
    });
    expect(augmented.total - baseline.total).toBeGreaterThanOrEqual(0.5);
  });
});

