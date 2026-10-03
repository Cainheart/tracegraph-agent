import { describe, expect, it } from "vitest";
import {
  PROJECTOR_VERSION,
  RunProjectionSchema,
  SCHEMA_VERSION,
  type RunProjection,
  type StartRunInput,
  type WorkspaceHandle,
} from "@tracegraph/contracts";
import {
  RunSessionController,
  RunSessionControllerError,
  type RunSessionRuntimePort,
  type RunSessionStorePort,
  type RunSessionControllerOptions,
} from "./index.js";

const workspace: WorkspaceHandle = {
  handle_id: "workspace-fixture",
  project_id: "project-one",
  real_root: "/workspace/project-one",
  workspace_kind: "readonly_local",
  capabilities: {
    index: true,
    read: true,
    search: true,
    run_command: false,
    preview_patch: false,
    commit_patch: false,
    test: false,
  },
  created_at: "2026-10-02T00:00:00.000Z",
};

const session = {
  header: {
    kind: "header" as const,
    session_version: 1 as const,
    session_id: "session-one",
    project_id: "project-one",
    created_at: "2026-10-02T00:00:00.000Z",
    run_ids: ["run-existing"],
  },
  entries: [],
  truncated: false,
};

function projection(input: { runId: string; projectId: string; status?: RunProjection["status"] }): RunProjection {
  return RunProjectionSchema.parse({
    schema_version: SCHEMA_VERSION,
    projector_version: PROJECTOR_VERSION,
    project_id: input.projectId,
    session_id: "session-one",
    run_id: input.runId,
    task: "fixture task",
    mode: "plan",
    workspace_kind: "readonly_local",
    status: input.status ?? "running",
    last_sequence: 0,
    timeline: [],
    artifact_refs: [],
  });
}

function harness(options: {
  startStatus?: RunProjection["status"];
  listedSessions?: Array<{ session_id: string; project_id: string }>;
  includeOtherProject?: boolean;
  beforeResume?:RunSessionControllerOptions["beforeResume"];
  beforeStart?:RunSessionControllerOptions["beforeStart"];
} = {}) {
  const startInputs: StartRunInput[] = [];
  const projections = new Map<string, RunProjection>();
  const resumeInputs: Array<Parameters<RunSessionStorePort["resume"]>[0]> = [];
  let sequence = 0;
  projections.set("run-existing", projection({ runId: "run-existing", projectId: "project-one" }));
  const runtime: RunSessionRuntimePort = {
    async startRun(input) {
      startInputs.push(input);
      const next = projection({
        runId: `run-${++sequence}`,
        projectId: input.project_id,
        status: options.startStatus ?? "running",
      });
      projections.set(next.run_id, next);
      return next;
    },
    async getProjection(runId) {
      const result = projections.get(runId);
      if (result === undefined) throw new Error("Run was not found");
      return result;
    },
  };
  const sessions: RunSessionStorePort = {
    async recover() { return { scanned_sessions: 0, truncated_session_ids: [], interrupted_run_ids: [], recovered_at: "2026-10-02T00:00:00.000Z" }; },
    async list() {
      return {
        sessions: (options.listedSessions ?? [{ session_id: "session-one", project_id: "project-one" }]).map((item) => ({
          session_id: item.session_id,
          project_id: item.project_id,
          created_at: "2026-10-02T00:00:00.000Z",
          updated_at: "2026-10-02T00:00:00.000Z",
          run_ids: [],
          entry_count: 0,
        })),
      };
    },
    async read(sessionId) {
      if (sessionId !== session.header.session_id) throw Object.assign(new Error("missing"), { code: "session_not_found" });
      return session;
    },
    async rename() { return session; },
    async delete(sessionId) { return { session_id: sessionId, deleted: true }; },
    async resume(input) {
      resumeInputs.push(input);
      return { session_id: "session-one", project_id: "project-one", run_id: "run-existing", status: "resumed", resumed_at: "2026-10-02T00:00:00.000Z" };
    },
  };
  const controller = new RunSessionController({
    runtime,
    sessions,
    ...(options.beforeResume?{beforeResume:options.beforeResume}:{}),
    ...(options.beforeStart?{beforeStart:options.beforeStart}:{}),
    getWorkspace: (projectId) => projectId === workspace.project_id
      ? workspace
      : options.includeOtherProject && projectId === "project-other"
        ? { ...workspace, handle_id: "workspace-other", project_id: "project-other" }
        : undefined,
    getProjectIds: () => options.includeOtherProject
      ? [workspace.project_id, "project-other"]
      : [workspace.project_id],
  });
  return { controller, startInputs, resumeInputs };
}

