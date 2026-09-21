import {
  ContextManifestSchema,
  CodeIntelUpdatedDataSchema,
  CodeStaleBaseDetectedDataSchema,
  ExtensionStatusSchema,
  LspStatusSnapshotSchema,
  LspDiagnosticsReceivedDataSchema,
  McpServerStatusSchema,
  McpStatusSnapshotSchema,
  SkillProjectInspectionSchema,
  GraphDeltaSchema,
  ModelUsageReportSchema,
  PermissionConfiguredDataSchema,
  PermissionSettingsResponseSchema,
  PolicyDeniedDataSchema,
  PolicyEvaluatedDataSchema,
  RunProjectionSchema,
  SandboxReportSchema,
  TeamMutationResultSchema,
  TelemetryStatusSchema,
  TodoListSchema,
  TodoWriteInputSchema,
  TokenEstimateSchema,
  UsageSnapshotSchema,
  UserInputConsumedDataSchema,
  UserInputQueuedDataSchema,
  WireSessionEventSchema,
  type ArtifactRef,
  type ArtifactWireResponse,
  type AttachmentStageReceipt,
  type ContextManifest,
  type ExtensionStatus,
  type LspStatusSnapshot,
  type McpServerStatus,
  type McpStatusSnapshot,
  type SkillProjectInspection,
  type GraphDelta,
  type LivePublicActivity,
  type ModelSurfaceEvent,
  type PermissionPresetUpdateRequest,
  type PermissionSettingsResponse,
  type PolicyDecision,
  type ProjectSummary,
  type RunProjection,
  type SessionDeleteResponse,
  type SessionListQuery,
  type SessionListResponse,
  type SessionReadResult,
  type SessionRecoveryReport,
  type SessionRenameRequest,
  type SessionResumeRequest,
  type SessionResumeResponse,
  type TodoList,
  type TodoMutationResult,
  type TodoWriteInput,
  type SubmitUserInputRequest,
  type SubmitUserInputResult,
  type CreateTeamRequest,
  type TeamMailboxSendRequest,
  type TeamMutationResult,
  type TeamTaskWriteRequest,
  type TelemetryStatus,
  type UsageSnapshot,
  type UserInputKind,
  type WireSessionEvent,
} from "@tracegraph/contracts";
import { TraceGraphClient as SdkTraceGraphClient } from "@tracegraph/sdk";
import type {
  ConfigureModelInput,
  ConfigurePermissionPresetInput,
  ModelConfigSnapshot,
  PermissionConfigSnapshot,
  TelemetryStatusSnapshot,
  ExtensionStatusSnapshot,
  SkillProjectInspectionSnapshot,
  McpServerStatusView,
  McpStatusSnapshotView,
  LspStatusSnapshotView,
  WorkbenchClient,
} from "./client";
import type {
  ApprovalRequest,
  ChangedFile,
  ConnectionSnapshot,
  ConversationTurn,
  ContextArchiveLoadResult,
  ContextBudgetSnapshot,
  ContextTokenEstimateSnapshot,
  ContextSource,
  CodeIntelSnapshot,
  DiffLine,
  EvidenceSlot,
  EventKind,
  EventState,
  GraphEdge,
  GraphNode,
  EventEvidenceSnapshot,
  AttachmentPreviewContent,
  AttachmentSnapshot,
  PublicActivitySnapshot,
  ProviderUsageSnapshot,
  ModelSurfaceSnapshot,
  ProjectSnapshot,
  ReasoningEffort,
  PendingAttachment,
  RunMode,
  RunSnapshot,
  RunStatus,
  ReplayDiffSnapshot,
  ReplayViewState,
  SubagentChildRunSnapshot,
  SubagentSnapshot,
  TraceEvent,
  WorkbenchSnapshot,
  WorkspaceKind,
} from "./model";
import { adjacentReplaySequence, emptyEventEvidence } from "./model";

export interface TraceGraphSdkPort {
  bootstrap(): Promise<{ token: string; expiresAt: string; recovery?: SessionRecoveryReport }>;
  listProjects(): Promise<readonly ProjectSummary[]>;
  listSessions?(input?: SessionListQuery): Promise<SessionListResponse>;
  getSession?(sessionId: string): Promise<SessionReadResult>;
  renameSession?(sessionId: string, input: SessionRenameRequest): Promise<SessionReadResult>;
  deleteSession?(sessionId: string): Promise<SessionDeleteResponse>;
  resumeSession?(sessionId: string, input?: Partial<SessionResumeRequest>): Promise<SessionResumeResponse>;
  createProject?(input: { name: string; template?: "typescript" }): Promise<ProjectSummary>;
  openLocalProject?(input?: { access?: "read_write" | "read_only"; command_id?: string }): Promise<ProjectSummary | undefined>;
  revealProject?(projectId: string, commandId?: string): Promise<void>;
  removeProject?(projectId: string, commandId?: string): Promise<void>;
  getModelConfig?(): Promise<ModelConfigSnapshot>;
  configureModel?(input: ConfigureModelInput): Promise<ModelConfigSnapshot>;
  getPermissionConfig?(): Promise<PermissionSettingsResponse>;
  configurePermissionPreset?(input: Omit<PermissionPresetUpdateRequest, "command_id"> & { command_id?: string }): Promise<PermissionSettingsResponse>;
  getTelemetryStatus?(): Promise<TelemetryStatus>;
  getUsage?(): Promise<UsageSnapshot>;
  listExtensions?(): Promise<readonly ExtensionStatus[]>;
  reloadExtension?(extensionName: string): Promise<ExtensionStatus>;
  listSkills?(): Promise<readonly SkillProjectInspection[]>;
  getMcpStatus?(): Promise<McpStatusSnapshot>;
  restartMcpServer?(serverName: string, input?: { command_id?: string }): Promise<McpServerStatus>;
  getLspStatus?(): Promise<LspStatusSnapshot>;
  uploadAttachment?(input: {
    command_id?: string;
    session_id?: string;
    declared_media_type: string;
    delivery: "offload" | "inline";
    bytes: Blob | ArrayBuffer | Uint8Array;
  } & ({ target: "project"; project_id: string } | { target: "chat" })): Promise<AttachmentStageReceipt>;
  getAttachmentContent?(runId: string, attachmentId: string): Promise<{
    attachmentId: string;
    mediaType: "image/png" | "image/jpeg" | "application/pdf";
    sha256: `sha256:${string}`;
    bytes: Uint8Array;
  }>;
  startRun(input: { command_id: string; project_id: string; session_id?: string; task: string; mode: RunMode; reasoning_effort?: ReasoningEffort; conversation_history?: { role: "user" | "assistant"; content: string }[]; attachment_upload_ids?: string[] }): Promise<RunProjection>;
  startChat?(input: { command_id: string; session_id?: string; task: string; reasoning_effort?: ReasoningEffort; conversation_history?: { role: "user" | "assistant"; content: string }[]; attachment_upload_ids?: string[] }): Promise<RunProjection>;
  approve(runId: string, command: {
    type: "approve";
    command_id: string;
    project_id: string;
    run_id: string;
    approval_id: string;
    action_id: string;
  }): Promise<RunProjection>;
  approvePlan(runId: string, input: {
    command_id?: string;
    plan_event_id: string;
  }): Promise<RunProjection>;
  getTodos(runId: string): Promise<TodoList>;
  writeTodo(runId: string, request: {
    command_id?: string;
    input: TodoWriteInput;
  }): Promise<TodoMutationResult>;
  createTeam?(coordinatorRunId: string, request?: Partial<CreateTeamRequest>): Promise<TeamMutationResult>;
  sendTeamMailbox?(actorRunId: string, request: Omit<TeamMailboxSendRequest, "command_id"> & {
    command_id?: string;
  }): Promise<TeamMutationResult>;
  writeTeamTask?(actorRunId: string, request: Omit<TeamTaskWriteRequest, "command_id"> & {
    command_id?: string;
  }): Promise<TeamMutationResult>;
  submitUserInput(runId: string, request: Omit<SubmitUserInputRequest, "command_id" | "input_id"> & {
    command_id?: string;
    input_id?: string;
  }): Promise<SubmitUserInputResult>;
  reject(runId: string, command: {
    type: "reject";
    command_id: string;
    project_id: string;
    run_id: string;
    approval_id: string;
    action_id: string;
    reason?: string;
  }): Promise<RunProjection>;
  stop(runId: string, command: {
    type: "stop";
    command_id: string;
    project_id: string;
    run_id: string;
    reason?: string;
  }): Promise<RunProjection>;
  rollbackAction?(runId: string, actionId: string, input?: {
    command_id?: string;
    force?: boolean;
  }): Promise<RunProjection>;
  getRun(runId: string): Promise<RunProjection>;
  /** Relation-scoped, read-only child Run lookup. */
  getSubagent?(parentRunId: string, subagentId: string): Promise<RunProjection>;
  /** G23 replay capability. Optional only while older SDK builds roll forward. */
  createReplay?(input: {
    session_id: string;
    run_id: string;
    until_sequence: number;
  }): Promise<unknown>;
  getReplayDiff?(input: {
    from: number;
    to: number;
  }): Promise<unknown>;
  /** Restore the SDK's retained live bearer after a fixed read-only replay bearer. */
  exitReplay?(): void;
  getArtifact(runId: string, artifactId: string): Promise<ArtifactWireResponse>;
  streamEvents(runId: string, options: {
    afterSequence?: number;
    signal?: AbortSignal;
    reconnect?: boolean;
  }): AsyncGenerator<WireSessionEvent, void, void>;
  /** Optional while older Hosts roll forward. This feed is volatile by design. */
  streamLiveActivities?(runId: string, options: {
    afterSequence?: number;
    signal?: AbortSignal;
    reconnect?: boolean;
  }): AsyncGenerator<LivePublicActivity, void, void>;
  /** Optional while Hosts roll forward to the real model public-stream API. */
  streamModelSurface?(runId: string, options: {
    afterCursor?: number;
    signal?: AbortSignal;
    reconnect?: boolean;
  }): AsyncGenerator<ModelSurfaceEvent, void, void>;
}

export interface LiveTraceGraphClientOptions {
  sdk?: TraceGraphSdkPort;
  baseUrl?: string;
  minRetryMs?: number;
  maxRetryMs?: number;
}

type ArtifactFetchResult = {
  slot: EvidenceSlot;
  content?: string;
  transient?: boolean;
};

const PLAIN_CHAT_KEY = "plain-chat";

const emptySlot = (message: string): EvidenceSlot => ({ status: "not_present", message });

const emptyLiveSnapshot = (connection: ConnectionSnapshot): WorkbenchSnapshot => ({
  dataSource: "live",
  connection,
  project: null,
  availableProjects: [],
  sessions: [],
  selectedSessionId: null,
  sessionViewState: null,
  recovery: null,
  run: null,
  conversation: [],
  contextSources: [],
  changedFiles: [],
  diffs: {},
  graphNodes: [],
  graphEdges: [],
  evidence: {
    context: emptySlot("No Context Manifest is available."),
    diff: emptySlot("No Diff Artifact is available."),
    graph: emptySlot("No Graph Delta Artifact is available."),
    test: emptySlot("No Test Log Artifact is available."),
  },
  eventEvidence: {},
});

export class LiveTraceGraphClient implements WorkbenchClient {
  private readonly sdk: TraceGraphSdkPort;
  private readonly minRetryMs: number;
  private readonly maxRetryMs: number;
  private snapshot: WorkbenchSnapshot = emptyLiveSnapshot({
    state: "connecting",
    message: "Connecting to the local TraceGraph Host…",
    lastSequence: 0,
  });
  private readonly listeners = new Set<(snapshot: WorkbenchSnapshot) => void>();
  private projects: readonly ProjectSummary[] = [];
  private sessions: SessionListResponse["sessions"] = [];
  private selectedSessionId: string | null = null;
  private sessionViewState: WorkbenchSnapshot["sessionViewState"] = null;
  private recovery: SessionRecoveryReport | null = null;
  private sessionQuery = "";
  private selectedProjectId: string | null = null;
  private initialization: Promise<void> | null = null;
  private streamController: AbortController | null = null;
  private streamGeneration = 0;
  private viewGeneration = 0;
  /** Serializes SDK bearer transitions while still letting the UI supersede work by generation. */
  private replayTransition: Promise<void> = Promise.resolve();
  private readonly artifactCache = new Map<string, Promise<ArtifactFetchResult>>();
  private readonly subagentDetails = new Map<string, SubagentSnapshot["detail"]>();
  private subagentCacheGeneration = 0;
  private readonly conversations = new Map<string, ConversationTurn[]>();
  private readonly liveActivities = new Map<string, PublicActivitySnapshot[]>();
  private readonly modelSurface = new Map<string, ModelSurfaceSnapshot[]>();
  private readonly pendingUserInputAttempts = new Map<string, {
    commandId: string;
    inputId: string;
  }>();
  private readonly pendingTeamAttempts = new Map<string, string>();
  private plainChatActive = false;

  constructor(options: LiveTraceGraphClientOptions = {}) {
    this.sdk = options.sdk ?? new SdkTraceGraphClient({ baseUrl: options.baseUrl ?? "" });
    this.minRetryMs = options.minRetryMs ?? 300;
    this.maxRetryMs = options.maxRetryMs ?? 2_500;
  }

