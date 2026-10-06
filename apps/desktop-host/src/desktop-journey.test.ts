import { readFile } from "node:fs/promises";
import { fork } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentRuntime, DeterministicFakeModel, type ModelAdapter, type ModelInput } from "@tracegraph/core";
import { DecisionSchema, RunProjectionSchema, type RunProjection } from "@tracegraph/contracts";
import { FramedRpcClient } from "@tracegraph/sdk/client";
import { createFailingTypescriptFixture, createTemporaryDataDir } from "@tracegraph/test-support";
import { describe, expect, it } from "vitest";
import { createDesktopHostRuntime, type DesktopHostRuntime } from "./desktop-host.js";

function finish(answer: string, finishIntent: "answer" | "submit_plan" = "answer") {
  return DecisionSchema.parse({ decision_id: `decision:${crypto.randomUUID()}`, kind: "finish", finish_intent: finishIntent, public_reason: "Observed fixture result", evidence_refs: [], risk: "none", final_answer: answer });
}

function model(): ModelAdapter {
  const fake = new DeterministicFakeModel();
  return {
    name: "desktop-journey-fixture",
    async decide(input: ModelInput) {
      if (input.task === "UX plain conversation") {
        expect(input.toolSchemas.some((tool) => ["read_file", "search", "commit_patch", "run_test", "run_command"].includes(tool.name))).toBe(false);
        return finish("The isolated conversation is ready.");
      }
      if (input.task === "UX wait for cancel") {
        return new Promise((_resolve, reject) => {
          if (input.signal?.aborted) { reject(input.signal.reason); return; }
          input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true });
        });
      }
      if (input.task === "UX plan") {
        if (input.mode === "plan" && input.turn === 1) return DecisionSchema.parse({
          decision_id: "decision:todo", kind: "tool_call", public_reason: "Create a reviewable plan", evidence_refs: [], risk: "low", expected_effect: "Plan Todo", tool_call: { action_id: "action:todo", tool_name: "todo_write", arguments: { operation: "create", todo_id: "todo:plan", title: "Inspect before executing" } },
        });
        return finish("Plan and steering were reviewed.", input.mode === "plan" ? "submit_plan" : "answer");
      }
      return fake.decide(input);
    },
  };
}

async function connect(host: DesktopHostRuntime) {
  const clientToHost = new TransformStream<Uint8Array, Uint8Array>();
  const hostToClient = new TransformStream<Uint8Array, Uint8Array>();
  const serve = host.serve({ readable: clientToHost.readable, writable: hostToClient.writable });
  const client = new FramedRpcClient({ readable: hostToClient.readable, writable: clientToHost.writable });
  return {
    client,
    async close() { await client.close(); await serve; await host.close(); },
  };
}

async function getRun(client: FramedRpcClient, runId: string): Promise<RunProjection> {
  const result = await client.query({ operation: "run.get", run_id: runId });
  if (result.resource !== "run") throw new Error("Expected Run reply");
  return RunProjectionSchema.parse(result.value);
}

async function waitStatus(client: FramedRpcClient, runId: string, status: RunProjection["status"]): Promise<RunProjection> {
  await expect.poll(async () => (await getRun(client, runId)).status, { timeout: 15_000, interval: 30 }).toBe(status);
  return getRun(client, runId);
}

async function harness() {
  const data = await createTemporaryDataDir();
  const fixture = await createFailingTypescriptFixture(`desktop-journey-${crypto.randomUUID()}`);
  const makeHost = () => createDesktopHostRuntime({
    dataDir: data.path, projects: [{ workspace: fixture.handle }],
    createRuntime: (options) => createAgentRuntime({ ...options, model: model(), sandboxMode: "danger-full-access" }),
  });
  return { data, fixture, makeHost, async cleanup() { await fixture.cleanup(); await data.cleanup(); } };
}

