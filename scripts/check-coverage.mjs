#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const DEFAULT_SUMMARY = "coverage/coverage-summary.json";
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

export const COVERAGE_GATE_SCHEMA_VERSION = "tracegraph.coverage-gate.v1";

export const COVERAGE_THRESHOLDS = Object.freeze({
  global: 70,
  contracts: 90,
  context: 90,
  policy: 90,
});

function fail(message) {
  throw new Error(message);
}

function toPosixPath(value) {
  return value.split(sep).join("/");
}

function extensionOf(filePath) {
  if (filePath.endsWith(".tsx")) return ".tsx";
  if (filePath.endsWith(".ts")) return ".ts";
  return "";
}

function isProductionSource(relativePath) {
  if (!SOURCE_EXTENSIONS.has(extensionOf(relativePath))) return false;
  if (/\.(?:test|spec)\.tsx?$/.test(relativePath)) return false;
  if (relativePath.endsWith(".d.ts")) return false;
  return /^(?:apps|packages)\/[^/]+\/src\//.test(relativePath);
}

async function walkFiles(directory, rootDirectory, output) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(absolutePath, rootDirectory, output);
      continue;
    }
    if (!entry.isFile()) continue;

    const sourcePath = toPosixPath(relative(rootDirectory, absolutePath));
    if (isProductionSource(sourcePath)) output.push(sourcePath);
  }
}

export async function discoverProductionSources(rootDirectory) {
  const root = resolve(rootDirectory);
  const sources = [];
  await walkFiles(resolve(root, "apps"), root, sources);
  await walkFiles(resolve(root, "packages"), root, sources);
  sources.sort();

  if (sources.length === 0) {
    fail(`no production TypeScript sources found below ${root}`);
  }
  return sources;
}

function normalizeSummaryPath(summaryPath, rootDirectory) {
  let decodedPath = summaryPath;
  if (summaryPath.startsWith("file:")) {
    try {
      decodedPath = fileURLToPath(summaryPath);
    } catch {
      fail(`coverage summary contains an invalid file URL: ${summaryPath}`);
    }
  }

  const absolutePath = isAbsolute(decodedPath)
    ? resolve(decodedPath)
    : resolve(rootDirectory, decodedPath);
  const relativePath = toPosixPath(relative(rootDirectory, absolutePath));
  if (relativePath === ".." || relativePath.startsWith("../")) return undefined;
  return relativePath;
}

