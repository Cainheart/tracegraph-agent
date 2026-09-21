import { DEFAULT_TEAM_LIMITS, TeamProjectionSchema, TodoItemSchema } from "@tracegraph/contracts";
import type {
  BuiltinPermissionPresetKey,
  ExtensionStatus,
  LspServerStatus,
  LspStatusSnapshot,
  McpServerStatus,
  McpStatusSnapshot,
  SkillProjectInspection,
  ModelConfigUpdateRequest,
  ModelProvider,
  ModelProtocol,
  PermissionPresetUpdateRequest,
  PermissionSettingsResponse,
  PublicModelConfigResponse,
  SafeCredentialMetadata,
  TelemetryStatus,
  UsageSnapshot,
  TaskBoardItem,
  TodoWriteInput,
  UserInputKind,
} from "@tracegraph/contracts";
import { createDemoSnapshot } from "./demo";
import type { AttachmentPreviewContent, ContextArchiveLoadResult, PendingAttachment, ReasoningEffort, RunMode, RunStatus, WorkbenchSnapshot, WorkspaceKind } from "./model";

export interface WorkbenchClient {
  getSnapshot(): WorkbenchSnapshot;
  subscribe(listener: (snapshot: WorkbenchSnapshot) => void): () => void;
  chooseProject(kind: WorkspaceKind): Promise<void>;
  chooseProjectById(projectId: string): Promise<void>;
  openLocalProject(access?: "read_write" | "read_only"): Promise<void>;
  revealProject(projectId: string): Promise<void>;
  removeProject(projectId: string): Promise<void>;
  searchSessions(query: string): Promise<void>;
  openSession(sessionId: string): Promise<void>;
  renameSession(sessionId: string, title: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  resumeSession(sessionId: string): Promise<void>;
  returnHome(): Promise<void>;
  startRun(task: string, mode: RunMode, reasoningEffort?: ReasoningEffort, attachments?: readonly PendingAttachment[]): Promise<void>;
  startChat(task: string, reasoningEffort?: ReasoningEffort, attachments?: readonly PendingAttachment[]): Promise<void>;
  approvePlan(): Promise<void>;
  updateTodo(input: TodoWriteInput): Promise<void>;
  createTeam(): Promise<void>;
  steerTeamMember(subagentId: string, payload: string): Promise<void>;
  cancelTeamTask(task: TaskBoardItem): Promise<void>;
  submitUserInput(kind: UserInputKind, body: string): Promise<void>;
  approve(approvalId: string): Promise<void>;
  reject(approvalId: string): Promise<void>;
  stop(): Promise<void>;
  /** Lazily load the canonical child Run linked from the selected parent. */
  loadSubagent(subagentId: string): Promise<void>;
  /** Fetch verified bytes only after an explicit live-view disclosure. */
  loadAttachment(attachmentId: string): Promise<AttachmentPreviewContent>;
  enterReplay(sequence: number): Promise<void>;
  stepReplay(direction: -1 | 1): Promise<void>;
  returnToLive(): Promise<void>;
  previewState(status: RunStatus): Promise<void>;
  createProject(name: string): Promise<void>;
  loadContextArchive(runId: string, artifactId: string): Promise<ContextArchiveLoadResult>;
  getPermissionConfig(): Promise<PermissionConfigSnapshot>;
  configurePermissionPreset(input: ConfigurePermissionPresetInput): Promise<PermissionConfigSnapshot>;
  getModelConfig(): Promise<ModelConfigSnapshot>;
  configureModel(input: ConfigureModelInput): Promise<ModelConfigSnapshot>;
  getTelemetryStatus(): Promise<TelemetryStatusSnapshot>;
  getUsage(): Promise<UsageSnapshot>;
  listExtensions(): Promise<readonly ExtensionStatusSnapshot[]>;
  reloadExtension(extensionName: string): Promise<ExtensionStatusSnapshot>;
  listSkills(): Promise<readonly SkillProjectInspectionSnapshot[]>;
  getMcpStatus(): Promise<McpStatusSnapshotView>;
  restartMcpServer(serverName: string): Promise<McpServerStatusView>;
  getLspStatus(): Promise<LspStatusSnapshotView>;
}

export type PermissionConfigSnapshot = PermissionSettingsResponse;
export type ConfigurePermissionPresetInput = Pick<PermissionPresetUpdateRequest, "preset_key">;
export type ModelConfigSnapshot = PublicModelConfigResponse;
export type ConfigureModelInput = ModelConfigUpdateRequest;
export type TelemetryStatusSnapshot = TelemetryStatus;
export type UsageSnapshotSnapshot = UsageSnapshot;
export type ExtensionStatusSnapshot = ExtensionStatus;
export type SkillProjectInspectionSnapshot = SkillProjectInspection;
export type McpStatusSnapshotView = McpStatusSnapshot;
export type McpServerStatusView = McpServerStatus;
export type LspStatusSnapshotView = LspStatusSnapshot;
export type LspServerStatusView = LspServerStatus;
export type { BuiltinPermissionPresetKey, ExtensionStatus, ModelProvider, ModelProtocol, SafeCredentialMetadata, TelemetryStatus };

const DEMO_POLICY_DIGEST = `sha256:${"0".repeat(64)}`;
const DEMO_PERMISSION_OPTIONS: PermissionConfigSnapshot["available_presets"] = [
  { key: "read-only", label: "Read only", sandbox_mode: "read-only", approval_policy: "never" },
  { key: "workspace-write", label: "Workspace write", sandbox_mode: "workspace-write", approval_policy: "on-write" },
  { key: "full-write", label: "Full write", sandbox_mode: "danger-full-access", approval_policy: "never" },
];

function demoPermissionConfig(presetKey: BuiltinPermissionPresetKey): PermissionConfigSnapshot {
  const preset = DEMO_PERMISSION_OPTIONS.find(({ key }) => key === presetKey) ?? DEMO_PERMISSION_OPTIONS[1]!;
  return {
    active_preset: preset.key,
    sandbox_mode: preset.sandbox_mode,
    approval_policy: preset.approval_policy,
    policy_digest: DEMO_POLICY_DIGEST,
    ceiling: "full-write",
    available_presets: DEMO_PERMISSION_OPTIONS,
    source: "default",
    locked: false,
  };
}

/**
 * A deterministic in-browser adapter. Production can inject an HTTP/SSE client
 * implementing the same interface without changing the workbench components.
 */
export class DemoTraceGraphClient implements WorkbenchClient {
  private snapshot = createDemoSnapshot();
  private permissionConfig = demoPermissionConfig("workspace-write");
  private readonly listeners = new Set<(snapshot: WorkbenchSnapshot) => void>();

