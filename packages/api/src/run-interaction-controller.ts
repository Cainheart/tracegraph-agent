import {
  ApprovalCommandSchema, ApprovePlanCommandSchema, ApprovePlanRequestSchema,
  ArtifactWireResponseSchema, IdentifierSchema, RunProjectionSchema, StopRunCommandSchema,
  SubmitUserInputCommandSchema, SubmitUserInputRequestSchema, SubmitUserInputResultSchema,
  TodoListSchema, TodoMutationResultSchema, TodoWriteRequestSchema,
  type ApprovalCommand, type ApprovePlanCommand, type ApprovePlanRequest, type ArtifactWireResponse,
  type RunProjection, type StopRunCommand, type SubmitUserInputCommand, type SubmitUserInputRequest,
  type SubmitUserInputResult, type TodoList, type TodoMutationResult, type TodoWriteRequest,
} from "@tracegraph/contracts";
import { RunSessionController, RunSessionControllerError } from "./run-session-controller.js";

/** Existing Runtime public ports, without transport or filesystem authority. */
export interface RunInteractionRuntimePort {
  approve(command: ApprovalCommand): Promise<RunProjection>;
  reject(command: ApprovalCommand): Promise<RunProjection>;
  stop(command: StopRunCommand): Promise<RunProjection>;
  approvePlan(command: ApprovePlanCommand): Promise<RunProjection>;
  submitUserInput(command: SubmitUserInputCommand): Promise<SubmitUserInputResult>;
  readTodos(runId: string, projectId: string): Promise<TodoList>;
  writeTodo(input: TodoWriteRequest & { run_id: string; project_id: string; updated_by: "user" }): Promise<TodoMutationResult>;
  getArtifact(input: { artifactId: string; runId: string; projectId: string }): Promise<ArtifactWireResponse>;
}

/** The canonical Run, not client-selected project ids, binds every operation. */
export class RunInteractionController {
  constructor(readonly runtime: RunInteractionRuntimePort, readonly sessions: RunSessionController) {}

  async approval(commandValue: ApprovalCommand): Promise<RunProjection> {
    const command = ApprovalCommandSchema.strict().parse(commandValue);
    const current = await this.sessions.getRun(command.run_id);
    this.#assertScope(current, command.project_id);
    const value = await (command.type === "approve" ? this.runtime.approve(command) : this.runtime.reject(command));
    return this.#observe(current, value);
  }

  async stop(commandValue: StopRunCommand): Promise<RunProjection> {
    const command = StopRunCommandSchema.strict().parse(commandValue);
    const current = await this.sessions.getRun(command.run_id);
    this.#assertScope(current, command.project_id);
    return this.#observe(current, await this.runtime.stop(command));
  }

  approvePlan(runId: string, inputValue: ApprovePlanRequest): Promise<RunProjection> {
    return this.sessions.withSerializedRunOperation(async () => {
      const input = ApprovePlanRequestSchema.parse(inputValue);
      const current = await this.sessions.getRun(IdentifierSchema.parse(runId));
      await this.sessions.assertRunAdmission(current.project_id,current.session_id,current.run_id);
      const command = ApprovePlanCommandSchema.parse({ ...input, type: "approve_plan", run_id: current.run_id, project_id: current.project_id });
      const projection = this.#validateProjection(current, await this.runtime.approvePlan(command));
      this.sessions.activateRunProjection(projection);
      return projection;
    });
  }

  async submitUserInput(runId: string, inputValue: SubmitUserInputRequest): Promise<SubmitUserInputResult> {
    const input = SubmitUserInputRequestSchema.parse(inputValue);
    const current = await this.sessions.getRun(IdentifierSchema.parse(runId));
    const command = SubmitUserInputCommandSchema.parse({ ...input, type: "submit_user_input", run_id: current.run_id, project_id: current.project_id, actor: "user" });
    const result = SubmitUserInputResultSchema.parse(await this.runtime.submitUserInput(command));
    if (result.input.run_id !== current.run_id || result.input.input_id !== input.input_id || result.input.kind !== input.kind || result.input.actor !== "user") {
      throw new Error("Runtime returned a user input result with mismatched identity");
    }
    return result;
  }

  async getTodos(runId: string): Promise<TodoList> {
    const current = await this.sessions.getRun(IdentifierSchema.parse(runId));
    return TodoListSchema.parse(await this.runtime.readTodos(current.run_id, current.project_id));
  }

  async writeTodo(runId: string, inputValue: TodoWriteRequest): Promise<TodoMutationResult> {
    const input = TodoWriteRequestSchema.parse(inputValue);
    const current = await this.sessions.getRun(IdentifierSchema.parse(runId));
    const result = TodoMutationResultSchema.parse(await this.runtime.writeTodo({
      ...input, run_id: current.run_id, project_id: current.project_id, updated_by: "user",
    }));
    if (result.todo.todo_id !== input.input.todo_id) throw new Error("Runtime returned a Todo result with mismatched identity");
    return result;
  }

  async getArtifact(runId: string, artifactId: string): Promise<ArtifactWireResponse> {
    const current = await this.sessions.getRun(IdentifierSchema.parse(runId));
    const id = IdentifierSchema.parse(artifactId);
    const result = ArtifactWireResponseSchema.parse(await this.runtime.getArtifact({ runId: current.run_id, projectId: current.project_id, artifactId: id }));
    const returnedId = result.status === "available" ? result.artifact.artifact_id : result.artifact_id;
    if (returnedId !== id) throw new Error("Runtime returned an Artifact with mismatched identity");
    if (result.status === "available" && (result.artifact.run_id !== current.run_id || result.artifact.project_id !== current.project_id)) {
      throw new Error("Runtime returned an Artifact outside the authorized Run");
    }
    return result;
  }

  #assertScope(current: RunProjection, projectId: string): void {
    if (current.project_id !== projectId) throw new RunSessionControllerError(403, "run_project_mismatch", "Command project does not own this Run");
  }

  #validateProjection(current: RunProjection, value: RunProjection): RunProjection {
    const projection = RunProjectionSchema.parse(value);
    if (projection.run_id !== current.run_id || projection.project_id !== current.project_id) {
      throw new Error("Runtime returned a Run projection with mismatched identity");
    }
    return projection;
  }

  #observe(current: RunProjection, value: RunProjection): RunProjection {
    const projection = this.#validateProjection(current, value);
    this.sessions.observeRunProjection(projection);
    return projection;
  }
}
