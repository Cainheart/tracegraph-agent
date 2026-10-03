#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DISPOSABLE_FIXTURE_CAPABILITIES, WorkspaceHandleSchema } from "../packages/contracts/dist/index.js";
import {
  ActionWal, buildLegacyCapsule, createAgentRuntime, DurableSessionController, JsonlEventLedger,
  JsonlSessionStore, verifyLegacyCapsule,
} from "../packages/core/dist/index.js";

const self = fileURLToPath(import.meta.url);
const fixedNow = () => new Date("2026-10-03T00:00:00.000Z");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });

export async function runProofs(output) {
  if (process.platform === "win32") throw new Error("The process-group proof requires POSIX; Windows is unsupported, not skipped as passed");
  const root = output === undefined ? await mkdtemp(join(tmpdir(), "outlive-public-proofs-")) : resolve(output);
  if (output !== undefined) await mkdir(root, { recursive: false, mode: 0o700 });
  const results = [];
  for (const [id, run] of [["DEMO-080", recovery], ["DEMO-081", memoryLineage], ["DEMO-082", cancellation]]) {
    const directory = join(root, id);
    await mkdir(directory, { mode: 0o700 });
    results.push({ task_id: id, ...await run(directory) });
  }
  const report = {
    schema_version: "tracegraph.public-proofs.v1", recorded_at: new Date().toISOString(),
    platform: process.platform, arch: process.arch, node: process.version,
    fixture_boundary: "offline scripted decisions, synthetic public content, real Runtime/files/processes; no provider quality claim",
    results,
  };
  await json(join(root, "report.json"), report);
  const files = await hashTree(root);
  await writeFile(join(root, "SHA256SUMS"), files.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n") + "\n");
  return { root, report };
}

async function recovery(root) {
  const workspace = await workspaceAt(root, "recovery");
  await mkdir(join(workspace.real_root, "src"));
  const sourcePath = join(workspace.real_root, "src/add.ts");
  await writeFile(sourcePath, "export function add(left, right) { return left - right; }\n");
  const dataDir = join(root, "data");
  await json(join(root, "worker-input.json"), { workspace, dataDir });
  const child = spawn(process.execPath, [self, "--recovery-worker", root], { stdio: ["ignore", "pipe", "pipe"], env: safeEnvironment() });
  let errorText = "";
  child.stderr.on("data", (chunk) => { errorText += chunk.toString(); });
  const exited = new Promise((done, reject) => { child.once("error", reject); child.once("exit", (code, signal) => done({ code, signal })); });
  let info;
  try {
    info = await eventually(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Recovery worker exited too early: ${errorText}`);
      try { return JSON.parse(await readFile(join(root, "crash-ready.json"), "utf8")); }
      catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
    }, "worker never reached the WAL crash boundary");
    const atCrash = await readFile(sourcePath, "utf8");
    assert.match(atCrash, /left \+ right/u);
    const crashWal = await new ActionWal(join(dataDir, "wal")).list(info.run_id);
    assert.equal(crashWal.at(-1).phase, "prepare");
    await json(join(root, "wal-at-crash.json"), crashWal);
    child.kill("SIGKILL");
    const exit = await exited;
    assert.equal(exit.signal, "SIGKILL");
    assert.equal(alive(child.pid), false);
    const store = new JsonlSessionStore(join(dataDir, "sessions"));
    const runtime = await createAgentRuntime({ dataDir, sessionStore: store, model: finishingModel("restart"), sandboxMode: "danger-full-access" });
    try {
      const before = await runtime.getProjection(info.run_id);
      const controller = new DurableSessionController({ store, runtime, workspaceResolver: (id) => id === workspace.project_id ? workspace : undefined });
      const recovered = await controller.recover();
      const locator = { projectId: info.project_id, sessionId: info.session_id, runId: info.run_id, workspace };
      await runtime.reconcileActions(locator);
      const after = await runtime.getProjection(info.run_id);
      assert.equal(after.timeline.filter((event) => event.type === "patch.applied").length, 1);
      assert.equal(after.timeline.filter((event) => event.type === "action.verified").length, 1);
      assert.ok(after.timeline.some((event) => event.type === "action.reconciled"));
      assert.ok(after.timeline.some((event) => event.type === "run.interrupted"));
      assert.equal(await readFile(sourcePath, "utf8"), atCrash);
      const finalWal = await new ActionWal(join(dataDir, "wal")).list(info.run_id);
      assert.equal(finalWal.at(-1).phase, "verified");
      await json(join(root, "wal-after-reconcile.json"), finalWal);
      const count = after.timeline.length;
      await runtime.reconcileActions(locator);
      assert.equal((await runtime.getProjection(info.run_id)).timeline.length, count);
      assert.equal(await readFile(sourcePath, "utf8"), atCrash);
      assert.deepEqual(after.timeline.map((event) => event.sequence), after.timeline.map((_, index) => index + 1));
      await json(join(root, "before-recovery.json"), before);
      await json(join(root, "after-recovery.json"), after);
      const receipt = { status: "passed", child_pid: child.pid, exit, crash_point: "after_apply_before_applied", recovery: recovered, mutation_sha256_at_crash: digest(atCrash), mutation_sha256_after_repeated_reconcile: digest(await readFile(sourcePath)), patch_applied_events: 1, verified_events: 1, repeated_reconcile_added_events: 0, child_absent: true };
      await json(join(root, "oracle.json"), receipt);
      return receipt;
    } finally { await runtime.shutdownBackgroundWork(); }
  } finally { if (alive(child.pid)) { child.kill("SIGKILL"); await exited; } }
}

async function recoveryWorker(root) {
  const { workspace, dataDir } = JSON.parse(await readFile(join(root, "worker-input.json"), "utf8"));
  const store = new JsonlSessionStore(join(dataDir, "sessions"));
  let info;
  const model = {
    name: "public-proof-preview",
    async decide() { return toolDecision("preview", "preview_patch", { path: "src/add.ts", expected: "return left - right;", replacement: "return left + right;" }); },
  };
  const runtime = await createAgentRuntime({ dataDir, sessionStore: store, model, sandboxMode: "danger-full-access", async actionCommitFaultInjector(point) {
    if (point !== "after_apply_before_applied") return;
    await json(join(root, "crash-ready.json"), info);
    await new Promise(() => { setInterval(() => undefined, 1_000); });
  } });
  const started = await runtime.startRun(startInput(workspace, "recovery"));
  const waiting = await waitStatus(runtime, started.run_id, "awaiting_approval");
  info = { project_id: waiting.project_id, session_id: waiting.session_id, run_id: waiting.run_id };
  await eventually(async () => (await store.readAll(waiting.session_id)).entries.length >= waiting.timeline.length ? true : undefined, "session index did not catch up");
  await runtime.approve({ type: "approve", command_id: "command:proof:approve", ...info, approval_id: waiting.pending_approval.approval_id, action_id: waiting.pending_approval.action_id });
  throw new Error("Recovery worker unexpectedly crossed the deliberate crash boundary");
}

async function memoryLineage(root) {
  const workspace = await workspaceAt(root, "memory");
  const dataDir = join(root, "data");
  const contexts = [];
  const ledger = new JsonlEventLedger(join(dataDir, "events"));
  const runtime = await createAgentRuntime({ dataDir, ledger, now: fixedNow, memoryControlOwnerId: "owner:public-proof", v2MemoryRecallEnabled: true,
    model: { name: "public-proof-memory", async decide(input) { contexts.push({ run_id: input.runId, manifest: input.contextManifest, context: input.context }); return finishDecision(`memory-${contexts.length}`); } },
  });
  const scope = { allowedScopeIds: [workspace.project_id] };
  try {
    const original = await runtime.createMemoryCandidate({ command_id: "command:proof:memory-source", kind: "fact", project_id: workspace.project_id, claim: "The public demonstration service port is 4310.", normalized_key: "public demonstration service port", sensitivity: "public", allow_model_use: true, allow_export: true, source_description: "Synthetic user-authored fact for the executable public demonstration." }, scope);
    const originalActive = await runtime.reviewMemory(original.record.memoryId, { command_id: "command:proof:memory-review", expected_sequence: 0, action: "review_activate" }, scope);
    const first = await recallRun(runtime, workspace, "original");
    assert.ok(contexts.at(-1).context.includes(original.record.claim));
    assertMemoryUse(first, original.record.memoryId);
    const exportInput = capsuleInput(originalActive.record);
    const capsule = buildLegacyCapsule(exportInput);
    const verified = verifyLegacyCapsule(capsule.files);
    assert.equal(verified.memories[0].claim, original.record.claim);
    for (const [path, body] of Object.entries(capsule.files)) { await mkdir(dirname(join(root, "capsule", path)), { recursive: true }); await writeFile(join(root, "capsule", path), body); }
    const correction = await runtime.correctMemory(original.record.memoryId, { command_id: "command:proof:memory-correct", expected_sequence: 1, claim: "The public demonstration service port is 4311.", allow_export: true }, scope);
    assert.deepEqual(correction.record.lineage.supersedes, [original.record.memoryId]);
    const active = await runtime.reviewMemory(correction.record.memoryId, { command_id: "command:proof:correction-review", expected_sequence: 0, action: "review_activate" }, scope);
    const second = await recallRun(runtime, workspace, "corrected");
    assert.ok(contexts.at(-1).context.includes(active.record.claim));
    assert.ok(!contexts.at(-1).context.includes(original.record.claim));
    assertMemoryUse(second, active.record.memoryId);
    assert.equal(active.record.governance.allowExport, true);
    const correctedCapsule = buildLegacyCapsule({ ...capsuleInput(active.record), capsuleId: "capsule:public-proof-corrected" });
    assert.equal(verifyLegacyCapsule(correctedCapsule.files).memories[0].claim, active.record.claim);
    for (const [path, body] of Object.entries(correctedCapsule.files)) { await mkdir(dirname(join(root, "corrected-capsule", path)), { recursive: true }); await writeFile(join(root, "corrected-capsule", path), body); }
    const revoked = await runtime.revokeMemory(active.record.memoryId, { command_id: "command:proof:memory-revoke", expected_sequence: 1 }, scope);
    const third = await recallRun(runtime, workspace, "revoked");
    assert.ok(!contexts.at(-1).context.includes(active.record.claim));
    assert.ok(!contexts.at(-1).context.includes(original.record.claim));
    assert.equal(third.timeline.filter((event) => event.type === "memory.use_status").length, 0);
    assert.throws(() => buildLegacyCapsule(capsuleInput(revoked.record)), (error) => error.code === "legacy_capsule_item_not_exportable");
    const final = await runtime.listMemoryControl(scope);
    assert.ok(final.items.find((item) => item.record.memoryId === active.record.memoryId).memoryUseRequests.length > 0);
    await json(join(root, "lineage.json"), { original, correction, final, export_before_revoke: verified.manifest, exported_copy_revocation: "Local revocation cannot retract a previously exported external copy" });
    await json(join(root, "model-requests.json"), contexts);
    await json(join(root, "run-projections.json"), [first, second, third]);
    const receipt = { status: "passed", source_memory_id: original.record.memoryId, corrected_memory_id: active.record.memoryId, capsule_digest: verified.capsuleDigest, corrected_capsule_digest: verifyLegacyCapsule(correctedCapsule.files).capsuleDigest, original_recalled: true, correction_recalled: true, superseded_excluded: true, revoked_excluded: true, revoked_export_rejected: true, retained_external_copy_warning: true };
    await json(join(root, "oracle.json"), receipt);
    return receipt;
  } finally { await runtime.shutdownBackgroundWork(); }
}

async function cancellation(root) {
  const workspace = await workspaceAt(root, "cancel");
  await mkdir(join(workspace.real_root, "test"));
  await writeFile(join(workspace.real_root, "test/run.mjs"), [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "process.on('SIGTERM', () => {});",
    "const child = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`], { stdio: 'ignore' });",
    "writeFileSync('processes.json', JSON.stringify({ leader: process.pid, descendant: child.pid }));",
    "setInterval(() => {}, 1000);", "",
  ].join("\n"));
  let dispatches = 0;
  const runtime = await createAgentRuntime({ dataDir: join(root, "data"), sandboxMode: "danger-full-access", model: {
    name: "public-proof-cancel", async decide() { dispatches++; return toolDecision("cancel-test", "run_test", { suite: "fixture" }); },
  } });
  let pids;
  try {
    const started = await runtime.startRun(startInput(workspace, "cancel"));
    pids = await eventually(async () => { try { return JSON.parse(await readFile(join(workspace.real_root, "processes.json"), "utf8")); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; } }, "run_test did not spawn its process group");
    assert.equal(alive(pids.leader), true);
    assert.equal(alive(pids.descendant), true);
    await runtime.submitUserInput({ type: "submit_user_input", command_id: "command:proof:request-cancel", input_id: "input:proof:cancel", project_id: started.project_id, run_id: started.run_id, kind: "cancel", body: "Stop the public demonstration and all child work.", actor: "user" });
    const cancelled = await waitStatus(runtime, started.run_id, "cancelled");
    assert.equal(alive(pids.leader), false);
    assert.equal(alive(pids.descendant), false);
    assert.equal(alive(-pids.leader), false);
    assert.equal(dispatches, 1);
    assert.equal(cancelled.input_queue.pending.length, 0);
    assert.equal(cancelled.subagents.active_count, 0);
    assert.ok(cancelled.timeline.some((event) => event.type === "tool.started"));
    assert.ok(cancelled.timeline.some((event) => event.type === "run.cancelled"));
    assert.ok(cancelled.timeline.some((event) => event.type === "user.input_consumed"));
    await json(join(root, "projection.json"), cancelled);
    const receipt = { status: "passed", ...pids, leader_absent: true, descendant_absent: true, process_group_absent: true, model_dispatches: dispatches, pending_inputs: 0, active_subagents: 0, events: cancelled.timeline.map(({ sequence, type, summary }) => ({ sequence, type, summary })) };
    await json(join(root, "oracle.json"), receipt);
    return receipt;
  } finally { if (pids && alive(-pids.leader)) process.kill(-pids.leader, "SIGKILL"); await runtime.shutdownBackgroundWork(); }
}

