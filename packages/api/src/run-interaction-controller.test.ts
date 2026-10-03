import { PROJECTOR_VERSION, RunProjectionSchema, SCHEMA_VERSION } from "@tracegraph/contracts";
import { describe, expect, it, vi } from "vitest";
import { RunInteractionController, type RunInteractionRuntimePort, RunSessionController } from "./index.js";

const current = RunProjectionSchema.parse({
  schema_version: SCHEMA_VERSION, projector_version: PROJECTOR_VERSION, project_id: "project:one",
  session_id: "session:one", run_id: "run:one", task: "Inspect", mode: "execute", workspace_kind: "readonly_local",
  status: "running", last_sequence: 0, timeline: [], artifact_refs: [],
});
const approval = { type: "approve" as const, command_id: "command:approval", project_id: current.project_id, run_id: current.run_id, approval_id: "approval:one", action_id: "action:one" };

function harness() {
  const sessions = {
    getRun: vi.fn(async () => current),
    getActiveRunProjection: vi.fn(async () => undefined),
    assertRunAdmission:vi.fn(async()=>undefined),
    observeRunProjection: vi.fn(), activateRunProjection: vi.fn(),
    withSerializedRunOperation: <T>(operation: () => Promise<T>) => operation(),
  } as unknown as RunSessionController;
  const runtime = {
    approve: vi.fn(async () => current), reject: vi.fn(async () => current), stop: vi.fn(async () => current), approvePlan: vi.fn(async () => current),
    submitUserInput: vi.fn(async (command) => ({
      input: { input_id: command.input_id, run_id: command.run_id, kind: command.kind, body: command.body, actor: command.actor, submitted_at: "2026-10-03T00:00:00.000Z" }, disposition: "queued" as const,
    })),
    readTodos: vi.fn(async () => ({ items: [], last_sequence: 0 })),
    writeTodo: vi.fn(async () => ({ todo: { todo_id: "todo:one", title: "Inspect", state: "pending" as const, depends_on: [], evidence_event_ids: [], created_by: "user" as const }, event_type: "todo.created" as const, event_id: "event:one", last_sequence: 1 })),
    getArtifact: vi.fn(async ({ artifactId }) => ({ status: "unavailable" as const, artifact_id: artifactId, reason: "not_found" as const })),
  } satisfies RunInteractionRuntimePort;
  return { sessions, runtime, controller: new RunInteractionController(runtime, sessions) };
}

describe("Run interaction controller authority and business replies", () => {
  it("rejects a command project that does not own the canonical Run before dispatch", async () => {
    const h = harness();
    await expect(h.controller.approval({ ...approval, project_id: "project:other" })).rejects.toMatchObject({ statusCode: 403 });
    await expect(h.controller.stop({ type: "stop", command_id: "command:stop", run_id: current.run_id, project_id: "project:other" })).rejects.toMatchObject({ statusCode: 403 });
    expect(h.runtime.approve).not.toHaveBeenCalled();
    expect(h.runtime.stop).not.toHaveBeenCalled();
  });

  it("derives user input authority and rejects actor/project overrides", async () => {
    const h = harness();
    const input = { command_id: "command:input", input_id: "input:one", kind: "message" as const, body: "Check tests first" };
    await h.controller.submitUserInput(current.run_id, input);
    expect(h.runtime.submitUserInput).toHaveBeenCalledWith({ ...input, type: "submit_user_input", run_id: current.run_id, project_id: current.project_id, actor: "user" });
    await expect(h.controller.submitUserInput(current.run_id, { ...input, actor: "parent_agent" } as never)).rejects.toThrow();
    await expect(h.controller.submitUserInput(current.run_id, { ...input, project_id: "project:other" } as never)).rejects.toThrow();
    expect(h.runtime.submitUserInput).toHaveBeenCalledTimes(1);
  });

  it("binds Todo and Artifact operations to the Run's registered project", async () => {
    const h = harness();
    await h.controller.getTodos(current.run_id);
    expect(h.runtime.readTodos).toHaveBeenCalledWith(current.run_id, current.project_id);
    const input = { command_id: "command:todo", input: { operation: "create" as const, todo_id: "todo:one", title: "Inspect" } };
    await h.controller.writeTodo(current.run_id, input);
    expect(h.runtime.writeTodo).toHaveBeenCalledWith({ ...input, run_id: current.run_id, project_id: current.project_id, updated_by: "user" });
    await expect(h.controller.getArtifact(current.run_id, "artifact:one")).resolves.toMatchObject({ status: "unavailable" });
    expect(h.runtime.getArtifact).toHaveBeenCalledWith({ runId: current.run_id, projectId: current.project_id, artifactId: "artifact:one" });
  });

  it("rejects successful-looking replies with a different Run, input, Todo or Artifact identity", async () => {
    const h = harness();
    h.runtime.approve.mockResolvedValue({ ...current, run_id: "run:other" });
    await expect(h.controller.approval(approval)).rejects.toThrow("mismatched identity");
    h.runtime.submitUserInput.mockResolvedValue({ input: { input_id: "input:other", run_id: current.run_id, kind: "message", body: "Inspect", actor: "user", submitted_at: "2026-10-03T00:00:00.000Z" }, disposition: "queued" });
    await expect(h.controller.submitUserInput(current.run_id, { command_id: "command:input", input_id: "input:one", kind: "message", body: "Inspect" })).rejects.toThrow("mismatched identity");
    h.runtime.getArtifact.mockResolvedValue({ status: "unavailable", artifact_id: "artifact:other", reason: "not_found" });
    await expect(h.controller.getArtifact(current.run_id, "artifact:one")).rejects.toThrow("mismatched identity");
    await expect(h.controller.writeTodo(current.run_id, { command_id: "command:todo", input: { operation: "create", todo_id: "todo:other", title: "Inspect" } })).rejects.toThrow("mismatched identity");
  });

  it("prevents approving a paused plan while another Run owns admission", async () => {
    const h = harness();
    vi.mocked(h.sessions.assertRunAdmission).mockRejectedValue(Object.assign(new Error("Admission occupied"),{statusCode:409}));
    await expect(h.controller.approvePlan(current.run_id, { command_id: "command:plan", plan_event_id: "event:plan" })).rejects.toMatchObject({ statusCode: 409 });
    expect(h.runtime.approvePlan).not.toHaveBeenCalled();
  });

  it("cannot dispatch when canonical Run scope has been revoked", async () => {
    const h = harness();
    vi.mocked(h.sessions.getRun).mockRejectedValue(Object.assign(new Error("unregistered"), { statusCode: 404 }));
    await expect(h.controller.approval(approval)).rejects.toMatchObject({ statusCode: 404 });
    await expect(h.controller.writeTodo(current.run_id, { command_id: "command:todo", input: { operation: "create", todo_id: "todo:one", title: "Inspect" } })).rejects.toMatchObject({ statusCode: 404 });
    await expect(h.controller.getArtifact(current.run_id, "artifact:one")).rejects.toMatchObject({ statusCode: 404 });
    expect(h.runtime.approve).not.toHaveBeenCalled(); expect(h.runtime.writeTodo).not.toHaveBeenCalled(); expect(h.runtime.getArtifact).not.toHaveBeenCalled();
  });
});