  getSnapshot(): WorkbenchSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: WorkbenchSnapshot) => void): () => void {
    this.listeners.add(listener);
    void this.initialize();
    return () => this.listeners.delete(listener);
  }

  initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    this.initialization = this.bootstrap();
    return this.initialization;
  }

  async chooseProject(kind: WorkspaceKind): Promise<void> {
    await this.initialize();
    const project = this.projects.find((candidate) => candidate.workspace_kind === kind);
    if (!project) {
      this.commit({
        ...this.snapshot,
        connection: {
          ...this.snapshot.connection,
          message: `The Host has no registered ${kind === "readonly_local" ? "read-only local project" : "disposable fixture"}.`,
        },
      });
      return;
    }
    await this.chooseProjectById(project.project_id);
  }

  async chooseProjectById(projectId: string): Promise<void> {
    await this.initialize();
    this.assertLiveWritable("Project navigation");
    const project = this.projects.find((candidate) => candidate.project_id === projectId);
    if (!project) throw new Error("The selected project is no longer registered by the local Host");
    this.stopStream();
    this.artifactCache.clear();
    this.clearSubagentDetails();
    this.projection = null;
    this.plainChatActive = false;
    this.selectedProjectId = project.project_id;
    this.commit({
      ...emptyLiveSnapshot({ state: "live", message: "Connected to the local Host", lastSequence: 0 }),
      project: mapProject(project),
      availableProjects: this.projects.map(mapProject),
      sessions: this.sessions,
      selectedSessionId: null,
      sessionViewState: null,
      recovery: this.recovery,
      conversation: this.conversations.get(project.project_id) ?? [],
    });
    this.selectedSessionId = null;
    this.sessionViewState = null;
    await this.refreshSessions();
  }

  async openLocalProject(access: "read_write" | "read_only" = "read_write"): Promise<void> {
    await this.initialize();
    this.assertLiveWritable("Opening a project");
    if (!this.sdk.openLocalProject) throw new Error("This Host does not support native folder selection");
    const selected = await this.sdk.openLocalProject({ access });
    if (!selected) return;
    const existingIndex = this.projects.findIndex((project) => project.project_id === selected.project_id);
    this.projects = existingIndex < 0
      ? [...this.projects, selected]
      : this.projects.map((project, index) => index === existingIndex ? selected : project);
    await this.chooseProjectById(selected.project_id);
  }

  async revealProject(projectId: string): Promise<void> {
    await this.initialize();
    this.assertLiveWritable("Revealing a project");
    if (!this.sdk.revealProject) throw new Error("This Host cannot reveal local project folders");
    await this.sdk.revealProject(projectId);
  }

  async removeProject(projectId: string): Promise<void> {
    await this.initialize();
    this.assertLiveWritable("Removing a project");
    if (!this.sdk.removeProject) throw new Error("This Host does not support removing project registrations");
    const project = this.projects.find((candidate) => candidate.project_id === projectId);
    if (!project) throw new Error("The selected project is no longer registered by the local Host");
    if (project.location?.kind !== "linked_directory" && project.location?.kind !== "managed_storage") {
      throw new Error("This project cannot be removed from the local Host");
    }
    if (this.snapshot.run && this.snapshot.project?.id === projectId && !isTerminalStatus(this.snapshot.run.status)) {
      throw new Error("Stop the active run before removing its project registration");
    }
    await this.sdk.removeProject(projectId);
    this.projects = this.projects.filter((candidate) => candidate.project_id !== projectId);
    this.conversations.delete(projectId);
    if (this.selectedProjectId === projectId || this.snapshot.project?.id === projectId) {
      this.stopStream();
      this.artifactCache.clear();
      this.clearSubagentDetails();
      this.projection = null;
      this.plainChatActive = false;
      this.selectedProjectId = null;
      this.commit({
        ...emptyLiveSnapshot({ state: "live", message: "Project registration removed", lastSequence: 0 }),
        availableProjects: this.projects.map(mapProject),
        sessions: this.sessions,
        recovery: this.recovery,
      });
    } else {
      this.commit({ ...this.snapshot, availableProjects: this.projects.map(mapProject) });
    }
  }

  async searchSessions(query: string): Promise<void> {
    await this.initialize();
    this.assertLiveWritable("Session search");
    this.sessionQuery = query.trim();
    await this.refreshSessions();
  }

  async openSession(sessionId: string): Promise<void> {
    await this.initialize();
    this.assertLiveWritable("Session navigation");
    if (!this.sdk.getSession) throw new Error("This Host does not support durable sessions");
    const detail = await this.sdk.getSession(sessionId);
    const runId = detail.header.run_ids.at(-1);
    if (!runId) throw new Error("This session has no Run to restore");
    const projection = await this.sdk.getRun(runId);
    this.stopStream();
    this.artifactCache.clear();
    this.clearSubagentDetails();
    this.selectedSessionId = sessionId;
    this.sessionViewState = "restored";
    await this.acceptProjection(projection, {
      state: "live",
      message: detail.truncated ? "Recovered session view after truncating an incomplete tail" : "Durable session view restored",
      lastSequence: projection.last_sequence,
    });
    if (!isStreamSettled(projection)) this.startStream(projection.run_id);
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.initialize();
    this.assertLiveWritable("Renaming a Session");
    if (!this.sdk.renameSession) throw new Error("This Host does not support renaming sessions");
    await this.sdk.renameSession(sessionId, { title });
    await this.refreshSessions();
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.initialize();
    this.assertLiveWritable("Deleting a Session");
    if (!this.sdk.deleteSession) throw new Error("This Host does not support deleting sessions");
    await this.sdk.deleteSession(sessionId);
    this.sessions = this.sessions.filter((session) => session.session_id !== sessionId);
    if (this.selectedSessionId === sessionId) {
      this.stopStream();
      this.artifactCache.clear();
      this.clearSubagentDetails();
      this.projection = null;
      this.selectedSessionId = null;
      this.sessionViewState = null;
      this.commit({
        ...emptyLiveSnapshot({ state: "live", message: "Session moved to TraceGraph trash", lastSequence: 0 }),
        project: this.snapshot.project,
        availableProjects: this.projects.map(mapProject),
        sessions: this.sessions,
        selectedSessionId: null,
        sessionViewState: null,
        recovery: this.recovery,
      });
      return;
    }
    this.commit({ ...this.snapshot, sessions: this.sessions });
  }

  async resumeSession(sessionId: string): Promise<void> {
    await this.initialize();
    this.assertLiveWritable("Resuming a Session");
    if (!this.sdk.resumeSession) throw new Error("This Host does not support resuming sessions");
    const resumed = await this.sdk.resumeSession(sessionId, { command_id: commandId() });
    const projection = await this.sdk.getRun(resumed.run_id);
    this.stopStream();
    this.artifactCache.clear();
    this.clearSubagentDetails();
    this.selectedSessionId = sessionId;
    this.sessionViewState = "resumed";
    await this.acceptProjection(projection, {
      state: "live",
      message: resumed.status === "awaiting_approval" ? "Session restored with approval still required" : "Interrupted session resumed",
      lastSequence: projection.last_sequence,
    });
    if (!isStreamSettled(projection)) this.startStream(projection.run_id);
    await this.refreshSessions();
  }

  async returnHome(): Promise<void> {
    await this.initialize();
    this.assertLiveWritable("Leaving the replayed Run");
    this.archiveCurrentRun();
    this.stopStream();
    this.artifactCache.clear();
    this.clearSubagentDetails();
    this.projection = null;
    this.plainChatActive = false;
    this.selectedProjectId = null;
    this.selectedSessionId = null;
    this.sessionViewState = null;
    this.commit({
      ...emptyLiveSnapshot({ state: "live", message: "Connected to the local Host", lastSequence: 0 }),
      availableProjects: this.projects.map(mapProject),
      sessions: this.sessions,
      selectedSessionId: null,
      sessionViewState: null,
      recovery: this.recovery,
    });
    await this.refreshSessions();
  }

  async startRun(
    task: string,
    mode: RunMode,
    reasoningEffort: ReasoningEffort = "default",
    attachments: readonly PendingAttachment[] = [],
  ): Promise<void> {
    await this.initialize();
    this.assertLiveWritable("Starting a Run");
    const project = this.requireSelectedProject();
    this.artifactCache.clear();
    this.clearSubagentDetails();
    this.sessionViewState = null;
    this.archiveCurrentRun();
    this.plainChatActive = false;
    const conversation = this.conversations.get(project.project_id) ?? [];
    const attachmentUploadIds = await this.stageAttachments(attachments, {
      target: "project",
      project_id: project.project_id,
    });
    const projection = await this.sdk.startRun({
      command_id: commandId(),
      project_id: project.project_id,
      task,
      mode,
      ...(this.selectedSessionId === null ? {} : { session_id: this.selectedSessionId }),
      reasoning_effort: reasoningEffort,
      conversation_history: conversation.flatMap((turn) => [
        { role: "user" as const, content: turn.task },
        { role: "assistant" as const, content: turn.response },
      ]).slice(-160),
      ...(attachmentUploadIds.length === 0 ? {} : { attachment_upload_ids: attachmentUploadIds }),
    });
    await this.acceptProjection(projection, { state: "live", message: "Live event stream connected", lastSequence: projection.last_sequence });
    await this.refreshSessions();
    if (!isStreamSettled(projection)) this.startStream(projection.run_id);
  }

  async startChat(
    task: string,
    reasoningEffort: ReasoningEffort = "default",
    attachments: readonly PendingAttachment[] = [],
  ): Promise<void> {
    await this.initialize();
    this.assertLiveWritable("Starting a chat Run");
    if (!this.sdk.startChat) throw new Error("This Host does not support isolated plain chat");
    this.artifactCache.clear();
    this.clearSubagentDetails();
    this.sessionViewState = null;
    this.archiveCurrentRun();
    this.plainChatActive = true;
    this.selectedProjectId = null;
    const conversation = this.conversations.get(PLAIN_CHAT_KEY) ?? [];
    const attachmentUploadIds = await this.stageAttachments(attachments, { target: "chat" });
    const projection = await this.sdk.startChat({
      command_id: commandId(),
      task,
      ...(this.selectedSessionId === null ? {} : { session_id: this.selectedSessionId }),
      reasoning_effort: reasoningEffort,
      conversation_history: conversation.flatMap((turn) => [
        { role: "user" as const, content: turn.task },
        { role: "assistant" as const, content: turn.response },
      ]).slice(-160),
      ...(attachmentUploadIds.length === 0 ? {} : { attachment_upload_ids: attachmentUploadIds }),
    });
    await this.acceptProjection(projection, { state: "live", message: "Plain chat event stream connected", lastSequence: projection.last_sequence });
    await this.refreshSessions();
    if (!isStreamSettled(projection)) this.startStream(projection.run_id);
  }

  private async stageAttachments(
    attachments: readonly PendingAttachment[],
    target: { target: "project"; project_id: string } | { target: "chat" },
  ): Promise<string[]> {
    if (attachments.length === 0) return [];
    if (!this.sdk.uploadAttachment) {
      throw new Error("This Host SDK does not support attachment uploads");
    }
    const uploadIds: string[] = [];
    // Keep staging order deterministic so the attachment projection matches
    // the order the user selected, while each raw request stays independently
    // bounded and retryable.
    for (const attachment of attachments) {
      const receipt = await this.sdk.uploadAttachment({
        ...target,
        ...(this.selectedSessionId === null ? {} : { session_id: this.selectedSessionId }),
        declared_media_type: attachment.declaredMediaType,
        delivery: attachment.delivery,
        bytes: attachment.file,
      });
      // The receipt is intentionally opaque: project/session binding remains
      // in Core so a plain-chat response cannot disclose its hidden project.
      uploadIds.push(receipt.upload_id);
    }
    return uploadIds;
  }

  async createProject(name: string): Promise<void> {
    await this.initialize();
    this.assertLiveWritable("Creating a project");
    if (!this.sdk.createProject) throw new Error("This Host client does not support project creation");
    const created = await this.sdk.createProject({ name, template: "typescript" });
    this.projects = [...this.projects, created];
    this.stopStream();
    this.projection = null;
    this.plainChatActive = false;
    this.selectedProjectId = created.project_id;
    this.selectedSessionId = null;
    this.sessionViewState = null;
    this.commit({
      ...emptyLiveSnapshot({ state: "live", message: "Managed project created", lastSequence: 0 }),
      project: mapProject(created),
      availableProjects: this.projects.map(mapProject),
      sessions: this.sessions,
      selectedSessionId: null,
      sessionViewState: null,
      recovery: this.recovery,
      conversation: [],
    });
    await this.refreshSessions();
  }

  async getModelConfig(): Promise<ModelConfigSnapshot> {
    await this.initialize();
    if (!this.sdk.getModelConfig) return { provider: "openai", protocol: "openai-chat-completions", configured: false, base_url: "https://api.openai.com/v1", model: "gpt-4.1-mini", has_key: false };
    return this.sdk.getModelConfig();
  }

  async configureModel(input: ConfigureModelInput): Promise<ModelConfigSnapshot> {
    await this.initialize();
    this.assertLiveWritable("Configuring a model");
    if (!this.sdk.configureModel) throw new Error("This Host client does not support model configuration");
    return this.sdk.configureModel(input);
  }

  async getPermissionConfig(): Promise<PermissionConfigSnapshot> {
    await this.initialize();
    if (!this.sdk.getPermissionConfig) throw new Error("This Host client does not support permission configuration");
    return PermissionSettingsResponseSchema.parse(await this.sdk.getPermissionConfig());
  }

  async configurePermissionPreset(input: ConfigurePermissionPresetInput): Promise<PermissionConfigSnapshot> {
    await this.initialize();
    this.assertLiveWritable("Configuring permissions");
    if (!this.sdk.configurePermissionPreset) throw new Error("This Host client does not support permission configuration");
    // The browser chooses only a Host-advertised preset. It cannot submit
    // sandbox modes, approval policy, rules, paths, or approval tokens.
    return PermissionSettingsResponseSchema.parse(await this.sdk.configurePermissionPreset({ preset_key: input.preset_key }));
  }

  async getTelemetryStatus(): Promise<TelemetryStatusSnapshot> {
    await this.initialize();
    if (!this.sdk.getTelemetryStatus) {
      throw new Error("This Host client does not support telemetry status");
    }
    return TelemetryStatusSchema.parse(await this.sdk.getTelemetryStatus());
  }

  async getUsage(): Promise<UsageSnapshot> {
    await this.initialize();
    if (!this.sdk.getUsage) {
      throw new Error("This Host client does not support aggregate usage");
    }
    return UsageSnapshotSchema.parse(await this.sdk.getUsage());
  }

  async listExtensions(): Promise<readonly ExtensionStatusSnapshot[]> {
    await this.initialize();
    if (!this.sdk.listExtensions) {
      throw new Error("This Host client does not support extension management");
    }
    return ExtensionStatusSchema.array().max(64).parse(await this.sdk.listExtensions());
  }

  async reloadExtension(extensionName: string): Promise<ExtensionStatusSnapshot> {
    await this.initialize();
    this.assertLiveWritable("Reloading an extension");
    if (!this.sdk.reloadExtension) {
      throw new Error("This Host client does not support extension management");
    }
    return ExtensionStatusSchema.parse(await this.sdk.reloadExtension(extensionName));
  }

  async listSkills(): Promise<readonly SkillProjectInspectionSnapshot[]> {
    await this.initialize();
    if (!this.sdk.listSkills) throw new Error("This Host client does not support Skill inspection");
    return SkillProjectInspectionSchema.array().max(256).parse(await this.sdk.listSkills());
  }

  async getMcpStatus(): Promise<McpStatusSnapshotView> {
    await this.initialize();
    if (!this.sdk.getMcpStatus) throw new Error("This Host client does not support MCP status");
    return McpStatusSnapshotSchema.parse(await this.sdk.getMcpStatus());
  }

  async restartMcpServer(serverName: string): Promise<McpServerStatusView> {
    await this.initialize();
    this.assertLiveWritable("Restarting an MCP server");
    if (!this.sdk.restartMcpServer) throw new Error("This Host client does not support MCP management");
    return McpServerStatusSchema.parse(await this.sdk.restartMcpServer(serverName));
  }

  async getLspStatus(): Promise<LspStatusSnapshotView> {
    await this.initialize();
    if (!this.sdk.getLspStatus) throw new Error("This Host client does not support LSP status");
    return LspStatusSnapshotSchema.parse(await this.sdk.getLspStatus());
  }

  async loadContextArchive(runId: string, artifactId: string): Promise<ContextArchiveLoadResult> {
    const projection = this.requireProjection();
    if (projection.run_id !== runId) throw new Error("The requested Context archive does not belong to the current Run");
    const sources = [
      ...this.snapshot.contextSources,
      ...Object.values(this.snapshot.eventEvidence).flatMap((evidence) => evidence.contextSources),
    ];
    if (!sources.some((source) => source.archive?.artifactId === artifactId)) {
      throw new Error("The requested Context archive is not referenced by an active manifest item");
    }
    const result = await fetchArtifactById(
      this.sdk,
      runId,
      artifactId,
      "Context archive Artifact",
      this.artifactCache,
    );
    return {
      status: result.slot.status,
      message: result.slot.message,
      ...(result.content === undefined ? {} : { content: result.content }),
    };
  }

  async approvePlan(): Promise<void> {
    this.assertLiveWritable("Approving a plan");
    const projection = this.requireProjection();
    const pending = projection.pending_plan;
    if (projection.status !== "awaiting_plan_approval" || pending === undefined) {
      throw new Error("Plan approval is no longer pending");
    }
    let next: RunProjection;
    try {
      next = await this.sdk.approvePlan(projection.run_id, {
        command_id: commandId(),
        plan_event_id: pending.plan_event_id,
      });
    } catch (error) {
      // Another browser or API client may have changed the Todo plan between
      // render and click. Refresh the canonical revision before surfacing the
      // conflict so the user can immediately approve the current plan.
      try {
        const refreshed = await this.sdk.getRun(projection.run_id);
        if (refreshed.run_id === projection.run_id) {
          await this.acceptProjection(refreshed, {
            state: "live",
            message: "Plan changed before approval; refreshed the current revision",
            lastSequence: refreshed.last_sequence,
          });
        }
      } catch {
        // Preserve the approval error. A failed best-effort refresh must not
        // replace the precise Host conflict with a secondary transport error.
      }
      throw error;
    }
    if (next.run_id !== projection.run_id) {
      throw new Error("The Host returned a different Run after plan approval");
    }
    await this.acceptProjection(next, {
      state: "live",
      message: "The approved plan is executing in the same Run",
      lastSequence: next.last_sequence,
    });
    if (!isStreamSettled(next)) this.startStream(next.run_id, next.last_sequence);
  }

  async updateTodo(input: TodoWriteInput): Promise<void> {
    this.assertLiveWritable("Updating a Todo");
    const projection = this.requireProjection();
    assertTodoUpdatesAvailable(projection.status);
    const safeInput = TodoWriteInputSchema.parse(input);
    if (safeInput.operation !== "update") {
      throw new Error("The Web workbench accepts user Todo updates only");
    }
    await this.sdk.writeTodo(projection.run_id, {
      command_id: commandId(),
      input: safeInput,
    });
    const next = await this.sdk.getRun(projection.run_id);
    if (next.run_id !== projection.run_id) {
      throw new Error("The Host returned a different Run after the Todo update");
    }
    await this.acceptProjection(next, {
      state: "live",
      message: "Todo update recorded in the Run ledger",
      lastSequence: next.last_sequence,
    });
  }

  async createTeam(): Promise<void> {
    this.assertLiveWritable("Creating an Agent Team");
    const projection = this.requireProjection();
    assertTeamUpdatesAvailable(projection.status);
    if (projection.team !== undefined) throw new Error("This Run already has an Agent Team");
    if (!this.sdk.createTeam) throw new Error("This Host does not support Agent Teams");
    const attemptKey = JSON.stringify([projection.run_id, "create"]);
    const command = this.pendingTeamAttempts.get(attemptKey) ?? commandId();
    this.pendingTeamAttempts.set(attemptKey, command);
    const generation = this.viewGeneration;
    const result = TeamMutationResultSchema.parse(await this.sdk.createTeam(projection.run_id, {
      command_id: command,
    }));
    if (result.command_id !== command || result.team.coordinator_run_id !== projection.run_id) {
      throw new Error("The Host returned Agent Team state outside the selected Run");
    }
    await this.refreshAfterTeamMutation(projection.run_id, generation, "Agent Team created in the Run ledger");
    this.pendingTeamAttempts.delete(attemptKey);
  }

  async steerTeamMember(subagentId: string, payload: string): Promise<void> {
    this.assertLiveWritable("Steering a Team member");
    const projection = this.requireProjection();
    assertTeamUpdatesAvailable(projection.status);
    const member = projection.team?.roster.members.find(({ link }) => link.subagent_id === subagentId);
    if (member?.status !== "active") throw new Error("The selected Team member is no longer active");
    if (!this.sdk.sendTeamMailbox) throw new Error("This Host does not support Agent Team mailboxes");
    const attemptKey = JSON.stringify([projection.run_id, "steer", subagentId, payload]);
    const command = this.pendingTeamAttempts.get(attemptKey) ?? commandId();
    this.pendingTeamAttempts.set(attemptKey, command);
    const generation = this.viewGeneration;
    const result = TeamMutationResultSchema.parse(await this.sdk.sendTeamMailbox(projection.run_id, {
      command_id: command,
      input: { to: subagentId, kind: "steer", payload },
    }));
    if (result.command_id !== command || result.team.coordinator_run_id !== projection.run_id) {
      throw new Error("The Host returned Agent Team state outside the selected Run");
    }
    await this.refreshAfterTeamMutation(projection.run_id, generation, "Durable Team steer message delivered");
    this.pendingTeamAttempts.delete(attemptKey);
  }

  async cancelTeamTask(task: import("@tracegraph/contracts").TaskBoardItem): Promise<void> {
    this.assertLiveWritable("Cancelling a Team task");
    const projection = this.requireProjection();
    assertTeamUpdatesAvailable(projection.status);
    const current = projection.team?.task_board.items.find(({ task_id: taskId }) => taskId === task.task_id);
    if (current === undefined || current.version !== task.version) throw new Error("The Team task revision changed");
    if (!this.sdk.writeTeamTask) throw new Error("This Host does not support Agent Team tasks");
    const attemptKey = JSON.stringify([projection.run_id, "cancel", task.task_id, task.version]);
    const command = this.pendingTeamAttempts.get(attemptKey) ?? commandId();
    this.pendingTeamAttempts.set(attemptKey, command);
    const generation = this.viewGeneration;
    const result = TeamMutationResultSchema.parse(await this.sdk.writeTeamTask(projection.run_id, {
      command_id: command,
      input: {
        operation: "cancel",
        task_id: task.task_id,
        expected_version: task.version,
        reason: "Cancelled by the user in TraceGraph Web",
      },
    }));
    if (result.command_id !== command || result.team.coordinator_run_id !== projection.run_id) {
      throw new Error("The Host returned Agent Team state outside the selected Run");
    }
    await this.refreshAfterTeamMutation(projection.run_id, generation, "Shared Team task cancelled");
    this.pendingTeamAttempts.delete(attemptKey);
  }

  async submitUserInput(kind: UserInputKind, body: string): Promise<void> {
    this.assertLiveWritable("Submitting Run input");
    if (this.snapshot.connection.state === "reconnecting") {
      throw new Error("Steering is unavailable while reconnecting to the Host");
    }
    const projection = this.requireProjection();
    assertSteeringAvailable(projection.status);
    const attemptKey = JSON.stringify([projection.run_id, kind, body]);
    const attempt = this.pendingUserInputAttempts.get(attemptKey) ?? {
      commandId: commandId(),
      inputId: inputId(),
    };
    this.pendingUserInputAttempts.set(attemptKey, attempt);
    const result = await this.sdk.submitUserInput(projection.run_id, {
      command_id: attempt.commandId,
      input_id: attempt.inputId,
      kind,
      body,
    });
    if (result.input.run_id !== projection.run_id || result.input.kind !== kind) {
      throw new Error("The Host returned steering input for a different Run");
    }
    if (this.projection?.run_id !== projection.run_id) {
      // The durable command may have succeeded after the user navigated away.
      // Do not use its late response to reclaim the current workbench.
      this.pendingUserInputAttempts.delete(attemptKey);
      return;
    }
    const next = await this.sdk.getRun(projection.run_id);
    if (next.run_id !== projection.run_id) {
      throw new Error("The Host returned a different Run after steering input");
    }
    if (this.projection?.run_id !== projection.run_id) {
      this.pendingUserInputAttempts.delete(attemptKey);
      return;
    }
    await this.acceptProjection(next, {
      state: "live",
      message: kind === "cancel"
        ? "Cancellation queued for the next safe boundary"
        : "Input queued for the next model step",
      lastSequence: next.last_sequence,
    });
    this.pendingUserInputAttempts.delete(attemptKey);
  }

  async approve(approvalId: string): Promise<void> {
    this.assertLiveWritable("Approving an Action");
    const projection = this.requireProjection();
    const pending = projection.pending_approval;
    if (!pending || pending.approval_id !== approvalId) throw new Error("Approval is no longer pending");
    if (!this.snapshot.run?.approval?.reviewReady || this.snapshot.evidence.diff.status !== "available") {
      throw new Error("The complete PatchPreview Artifact must be verified before approval");
    }
    const next = await this.sdk.approve(projection.run_id, {
      type: "approve",
      command_id: commandId(),
      project_id: projection.project_id,
      run_id: projection.run_id,
      approval_id: pending.approval_id,
      action_id: pending.action_id,
    });
    await this.acceptProjection(next, { state: "live", message: "Approval committed by the Host", lastSequence: next.last_sequence });
  }

  async reject(approvalId: string): Promise<void> {
    this.assertLiveWritable("Rejecting an Action");
    const projection = this.requireProjection();
    const pending = projection.pending_approval;
    if (!pending || pending.approval_id !== approvalId) throw new Error("Approval is no longer pending");
    const next = await this.sdk.reject(projection.run_id, {
      type: "reject",
      command_id: commandId(),
      project_id: projection.project_id,
      run_id: projection.run_id,
      approval_id: pending.approval_id,
      action_id: pending.action_id,
      reason: "Rejected in TraceGraph Web",
    });
    await this.acceptProjection(next, { state: "live", message: "Patch rejected", lastSequence: next.last_sequence });
  }

  async stop(): Promise<void> {
    await this.submitUserInput("cancel", "");
  }

  async loadSubagent(subagentId: string): Promise<void> {
    await this.initialize();
    if (this.snapshot.replay !== undefined) {
      throw new Error("Child Run details are unavailable while viewing a replay snapshot");
    }
    const parent = this.requireProjection();
    const delegated = parent.subagents?.items.find(({ link }) => link.subagent_id === subagentId);
    if (delegated === undefined) throw new Error("The selected subagent is no longer linked to this Run");
    if (!this.sdk.getSubagent) throw new Error("This Host SDK does not support subagent child Run reads");
    const generation = this.subagentCacheGeneration;
    const cacheKey = subagentCacheKey(parent.run_id, subagentId);
    if (this.subagentDetails.get(cacheKey)?.state === "loading") return;
    this.subagentDetails.set(cacheKey, { state: "loading" });
    this.commit(withSubagentDetails(this.snapshot, parent.run_id, this.subagentDetails));

    try {
      const child = await this.sdk.getSubagent(parent.run_id, subagentId);
      if (
        child.run_id !== delegated.link.child_run_id
        || child.session_id !== delegated.link.child_session_id
        || child.project_id !== parent.project_id
      ) {
        throw new Error("The Host returned a child Run outside the delegated relation");
      }
      if (
        generation !== this.subagentCacheGeneration
        || this.snapshot.replay !== undefined
        || this.projection?.run_id !== parent.run_id
      ) return;
      this.subagentDetails.set(cacheKey, {
        state: "available",
        run: mapSubagentChildRun(child),
      });
    } catch (error) {
      if (
        generation !== this.subagentCacheGeneration
        || this.snapshot.replay !== undefined
        || this.projection?.run_id !== parent.run_id
      ) return;
      this.subagentDetails.set(cacheKey, { state: "error", message: publicMessage(error) });
    }
    this.commit(withSubagentDetails(this.snapshot, parent.run_id, this.subagentDetails));
  }

  async loadAttachment(attachmentId: string): Promise<AttachmentPreviewContent> {
    await this.initialize();
    if (this.snapshot.replay !== undefined) {
      throw new Error("Attachment previews are unavailable while viewing a replay snapshot");
    }
    const projection = this.requireProjection();
    const projected = projection.attachments.items.find((item) => (
      item.status !== "rejected" && item.attachment.attachment_id === attachmentId
    ));
    if (projected === undefined || projected.status === "rejected") {
      throw new Error("The selected attachment is no longer related to this Run");
    }
    if (!this.sdk.getAttachmentContent) {
      throw new Error("This Host SDK does not support attachment content reads");
    }
    const content = await this.sdk.getAttachmentContent(projection.run_id, attachmentId);
    if (
      content.attachmentId !== attachmentId
      || content.mediaType !== projected.attachment.media_type
      || content.sha256 !== projected.attachment.sha256
      || content.bytes.byteLength !== projected.attachment.bytes
    ) {
      throw new Error("The Host returned attachment bytes outside the canonical Run relation");
    }
    return { mediaType: content.mediaType, bytes: content.bytes };
  }

  async enterReplay(sequence: number): Promise<void> {
    await this.initialize();
    const liveProjection = this.requireProjection();
    if (!this.sdk.createReplay) throw new Error("This Host SDK does not support durable replay");
    const sessionId = liveProjection.session_id ?? this.selectedSessionId;
    if (!sessionId) throw new Error("Replay requires a durable Session binding");
    const currentReplay = this.snapshot.replay;
    const availableSequences = currentReplay?.availableSequences
      ?? liveProjection.timeline.map((event) => event.sequence);
    if (!Number.isInteger(sequence) || !availableSequences.includes(sequence)) {
      throw new Error("Replay sequence must identify a canonical event in the current Run");
    }
    const diffFromSequence = currentReplay?.requestedSequence
      ?? previousReplaySequence(availableSequences, sequence);

    const generation = ++this.viewGeneration;
    this.stopStream();
    // Re-fetch historical bytes under the Host-issued replay capability. A
    // live-authority cache entry must not silently bypass replay scope.
    this.artifactCache.clear();
    this.clearSubagentDetails();
    this.commit({
      ...this.snapshot,
      replay: {
        state: "loading",
        runId: liveProjection.run_id,
        requestedSequence: sequence,
        headSequence: currentReplay?.headSequence ?? liveProjection.last_sequence,
        availableSequences,
      },
    });

    const operation = this.replayTransition.then(() => this.performEnterReplay({
      generation,
      liveProjection,
      sessionId,
      sequence,
      diffFromSequence,
      availableSequences,
    }));
    this.replayTransition = operation.catch(() => undefined);
    return operation;
  }

  async stepReplay(direction: -1 | 1): Promise<void> {
    const replay = this.snapshot.replay;
    if (!replay || replay.state === "restoring") return;
    const target = adjacentReplaySequence(
      replay.availableSequences,
      replay.requestedSequence,
      direction,
    );
    if (target !== null) await this.enterReplay(target);
  }

  async returnToLive(): Promise<void> {
    const replay = this.snapshot.replay;
    if (!replay) return;
    const generation = ++this.viewGeneration;
    this.stopStream();
    this.commit({
      ...this.snapshot,
      replay: { ...replay, state: "restoring" },
    });
    const operation = this.replayTransition.then(() => this.performReturnToLive(
      replay.runId,
      generation,
    ));
    this.replayTransition = operation.catch(() => undefined);
    return operation;
  }

  async previewState(status: RunStatus): Promise<void> {
    // The only live-mode action exposed through this seam is an explicit SSE
    // retry. Prototype state switching remains demo-only.
    if (status === "running" && this.projection && !isTerminal(this.projection)) {
      this.startStream(this.projection.run_id);
    }
  }

  private async performEnterReplay(input: {
    generation: number;
    liveProjection: RunProjection;
    sessionId: string;
    sequence: number;
    diffFromSequence: number;
    availableSequences: readonly number[];
  }): Promise<void> {
    if (input.generation !== this.viewGeneration) return;
    try {
      const response = parseReplaySession(await this.sdk.createReplay!({
        session_id: input.sessionId,
        run_id: input.liveProjection.run_id,
        until_sequence: input.sequence,
      }));
      if (input.generation !== this.viewGeneration) {
        return;
      }
      if (
        response.snapshot.projection.run_id !== input.liveProjection.run_id
        || response.snapshot.projection.last_sequence !== input.sequence
      ) {
        throw new Error("The Host returned a replay snapshot for a different Run or sequence");
      }

      const diff = this.sdk.getReplayDiff
        ? mapReplayDiff(
            await this.sdk.getReplayDiff({
              from: input.diffFromSequence,
              to: input.sequence,
            }),
            response.snapshot.projection,
            input.diffFromSequence,
            input.sequence,
            response.snapshot.projectionHash,
          )
        : undefined;
      if (input.generation !== this.viewGeneration) {
        return;
      }

      const replay: ReplayViewState = {
        state: "active",
        runId: input.liveProjection.run_id,
        requestedSequence: input.sequence,
        headSequence: response.snapshot.headSequence,
        availableSequences: input.availableSequences,
        projectionHash: response.snapshot.projectionHash,
        expiresAt: response.expiresAt,
        ...(diff === undefined ? {} : { diff }),
      };
      const project = this.projects.find(({ project_id: projectId }) => (
        projectId === response.snapshot.projection.project_id
      ));
      const conversationKey = project?.project_id ?? PLAIN_CHAT_KEY;
      const mapped = mapProjection(
        response.snapshot.projection,
        project,
        {
          state: "live",
          message: `Read-only replay at durable event #${input.sequence}`,
          lastSequence: input.liveProjection.last_sequence,
        },
        TodoListSchema.parse(response.snapshot.projection.todos),
      );
      const base: WorkbenchSnapshot = {
        ...mapped,
        availableProjects: this.projects.map(mapProject),
        sessions: this.sessions,
        selectedSessionId: this.selectedSessionId,
        sessionViewState: this.sessionViewState,
        recovery: this.recovery,
        conversation: (this.conversations.get(conversationKey) ?? []).filter((turn) => (
          turn.runId !== input.liveProjection.run_id
        )),
        replay,
      };
      this.commit(base);
      const hydrated = await hydrateProjection(
        this.sdk,
        response.snapshot.projection,
        base,
        this.artifactCache,
      );
      if (input.generation === this.viewGeneration && this.snapshot.replay?.requestedSequence === input.sequence) {
        this.commit({ ...hydrated, replay });
      }
    } catch (error) {
      // A newer replay request owns the SDK authority now. Let its queued
      // transition rotate or restore the token; the obsolete Promise must not
      // surface an error into the newer view or exit its capability.
      if (input.generation !== this.viewGeneration) return;
      await this.performReturnToLive(input.liveProjection.run_id, input.generation);
      throw error;
    }
  }

  private async performReturnToLive(runId: string, generation: number): Promise<void> {
    this.sdk.exitReplay?.();
    this.artifactCache.clear();
    this.clearSubagentDetails();
    const projection = await this.sdk.getRun(runId);
    if (generation !== this.viewGeneration) return;
    this.commit(withoutReplay(this.snapshot));
    await this.acceptProjection(projection, {
      state: "live",
      message: "Returned to the current durable projection",
      lastSequence: projection.last_sequence,
    });
    if (generation !== this.viewGeneration) return;
    if (!isStreamSettled(projection)) this.startStream(projection.run_id, projection.last_sequence);
  }

  private async bootstrap(): Promise<void> {
    try {
      const bootstrap = await this.sdk.bootstrap();
      this.recovery = bootstrap.recovery ?? null;
      const [projects, sessionResponse] = await Promise.all([
        this.sdk.listProjects(),
        this.sdk.listSessions?.({ limit: 50, view: "roots" }) ?? Promise.resolve({ sessions: [] }),
      ]);
      this.projects = projects;
      this.sessions = sessionResponse.sessions;
      this.commit({
        ...emptyLiveSnapshot({
          state: "live",
          message: this.projects.length > 0 ? "Connected to the local Host" : "Connected, but the Host has no registered projects",
          lastSequence: 0,
        }),
        availableProjects: this.projects.map(mapProject),
        sessions: this.sessions,
        selectedSessionId: null,
        sessionViewState: null,
        recovery: this.recovery,
      });
    } catch (error) {
      this.commit({
        ...this.snapshot,
        connection: { state: "offline", message: publicMessage(error), lastSequence: this.snapshot.connection.lastSequence },
      });
    }
  }

  private projection: RunProjection | null = null;

  private async refreshSessions(): Promise<void> {
    if (!this.sdk.listSessions) return;
    const response = await this.sdk.listSessions({
      limit: 50,
      view: "roots",
      ...(this.selectedProjectId === null ? {} : { project_id: this.selectedProjectId }),
      ...(this.sessionQuery ? { q: this.sessionQuery } : {}),
    });
    this.sessions = response.sessions;
    this.commit({
      ...this.snapshot,
      sessions: this.sessions,
      selectedSessionId: this.selectedSessionId,
      sessionViewState: this.sessionViewState,
      recovery: this.recovery,
    });
  }

  private async acceptProjection(projection: RunProjection, connection: ConnectionSnapshot): Promise<void> {
    const viewGeneration = this.viewGeneration;
    const current = this.projection;
    if (
      current?.run_id === projection.run_id
      && projection.last_sequence < current.last_sequence
    ) {
      // Concurrent HTTP refreshes can resolve out of order. Never let an
      // older canonical snapshot resurrect a Run after a newer terminal (or
      // otherwise more advanced) projection has already been accepted.
      return;
    }
    if (current?.run_id === projection.run_id) {
      const previousById = new Map(
        current.subagents.items.map((subagent) => [subagent.link.subagent_id, subagent] as const),
      );
      let invalidated = false;
      for (const subagent of projection.subagents.items) {
        const previous = previousById.get(subagent.link.subagent_id);
        if (
          previous !== undefined
          && (
            previous.status !== subagent.status
            || previous.message_count !== subagent.message_count
            || previous.finished_at !== subagent.finished_at
          )
        ) {
          this.subagentDetails.delete(subagentCacheKey(projection.run_id, subagent.link.subagent_id));
          invalidated = true;
        }
      }
      if (invalidated) this.subagentCacheGeneration += 1;
    }
    this.projection = projection;
    // A command or HTTP refresh may have started just before time travel. Keep
    // the newer live authority for the eventual return, but never let its
    // presentation reclaim a replay view.
    if (this.snapshot.replay !== undefined) return;
    const project = this.projects.find((candidate) => candidate.project_id === projection.project_id);
    this.plainChatActive = project === undefined;
    this.selectedProjectId = project?.project_id ?? null;
    if (projection.session_id !== undefined) this.selectedSessionId = projection.session_id;
    const conversationKey = project?.project_id ?? PLAIN_CHAT_KEY;
    const mapped = withSubagentDetails(
      mapProjection(projection, project, connection, TodoListSchema.parse(projection.todos)),
      projection.run_id,
      this.subagentDetails,
    );
    const publicActivities = this.liveActivities.get(projection.run_id) ?? [];
    const modelSurface = this.modelSurface.get(projection.run_id) ?? [];
    const base = {
      ...mapped,
      run: mapped.run === null
        ? null
        : {
          ...mapped.run,
          ...(publicActivities.length === 0 ? {} : { publicActivities }),
          ...(modelSurface.length === 0 ? {} : { modelSurface }),
        },
      availableProjects: this.projects.map(mapProject),
      sessions: this.sessions,
      selectedSessionId: this.selectedSessionId,
      sessionViewState: this.sessionViewState,
      recovery: this.recovery,
      conversation: this.conversations.get(conversationKey) ?? [],
    };
    this.commit(base);
    const hydrated = await hydrateProjection(this.sdk, projection, base, this.artifactCache);
    if (
      viewGeneration === this.viewGeneration
      && this.snapshot.replay === undefined
      && this.projection?.run_id === projection.run_id
      && this.projection.last_sequence === projection.last_sequence
    ) {
      const latestPublicActivities = this.liveActivities.get(projection.run_id) ?? [];
      const latestModelSurface = this.modelSurface.get(projection.run_id) ?? [];
      this.commit({
        ...hydrated,
        run: hydrated.run === null
          ? null
          : {
            ...hydrated.run,
            ...(latestPublicActivities.length === 0 ? {} : { publicActivities: latestPublicActivities }),
            ...(latestModelSurface.length === 0 ? {} : { modelSurface: latestModelSurface }),
          },
      });
    }
  }

  private startStream(runId: string, liveAfterSequence = 0): void {
    if (this.snapshot.replay !== undefined) return;
    this.stopStream();
    const controller = new AbortController();
    const generation = ++this.streamGeneration;
    this.streamController = controller;
    void this.consumeLiveProcess(runId, controller, generation, liveAfterSequence);
    void this.consumeModelSurface(runId, controller, generation);
    void this.consumeStream(runId, controller, generation);
  }

  /**
   * Fast UI-only feed: it is intentionally independent of projection reloads
   * so a user can see an in-flight request/tool immediately. The durable SSE
   * stream below remains the only authority for a final RunProjection.
   */
  private async consumeLiveProcess(
    runId: string,
    controller: AbortController,
    generation: number,
    afterSequence: number,
  ): Promise<void> {
    if (!this.sdk.streamLiveActivities) return;
    try {
      for await (const activity of this.sdk.streamLiveActivities(runId, {
        afterSequence,
        signal: controller.signal,
        reconnect: true,
      })) {
        if (controller.signal.aborted || generation !== this.streamGeneration) return;
        this.recordLiveActivity(runId, activity);
        if (activity.source_event_type === "run.completed" || activity.source_event_type === "run.failed" || activity.source_event_type === "run.cancelled" || activity.source_event_type === "run.interrupted" || activity.source_event_type === "action.diverged") return;
      }
    } catch {
      // The durable projection stream owns connection state and retry UI. A
      // transient presentation stream failure must never mark a Run failed.
    }
  }

  /**
   * Dedicated provider-derived public text stream. Unlike the execution feed,
   * these snapshots are not projected from ledger events and are never used
   * as the authority for a tool call or final Run state.
   */
  private async consumeModelSurface(runId: string, controller: AbortController, generation: number): Promise<void> {
    if (!this.sdk.streamModelSurface) return;
    try {
      for await (const event of this.sdk.streamModelSurface(runId, {
        afterCursor: 0,
        signal: controller.signal,
        reconnect: true,
      })) {
        if (controller.signal.aborted || generation !== this.streamGeneration) return;
        this.recordModelSurface(runId, event);
      }
    } catch {
      // The durable event stream owns overall connection state. A transient
      // model-surface failure must not mark an otherwise valid Run as failed.
    }
  }

  private async consumeStream(runId: string, controller: AbortController, generation: number): Promise<void> {
    let retryMs = this.minRetryMs;
    let afterSequence = this.projection?.last_sequence ?? 0;
    while (!controller.signal.aborted && generation === this.streamGeneration) {
      try {
        const statusBeforeRefresh = this.projection?.status;
        const refreshed = await this.sdk.getRun(runId);
        if (controller.signal.aborted || generation !== this.streamGeneration) return;
        afterSequence = Math.max(afterSequence, refreshed.last_sequence);
        await this.acceptProjection(refreshed, { state: "live", message: "Live event stream connected", lastSequence: afterSequence });
        if (resumedExternallyApprovedPlan(statusBeforeRefresh, refreshed)) {
          void this.consumeLiveProcess(runId, controller, generation, refreshed.last_sequence);
        }
        if (isStreamSettled(refreshed)) {
          if (this.streamController === controller) this.stopStream();
          return;
        }
        retryMs = this.minRetryMs;
        for await (const event of this.sdk.streamEvents(runId, {
          afterSequence,
          signal: controller.signal,
          reconnect: false,
        })) {
          afterSequence = Math.max(afterSequence, event.sequence);
          const previousStatus = this.projection?.status;
          const projection = await this.sdk.getRun(runId);
          if (controller.signal.aborted || generation !== this.streamGeneration) return;
          afterSequence = Math.max(afterSequence, projection.last_sequence);
          await this.acceptProjection(projection, { state: "live", message: "Live event stream connected", lastSequence: afterSequence });
          if (resumedExternallyApprovedPlan(previousStatus, projection)) {
            // The plan-stage public feed already ended at plan.ready. Start a
            // new low-latency feed from the approved durable cursor without
            // interrupting or duplicating this canonical event stream.
            void this.consumeLiveProcess(runId, controller, generation, projection.last_sequence);
          }
          if (isStreamSettled(projection)) {
            if (this.streamController === controller) this.stopStream();
            return;
          }
        }
        if (!controller.signal.aborted) throw new Error("The event stream closed before the run reached a terminal state");
      } catch (error) {
        if (controller.signal.aborted || generation !== this.streamGeneration) return;
        const stableRun = this.snapshot.run;
        this.commit({
          ...this.snapshot,
          connection: { state: "reconnecting", message: publicMessage(error), lastSequence: afterSequence },
          run: stableRun ? { ...stableRun, status: "reconnecting", lastSequence: afterSequence } : null,
        });
        await delay(retryMs, controller.signal);
        retryMs = Math.min(this.maxRetryMs, retryMs * 2);
      }
    }
  }

  private stopStream(): void {
    this.streamController?.abort();
    this.streamController = null;
    this.streamGeneration += 1;
  }

  private recordLiveActivity(runId: string, activity: LivePublicActivity): void {
    const current = this.liveActivities.get(runId) ?? [];
    if (current.some((item) => item.sourceEventId === activity.source_event_id)) return;
    const next = [...current, mapLiveActivity(activity)].slice(-96);
    this.liveActivities.set(runId, next);
    if (this.snapshot.replay !== undefined || this.snapshot.run?.id !== runId) return;
    this.commit({
      ...this.snapshot,
      run: { ...this.snapshot.run, publicActivities: next },
    });
  }

  private recordModelSurface(runId: string, event: ModelSurfaceEvent): void {
    const current = this.modelSurface.get(runId) ?? [];
    const nextSnapshot = mapModelSurface(event);
    // Provider-native reasoning is a private scratchpad.  Older Hosts may
    // still emit the legacy wire type, so reject it at the client boundary as
    // well as in Runtime and the React renderer.
    if (nextSnapshot.type === "thinking_snapshot") return;
    // Each newer snapshot supersedes the same model-call surface. Keeping the
    // reducer keyed this way makes reconnects idempotent and avoids a React
    // entry for every provider token.
    const keyMatches = (item: ModelSurfaceSnapshot): boolean =>
      item.modelCallId === nextSnapshot.modelCallId && item.type === nextSnapshot.type;
    const existing = current.find(keyMatches);
    const next = existing && existing.cursor >= nextSnapshot.cursor
      ? current
      : [...current.filter((item) => !keyMatches(item)), nextSnapshot]
        .sort((left, right) => left.cursor - right.cursor)
        .slice(-24);
    this.modelSurface.set(runId, next);
    if (this.snapshot.replay !== undefined || this.snapshot.run?.id !== runId || next === current) return;
    this.commit({
      ...this.snapshot,
      run: { ...this.snapshot.run, modelSurface: next },
    });
  }

  private archiveCurrentRun(): void {
    const run = this.snapshot.run;
    const conversationKey = this.snapshot.project?.id ?? (this.plainChatActive ? PLAIN_CHAT_KEY : undefined);
    if (!run || !conversationKey || !isTerminalStatus(run.status)) return;
    const turns = this.conversations.get(conversationKey) ?? [];
    if (turns.some((turn) => turn.runId === run.id)) return;
    this.conversations.set(conversationKey, [...turns, {
      runId: run.id,
      task: run.task,
      status: run.status,
      response: run.outcome ?? run.currentStep,
      events: run.events,
      ...(run.elapsed === undefined ? {} : { elapsed: run.elapsed }),
      ...(run.inputTokens === undefined ? {} : { inputTokens: run.inputTokens }),
      ...(run.contextBudget?.providerUsage?.totalTokens === undefined ? {} : { totalTokens: run.contextBudget.providerUsage.totalTokens }),
    }]);
  }

  private requireSelectedProject(): ProjectSummary {
    const project = this.projects.find((candidate) => candidate.project_id === this.selectedProjectId);
    if (!project) throw new Error("Select a Host-registered project before starting a run");
    return project;
  }

  private requireProjection(): RunProjection {
    if (!this.projection) throw new Error("There is no active Host run");
    return this.projection;
  }

  private assertLiveWritable(action: string): void {
    if (this.snapshot.replay !== undefined) {
      throw new Error(`${action} is unavailable while viewing a read-only replay snapshot`);
    }
  }

  private async refreshAfterTeamMutation(runId: string, generation: number, message: string): Promise<void> {
    if (generation !== this.viewGeneration || this.snapshot.replay !== undefined || this.projection?.run_id !== runId) return;
    const next = await this.sdk.getRun(runId);
    if (next.run_id !== runId) throw new Error("The Host returned a different Run after the Team mutation");
    if (generation !== this.viewGeneration || this.snapshot.replay !== undefined || this.projection?.run_id !== runId) return;
    await this.acceptProjection(next, { state: "live", message, lastSequence: next.last_sequence });
  }

  private clearSubagentDetails(): void {
    this.subagentCacheGeneration += 1;
    this.subagentDetails.clear();
  }

  private commit(snapshot: WorkbenchSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}

