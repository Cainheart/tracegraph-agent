import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { tmpdir, cpus, totalmem, release, platform, arch } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export const SCENARIO_SCHEMA_VERSION = "tracegraph.benchmark-scenario.v1";
export const REPORT_SCHEMA_VERSION = "tracegraph.benchmark-report.v1";
export const MAX_SCENARIO_BYTES = 32 * 1024;
export const MAX_REPORT_BYTES = 256 * 1024;

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OFFLINE_GUARD_URL = pathToFileURL(fileURLToPath(new URL("./offline-guard.mjs", import.meta.url))).href;
const RUNNER_VERSION = 1;
const MAX_ARGUMENTS = 96;
const MAX_ARGUMENT_BYTES = 24 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const MAX_SAMPLES = 100;
const MAX_WARMUPS = 20;
const SENSITIVE_ENV_NAME = /(?:^|_)(?:API_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|BEARER_?TOKEN|CLIENT_?SECRET|PRIVATE_?KEY|PASSWORD|CREDENTIAL|SECRET|TOKEN|COOKIE)(?:_|$)/iu;
const PROVIDER_ENV_NAME = /^(?:OPENAI|ANTHROPIC|GOOGLE|GEMINI|AZURE_OPENAI|AWS|DEEPSEEK|DASHSCOPE|QWEN|MINIMAX|GLM|ZHIPUAI|LANGFUSE|OTEL_EXPORTER_OTLP)_/iu;
const NETWORK_PROXY_ENV_NAME = /^(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/iu;

export async function readScenarioManifest(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SCENARIO_BYTES) {
    throw new Error("Benchmark scenario must be a bounded regular JSON file");
  }
  const raw = await readFile(path);
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("Benchmark scenario is not valid JSON");
  }
  return {
    scenario: parseScenarioManifest(parsed),
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
}

export function parseScenarioManifest(value) {
  assertExactKeys(value, [
    "schema_version", "id", "version", "description", "working_directory",
    "correctness_command", "command", "warmup_iterations", "sample_iterations",
    "timeout_ms", "budget",
  ], "scenario");
  if (value.schema_version !== SCENARIO_SCHEMA_VERSION) throw new Error("Benchmark scenario schema_version is unsupported");
  if (typeof value.id !== "string" || !/^[a-z][a-z0-9-]{1,63}$/u.test(value.id)) {
    throw new Error("Benchmark scenario id is invalid");
  }
  if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(value.version)) {
    throw new Error("Benchmark scenario version must use major.minor.patch");
  }
  if (typeof value.description !== "string" || value.description.length < 1 || value.description.length > 240) {
    throw new Error("Benchmark scenario description must contain 1 to 240 characters");
  }
  if (typeof value.working_directory !== "string" || value.working_directory.length > 240
    || isAbsolute(value.working_directory) || value.working_directory.split(/[\\/]/u).includes("..")) {
    throw new Error("Benchmark working_directory must be a repository-relative path");
  }
  const warmupIterations = boundedInteger(value.warmup_iterations, 0, MAX_WARMUPS, "warmup_iterations");
  const sampleIterations = boundedInteger(value.sample_iterations, 3, MAX_SAMPLES, "sample_iterations");
  const timeoutMs = boundedInteger(value.timeout_ms, 100, MAX_TIMEOUT_MS, "timeout_ms");
  const correctnessCommand = parseCommand(value.correctness_command, "correctness_command");
  const command = parseCommand(value.command, "command");
  assertExactKeys(value.budget, ["wall_time_ms_p95_max"], "budget");
  const wallTimeP95Max = value.budget.wall_time_ms_p95_max;
  if (typeof wallTimeP95Max !== "number" || !Number.isFinite(wallTimeP95Max)
    || wallTimeP95Max <= 0 || wallTimeP95Max > MAX_TIMEOUT_MS) {
    throw new Error(`budget.wall_time_ms_p95_max must be greater than zero and at most ${MAX_TIMEOUT_MS}`);
  }
  return Object.freeze({
    schema_version: SCENARIO_SCHEMA_VERSION,
    id: value.id,
    version: value.version,
    description: value.description,
    working_directory: value.working_directory,
    correctness_command: correctnessCommand,
    command,
    warmup_iterations: warmupIterations,
    sample_iterations: sampleIterations,
    timeout_ms: timeoutMs,
    budget: Object.freeze({ wall_time_ms_p95_max: wallTimeP95Max }),
  });
}

