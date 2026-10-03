import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAgentRuntime,
  createDefaultToolRegistry,
  createReadonlyWorkspaceHandle,
  DurableSessionController,
  evaluateMemoryRecallEligibility,
  executeToolDefinition,
  JsonlEventLedger,
  JsonlSessionStore,
  projectRun,
  rankEligibleV2Memory,
} from "../../packages/core/dist/index.js";
import { createTraceGraphHost } from "../../packages/host/dist/index.js";

const SCENARIOS = new Set([
  "cold-start",
  "ledger-append",
  "run-replay",
  "context-compaction",
  "memory-recall",
  "tool-execution",
  "cancel-quiescence",
  "run-recovery",
]);
const ROOT = process.env.TRACEGRAPH_BENCHMARK_TEMP_ROOT;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXED_NOW = new Date("2026-10-01T00:00:00.000Z");

if (typeof ROOT !== "string" || ROOT.length === 0) {
  throw new Error("TRACEGRAPH_BENCHMARK_TEMP_ROOT is required");
}

const [mode, scenarioId] = process.argv.slice(2);
if (mode === "recovery-worker") {
  await runInterruptedWorker();
} else {
  if (mode !== "correctness" && mode !== "measure") {
    throw new Error("Expected correctness, measure, or recovery-worker mode");
  }
  if (typeof scenarioId !== "string" || !SCENARIOS.has(scenarioId)) {
    throw new Error("Unknown benchmark path");
  }
  await runScenario(scenarioId);
}

async function runScenario(id) {
  switch (id) {
    case "cold-start": return coldStart();
    case "ledger-append": return ledgerAppend();
    case "run-replay": return runReplay();
    case "context-compaction": return contextCompaction();
    case "memory-recall": return memoryRecall();
    case "tool-execution": return toolExecution();
    case "cancel-quiescence": return cancelQuiescence();
    case "run-recovery": return runRecovery();
    default: throw new Error("Unknown benchmark path");
  }
}