function readLineCounts(entry, label) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    fail(`${label} must be an object`);
  }
  const lines = entry.lines;
  if (!lines || typeof lines !== "object" || Array.isArray(lines)) {
    fail(`${label}.lines must be an object`);
  }

  const { total, covered } = lines;
  if (!Number.isSafeInteger(total) || total < 0) {
    fail(`${label}.lines.total must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(covered) || covered < 0 || covered > total) {
    fail(`${label}.lines.covered must be an integer between zero and total`);
  }
  return { total, covered };
}

function addCounts(left, right) {
  return {
    total: left.total + right.total,
    covered: left.covered + right.covered,
  };
}

function percentage(counts) {
  return counts.total === 0 ? 100 : (counts.covered / counts.total) * 100;
}

function roundedPercentage(counts) {
  return Math.round(percentage(counts) * 100) / 100;
}

function createGate(id, threshold, sourceFiles, coverageByFile) {
  if (sourceFiles.length === 0) {
    return {
      id,
      threshold,
      source_files: 0,
      lines: { total: 0, covered: 0, percent: 0 },
      status: "failed",
      reason: "scope contains no production source files",
    };
  }

  let counts = { total: 0, covered: 0 };
  for (const sourceFile of sourceFiles) {
    const fileCounts = coverageByFile.get(sourceFile);
    if (fileCounts) counts = addCounts(counts, fileCounts);
  }
  const percent = roundedPercentage(counts);
  const status = counts.total > 0 && percentage(counts) >= threshold ? "passed" : "failed";
  return {
    id,
    threshold,
    source_files: sourceFiles.length,
    lines: { ...counts, percent },
    status,
    ...(counts.total === 0 ? { reason: "scope contains no executable lines" } : {}),
  };
}

export function evaluateCoverageSummary(summary, options) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    fail("coverage summary root must be an object");
  }
  const rootDirectory = resolve(options.rootDirectory);
  const expectedSources = [...new Set(options.expectedSources)].sort();
  if (expectedSources.length !== options.expectedSources.length) {
    fail("expected source list contains duplicate paths");
  }
  if (expectedSources.some((sourcePath) => !isProductionSource(sourcePath))) {
    fail("expected source list contains a non-production path");
  }

  const coverageByFile = new Map();
  for (const [summaryPath, entry] of Object.entries(summary)) {
    if (summaryPath === "total") continue;
    const sourcePath = normalizeSummaryPath(summaryPath, rootDirectory);
    if (!sourcePath || !isProductionSource(sourcePath)) continue;
    if (coverageByFile.has(sourcePath)) {
      fail(`coverage summary maps multiple entries to ${sourcePath}`);
    }
    coverageByFile.set(sourcePath, readLineCounts(entry, summaryPath));
  }

  const missingSources = expectedSources.filter((sourcePath) => !coverageByFile.has(sourcePath));
  const unexpectedSources = [...coverageByFile.keys()]
    .filter((sourcePath) => !expectedSources.includes(sourcePath))
    .sort();

  let computedTotal = { total: 0, covered: 0 };
  for (const sourcePath of expectedSources) {
    const counts = coverageByFile.get(sourcePath);
    if (counts) computedTotal = addCounts(computedTotal, counts);
  }

  const declaredTotal = readLineCounts(summary.total, "total");
  const totalMatches = declaredTotal.total === computedTotal.total
    && declaredTotal.covered === computedTotal.covered
    && unexpectedSources.length === 0;

  const contractsSources = expectedSources.filter((path) => path.startsWith("packages/contracts/src/"));
  const contextSources = expectedSources.filter((path) => path === "packages/core/src/context.ts");
  const policySources = expectedSources.filter((path) => /^packages\/core\/src\/policy[^/]*\.tsx?$/.test(path));
  const gates = [
    createGate("global", COVERAGE_THRESHOLDS.global, expectedSources, coverageByFile),
    createGate("packages/contracts", COVERAGE_THRESHOLDS.contracts, contractsSources, coverageByFile),
    createGate("packages/core/src/context.ts", COVERAGE_THRESHOLDS.context, contextSources, coverageByFile),
    createGate("packages/core/src/policy*", COVERAGE_THRESHOLDS.policy, policySources, coverageByFile),
  ];

  const errors = [];
  if (missingSources.length > 0) {
    errors.push(`coverage is missing ${missingSources.length} production source file(s)`);
  }
  if (unexpectedSources.length > 0) {
    errors.push(`coverage contains ${unexpectedSources.length} unexpected production source file(s)`);
  }
  if (!totalMatches) {
    errors.push("declared total line counts do not match the complete per-file source set");
  }
  for (const gate of gates) {
    if (gate.status === "failed") {
      errors.push(`${gate.id} line coverage ${gate.lines.percent}% is below ${gate.threshold}%`);
    }
  }

  return {
    schema_version: COVERAGE_GATE_SCHEMA_VERSION,
    result: errors.length === 0 ? "passed" : "failed",
    source_files: expectedSources.length,
    missing_sources: missingSources,
    unexpected_sources: unexpectedSources,
    totals: {
      declared: { ...declaredTotal, percent: roundedPercentage(declaredTotal) },
      computed: { ...computedTotal, percent: roundedPercentage(computedTotal) },
    },
    gates,
    errors,
  };
}

export async function checkCoverage(options = {}) {
  const rootDirectory = resolve(options.rootDirectory ?? DEFAULT_ROOT);
  const summaryPath = resolve(rootDirectory, options.summaryPath ?? DEFAULT_SUMMARY);
  const expectedSources = await discoverProductionSources(rootDirectory);

  let summary;
  try {
    summary = JSON.parse(await readFile(summaryPath, "utf8"));
  } catch (error) {
    fail(`cannot read coverage summary at ${summaryPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    summary_path: toPosixPath(relative(rootDirectory, summaryPath)),
    ...evaluateCoverageSummary(summary, { rootDirectory, expectedSources }),
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--root" && argument !== "--summary") {
      fail(`unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${argument} requires a value`);
    const key = argument === "--root" ? "rootDirectory" : "summaryPath";
    if (options[key] !== undefined) fail(`${argument} may only be specified once`);
    options[key] = value;
    index += 1;
  }
  return options;
}

async function main() {
  try {
    const result = await checkCoverage(parseArguments(process.argv.slice(2)));
    const output = `${JSON.stringify(result, null, 2)}\n`;
    if (result.result === "passed") {
      process.stdout.write(output);
      return;
    }
    process.stderr.write(output);
    process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      schema_version: COVERAGE_GATE_SCHEMA_VERSION,
      result: "failed",
      errors: [error instanceof Error ? error.message : String(error)],
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  await main();
}