function parseReplaySession(value: unknown): {
  replayId: string;
  expiresAt: string;
  snapshot: { projection: RunProjection; projectionHash: string; headSequence: number };
} {
  const response = unknownRecord(value, "Replay response");
  const snapshot = unknownRecord(response.snapshot, "Replay snapshot");
  const replayId = requiredString(response.replay_id, "Replay id");
  const expiresAt = requiredString(response.expires_at, "Replay expiry");
  const projectionHash = requiredString(
    snapshot.projection_hash ?? snapshot.snapshot_hash,
    "Replay projection hash",
  );
  const headSequence = nonNegativeInteger(snapshot.head_sequence);
  if (headSequence === undefined || headSequence < 1) throw new TypeError("Replay head sequence is missing");
  return {
    replayId,
    expiresAt,
    snapshot: {
      projection: RunProjectionSchema.parse(snapshot.projection),
      projectionHash,
      headSequence,
    },
  };
}

function mapReplayDiff(
  value: unknown,
  projection: RunProjection,
  fallbackFromSequence: number,
  fallbackToSequence: number,
  fallbackProjectionHash: string,
): ReplayDiffSnapshot {
  const diff = unknownRecord(value, "Replay diff");
  const evidence = optionalRecord(diff.evidence);
  const events = optionalRecord(diff.events);
  const tools = optionalRecord(diff.tool_results);
  const todos = optionalRecord(diff.todos);
  const approval = optionalRecord(diff.approval);
  const status = optionalRecord(diff.status);
  const mode = optionalRecord(diff.mode);
  const fromSequence = nonNegativeInteger(diff.from_sequence) ?? fallbackFromSequence;
  const toSequence = nonNegativeInteger(diff.to_sequence) ?? fallbackToSequence;
  const contractAddedEvents = mapReplayEvents(events?.added, projection.status);
  const addedEvents = contractAddedEvents.length > 0 || fromSequence >= toSequence
    ? contractAddedEvents
    : projection.timeline
        .filter((event) => event.sequence > fromSequence && event.sequence <= toSequence)
        .map((event) => mapWireEvent(event, projection.status));
  const removedEvents = mapReplayEvents(events?.removed, projection.status);
  const toolResults = [
    ...mapReplayToolResults(tools?.added, projection.status, "added"),
    ...mapReplayToolResults(tools?.removed, projection.status, "removed"),
  ];
  const todoChanges: ReplayDiffSnapshot["todoChanges"] = [
    ...unknownArray(todos?.added).flatMap((entry) => mapReplayTodo(entry, "added")),
    ...unknownArray(todos?.removed).flatMap((entry) => mapReplayTodo(entry, "removed")),
    ...unknownArray(todos?.changed).flatMap((entry) => {
      const change = optionalRecord(entry);
      const before = optionalRecord(change?.before);
      const after = optionalRecord(change?.after);
      const todoId = optionalString(after?.todo_id) ?? optionalString(before?.todo_id);
      const title = optionalString(after?.title) ?? optionalString(before?.title);
      if (todoId === undefined || title === undefined) return [];
      const beforeState = optionalString(before?.state);
      const afterState = optionalString(after?.state);
      return [{
        todoId,
        title,
        kind: "changed" as const,
        ...(beforeState === undefined ? {} : { beforeState }),
        ...(afterState === undefined ? {} : { afterState }),
      }];
    }),
  ];
  return {
    fromSequence,
    toSequence,
    fromProjectionHash: optionalString(diff.from_snapshot_hash) ?? fallbackProjectionHash,
    toProjectionHash: optionalString(diff.to_snapshot_hash) ?? fallbackProjectionHash,
    addedEvents,
    removedEvents,
    addedEvidenceCount: unknownArray(evidence?.added).length,
    removedEvidenceCount: unknownArray(evidence?.removed).length,
    toolResults,
    todoChanges,
    approvalChanged: typeof approval?.changed === "boolean"
      ? approval.changed
      : JSON.stringify(approval?.before) !== JSON.stringify(approval?.after),
    statusBefore: optionalString(status?.before) ?? projection.status,
    statusAfter: optionalString(status?.after) ?? projection.status,
    modeBefore: optionalString(mode?.before) ?? projection.mode,
    modeAfter: optionalString(mode?.after) ?? projection.mode,
  };
}