function assertMemoryUse(projection, memoryId) {
  const events = projection.timeline.filter((event) => event.type === "memory.use_status");
  assert.deepEqual(events.map((event) => event.data.stage), ["dispatch_intent", "adapter_invoked", "response"]);
  assert.equal(events[0].data.memory_items[0].memory_ref.memory_id, memoryId);
}
async function recallRun(runtime, workspace, name) {
  const started = await runtime.startRun({ ...startInput(workspace, `memory-${name}`), task: "What is the public demonstration service port?" });
  return waitStatus(runtime, started.run_id, "completed");
}
function capsuleInput(record) {
  return { capsuleId: "capsule:public-proof", createdAt: fixedNow().toISOString(), sourceInstanceId: "instance:public-proof",
    principals: { contentCreator: { id: "user:public-proof" }, exportOperator: { id: "user:public-proof" }, describedSubject: { id: "subject:synthetic" }, authorizedBy: { id: "user:public-proof" } },
    consent: { consentedBy: "user:public-proof", consentedAt: fixedNow().toISOString(), purpose: "Export this selected synthetic demonstration fact.", externalCopyWarningAcknowledged: true },
    memories: [record], selectedMemoryIds: [record.memoryId], experiences: [], selectedExperienceCaseIds: [] };
}
async function workspaceAt(root, name) {
  const path = join(root, "workspace"); await mkdir(path);
  return WorkspaceHandleSchema.parse({ handle_id: `workspace:proof-${name}`, project_id: `project:proof-${name}`, real_root: await realpath(path), workspace_kind: "disposable_fixture", capabilities: DISPOSABLE_FIXTURE_CAPABILITIES, created_at: fixedNow().toISOString() });
}
function startInput(workspace, name) { return { command_id: `command:proof:${name}`, project_id: workspace.project_id, task: `Execute the controlled ${name} public proof.`, mode: "execute", workspace }; }
function finishDecision(name) { return { decision_id: `decision:proof:${name}`, kind: "finish", public_reason: "The controlled proof request completed.", evidence_refs: [], risk: "none", final_answer: "Controlled proof request completed." }; }
function finishingModel(name) { return { name: "public-proof-finish", async decide() { return finishDecision(name); } }; }
function toolDecision(name, tool, args) { return { decision_id: `decision:proof:${name}`, kind: "tool_call", public_reason: "Execute the controlled public proof action.", evidence_refs: [], risk: tool === "preview_patch" ? "high" : "low", tool_call: { action_id: `action:proof:${name}`, tool_name: tool, arguments: args } }; }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } }
function safeEnvironment() { return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|API_KEY|NODE_OPTIONS|TRACEGRAPH_/u.test(key))); }
async function eventually(read, label) { const deadline = Date.now() + 20_000; while (Date.now() < deadline) { const value = await read(); if (value !== undefined) return value; await sleep(15); } throw new Error(label); }
async function waitStatus(runtime, runId, status) { return eventually(async () => { const projection = await runtime.getProjection(runId); if (projection.status === status) return projection; if (["failed", "cancelled", "completed", "needs_manual_review"].includes(projection.status)) throw new Error(`Expected ${status}, got ${projection.status}: ${projection.failure_code}`); return undefined; }, `Run never reached ${status}`); }
async function hashTree(root, prefix = "") { const result = []; for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) { const path = join(prefix, entry.name); if (entry.isDirectory()) result.push(...await hashTree(root, path)); else if (entry.isFile()) result.push({ path, sha256: digest(await readFile(join(root, path))) }); else throw new Error("Evidence must contain only files and directories"); } return result; }

if (resolve(process.argv[1] ?? "") === self) {
  if (process.argv[2] === "--recovery-worker") await recoveryWorker(resolve(process.argv[3]));
  else {
    if (process.argv.length > 4 || (process.argv[2] !== undefined && process.argv[2] !== "--output")) throw new Error("Usage: node demos/proofs.mjs [--output NEW_DIRECTORY]");
    const result = await runProofs(process.argv[3]);
    process.stdout.write(`Public proofs passed: ${result.root}\n`);
  }
}