  getSnapshot(): WorkbenchSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: WorkbenchSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async chooseProject(kind: WorkspaceKind): Promise<void> {
    this.commit(createDemoSnapshot("ready", kind));
  }

  async chooseProjectById(_projectId: string): Promise<void> {
    this.commit(createDemoSnapshot("ready", "managed_local"));
  }

  async openLocalProject(_access: "read_write" | "read_only" = "read_write"): Promise<void> {
    this.commit(createDemoSnapshot("ready", "managed_local"));
  }

  async revealProject(_projectId: string): Promise<void> {}

  async removeProject(_projectId: string): Promise<void> {}
  async searchSessions(_query: string): Promise<void> {}
  async openSession(_sessionId: string): Promise<void> { throw new Error("Durable sessions are unavailable in browser demo mode"); }
  async renameSession(_sessionId: string, _title: string): Promise<void> { throw new Error("Durable sessions are unavailable in browser demo mode"); }
  async deleteSession(_sessionId: string): Promise<void> { throw new Error("Durable sessions are unavailable in browser demo mode"); }
  async resumeSession(_sessionId: string): Promise<void> { throw new Error("Durable sessions are unavailable in browser demo mode"); }

  async returnHome(): Promise<void> {
    this.commit(createDemoSnapshot("empty"));
  }