async function coldStart() {
  const runtime = await createRuntime("cold-start", finishedModel("cold-start"));
  const host = await createTraceGraphHost({
    runtime,
    projects: [],
    capabilityToken: "benchmark-loopback-capability",
    allowedOrigins: ["http://127.0.0.1:4310"],
    logger: false,
  });
  try {
    const address = await host.listen({ port: 0, host: "127.0.0.1" });
    const response = await fetch(`${address}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  } finally {
    await host.close();
  }
}

async function ledgerAppend() {
  const ledger = new JsonlEventLedger(join(ROOT, "ledger-append", "events"), {
    now: () => FIXED_NOW,
    idFactory: sequentialIds("ledger"),
  });
  const projectId = "project:bench-ledger";
  const runId = "run:bench-ledger";
  const common = { project_id: projectId, run_id: runId, session_id: "session:bench-ledger" };
  await ledger.append({
    ...common,
    type: "run.created",
    summary: "Create a fixed benchmark Run",
    data: { task: "Append deterministic ledger events", mode: "execute", workspace_kind: "readonly_local" },
  });
  await ledger.append({
    ...common,
    type: "run.started",
    summary: "Start the benchmark Run",
    data: { phase: "running" },
  });
  const appendCount = 48;
  for (let index = 0; index < appendCount; index += 1) {
    await ledger.append({
      ...common,
      type: "model.request_started",
      summary: "Record deterministic model request evidence",
      model_call_id: `model-call:bench-ledger-${index}`,
      data: { turn: index + 1, request_kind: "initial" },
    });
  }
  const events = await ledger.list(runId);
  assert.equal(events.length, appendCount + 2);
  assert.equal(projectRun(events).status, "running");
  assert.equal(events.at(-1)?.sequence, appendCount + 2);
}

async function runReplay() {
  const workspace = await createWorkspace("run-replay");
  const runtime = await createRuntime("run-replay", oneToolThenFinishModel("run-replay"));
  try {
    await writeFile(join(workspace.real_root, "probe.txt"), "deterministic replay evidence\n", "utf8");
    const completed = await startAndWait(runtime, workspace, "run-replay");
    const snapshot = await runtime.replayAt({
      session_id: completed.session_id,
      run_id: completed.run_id,
      until_sequence: completed.last_sequence,
    });
    assert.equal(snapshot.projection.status, "completed");
    assert.ok(snapshot.projection.timeline.some((event) => event.type === "tool.completed"));
    assert.equal(snapshot.until_sequence, completed.last_sequence);
  } finally {
    await runtime.shutdownBackgroundWork?.();
  }
}

async function contextCompaction() {
  const workspace = await createWorkspace("context-compaction");
  const runtime = await createRuntime("context-compaction", finishedModel("context-compaction"), {
    contextPolicy: {
      window_tokens: 2_048,
      reserved_output_tokens: 512,
      warning_ratio: 0.55,
      compression_ratio: 0.6,
      recent_history_messages: 4,
      history_checkpoint_tokens: 128,
      tool_budget_ratio: 0.1,
      token_estimator: "heuristic_v2",
    },
  });
  try {
    const history = Array.from({ length: 24 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `history-${index} ${"deterministic context evidence ".repeat(24)}`,
    }));
    const completed = await startAndWait(runtime, workspace, "context-compaction", {
      task: "Preserve recent evidence while compacting the deterministic history.",
      conversation_history: history,
    });
    const contextBuilt = completed.timeline.find((event) => event.type === "context.built");
    const compression = contextBuilt?.data.compression;
    assert.equal(typeof contextBuilt?.data.input_tokens, "number");
    assert.ok(compression !== null && typeof compression === "object");
    assert.notEqual(compression.applied_strategy, "none");
    assert.equal(completed.status, "completed");
  } finally {
    await runtime.shutdownBackgroundWork?.();
  }
}

async function memoryRecall() {
  const records = Array.from({ length: 128 }, (_, index) => memoryRecord(index));
  const request = { ownerId: "owner:bench-memory", projectId: "project:bench-memory" };
  const gate = evaluateMemoryRecallEligibility({ records, request, now: FIXED_NOW });
  assert.equal(gate.blocked.length, 0);
  assert.equal(gate.eligible.length, records.length);
  const hits = rankEligibleV2Memory({
    records,
    gate,
    query: "append-only event ledger",
    maxHits: 8,
    maxTokens: 256,
  });
  assert.equal(hits[0]?.attribution.memory_ref.memory_id, "memory:bench-127");
  assert.ok(hits[0]?.content.includes("append-only event ledger"));
}

async function toolExecution() {
  const workspace = await createWorkspace("tool-execution");
  const content = `TOOL_BENCHMARK_SENTINEL ${"bounded read evidence ".repeat(96)}\n`;
  await writeFile(join(workspace.real_root, "probe.txt"), content, "utf8");
  const definition = createDefaultToolRegistry().get("read_file");
  assert.ok(definition !== undefined, "read_file must be registered");
  const result = await executeToolDefinition(definition, { path: "probe.txt" }, {
    projectId: workspace.project_id,
    runId: "run:bench-tool",
    workspace,
    sandboxMode: "read-only",
  });
  assert.equal(result.status, "success");
  assert.equal(result.code, "file_read");
  assert.ok(JSON.stringify(result).includes("TOOL_BENCHMARK_SENTINEL"));
}

async function cancelQuiescence() {
  const entered = deferred();
  const workspace = await createWorkspace("cancel-quiescence");
  const model = {
    name: "bench-cancel-blocking-model",
    async decide(input) {
      entered.resolve();
      return waitForAbort(input.signal);
    },
  };
  const runtime = await createRuntime("cancel-quiescence", model);
  try {
    const started = await runtime.startRun(startInput(workspace, "cancel-quiescence"));
    await withTimeout(entered.promise, 5_000, "model dispatch did not start");
    const queued = await runtime.submitUserInput({
      type: "submit_user_input",
      command_id: "command:bench-cancel",
      input_id: "input:bench-cancel",
      project_id: started.project_id,
      run_id: started.run_id,
      kind: "cancel",
      body: "Stop the deterministic benchmark Run",
      actor: "user",
    });
    assert.equal(queued.disposition, "queued");
    const cancelled = await waitForStatus(runtime, started.run_id, "cancelled");
    assert.ok(cancelled.timeline.some((event) => event.type === "run.cancelled"));
    assert.equal(cancelled.subagents.active_count, 0);
    assert.equal(cancelled.input_queue.pending.length, 0);
  } finally {
    await runtime.shutdownBackgroundWork?.();
  }
}

async function runRecovery() {
  const workspace = await createWorkspace("run-recovery");
  const sessionRoot = join(ROOT, "run-recovery", "sessions");
  const readyPath = join(ROOT, "run-recovery", "worker-ready.json");
  await mkdir(dirname(readyPath), { recursive: true });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "recovery-worker"], {
    cwd: REPOSITORY_ROOT,
    env: process.env,
    stdio: "ignore",
    windowsHide: true,
  });
  let workerInfo;
  try {
    workerInfo = await waitForWorker(child, readyPath);
    await terminateChild(child);
  } catch (error) {
    await terminateChild(child).catch(() => undefined);
    throw error;
  }

  const store = new JsonlSessionStore(sessionRoot);
  const runtime = await createRuntime("run-recovery", finishedModel("run-recovery-resume"), {
    sessionStore: store,
  });
  try {
    const controller = new DurableSessionController({
      store,
      runtime,
      workspaceResolver: (projectId) => projectId === workspace.project_id ? workspace : undefined,
    });
    const report = await controller.recover();
    assert.ok(report.interrupted_run_ids.includes(workerInfo.run_id));
    const resumed = await runtime.resumeRun({
      sessionId: workerInfo.session_id,
      projectId: workerInfo.project_id,
      runId: workerInfo.run_id,
      commandId: "command:bench-recovery-resume",
      workspace,
    });
    assert.equal(resumed.status, "awaiting_plan_approval");
    assert.ok(resumed.pending_plan?.plan_event_id);
    await runtime.approvePlan({
      type: "approve_plan",
      command_id: "command:bench-recovery-approve",
      project_id: resumed.project_id,
      run_id: resumed.run_id,
      plan_event_id: resumed.pending_plan.plan_event_id,
    });
    const completed = await waitForStatus(runtime, resumed.run_id, "completed");
    assert.ok(completed.timeline.some((event) => event.type === "run.interrupted"));
    assert.ok(completed.timeline.some((event) => event.type === "run.resumed"));
  } finally {
    await runtime.shutdownBackgroundWork?.();
  }
}

async function runInterruptedWorker() {
  const workspace = await createWorkspace("run-recovery");
  const store = new JsonlSessionStore(join(ROOT, "run-recovery", "sessions"));
  const entered = deferred();
  const runtime = await createRuntime("run-recovery", {
    name: "bench-recovery-hanging-model",
    async decide(input) {
      if (input.mode === "plan" && !planCreated) {
        planCreated = true;
        return {
          decision_id: "decision:bench-recovery-plan",
          kind: "tool_call",
          public_reason: "Create one deterministic plan item for recovery.",
          evidence_refs: [],
          risk: "low",
          expected_effect: "Persist the benchmark plan before Host interruption.",
          tool_call: {
            action_id: "action:bench-recovery-plan-item",
            tool_name: "todo_write",
            arguments: {
              operation: "create",
              todo_id: "todo:bench-recovery",
              title: "Resume the deterministic benchmark Run",
            },
          },
        };
      }
      if (input.mode === "plan") {
        entered.resolve();
        return finishDecision("decision:bench-recovery-plan-ready");
      }
      return new Promise(() => undefined);
    },
  }, { sessionStore: store });
  let planCreated = false;
  const started = await runtime.startRun(startInput(workspace, "run-recovery", { mode: "plan" }));
  await withTimeout(entered.promise, 5_000, "recovery model dispatch did not start");
  const waiting = await waitForStatus(runtime, started.run_id, "awaiting_plan_approval");
  await waitForSessionIndex(store, waiting.session_id, waiting.timeline.length);
  await writeFile(join(ROOT, "run-recovery", "worker-ready.json"), JSON.stringify({
    project_id: waiting.project_id,
    session_id: waiting.session_id,
    run_id: waiting.run_id,
  }), { mode: 0o600, flag: "wx" });
  setInterval(() => undefined, 1_000);
}

function memoryRecord(index) {
  const claim = index === 127
    ? "The benchmark project preserves an append-only event ledger as the canonical source for durable run facts."
    : `Deterministic benchmark memory record ${index} describes an unrelated local workflow preference.`;
  return {
    schemaVersion: 2,
    memoryId: `memory:bench-${index}`,
    version: 1,
    kind: "fact",
    claim,
    status: "active",
    scope: { ownerId: "owner:bench-memory", projectId: "project:bench-memory", visibility: "private" },
    provenance: {
      origin: "fixture",
      evidenceRefs: [{ source_id: "source:bench-fixture", source_type: "user", trust: "trusted" }],
      createdBy: { type: "system", id: "system:benchmark" },
    },
    assessment: { sourceTrust: "trusted", verification: "verified" },
    validity: {
      validFrom: "2026-10-01T00:00:00.000Z",
      applicability: ["project:bench-memory"],
      invalidators: [],
    },
    governance: {
      sensitivity: "internal",
      consent: "explicit",
      retentionPolicy: "benchmark-fixture",
      allowModelUse: true,
      allowExport: false,
    },
    lineage: { supersedes: [], contradictedBy: [], derivedFrom: [] },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

async function createRuntime(name, model, overrides = {}) {
  return createAgentRuntime({
    dataDir: join(ROOT, name, "runtime-data"),
    model,
    now: () => FIXED_NOW,
    idFactory: sequentialIds(name),
    ...overrides,
  });
}

async function createWorkspace(name) {
  const workspaceRoot = join(ROOT, name, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  return createReadonlyWorkspaceHandle({
    projectId: `project:bench-${name}`,
    root: workspaceRoot,
  });
}

function startInput(workspace, name, overrides = {}) {
  return {
    command_id: `command:bench-start-${name}`,
    project_id: workspace.project_id,
    task: `Exercise deterministic ${name} path`,
    mode: "execute",
    workspace,
    ...overrides,
  };
}

async function startAndWait(runtime, workspace, name, overrides = {}) {
  const started = await runtime.startRun(startInput(workspace, name, overrides));
  return waitForStatus(runtime, started.run_id, "completed");
}

function finishedModel(name) {
  let sequence = 0;
  return {
    name: `bench-${name}-finish-model`,
    async decide() {
      sequence += 1;
      return finishDecision(`decision:${name}:${sequence}`);
    },
  };
}

function oneToolThenFinishModel(name) {
  let called = false;
  let sequence = 0;
  return {
    name: `bench-${name}-tool-model`,
    async decide() {
      sequence += 1;
      if (!called) {
        called = true;
        return {
          decision_id: `decision:${name}:${sequence}`,
          kind: "tool_call",
          public_reason: "Read the deterministic benchmark file.",
          evidence_refs: [],
          risk: "low",
          expected_effect: "Return the checked fixture contents.",
          tool_call: {
            action_id: `action:${name}:read-file`,
            tool_name: "read_file",
            arguments: { path: "probe.txt" },
          },
        };
      }
      return finishDecision(`decision:${name}:${sequence}`);
    },
  };
}

function finishDecision(decisionId) {
  return {
    decision_id: decisionId,
    kind: "finish",
    public_reason: "The deterministic benchmark path is complete.",
    evidence_refs: [],
    risk: "none",
    final_answer: "Benchmark path complete.",
  };
}

function sequentialIds(namespace) {
  let sequence = 0;
  return (prefix) => `${prefix}:bench-${namespace}-${String(++sequence).padStart(5, "0")}`;
}

async function waitForStatus(runtime, runId, expected) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const projection = await runtime.getProjection(runId);
    if (projection.status === expected) return projection;
    if (["completed", "failed", "cancelled", "interrupted"].includes(projection.status)) {
      throw new Error(`Run reached ${projection.status} while waiting for ${expected}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(`Timed out waiting for Run status ${expected}`);
}

function waitForAbort(signal) {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(signal?.reason instanceof Error ? signal.reason : new Error("Run aborted"));
    if (signal?.aborted) {
      fail();
      return;
    }
    signal?.addEventListener("abort", fail, { once: true });
  });
}

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolvePromise_) => { resolvePromise = resolvePromise_; });
  return { promise, resolve: resolvePromise };
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForWorker(child, readyPath) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(readyPath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error("recovery worker exited before writing its readiness receipt");
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
  throw new Error("recovery worker did not become ready");
}

async function waitForSessionIndex(store, sessionId, expectedEntries) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const stored = await store.readAll(sessionId);
    if (stored.entries.length >= expectedEntries) return stored;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error("session index did not catch up before the recovery worker stopped");
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await once(child, "close");
}
