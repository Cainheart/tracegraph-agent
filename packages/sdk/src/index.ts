import {
  ApprovalCommandSchema,
  ApprovePlanRequestSchema,
  AttachmentMediaTypeSchema,
  AttachmentStageReceiptSchema,
  AttachmentUploadRequestSchema,
  ArtifactWireResponseSchema,
  ExtensionCommandInvocationSchema,
  ExtensionCommandResultSchema,
  ExtensionReloadCommandSchema,
  ExtensionStatusSchema,
  LivePublicActivitySchema,
  MCP_SERVER_NAME_SCHEMA,
  McpRestartRequestSchema,
  McpServerStatusSchema,
  McpStatusSnapshotSchema,
  LspStatusSnapshotSchema,
  ModelConfigUpdateRequestSchema,
  ModelSurfaceEventSchema,
  OpenLocalProjectRequestSchema,
  PermissionPresetUpdateRequestSchema,
  PermissionSettingsResponseSchema,
  ProjectSummarySchema,
  PublicModelConfigResponseSchema,
  RemoveProjectRequestSchema,
  ReplayDiffQuerySchema,
  ReplayDiffSchema,
  ReplaySessionResponseSchema,
  ReplaySnapshotRequestSchema,
  RollbackActionRequestSchema,
  RunProjectionSchema,
  SessionDeleteResponseSchema,
  SessionListQuerySchema,
  SessionListResponseSchema,
  SessionReadResultSchema,
  SessionRecoveryReportSchema,
  SessionRenameRequestSchema,
  SessionResumeRequestSchema,
  SessionResumeResponseSchema,
  SkillProjectInspectionSchema,
  StartRunRequestSchema,
  StartChatRequestSchema,
  StopRunCommandSchema,
  SubmitUserInputRequestSchema,
  SubmitUserInputResultSchema,
  CreateTeamRequestSchema,
  TeamHeartbeatRequestSchema,
  TeamMailboxClaimRequestSchema,
  TeamMailboxSendRequestSchema,
  TeamMutationResultSchema,
  TeamReadResponseSchema,
  TeamSweepLostMembersRequestSchema,
  TeamTaskWriteRequestSchema,
  TelemetryStatusSchema,
  TodoListSchema,
  TodoMutationResultSchema,
  TodoWriteRequestSchema,
  WireSessionEventSchema,
  type ApprovalCommand,
  type ApprovePlanRequest,
  type AttachmentMediaType,
  type AttachmentStageReceipt,
  type AttachmentUploadRequest,
  type ArtifactWireResponse,
  type ExtensionCommandResult,
  type ExtensionStatus,
  type LivePublicActivity,
  type McpRestartRequest,
  type McpServerStatus,
  type McpStatusSnapshot,
  type LspStatusSnapshot,
  type ModelConfigUpdateRequest,
  type ModelSurfaceEvent,
  type OpenLocalProjectRequest,
  type PermissionPresetUpdateRequest,
  type PermissionSettingsResponse,
  type ProjectSummary,
  type PublicModelConfigResponse,
  type ReplayDiff,
  type ReplaySessionResponse,
  type ReplaySnapshotRequest,
  type RollbackActionRequest,
  type RunProjection,
  type SessionDeleteResponse,
  type SessionListQuery,
  type SessionListResponse,
  type SessionReadResult,
  type SessionRecoveryReport,
  type SessionRenameRequest,
  type SessionResumeRequest,
  type SessionResumeResponse,
  type StartRunRequest,
  type StartChatRequest,
  type StopRunCommand,
  type SubmitUserInputRequest,
  type SubmitUserInputResult,
  type CreateTeamRequest,
  type TeamHeartbeatRequest,
  type TeamMailboxClaimRequest,
  type TeamMailboxSendRequest,
  type TeamMutationResult,
  type TeamReadResponse,
  type TeamSweepLostMembersRequest,
  type TeamTaskWriteRequest,
  type TelemetryStatus,
  type TodoList,
  type TodoMutationResult,
  type TodoWriteInput,
  type TodoWriteRequest,
  type WireSessionEvent,
  type SkillProjectInspection,
} from "@tracegraph/contracts";

export type {
  LivePublicActivity,
  ModelProvider,
  ModelProtocol,
  ModelSurfaceEvent,
  ReasoningEffort,
  ReplayDiff,
  ReplaySessionResponse,
  ReplaySnapshotRequest,
  SafeCredentialMetadata,
  SessionDeleteResponse,
  SessionListQuery,
  SessionListResponse,
  SessionReadResult,
  SessionRecoveryReport,
  SessionRenameRequest,
  SessionResumeRequest,
  SessionResumeResponse,
  TodoList,
  TodoMutationResult,
  TodoWriteInput,
  TodoWriteRequest,
  SubmitUserInputRequest,
  SubmitUserInputResult,
  CreateTeamRequest,
  TeamHeartbeatRequest,
  TeamMailboxClaimRequest,
  TeamMailboxSendRequest,
  TeamMutationResult,
  TeamReadResponse,
  TeamSweepLostMembersRequest,
  TeamTaskWriteRequest,
  TelemetryStatus,
  ExtensionCommandResult,
  ExtensionStatus,
  McpRestartRequest,
  McpServerStatus,
  McpStatusSnapshot,
  LspStatusSnapshot,
} from "@tracegraph/contracts";