  async startRun(_task: string, mode: RunMode, _reasoningEffort: ReasoningEffort = "default", _attachments: readonly PendingAttachment[] = []): Promise<void> {
    const kind = this.snapshot.project?.workspaceKind ?? "disposable_fixture";
    if (kind === "readonly_local" && mode === "execute") {
      throw new Error("Local repositories are read-only in P0");
    }
    this.commit(createDemoSnapshot("indexing", kind, mode));
    await this.wait(420);
    if (mode === "plan") {
      this.commit(createDemoSnapshot("awaiting_plan_approval", kind, mode));
      return;
    }
    this.commit(createDemoSnapshot("running", kind, mode));
    if (kind === "disposable_fixture") {
      await this.wait(650);
      this.commit(createDemoSnapshot("needs_approval", kind, mode));
    }
  }

  async startChat(_task: string, _reasoningEffort: ReasoningEffort = "default", _attachments: readonly PendingAttachment[] = []): Promise<void> {
    this.commit(createDemoSnapshot("running", "readonly_local", "execute"));
    await this.wait(420);
    this.commit(createDemoSnapshot("completed", "readonly_local", "execute"));
  }

  async approvePlan(): Promise<void> {
    const run = this.snapshot.run;
    if (!run?.pendingPlan) throw new Error("Plan approval is no longer pending");
    const kind = this.snapshot.project?.workspaceKind ?? "disposable_fixture";
    const { pendingPlan: _pendingPlan, ...rest } = run;
    this.commit({ ...this.snapshot, run: { ...rest, mode: "execute", status: "running" } });
    await this.wait(520);
    this.commit(createDemoSnapshot(kind === "readonly_local" ? "completed" : "needs_approval", kind, "execute"));
  }

  async updateTodo(input: TodoWriteInput): Promise<void> {
    if (input.operation !== "update") throw new Error("The browser demo accepts Todo updates only");
    const run = this.snapshot.run;
    if (!run) throw new Error("No Run is selected");
    const index = run.todos.findIndex(({ todo_id: todoId }) => todoId === input.todo_id);
    if (index < 0) throw new Error("Todo is no longer available");
    const todos = run.todos.map((todo, todoIndex) => {
      if (todoIndex !== index) return todo;
      const next: Record<string, unknown> = { ...todo };
      if (input.title !== undefined) next.title = input.title;
      if (input.clear_detail === true) delete next.detail;
      else if (input.detail !== undefined) next.detail = input.detail;
      if (input.state !== undefined) next.state = input.state;
      if (input.depends_on !== undefined) next.depends_on = input.depends_on;
      if (input.evidence_event_ids !== undefined) next.evidence_event_ids = input.evidence_event_ids;
      if (input.state === "done" && todo.evidence_event_ids.length === 0 && input.evidence_event_ids === undefined) {
        const confirmationEventId = run.events.at(-1)?.id;
        if (confirmationEventId !== undefined) next.evidence_event_ids = [confirmationEventId];
      }
      return TodoItemSchema.parse(next);
    });
    this.commit({ ...this.snapshot, run: { ...run, todos } });
  }

  async createTeam(): Promise<void> {
    const run = this.snapshot.run;
    if (!run) throw new Error("No Run is selected");
    if (run.team !== undefined) throw new Error("This Run already has an Agent Team");
    const sequence = run.lastSequence + 1;
    const createdAt = new Date().toISOString();
    const eventId = `event:demo-team-created:${sequence}`;
    const team = TeamProjectionSchema.parse({
      team_id: `team:demo:${run.id}`,
      coordinator_run_id: run.id,
      limits: { ...DEFAULT_TEAM_LIMITS, max_parallel_workers: 2 },
      created_event_id: eventId,
      created_at: createdAt,
      roster: { members: [], last_sequence: 0 },
      mailbox: { messages: [], last_sequence: 0 },
      task_board: { items: [], last_sequence: 0 },
      last_sequence: sequence,
    });
    this.commit({
      ...this.snapshot,
      run: {
        ...run,
        team,
        lastSequence: sequence,
        currentStep: "Agent team created",
        events: [...run.events, {
          id: eventId,
          sequence,
          kind: "team",
          title: "Agent team created",
          summary: "A durable Team coordinator was created for this Run",
          timestamp: createdAt,
          state: "succeeded",
        }],
      },
    });
  }