export async function runBenchmark({
  scenario: rawScenario,
  scenarioConfigSha256,
  scenarioFile = null,
  reportPath,
  repositoryRoot = REPOSITORY_ROOT,
  now = () => new Date(),
}) {
  const scenario = parseScenarioManifest(rawScenario);
  if (typeof scenarioConfigSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(scenarioConfigSha256)) {
    throw new Error("scenarioConfigSha256 must be a lowercase SHA-256 digest");
  }
  const root = await realpath(resolve(repositoryRoot));
  const requestedWorkingDirectory = resolve(root, scenario.working_directory);
  assertWithinRoot(root, requestedWorkingDirectory, "working_directory");
  const workingDirectory = await realpath(requestedWorkingDirectory);
  assertWithinRoot(root, workingDirectory, "working_directory");
  if (scenarioFile !== null && (typeof scenarioFile !== "string" || isAbsolute(scenarioFile) || scenarioFile.includes(".."))) {
    throw new Error("scenarioFile must be a repository-relative label");
  }
  const metadata = readSourceMetadata(root);
  const machine = readMachineMetadata();
  const startedAt = now().toISOString();
  const runId = randomUUID();
  const correctness = await executeIsolated(scenario.correctness_command.args, workingDirectory, scenario.timeout_ms);
  const correctnessResult = {
    passed: correctness.exit_code === 0 && !correctness.timed_out && correctness.spawn_error_code === null,
    exit_code: correctness.exit_code,
    signal: correctness.signal,
    timed_out: correctness.timed_out,
    spawn_error_code: correctness.spawn_error_code,
    duration_ms: correctness.duration_ms,
  };
  const warmups = [];
  const samples = [];
  let status = "passed";
  let failure = null;

  if (!correctnessResult.passed) {
    status = "failed_correctness";
    failure = "correctness command did not exit successfully; measurement was skipped";
  } else {
    for (let index = 0; index < scenario.warmup_iterations; index += 1) {
      const result = await executeIsolated(scenario.command.args, workingDirectory, scenario.timeout_ms);
      warmups.push(toRawResult(index + 1, result));
      if (!result.ok) {
        status = "failed_warmup";
        failure = `warmup ${index + 1} did not exit successfully; measurement was skipped`;
        break;
      }
    }

    if (status === "passed") {
      for (let index = 0; index < scenario.sample_iterations; index += 1) {
        const result = await executeIsolated(scenario.command.args, workingDirectory, scenario.timeout_ms);
        samples.push(toRawResult(index + 1, result));
        if (!result.ok) {
          status = "failed_sample";
          failure = `sample ${index + 1} did not exit successfully; remaining measurements were skipped`;
          break;
        }
      }
    }
  }

  const successfulSamples = samples.filter(({ exit_code, timed_out, spawn_error_code }) => (
    exit_code === 0 && !timed_out && spawn_error_code === null
  )).map(({ wall_time_ms }) => wall_time_ms);
  const measurementComplete = samples.length === scenario.sample_iterations
    && successfulSamples.length === scenario.sample_iterations;
  const summary = measurementComplete ? summarize(successfulSamples) : null;
  let budgetResult = {
    metric: "wall_time_ms.p95",
    limit: scenario.budget.wall_time_ms_p95_max,
    observed: summary?.p95_ms ?? null,
    passed: null,
  };
  if (status === "passed" && samples.length === scenario.sample_iterations && summary !== null) {
    budgetResult = {
      ...budgetResult,
      passed: summary.p95_ms <= scenario.budget.wall_time_ms_p95_max,
    };
    if (budgetResult.passed === false) {
      status = "failed_budget";
      failure = `wall-time p95 ${summary.p95_ms} ms exceeds the fixed scenario budget`;
    }
  }

  const finishedAt = now().toISOString();
  const report = {
    schema_version: REPORT_SCHEMA_VERSION,
    run_id: runId,
    started_at: startedAt,
    finished_at: finishedAt,
    scenario: {
      id: scenario.id,
      version: scenario.version,
      description: scenario.description,
      source_file: scenarioFile,
      config_sha256: scenarioConfigSha256,
    },
    source: metadata,
    machine,
    settings: {
      warmup_iterations: scenario.warmup_iterations,
      sample_iterations: scenario.sample_iterations,
      timeout_ms: scenario.timeout_ms,
      budget: scenario.budget,
    },
    correctness: correctnessResult,
    raw: { warmups, samples },
    summary,
    budget: budgetResult,
    outcome: { status, failure },
  };
  await writeBoundedReport(reportPath, report);
  return report;
}