export interface TraceGraphClientOptions {
  baseUrl?: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
  /**
   * Origin sent by the Node client to the loopback Host. Browsers manage their
   * own Origin header and ignore this option. Set false for a non-Host fetch
   * adapter; custom Host origins must also be present in Host allowedOrigins.
   */
  nodeOrigin?: string | false;
}

export interface StreamOptions {
  afterSequence?: number;
  signal?: AbortSignal;
  reconnect?: boolean;
  minRetryMs?: number;
  maxRetryMs?: number;
}

/** Cursor options for the volatile, model-authored public text stream. */
export interface ModelSurfaceStreamOptions {
  afterCursor?: number;
  signal?: AbortSignal;
  reconnect?: boolean;
  minRetryMs?: number;
  maxRetryMs?: number;
}

export type ModelConfigSnapshot = PublicModelConfigResponse;
export type ConfigureModelInput = ModelConfigUpdateRequest;
export type PermissionConfigSnapshot = PermissionSettingsResponse;
export type ConfigurePermissionPresetInput = PermissionPresetUpdateRequest;
export type TelemetryStatusSnapshot = TelemetryStatus;
export type ExtensionStatusSnapshot = ExtensionStatus;
export type ExtensionCommandResultSnapshot = ExtensionCommandResult;
export type SkillProjectInspectionSnapshot = SkillProjectInspection;
export type McpStatusSnapshotResponse = McpStatusSnapshot;
export type McpServerStatusSnapshot = McpServerStatus;
export type LspStatusSnapshotResponse = LspStatusSnapshot;

type ProjectAttachmentUpload = Extract<AttachmentUploadRequest, { target: "project" }>;
type ChatAttachmentUpload = Extract<AttachmentUploadRequest, { target: "chat" }>;

export type UploadAttachmentInput = (
  | Omit<ProjectAttachmentUpload, "command_id">
  | Omit<ChatAttachmentUpload, "command_id">
) & {
  command_id?: string;
  /** Reusable bytes only; streaming bodies cannot be safely retried after a 401. */
  bytes: Blob | ArrayBuffer | Uint8Array;
};

export interface AttachmentContentResponse {
  attachmentId: string;
  mediaType: AttachmentMediaType;
  sha256: `sha256:${string}`;
  bytes: Uint8Array;
}

export interface ReplayDiffInput {
  from: number;
  to: number;
}

export interface BootstrapSnapshot {
  token: string;
  expiresAt: string;
  recovery?: SessionRecoveryReport;
}

export class TraceGraphHttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "TraceGraphHttpError";
    this.status = status;
    this.body = body;
  }
}

const normalizeBaseUrl = (value: string): string => value.replace(/\/$/, "");
const DEFAULT_NODE_ORIGIN = "http://127.0.0.1:4310";

const createCommandId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `cmd_${Date.now()}_${Math.random().toString(16).slice(2)}`;
};

const createInputId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `input_${globalThis.crypto.randomUUID()}`;
  }
  return `input_${Date.now()}_${Math.random().toString(16).slice(2)}`;
};