async function seedKilledPlan(dataDir: string, workspace: unknown): Promise<{ runId: string; sessionId: string }> {
  const worker = fork(fileURLToPath(new URL("./recovery-seed-worker.mjs", import.meta.url)), [], {
    execArgv: ["--import", "tsx"], env: Object.fromEntries(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
    stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "json",
  });
  worker.stderr?.resume();
  const exited = new Promise<void>((resolve) => { worker.once("exit", () => resolve()); });
  try {
    const seeded = await new Promise<{ runId: string; sessionId: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Plan seed timed out")), 20_000);
      worker.on("message", (message: unknown) => {
        if (typeof message !== "object" || message === null) return;
        const value = message as Record<string, unknown>;
        if (value.kind === "seeded") { clearTimeout(timer); resolve({ runId: String(value.run_id), sessionId: String(value.session_id) }); }
        if (value.kind === "seed_error") { clearTimeout(timer); reject(new Error(String(value.message))); }
      });
      worker.once("error", (error) => { clearTimeout(timer); reject(error); });
      worker.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Plan seed exited early: ${String(code)}`)); });
      worker.once("spawn", () => worker.send({ dataDir, workspace, mode: "plan" }));
    });
    return seeded;
  } finally { worker.kill("SIGKILL"); await exited; }
}

describe("Desktop private RPC real Runtime journeys", { timeout: 45_000 }, () => {
  it("reviews, rejects and approves a real patch; persists Todo/input; reads scoped diff/test artifacts", async () => {
    const h = await harness();
    const connection = await connect(await h.makeHost());
    try {
      const { client } = connection;
      const start = async (commandId: string) => {
        const result = await client.command({ type: "start_run", command_id: commandId, input: { command_id: commandId, project_id: h.fixture.handle.project_id, task: "Fix the fixture arithmetic", mode: "execute" } });
        if (result.resource !== "run") throw new Error("Expected Run start");
        return waitStatus(client, result.value.run_id, "awaiting_approval");
      };
      const rejected = await start("command:reject-start");
      const pendingRejected = rejected.pending_approval!;
      const rejectedReply = await client.command({ type: "reject", command_id: "command:reject", project_id: rejected.project_id, run_id: rejected.run_id, approval_id: pendingRejected.approval_id, action_id: pendingRejected.action_id, reason: "Inspect first" });
      expect(rejectedReply.resource).toBe("run");
      expect(await readFile(join(h.fixture.handle.real_root, "src/add.ts"), "utf8")).toContain("return left - right;");

      const waiting = await start("command:approve-start");
      const todoInput = { command_id: "command:todo", input: { operation: "create" as const, todo_id: "todo:user-review", title: "Confirm the registered fixture tests" } };
      const todo = await client.command({ type: "todo.write", run_id: waiting.run_id, input: todoInput });
      expect(todo.resource).toBe("todo_mutation");
      await expect(client.command({ type: "todo.write", run_id: waiting.run_id, input: todoInput })).resolves.toEqual(todo);
      const todos = await client.query({ operation: "todo.list", run_id: waiting.run_id });
      expect(todos).toMatchObject({ resource: "todos", value: { items: [{ todo_id: "todo:user-review", created_by: "user" }] } });
      const steering = { command_id: "command:steer", input_id: "input:steer", kind: "message" as const, body: "Check the registered test receipt" };
      await expect(client.command({ type: "run.input", run_id: waiting.run_id, input: steering })).resolves.toMatchObject({ resource: "user_input", value: { disposition: "queued", input: { actor: "user" } } });
      await expect(client.command({ type: "run.input", run_id: waiting.run_id, input: steering })).resolves.toMatchObject({ value: { disposition: "duplicate" } });
      await expect(client.command({ type: "approve", command_id: "command:forged", project_id: "project:forged", run_id: waiting.run_id, approval_id: waiting.pending_approval!.approval_id, action_id: waiting.pending_approval!.action_id })).rejects.toMatchObject({ protocolError: { code: "forbidden" } });
      expect(await readFile(join(h.fixture.handle.real_root, "src/add.ts"), "utf8")).toContain("return left - right;");
      const diff = waiting.artifact_refs.find((ref) => ref.kind === "patch_preview");
      expect(diff).toBeDefined();
      const diffReply = await client.query({ operation: "artifact.get", run_id: waiting.run_id, artifact_id: diff!.artifact_id });
      expect(diffReply).toMatchObject({ resource: "artifact", value: { status: "available", content: expect.stringContaining("return left + right;") } });
      await expect(client.query({ operation: "artifact.get", run_id: rejected.run_id, artifact_id: diff!.artifact_id })).resolves.toMatchObject({ resource: "artifact", value: { status: "unavailable", reason: "out_of_scope" } });
      const pending = waiting.pending_approval!;
      await client.command({ type: "approve", command_id: "command:approve", project_id: waiting.project_id, run_id: waiting.run_id, approval_id: pending.approval_id, action_id: pending.action_id });
      const completed = await waitStatus(client, waiting.run_id, "completed");
      expect(await readFile(join(h.fixture.handle.real_root, "src/add.ts"), "utf8")).toContain("return left + right;");
      expect(completed.timeline.some((event) => event.type === "test.completed")).toBe(true);
      expect(completed.timeline.some((event) => event.type === "user.input_consumed")).toBe(true);
      const testLog = completed.artifact_refs.find((ref) => ref.kind === "test_log");
      expect(testLog).toBeDefined();
      await expect(client.query({ operation: "artifact.get", run_id: completed.run_id, artifact_id: testLog!.artifact_id })).resolves.toMatchObject({ resource: "artifact", value: { status: "available" } });
    } finally { await connection.close(); await h.cleanup(); }
  });

  it("recovers a killed Host and explicitly resumes its Session then approves its exact plan revision", async () => {
    const h = await harness();
    const seeded = await seedKilledPlan(h.data.path, h.fixture.handle);
    const recoveredHost = await h.makeHost();
    const connection = await connect(recoveredHost);
    try {
      expect(recoveredHost.sessionRecovery.interrupted_run_ids).toContain(seeded.runId);
      const waiting = await getRun(connection.client, seeded.runId);
      expect(waiting.status).toBe("interrupted");
      await connection.client.command({ type: "session.rename", session_id: waiting.session_id!, input: { title: "Recovered review plan" } }).catch((error) => { throw new Error("Session rename failed", { cause: error }); });
      const session = await connection.client.query({ operation: "session.get", session_id: waiting.session_id! });
      expect(session).toMatchObject({ resource: "session", value: { header: { title: "Recovered review plan" } } });
      await expect(connection.client.command({ type: "session.resume", session_id: waiting.session_id!, input: { command_id: "command:resume" } }).catch((error) => { throw new Error("Session resume failed", { cause: error }); })).resolves.toMatchObject({ resource: "session_resume", value: { run_id: waiting.run_id, status: "awaiting_plan_approval" } });
      await expect(connection.client.command({ type: "session.resume", session_id: waiting.session_id!, input: { command_id: "command:resume" } })).resolves.toMatchObject({ resource: "session_resume", value: { run_id: waiting.run_id } });
      const restored = await getRun(connection.client, waiting.run_id);
      expect(restored.status).toBe("awaiting_plan_approval");
      expect(restored.todos.items).toEqual(expect.arrayContaining([expect.objectContaining({ todo_id: "todo:plan", title: "Inspect before executing" })]));
      expect(restored.timeline.find((event) => event.event_id === restored.pending_plan!.plan_event_id)).toMatchObject({ type: "plan.ready", data: { todo_ids: ["todo:plan"] } });
      await connection.client.command({ type: "run.input", run_id: waiting.run_id, input: { command_id: "command:plan-steer", input_id: "input:plan-steer", kind: "message", body: "Read evidence before finishing" } });
      await expect(connection.client.command({ type: "run.approve_plan", run_id: waiting.run_id, input: { command_id: "command:stale-plan", plan_event_id: "event:stale" } })).rejects.toMatchObject({ protocolError: { code: "conflict" } });
      await connection.client.command({ type: "run.approve_plan", run_id: waiting.run_id, input: { command_id: "command:approve-plan", plan_event_id: restored.pending_plan!.plan_event_id } });
      const completed = await waitStatus(connection.client, waiting.run_id, "completed");
      expect(completed.timeline.some((event) => event.type === "plan.approved")).toBe(true);
      expect(completed.timeline.some((event) => event.type === "user.input_consumed")).toBe(true);
    } finally { await connection.close(); await h.cleanup(); }
  });

  it("runs isolated plain chat, deletes its Session, and durably cancels active work", async () => {
    const h = await harness();
    const host = await h.makeHost();
    const connection = await connect(host);
    try {
      expect(host.native.listProjects().some((project) => project.project_id === "chat:desktop")).toBe(false);
      const chat = await connection.client.command({ type: "chat.start", input: { command_id: "command:chat", task: "UX plain conversation" } });
      if (chat.resource !== "run") throw new Error("Expected chat Run");
      const completed = await waitStatus(connection.client, chat.value.run_id, "completed");
      expect(completed.project_id).toBe("chat:desktop");
      await expect.poll(async () => {
        try { return await connection.client.command({ type: "session.delete", session_id: completed.session_id! }); }
        catch (error) {
          if ((error as { protocolError?: { code?: string } }).protocolError?.code === "conflict") return undefined;
          throw error;
        }
      }).toMatchObject({ resource: "session_delete", value: { deleted: true } });
      const blocked = await connection.client.command({ type: "start_run", command_id: "command:cancel-start", input: { command_id: "command:cancel-start", project_id: h.fixture.handle.project_id, task: "UX wait for cancel", mode: "execute" } });
      if (blocked.resource !== "run") throw new Error("Expected blocked Run");
      await waitStatus(connection.client, blocked.value.run_id, "running");
      await expect(connection.client.command({ type: "session.delete", session_id: blocked.value.session_id! })).rejects.toMatchObject({ protocolError: { code: "conflict" } });
      await connection.client.command({ type: "run.input", run_id: blocked.value.run_id, input: { command_id: "command:cancel", input_id: "input:cancel", kind: "cancel", body: "Stop this test Run" } });
      const cancelled = await waitStatus(connection.client, blocked.value.run_id, "cancelled");
      expect(cancelled.timeline.some((event) => event.type === "user.input_queued")).toBe(true);
      const second = await connection.client.command({ type: "start_run", command_id: "command:stop-start", input: { command_id: "command:stop-start", project_id: h.fixture.handle.project_id, task: "UX wait for cancel", mode: "execute" } });
      if (second.resource !== "run") throw new Error("Expected second blocked Run");
      await waitStatus(connection.client, second.value.run_id, "running");
      await connection.client.command({ type: "stop", command_id: "command:stop", run_id: second.value.run_id, project_id: second.value.project_id });
      await waitStatus(connection.client, second.value.run_id, "cancelled");
    } finally { await connection.close(); await h.cleanup(); }
  });
});