function mapReplayEvents(value: unknown, runStatus: RunProjection["status"]): TraceEvent[] {
  return unknownArray(value).flatMap((entry) => {
    const parsed = WireSessionEventSchema.safeParse(entry);
    return parsed.success ? [mapWireEvent(parsed.data, runStatus)] : [];
  });
}

function mapReplayToolResults(
  value: unknown,
  runStatus: RunProjection["status"],
  kind: "added" | "removed",
): ReplayDiffSnapshot["toolResults"] {
  return unknownArray(value).flatMap((entry) => {
    const parsed = WireSessionEventSchema.safeParse(entry);
    if (!parsed.success) return [];
    const mapped = mapWireEvent(parsed.data, runStatus);
    return [{
      kind,
      eventId: mapped.id,
      sequence: mapped.sequence,
      type: parsed.data.type,
      summary: mapped.summary,
      ...(mapped.toolName === undefined ? {} : { toolName: mapped.toolName }),
    }];
  });
}

function mapReplayTodo(value: unknown, kind: "added" | "removed"): ReplayDiffSnapshot["todoChanges"] {
  const todo = optionalRecord(value);
  const todoId = optionalString(todo?.todo_id);
  const title = optionalString(todo?.title);
  if (todoId === undefined || title === undefined) return [];
  const state = optionalString(todo?.state);
  return [{
    todoId,
    title,
    kind,
    ...(kind === "removed"
      ? (state === undefined ? {} : { beforeState: state })
      : (state === undefined ? {} : { afterState: state })),
  }];
}