  async steerTeamMember(subagentId: string, payloadValue: string): Promise<void> {
    const run = this.snapshot.run;
    const team = run?.team;
    if (!run || !team) throw new Error("No Agent Team is selected");
    const member = team.roster.members.find(({ link }) => link.subagent_id === subagentId);
    if (member?.status !== "active") throw new Error("The selected Team member is not active");
    const payload = payloadValue.trim();
    if (payload.length === 0) throw new Error("A steer message cannot be empty");
    const sequence = run.lastSequence + 1;
    const deliveredAt = new Date().toISOString();
    const messageId = `message:demo:${sequence}`;
    const nextTeam = TeamProjectionSchema.parse({
      ...team,
      mailbox: {
        messages: [...team.mailbox.messages, {
          message_id: messageId,
          from: "coordinator",
          to: subagentId,
          kind: "steer",
          payload,
          delivered_at: deliveredAt,
        }],
        last_sequence: sequence,
      },
      last_sequence: sequence,
    });
    this.commit({ ...this.snapshot, run: {
      ...run,
      team: nextTeam,
      lastSequence: sequence,
      currentStep: "Team mailbox message delivered",
      events: [...run.events, {
        id: `event:demo-team-mailbox:${sequence}`,
        sequence,
        kind: "team",
        title: "Team mailbox message delivered",
        summary: "A durable steer message was delivered",
        timestamp: deliveredAt,
        state: "succeeded",
      }],
    } });
  }

  async cancelTeamTask(task: TaskBoardItem): Promise<void> {
    const run = this.snapshot.run;
    const team = run?.team;
    if (!run || !team) throw new Error("No Agent Team is selected");
    const current = team.task_board.items.find(({ task_id: taskId }) => taskId === task.task_id);
    if (current === undefined || current.version !== task.version) throw new Error("The Team task revision changed");
    if (current.state !== "open" && current.state !== "claimed" && current.state !== "blocked") {
      throw new Error("The Team task cannot be cancelled from its current state");
    }
    const sequence = run.lastSequence + 1;
    const updatedAt = new Date().toISOString();
    const { owner: _owner, ...withoutOwner } = current;
    const nextTeam = TeamProjectionSchema.parse({
      ...team,
      task_board: {
        items: team.task_board.items.map((item) => item.task_id === current.task_id ? {
          ...withoutOwner,
          state: "cancelled",
          version: current.version + 1,
          updated_at: updatedAt,
        } : item),
        last_sequence: sequence,
      },
      last_sequence: sequence,
    });
    this.commit({ ...this.snapshot, run: {
      ...run,
      team: nextTeam,
      lastSequence: sequence,
      currentStep: "Team task cancelled",
      events: [...run.events, {
        id: `event:demo-team-task-cancelled:${sequence}`,
        sequence,
        kind: "team",
        title: "Team task cancelled",
        summary: `Cancelled shared task ${current.task_id}`,
        timestamp: updatedAt,
        state: "succeeded",
      }],
    } });
  }

  async submitUserInput(kind: UserInputKind, body: string): Promise<void> {
    const run = this.snapshot.run;
    if (!run) throw new Error("No Run is selected");
    if (["completed", "failed", "cancelled", "historical", "interrupted", "needs_manual_review"].includes(run.status)) {
      throw new Error("Steering is unavailable after the Run has stopped");
    }
    const inputId = `input_demo_${Date.now()}`;
    const submittedAt = new Date().toISOString();
    const input = { input_id: inputId, run_id: run.id, kind, body, actor: "user" as const, submitted_at: submittedAt };
    this.commit({
      ...this.snapshot,
      run: { ...run, inputQueue: { ...run.inputQueue, pending: [...run.inputQueue.pending, input] } },
    });
    await this.wait(180);
    const current = this.snapshot.run;
    if (!current || current.id !== run.id) return;
    const consumedAt = new Date().toISOString();
    const inputQueue = {
      pending: current.inputQueue.pending.filter(({ input_id: pendingId }) => pendingId !== inputId),
      lastConsumed: { input_id: inputId, kind, consumed_at: consumedAt, at_step: 1, queued_event_id: `event_${inputId}` },
    };
    this.commit({
      ...this.snapshot,
      run: { ...current, inputQueue, ...(kind === "cancel" ? { status: "cancelled" as const } : {}) },
    });
  }

