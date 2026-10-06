import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DecisionSchema, type RunProjection } from "@tracegraph/contracts";
import type { ModelAdapter } from "../../kernel/types.js";
import { createManagedWorkspaceHandle } from "../../kernel/workspace.js";
import { sha256 } from "../../kernel/crypto.js";
import { NativeSandboxRunner } from "../../seams/sandbox/runner.js";
import { createEffectivePermissionPolicy, CORE_BUILTIN_PERMISSION_PRESETS } from "../tools/policy-engine.js";
import { createAgentRuntime, type AgentRuntime } from "./runtime.js";

const roots: string[] = [];
const runtimes: AgentRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdownBackgroundWork?.())); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("project commands through canonical Runtime boundaries", () => {
  it("discovers and executes a real project command with canonical receipts, scoped output Artifact, and read-only replay", async () => {
    const harness = await fixture("success");
    let modelCalls = 0;
    let selected: { command: string; path: string; manifest_sha256: string } | undefined;
    const runtime = await tracked({ dataDir: harness.dataDir, permissionPolicy: fullAccessPolicy(), model: { name: "real-command-model", async decide(input) {
      modelCalls += 1;
      if (modelCalls === 1) return call("discover_project_commands", { path: "." });
      if (modelCalls === 2) {
        selected = input.observations.at(-1)?.facts.commands as unknown as typeof selected;
        selected = Array.isArray(selected) ? selected[0] : undefined;
        if (!selected) throw new Error("Discovered command evidence was not available to the model");
        return call("run_project_command", { path: selected.path, command: selected.command, expected_manifest_sha256: selected.manifest_sha256, timeout_ms: 3_000 });
      }
      expect(input.observations.at(-1)?.facts).toMatchObject({ exit_code: 0, code: "project_command_passed", started: true, evidence_event_id: expect.any(String) });
      return answer();
    } } });
    const started = await runtime.startRun({ command_id: "command:start-success", project_id: harness.workspace.project_id, workspace: harness.workspace, task: "Build this existing project", mode: "execute" });
    const completed = await wait(runtime, started.run_id, "completed");
    expect(await readFile(join(harness.workspace.real_root, "built.txt"), "utf8")).toBe("REAL_BUILD_BYTES");
    const processStart = completed.timeline.find((event) => event.type === "tool.started" && event.data.tool_name === "run_project_command")!;
    const result = completed.timeline.find((event) => event.type === "tool.completed" && event.action_id === processStart.action_id)!;
    expect(processStart.operation_id).toBe(processStart.action_id);
    expect(result.sequence).toBeGreaterThan(processStart.sequence);
    expect(result.data.receipt).toMatchObject({ action_id: processStart.action_id, tool_name: "run_project_command", transport_status: "success", business_status: "success", code: "project_command_passed" });
    const ref = result.artifact_refs[0]!;
    const artifact = await runtime.getArtifact({ artifactId: ref.artifact_id, projectId: completed.project_id, runId: completed.run_id });
    expect(artifact).toMatchObject({ status: "available", content: expect.stringContaining("ACTUAL_STDOUT") });
    const wrongScope = await runtime.getArtifact({ artifactId: ref.artifact_id, projectId: "project:outside", runId: completed.run_id });
    expect(wrongScope.status).not.toBe("available");
    expect((await runtime.replay(completed.run_id)).timeline).toEqual(completed.timeline);
    expect(modelCalls).toBe(3);
    expect(await readFile(join(harness.workspace.real_root, "built.txt"), "utf8")).toBe("REAL_BUILD_BYTES");
  });

  it("allows command discovery in Plan but blocks actual command dispatch before any process", async () => {
    const harness = await fixture("plan-deny");
    let calls = 0;
    const hash = sha256(await readFile(join(harness.workspace.real_root, "outlive.commands.json")));
    const runtime = await tracked({ dataDir: harness.dataDir, permissionPolicy: fullAccessPolicy(), model: { name: "plan-command-deny", async decide() { return ++calls === 1 ? call("discover_project_commands", { path: "." }) : call("run_project_command", { path: "outlive.commands.json", command: "build", expected_manifest_sha256: hash }); } } });
    const started = await runtime.startRun({ command_id: "command:start-plan-deny", project_id: harness.workspace.project_id, workspace: harness.workspace, task: "Inspect proposed build commands", mode: "plan" });
    const failed = await wait(runtime, started.run_id, "failed");
    expect(failed.failure_code).toBe("plan_mode_denied");
    expect(failed.timeline.filter((event) => event.type === "tool.started").map((event) => event.data.tool_name)).toEqual(["discover_project_commands"]);
    await expect(stat(join(harness.workspace.real_root, "built.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects command execution under a read-only capability independently of the full access preset", async () => {
    const harness = await fixture("cap-deny");
    const runtime = await tracked({ dataDir: harness.dataDir, permissionPolicy: fullAccessPolicy(), model: { name: "cap-deny-model", async decide() { return call("run_project_command", { path: "outlive.commands.json", command: "build", expected_manifest_sha256: sha256(await readFile(join(harness.workspace.real_root, "outlive.commands.json"))) }); } } });
    const workspace = { ...harness.workspace, capabilities: { ...harness.workspace.capabilities, run_command: false } };
    const started = await runtime.startRun({ command_id: "command:start-cap-deny", project_id: workspace.project_id, workspace, task: "Do not grant command authority", mode: "execute" });
    const failed = await wait(runtime, started.run_id, "failed");
    expect(failed.failure_code).toBe("capability_denied");
    expect(failed.timeline.some(({ type }) => type === "tool.started")).toBe(false);
    await expect(stat(join(harness.workspace.real_root, "built.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves unknown external effects and never issues another model or command attempt", async () => {
    const harness = await fixture("unknown");
    const native = new NativeSandboxRunner();
    let dispatches = 0;
    let modelCalls = 0;
    const runtime = await tracked({ dataDir: harness.dataDir, permissionPolicy: fullAccessPolicy(), sandboxRunner: { probe: (request) => native.probe(request), async run() { dispatches += 1; await writeFile(join(harness.workspace.real_root, "built.txt"), "UNKNOWN_WRITE"); throw new Error("result lost"); } }, model: { name: "unknown-model", async decide() { modelCalls += 1; return call("run_project_command", { path: "outlive.commands.json", command: "build", expected_manifest_sha256: sha256(await readFile(join(harness.workspace.real_root, "outlive.commands.json"))) }); } } });
    const started = await runtime.startRun({ command_id: "command:start-unknown", project_id: harness.workspace.project_id, workspace: harness.workspace, task: "Execute at most one operation", mode: "execute" });
    const failed = await wait(runtime, started.run_id, "failed");
    expect(failed.failure_code).toBe("unknown_side_effect");
    expect(failed.timeline.find(({ type }) => type === "tool.unknown")?.data.receipt).toMatchObject({ status: "unknown", business_status: "unknown", code: "command_outcome_unknown" });
    expect(dispatches).toBe(1);
    expect(modelCalls).toBe(1);
    expect(await readFile(join(harness.workspace.real_root, "built.txt"), "utf8")).toBe("UNKNOWN_WRITE");
    await runtime.replay(failed.run_id);
    expect(dispatches).toBe(1);
  });

  it("retains a manifest CAS failure as a no-start command receipt rather than reporting process success", async () => {
    const harness = await fixture("changed");
    const runtime = await tracked({ dataDir: harness.dataDir, permissionPolicy: fullAccessPolicy(), model: { name: "changed-model", async decide() { return call("run_project_command", { path: "outlive.commands.json", command: "build", expected_manifest_sha256: sha256("different manifest") }); } } });
    const started = await runtime.startRun({ command_id: "command:start-changed", project_id: harness.workspace.project_id, workspace: harness.workspace, task: "Do not execute a stale command", mode: "execute" });
    const failed = await wait(runtime, started.run_id, "failed");
    expect(failed.failure_code).toBe("command_manifest_changed");
    expect(failed.timeline.find(({ type }) => type === "tool.failed")?.data.observation).toMatchObject({ facts: { started: false, automatic_retry_allowed: false } });
    await expect(stat(join(harness.workspace.real_root, "built.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `outlive-command-runtime-${name}-`)); roots.push(root);
  const workspaceRoot = join(root, "project"); await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "build.mjs"), "import {writeFileSync} from 'node:fs'; writeFileSync('built.txt','REAL_BUILD_BYTES'); console.log('ACTUAL_STDOUT');");
  await writeFile(join(workspaceRoot, "outlive.commands.json"), JSON.stringify({ version: 1, commands: { build: { executable: "node", args: ["build.mjs"] } } }));
  return { dataDir: join(root, "data"), workspace: await createManagedWorkspaceHandle({ projectId: `project:${name}`, root: workspaceRoot }) };
}
function fullAccessPolicy() { return createEffectivePermissionPolicy({ preset: CORE_BUILTIN_PERMISSION_PRESETS["full-write"] }); }
async function tracked(options: Parameters<typeof createAgentRuntime>[0]) { const runtime = await createAgentRuntime(options); runtimes.push(runtime); return runtime; }
function call(tool_name: string, arguments_: Record<string, unknown>) { return DecisionSchema.parse({ decision_id: `decision:${tool_name}`, kind: "tool_call", public_reason: "Run the checked project operation", evidence_refs: [], risk: "low", tool_call: { action_id: `action:${tool_name}`, tool_name, arguments: arguments_ } }); }
function answer() { return DecisionSchema.parse({ decision_id: "decision:answer", kind: "finish", finish_intent: "answer", public_reason: "The actual command result is recorded", evidence_refs: [], risk: "none", final_answer: "The build command succeeded; this does not prove all software requirements are complete." }); }
async function wait(runtime: AgentRuntime, runId: string, status: RunProjection["status"]) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) { const projection = await runtime.getProjection(runId); if (projection.status === status) return projection; await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error(`Expected ${status}, got ${(await runtime.getProjection(runId)).status}`);
}