function previousReplaySequence(sequences: readonly number[], current: number): number {
  return adjacentReplaySequence(sequences, current, -1) ?? current;
}

function withoutReplay(snapshot: WorkbenchSnapshot): WorkbenchSnapshot {
  const { replay: _replay, ...live } = snapshot;
  return live;
}

function unknownRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function unknownArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} is missing`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function mapProject(project: ProjectSummary): ProjectSnapshot {
  return {
    id: project.project_id,
    name: project.label,
    pathLabel: project.location?.display_path ?? (project.workspace_kind === "readonly_local" ? "Host-managed · read-only" : project.workspace_kind === "managed_local" ? "Host-managed · persistent project" : "Host-managed · disposable fixture"),
    workspaceKind: project.workspace_kind,
    ...(project.location === undefined ? {} : {
      location: {
        kind: project.location.kind,
        displayPath: project.location.display_path,
        canReveal: project.location.can_reveal,
        access: project.location.access,
      },
    }),
  };
}

function mapProjection(
  projection: RunProjection,
  projectSummary: ProjectSummary | undefined,
  connection: ConnectionSnapshot,
  todoList: TodoList,
): WorkbenchSnapshot {
  const events = projection.timeline.map((event) => {
    const mapped = mapWireEvent(event, projection.status);
    return mapped.kind === "sandbox"
      && mapped.sandboxReport === undefined
      && projection.sandbox_report !== undefined
      ? { ...mapped, sandboxReport: projection.sandbox_report }
      : mapped;
  });
  const contextEvent = highestSequenceEvent(
    projection.timeline,
    (event) => event.type === "context.built",
  );
  const createdEvent = projection.timeline.find((event) => event.type === "run.created");
  const inputTokens = numberValue(contextEvent?.data.input_tokens);
  const tokenLimit = numberValue(contextEvent?.data.token_limit);
  const reservedOutput = numberValue(contextEvent?.data.reserved_output_tokens);
  const contextBudget = contextBudgetFromEvent(contextEvent, projection.timeline);
  const turnIds = new Set(
    projection.timeline
      .map((event) => event.turn_id)
      .filter((turnId): turnId is string => typeof turnId === "string" && turnId.length > 0),
  );
  const turnsCompleted = turnIds.size > 0 ? turnIds.size : undefined;
  const turnLimit = numberValue(createdEvent?.data.max_turns);
  const pending = projection.pending_approval;
  const inlineReview = { files: [], diffs: {} };
  const artifacts = latestArtifacts(projection.artifact_refs);
  const elapsedValue = elapsed(projection.timeline);
  const project = projectSummary ? mapProject(projectSummary) : null;
  const sandboxReport = projection.sandbox_report
    ?? [...events].reverse().find((event) => event.sandboxReport !== undefined)?.sandboxReport;
  const permission = projection.permission
    ?? [...events].reverse().find((event) => event.permission !== undefined)?.permission;
  const run: RunSnapshot = {
    id: projection.run_id,
    status: mapRunStatus(projection.status),
    mode: projection.mode,
    task: projection.task,
    ...(elapsedValue === undefined ? {} : { elapsed: elapsedValue }),
    currentStep: projection.timeline.at(-1)?.summary ?? "Run created",
    lastSequence: projection.last_sequence,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(tokenLimit === undefined ? {} : { tokenLimit }),
    ...(reservedOutput === undefined ? {} : { reservedOutput }),
    ...(turnsCompleted === undefined ? {} : { turnsCompleted }),
    ...(turnLimit === undefined ? {} : { turnLimit }),
    ...(sandboxReport === undefined ? {} : { sandboxReport }),
    ...(permission === undefined ? {} : { permission }),
    ...(projection.code_intel === undefined ? {} : { codeIntel: mapCodeIntelProjection(projection.code_intel) }),
    ...(contextBudget === undefined ? {} : { contextBudget }),
    events,
    todos: todoList.items,
    inputQueue: {
      pending: projection.input_queue.pending,
      ...(projection.input_queue.last_consumed === undefined
        ? {}
        : { lastConsumed: projection.input_queue.last_consumed }),
    },
    subagents: (projection.subagents?.items ?? []).map((subagent): SubagentSnapshot => ({
      id: subagent.link.subagent_id,
      name: subagent.name,
      status: subagent.status,
      childRunId: subagent.link.child_run_id,
      childSessionId: subagent.link.child_session_id,
      contextScope: subagent.context_scope,
      depth: subagent.depth,
      messageCount: subagent.message_count,
      startedAt: subagent.started_at,
      ...(subagent.finished_at === undefined ? {} : { finishedAt: subagent.finished_at }),
      ...(subagent.failure_reason === undefined ? {} : { failureReason: subagent.failure_reason }),
      ...(subagent.result?.summary === undefined ? {} : { resultSummary: subagent.result.summary }),
      budget: {
        maxSteps: subagent.budget.max_steps,
        maxTokens: subagent.budget.max_tokens,
      },
      detail: { state: "idle" },
    })),
    ...(projection.team === undefined ? {} : { team: projection.team }),
    attachments: projection.attachments.items.map((item): AttachmentSnapshot => {
      if (item.status === "rejected") {
        return {
          id: item.upload_id,
          status: "rejected",
          bytes: item.bytes,
          delivery: item.delivery,
          source: item.source,
          rejectionCode: item.code,
          reason: item.reason,
          ...(item.sniffed_media_type === undefined ? {} : { mediaType: item.sniffed_media_type }),
        };
      }
      const pdfExtraction = item.pdf_extraction.status === "extracted"
        ? {
            status: "extracted" as const,
            artifactId: item.pdf_extraction.artifact_id,
            characters: item.pdf_extraction.characters,
          }
        : item.pdf_extraction.status === "failed"
          ? {
              status: "failed" as const,
              code: item.pdf_extraction.code,
              reason: item.pdf_extraction.reason,
            }
          : { status: "not_applicable" as const };
      return {
        id: item.attachment.attachment_id,
        status: item.status,
        mediaType: item.attachment.media_type,
        bytes: item.attachment.bytes,
        delivery: item.delivery,
        source: item.attachment.source,
        sha256: item.attachment.sha256,
        pdfExtraction,
      };
    }),
    ...(projection.pending_plan === undefined ? {} : {
      pendingPlan: {
        eventId: projection.pending_plan.plan_event_id,
        todoIds: projection.pending_plan.todo_ids,
      },
    }),
    ...(pending ? { approval: mapApproval(pending) } : {}),
    ...(projection.outcome === undefined ? {} : { outcome: projection.outcome }),
  };
  return {
    dataSource: "live",
    connection,
    project,
    availableProjects: project ? [project] : [],
    sessions: [],
    selectedSessionId: null,
    sessionViewState: null,
    recovery: null,
    run,
    conversation: [],
    contextSources: [],
    changedFiles: inlineReview.files,
    diffs: inlineReview.diffs,
    graphNodes: [],
    graphEdges: [],
    evidence: {
      context: artifactSlot(artifacts.context, "Context Manifest"),
      diff: pending
        ? artifactSlot(pending.preview.artifact_ref ?? artifacts.diff, "complete PatchPreview")
        : artifactSlot(artifacts.diff, "Diff"),
      graph: artifactSlot(artifacts.graph, "Graph Delta"),
      test: artifactSlot(artifacts.test, "Test Log"),
    },
    eventEvidence: Object.fromEntries(events.map((event) => [
      event.id,
      emptyEventEvidence("Linked evidence is still loading."),
    ])),
  };
}

function mapSubagentChildRun(projection: RunProjection): SubagentChildRunSnapshot {
  return {
    id: projection.run_id,
    ...(projection.session_id === undefined ? {} : { sessionId: projection.session_id }),
    status: mapRunStatus(projection.status),
    task: projection.task,
    lastSequence: projection.last_sequence,
    events: projection.timeline.map((event) => mapWireEvent(event, projection.status)),
    ...(projection.outcome === undefined ? {} : { outcome: projection.outcome }),
  };
}

function subagentCacheKey(parentRunId: string, subagentId: string): string {
  return `${parentRunId}\u0000${subagentId}`;
}

function withSubagentDetails(
  snapshot: WorkbenchSnapshot,
  parentRunId: string,
  details: ReadonlyMap<string, SubagentSnapshot["detail"]>,
): WorkbenchSnapshot {
  if (snapshot.run?.id !== parentRunId) return snapshot;
  return {
    ...snapshot,
    run: {
      ...snapshot.run,
      subagents: snapshot.run.subagents.map((subagent) => ({
        ...subagent,
        detail: details.get(subagentCacheKey(parentRunId, subagent.id)) ?? subagent.detail,
      })),
    },
  };
}

async function hydrateProjection(
  sdk: TraceGraphSdkPort,
  projection: RunProjection,
  base: WorkbenchSnapshot,
  artifactCache: Map<string, Promise<ArtifactFetchResult>>,
): Promise<WorkbenchSnapshot> {
  const refs = latestArtifacts(projection.artifact_refs);
  const [contextResult, diffResult, graphResult, testResult] = await Promise.all([
    fetchArtifact(sdk, projection.run_id, refs.context, artifactCache),
    fetchArtifact(
      sdk,
      projection.run_id,
      projection.pending_approval?.preview.artifact_ref ?? refs.diff,
      artifactCache,
    ),
    fetchArtifact(sdk, projection.run_id, refs.graph, artifactCache),
    fetchArtifact(sdk, projection.run_id, refs.test, artifactCache),
  ]);

  let contextSources = base.contextSources;
  let contextSlot = base.evidence.context;
  let run = base.run;
  if (contextResult) {
    contextSlot = contextResult.slot;
    if (contextResult.content) {
      const parsed = parseJson(contextResult.content, ContextManifestSchema);
      if (parsed) {
        contextSources = mapContextSources(parsed);
        if (run) {
          const contextBudget = mapContextBudget(parsed, projection.timeline);
          run = {
            ...run,
            inputTokens: parsed.input_tokens,
            tokenLimit: parsed.token_limit,
            reservedOutput: parsed.reserved_output_tokens,
            ...(contextBudget === undefined ? {} : { contextBudget }),
          };
        }
      }
      else contextSlot = { ...contextSlot, status: "unavailable", message: "Context Artifact did not match ContextManifestSchema" };
    }
  }

  let changedFiles = base.changedFiles;
  let diffs = base.diffs;
  let diffSlot = base.evidence.diff;
  if (diffResult) {
    diffSlot = diffResult.slot;
    if (diffResult.content) {
      const parsed = parseDiff(diffResult.content, scopeFromProjection(projection));
      changedFiles = parsed.files;
      diffs = parsed.diffs;
      diffSlot = { ...diffSlot, content: diffResult.content };
      if (run?.approval) {
        const stats = diffStats(diffResult.content);
        run = {
          ...run,
          approval: {
            ...run.approval,
            additions: stats.additions,
            deletions: stats.deletions,
            reviewReady: diffResult.slot.status === "available",
            reviewMessage: "Complete PatchPreview Artifact verified by the Host.",
          },
        };
      }
    } else if (run?.approval) {
      run = {
        ...run,
        approval: {
          ...run.approval,
          reviewReady: false,
          reviewMessage: diffResult.slot.message,
        },
      };
    }
  }

  let graphNodes = base.graphNodes;
  let graphEdges = base.graphEdges;
  let graphSlot = base.evidence.graph;
  if (graphResult) {
    graphSlot = graphResult.slot;
    if (graphResult.content) {
      const parsed = parseJson(graphResult.content, GraphDeltaSchema);
      if (parsed) ({ nodes: graphNodes, edges: graphEdges } = mapGraphDelta(parsed));
      else graphSlot = { ...graphSlot, status: "unavailable", message: "Graph Artifact did not match GraphDeltaSchema" };
    }
  }

  const testSlot = testResult?.content
    ? { ...testResult.slot, content: testResult.content }
    : (testResult?.slot ?? base.evidence.test);

  const eventEvidence = await hydrateEventEvidence(sdk, projection, artifactCache);

  return {
    ...base,
    run,
    contextSources,
    changedFiles,
    diffs,
    graphNodes,
    graphEdges,
    evidence: { context: contextSlot, diff: diffSlot, graph: graphSlot, test: testSlot },
    eventEvidence,
  };
}

async function hydrateEventEvidence(
  sdk: TraceGraphSdkPort,
  projection: RunProjection,
  artifactCache: Map<string, Promise<ArtifactFetchResult>>,
): Promise<Readonly<Record<string, EventEvidenceSnapshot>>> {
  const entries = await Promise.all(projection.timeline.map(async (event) => {
    const relations = resolveEventRelations(projection.timeline, event);
    const [contextResult, diffResult, graphResult, testResult] = await Promise.all([
      fetchArtifact(sdk, projection.run_id, relations.contextRef, artifactCache),
      fetchArtifact(sdk, projection.run_id, relations.diffRef, artifactCache),
      fetchArtifact(sdk, projection.run_id, relations.graphRef, artifactCache),
      fetchArtifact(sdk, projection.run_id, relations.testRef, artifactCache),
    ]);
    const linked = emptyEventEvidence("The selected event does not reference this evidence type.");
    const codeIntel = codeIntelForEvent(projection.timeline, event);
    let contextSources = linked.contextSources;
    let contextSlot = relations.contextRef
      ? artifactSlot(relations.contextRef, "Context Manifest")
      : linked.evidence.context;
    let inputTokens: number | undefined;
    let tokenLimit: number | undefined;
    let reservedOutput: number | undefined;
    let contextBudget: ContextBudgetSnapshot | undefined;
    if (contextResult) {
      contextSlot = contextResult.slot;
      if (contextResult.content) {
        const parsed = parseJson(contextResult.content, ContextManifestSchema);
        if (parsed) {
          contextSources = mapContextSources(parsed);
          inputTokens = parsed.input_tokens;
          tokenLimit = parsed.token_limit;
          reservedOutput = parsed.reserved_output_tokens;
          contextBudget = mapContextBudget(parsed, projection.timeline);
        } else {
          contextSlot = { ...contextSlot, status: "unavailable", message: "Context Artifact did not match ContextManifestSchema" };
        }
      }
    }

    let changedFiles = linked.changedFiles;
    let diffs = linked.diffs;
    let diffSlot = relations.diffRef ? artifactSlot(relations.diffRef, "Diff") : linked.evidence.diff;
    if (diffResult) {
      diffSlot = diffResult.slot;
      if (diffResult.content) {
        ({ files: changedFiles, diffs } = parseDiff(diffResult.content, relations.patchScope));
        diffSlot = { ...diffSlot, content: diffResult.content };
      }
    }

    let graphNodes = linked.graphNodes;
    let graphEdges = linked.graphEdges;
    let graphSlot = relations.graphRef ? artifactSlot(relations.graphRef, "Graph Delta") : linked.evidence.graph;
    if (graphResult) {
      graphSlot = graphResult.slot;
      if (graphResult.content) {
        const parsed = parseJson(graphResult.content, GraphDeltaSchema);
        if (parsed) ({ nodes: graphNodes, edges: graphEdges } = mapGraphDelta(parsed));
        else graphSlot = { ...graphSlot, status: "unavailable", message: "Graph Artifact did not match GraphDeltaSchema" };
      }
    }

    const testSlot = testResult?.content
      ? { ...testResult.slot, content: testResult.content }
      : (testResult?.slot ?? (relations.testRef ? artifactSlot(relations.testRef, "Test Log") : linked.evidence.test));

    return [event.event_id, {
      contextSources,
      changedFiles,
      diffs,
      graphNodes,
      graphEdges,
      ...(codeIntel === undefined ? {} : { codeIntel }),
      evidence: { context: contextSlot, diff: diffSlot, graph: graphSlot, test: testSlot },
      ...(relations.contextManifestId === undefined ? {} : { contextManifestId: relations.contextManifestId }),
      ...(relations.patchEventId === undefined ? {} : { patchEventId: relations.patchEventId }),
      ...(relations.graphDeltaId === undefined ? {} : { graphDeltaId: relations.graphDeltaId }),
      ...(relations.testReceiptId === undefined ? {} : { testReceiptId: relations.testReceiptId }),
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(tokenLimit === undefined ? {} : { tokenLimit }),
      ...(reservedOutput === undefined ? {} : { reservedOutput }),
      ...(contextBudget === undefined ? {} : { contextBudget }),
    } satisfies EventEvidenceSnapshot] as const;
  }));
  return Object.fromEntries(entries);
}

function mapCodeIntelProjection(
  value: NonNullable<RunProjection["code_intel"]>,
): CodeIntelSnapshot {
  return {
    changedFiles: value.changed_files,
    changedFilesTruncated: value.changed_files_truncated,
    changedSymbols: value.changed_symbols,
    changedSymbolsTruncated: value.changed_symbols_truncated,
    ...(value.diagnostics_summary === undefined ? {} : { diagnosticsSummary: value.diagnostics_summary }),
    ...(value.stale_base === undefined ? {} : { staleBase: value.stale_base }),
  };
}

/**
 * Resolve semantic data from the selected event's own patch relation. Never
 * use projection.code_intel here: that is the run head and may be newer than
 * a replayed/selected historical patch.
 */
function codeIntelForEvent(
  timeline: readonly WireSessionEvent[],
  selected: WireSessionEvent,
): CodeIntelSnapshot | undefined {
  const selectedPatchId = selected.type === "patch.applied" || selected.type === "patch.preview_created"
    ? selected.event_id
    : selected.patch_event_id;
  const semanticEvent = selected.type === "code.intel_updated" || selected.type === "code.stale_base_detected"
    ? selected
    : selectedPatchId === undefined
      ? selected.action_id === undefined
        ? undefined
        // A drift has no applied Patch yet. Tie its replacement approval to
        // the same action only when the drift fact already existed, so an old
        // preview cannot inherit a later reapproval warning.
        : [...timeline].reverse().find((event) => (
          event.type === "code.stale_base_detected"
          && event.action_id === selected.action_id
          && event.sequence <= selected.sequence
        ))
      : [...timeline].reverse().find((event) => (
        event.type === "code.intel_updated" && event.patch_event_id === selectedPatchId
      ));
  if (semanticEvent === undefined) return undefined;

  const diagnosticsSummary = lspSummaryAtOrBefore(timeline, semanticEvent.sequence);
  if (semanticEvent.type === "code.intel_updated") {
    const parsed = CodeIntelUpdatedDataSchema.safeParse(semanticEvent.data);
    if (!parsed.success) return undefined;
    return {
      changedFiles: parsed.data.changed_files,
      changedFilesTruncated: parsed.data.changed_files_truncated,
      changedSymbols: parsed.data.changed_symbols,
      changedSymbolsTruncated: parsed.data.changed_symbols_truncated,
      ...(diagnosticsSummary === undefined ? {} : { diagnosticsSummary }),
    };
  }
  const stale = CodeStaleBaseDetectedDataSchema.safeParse(semanticEvent.data);
  if (!stale.success) return undefined;
  return {
    changedFiles: [],
    changedFilesTruncated: false,
    changedSymbols: [],
    changedSymbolsTruncated: false,
    ...(diagnosticsSummary === undefined ? {} : { diagnosticsSummary }),
    staleBase: stale.data.stale_base,
  };
}

function lspSummaryAtOrBefore(
  timeline: readonly WireSessionEvent[],
  sequence: number,
): CodeIntelSnapshot["diagnosticsSummary"] | undefined {
  const event = [...timeline].reverse().find((candidate) => (
    candidate.sequence <= sequence && candidate.type === "lsp.diagnostics_received"
  ));
  const parsed = event === undefined ? undefined : LspDiagnosticsReceivedDataSchema.safeParse(event.data);
  if (parsed === undefined || !parsed.success) return undefined;
  const { project_id: _projectId, ...summary } = parsed.data;
  return summary;
}

function resolveEventRelations(
  timeline: readonly WireSessionEvent[],
  selected: WireSessionEvent,
): {
  contextRef?: ArtifactRef;
  diffRef?: ArtifactRef;
  graphRef?: ArtifactRef;
  testRef?: ArtifactRef;
  contextManifestId?: string;
  patchEventId?: string;
  graphDeltaId?: string;
  testReceiptId?: string;
  patchScope: readonly string[];
} {
  const directContext = artifactOfKinds(selected, ["context_manifest"]);
  const contextEvent = selected.context_manifest_ref
    ? [...timeline].reverse().find((event) => event.context_manifest_ref === selected.context_manifest_ref && artifactOfKinds(event, ["context_manifest"]))
    : undefined;
  const contextRef = directContext ?? (contextEvent ? artifactOfKinds(contextEvent, ["context_manifest"]) : undefined);

  const directDiff = artifactOfKinds(selected, ["diff", "patch_preview"]);
  const explicitPatchEvent = selected.type === "patch.preview_created" || selected.type === "patch.applied"
    ? selected
    : selected.patch_event_id
      ? timeline.find((event) => event.event_id === selected.patch_event_id)
      : undefined;
  const sharedArtifactPatchEvent = directDiff && !explicitPatchEvent
    ? [...timeline].reverse().find((event) => (
        event.type === "patch.preview_created" || event.type === "patch.applied"
      ) && event.artifact_refs.some((ref) => ref.artifact_id === directDiff.artifact_id))
    : undefined;
  const patchEvent = explicitPatchEvent ?? sharedArtifactPatchEvent;
  const patchEventId = patchEvent?.event_id ?? selected.patch_event_id;
  const diffRef = directDiff ?? (patchEvent ? artifactOfKinds(patchEvent, ["diff", "patch_preview"]) : undefined);

  const directGraph = artifactOfKinds(selected, ["graph_delta"]);
  const graphEvent = directGraph
    ? selected
    : selected.graph_delta_id
      ? [...timeline].reverse().find((event) => event.graph_delta_id === selected.graph_delta_id && artifactOfKinds(event, ["graph_delta"]))
      : patchEventId
        ? [...timeline].reverse().find((event) => event.patch_event_id === patchEventId && artifactOfKinds(event, ["graph_delta"]))
        : undefined;
  const graphRef = directGraph ?? (graphEvent ? artifactOfKinds(graphEvent, ["graph_delta"]) : undefined);
  const graphDeltaId = selected.graph_delta_id ?? graphEvent?.graph_delta_id;

  const directTest = artifactOfKinds(selected, ["test_log"]);
  const sharedArtifactTestEvent = directTest && selected.type !== "test.completed"
    ? [...timeline].reverse().find((event) => event.type === "test.completed"
      && event.artifact_refs.some((ref) => ref.artifact_id === directTest.artifact_id))
    : undefined;
  const testEvent = selected.test_receipt_id
    ? [...timeline].reverse().find((event) => event.test_receipt_id === selected.test_receipt_id && artifactOfKinds(event, ["test_log"]))
    : sharedArtifactTestEvent ?? (patchEventId
      ? [...timeline].reverse().find((event) => event.patch_event_id === patchEventId && artifactOfKinds(event, ["test_log"]))
      : undefined) ?? (directTest ? selected : undefined);
  const testRef = directTest ?? (testEvent ? artifactOfKinds(testEvent, ["test_log"]) : undefined);
  const testReceiptId = selected.test_receipt_id ?? testEvent?.test_receipt_id;

  return {
    ...(contextRef === undefined ? {} : { contextRef }),
    ...(diffRef === undefined ? {} : { diffRef }),
    ...(graphRef === undefined ? {} : { graphRef }),
    ...(testRef === undefined ? {} : { testRef }),
    ...(selected.context_manifest_ref === undefined ? {} : { contextManifestId: selected.context_manifest_ref }),
    ...(patchEventId === undefined ? {} : { patchEventId }),
    ...(graphDeltaId === undefined ? {} : { graphDeltaId }),
    ...(testReceiptId === undefined ? {} : { testReceiptId }),
    patchScope: patchScope(patchEvent),
  };
}

function artifactOfKinds(
  event: WireSessionEvent,
  kinds: readonly ArtifactRef["kind"][],
): ArtifactRef | undefined {
  // Parent subagent terminal events may reference child-owned Artifacts. Keep
  // those behind the relation-scoped child Run read instead of fetching them
  // with the parent Run's artifact authority.
  return [...event.artifact_refs].reverse().find((ref) => (
    ref.run_id === event.run_id && kinds.includes(ref.kind)
  ));
}

function patchScope(event: WireSessionEvent | undefined): readonly string[] {
  if (!event) return [];
  const directScope = event.data.scope;
  if (Array.isArray(directScope) && directScope.every((item) => typeof item === "string")) return directScope;
  const preview = recordValue(event.data.preview);
  const previewScope = preview?.scope;
  return Array.isArray(previewScope) && previewScope.every((item) => typeof item === "string") ? previewScope : [];
}

function mapWireEvent(event: WireSessionEvent, runStatus: RunProjection["status"]): TraceEvent {
  const receipt = recordValue(event.data.receipt);
  const receiptMetadata = recordValue(receipt?.metadata);
  const decision = recordValue(event.data.decision);
  const policyDecision = parsePolicyDecision(event);
  const permission = parsePermissionConfiguredData(event);
  const pending = recordValue(event.data.pending_approval);
  const riskValue = stringValue(decision?.risk) ?? stringValue(pending?.risk);
  const risk = riskValue === "low" || riskValue === "medium" || riskValue === "high" ? riskValue : undefined;
  const rationale = policyDecision?.explanation ?? stringValue(decision?.public_reason);
  const toolCall = recordValue(decision?.tool_call);
  const toolArguments = recordValue(toolCall?.arguments);
  const observation = recordValue(event.data.observation);
  const observationFacts = recordValue(observation?.facts);
  const toolName = stringValue(event.data.tool_name)
    ?? stringValue(receipt?.tool_name)
    ?? policyDecision?.tool_name
    ?? stringValue(toolCall?.tool_name)
    ?? stringValue(observationFacts?.tool_name);
  const target = firstString(
    event.data.path,
    event.data.pattern,
    event.data.query,
    event.data.suite,
    observationFacts?.path,
    observationFacts?.pattern,
    observationFacts?.query,
    observationFacts?.suite,
    toolArguments?.path,
    toolArguments?.pattern,
    toolArguments?.query,
    toolArguments?.suite,
  );
  const durationMs = numberValue(receipt?.duration_ms);
  const sandboxReport = parseSandboxReport(event.data.sandbox_report)
    ?? parseSandboxReport(receiptMetadata?.sandbox_report)
    ?? parseSandboxReport(observationFacts?.sandbox_report);
  const operationId = event.operation_id ?? event.model_call_id;
  return {
    id: event.event_id,
    sequence: event.sequence,
    kind: mapEventKind(event.type),
    title: eventTitle(event.type),
    summary: event.summary,
    timestamp: formatTime(event.occurred_at),
    state: mapEventState(event.type, runStatus, policyDecision),
    ...(durationMs === undefined ? {} : { duration: durationMs < 1_000 ? `${durationMs} ms` : `${(durationMs / 1_000).toFixed(2)} s` }),
    ...(risk === undefined ? {} : { risk }),
    ...(sandboxReport === undefined ? {} : { sandboxReport }),
    ...(permission === undefined ? {} : { permission }),
    ...(policyDecision === undefined ? {} : { policyDecision }),
    ...(rationale === undefined ? {} : { rationale }),
    ...(operationId === undefined ? {} : { operationId }),
    ...(toolName === undefined ? {} : { toolName }),
    ...(target === undefined ? {} : { target }),
    ...(event.context_manifest_ref === undefined ? {} : { contextManifestRef: event.context_manifest_ref }),
    ...((event.type === "patch.preview_created" || event.type === "patch.applied") ? { patchRef: event.event_id } : event.patch_event_id ? { patchRef: event.patch_event_id } : {}),
    ...(event.graph_delta_id === undefined ? {} : { graphDeltaRef: event.graph_delta_id }),
    ...(event.test_receipt_id === undefined ? {} : { testReceiptRef: event.test_receipt_id }),
    ...(event.artifact_refs.every((ref) => ref.run_id !== event.run_id)
      ? {}
      : {
          evidenceRefs: event.artifact_refs
            .filter((ref) => ref.run_id === event.run_id)
            .map((ref) => ref.artifact_id),
        }),
    ...steeringEventMetadata(event),
    output: event.summary,
  };
}

function steeringEventMetadata(event: WireSessionEvent): Pick<TraceEvent, "inputId" | "inputKind" | "atStep"> {
  if (event.type === "user.input_queued") {
    const parsed = UserInputQueuedDataSchema.safeParse(event.data);
    return parsed.success
      ? { inputId: parsed.data.input.input_id, inputKind: parsed.data.input.kind }
      : {};
  }
  if (event.type === "user.input_consumed") {
    const parsed = UserInputConsumedDataSchema.safeParse(event.data);
    return parsed.success
      ? { inputId: parsed.data.input_id, inputKind: parsed.data.kind, atStep: parsed.data.at_step }
      : {};
  }
  return {};
}

function parsePermissionConfiguredData(event: WireSessionEvent) {
  if (event.type !== "permission.configured") return undefined;
  const parsed = PermissionConfiguredDataSchema.safeParse(event.data);
  return parsed.success ? parsed.data.permission : undefined;
}

function parsePolicyDecision(event: WireSessionEvent): PolicyDecision | undefined {
  if (event.type === "policy.evaluated") {
    const parsed = PolicyEvaluatedDataSchema.safeParse(event.data);
    return parsed.success ? parsed.data.decision : undefined;
  }
  if (event.type === "policy.denied") {
    const parsed = PolicyDeniedDataSchema.safeParse(event.data);
    return parsed.success ? parsed.data.decision : undefined;
  }
  return undefined;
}

function parseSandboxReport(value: unknown) {
  const parsed = SandboxReportSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function mapEventKind(type: WireSessionEvent["type"]): EventKind {
  if (type === "permission.configured") return "permission";
  if (type.startsWith("sandbox.")) return "sandbox";
  if (type.startsWith("context.")) return "context";
  if (type.startsWith("model.") || type.startsWith("action.") || type.startsWith("policy.")) return "decision";
  if (type.startsWith("todo.")) return "todo";
  if (type.startsWith("subagent.")) return "subagent";
  if (type.startsWith("team.")) return "team";
  if (type.startsWith("attachment.")) return "attachment";
  if (type.startsWith("user.input_")) return "query";
  if (type.startsWith("plan.")) return "approval";
  if (type.startsWith("tool.")) return "tool";
  if (type.startsWith("approval.")) return "approval";
  if (type.startsWith("patch.")) return "patch";
  if (type.startsWith("graph.") || type.startsWith("code.")) return "graph";
  if (type.startsWith("test.")) return "test";
  return "run";
}

function mapEventState(
  type: WireSessionEvent["type"],
  runStatus: RunProjection["status"],
  policyDecision?: PolicyDecision,
): EventState {
  if (policyDecision?.kind === "deny") return "denied";
  if (policyDecision?.kind === "ask") return "waiting";
  if (type === "approval.requested") return "waiting";
  if (type === "plan.ready") return runStatus === "awaiting_plan_approval" ? "waiting" : "succeeded";
  if (type === "tool.started" || type === "tool.batch_started" || type === "run.started" || type === "model.request_started" || type === "context.compaction_started" || type === "subagent.started") {
    if (runStatus === "completed") return "succeeded";
    if (runStatus === "failed") return "failed";
    if (runStatus === "cancelled" || runStatus === "interrupted") return "denied";
    return "running";
  }
  if (type.endsWith("failed") || type === "model.output_invalid" || type === "tool.unknown" || type === "action.diverged") return "failed";
  if (type === "approval.denied" || type === "approval.expired" || type === "policy.denied" || type === "action.rejected" || type === "action.rollback_refused" || type === "subagent.interrupted" || type === "attachment.rejected" || type === "code.stale_base_detected") return "denied";
  return "succeeded";
}

function eventTitle(type: WireSessionEvent["type"]): string {
  const titles: Partial<Record<WireSessionEvent["type"], string>> = {
    "run.created": "Run created",
    "run.started": "Workspace indexing started",
    "run.completed": "Run completed",
    "run.failed": "Run failed",
    "run.cancelled": "Run cancelled",
    "run.interrupted": "Run interrupted",
    "run.resumed": "Run resumed",
    "session.opened": "Session opened",
    "session.closed": "Session closed",
    "session.title_changed": "Session title changed",
    "session.tail_truncated": "Incomplete session tail repaired",
    "permission.configured": "Permission configured",
    "policy.evaluated": "Policy evaluated",
    "policy.denied": "Policy denied",
    "plan.ready": "Plan ready",
    "plan.approved": "Plan approved",
    "todo.created": "Todo created",
    "todo.updated": "Todo updated",
    "todo.completed": "Todo completed",
    "todo.blocked": "Todo blocked",
    "user.input_queued": "User input queued",
    "user.input_consumed": "User input consumed",
    "subagent.started": "Subagent started",
    "subagent.message_sent": "Subagent message sent",
    "subagent.completed": "Subagent completed",
    "subagent.failed": "Subagent failed",
    "subagent.interrupted": "Subagent interrupted",
    "team.created": "Agent team created",
    "team.member_joined": "Team member joined",
    "team.heartbeat": "Team heartbeat recorded",
    "team.member_lost": "Team member lost",
    "team.mailbox_delivered": "Team mailbox message delivered",
    "team.mailbox_claimed": "Team mailbox message claimed",
    "team.task_created": "Team task created",
    "team.task_claimed": "Team task claimed",
    "team.task_completed": "Team task completed",
    "team.task_blocked": "Team task blocked",
    "team.task_cancelled": "Team task cancelled",
    "team.task_reopened": "Team task reopened",
    "attachment.added": "Attachment added",
    "attachment.rejected": "Attachment rejected",
    "attachment.offloaded": "Attachment offloaded",
    "sandbox.configured": "Sandbox configured",
    "sandbox.enforced": "Sandbox enforced",
    "sandbox.disabled": "Sandbox disabled",
    "context.built": "Context built",
    "context.budget_warning": "Context budget warning",
    "context.compaction_started": "Context compression started",
    "context.compaction_completed": "Context checkpoint recorded",
    "context.tool_output_spilled": "Tool output archived",
    "context.summary_created": "Context summary created",
    "context.summary_failed": "Context summary fell back",
    "context.spill_refetched": "Archived Context source retrieved",
    "model.request_started": "Model request started",
    "model.decision": "Model decision",
    "model.request_failed": "Model request failed",
    "model.output_invalid": "Model output rejected",
    "tool.batch_started": "Tool batch started",
    "tool.batch_completed": "Tool batch completed",
    "approval.requested": "Approval required",
    "approval.granted": "Approval granted",
    "approval.denied": "Approval denied",
    "approval.expired": "Approval expired",
    "action.verified": "Action verified",
    "action.reconciled": "Action reconciled",
    "action.diverged": "Action requires manual review",
    "action.rollback_refused": "Rollback refused",
    "patch.preview_created": "Patch preview created",
    "patch.applied": "Patch applied",
    "patch.rolled_back": "Patch rolled back",
    "graph.snapshot_created": "Graph snapshot created",
    "graph.delta_created": "Architecture delta created",
    "code.intel_updated": "Semantic CodeGraph updated",
    "code.stale_base_detected": "Git base drift requires reapproval",
    "test.completed": "Tests completed",
  };
  return titles[type] ?? type.split(".").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" · ");
}

function mapRunStatus(status: RunProjection["status"]): RunStatus {
  const statuses: Record<RunProjection["status"], RunStatus> = {
    created: "indexing",
    indexing: "indexing",
    running: "running",
    awaiting_plan_approval: "awaiting_plan_approval",
    awaiting_approval: "needs_approval",
    needs_manual_review: "needs_manual_review",
    interrupted: "interrupted",
    completed: "completed",
    failed: "failed",
    cancelled: "cancelled",
  };
  return statuses[status];
}

function mapApproval(pending: NonNullable<RunProjection["pending_approval"]>): ApprovalRequest {
  const stats = diffStats(pending.preview.diff);
  return {
    id: pending.approval_id,
    action: "commit_patch",
    risk: pending.risk,
    target: pending.preview.path,
    files: pending.preview.scope.length,
    additions: stats.additions,
    deletions: stats.deletions,
    expiresAt: countdown(pending.preview.expires_at),
    rollbackAvailable: false,
    reviewReady: false,
    reviewMessage: "Loading and verifying the complete PatchPreview Artifact…",
  };
}

function latestArtifacts(refs: readonly ArtifactRef[]): {
  context?: ArtifactRef;
  diff?: ArtifactRef;
  graph?: ArtifactRef;
  test?: ArtifactRef;
} {
  const context = [...refs].reverse().find((ref) => ref.kind === "context_manifest");
  const diff = [...refs].reverse().find((ref) => ref.kind === "diff" || ref.kind === "patch_preview");
  const graph = [...refs].reverse().find((ref) => ref.kind === "graph_delta");
  const test = [...refs].reverse().find((ref) => ref.kind === "test_log");
  return {
    ...(context === undefined ? {} : { context }),
    ...(diff === undefined ? {} : { diff }),
    ...(graph === undefined ? {} : { graph }),
    ...(test === undefined ? {} : { test }),
  };
}

function artifactSlot(ref: ArtifactRef | undefined, label: string): EvidenceSlot {
  return ref
    ? { status: "loading", artifactId: ref.artifact_id, message: `Loading ${label} Artifact…` }
    : { status: "not_present", message: `No ${label} Artifact was referenced by this RunProjection.` };
}

async function fetchArtifact(
  sdk: TraceGraphSdkPort,
  runId: string,
  ref: ArtifactRef | undefined,
  cache: Map<string, Promise<ArtifactFetchResult>>,
): Promise<ArtifactFetchResult | null> {
  if (!ref) return null;
  return fetchArtifactById(sdk, runId, ref.artifact_id, `${ref.kind} Artifact`, cache);
}

async function fetchArtifactById(
  sdk: TraceGraphSdkPort,
  runId: string,
  artifactId: string,
  label: string,
  cache: Map<string, Promise<ArtifactFetchResult>>,
): Promise<ArtifactFetchResult> {
  const key = `${runId}\u0000${artifactId}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const request = requestArtifact(sdk, runId, artifactId, label);
  cache.set(key, request);
  void request.then((result) => {
    if (result.transient) cache.delete(key);
  });
  return request;
}