export function summarize(input) {
  if (!Array.isArray(input) || input.length === 0
    || input.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
    throw new Error("At least one finite nonnegative sample is required");
  }
  const values = [...input].sort((left, right) => left - right);
  const median = medianOfSorted(values);
  const absoluteDeviations = values.map((value) => Math.abs(value - median)).sort((left, right) => left - right);
  return {
    sample_count: values.length,
    method: "nearest-rank p95; median absolute deviation (MAD)",
    min_ms: round(values[0]),
    median_ms: round(median),
    p95_ms: round(values[Math.max(0, Math.ceil(0.95 * values.length) - 1)]),
    mad_ms: round(medianOfSorted(absoluteDeviations)),
    max_ms: round(values[values.length - 1]),
  };
}

async function executeIsolated(args, cwd, timeoutMs) {
  const tempRoot = await mkdtempPrivate();
  const started = performance.now();
  try {
    const childResult = await spawnNode(args, cwd, timeoutMs, tempRoot);
    return {
      ...childResult,
      duration_ms: round(performance.now() - started),
      ok: childResult.exit_code === 0 && !childResult.timed_out && childResult.spawn_error_code === null,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function mkdtempPrivate() {
  const path = await mkdtemp(join(tmpdir(), "tracegraph-bench-"));
  await chmod(path, 0o700);
  await mkdir(join(path, "home"), { recursive: true, mode: 0o700 });
  return path;
}

function spawnNode(args, cwd, timeoutMs, tempRoot) {
  const env = sanitizedEnvironment(tempRoot);
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: "ignore",
      windowsHide: true,
    });
    let timedOut = false;
    let spawnErrorCode = null;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChild(child);
    }, timeoutMs);
    timer.unref?.();
    child.once("error", (error) => {
      spawnErrorCode = typeof error.code === "string" ? error.code : "SPAWN_FAILED";
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolvePromise({
        exit_code: exitCode,
        signal,
        timed_out: timedOut,
        spawn_error_code: spawnErrorCode,
      });
    });
  });
}

function terminateChild(child) {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
  }
}

function sanitizedEnvironment(tempRoot) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || name === "NODE_OPTIONS" || SENSITIVE_ENV_NAME.test(name)
      || PROVIDER_ENV_NAME.test(name) || NETWORK_PROXY_ENV_NAME.test(name)) continue;
    env[name] = value;
  }
  const home = join(tempRoot, "home");
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = join(home, ".config");
  env.XDG_CACHE_HOME = join(home, ".cache");
  env.XDG_DATA_HOME = join(home, ".local", "share");
  env.APPDATA = join(home, "AppData", "Roaming");
  env.LOCALAPPDATA = join(home, "AppData", "Local");
  env.TMPDIR = tempRoot;
  env.TMP = tempRoot;
  env.TEMP = tempRoot;
  env.TRACEGRAPH_BENCHMARK_TEMP_ROOT = tempRoot;
  env.NODE_OPTIONS = `--import=${OFFLINE_GUARD_URL}`;
  return env;
}