  async approve(_approvalId: string): Promise<void> {
    this.commit(createDemoSnapshot("running", "disposable_fixture"));
    await this.wait(520);
    this.commit(createDemoSnapshot("ready_for_review", "disposable_fixture"));
  }

  async reject(_approvalId: string): Promise<void> {
    this.commit(createDemoSnapshot("cancelled", "disposable_fixture"));
  }

  async stop(): Promise<void> {
    await this.submitUserInput("cancel", "");
  }

  async loadSubagent(_subagentId: string): Promise<void> {
    throw new Error("Subagent child Runs are unavailable in browser demo mode");
  }

  async loadAttachment(_attachmentId: string): Promise<AttachmentPreviewContent> {
    throw new Error("Attachment content is unavailable in browser demo mode");
  }

  async enterReplay(_sequence: number): Promise<void> {
    throw new Error("Durable replay is unavailable in browser demo mode");
  }

  async stepReplay(_direction: -1 | 1): Promise<void> {
    throw new Error("Durable replay is unavailable in browser demo mode");
  }

  async returnToLive(): Promise<void> {}

  async previewState(status: RunStatus): Promise<void> {
    const kind = this.snapshot.project?.workspaceKind ?? "disposable_fixture";
    this.commit(createDemoSnapshot(status, kind));
  }

  async createProject(_name: string): Promise<void> { throw new Error("Project creation is unavailable in browser demo mode"); }
  async loadContextArchive(_runId: string, artifactId: string): Promise<ContextArchiveLoadResult> {
    return { status: "unavailable", message: `Archive ${artifactId} is unavailable in browser demo mode` };
  }
  async getPermissionConfig(): Promise<PermissionConfigSnapshot> { return this.permissionConfig; }
  async configurePermissionPreset(input: ConfigurePermissionPresetInput): Promise<PermissionConfigSnapshot> {
    this.permissionConfig = demoPermissionConfig(input.preset_key);
    return this.permissionConfig;
  }
  async getModelConfig(): Promise<ModelConfigSnapshot> { return { provider: "openai", protocol: "openai-chat-completions", configured: false, base_url: "https://api.openai.com/v1", model: "gpt-4.1-mini", has_key: false }; }
  async configureModel(_input: ConfigureModelInput): Promise<ModelConfigSnapshot> { throw new Error("Model configuration is unavailable in browser demo mode"); }
  async getTelemetryStatus(): Promise<TelemetryStatusSnapshot> {
    return {
      schema_version: "tracegraph.telemetry-status.v1",
      sink: "noop",
      state: "disabled",
      error_count: 0,
    };
  }
  async getUsage(): Promise<UsageSnapshotSnapshot> {
    return {
      schema_version: "tracegraph.usage.v1",
      generated_at: new Date().toISOString(),
      source: "unavailable",
      run_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0,
      costs: [],
    };
  }
  async listExtensions(): Promise<readonly ExtensionStatusSnapshot[]> {
    return ["@tracegraph/builtin-artifact-tools", "@tracegraph/builtin-run-state-tools"].map((name) => ({
      name,
      api_version: "tracegraph.extension.v1" as const,
      state: "active" as const,
      registration_count: name.includes("artifact") ? 2 : 6,
      generation: 1,
      updated_at: "2026-09-19T00:00:00.000Z",
    }));
  }
  async reloadExtension(extensionName: string): Promise<ExtensionStatusSnapshot> {
    const status = (await this.listExtensions()).find(({ name }) => name === extensionName);
    if (!status) throw new Error("Extension is unavailable in browser demo mode");
    return status;
  }

  async listSkills(): Promise<readonly SkillProjectInspectionSnapshot[]> {
    return [];
  }

  async getMcpStatus(): Promise<McpStatusSnapshotView> {
    return {
      config_version: "tracegraph.mcp.v1",
      servers: [],
      updated_at: new Date().toISOString(),
    };
  }

  async restartMcpServer(_serverName: string): Promise<McpServerStatusView> {
    throw new Error("MCP management is unavailable in browser demo mode");
  }

  async getLspStatus(): Promise<LspStatusSnapshotView> {
    return {
      config_version: "tracegraph.lsp.v1",
      servers: [],
      updated_at: new Date().toISOString(),
    };
  }

  private commit(snapshot: WorkbenchSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  private wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }
}