async function requestArtifact(
  sdk: TraceGraphSdkPort,
  runId: string,
  artifactId: string,
  label: string,
): Promise<ArtifactFetchResult> {
  try {
    const response = await sdk.getArtifact(runId, artifactId);
    if (response.status === "available") {
      return {
        slot: { status: "available", artifactId, message: `${label} verified by the Host` },
        content: response.content,
      };
    }
    if (response.status === "corrupt") {
      return { slot: { status: "corrupt", artifactId, message: `Artifact hash mismatch: ${response.reason}` } };
    }
    return { slot: { status: "unavailable", artifactId, message: `Artifact unavailable: ${response.reason}` } };
  } catch (error) {
    return {
      slot: { status: "unavailable", artifactId, message: `Artifact request failed: ${publicMessage(error)}` },
      transient: true,
    };
  }
}

function parseDiff(content: string, fallbackScope: readonly string[]): { files: readonly ChangedFile[]; diffs: Readonly<Record<string, readonly DiffLine[]>> } {
  const lines = content.split(/\r?\n/u);
  let currentPath: string | null = fallbackScope[0] ?? null;
  const buckets = new Map<string, DiffLine[]>();
  const ensure = (path: string) => {
    const existing = buckets.get(path);
    if (existing) return existing;
    const created: DiffLine[] = [];
    buckets.set(path, created);
    return created;
  };
  let lineNumber = 0;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
      currentPath = match?.[2] ?? currentPath;
      if (currentPath) ensure(currentPath).push({ number: null, type: "meta", content: line });
      continue;
    }
    if (line.startsWith("+++ ")) {
      const candidate = line.slice(4).replace(/^b\//u, "").trim();
      if (candidate && candidate !== "/dev/null") currentPath = candidate;
      if (currentPath) ensure(currentPath).push({ number: null, type: "meta", content: line });
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("@@")) {
      if (currentPath) ensure(currentPath).push({ number: null, type: "meta", content: line });
      continue;
    }
    if (!currentPath) continue;
    const type: DiffLine["type"] = line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : "context";
    if (type !== "removed") lineNumber += 1;
    ensure(currentPath).push({ number: lineNumber, type, content: line });
  }
  for (const path of fallbackScope) ensure(path);
  const files = [...buckets].map(([path, diffLines]) => ({
    path,
    status: diffLines.some((line) => line.content.startsWith("--- /dev/null"))
      ? "added" as const
      : diffLines.some((line) => line.content.startsWith("+++ /dev/null"))
        ? "deleted" as const
        : "modified" as const,
    additions: diffLines.filter((line) => line.type === "added").length,
    deletions: diffLines.filter((line) => line.type === "removed").length,
  }));
  return { files, diffs: Object.fromEntries(buckets) };
}