function readSourceMetadata(root) {
  const commitOutput = runGit(root, ["rev-parse", "HEAD"]);
  const statusOutput = runGit(root, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  const commit = commitOutput?.trim() ?? "";
  return {
    git_commit: /^[a-f0-9]{40}$/u.test(commit) ? commit : null,
    working_tree_clean: statusOutput === null ? null : statusOutput.trim().length === 0,
  };
}

function runGit(root, args) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && name !== "NODE_OPTIONS" && !SENSITIVE_ENV_NAME.test(name)
      && !PROVIDER_ENV_NAME.test(name) && !NETWORK_PROXY_ENV_NAME.test(name)) env[name] = value;
  }
  const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

function readMachineMetadata() {
  const cpuModel = cpus()[0]?.model ?? "unknown";
  return {
    os_platform: platform(),
    os_release: release(),
    architecture: arch(),
    cpu_model: cpuModel.slice(0, 160),
    logical_cpu_count: cpus().length,
    total_memory_bytes: totalmem(),
    runtime: { name: "node", version: process.version, runner_version: RUNNER_VERSION },
  };
}

async function writeBoundedReport(path, report) {
  if (typeof path !== "string" || path.length === 0) throw new Error("A reportPath is required");
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_REPORT_BYTES) {
    throw new Error(`Benchmark report exceeded the ${MAX_REPORT_BYTES}-byte bound`);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function parseCommand(value, label) {
  assertExactKeys(value, ["args"], label);
  if (!Array.isArray(value.args) || value.args.length === 0 || value.args.length > MAX_ARGUMENTS
    || value.args.some((arg) => typeof arg !== "string" || arg.length > 8_192)
    || value.args.reduce((sum, arg) => sum + Buffer.byteLength(arg, "utf8"), 0) > MAX_ARGUMENT_BYTES) {
    throw new Error(`${label}.args must contain bounded Node arguments`);
  }
  return Object.freeze({ args: Object.freeze([...value.args]) });
}

function assertExactKeys(value, expectedKeys, label) {
  if (!isRecord(value) || Object.keys(value).sort().join("\n") !== [...expectedKeys].sort().join("\n")) {
    throw new Error(`${label} has an invalid object shape`);
  }
}

function boundedInteger(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function assertWithinRoot(root, target, label) {
  const path = relative(root, target);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`${label} resolves outside the repository`);
  }
}