export class TraceGraphClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #nodeOrigin: string | undefined;
  #token: string | undefined;
  #tokenRefresh: Promise<void> | null = null;
  #liveTokenBeforeReplay: string | undefined;
  #replayScope: { sessionId: string; runId: string } | undefined;
  #replayGeneration = 0;

  constructor(options: TraceGraphClientOptions = {}) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl ?? "http://127.0.0.1:4311");
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#nodeOrigin = isBrowserRuntime() || options.nodeOrigin === false
      ? undefined
      : normalizeOrigin(options.nodeOrigin ?? DEFAULT_NODE_ORIGIN);
    this.#token = options.token;
  }

  get token(): string | undefined {
    return this.#token;
  }

  get replayActive(): boolean {
    return this.#replayScope !== undefined;
  }

  async bootstrap(): Promise<BootstrapSnapshot> {
    if (this.#replayScope !== undefined) {
      throw new Error("Exit replay before refreshing the live Host capability");
    }
    const value = await this.#requestUnknown("/api/bootstrap", { method: "GET" }, false);
    if (
      typeof value !== "object" ||
      value === null ||
      !("token" in value) ||
      typeof value.token !== "string" ||
      !("expiresAt" in value) ||
      typeof value.expiresAt !== "string"
    ) {
      throw new TypeError("Invalid bootstrap response");
    }
    const recovery = "recovery" in value && value.recovery !== undefined
      ? SessionRecoveryReportSchema.parse(value.recovery)
      : undefined;
    this.#token = value.token;
    return {
      token: value.token,
      expiresAt: value.expiresAt,
      ...(recovery === undefined ? {} : { recovery }),
    };
  }

  async listProjects(): Promise<readonly ProjectSummary[]> {
    return ProjectSummarySchema.array().parse(
      await this.#requestUnknown("/api/projects"),
    );
  }

  async createProject(input: { name: string; template?: "typescript" }): Promise<ProjectSummary> {
    return ProjectSummarySchema.parse(await this.#command("/api/projects", {
      name: input.name,
      template: input.template ?? "typescript",
    }));
  }

  async openLocalProject(input: {
    access?: OpenLocalProjectRequest["access"];
    command_id?: string;
  } = {}): Promise<ProjectSummary | undefined> {
    const body = OpenLocalProjectRequestSchema.parse({
      command_id: input.command_id ?? createCommandId(),
      access: input.access ?? "read_write",
    });
    const response = await this.#command("/api/projects/open-local", body);
    return response === undefined ? undefined : ProjectSummarySchema.parse(response);
  }

  async revealProject(projectId: string, commandId = createCommandId()): Promise<void> {
    await this.#command(`/api/projects/${encodeURIComponent(projectId)}/reveal`, {
      command_id: commandId,
    });
  }

  async removeProject(projectId: string, commandId = createCommandId()): Promise<void> {
    const body = RemoveProjectRequestSchema.parse({ command_id: commandId });
    await this.#command(`/api/projects/${encodeURIComponent(projectId)}/remove`, body);
  }

  async getModelConfig(): Promise<ModelConfigSnapshot> {
    return PublicModelConfigResponseSchema.parse(
      await this.#requestUnknown("/api/model-config"),
    );
  }

  async configureModel(input: ConfigureModelInput): Promise<ModelConfigSnapshot> {
    const body = ModelConfigUpdateRequestSchema.parse(input);
    return PublicModelConfigResponseSchema.parse(
      await this.#command("/api/model-config", body),
    );
  }

  async getPermissionConfig(): Promise<PermissionConfigSnapshot> {
    return PermissionSettingsResponseSchema.parse(
      await this.#requestUnknown("/api/permission-config"),
    );
  }

  async getTelemetryStatus(): Promise<TelemetryStatusSnapshot> {
    return TelemetryStatusSchema.parse(
      await this.#requestUnknown("/api/telemetry-status"),
    );
  }

  async listExtensions(): Promise<readonly ExtensionStatusSnapshot[]> {
    return ExtensionStatusSchema.array().max(64).parse(
      await this.#requestUnknown("/api/extensions"),
    );
  }

  async listSkills(): Promise<readonly SkillProjectInspectionSnapshot[]> {
    return SkillProjectInspectionSchema.array().max(256).parse(
      await this.#requestUnknown("/api/skills"),
    );
  }

  async getMcpStatus(): Promise<McpStatusSnapshotResponse> {
    return McpStatusSnapshotSchema.parse(
      await this.#requestUnknown("/api/mcp"),
    );
  }

  async getLspStatus(): Promise<LspStatusSnapshotResponse> {
    return LspStatusSnapshotSchema.parse(
      await this.#requestUnknown("/api/lsp"),
    );
  }

  async restartMcpServer(
    serverName: string,
    input: { command_id?: string } = {},
  ): Promise<McpServerStatusSnapshot> {
    const parsedServerName = MCP_SERVER_NAME_SCHEMA.parse(serverName);
    const body = McpRestartRequestSchema.parse({
      command_id: input.command_id ?? createCommandId(),
    });
    return McpServerStatusSchema.parse(
      await this.#command(`/api/mcp/restart/${encodeURIComponent(parsedServerName)}`, body),
    );
  }

  async reloadExtension(
    extensionName: string,
    input: { command_id?: string; expected_config_digest?: `sha256:${string}` } = {},
  ): Promise<ExtensionStatusSnapshot> {
    const body = ExtensionReloadCommandSchema.parse({
      command_id: input.command_id ?? createCommandId(),
      extension_name: extensionName,
      ...(input.expected_config_digest === undefined
        ? {}
        : { expected_config_digest: input.expected_config_digest }),
    });
    return ExtensionStatusSchema.parse(
      await this.#command("/api/extensions/reload", body),
    );
  }

  async runExtensionCommand(
    name: string,
    input: { command_id?: string; args?: readonly string[] } = {},
  ): Promise<ExtensionCommandResultSnapshot> {
    const body = ExtensionCommandInvocationSchema.parse({
      command_id: input.command_id ?? createCommandId(),
      name,
      args: input.args ?? [],
    });
    return ExtensionCommandResultSchema.parse(
      await this.#command(`/api/extensions/commands/${encodeURIComponent(name)}`, body),
    );
  }

  async configurePermissionPreset(
    input: Omit<ConfigurePermissionPresetInput, "command_id"> & { command_id?: string },
  ): Promise<PermissionConfigSnapshot> {
    const body = PermissionPresetUpdateRequestSchema.parse({
      ...input,
      command_id: input.command_id ?? createCommandId(),
    });
    return PermissionSettingsResponseSchema.parse(
      await this.#command("/api/permission-config", body),
    );
  }

  async listSessions(input: Partial<SessionListQuery> = {}): Promise<SessionListResponse> {
    const query = SessionListQuerySchema.parse(input);
    const search = new URLSearchParams({ limit: String(query.limit) });
    search.set("view", query.view);
    if (query.project_id !== undefined) search.set("project_id", query.project_id);
    if (query.q !== undefined) search.set("q", query.q);
    if (query.cursor !== undefined) search.set("cursor", query.cursor);
    return SessionListResponseSchema.parse(
      await this.#requestUnknown(`/api/sessions?${search.toString()}`),
    );
  }

  async getSession(sessionId: string): Promise<SessionReadResult> {
    return SessionReadResultSchema.parse(
      await this.#requestUnknown(`/api/sessions/${encodeURIComponent(sessionId)}`),
    );
  }

  /**
   * Enter or step within a Host-authorized historical view. The returned
   * replay bearer replaces the current transport authority, so an accidental
   * call to any ordinary mutation is rejected by the Host rather than merely
   * disabled by the UI.
   */
  async createReplay(input: ReplaySnapshotRequest): Promise<ReplaySessionResponse> {
    const body = ReplaySnapshotRequestSchema.parse(input);
    const generation = ++this.#replayGeneration;
    const startedInReplay = this.#replayScope !== undefined;
    const responseValue = await this.#requestUnknown("/api/replay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, true, !startedInReplay);
    if (generation !== this.#replayGeneration) {
      throw new Error("Replay request was superseded by a newer authority transition");
    }
    const response = ReplaySessionResponseSchema.parse(responseValue);
    if (this.#replayScope === undefined) this.#liveTokenBeforeReplay = this.#token;
    this.#token = response.replay_token;
    this.#replayScope = {
      sessionId: response.snapshot.session_id,
      runId: response.snapshot.run_id,
    };
    return response;
  }

  async getReplayDiff(input: ReplayDiffInput): Promise<ReplayDiff> {
    const scope = this.#replayScope;
    if (scope === undefined) throw new Error("Create a replay before requesting its diff");
    const query = ReplayDiffQuerySchema.parse({
      session_id: scope.sessionId,
      run_id: scope.runId,
      from: input.from,
      to: input.to,
    });
    const search = new URLSearchParams({
      session_id: query.session_id,
      run_id: query.run_id,
      from: String(query.from),
      to: String(query.to),
    });
    return ReplayDiffSchema.parse(
      await this.#requestUnknown(`/api/replay/diff?${search.toString()}`),
    );
  }

  /** Restore the live bearer retained before createReplay. No domain write is performed. */
  exitReplay(): void {
    // Invalidate an in-flight create/step even if its response has not yet set
    // replayScope. A late Host response must never reverse an explicit exit.
    this.#replayGeneration += 1;
    if (this.#replayScope === undefined) return;
    this.#token = this.#liveTokenBeforeReplay;
    this.#liveTokenBeforeReplay = undefined;
    this.#replayScope = undefined;
  }

  async renameSession(sessionId: string, input: SessionRenameRequest): Promise<SessionReadResult> {
    const body = SessionRenameRequestSchema.parse(input);
    return SessionReadResultSchema.parse(
      await this.#mutation(`/api/sessions/${encodeURIComponent(sessionId)}`, "PATCH", body),
    );
  }

  async deleteSession(sessionId: string): Promise<SessionDeleteResponse> {
    return SessionDeleteResponseSchema.parse(
      await this.#mutation(`/api/sessions/${encodeURIComponent(sessionId)}`, "DELETE"),
    );
  }

  async resumeSession(
    sessionId: string,
    input: Partial<SessionResumeRequest> = {},
  ): Promise<SessionResumeResponse> {
    const body = SessionResumeRequestSchema.parse({
      command_id: input.command_id ?? createCommandId(),
    });
    return SessionResumeResponseSchema.parse(
      await this.#mutation(`/api/sessions/${encodeURIComponent(sessionId)}/resume`, "POST", body),
    );
  }

  async startRun(input: StartRunRequest): Promise<RunProjection> {
    const body = StartRunRequestSchema.parse(input);
    return RunProjectionSchema.parse(
      await this.#command("/api/runs", body),
    );
  }

  async startChat(input: StartChatRequest): Promise<RunProjection> {
    const body = StartChatRequestSchema.parse(input);
    return RunProjectionSchema.parse(
      await this.#command("/api/chat/runs", body),
    );
  }

  /** Stage raw attachment bytes and receive an opaque, scope-bound upload id. */
  async uploadAttachment(input: UploadAttachmentInput): Promise<AttachmentStageReceipt> {
    const { bytes, ...metadata } = input;
    const body = AttachmentUploadRequestSchema.parse({
      ...metadata,
      command_id: input.command_id ?? createCommandId(),
    });
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined) query.set(key, value);
    }
    const response = await this.#requestResponse(`/api/attachments?${query.toString()}`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-tracegraph-command-id": body.command_id,
      },
      body: attachmentBody(bytes),
    });
    return AttachmentStageReceiptSchema.parse(await response.json());
  }

  async approvePlan(
    runId: string,
    input: Omit<ApprovePlanRequest, "command_id"> & { command_id?: string },
  ): Promise<RunProjection> {
    const body = ApprovePlanRequestSchema.parse({
      ...input,
      command_id: input.command_id ?? createCommandId(),
    });
    return RunProjectionSchema.parse(
      await this.#command(`/api/runs/${encodeURIComponent(runId)}/plan/approve`, body),
    );
  }

  async getTodos(runId: string): Promise<TodoList> {
    return TodoListSchema.parse(
      await this.#requestUnknown(`/api/runs/${encodeURIComponent(runId)}/todos`),
    );
  }

  async writeTodo(
    runId: string,
    request: Omit<TodoWriteRequest, "command_id"> & { command_id?: string },
  ): Promise<TodoMutationResult> {
    const body = TodoWriteRequestSchema.parse({
      command_id: request.command_id ?? createCommandId(),
      input: request.input,
    });
    return TodoMutationResultSchema.parse(
      await this.#command(`/api/runs/${encodeURIComponent(runId)}/todos`, body),
    );
  }

  /**
   * Durably enqueue a user steering input for an in-flight Run. Project and
   * actor authority are deliberately absent from this browser-safe request;
   * the loopback Host binds both before handing the command to Runtime.
   */
  async submitUserInput(
    runId: string,
    request: Omit<SubmitUserInputRequest, "command_id" | "input_id"> & {
      command_id?: string;
      input_id?: string;
    },
  ): Promise<SubmitUserInputResult> {
    const body = SubmitUserInputRequestSchema.parse({
      ...request,
      command_id: request.command_id ?? createCommandId(),
      input_id: request.input_id ?? createInputId(),
    });
    return SubmitUserInputResultSchema.parse(
      await this.#command(`/api/runs/${encodeURIComponent(runId)}/input`, body),
    );
  }

  async approve(runId: string, command: ApprovalCommand): Promise<RunProjection> {
    const body = ApprovalCommandSchema.parse(command);
    return RunProjectionSchema.parse(
      await this.#command(`/api/runs/${encodeURIComponent(runId)}/approve`, body),
    );
  }

  async reject(runId: string, command: ApprovalCommand): Promise<RunProjection> {
    const body = ApprovalCommandSchema.parse(command);
    return RunProjectionSchema.parse(
      await this.#command(`/api/runs/${encodeURIComponent(runId)}/reject`, body),
    );
  }

  async stop(runId: string, command: StopRunCommand): Promise<RunProjection> {
    const body = StopRunCommandSchema.parse(command);
    return RunProjectionSchema.parse(
      await this.#command(`/api/runs/${encodeURIComponent(runId)}/stop`, body),
    );
  }

  async rollbackAction(
    runId: string,
    actionId: string,
    input: Partial<RollbackActionRequest> = {},
  ): Promise<RunProjection> {
    const body = RollbackActionRequestSchema.parse({
      command_id: input.command_id ?? createCommandId(),
      force: input.force ?? false,
    });
    return RunProjectionSchema.parse(
      await this.#command(
        `/api/runs/${encodeURIComponent(runId)}/actions/${encodeURIComponent(actionId)}/rollback`,
        body,
      ),
    );
  }

  async getRun(runId: string): Promise<RunProjection> {
    return RunProjectionSchema.parse(
      await this.#requestUnknown(`/api/runs/${encodeURIComponent(runId)}`),
    );
  }

  /** Read the canonical child Run linked by a parent Run's subagent projection. */
  async getSubagent(parentRunId: string, subagentId: string): Promise<RunProjection> {
    return RunProjectionSchema.parse(
      await this.#requestUnknown(
        `/api/runs/${encodeURIComponent(parentRunId)}/subagents/${encodeURIComponent(subagentId)}`,
      ),
    );
  }

  /** Read the canonical team rooted at a coordinator Run. */
  async getTeam(coordinatorRunId: string): Promise<TeamReadResponse> {
    return TeamReadResponseSchema.parse(
      await this.#requestUnknown(
        `/api/runs/${encodeURIComponent(coordinatorRunId)}/team`,
      ),
    );
  }

  async createTeam(
    coordinatorRunId: string,
    request: Partial<CreateTeamRequest> = {},
  ): Promise<TeamMutationResult> {
    const body = CreateTeamRequestSchema.parse({
      command_id: request.command_id ?? createCommandId(),
    });
    return TeamMutationResultSchema.parse(
      await this.#command(
        `/api/runs/${encodeURIComponent(coordinatorRunId)}/team`,
        body,
      ),
    );
  }

  async sendTeamMailbox(
    actorRunId: string,
    request: Omit<TeamMailboxSendRequest, "command_id"> & { command_id?: string },
  ): Promise<TeamMutationResult> {
    const body = TeamMailboxSendRequestSchema.parse({
      command_id: request.command_id ?? createCommandId(),
      input: request.input,
    });
    return TeamMutationResultSchema.parse(
      await this.#command(
        `/api/runs/${encodeURIComponent(actorRunId)}/team/mailbox/send`,
        body,
      ),
    );
  }

  async claimTeamMailbox(
    actorRunId: string,
    request: Omit<TeamMailboxClaimRequest, "command_id"> & { command_id?: string },
  ): Promise<TeamMutationResult> {
    const body = TeamMailboxClaimRequestSchema.parse({
      command_id: request.command_id ?? createCommandId(),
      input: request.input,
    });
    return TeamMutationResultSchema.parse(
      await this.#command(
        `/api/runs/${encodeURIComponent(actorRunId)}/team/mailbox/claim`,
        body,
      ),
    );
  }

  async writeTeamTask(
    actorRunId: string,
    request: Omit<TeamTaskWriteRequest, "command_id"> & { command_id?: string },
  ): Promise<TeamMutationResult> {
    const body = TeamTaskWriteRequestSchema.parse({
      command_id: request.command_id ?? createCommandId(),
      input: request.input,
    });
    return TeamMutationResultSchema.parse(
      await this.#command(
        `/api/runs/${encodeURIComponent(actorRunId)}/team/tasks/write`,
        body,
      ),
    );
  }

  async heartbeatTeam(
    memberRunId: string,
    request: Partial<TeamHeartbeatRequest> = {},
  ): Promise<TeamMutationResult> {
    const body = TeamHeartbeatRequestSchema.parse({
      command_id: request.command_id ?? createCommandId(),
      input: request.input ?? {},
    });
    return TeamMutationResultSchema.parse(
      await this.#command(
        `/api/runs/${encodeURIComponent(memberRunId)}/team/heartbeat`,
        body,
      ),
    );
  }

  async sweepLostTeamMembers(
    coordinatorRunId: string,
    request: Partial<TeamSweepLostMembersRequest> = {},
  ): Promise<TeamMutationResult> {
    const body = TeamSweepLostMembersRequestSchema.parse({
      command_id: request.command_id ?? createCommandId(),
    });
    return TeamMutationResultSchema.parse(
      await this.#command(
        `/api/runs/${encodeURIComponent(coordinatorRunId)}/team/sweep`,
        body,
      ),
    );
  }

  async getArtifact(runId: string, artifactId: string): Promise<ArtifactWireResponse> {
    const query = new URLSearchParams({ run_id: runId });
    return ArtifactWireResponseSchema.parse(
      await this.#requestUnknown(
        `/api/artifacts/${encodeURIComponent(artifactId)}?${query.toString()}`,
      ),
    );
  }

  /** Fetch verified binary bytes through the live, relation-scoped Host route. */
  async getAttachmentContent(
    runId: string,
    attachmentId: string,
  ): Promise<AttachmentContentResponse> {
    const response = await this.#requestResponse(
      `/api/runs/${encodeURIComponent(runId)}/attachments/${encodeURIComponent(attachmentId)}/content`,
      { headers: { accept: "image/png,image/jpeg,application/pdf" } },
    );
    const mediaType = AttachmentMediaTypeSchema.parse(
      response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase(),
    );
    const sha256 = response.headers.get("x-tracegraph-content-sha256");
    if (sha256 === null || !/^sha256:[a-f0-9]{64}$/u.test(sha256)) {
      throw new TypeError("Attachment content response has no valid content hash");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new TypeError("Attachment content response was empty");
    }
    return { attachmentId, mediaType, sha256: sha256 as `sha256:${string}`, bytes };
  }

  async *streamEvents(
    runId: string,
    options: StreamOptions = {},
  ): AsyncGenerator<WireSessionEvent, void, void> {
    let afterSequence = options.afterSequence ?? 0;
    let retryMs = options.minRetryMs ?? 250;
    const maxRetryMs = options.maxRetryMs ?? 2_000;
    const reconnect = options.reconnect ?? true;
    let retriedAuthentication = false;

    while (!options.signal?.aborted) {
      try {
        const query = new URLSearchParams({ after_sequence: String(afterSequence) });
        const requestInit: RequestInit = { headers: this.#headers() };
        if (options.signal) requestInit.signal = options.signal;
        const response = await this.#fetch(
          `${this.#baseUrl}/api/runs/${encodeURIComponent(runId)}/events/stream?${query.toString()}`,
          requestInit,
        );
        if (response.status === 401 && this.#replayScope === undefined && !retriedAuthentication) {
          retriedAuthentication = true;
          await this.#refreshCapabilityToken();
          continue;
        }
        if (!response.ok) {
          throw await this.#httpError(response);
        }
        if (!response.body) {
          throw new TypeError("SSE response has no body");
        }

        retryMs = options.minRetryMs ?? 250;
        retriedAuthentication = false;
        for await (const payload of parseSseData(response.body, options.signal)) {
          const event = WireSessionEventSchema.parse(JSON.parse(payload));
          afterSequence = Math.max(afterSequence, event.sequence);
          yield event;
        }
        if (!reconnect) return;
      } catch (error) {
        if (options.signal?.aborted) return;
        if (!reconnect) throw error;
        await delay(retryMs, options.signal);
        retryMs = Math.min(maxRetryMs, retryMs * 2);
      }
    }
  }

  /**
   * Stream the volatile, safe public-process feed for an active Run. Unlike
   * `streamEvents`, this is not ledger replay: it contains only concise
   * runtime activity suitable for a fast live UI, never provider CoT or token
   * deltas.
   */
  async *streamLiveActivities(
    runId: string,
    options: StreamOptions = {},
  ): AsyncGenerator<LivePublicActivity, void, void> {
    let afterSequence = options.afterSequence ?? 0;
    let retryMs = options.minRetryMs ?? 250;
    const maxRetryMs = options.maxRetryMs ?? 2_000;
    const reconnect = options.reconnect ?? true;
    let retriedAuthentication = false;

    while (!options.signal?.aborted) {
      try {
        const query = new URLSearchParams({ after_sequence: String(afterSequence) });
        const requestInit: RequestInit = { headers: this.#headers() };
        if (options.signal) requestInit.signal = options.signal;
        const response = await this.#fetch(
          `${this.#baseUrl}/api/runs/${encodeURIComponent(runId)}/live/stream?${query.toString()}`,
          requestInit,
        );
        if (response.status === 401 && this.#replayScope === undefined && !retriedAuthentication) {
          retriedAuthentication = true;
          await this.#refreshCapabilityToken();
          continue;
        }
        if (!response.ok) {
          throw await this.#httpError(response);
        }
        if (!response.body) {
          throw new TypeError("SSE response has no body");
        }

        retryMs = options.minRetryMs ?? 250;
        retriedAuthentication = false;
        let lastActivity: LivePublicActivity | undefined;
        for await (const payload of parseSseData(response.body, options.signal)) {
          const activity = LivePublicActivitySchema.parse(JSON.parse(payload));
          lastActivity = activity;
          afterSequence = Math.max(afterSequence, activity.sequence);
          yield activity;
          // Terminal facts are self-describing, so they can stop immediately.
          // plan.ready is different: it may be historical activity in an
          // execute-stage replay, and only becomes a wait boundary when the
          // current Host response ends immediately after that activity.
          if (isTerminalLiveActivity(activity)) return;
        }
        if (!reconnect) return;
        if (lastActivity?.source_event_type === "plan.ready") {
          // EOF alone is not proof that this was the current wait boundary: a
          // proxy can disconnect immediately after replaying a historical
          // plan.ready from an execute-stage Run. Confirm the durable
          // optimistic-lock revision before deciding not to reconnect.
          const projection = await this.getRun(runId);
          if (
            projection.status === "awaiting_plan_approval"
            && projection.pending_plan?.plan_event_id === lastActivity.source_event_id
          ) {
            return;
          }
        }
      } catch (error) {
        if (options.signal?.aborted) return;
        if (!reconnect) throw error;
        await delay(retryMs, options.signal);
        retryMs = Math.min(maxRetryMs, retryMs * 2);
      }
    }
  }

  /**
   * Stream the transient, model-authored public plan/answer surface. Its
   * cursor is independent of the durable event ledger and of the compact
   * execution feed, so clients can reconnect without dropping token updates.
   */
  async *streamModelSurface(
    runId: string,
    options: ModelSurfaceStreamOptions = {},
  ): AsyncGenerator<ModelSurfaceEvent, void, void> {
    let afterCursor = options.afterCursor ?? 0;
    let retryMs = options.minRetryMs ?? 250;
    const maxRetryMs = options.maxRetryMs ?? 2_000;
    const reconnect = options.reconnect ?? true;
    let retriedAuthentication = false;

    while (!options.signal?.aborted) {
      try {
        const query = new URLSearchParams({ after_cursor: String(afterCursor) });
        const requestInit: RequestInit = { headers: this.#headers() };
        if (options.signal) requestInit.signal = options.signal;
        const response = await this.#fetch(
          `${this.#baseUrl}/api/runs/${encodeURIComponent(runId)}/model-surface/stream?${query.toString()}`,
          requestInit,
        );
        if (response.status === 401 && this.#replayScope === undefined && !retriedAuthentication) {
          retriedAuthentication = true;
          await this.#refreshCapabilityToken();
          continue;
        }
        if (!response.ok) throw await this.#httpError(response);
        if (!response.body) throw new TypeError("SSE response has no body");

        retryMs = options.minRetryMs ?? 250;
        retriedAuthentication = false;
        for await (const payload of parseSseData(response.body, options.signal)) {
          const event = ModelSurfaceEventSchema.parse(JSON.parse(payload));
          afterCursor = Math.max(afterCursor, event.cursor);
          yield event;
        }
        if (!reconnect) return;
      } catch (error) {
        if (options.signal?.aborted) return;
        if (!reconnect) throw error;
        await delay(retryMs, options.signal);
        retryMs = Math.min(maxRetryMs, retryMs * 2);
      }
    }
  }

  async #command(path: string, body: unknown): Promise<unknown> {
    const commandId =
      typeof body === "object" &&
      body !== null &&
      "command_id" in body &&
      typeof body.command_id === "string"
        ? body.command_id
        : createCommandId();
    return this.#requestUnknown(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tracegraph-command-id": commandId,
      },
      body: JSON.stringify(body),
    });
  }

  async #mutation(
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    body?: unknown,
  ): Promise<unknown> {
    const commandId =
      typeof body === "object" &&
      body !== null &&
      "command_id" in body &&
      typeof body.command_id === "string"
        ? body.command_id
        : createCommandId();
    return this.#requestUnknown(path, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "x-tracegraph-command-id": commandId,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async #requestUnknown(
    path: string,
    init: RequestInit = {},
    authenticated = true,
    retryAuthentication = true,
  ): Promise<unknown> {
    const response = await this.#requestResponse(path, init, authenticated, retryAuthentication);
    if (response.status === 204) return undefined;
    return response.json() as Promise<unknown>;
  }

  async #requestResponse(
    path: string,
    init: RequestInit = {},
    authenticated = true,
    retryAuthentication = true,
  ): Promise<Response> {
    // Authority is a property of the request that left the process, not of
    // whatever mode the caller happens to be in when a late response arrives.
    // Remembering it here prevents an exited replay request from turning a
    // delayed 401 into a live bootstrap/retry.
    const startedWithReplayAuthority = this.#replayScope !== undefined;
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        ...this.#headers(authenticated),
        ...init.headers,
      },
    });
    if (
      response.status === 401
      && authenticated
      && retryAuthentication
      && !startedWithReplayAuthority
      && this.#replayScope === undefined
    ) {
      await this.#refreshCapabilityToken();
      return this.#requestResponse(path, init, authenticated, false);
    }
    if (!response.ok) {
      throw await this.#httpError(response);
    }
    return response;
  }

  async #refreshCapabilityToken(): Promise<void> {
    if (this.#replayScope !== undefined) {
      throw new TraceGraphHttpError(
        401,
        "Replay capability expired; exit replay before reconnecting live authority",
        { error: "replay_capability_expired" },
      );
    }
    if (!this.#tokenRefresh) {
      this.#tokenRefresh = this.bootstrap().then(() => undefined).finally(() => {
        this.#tokenRefresh = null;
      });
    }
    await this.#tokenRefresh;
  }

  #headers(authenticated = true): Record<string, string> {
    const transportHeaders = this.#nodeOrigin === undefined ? {} : { origin: this.#nodeOrigin };
    if (!authenticated) return { accept: "application/json", ...transportHeaders };
    if (!this.#token) throw new Error("TraceGraph client is not bootstrapped");
    return {
      accept: "application/json",
      authorization: `Bearer ${this.#token}`,
      ...transportHeaders,
    };
  }

  async #httpError(response: Response): Promise<TraceGraphHttpError> {
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Keep the original text so non-JSON proxy/Host failures remain inspectable.
    }
    const message =
      typeof body === "object" && body !== null && "message" in body
        ? String(body.message)
        : `TraceGraph Host returned ${response.status}`;
    return new TraceGraphHttpError(response.status, message, body);
  }
}

function attachmentBody(value: Blob | ArrayBuffer | Uint8Array): BodyInit {
  if (value instanceof Blob) return value;
  if (value instanceof ArrayBuffer) return value;
  // Copy views backed by SharedArrayBuffer or a sliced Buffer into an ordinary
  // ArrayBuffer so fetch retries never depend on a mutable/shared backing store.
  return Uint8Array.from(value).buffer;
}

function isBrowserRuntime(): boolean {
  return typeof globalThis.window !== "undefined" && typeof globalThis.document !== "undefined";
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("nodeOrigin must use http or https");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("nodeOrigin must be an origin without credentials, path, query, or fragment");
  }
  return url.origin;
}

function isTerminalLiveActivity(activity: LivePublicActivity): boolean {
  return activity.source_event_type === "run.completed"
    || activity.source_event_type === "run.failed"
    || activity.source_event_type === "run.cancelled"
    || activity.source_event_type === "run.interrupted"
    || activity.source_event_type === "action.diverged";
}

export async function* parseSseData(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) yield data;
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const delay = async (milliseconds: number, signal?: AbortSignal): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
};