describe("RunSessionController in-process", () => {
  it("revalidates recovery authority after admission and releases the claim without durable resume on denial",async()=>{
    const order:string[]=[];const {controller,resumeInputs}=harness({beforeStart:async()=>{order.push("admitted");return {release:()=>{order.push("released");}};},beforeResume:async({workspace:bound,session:detail})=>{expect(bound.project_id).toBe(detail.header.project_id);order.push("policy");throw new RunSessionControllerError(409,"resume_policy_changed","Start a new Run");}});
    await expect(controller.resumeSession("session-one",{command_id:"resume:restricted"})).rejects.toMatchObject({code:"resume_policy_changed"});expect(order).toEqual(["admitted","policy","released"]);expect(resumeInputs).toEqual([]);
  });
  it("binds a registered Workspace and replays an identical command idempotently", async () => {
    const { controller, startInputs } = harness();
    const input = { command_id: "command-start-one", project_id: "project-one", task: "do work", mode: "plan" as const };
    const first = await controller.startRun(input);
    const replay = await controller.startRun(input);

    expect(replay.run_id).toBe(first.run_id);
    expect(startInputs).toHaveLength(1);
    expect(startInputs[0]?.workspace).toEqual(workspace);
  });

  it("rejects command-id collisions, unregistered projects, and Session/project mismatches", async () => {
    const { controller } = harness();
    const input = { command_id: "command-start-one", project_id: "project-one", task: "do work", mode: "plan" as const };
    await expect(controller.startRun({ ...input, command_id: "command-other", project_id: "project-missing" })).rejects.toMatchObject({
      statusCode: 404,
      code: "project_not_registered",
    });
    await controller.startRun(input);
    await expect(controller.startRun({ ...input, task: "different work" })).rejects.toMatchObject({
      statusCode: 409,
      code: "command_id_conflict",
    } satisfies Partial<RunSessionControllerError>);
  });

  it("rejects a Session that belongs to another registered project", async () => {
    const { controller } = harness({ includeOtherProject: true });
    await expect(controller.startRun({
      command_id: "command-session-mismatch",
      session_id: "session-one",
      project_id: "project-other",
      task: "do work",
      mode: "plan",
    })).rejects.toMatchObject({ statusCode: 409, code: "session_project_mismatch" });
  });

  it("serializes starts and allows only one active Run", async () => {
    const { controller, startInputs } = harness();
    const first = controller.startRun({ command_id: "command-start-one", project_id: "project-one", task: "first", mode: "plan" });
    await expect(controller.startRun({ command_id: "command-start-two", project_id: "project-one", task: "second", mode: "plan" })).rejects.toMatchObject({
      statusCode: 409,
      code: "active_run_conflict",
    });
    await first;
    expect(startInputs).toHaveLength(1);
  });

  it("resumes a scoped Session with its registered Workspace and restores the active Run guard", async () => {
    const { controller, resumeInputs } = harness();
    await expect(controller.resumeSession("session-one", { command_id: "command-resume-one" })).resolves.toMatchObject({
      session_id: "session-one",
      project_id: "project-one",
      run_id: "run-existing",
    });
    expect(resumeInputs).toEqual([{
      sessionId: "session-one",
      commandId: "command-resume-one",
      workspace,
    }]);
    await expect(controller.resumeSession("session-one", { command_id: "command-resume-one" })).resolves.toMatchObject({ run_id: "run-existing" });
    expect(resumeInputs).toHaveLength(1);
    await expect(controller.startRun({
      command_id: "command-start-after-resume",
      project_id: "project-one",
      task: "blocked while resumed run is active",
      mode: "plan",
    })).rejects.toMatchObject({ statusCode: 409, code: "active_run_conflict" });
  });

  it("keeps Session lists inside Host project scope and serves typed reads", async () => {
    const { controller } = harness({ listedSessions: [{ session_id: "session-other", project_id: "project-other" }] });
    await expect(controller.listSessions({})).rejects.toThrow(/outside the Host project scope/u);
    await expect(controller.getSession("session-one")).resolves.toMatchObject({ header: { project_id: "project-one" } });
  });
});