function medianOfSorted(values) {
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0 ? (values[middle - 1] + values[middle]) / 2 : values[middle];
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

function toRawResult(iteration, result) {
  return {
    iteration,
    wall_time_ms: result.duration_ms,
    exit_code: result.exit_code,
    signal: result.signal,
    timed_out: result.timed_out,
    spawn_error_code: result.spawn_error_code,
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return { help: true };
    if (token === "--all") {
      if (options.all === true) throw new Error("--all may be supplied once");
      options.all = true;
      continue;
    }
    if (token !== "--scenario" && token !== "--output") throw new Error(`Unknown argument: ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--") || options[token] !== undefined) {
      throw new Error(`${token} requires one value and may be supplied once`);
    }
    options[token] = value;
    index += 1;
  }
  if (options.all === true) {
    if (options["--scenario"] !== undefined || options["--output"] !== undefined) {
      throw new Error("--all cannot be combined with --scenario or --output");
    }
    return { all: true };
  }
  if (options["--scenario"] === undefined) throw new Error("--scenario or --all is required");
  return { scenarioPath: options["--scenario"], output: options["--output"] };
}

function safeRepositoryPath(root, input, allowedPrefix, label) {
  if (typeof input !== "string" || input.length === 0 || isAbsolute(input)) throw new Error(`${label} must be a relative path`);
  const target = resolve(root, input);
  assertWithinRoot(root, target, label);
  const relativePath = relative(root, target).split(sep).join("/");
  if (relativePath !== allowedPrefix && !relativePath.startsWith(`${allowedPrefix}/`)) {
    throw new Error(`${label} must be inside ${allowedPrefix}`);
  }
  return target;
}

async function assertNoSymlinkComponents(root, target, label) {
  const relativePath = relative(root, target);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`${label} escapes repository root`);
  }
  let current = root;
  for (const component of relativePath.split(sep).filter(Boolean)) {
    current = join(current, component);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`${label} path cannot traverse symbolic links`);
  }
}

async function assertReportDoesNotExist(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Benchmark report path already exists; reports are never overwritten");
}

function formatHelp() {
  return [
    "Usage: pnpm benchmark -- --scenario benchmarks/scenarios/<scenario>.json [--output _tmp_benchmarks/reports/<name>.json]",
    "       pnpm benchmark -- --all",
    "The output path, when supplied, must remain inside _tmp_benchmarks/reports/.",
  ].join("\n");
}

async function main(argv) {
  if (argv[0] === "--") argv = argv.slice(1);
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${formatHelp()}\n`);
    return 0;
  }
  if (options.all) {
    const directory = safeRepositoryPath(
      REPOSITORY_ROOT,
      "benchmarks/scenarios",
      "benchmarks/scenarios",
      "scenario directory",
    );
    await assertNoSymlinkComponents(REPOSITORY_ROOT, directory, "scenario directory");
    const entries = await readdir(directory, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.name.endsWith(".json"))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (files.length === 0 || files.some((entry) => !entry.isFile())) {
      throw new Error("--all requires at least one regular JSON scenario manifest");
    }
    let passed = 0;
    for (const entry of files) {
      const inputPath = relative(REPOSITORY_ROOT, join(directory, entry.name)).split(sep).join("/");
      const result = await runScenarioFile(inputPath);
      process.stdout.write(formatScenarioResult(result));
      if (result.report.outcome.status === "passed") passed += 1;
    }
    process.stdout.write(`Benchmark suite: ${passed}/${files.length} scenarios passed\n`);
    return passed === files.length ? 0 : 1;
  }
  const result = await runScenarioFile(options.scenarioPath, options.output);
  process.stdout.write(formatScenarioResult(result));
  return result.report.outcome.status === "passed" ? 0 : 1;
}

async function runScenarioFile(inputPath, requestedOutput) {
  const scenarioPath = safeRepositoryPath(REPOSITORY_ROOT, inputPath, "benchmarks/scenarios", "scenario");
  await assertNoSymlinkComponents(REPOSITORY_ROOT, scenarioPath, "scenario");
  const { scenario, sha256 } = await readScenarioManifest(scenarioPath);
  const defaultName = `${scenario.id}-${new Date().toISOString().replaceAll(":", "-")}-${process.pid}-${randomUUID().slice(0, 8)}.json`;
  const outputPath = requestedOutput === undefined
    ? join(REPOSITORY_ROOT, "_tmp_benchmarks", "reports", defaultName)
    : safeRepositoryPath(REPOSITORY_ROOT, requestedOutput, "_tmp_benchmarks/reports", "output");
  if (!outputPath.endsWith(".json")) throw new Error("Benchmark report output must end in .json");
  await assertNoSymlinkComponents(REPOSITORY_ROOT, outputPath, "output");
  await assertReportDoesNotExist(outputPath);
  const scenarioFile = relative(REPOSITORY_ROOT, scenarioPath).split(sep).join("/");
  const report = await runBenchmark({ scenario, scenarioConfigSha256: sha256, scenarioFile, reportPath: outputPath });
  const relativeReportPath = relative(REPOSITORY_ROOT, outputPath).split(sep).join("/");
  return { report, reportPath: relativeReportPath };
}

function formatScenarioResult({ report, reportPath }) {
  const summary = report.summary === null ? "no measurements" : `p95 ${report.summary.p95_ms} ms`;
  return `Benchmark ${report.scenario.id}: ${report.outcome.status} (${summary})\nReport: ${reportPath}\n`;
}

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((status) => {
    process.exitCode = status;
  }).catch((error) => {
    process.stderr.write(`Benchmark runner: ${error instanceof Error ? error.message : "operation failed"}\n`);
    process.exitCode = 2;
  });
}