function mapContextSources(manifest: ContextManifest): readonly ContextSource[] {
  const colors: Record<ContextManifest["items"][number]["section"], string> = {
    system: "#7c8cff",
    goal: "#b88cff",
    repo: "#48bfa5",
    history: "#e0a84b",
    tool: "#4e9bea",
    memory: "#d292e8",
  };
  return manifest.items.map((item) => {
    const archive = item.artifact_ref?.kind === "spilled_tool_output"
      || item.artifact_ref?.kind === "context_source_archive"
      ? item.artifact_ref
      : undefined;
    return {
      itemId: item.item_id,
      name: item.label,
      tokens: item.included_tokens,
      ...(item.original_tokens === item.included_tokens ? {} : { originalTokens: item.original_tokens }),
      action: item.action,
      reason: item.reason,
      color: colors[item.section],
      ...(archive === undefined ? {} : {
        archive: {
          artifactId: archive.artifact_id,
          locator: `artifact:${archive.artifact_id}`,
          status: "idle" as const,
          message: "Open to load the archived Context source.",
        },
      }),
    };
  });
}

/** Prefer the artifact contract whenever it is available. */
function mapContextBudget(
  manifest: ContextManifest,
  timeline: readonly WireSessionEvent[],
): ContextBudgetSnapshot | undefined {
  const budget = manifest.budget;
  if (!budget) return undefined;
  const compression = manifest.compression;
  const estimate = mapTokenEstimate(manifest.token_estimate);
  const providerUsage = latestProviderUsage(timeline, manifest.model_call_id);
  return {
    modelCallId: manifest.model_call_id,
    windowTokens: manifest.token_limit,
    inputBudgetTokens: budget.input_budget_tokens,
    usedTokens: manifest.input_tokens,
    reservedOutputTokens: manifest.reserved_output_tokens,
    warningThresholdTokens: budget.warning_threshold_tokens,
    compressionThresholdTokens: budget.compression_threshold_tokens,
    estimator: budget.token_estimator,
    status: budget.status,
    ...(estimate === undefined ? {} : { estimate }),
    ...(providerUsage === undefined ? {} : { providerUsage }),
    ...(compression === undefined ? {} : {
      compression: {
        strategy: compression.strategy,
        appliedStrategy: compression.applied_strategy,
        trigger: compression.trigger,
        beforeTokens: compression.before_tokens,
        afterTokens: compression.after_tokens,
        checkpointTokens: compression.checkpoint_tokens,
        preservedRecentMessageCount: compression.preserved_recent_message_count,
        compactedHistoryMessageCount: compression.compacted_history_message_count,
      },
    }),
  };
}

/**
 * A fresh `context.built` event lets the chat render its budget before the
 * inspector has finished fetching the Context Manifest Artifact.
 */
