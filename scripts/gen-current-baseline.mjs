import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, rm, rmdir, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDirectory, "..");
const outputRelativePath = "docs/generated/current-baseline.md";
const structureStart = "<!-- BASELINE-STRUCTURE:START -->";
const structureEnd = "<!-- BASELINE-STRUCTURE:END -->";
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const testFilePattern = /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/u;
const evalFilePattern = /\.eval\.(?:ts|tsx|js|mjs)$/u;
const skippedDirectories = new Set([".git", "node_modules", "dist", "coverage", ".cache"]);
const performanceMetricNames = [
  "context.built.input_tokens",
  "run.model_calls",
  "tool.call.p95_ms",
  "sse.first_byte_ms",
];
const evalMetricsDirectory = "_tmp_evals/metrics";
const evalReportPath = "_tmp_evals/reports/latest.json";

function normalizedPath(value) {
  return value.split(path.sep).join("/");
}

function fail(message) {
  throw new Error(message);
}

function run(command, args, cwd, env, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    const details = capture ? `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() : "";
    fail(`${command} ${args.join(" ")} exited with ${result.status ?? "signal"}${details ? `\n${details}` : ""}`);
  }
  return capture ? (result.stdout ?? "").trim() : "";
}

async function walkFiles(directory, relativeDirectory = "") {
  const absoluteDirectory = path.join(directory, relativeDirectory);
  let entries;
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) continue;
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) files.push(...await walkFiles(directory, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

async function collectWorkspacePackages(root, workspaceConfig) {
  if (!Array.isArray(workspaceConfig.packages)) fail("pnpm-workspace.yaml must declare package patterns");
  const packageFiles = new Set();
  for (const pattern of workspaceConfig.packages) {
    if (typeof pattern !== "string" || !/^[^!*?]+\/\*$/u.test(pattern)) {
      fail(`Unsupported pnpm workspace pattern: ${String(pattern)}`);
    }
    const parent = path.join(root, pattern.slice(0, -2));
    const entries = await readdir(parent, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const manifestPath = path.join(parent, entry.name, "package.json");
      try {
        const info = await lstat(manifestPath);
        if (info.isFile() && !info.isSymbolicLink()) packageFiles.add(manifestPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }

  const manifests = [];
  for (const manifestPath of [...packageFiles].sort()) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (typeof manifest.name !== "string" || !manifest.name) fail(`Workspace package has no name: ${manifestPath}`);
    manifests.push({ path: manifestPath, manifest });
  }
  const knownNames = new Set(manifests.map(({ manifest }) => manifest.name));
  if (knownNames.size !== manifests.length) fail("Workspace package names must be unique");

  const packages = manifests.map(({ path: manifestPath, manifest }) => {
    const dependencies = new Set();
    for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, version] of Object.entries(manifest[section] ?? {})) {
        if (typeof version === "string" && version.startsWith("workspace:") && knownNames.has(name)) dependencies.add(name);
      }
    }
    return {
      name: manifest.name,
      path: normalizedPath(path.relative(root, path.dirname(manifestPath))),
      dependencies: [...dependencies].sort(),
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
  assertAcyclicPackages(packages);
  return packages;
}

function assertAcyclicPackages(packages) {
  const graph = new Map(packages.map((item) => [item.name, item.dependencies]));
  const visiting = new Set();
  const visited = new Set();
  function visit(name, chain) {
    if (visiting.has(name)) fail(`Workspace package dependency cycle: ${[...chain, name].join(" -> ")}`);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of graph.get(name) ?? []) visit(dependency, [...chain, name]);
    visiting.delete(name);
    visited.add(name);
  }
  for (const name of graph.keys()) visit(name, []);
}

async function countSourceLines(root) {
  const paths = [];
  for (const area of ["apps", "packages"]) {
    for (const file of await walkFiles(path.join(root, area))) {
      if (!file.includes(`${path.sep}src${path.sep}`) || !sourceExtensions.has(path.extname(file))) continue;
      if (file.endsWith(".d.ts") || testFilePattern.test(file)) continue;
      paths.push(path.join(area, file));
    }
  }
  let nonblankLines = 0;
  for (const file of paths) {
    const content = await readFile(path.join(root, file), "utf8");
    nonblankLines += content.split(/\r?\n/u).filter((line) => line.trim().length > 0).length;
  }
  return { production_files: paths.length, nonblank_lines: nonblankLines };
}

function countTestCalls(source) {
  const direct = [...source.matchAll(/\b(?:it|test)(?:\.(?:only|skip|todo|fails|concurrent|sequential))?\s*\(\s*["'`]/gu)].length;
  const parameterized = [...source.matchAll(/\b(?:it|test)\.each\s*\([\s\S]*?\)\s*\(\s*["'`]/gu)].length;
  return direct + parameterized;
}

async function countTests(root) {
  const files = [];
  for (const area of ["apps", "packages", "scripts", "evals"]) {
    for (const file of await walkFiles(path.join(root, area))) {
      if (!sourceExtensions.has(path.extname(file))) continue;
      if (testFilePattern.test(file) || evalFilePattern.test(file)) files.push(path.join(area, file));
    }
  }
  let declarationCallSites = 0;
  for (const file of files) declarationCallSites += countTestCalls(await readFile(path.join(root, file), "utf8"));
  return { test_files: files.length, test_declaration_call_sites: declarationCallSites };
}

async function countEventTypes(root) {
  const relativeFile = "packages/contracts/src/event.ts";
  const source = await readFile(path.join(root, relativeFile), "utf8");
  const declaration = /export const EventTypeSchema\s*=\s*z\.enum\(\[([\s\S]*?)\]\);/u.exec(source);
  const eventTypes = declaration ? [...declaration[1].matchAll(/^\s*"([^"\\]*(?:\\.[^"\\]*)*)",?\s*$/gmu)].map((match) => match[1]).sort() : undefined;
  if (!eventTypes || eventTypes.length === 0) fail(`${relativeFile}: could not read EventTypeSchema string literals`);
  if (new Set(eventTypes).size !== eventTypes.length) fail(`${relativeFile}: EventTypeSchema has duplicate values`);
  return { event_type_count: eventTypes.length, event_types: eventTypes };
}

export async function collectStructuralBaseline(root = defaultRoot) {
  const workspaceSource = await readFile(path.join(root, "pnpm-workspace.yaml"), "utf8");
  const workspaceConfig = parse(workspaceSource, { uniqueKeys: true });
  const [packages, loc, tests, events] = await Promise.all([
    collectWorkspacePackages(root, workspaceConfig),
    countSourceLines(root),
    countTests(root),
    countEventTypes(root),
  ]);
  return { packages, source_loc: loc, tests, events };
}

function extractStructuralBaseline(markdown) {
  const escapedStart = structureStart.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const escapedEnd = structureEnd.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`${escapedStart}\\s*\\x60\\x60\\x60json\\s*([\\s\\S]*?)\\s*\\x60\\x60\\x60\\s*${escapedEnd}`, "u").exec(markdown);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]);
  } catch {
    return undefined;
  }
}

