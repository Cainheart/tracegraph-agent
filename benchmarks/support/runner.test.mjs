import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  parseScenarioManifest,
  readScenarioManifest,
  runBenchmark,
  SCENARIO_SCHEMA_VERSION,
  summarize,
} from "./runner.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("scenario manifests reject unknown keys, out-of-root paths, and unbounded settings", () => {
  assert.throws(() => parseScenarioManifest({ ...scenario(), typo: true }), /invalid object shape/u);
  assert.throws(() => parseScenarioManifest(scenario({ working_directory: "../outside" })), /repository-relative/u);
  assert.throws(() => parseScenarioManifest(scenario({ sample_iterations: 101 })), /sample_iterations/u);
  assert.throws(() => parseScenarioManifest(scenario({ budget: { wall_time_ms_p95_max: 0 } })), /budget/u);
});

test("scenario loader hashes bounded regular JSON config bytes", async (context) => {
  const root = await makeTempRoot(context);
  const path = join(root, "scenario.json");
  const source = `${JSON.stringify(scenario())}\n`;
  await writeFile(path, source, "utf8");
  const loaded = await readScenarioManifest(path);
  assert.equal(loaded.scenario.id, "runner-test");
  assert.equal(loaded.sha256, createHash("sha256").update(source).digest("hex"));
});

test("summary uses nearest-rank p95 and median absolute deviation", () => {
  assert.deepEqual(summarize([9, 1, 5, 3, 7]), {
    sample_count: 5,
    method: "nearest-rank p95; median absolute deviation (MAD)",
    min_ms: 1,
    median_ms: 5,
    p95_ms: 9,
    mad_ms: 2,
    max_ms: 9,
  });
});

test("runner isolates each command, strips credentials, and writes an auditable raw report", async (context) => {
  const root = await makeTempRoot(context);
  const logPath = join(root, "invocations.log");
  const appendInvocation = (label) => [
    "--eval",
    `require('node:fs').appendFileSync(${JSON.stringify(logPath)}, ${JSON.stringify(`${label}|`)} + process.env.TRACEGRAPH_BENCHMARK_TEMP_ROOT + '\\n'); if (process.env.TRACEGRAPH_BENCH_TEST_SECRET) process.exit(19);`,
  ];
  const reportPath = join(root, "report.json");
  const previousSecret = process.env.TRACEGRAPH_BENCH_TEST_SECRET;
  const previousNodeOptions = process.env.NODE_OPTIONS;
  process.env.TRACEGRAPH_BENCH_TEST_SECRET = "never-include-this-value";
  process.env.NODE_OPTIONS = "--require=/does/not/exist";
  try {
    const report = await runBenchmark({
      scenario: scenario({
        correctness_command: { args: appendInvocation("correctness") },
        command: { args: appendInvocation("sample") },
        warmup_iterations: 1,
        sample_iterations: 3,
      }),
      scenarioConfigSha256: createHash("sha256").update("fixed-test-scenario").digest("hex"),
      reportPath,
      repositoryRoot: REPOSITORY_ROOT,
    });
    assert.equal(report.outcome.status, "passed");
    assert.equal(report.correctness.passed, true);
    assert.equal(report.raw.warmups.length, 1);
    assert.equal(report.raw.samples.length, 3);
    assert.equal(report.summary.sample_count, 3);
    assert.equal(report.budget.passed, true);
    assert.equal(report.source.working_tree_clean, false);
    assert.equal(report.machine.runtime.name, "node");

    const invocations = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => line.split("|"));
    assert.deepEqual(invocations.map(([kind]) => kind), ["correctness", "sample", "sample", "sample", "sample"]);
    const tempRoots = invocations.map(([, path]) => path);
    assert.equal(new Set(tempRoots).size, 5);
    for (const tempRoot of tempRoots) {
      await assert.rejects(access(tempRoot), { code: "ENOENT" });
    }
    const serialized = await readFile(reportPath, "utf8");
    assert.doesNotMatch(serialized, /never-include-this-value|TRACEGRAPH_BENCH_TEST_SECRET|invocations\.log|tracegraph-bench-/u);
    assert.match(serialized, /"config_sha256"/u);
  } finally {
    if (previousSecret === undefined) delete process.env.TRACEGRAPH_BENCH_TEST_SECRET;
    else process.env.TRACEGRAPH_BENCH_TEST_SECRET = previousSecret;
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
  }
});