function contextBudgetFromEvent(
  event: WireSessionEvent | undefined,
  timeline: readonly WireSessionEvent[],
): ContextBudgetSnapshot | undefined {
  if (!event || event.type !== "context.built") return undefined;
  const windowTokens = numberValue(event.data.token_limit);
  const inputBudgetTokens = numberValue(event.data.input_budget_tokens);
  const usedTokens = numberValue(event.data.input_tokens);
  const reservedOutputTokens = numberValue(event.data.reserved_output_tokens);
  const warningThresholdTokens = numberValue(event.data.warning_threshold_tokens);
  const compressionThresholdTokens = numberValue(event.data.compression_threshold_tokens);
  const estimator = event.data.token_estimator;
  const status = event.data.context_status;
  if (
    windowTokens === undefined || inputBudgetTokens === undefined || usedTokens === undefined
    || reservedOutputTokens === undefined || warningThresholdTokens === undefined || compressionThresholdTokens === undefined
    || (estimator !== "heuristic_v2" && estimator !== "provider_tokenizer")
    || (status !== "healthy" && status !== "warning" && status !== "compressed")
  ) return undefined;
  const tokenValues = [
    windowTokens,
    inputBudgetTokens,
    usedTokens,
    reservedOutputTokens,
    warningThresholdTokens,
    compressionThresholdTokens,
  ];
  if (
    tokenValues.some((value) => !Number.isSafeInteger(value) || value < 0)
    || windowTokens <= 0
    || inputBudgetTokens <= 0
    || windowTokens - reservedOutputTokens !== inputBudgetTokens
    || usedTokens > inputBudgetTokens
    || warningThresholdTokens >= compressionThresholdTokens
    || compressionThresholdTokens > inputBudgetTokens
    || (status === "healthy" && usedTokens >= warningThresholdTokens)
    || (status === "warning" && usedTokens < warningThresholdTokens)
  ) return undefined;
  const rawCompression = recordValue(event.data.compression);
  const rawStrategy = rawCompression?.strategy;
  const strategy = rawStrategy === "none" || rawStrategy === "tiered_history_checkpoint"
    ? rawStrategy
    : undefined;
  const rawAppliedStrategy = rawCompression?.applied_strategy;
  const appliedStrategy = rawAppliedStrategy === "none"
    || rawAppliedStrategy === "tiered_history_checkpoint"
    || rawAppliedStrategy === "bounded_history"
    || rawAppliedStrategy === "bounded_tool_output"
    || rawAppliedStrategy === "mixed"
    ? rawAppliedStrategy
    // Older Hosts only reported the legacy history-checkpoint field. Keep
    // their historical Context artifacts readable rather than rejecting them.
    : strategy === "tiered_history_checkpoint"
      ? "tiered_history_checkpoint"
      : "none";
  const rawTrigger = rawCompression?.trigger;
  const trigger = rawTrigger === "within_budget" || rawTrigger === "warning_threshold"
    || rawTrigger === "compression_threshold" || rawTrigger === "hard_budget"
    ? rawTrigger
    : undefined;
  const beforeTokens = numberValue(rawCompression?.before_tokens);
  const afterTokens = numberValue(rawCompression?.after_tokens);
  const checkpointTokens = numberValue(rawCompression?.checkpoint_tokens);
  const preservedRecentMessageCount = numberValue(rawCompression?.preserved_recent_message_count);
  const compactedHistoryMessageCount = numberValue(rawCompression?.compacted_history_message_count);
  const compression: NonNullable<ContextBudgetSnapshot["compression"]> | undefined = (
    strategy !== undefined && trigger !== undefined
    && beforeTokens !== undefined && afterTokens !== undefined && checkpointTokens !== undefined
    && preservedRecentMessageCount !== undefined && compactedHistoryMessageCount !== undefined
  ) ? {
    strategy: strategy as "none" | "tiered_history_checkpoint",
    appliedStrategy,
    trigger: trigger as "within_budget" | "warning_threshold" | "compression_threshold" | "hard_budget",
    beforeTokens,
    afterTokens,
    checkpointTokens,
    preservedRecentMessageCount,
    compactedHistoryMessageCount,
  } : undefined;
  if (
    (status === "compressed" && (compression === undefined || compression.appliedStrategy === "none"))
    || (status !== "compressed" && compression?.appliedStrategy !== undefined && compression.appliedStrategy !== "none")
    || (compression !== undefined && compression.afterTokens !== usedTokens)
  ) return undefined;
  const modelCallId = event.model_call_id;
  const estimate = mapTokenEstimate(event.data.token_estimate);
  const providerUsage = modelCallId === undefined
    ? undefined
    : latestProviderUsage(timeline, modelCallId);
  return {
    ...(modelCallId === undefined ? {} : { modelCallId }),
    windowTokens,
    inputBudgetTokens,
    usedTokens,
    reservedOutputTokens,
    warningThresholdTokens,
    compressionThresholdTokens,
    estimator,
    status,
    ...(estimate === undefined ? {} : { estimate }),
    ...(providerUsage === undefined ? {} : { providerUsage }),
    ...(compression === undefined ? {} : { compression }),
  };
}

function mapTokenEstimate(value: unknown): ContextTokenEstimateSnapshot | undefined {
  const parsed = TokenEstimateSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return {
    estimatorId: parsed.data.estimator_id,
    confidence: parsed.data.confidence,
    inputTokens: parsed.data.input_tokens,
    outputTokens: parsed.data.output_tokens,
    ...(parsed.data.cached_tokens === undefined ? {} : { cachedTokens: parsed.data.cached_tokens }),
    perSection: {
      system: parsed.data.per_section.system,
      goal: parsed.data.per_section.goal,
      history: parsed.data.per_section.history,
      tool: parsed.data.per_section.tool,
      repo: parsed.data.per_section.repo,
      memory: parsed.data.per_section.memory,
    },
  };
}

function latestProviderUsage(
  timeline: readonly WireSessionEvent[],
  modelCallId: string,
): ProviderUsageSnapshot | undefined {
  // A single model call can append an initial report and then one or more
  // repair reports. The durable UI deliberately shows the newest report. An
  // anomaly is attached only when it names that same request kind/sequence;
  // an older initial anomaly must not be presented as a repair anomaly.
  const usageEvent = highestSequenceEvent(timeline, (candidate) =>
    candidate.type === "model.usage_reported" && candidate.model_call_id === modelCallId,
  );
  if (!usageEvent) return undefined;
  const data = usageEvent.data;
  const parsed = ModelUsageReportSchema.safeParse({
    provider: data.provider,
    model: data.model,
    input_tokens: data.input_tokens,
    output_tokens: data.output_tokens,
    ...(data.cached_input_tokens === undefined ? {} : { cached_input_tokens: data.cached_input_tokens }),
    ...(data.reasoning_output_tokens === undefined ? {} : { reasoning_output_tokens: data.reasoning_output_tokens }),
    total_tokens: data.total_tokens,
    request_kind: data.request_kind,
    request_sequence: data.request_sequence,
    ...(data.provider_reported_cost === undefined ? {} : { provider_reported_cost: data.provider_reported_cost }),
  });
  if (!parsed.success) return undefined;

  const matchingAnomaly = highestSequenceEvent(timeline, (candidate) =>
    candidate.type === "model.usage_anomaly"
      && candidate.model_call_id === modelCallId
      && candidate.data.request_kind === parsed.data.request_kind
      && candidate.data.request_sequence === parsed.data.request_sequence
      && candidate.data.anomaly === true,
  );
  const estimatedInputTokens = numberValue(data.estimated_input_tokens);
  const deltaRatio = numberValue(data.delta_ratio);
  const reportedCost = data.cost_status === "provider_reported"
    ? parsed.data.provider_reported_cost
    : undefined;
  return {
    modelCallId,
    provider: parsed.data.provider,
    model: parsed.data.model,
    inputTokens: parsed.data.input_tokens,
    outputTokens: parsed.data.output_tokens,
    ...(parsed.data.cached_input_tokens === undefined ? {} : { cachedInputTokens: parsed.data.cached_input_tokens }),
    ...(parsed.data.reasoning_output_tokens === undefined ? {} : { reasoningOutputTokens: parsed.data.reasoning_output_tokens }),
    totalTokens: parsed.data.total_tokens,
    requestKind: parsed.data.request_kind,
    requestSequence: parsed.data.request_sequence,
    ...(estimatedInputTokens === undefined || estimatedInputTokens < 0 ? {} : { estimatedInputTokens }),
    ...(deltaRatio === undefined || deltaRatio < 0 ? {} : { deltaRatio }),
    cost: reportedCost === undefined
      ? { status: "unavailable" }
      : { status: "provider_reported", amount: reportedCost.amount, currency: reportedCost.currency },
    anomaly: data.anomaly === true || matchingAnomaly !== undefined,
  };
}

function highestSequenceEvent(
  timeline: readonly WireSessionEvent[],
  predicate: (event: WireSessionEvent) => boolean,
): WireSessionEvent | undefined {
  let latest: WireSessionEvent | undefined;
  for (const event of timeline) {
    if (predicate(event) && (latest === undefined || event.sequence > latest.sequence)) latest = event;
  }
  return latest;
}

function mapLiveActivity(activity: LivePublicActivity): PublicActivitySnapshot {
  return {
    id: activity.activity_id,
    sourceEventId: activity.source_event_id,
    sourceEventType: activity.source_event_type,
    sequence: activity.sequence,
    timestamp: formatTime(activity.occurred_at),
    kind: activity.kind,
    status: activity.status,
    summary: activity.summary,
  };
}

function mapModelSurface(event: ModelSurfaceEvent): ModelSurfaceSnapshot {
  return {
    id: event.surface_event_id,
    modelCallId: event.model_call_id,
    cursor: event.cursor,
    timestamp: formatTime(event.occurred_at),
    type: event.type,
    status: event.status,
    text: event.text,
  };
}

function mapGraphDelta(delta: GraphDelta): { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] } {
  const nodes = new Map<string, GraphNode>();
  const addNode = (
    id: string,
    state: GraphNode["state"],
    before: GraphNode["before"],
    after: GraphNode["after"],
  ) => {
    const existing = nodes.get(id);
    if (existing) {
      const mergedBefore = existing.before ?? before;
      const mergedAfter = existing.after ?? after;
      nodes.set(id, {
        ...existing,
        // An edge may introduce only a partial endpoint after the node delta
        // has already supplied a precise added/changed/removed state. Keep
        // that stronger recorded state rather than degrading the graph view.
        state: state === "partial"
          ? existing.state
          : existing.state === "partial" || existing.state === state
            ? state
            : "partial",
        ...(mergedBefore === undefined ? {} : { before: mergedBefore }),
        ...(mergedAfter === undefined ? {} : { after: mergedAfter }),
      });
      return;
    }
    const index = nodes.size;
    nodes.set(id, {
      id,
      state,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
      x: 26 + (index % 2) * 155,
      y: 42 + Math.floor(index / 2) * 95,
    });
  };
  for (const change of delta.node_changes) {
    const node = change.after ?? change.before;
    if (!node) continue;
    addNode(
      node.id,
      mapGraphChange(change.change),
      change.before ? { label: change.before.label, path: change.before.file_path ?? change.before.label } : undefined,
      change.after ? { label: change.after.label, path: change.after.file_path ?? change.after.label } : undefined,
    );
  }
  const edges: GraphEdge[] = [];
  for (const change of delta.edge_changes) {
    const edge = change.after ?? change.before;
    if (!edge) continue;
    const before = change.before ? {
      from: change.before.source_node_id,
      to: change.before.target_node_id,
      label: graphEdgeLabel(change.before.kind),
      confidence: graphConfidence(change.before.confidence),
    } : undefined;
    const after = change.after ? {
      from: change.after.source_node_id,
      to: change.after.target_node_id,
      label: graphEdgeLabel(change.after.kind),
      confidence: graphConfidence(change.after.confidence),
    } : undefined;
    if (change.before) {
      addNode(
        change.before.source_node_id,
        "partial",
        { label: change.before.source_node_id, path: change.before.file_path },
        undefined,
      );
      addNode(
        change.before.target_node_id,
        "partial",
        { label: change.before.target_node_id, path: change.before.file_path },
        undefined,
      );
    }
    if (change.after) {
      addNode(
        change.after.source_node_id,
        "partial",
        undefined,
        { label: change.after.source_node_id, path: change.after.file_path },
      );
      addNode(
        change.after.target_node_id,
        "partial",
        undefined,
        { label: change.after.target_node_id, path: change.after.file_path },
      );
    }
    edges.push({
      id: edge.id,
      state: mapEdgeChange(change.change),
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    });
  }
  return { nodes: [...nodes.values()], edges };
}

function graphConfidence(confidence: "high" | "medium" | "low"): number {
  return confidence === "high" ? 1 : confidence === "medium" ? 0.7 : 0.4;
}

function graphEdgeLabel(kind: "static_import" | "static_export" | "contains"): string {
  if (kind === "static_import") return "imports";
  if (kind === "static_export") return "exports";
  return "contains";
}

function mapGraphChange(change: GraphDelta["node_changes"][number]["change"]): GraphNode["state"] {
  if (change === "added" || change === "removed" || change === "changed") return change;
  return "partial";
}

function mapEdgeChange(change: GraphDelta["edge_changes"][number]["change"]): GraphEdge["state"] {
  if (change === "added" || change === "removed" || change === "changed") return change;
  return "partial";
}

function scopeFromProjection(projection: RunProjection): readonly string[] {
  if (projection.pending_approval) return projection.pending_approval.preview.scope;
  const applied = [...projection.timeline].reverse().find((event) => event.type === "patch.applied");
  const scope = applied?.data.scope;
  return Array.isArray(scope) && scope.every((item) => typeof item === "string") ? scope : [];
}

function diffStats(diff: string): { additions: number; deletions: number } {
  const lines = diff.split(/\r?\n/u);
  return {
    additions: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    deletions: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
  };
}

function elapsed(events: readonly WireSessionEvent[]): string | undefined {
  const first = events[0];
  const last = events.at(-1);
  if (!first || !last) return undefined;
  const milliseconds = Date.parse(last.occurred_at) - Date.parse(first.occurred_at);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  const seconds = Math.floor(milliseconds / 1_000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function countdown(expiresAt: string): string {
  const seconds = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1_000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--:--:--" : date.toLocaleTimeString([], { hour12: false });
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseJson<T>(content: string, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function commandId(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? `cmd_${globalThis.crypto.randomUUID()}`
    : `cmd_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function inputId(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? `input_${globalThis.crypto.randomUUID()}`
    : `input_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function publicMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The local Host is unavailable";
}

function isTerminal(projection: RunProjection): boolean {
  return projection.status === "completed"
    || projection.status === "failed"
    || projection.status === "cancelled"
    || projection.status === "interrupted"
    || projection.status === "needs_manual_review";
}

function isStreamSettled(projection: RunProjection): boolean {
  return isTerminal(projection);
}

function resumedExternallyApprovedPlan(
  previousStatus: RunProjection["status"] | undefined,
  projection: RunProjection,
): boolean {
  return previousStatus === "awaiting_plan_approval"
    && projection.mode === "execute"
    && projection.status !== "awaiting_plan_approval"
    && !isTerminal(projection);
}

function assertTodoUpdatesAvailable(status: RunProjection["status"]): void {
  if (status === "completed" || status === "failed" || status === "cancelled") {
    throw new Error("A terminal Run Todo list cannot be changed");
  }
  if (status === "interrupted" || status === "needs_manual_review") {
    throw new Error("Todo changes are unavailable while the Run requires recovery or manual review");
  }
}

function assertTeamUpdatesAvailable(status: RunProjection["status"]): void {
  if (status === "completed" || status === "failed" || status === "cancelled") {
    throw new Error("Agent Team changes are unavailable after the Run has stopped");
  }
  if (status === "interrupted" || status === "needs_manual_review") {
    throw new Error("Agent Team changes are unavailable while the Run requires recovery or manual review");
  }
}

function assertSteeringAvailable(status: RunProjection["status"]): void {
  if (status === "completed" || status === "failed" || status === "cancelled") {
    throw new Error("Steering is unavailable after the Run has stopped");
  }
  if (status === "interrupted" || status === "needs_manual_review") {
    throw new Error("Steering is unavailable while the Run requires recovery or manual review");
  }
}

function isTerminalStatus(status: RunStatus): boolean {
  return status === "completed"
    || status === "ready_for_review"
    || status === "failed"
    || status === "cancelled"
    || status === "interrupted"
    || status === "needs_manual_review"
    || status === "historical";
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = globalThis.setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      globalThis.clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