export function compareStructuralBaseline(markdown, currentStructure) {
  const recorded = extractStructuralBaseline(markdown);
  if (recorded === undefined) return { ok: false, message: "No valid deterministic structure block found in baseline report." };
  const expected = `${JSON.stringify(currentStructure, null, 2)}\n`;
  const actual = `${JSON.stringify(recorded, null, 2)}\n`;
  return actual === expected
    ? { ok: true, message: "Deterministic structural data matches." }
    : { ok: false, message: "Deterministic structural data differs; regenerate and review the baseline." };
}

async function captureDiagnosticOutputs(root) {
  const temporaryRoot = path.join(root, "_tmp_evals");
  const metricsDirectory = path.join(root, evalMetricsDirectory);
  const report = path.join(root, evalReportPath);
  const metrics = new Map();
  let temporaryRootInfo;
  try {
    temporaryRootInfo = await lstat(temporaryRoot);
    if (!temporaryRootInfo.isDirectory() || temporaryRootInfo.isSymbolicLink()) fail(`Refusing to snapshot non-regular eval temp root: ${temporaryRoot}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let metricsDirectoryInfo;
  try {
    metricsDirectoryInfo = await lstat(metricsDirectory);
    if (!metricsDirectoryInfo.isDirectory() || metricsDirectoryInfo.isSymbolicLink()) fail(`Refusing to snapshot non-regular metrics directory: ${metricsDirectory}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let metricNames = [];
  try {
    metricNames = (await readdir(metricsDirectory)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (metricNames.length > 64) fail(`${evalMetricsDirectory} contains more than 64 JSON files; refusing to snapshot`);
  for (const name of metricNames) {
    const file = path.join(metricsDirectory, name);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) fail(`Refusing to snapshot non-regular metric file: ${file}`);
    metrics.set(name, { content: await readFile(file), mode: info.mode, atime: info.atime, mtime: info.mtime });
  }
  let reportBytes;
  let reportInfo;
  try {
    reportInfo = await lstat(report);
    if (!reportInfo.isFile() || reportInfo.isSymbolicLink()) fail(`Refusing to snapshot non-regular eval report: ${report}`);
    reportBytes = await readFile(report);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let reportDirectoryInfo;
  try {
    reportDirectoryInfo = await lstat(path.dirname(report));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { temporaryRoot, metricsDirectory, report, metrics, reportBytes, temporaryRootInfo, metricsDirectoryInfo, reportInfo, reportDirectoryInfo };
}

async function restoreDiagnosticOutputs(snapshot) {
  const currentNames = await readdir(snapshot.metricsDirectory).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
  for (const name of currentNames.filter((entry) => entry.endsWith(".json"))) {
    if (!snapshot.metrics.has(name)) await rm(path.join(snapshot.metricsDirectory, name), { force: true });
  }
  if (snapshot.metrics.size > 0) await mkdir(snapshot.metricsDirectory, { recursive: true });
  for (const [name, entry] of snapshot.metrics) {
    const file = path.join(snapshot.metricsDirectory, name);
    await writeFile(file, entry.content);
    await chmod(file, entry.mode);
    await utimes(file, entry.atime, entry.mtime);
  }
  if (snapshot.reportBytes !== undefined) {
    await mkdir(path.dirname(snapshot.report), { recursive: true });
    await writeFile(snapshot.report, snapshot.reportBytes);
    await chmod(snapshot.report, snapshot.reportInfo.mode);
    await utimes(snapshot.report, snapshot.reportInfo.atime, snapshot.reportInfo.mtime);
  } else {
    await rm(snapshot.report, { force: true });
  }
  if (snapshot.metricsDirectoryInfo) {
    await chmod(snapshot.metricsDirectory, snapshot.metricsDirectoryInfo.mode);
    await utimes(snapshot.metricsDirectory, snapshot.metricsDirectoryInfo.atime, snapshot.metricsDirectoryInfo.mtime);
  }
  if (snapshot.reportDirectoryInfo) {
    await chmod(path.dirname(snapshot.report), snapshot.reportDirectoryInfo.mode);
    await utimes(path.dirname(snapshot.report), snapshot.reportDirectoryInfo.atime, snapshot.reportDirectoryInfo.mtime);
  } else {
    await rmdir(path.dirname(snapshot.report)).catch((error) => {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
    });
  }
  if (!snapshot.metricsDirectoryInfo) {
    await rmdir(snapshot.metricsDirectory).catch((error) => {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
    });
  }
  if (snapshot.temporaryRootInfo) {
    await chmod(snapshot.temporaryRoot, snapshot.temporaryRootInfo.mode);
    await utimes(snapshot.temporaryRoot, snapshot.temporaryRootInfo.atime, snapshot.temporaryRootInfo.mtime);
  } else {
    await rmdir(snapshot.temporaryRoot).catch((error) => {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
    });
  }
}

async function collectPerformanceDiagnostics(root, env) {
  const snapshot = await captureDiagnosticOutputs(root);
  try {
    run("pnpm", ["run", "build"], root, env);
    run("pnpm", ["exec", "vitest", "run", "--config", "vitest.evals.config.ts", "evals/perf/performance.eval.ts"], root, env);
    const report = JSON.parse(await readFile(path.join(root, evalReportPath), "utf8"));
    if (report.result !== "passed") fail(`G16 performance eval did not pass (result: ${String(report.result)})`);
    const observed = new Map((report.metrics ?? []).map((metric) => [metric.name, metric]));
    const committed = JSON.parse(await readFile(path.join(root, "evals/baselines/performance.json"), "utf8"));
    const metrics = performanceMetricNames.map((name) => {
      const sample = observed.get(name);
      const gate = committed.metrics?.[name];
      if (!sample || !gate || !Number.isFinite(sample.value) || sample.unit !== gate.unit || sample.scenario !== gate.scenario) {
        fail(`G16 performance report is missing or mismatches metric ${name}`);
      }
      return { name, value: sample.value, unit: sample.unit, scenario: sample.scenario, accepted_max: gate.max };
    });
    const testSummary = report.summary ?? {};
    return {
      measured_at: report.generated_at,
      result: report.result,
      test_summary: { total: testSummary.total ?? 0, passed: testSummary.passed ?? 0, failed: testSummary.failed ?? 0 },
      metrics,
      command: "pnpm run build && pnpm exec vitest run --config vitest.evals.config.ts evals/perf/performance.eval.ts",
    };
  } finally {
    await restoreDiagnosticOutputs(snapshot);
  }
}

async function collectRepositoryMetadata(root) {
  const git = (args) => run("git", args, root, { ...process.env, NODE_OPTIONS: "" }, true);
  const [commit, status, pnpmVersion] = await Promise.all([
    git(["rev-parse", "HEAD"]),
    git(["status", "--porcelain=v1", "--untracked-files=all"]),
    run("pnpm", ["--version"], root, { ...process.env, NODE_OPTIONS: "" }, true),
  ]);
  return {
    generated_at: new Date().toISOString(),
    commit,
    working_tree_dirty: status.length > 0,
    platform: { os: `${os.platform()} ${os.release()}`, arch: os.arch(), node: process.version, pnpm: pnpmVersion },
  };
}

export function renderReport(metadata, structure, performance) {
  const packageRows = structure.packages.map((item) => `| \`${item.name}\` | ${item.dependencies.length ? item.dependencies.map((name) => `\`${name}\``).join(", ") : "—"} |`).join("\n");
  const performanceRows = performance.metrics.map((metric) => `| \`${metric.name}\` | ${metric.value} ${metric.unit} | ${metric.accepted_max} ${metric.unit} |`).join("\n");
  return [
    "<!-- Generated by `pnpm baseline:current`; edit the source or generator instead. -->",
    "# Current repository baseline",
    "",
    `- Generated: \`${metadata.generated_at}\` (diagnostic metadata)`,
    `- Commit: \`${metadata.commit}\` (working tree ${metadata.working_tree_dirty ? "dirty" : "clean"})`,
    `- Environment: \`${metadata.platform.os}; ${metadata.platform.arch}; Node ${metadata.platform.node}; pnpm ${metadata.platform.pnpm}\` (diagnostic metadata)`,
    "",
    "## Deterministic structure",
    "",
    "`--check` compares only the JSON structure below. Environment, generation time, and performance samples are reported for diagnosis and are excluded from the comparison.",
    "",
    "### Workspace package DAG",
    "",
    `Workspace packages: **${structure.packages.length}**`,
    "",
    "| Package | Direct workspace dependencies |",
    "| --- | --- |",
    packageRows,
    "",
    "### Source and verification inventory",
    "",
    `- Production source: **${structure.source_loc.nonblank_lines.toLocaleString("en-US")}** nonblank lines across ${structure.source_loc.production_files} TypeScript/JavaScript files under \`apps/*/src\` and \`packages/*/src\` (test and declaration files excluded).`,
    `- Tests: **${structure.tests.test_files}** test/eval files; **${structure.tests.test_declaration_call_sites}** static \`it()\`/\`test()\` declaration call sites.`,
    `- Durable event types: **${structure.events.event_type_count}** from \`packages/contracts/src/event.ts:EventTypeSchema\`.`,
    "",
    structureStart,
    "```json",
    JSON.stringify(structure, null, 2),
    "```",
    structureEnd,
    "",
    "## Performance diagnostics",
    "",
    `G16 result: **${performance.result}** (${performance.test_summary.passed}/${performance.test_summary.total} tests passed); sample time \`${performance.measured_at}\`. This run is diagnostic and is not part of \`--check\`.`,
    "",
    "| Metric | Current sample | Accepted maximum |",
    "| --- | ---: | ---: |",
    performanceRows,
    "",
    `Reproduce performance samples with: \`${performance.command}\``,
    "",
    "## Reproduction",
    "",
    "- Regenerate this report and collect fresh G16 performance diagnostics: `pnpm baseline:current`.",
    "- Compare deterministic structure without rewriting the report: `pnpm baseline:current:check`.",
    "- Run the existing full offline eval suite separately with `pnpm evals`; its diagnostics are preserved by the baseline generator.",
    "",
  ].join("\n");
}

function parseArguments(argv) {
  let check = false;
  let root = defaultRoot;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--check") check = true;
    else if (argv[index] === "--root" && argv[index + 1]) root = path.resolve(argv[++index]);
    else fail(`Unknown or incomplete argument: ${argv[index]}`);
  }
  return { check, root };
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
    const structure = await collectStructuralBaseline(options.root);
    const outputPath = path.join(options.root, outputRelativePath);
    if (options.check) {
      const current = await readFile(outputPath, "utf8");
      const comparison = compareStructuralBaseline(current, structure);
      if (!comparison.ok) {
        console.error(comparison.message);
        process.exitCode = 1;
      } else {
        console.log(comparison.message);
      }
      return;
    }

    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.TRACEGRAPH_EVAL_UPDATE;
    const performance = await collectPerformanceDiagnostics(options.root, env);
    const metadata = await collectRepositoryMetadata(options.root);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, renderReport(metadata, structure, performance), "utf8");
    console.log(`Wrote ${path.relative(options.root, outputPath)} (${structure.packages.length} packages, ${structure.tests.test_files} test/eval files, ${structure.events.event_type_count} event types).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