test("correctness failure creates a failed report and skips every measurement", async (context) => {
  const root = await makeTempRoot(context);
  const marker = join(root, "measurement-started");
  const reportPath = join(root, "failed.json");
  const report = await runBenchmark({
    scenario: scenario({
      correctness_command: { args: ["--eval", "process.exit(7)"] },
      command: { args: ["--eval", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`] },
    }),
    scenarioConfigSha256: createHash("sha256").update("failed-correctness").digest("hex"),
    reportPath,
    repositoryRoot: REPOSITORY_ROOT,
  });
  assert.equal(report.outcome.status, "failed_correctness");
  assert.equal(report.correctness.exit_code, 7);
  assert.deepEqual(report.raw, { warmups: [], samples: [] });
  await assert.rejects(access(marker), { code: "ENOENT" });
  assert.equal(JSON.parse(await readFile(reportPath, "utf8")).outcome.status, "failed_correctness");
});

test("Node subprocesses reject fetch, TCP, UDP, and DNS egress and reports a budget regression", async (context) => {
  const root = await makeTempRoot(context);
  const reportPath = join(root, "budget.json");
  const guardedNetworkAssertion = [
    "--eval",
    "const blocked = (fn) => { try { fn(); return false; } catch (error) { return error.code === 'ERR_TRACEGRAPH_BENCHMARK_NETWORK_BLOCKED'; } }; const tcp = blocked(() => new (require('node:net').Socket)().connect({ host: 'example.com', port: 443 })); const tls = blocked(() => require('node:tls').connect({ host: 'example.com', port: 443 })); const udp = blocked(() => require('node:dgram').createSocket('udp4').send(Buffer.from('x'), 53, 'example.com', () => {})); const dns = blocked(() => require('node:dns').lookup('example.com', () => {})); void (async () => { try { await fetch('https://example.com'); process.exit(8); } catch (error) { process.exit(tcp && tls && udp && dns && error.code === 'ERR_TRACEGRAPH_BENCHMARK_NETWORK_BLOCKED' ? 0 : 9); } })();",
  ];
  const report = await runBenchmark({
    scenario: scenario({
      correctness_command: { args: guardedNetworkAssertion },
      command: { args: ["--eval", "await new Promise((resolve) => setTimeout(resolve, 25));"] },
      warmup_iterations: 0,
      sample_iterations: 3,
      budget: { wall_time_ms_p95_max: 0.001 },
    }),
    scenarioConfigSha256: createHash("sha256").update("slow-path").digest("hex"),
    reportPath,
    repositoryRoot: REPOSITORY_ROOT,
  });
  assert.equal(report.correctness.passed, true);
  assert.equal(report.outcome.status, "failed_budget");
  assert.equal(report.budget.passed, false);
  assert.ok(report.summary.p95_ms > report.settings.budget.wall_time_ms_p95_max);
});

test("timed out samples stop the run and are not counted as passing measurements", async (context) => {
  const root = await makeTempRoot(context);
  const report = await runBenchmark({
    scenario: scenario({
      command: { args: ["--eval", "setInterval(() => {}, 1_000)"] },
      warmup_iterations: 0,
      sample_iterations: 3,
      timeout_ms: 100,
    }),
    scenarioConfigSha256: createHash("sha256").update("timeout").digest("hex"),
    reportPath: join(root, "timeout.json"),
    repositoryRoot: REPOSITORY_ROOT,
  });
  assert.equal(report.outcome.status, "failed_sample");
  assert.equal(report.raw.samples.length, 1);
  assert.equal(report.raw.samples[0].timed_out, true);
  assert.equal(report.summary, null);
  assert.equal(report.budget.passed, null);
});

async function makeTempRoot(context) {
  const root = await mkdtemp(join(tmpdir(), "tracegraph-benchmark-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function scenario(overrides = {}) {
  return {
    schema_version: SCENARIO_SCHEMA_VERSION,
    id: "runner-test",
    version: "1.0.0",
    description: "Synthetic harness contract test",
    working_directory: ".",
    correctness_command: { args: ["--eval", "process.exit(0)"] },
    command: { args: ["--eval", "process.exit(0)"] },
    warmup_iterations: 1,
    sample_iterations: 3,
    timeout_ms: 2_000,
    budget: { wall_time_ms_p95_max: 30_000 },
    ...overrides,
  };
}
