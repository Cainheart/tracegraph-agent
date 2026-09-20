import {
  PROJECTOR_VERSION,
  SCHEMA_VERSION,
  type ArtifactRef,
  type ArtifactWireResponse,
  type ExtensionStatus,
  type LivePublicActivity,
  type ModelSurfaceEvent,
  type PermissionSettingsResponse,
  type ProjectSummary,
  type RunProjection,
  type SessionListQuery,
  type SessionRecoveryReport,
  type SessionSummary,
  type TelemetryStatus,
  type WireSessionEvent,
} from "@tracegraph/contracts";
import { describe, expect, it } from "vitest";
import { LiveTraceGraphClient, type TraceGraphSdkPort } from "./live-client";

const occurredAt = "2026-09-16T12:00:00.000Z";
const hash = `sha256:${"a".repeat(64)}` as `sha256:${string}`;

const permissionSettings: PermissionSettingsResponse = {
  active_preset: "workspace-write",
  sandbox_mode: "workspace-write",
  approval_policy: "on-write",
  policy_digest: hash,
  ceiling: "full-write",
  available_presets: [
    { key: "read-only", label: "Read only", sandbox_mode: "read-only", approval_policy: "never" },
    { key: "workspace-write", label: "Workspace write", sandbox_mode: "workspace-write", approval_policy: "on-write" },
    { key: "full-write", label: "Full write", sandbox_mode: "danger-full-access", approval_policy: "never" },
  ],
  source: "default",
  locked: false,
};

const fixtureProject: ProjectSummary = {
  project_id: "project_fixture",
  label: "SDK fixture",
  workspace_kind: "disposable_fixture",
  capabilities: {
    index: true,
    read: true,
    search: true,
    run_command: true,
    preview_patch: true,
    commit_patch: true,
    test: true,
  },
};

const readonlyProject: ProjectSummary = {
  project_id: "project_local",
  label: "Registered repository",
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
};

const durableSession: SessionSummary = {
  session_id: "session-durable",
  project_id: fixtureProject.project_id,
  created_at: occurredAt,
  updated_at: "2026-09-16T12:05:00.000Z",
  title: "Recover checkout investigation",
  run_ids: ["run_live"],
  entry_count: 4,
};

function artifact(kind: ArtifactRef["kind"], id = `artifact_${kind}`): ArtifactRef {
  return {
    artifact_id: id,
    kind,
    content_hash: hash,
    mime_type: kind === "diff" ? "text/x-diff" : "application/json",
    byte_length: 128,
    project_id: fixtureProject.project_id,
    run_id: "run_live",
    created_at: occurredAt,
  };
}

function event(
  sequence: number,
  type: WireSessionEvent["type"],
  overrides: Partial<WireSessionEvent> = {},
): WireSessionEvent {
  return {
    schema_version: SCHEMA_VERSION,
    event_id: `event_${sequence}`,
    project_id: fixtureProject.project_id,
    run_id: "run_live",
    sequence,
    occurred_at: occurredAt,
    type,
    summary: `${type} summary`,
    artifact_refs: [],
    data: {},
    ...overrides,
  };
}

function projection(
  status: RunProjection["status"],
  refs: readonly ArtifactRef[] = [],
  timeline: readonly WireSessionEvent[] = [],
): RunProjection {
  return {
    schema_version: SCHEMA_VERSION,
    projector_version: PROJECTOR_VERSION,
    project_id: fixtureProject.project_id,
    run_id: "run_live",
    task: "Inspect the real Host projection",
    mode: "plan",
    workspace_kind: "disposable_fixture",
    status,
    last_sequence: timeline.at(-1)?.sequence ?? 0,
    timeline: [...timeline],
    todos: { items: [], last_sequence: timeline.at(-1)?.sequence ?? 0 },
    input_queue: { pending: [] },
    subagents: {
      items: [],
      active_count: 0,
      last_sequence: 0,
      limits: { max_parallel_subagents: 2, max_depth: 1 },
    },
    attachments: { items: [], last_sequence: 0 },
    artifact_refs: [...refs],
  };
}

function emptyTeam(coordinatorRunId: string, sequence: number): NonNullable<RunProjection["team"]> {
  return {
    team_id: `team:fixture:${coordinatorRunId}`,
    coordinator_run_id: coordinatorRunId,
    limits: {
      max_parallel_workers: 2,
      heartbeat_timeout_ms: 30_000,
      max_members: 10,
      max_mailbox_messages: 100,
      max_tasks: 100,
    },
    created_event_id: `event:team-created:${sequence}`,
    created_at: occurredAt,
    roster: { members: [], last_sequence: 0 },
    mailbox: { messages: [], last_sequence: 0 },
    task_board: { items: [], last_sequence: 0 },
    last_sequence: sequence,
  };
}

function pendingProjection(previewRef: ArtifactRef): RunProjection {
  const base = projection("awaiting_approval", [previewRef], [event(1, "approval.requested")]);
  return {
    ...base,
    mode: "execute",
    pending_approval: {
      approval_id: "approval_live",
      action_id: "action_live",
      risk: "high",
      preview: {
        preview_id: "preview_live",
        action_id: "action_live",
        path: "src/index.ts",
        diff: "--- a/src/index.ts\n+++ b/src/index.ts\n@@\n-old\n+partial-inline-preview",
        base_hash: hash,
        patch_hash: hash,
        scope: ["src/index.ts"],
        expires_at: "2026-09-16T13:00:00.000Z",
        artifact_ref: previewRef,
      },
    },
  };
}

class FakeSdk implements TraceGraphSdkPort {
  readonly projects: readonly ProjectSummary[];
  currentProjection: RunProjection;
  readonly artifacts = new Map<string, ArtifactWireResponse>();
  readonly artifactRequests: Array<{ runId: string; artifactId: string }> = [];
  streamError: Error | null = null;
  streamedEvents: readonly WireSessionEvent[] = [];
  projectionAfterStreamEvent: RunProjection | null = null;
  readonly startInputs: Array<Parameters<TraceGraphSdkPort["startRun"]>[0]> = [];
  readonly chatInputs: Array<Parameters<NonNullable<TraceGraphSdkPort["startChat"]>>[0]> = [];
  readonly openLocalInputs: Array<Parameters<NonNullable<TraceGraphSdkPort["openLocalProject"]>>[0]> = [];
  readonly revealedProjects: Array<{ projectId: string; commandId?: string }> = [];
  readonly removedProjects: Array<{ projectId: string; commandId?: string }> = [];
  readonly permissionInputs: Array<Parameters<NonNullable<TraceGraphSdkPort["configurePermissionPreset"]>>[0]> = [];
  readonly planApprovalInputs: Array<Parameters<TraceGraphSdkPort["approvePlan"]>[1]> = [];
  readonly todoWriteInputs: Array<Parameters<TraceGraphSdkPort["writeTodo"]>[1]> = [];
  readonly teamCreateInputs: Array<Parameters<NonNullable<TraceGraphSdkPort["createTeam"]>>> = [];
  readonly teamMailboxInputs: Array<Parameters<NonNullable<TraceGraphSdkPort["sendTeamMailbox"]>>> = [];
  readonly teamTaskInputs: Array<Parameters<NonNullable<TraceGraphSdkPort["writeTeamTask"]>>> = [];
  readonly userInputSubmissions: Array<Parameters<TraceGraphSdkPort["submitUserInput"]>[1]> = [];
  readonly replayCreateInputs: Array<{ session_id: string; run_id: string; until_sequence: number }> = [];
  readonly replayDiffInputs: Array<{ from: number; to: number }> = [];
  readonly subagentRequests: Array<{ parentRunId: string; subagentId: string }> = [];
  readonly attachmentUploads: Array<Parameters<NonNullable<TraceGraphSdkPort["uploadAttachment"]>>[0]> = [];
  readonly attachmentContentRequests: Array<{ runId: string; attachmentId: string }> = [];
  attachmentUploadHandler: ((input: Parameters<NonNullable<TraceGraphSdkPort["uploadAttachment"]>>[0], index: number) => ReturnType<NonNullable<TraceGraphSdkPort["uploadAttachment"]>>) | null = null;
  attachmentContent: Awaited<ReturnType<NonNullable<TraceGraphSdkPort["getAttachmentContent"]>>> | null = null;
  subagentProjection: RunProjection | null = null;
  replayExitCalls = 0;
  replayRotations = 0;
  readonly activeReplayTokens = new Set<string>();
  private replayHeadSequence: number | null = null;
  createReplayHandler: ((input: { session_id: string; run_id: string; until_sequence: number }) => Promise<unknown>) | null = null;
  readonly liveActivityAfterSequences: number[] = [];
  readonly streamSignals: AbortSignal[] = [];
  readonly liveStreamSignals: AbortSignal[] = [];
  readonly modelStreamSignals: AbortSignal[] = [];
  getRunHandler: ((runId: string) => Promise<RunProjection>) | null = null;
  submitUserInputErrorAfterCommit: Error | null = null;
  stopCalls = 0;
  streamedLiveActivities: readonly LivePublicActivity[] = [];
  planApprovalError: Error | null = null;
  permissionSettings: PermissionSettingsResponse = permissionSettings;
  openLocalResult: ProjectSummary | undefined;
  sessionSummaries: SessionSummary[] = [];
  sessionQueries: SessionListQuery[] = [];
  openedSessionIds: string[] = [];
  resumedSessionIds: string[] = [];
  deletedSessionIds: string[] = [];
  recoveryReport: SessionRecoveryReport | null = null;
  telemetryStatus: TelemetryStatus = {
    schema_version: "tracegraph.telemetry-status.v1",
    sink: "noop",
    state: "disabled",
    error_count: 0,
  };
  extensionStatuses: readonly ExtensionStatus[] = [{
    name: "@tracegraph/builtin-artifact-tools",
    api_version: "tracegraph.extension.v1",
    state: "active",
    registration_count: 2,
    generation: 1,
    updated_at: occurredAt,
  }];
  readonly extensionReloads: string[] = [];

  constructor(currentProjection = projection("completed"), projects: readonly ProjectSummary[] = [fixtureProject, readonlyProject]) {
    this.currentProjection = currentProjection;
    this.projects = projects;
  }

  async bootstrap() { return { token: "browser-token", expiresAt: occurredAt, ...(this.recoveryReport === null ? {} : { recovery: this.recoveryReport }) }; }
  async listProjects() { return this.projects; }
  async listSessions(input: SessionListQuery = { limit: 50, view: "roots" }) {
    this.sessionQueries.push(input);
    return { sessions: this.sessionSummaries };
  }
  async getSession(sessionId: string) {
    this.openedSessionIds.push(sessionId);
    return {
      header: {
        kind: "header" as const,
        session_version: 1 as const,
        session_id: sessionId,
        project_id: fixtureProject.project_id,
        created_at: occurredAt,
        title: durableSession.title,
        run_ids: [this.currentProjection.run_id],
      },
      entries: [],
      truncated: false,
    };
  }
  async renameSession(sessionId: string, input: { title: string }) {
    this.sessionSummaries = this.sessionSummaries.map((session) => session.session_id === sessionId ? { ...session, title: input.title } : session);
    return this.getSession(sessionId).then((detail) => ({ ...detail, header: { ...detail.header, title: input.title } }));
  }
  async deleteSession(sessionId: string) {
    this.deletedSessionIds.push(sessionId);
    this.sessionSummaries = this.sessionSummaries.filter((session) => session.session_id !== sessionId);
    return { session_id: sessionId, deleted: true as const };
  }
  async resumeSession(sessionId: string) {
    this.resumedSessionIds.push(sessionId);
    this.currentProjection = { ...this.currentProjection, status: "awaiting_approval" };
    return {
      session_id: sessionId,
      project_id: this.currentProjection.project_id,
      run_id: this.currentProjection.run_id,
      status: "awaiting_approval" as const,
      resumed_at: occurredAt,
    };
  }
  async startRun(input: Parameters<TraceGraphSdkPort["startRun"]>[0]) { this.startInputs.push(input); return this.currentProjection; }
  async startChat(input: Parameters<NonNullable<TraceGraphSdkPort["startChat"]>>[0]) { this.chatInputs.push(input); return this.currentProjection; }
  async openLocalProject(input?: Parameters<NonNullable<TraceGraphSdkPort["openLocalProject"]>>[0]) { this.openLocalInputs.push(input); return this.openLocalResult; }
  async revealProject(projectId: string, commandId?: string) {
    this.revealedProjects.push(commandId === undefined ? { projectId } : { projectId, commandId });
  }
  async removeProject(projectId: string, commandId?: string) {
    this.removedProjects.push(commandId === undefined ? { projectId } : { projectId, commandId });
  }
  async getPermissionConfig() { return this.permissionSettings; }
  async getTelemetryStatus() { return this.telemetryStatus; }
  async listExtensions() { return this.extensionStatuses; }
  async reloadExtension(extensionName: string) {
    this.extensionReloads.push(extensionName);
    const current = this.extensionStatuses.find(({ name }) => name === extensionName);
    if (!current) throw new Error("Extension unavailable");
    return { ...current, generation: current.generation + 1 };
  }
  async configurePermissionPreset(input: Parameters<NonNullable<TraceGraphSdkPort["configurePermissionPreset"]>>[0]) {
    this.permissionInputs.push(input);
    const preset = this.permissionSettings.available_presets.find(({ key }) => key === input.preset_key);
    if (!preset) throw new Error("Preset unavailable");
    this.permissionSettings = {
      ...this.permissionSettings,
      active_preset: preset.key,
      sandbox_mode: preset.sandbox_mode,
      approval_policy: preset.approval_policy,
    };
    return this.permissionSettings;
  }
  async approve() { return this.currentProjection; }
  async approvePlan(_runId: string, input: Parameters<TraceGraphSdkPort["approvePlan"]>[1]) {
    this.planApprovalInputs.push(input);
    if (this.planApprovalError) throw this.planApprovalError;
    const { pending_plan: _pendingPlan, ...current } = this.currentProjection;
    this.currentProjection = { ...current, mode: "execute", status: "running" };
    return this.currentProjection;
  }
  async getTodos() { return this.currentProjection.todos; }
  async writeTodo(_runId: string, request: Parameters<TraceGraphSdkPort["writeTodo"]>[1]) {
    this.todoWriteInputs.push(request);
    const target = this.currentProjection.todos.items.find(({ todo_id: todoId }) => todoId === request.input.todo_id);
    if (!target) throw new Error("Todo is no longer available");
    const eventId = "event_todo_user";
    const nextTodo = {
      ...target,
      ...(request.input.state === undefined ? {} : { state: request.input.state }),
      ...(request.input.state === "done" && target.evidence_event_ids.length === 0 ? { evidence_event_ids: [eventId] } : {}),
    };
    this.currentProjection = {
      ...this.currentProjection,
      last_sequence: this.currentProjection.last_sequence + 1,
      todos: {
        items: this.currentProjection.todos.items.map((todo) => todo.todo_id === nextTodo.todo_id ? nextTodo : todo),
        last_sequence: this.currentProjection.last_sequence + 1,
      },
    };
    return { todo: nextTodo, event_type: request.input.state === "done" ? "todo.completed" as const : "todo.updated" as const, event_id: eventId, last_sequence: this.currentProjection.last_sequence };
  }
  async submitUserInput(runId: string, request: Parameters<TraceGraphSdkPort["submitUserInput"]>[1]) {
    this.userInputSubmissions.push(request);
    const existing = this.currentProjection.input_queue.pending.find((input) => (
      input.input_id === request.input_id
    ));
    if (existing !== undefined) {
      return { input: existing, disposition: "duplicate" as const };
    }
    const submittedAt = "2026-09-19T00:00:00.000Z";
    const input = {
      input_id: request.input_id ?? "input-generated",
      run_id: runId,
      kind: request.kind,
      body: request.body,
      actor: "user" as const,
      submitted_at: submittedAt,
    };
    this.currentProjection = {
      ...this.currentProjection,
      last_sequence: this.currentProjection.last_sequence + 1,
      input_queue: {
        ...this.currentProjection.input_queue,
        pending: [...this.currentProjection.input_queue.pending, input],
      },
    };
    if (this.submitUserInputErrorAfterCommit !== null) {
      const error = this.submitUserInputErrorAfterCommit;
      this.submitUserInputErrorAfterCommit = null;
      throw error;
    }
    return { input, disposition: "queued" as const };
  }
  async reject() { return this.currentProjection; }
  async stop() { this.stopCalls += 1; return this.currentProjection; }
  async getRun(runId: string) {
    return this.getRunHandler === null ? this.currentProjection : this.getRunHandler(runId);
  }
  async getSubagent(parentRunId: string, subagentId: string) {
    this.subagentRequests.push({ parentRunId, subagentId });
    if (this.subagentProjection === null) throw new Error("Child Run fixture is unavailable");
    return this.subagentProjection;
  }
  async createTeam(...input: Parameters<NonNullable<TraceGraphSdkPort["createTeam"]>>) {
    this.teamCreateInputs.push(input);
    const [runId, request = {}] = input;
    const sequence = this.currentProjection.last_sequence + 1;
    const team = emptyTeam(runId, sequence);
    this.currentProjection = {
      ...this.currentProjection,
      last_sequence: sequence,
      timeline: [...this.currentProjection.timeline, event(sequence, "team.created")],
      team,
    };
    return {
      command_id: request.command_id ?? "command:fake-team-create",
      disposition: "applied" as const,
      event_ids: [`event:team-created:${sequence}`],
      team,
    };
  }
  async sendTeamMailbox(...input: Parameters<NonNullable<TraceGraphSdkPort["sendTeamMailbox"]>>) {
    this.teamMailboxInputs.push(input);
    const [, request] = input;
    const team = this.currentProjection.team;
    if (team === undefined) throw new Error("Team fixture is unavailable");
    const sequence = this.currentProjection.last_sequence + 1;
    const deliveredAt = new Date(Date.parse(occurredAt) + sequence * 1_000).toISOString();
    const nextTeam = {
      ...team,
      mailbox: {
        messages: [...team.mailbox.messages, {
          message_id: `message:fake:${sequence}`,
          from: "coordinator",
          to: request.input.to,
          kind: request.input.kind,
          payload: request.input.payload,
          delivered_at: deliveredAt,
        }],
        last_sequence: sequence,
      },
      last_sequence: sequence,
    };
    this.currentProjection = {
      ...this.currentProjection,
      last_sequence: sequence,
      timeline: [...this.currentProjection.timeline, event(sequence, "team.mailbox_delivered")],
      team: nextTeam,
    };
    return {
      command_id: request.command_id ?? "command:fake-team-mailbox",
      disposition: "applied" as const,
      event_ids: [`event:team-mailbox:${sequence}`],
      team: nextTeam,
    };
  }
  async writeTeamTask(...input: Parameters<NonNullable<TraceGraphSdkPort["writeTeamTask"]>>) {
    this.teamTaskInputs.push(input);
    const [, request] = input;
    const team = this.currentProjection.team;
    if (team === undefined) throw new Error("Team fixture is unavailable");
    const sequence = this.currentProjection.last_sequence + 1;
    const nextTeam = request.input.operation === "cancel" ? {
      ...team,
      task_board: {
        items: team.task_board.items.map((task) => task.task_id === request.input.task_id ? {
          ...task,
          state: "cancelled" as const,
          owner: undefined,
          version: task.version + 1,
          updated_at: occurredAt,
        } : task),
        last_sequence: sequence,
      },
      last_sequence: sequence,
    } : team;
    this.currentProjection = {
      ...this.currentProjection,
      last_sequence: sequence,
      timeline: [...this.currentProjection.timeline, event(sequence, "team.task_cancelled")],
      team: nextTeam,
    };
    return {
      command_id: request.command_id ?? "command:fake-team-task",
      disposition: "applied" as const,
      event_ids: [`event:team-task:${sequence}`],
      team: nextTeam,
    };
  }
  async uploadAttachment(input: Parameters<NonNullable<TraceGraphSdkPort["uploadAttachment"]>>[0]) {
    const index = this.attachmentUploads.push(input) - 1;
    if (this.attachmentUploadHandler) return this.attachmentUploadHandler(input, index);
    const bytes = input.bytes instanceof Blob
      ? input.bytes.size
      : input.bytes instanceof ArrayBuffer
        ? input.bytes.byteLength
        : input.bytes.byteLength;
    return {
      status: "accepted" as const,
      upload_id: `upload:${index + 1}`,
      source: "user_upload" as const,
      delivery: input.delivery,
      bytes,
      expires_at: "2026-09-16T12:10:00.000Z",
      media_type: input.declared_media_type === "image/jpeg" ? "image/jpeg" as const : "image/png" as const,
      sha256: `sha256:${String(index + 1).repeat(64).slice(0, 64)}`,
    };
  }
  async getAttachmentContent(runId: string, attachmentId: string) {
    this.attachmentContentRequests.push({ runId, attachmentId });
    if (this.attachmentContent === null) throw new Error("Attachment content fixture is unavailable");
    return this.attachmentContent;
  }
  async createReplay(input: { session_id: string; run_id: string; until_sequence: number }) {
    this.replayCreateInputs.push(input);
    if (this.createReplayHandler) return this.createReplayHandler(input);
    if (this.replayHeadSequence === null) {
      this.replayHeadSequence = this.currentProjection.last_sequence;
    } else {
      this.replayRotations += 1;
      this.activeReplayTokens.clear();
    }
    if (input.until_sequence > this.replayHeadSequence) {
      throw new Error("Replay target exceeds the frozen initial head");
    }
    const replayToken = `token-${input.until_sequence}-${this.replayCreateInputs.length}`;
    this.activeReplayTokens.add(replayToken);
    const timeline = this.currentProjection.timeline.filter(({ sequence }) => sequence <= input.until_sequence);
    const replayProjection: RunProjection = {
      ...this.currentProjection,
      session_id: input.session_id,
      last_sequence: input.until_sequence,
      timeline,
      todos: { items: [], last_sequence: input.until_sequence },
      artifact_refs: timeline.flatMap(({ artifact_refs: refs }) => refs),
      input_queue: { pending: [] },
    };
    return {
      replay_id: `replay-${input.until_sequence}`,
      replay_token: replayToken,
      expires_at: "2026-09-16T13:00:00.000Z",
      snapshot: { projection: replayProjection, snapshot_hash: hash, head_sequence: this.replayHeadSequence },
    };
  }
  async getReplayDiff(input: { from: number; to: number }) {
    this.replayDiffInputs.push(input);
    const added = input.from < input.to
      ? this.currentProjection.timeline.filter(({ sequence }) => sequence > input.from && sequence <= input.to)
      : [];
    const removed = input.from > input.to
      ? this.currentProjection.timeline.filter(({ sequence }) => sequence <= input.from && sequence > input.to)
      : [];
    const isToolResult = ({ type }: WireSessionEvent) => (
      type === "tool.completed" || type === "tool.failed" || type === "tool.unknown"
    );
    return {
      schema_version: "tracegraph.replay-diff.v1",
      session_id: "session-durable",
      project_id: this.currentProjection.project_id,
      run_id: this.currentProjection.run_id,
      head_sequence: this.currentProjection.last_sequence,
      from_sequence: input.from,
      to_sequence: input.to,
      direction: input.from === input.to ? "same" : input.from < input.to ? "forward" : "backward",
      from_snapshot_hash: hash,
      to_snapshot_hash: hash,
      events: { added, removed },
      evidence: { added: [], removed: [], changed: [] },
      tool_results: { added: added.filter(isToolResult), removed: removed.filter(isToolResult) },
      todos: { added: [], removed: [], changed: [] },
      approval: { changed: false },
      pending_plan: { changed: false },
      status: { before: "running", after: "running" },
      mode: { before: "plan", after: "plan" },
    };
  }
  exitReplay() {
    this.replayExitCalls += 1;
    this.replayHeadSequence = null;
    this.activeReplayTokens.clear();
  }
  async getArtifact(runId: string, artifactId: string) {
    this.artifactRequests.push({ runId, artifactId });
    return this.artifacts.get(artifactId) ?? { status: "unavailable" as const, artifact_id: artifactId, reason: "not_found" as const };
  }
  async *streamEvents(
    _runId: string,
    options: Parameters<TraceGraphSdkPort["streamEvents"]>[1],
  ): AsyncGenerator<WireSessionEvent, void, void> {
    if (options.signal) this.streamSignals.push(options.signal);
    for (const streamedEvent of this.streamedEvents) {
      if (this.projectionAfterStreamEvent) this.currentProjection = this.projectionAfterStreamEvent;
      yield streamedEvent;
    }
    if (this.streamError) throw this.streamError;
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) {
        resolve();
        return;
      }
      options.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  async *streamLiveActivities(
    _runId: string,
    options: Parameters<NonNullable<TraceGraphSdkPort["streamLiveActivities"]>>[1],
  ): AsyncGenerator<LivePublicActivity, void, void> {
    const afterSequence = options.afterSequence ?? 0;
    if (options.signal) this.liveStreamSignals.push(options.signal);
    const closesAtPlanReady = this.currentProjection.status === "awaiting_plan_approval";
    this.liveActivityAfterSequences.push(afterSequence);
    for (const activity of this.streamedLiveActivities) {
      if (activity.sequence <= afterSequence) continue;
      yield activity;
      if (closesAtPlanReady && activity.source_event_type === "plan.ready") return;
      if (["run.completed", "run.failed", "run.cancelled", "run.interrupted", "action.diverged"].includes(activity.source_event_type)) return;
    }
  }
  async *streamModelSurface(
    _runId: string,
    options: Parameters<NonNullable<TraceGraphSdkPort["streamModelSurface"]>>[1],
  ): AsyncGenerator<ModelSurfaceEvent, void, void> {
    if (options.signal) this.modelStreamSignals.push(options.signal);
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) {
        resolve();
        return;
      }
      options.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("LiveTraceGraphClient", () => {
  it("projects only the strict read-only telemetry status exposed by the SDK", async () => {
    const sdk = new FakeSdk();
    sdk.telemetryStatus = {
      schema_version: "tracegraph.telemetry-status.v1",
      sink: "otlp_http",
      state: "degraded",
      error_count: 2,
      last_error_at: "2026-09-19T06:00:00.000Z",
    };
    const client = new LiveTraceGraphClient({ sdk });

    await client.initialize();
    await expect(client.getTelemetryStatus()).resolves.toEqual(sdk.telemetryStatus);

    sdk.telemetryStatus = {
      ...sdk.telemetryStatus,
      endpoint: "https://collector.example.test/v1/traces",
      headers: { authorization: "Bearer browser-secret" },
    } as unknown as TelemetryStatus;
    await expect(client.getTelemetryStatus()).rejects.toThrow();
  });

  it("reports an unsupported telemetry endpoint instead of inventing disabled status", async () => {
    const sdk = new FakeSdk();
    const withoutTelemetry = new Proxy(sdk, {
      get(target, property, receiver) {
        if (property === "getTelemetryStatus") return undefined;
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as TraceGraphSdkPort;
    const client = new LiveTraceGraphClient({ sdk: withoutTelemetry });

    await client.initialize();
    await expect(client.getTelemetryStatus()).rejects.toThrow(/does not support telemetry status/u);
  });

  it("strictly projects trusted extension status and delegates live reload", async () => {
    const sdk = new FakeSdk();
    const client = new LiveTraceGraphClient({ sdk });
    await client.initialize();

    await expect(client.listExtensions()).resolves.toEqual(sdk.extensionStatuses);
    await expect(client.reloadExtension("@tracegraph/builtin-artifact-tools"))
      .resolves.toMatchObject({ state: "active", generation: 2 });
    expect(sdk.extensionReloads).toEqual(["@tracegraph/builtin-artifact-tools"]);

    sdk.extensionStatuses = [{
      ...sdk.extensionStatuses[0]!,
      module: "/tmp/untrusted.mjs",
    } as unknown as ExtensionStatus];
    await expect(client.listExtensions()).rejects.toThrow();
  });

  it("approves the exact pending plan revision and continues the same Run in execute mode", async () => {
    const ready = event(3, "plan.ready", {
      data: { todo_ids: ["todo_plan"], todo_count: 1 },
    });
    const sdk = new FakeSdk({
      ...projection("awaiting_plan_approval", [], [event(1, "run.created"), ready]),
      pending_plan: { plan_event_id: ready.event_id, todo_ids: ["todo_plan"] },
      todos: {
        items: [{
          todo_id: "todo_plan",
          title: "Inspect the plan",
          state: "pending",
          depends_on: [],
          evidence_event_ids: [],
          created_by: "model",
        }],
        last_sequence: ready.sequence,
      },
    });
    const client = new LiveTraceGraphClient({ sdk });

    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Draft a plan first", "plan");

    expect(client.getSnapshot().run).toMatchObject({
      id: "run_live",
      mode: "plan",
      status: "awaiting_plan_approval",
      pendingPlan: { eventId: ready.event_id, todoIds: ["todo_plan"] },
      todos: [expect.objectContaining({ todo_id: "todo_plan" })],
    });

    sdk.streamedLiveActivities = [
      {
        schema_version: SCHEMA_VERSION,
        activity_id: `live:${ready.event_id}`,
        source_event_id: ready.event_id,
        source_event_type: "plan.ready",
        project_id: fixtureProject.project_id,
        run_id: "run_live",
        sequence: ready.sequence,
        occurred_at: occurredAt,
        kind: "run",
        status: "info",
        summary: "Plan ready for approval",
      },
      {
        schema_version: SCHEMA_VERSION,
        activity_id: "live:event_execute_tool",
        source_event_id: "event_execute_tool",
        source_event_type: "tool.started",
        project_id: fixtureProject.project_id,
        run_id: "run_live",
        sequence: ready.sequence + 1,
        occurred_at: occurredAt,
        kind: "tool",
        status: "started",
        summary: "Execute-stage tool started",
      },
    ];

    await client.approvePlan();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 10));

    expect(sdk.planApprovalInputs).toEqual([expect.objectContaining({ plan_event_id: ready.event_id })]);
    expect(sdk.liveActivityAfterSequences.at(-1)).toBe(ready.sequence);
    expect(client.getSnapshot().run).toMatchObject({ id: "run_live", mode: "execute", status: "running" });
    expect(client.getSnapshot().run).not.toHaveProperty("pendingPlan");
    expect(client.getSnapshot().run?.events.find(({ id }) => id === ready.event_id)?.state).toBe("succeeded");
    expect(client.getSnapshot().run?.publicActivities).toEqual([
      expect.objectContaining({ sourceEventId: "event_execute_tool" }),
    ]);
    await client.chooseProject("disposable_fixture");
  });

  it("refreshes the current plan revision after another client makes an approval stale", async () => {
    const oldReady = event(3, "plan.ready", { data: { todo_ids: ["todo-plan"], todo_count: 1 } });
    const newReady = event(5, "plan.ready", { data: { todo_ids: ["todo-plan"], todo_count: 1 } });
    const todo = {
      todo_id: "todo-plan",
      title: "Inspect the plan",
      state: "pending" as const,
      depends_on: [],
      evidence_event_ids: [],
      created_by: "model" as const,
    };
    const sdk = new FakeSdk({
      ...projection("awaiting_plan_approval", [], [event(1, "run.created"), oldReady]),
      pending_plan: { plan_event_id: oldReady.event_id, todo_ids: [todo.todo_id] },
      todos: { items: [todo], last_sequence: oldReady.sequence },
    });
    const client = new LiveTraceGraphClient({ sdk, minRetryMs: 60_000, maxRetryMs: 60_000 });

    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Draft a shared plan", "plan");
    sdk.currentProjection = {
      ...projection("awaiting_plan_approval", [], [event(1, "run.created"), oldReady, event(4, "todo.updated"), newReady]),
      pending_plan: { plan_event_id: newReady.event_id, todo_ids: [todo.todo_id] },
      todos: { items: [{ ...todo, state: "in_progress" }], last_sequence: newReady.sequence },
    };
    sdk.planApprovalError = new Error("Approval does not match the current plan revision");

    await expect(client.approvePlan()).rejects.toThrow("current plan revision");

    expect(sdk.planApprovalInputs).toEqual([expect.objectContaining({ plan_event_id: oldReady.event_id })]);
    expect(client.getSnapshot().run).toMatchObject({
      status: "awaiting_plan_approval",
      pendingPlan: { eventId: newReady.event_id },
      todos: [expect.objectContaining({ todo_id: todo.todo_id, state: "in_progress" })],
    });
    await client.chooseProject("disposable_fixture");
  });

  it("keeps the durable stream live while plan approval waits and observes an external Todo revision", async () => {
    const firstReady = event(3, "plan.ready", { data: { todo_ids: ["todo-plan"], todo_count: 1 } });
    const todoUpdated = event(4, "todo.updated");
    const nextReady = event(5, "plan.ready", { data: { todo_ids: ["todo-plan"], todo_count: 1 } });
    const todo = {
      todo_id: "todo-plan",
      title: "Inspect the plan",
      state: "pending" as const,
      depends_on: [],
      evidence_event_ids: [],
      created_by: "model" as const,
    };
    const sdk = new FakeSdk({
      ...projection("awaiting_plan_approval", [], [event(1, "run.created"), firstReady]),
      pending_plan: { plan_event_id: firstReady.event_id, todo_ids: [todo.todo_id] },
      todos: { items: [todo], last_sequence: firstReady.sequence },
    });
    sdk.streamedEvents = [todoUpdated, nextReady];
    sdk.projectionAfterStreamEvent = {
      ...projection("awaiting_plan_approval", [], [event(1, "run.created"), firstReady, todoUpdated, nextReady]),
      pending_plan: { plan_event_id: nextReady.event_id, todo_ids: [todo.todo_id] },
      todos: { items: [{ ...todo, state: "in_progress" }], last_sequence: nextReady.sequence },
    };
    const client = new LiveTraceGraphClient({ sdk, minRetryMs: 60_000, maxRetryMs: 60_000 });

    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Wait for shared plan edits", "plan");
    await new Promise((resolve) => globalThis.setTimeout(resolve, 10));

    expect(client.getSnapshot().run).toMatchObject({
      status: "awaiting_plan_approval",
      pendingPlan: { eventId: nextReady.event_id },
      todos: [expect.objectContaining({ todo_id: todo.todo_id, state: "in_progress" })],
    });
    await client.chooseProject("disposable_fixture");
  });

  it("restarts only the low-latency feed after another client approves the plan", async () => {
    const ready = event(3, "plan.ready", { data: { todo_ids: ["todo-plan"], todo_count: 1 } });
    const approved = event(4, "plan.approved", {
      data: { plan_event_id: ready.event_id, todo_ids: ["todo-plan"], approved_by: "user" },
    });
    const todo = {
      todo_id: "todo-plan",
      title: "Inspect the plan",
      state: "pending" as const,
      depends_on: [],
      evidence_event_ids: [],
      created_by: "model" as const,
    };
    const sdk = new FakeSdk({
      ...projection("awaiting_plan_approval", [], [event(1, "run.created"), ready]),
      pending_plan: { plan_event_id: ready.event_id, todo_ids: [todo.todo_id] },
      todos: { items: [todo], last_sequence: ready.sequence },
    });
    sdk.streamedLiveActivities = [
      {
        schema_version: SCHEMA_VERSION,
        activity_id: `live:${ready.event_id}`,
        source_event_id: ready.event_id,
        source_event_type: "plan.ready",
        project_id: fixtureProject.project_id,
        run_id: "run_live",
        sequence: ready.sequence,
        occurred_at: occurredAt,
        kind: "run",
        status: "info",
        summary: "Plan ready for approval",
      },
      {
        schema_version: SCHEMA_VERSION,
        activity_id: `live:${approved.event_id}`,
        source_event_id: approved.event_id,
        source_event_type: "plan.approved",
        project_id: fixtureProject.project_id,
        run_id: "run_live",
        sequence: approved.sequence,
        occurred_at: occurredAt,
        kind: "run",
        status: "started",
        summary: "Plan approved by another client",
      },
      {
        schema_version: SCHEMA_VERSION,
        activity_id: "live:event_external_execute_tool",
        source_event_id: "event_external_execute_tool",
        source_event_type: "tool.started",
        project_id: fixtureProject.project_id,
        run_id: "run_live",
        sequence: 5,
        occurred_at: occurredAt,
        kind: "tool",
        status: "started",
        summary: "External approval execute-stage tool started",
      },
    ];
    sdk.streamedEvents = [approved];
    sdk.projectionAfterStreamEvent = {
      ...projection("running", [], [event(1, "run.created"), ready, approved]),
      mode: "execute",
      todos: { items: [todo], last_sequence: ready.sequence },
    };
    const client = new LiveTraceGraphClient({ sdk, minRetryMs: 60_000, maxRetryMs: 60_000 });

    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Let another client approve", "plan");
    await new Promise((resolve) => globalThis.setTimeout(resolve, 10));

    expect(client.getSnapshot().run).toMatchObject({ mode: "execute", status: "running" });
    expect(sdk.liveActivityAfterSequences).toContain(ready.sequence + 1);
    expect(client.getSnapshot().run?.publicActivities).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceEventId: "event_external_execute_tool" }),
    ]));
    await client.chooseProject("disposable_fixture");
  });

  it("writes a user Todo update through the bounded SDK input and refreshes the canonical projection", async () => {
    const sdk = new FakeSdk({
      ...projection("running", [], [event(1, "run.created")]),
      mode: "execute",
      todos: {
        items: [{
          todo_id: "todo_user_update",
          title: "Verify the result",
          state: "pending",
          depends_on: [],
          evidence_event_ids: [],
          created_by: "model",
        }],
        last_sequence: 1,
      },
    });
    const client = new LiveTraceGraphClient({ sdk, minRetryMs: 60_000, maxRetryMs: 60_000 });

    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Execute the approved work", "execute");
    await client.updateTodo({ operation: "update", todo_id: "todo_user_update", state: "done" });

    expect(sdk.todoWriteInputs).toEqual([{
      command_id: expect.any(String),
      input: { operation: "update", todo_id: "todo_user_update", state: "done" },
    }]);
    expect(client.getSnapshot().run?.todos).toEqual([
      expect.objectContaining({ todo_id: "todo_user_update", state: "done", evidence_event_ids: ["event_todo_user"] }),
    ]);
    await client.chooseProject("disposable_fixture");
  });

  it("creates a durable Agent Team and refreshes the canonical root projection", async () => {
    const sdk = new FakeSdk({
      ...projection("running", [], [event(1, "run.created")]),
      mode: "execute",
    });
    const client = new LiveTraceGraphClient({ sdk, minRetryMs: 60_000, maxRetryMs: 60_000 });

    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Create a durable Team", "execute");
    await client.createTeam();

    expect(sdk.teamCreateInputs).toEqual([[
      "run_live",
      { command_id: expect.any(String) },
    ]]);
    expect(client.getSnapshot().run?.team).toMatchObject({
      coordinator_run_id: "run_live",
      roster: { members: [] },
      mailbox: { messages: [] },
      task_board: { items: [] },
    });
    expect(client.getSnapshot().run?.events.at(-1)).toMatchObject({
      kind: "team",
      title: "Agent team created",
    });
    await client.chooseProject("disposable_fixture");
  });

  it("delivers a user steer and cancels only the selected shared-task revision", async () => {
    const timeline = Array.from({ length: 6 }, (_, index) => event(index + 1, index === 0
      ? "run.created"
      : index === 1
        ? "subagent.started"
        : index === 2
          ? "team.created"
          : index === 3
            ? "team.member_joined"
            : index === 4
              ? "team.task_created"
              : "team.task_claimed"));
    const link = {
      subagent_id: "subagent:worker",
      parent_run_id: "run_live",
      parent_session_id: "session:root",
      child_run_id: "run:child",
      child_session_id: "session:child",
    };
    const sdk = new FakeSdk({
      ...projection("running", [], timeline),
      session_id: "session:root",
      mode: "execute",
      subagents: {
        items: [{
          link,
          name: "verifier",
          provider_key: "fixture",
          role_prompt_version: "team-verifier.v1",
          role_prompt_hash: hash,
          tool_allowlist: ["team_read", "team_task_write", "team_mailbox_claim", "team_heartbeat"],
          context_scope: "isolated",
          budget: { max_steps: 4, max_tokens: 4_000 },
          depth: 1,
          status: "running",
          started_event_id: timeline[1]!.event_id,
          initial_message_event_id: "event:subagent-message",
          message_count: 1,
          started_at: occurredAt,
        }],
        active_count: 1,
        last_sequence: 2,
        limits: { max_parallel_subagents: 2, max_depth: 1 },
      },
      team: {
        team_id: "team:one",
        coordinator_run_id: "run_live",
        limits: {
          max_parallel_workers: 2,
          heartbeat_timeout_ms: 30_000,
          max_members: 10,
          max_mailbox_messages: 100,
          max_tasks: 100,
        },
        created_event_id: timeline[2]!.event_id,
        created_at: occurredAt,
        roster: {
          members: [{ link, role: "verifier", status: "active", joined_at: occurredAt, last_heartbeat_at: occurredAt }],
          last_sequence: 4,
        },
        mailbox: { messages: [], last_sequence: 0 },
        task_board: {
          items: [{
            task_id: "task:verify",
            title: "Verify single-owner claims",
            state: "claimed",
            owner: "subagent:worker",
            acceptance: ["Only one worker owns the task"],
            evidence_event_ids: [],
            version: 2,
            created_at: occurredAt,
            updated_at: occurredAt,
          }],
          last_sequence: 6,
        },
        last_sequence: 6,
      },
    });
    const client = new LiveTraceGraphClient({ sdk, minRetryMs: 60_000, maxRetryMs: 60_000 });

    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Coordinate a verifier", "execute");
    const task = client.getSnapshot().run?.team?.task_board.items[0];
    expect(task).toBeDefined();
    await client.steerTeamMember("subagent:worker", "Check the claim race next.");
    await client.cancelTeamTask(task!);

    expect(sdk.teamMailboxInputs).toEqual([[
      "run_live",
      {
        command_id: expect.any(String),
        input: { to: "subagent:worker", kind: "steer", payload: "Check the claim race next." },
      },
    ]]);
    expect(sdk.teamTaskInputs).toEqual([[
      "run_live",
      {
        command_id: expect.any(String),
        input: {
          operation: "cancel",
          task_id: "task:verify",
          expected_version: 2,
          reason: "Cancelled by the user in TraceGraph Web",
        },
      },
    ]]);
    expect(client.getSnapshot().run?.team).toMatchObject({
      mailbox: { messages: [expect.objectContaining({ kind: "steer", to: "subagent:worker" })] },
      task_board: { items: [expect.objectContaining({ task_id: "task:verify", state: "cancelled", version: 3 })] },
    });
    await client.chooseProject("disposable_fixture");
  });

  it("queues runtime guidance and cancellation for a read-only project without requesting workspace write authority", async () => {
    const sdk = new FakeSdk({
      ...projection("running", [], [event(1, "run.created")]),
      project_id: readonlyProject.project_id,
      mode: "plan",
    }, [readonlyProject]);
    const client = new LiveTraceGraphClient({ sdk, minRetryMs: 60_000, maxRetryMs: 60_000 });

    await client.initialize();
    await client.chooseProject("readonly_local");
    await client.startRun("Inspect without workspace writes", "plan");
    await client.submitUserInput("message", "Inspect the retry path next");
    await client.stop();

    expect(sdk.userInputSubmissions).toEqual([
      expect.objectContaining({
        command_id: expect.any(String),
        input_id: expect.any(String),
        kind: "message",
        body: "Inspect the retry path next",
      }),
      expect.objectContaining({
        command_id: expect.any(String),
        input_id: expect.any(String),
        kind: "cancel",
        body: "",
      }),
    ]);
    expect(client.getSnapshot().run?.inputQueue.pending).toEqual([
      expect.objectContaining({ kind: "message", actor: "user" }),
      expect.objectContaining({ kind: "cancel", actor: "user" }),
    ]);
    expect(client.getSnapshot().run?.status).toBe("running");
    expect(sdk.stopCalls).toBe(0);
    expect(sdk.streamSignals.at(-1)?.aborted).toBe(false);
    await client.returnHome();
  });

  it("reuses input and command ids when a committed steering response is lost", async () => {
    const sdk = new FakeSdk(projection("running", [], [event(1, "run.started")]));
    sdk.submitUserInputErrorAfterCommit = new Error("Transport closed after Host commit");
    const client = new LiveTraceGraphClient({ sdk, minRetryMs: 60_000, maxRetryMs: 60_000 });
    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Retry one durable user intent", "plan");

    await expect(client.submitUserInput("message", "Inspect the same edge once"))
      .rejects.toThrow("Transport closed after Host commit");
    await client.submitUserInput("message", "Inspect the same edge once");

    expect(sdk.userInputSubmissions).toHaveLength(2);
    expect(sdk.userInputSubmissions[1]).toMatchObject({
      command_id: sdk.userInputSubmissions[0]?.command_id,
      input_id: sdk.userInputSubmissions[0]?.input_id,
    });
    expect(sdk.currentProjection.input_queue.pending).toHaveLength(1);
  });

  it("does not let a stale projection overwrite a newer cancellation", async () => {
    const terminal = projection("cancelled", [], [event(13, "run.cancelled")]);
    const client = new LiveTraceGraphClient({ sdk: new FakeSdk(terminal) });
    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Keep the newest canonical state", "plan");

    const internal = client as unknown as {
      acceptProjection: (
        value: RunProjection,
        connection: { state: "live"; message: string; lastSequence: number },
      ) => Promise<void>;
    };
    await internal.acceptProjection(
      projection("running", [], [event(11, "model.decision")]),
      { state: "live", message: "Late stale refresh", lastSequence: 11 },
    );

    expect(client.getSnapshot().run).toMatchObject({ status: "cancelled", lastSequence: 13 });
  });

  it("lazily loads relation-scoped child ledgers and clears them on replay", async () => {
    const parentTimeline = [event(1, "run.created"), event(2, "subagent.started")];
    const parent = {
      ...projection("running", [], parentTimeline),
      session_id: "session-durable",
      subagents: {
        items: [{
          link: {
            subagent_id: "subagent-one",
            parent_run_id: "run_live",
            parent_session_id: "session-durable",
            child_run_id: "run-child",
            child_session_id: "session-child",
          },
          name: "readonly",
          provider_key: "parent",
          role_prompt_version: "tracegraph.subagent.readonly.v1",
          role_prompt_hash: hash,
          tool_allowlist: ["search"],
          context_scope: "isolated" as const,
          budget: { max_steps: 4, max_tokens: 4_000 },
          depth: 1,
          status: "running" as const,
          started_event_id: "event_2",
          started_at: occurredAt,
          message_count: 1,
          initial_message_event_id: "event-subagent-message",
          last_message_at: occurredAt,
        }],
        active_count: 1,
        last_sequence: 2,
        limits: { max_parallel_subagents: 2, max_depth: 1 },
      },
    } satisfies RunProjection;
    const childEvent = event(1, "run.created", {
      run_id: "run-child",
      session_id: "session-child",
      summary: "Child Run created",
    });
    const child = {
      ...projection("completed", [], [childEvent]),
      session_id: "session-child",
      run_id: "run-child",
      task: "Inspect delegated files",
      outcome: "Found the relevant call sites",
    } satisfies RunProjection;
    const sdk = new FakeSdk(parent);
    sdk.subagentProjection = child;
    const client = new LiveTraceGraphClient({ sdk, minRetryMs: 60_000, maxRetryMs: 60_000 });

    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Delegate read-only inspection", "plan");
    expect(sdk.subagentRequests).toEqual([]);
    expect(client.getSnapshot().run?.subagents[0]?.detail).toEqual({ state: "idle" });

    await client.loadSubagent("subagent-one");
    expect(sdk.subagentRequests).toEqual([{ parentRunId: "run_live", subagentId: "subagent-one" }]);
    expect(client.getSnapshot().run?.subagents[0]?.detail).toMatchObject({
      state: "available",
      run: { id: "run-child", lastSequence: 1, events: [{ summary: "Child Run created" }] },
    });

    const terminalParent = {
      ...parent,
      last_sequence: 3,
      timeline: [...parent.timeline, event(3, "subagent.completed")],
      subagents: {
        ...parent.subagents,
        active_count: 0,
        last_sequence: 3,
        items: parent.subagents.items.map((item) => ({
          ...item,
          status: "completed" as const,
          finished_event_id: "event_3",
          finished_at: occurredAt,
          result: {
            subagent_id: item.link.subagent_id,
            child_run_id: item.link.child_run_id,
            status: "completed" as const,
            summary: "Found the relevant call sites",
            artifact_refs: [],
          },
        })),
      },
    } satisfies RunProjection;
    const internal = client as unknown as {
      acceptProjection: (
        value: RunProjection,
        connection: { state: "live"; message: string; lastSequence: number },
      ) => Promise<void>;
    };
    await internal.acceptProjection(
      terminalParent,
      { state: "live", message: "Child completed", lastSequence: 3 },
    );
    expect(client.getSnapshot().run?.subagents[0]?.detail).toEqual({ state: "idle" });
    await client.loadSubagent("subagent-one");
    expect(sdk.subagentRequests).toHaveLength(2);

    await client.enterReplay(1);
    expect(client.getSnapshot().run?.subagents[0]?.detail).toEqual({ state: "idle" });
    await expect(client.loadSubagent("subagent-one")).rejects.toThrow(/unavailable while viewing a replay/u);
    await client.returnToLive();
    await client.returnHome();
  });

  it("freezes the replay head, rotates capabilities while stepping, and refreshes the live head on return", async () => {
    const timeline = [
      event(1, "run.created"),
      event(2, "run.started", { data: { phase: "agent" } }),
      event(3, "tool.completed", { data: { tool_name: "read_file" } }),
    ];
    const sdk = new FakeSdk({
      ...projection("running", [], timeline),
      session_id: "session-durable",
    });
    const client = new LiveTraceGraphClient({ sdk, minRetryMs: 60_000, maxRetryMs: 60_000 });
    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Inspect replay safety", "plan");
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    const liveSignal = sdk.streamSignals.at(-1);

    await client.enterReplay(2);

    expect(liveSignal?.aborted).toBe(true);
    expect(sdk.liveStreamSignals.at(-1)?.aborted).toBe(true);
    expect(sdk.modelStreamSignals.at(-1)?.aborted).toBe(true);
    expect(client.getSnapshot()).toMatchObject({
      replay: { state: "active", requestedSequence: 2, headSequence: 3 },
      run: { lastSequence: 2 },
    });
    expect(client.getSnapshot().run?.events.map(({ sequence }) => sequence)).toEqual([1, 2]);
    await expect(client.stop()).rejects.toThrow(/read-only replay snapshot/u);
    await expect(client.updateTodo({ operation: "update", todo_id: "todo-any", state: "done" }))
      .rejects.toThrow(/read-only replay snapshot/u);
    await expect(client.createTeam()).rejects.toThrow(/read-only replay snapshot/u);

    sdk.currentProjection = {
      ...sdk.currentProjection,
      last_sequence: 4,
      timeline: [...timeline, event(4, "context.built")],
    };
    await client.stepReplay(1);
    expect(client.getSnapshot().replay).toMatchObject({ requestedSequence: 3, headSequence: 3 });
    expect(sdk.replayDiffInputs.at(-1)).toEqual({ from: 2, to: 3 });
    expect(sdk.replayExitCalls).toBe(0);
    expect(sdk.replayRotations).toBe(1);
    expect(sdk.activeReplayTokens.size).toBe(1);

    await client.stepReplay(-1);
    expect(client.getSnapshot().replay).toMatchObject({ requestedSequence: 2, headSequence: 3 });
    expect(client.getSnapshot().replay?.diff).toMatchObject({
      fromSequence: 3,
      toSequence: 2,
      addedEvents: [],
      removedEvents: [{ sequence: 3 }],
      toolResults: [{ kind: "removed", sequence: 3, toolName: "read_file" }],
    });
    expect(sdk.replayDiffInputs.at(-1)).toEqual({ from: 3, to: 2 });
    expect(sdk.replayExitCalls).toBe(0);
    expect(sdk.replayRotations).toBe(2);
    expect(sdk.activeReplayTokens.size).toBe(1);
    await expect(client.enterReplay(4)).rejects.toThrow(/canonical event/u);

    await client.returnToLive();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

    expect(client.getSnapshot().replay).toBeUndefined();
    expect(client.getSnapshot().run?.lastSequence).toBe(4);
    expect(sdk.replayExitCalls).toBe(1);
    expect(sdk.activeReplayTokens.size).toBe(0);
    expect(sdk.streamSignals.at(-1)?.aborted).toBe(false);
    await client.returnHome();
  });

  it("keeps only the newest replay request when replay responses resolve out of order", async () => {
    const timeline = [event(1, "run.created"), event(2, "run.started"), event(3, "model.decision")];
    const sdk = new FakeSdk({
      ...projection("running", [], timeline),
      session_id: "session-durable",
    });
    const firstRequested = deferred<void>();
    const firstResponse = deferred<unknown>();
    const responseFor = (input: { session_id: string; run_id: string; until_sequence: number }) => ({
      replay_id: `replay-${input.until_sequence}`,
      replay_token: `token-${input.until_sequence}`,
      expires_at: "2026-09-16T13:00:00.000Z",
      snapshot: {
        projection: {
          ...sdk.currentProjection,
          last_sequence: input.until_sequence,
          timeline: timeline.filter(({ sequence }) => sequence <= input.until_sequence),
          todos: { items: [], last_sequence: input.until_sequence },
        },
        snapshot_hash: hash,
        head_sequence: sdk.currentProjection.last_sequence,
      },
    });
    sdk.createReplayHandler = async (input) => {
      if (input.until_sequence === 2) {
        firstRequested.resolve(undefined);
        return firstResponse.promise;
      }
      return responseFor(input);
    };
    const client = new LiveTraceGraphClient({ sdk, minRetryMs: 60_000, maxRetryMs: 60_000 });
    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Prefer the newest replay target", "plan");

    const first = client.enterReplay(2);
    await firstRequested.promise;
    const second = client.enterReplay(3);
    firstResponse.resolve(responseFor({ session_id: "session-durable", run_id: "run_live", until_sequence: 2 }));
    await Promise.all([first, second]);

    expect(sdk.replayCreateInputs.map(({ until_sequence }) => until_sequence)).toEqual([2, 3]);
    expect(client.getSnapshot()).toMatchObject({
      replay: { state: "active", requestedSequence: 3 },
      run: { lastSequence: 3 },
    });
    await client.returnToLive();
    await client.returnHome();
  });

  it("suppresses an obsolete replay failure so it cannot pollute or exit the latest replay", async () => {
    const timeline = [event(1, "run.created"), event(2, "run.started"), event(3, "model.decision")];
    const sdk = new FakeSdk({
      ...projection("running", [], timeline),
      session_id: "session-durable",
    });
    const firstRequested = deferred<void>();
    const firstFailure = deferred<void>();
    sdk.createReplayHandler = async (input) => {
      if (input.until_sequence === 2) {
        firstRequested.resolve(undefined);
        await firstFailure.promise;
        throw new Error("obsolete replay failed");
      }
      return {
        replay_id: `replay-${input.until_sequence}`,
        replay_token: `token-${input.until_sequence}`,
        expires_at: "2026-09-16T13:00:00.000Z",
        snapshot: {
          projection: {
            ...sdk.currentProjection,
            last_sequence: input.until_sequence,
            timeline: timeline.filter(({ sequence }) => sequence <= input.until_sequence),
            todos: { items: [], last_sequence: input.until_sequence },
          },
          snapshot_hash: hash,
          head_sequence: 3,
        },
      };
    };
    const client = new LiveTraceGraphClient({ sdk, minRetryMs: 60_000, maxRetryMs: 60_000 });
    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Ignore an obsolete replay error", "plan");

    const obsolete = client.enterReplay(2);
    await firstRequested.promise;
    const latest = client.enterReplay(3);
    firstFailure.resolve(undefined);

    await expect(obsolete).resolves.toBeUndefined();
    await latest;
    expect(sdk.replayExitCalls).toBe(0);
    expect(client.getSnapshot()).toMatchObject({
      replay: { state: "active", requestedSequence: 3 },
      run: { lastSequence: 3 },
    });

    await client.returnToLive();
    await client.returnHome();
  });

  it("ignores a late refresh from an obsolete Run stream after project switch", async () => {
    const oldProjection = projection("running", [], [event(11, "model.decision")]);
    const sdk = new FakeSdk(oldProjection);
    const requested = deferred<void>();
    const response = deferred<RunProjection>();
    sdk.getRunHandler = async () => {
      requested.resolve(undefined);
      return response.promise;
    };
    const client = new LiveTraceGraphClient({ sdk, minRetryMs: 60_000, maxRetryMs: 60_000 });
    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Do not resurrect this Run", "plan");
    await requested.promise;

    await client.chooseProject("readonly_local");
    response.resolve(oldProjection);
    await response.promise;
    await Promise.resolve();

    expect(client.getSnapshot().project?.id).toBe(readonlyProject.project_id);
    expect(client.getSnapshot().run).toBeNull();
  });

  it("keeps a late steering refresh from reclaiming the workbench after project switch", async () => {
    const sdk = new FakeSdk(projection("running", [], [event(1, "run.started")]));
    const client = new LiveTraceGraphClient({ sdk, minRetryMs: 60_000, maxRetryMs: 60_000 });
    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Queue guidance on this Run", "plan");
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    expect(sdk.streamSignals.length).toBeGreaterThan(0);

    const requested = deferred<void>();
    const response = deferred<RunProjection>();
    sdk.getRunHandler = async () => {
      requested.resolve(undefined);
      return response.promise;
    };
    const submitting = client.submitUserInput("message", "Do not reopen this view");
    await requested.promise;
    const oldRunAfterSubmit = sdk.currentProjection;

    await client.chooseProject("readonly_local");
    response.resolve(oldRunAfterSubmit);
    await submitting;

    expect(client.getSnapshot().project?.id).toBe(readonlyProject.project_id);
    expect(client.getSnapshot().run).toBeNull();
    expect(sdk.userInputSubmissions).toHaveLength(1);
  });

  it("projects consumed steering input with its durable safe-step marker", async () => {
    const queued = event(2, "user.input_queued", {
      data: {
        input: {
          input_id: "input-consumed",
          run_id: "run_live",
          kind: "message",
          body: "Check the parser edge case",
          actor: "user",
          submitted_at: occurredAt,
        },
      },
    });
    const consumed = event(3, "user.input_consumed", {
      data: {
        input_id: "input-consumed",
        kind: "message",
        consumed_at: "2026-09-16T12:00:01.000Z",
        at_step: 2,
        queued_event_id: queued.event_id,
      },
    });
    const sdk = new FakeSdk({
      ...projection("running", [], [event(1, "run.created"), queued, consumed]),
      input_queue: {
        pending: [],
        last_consumed: {
          input_id: "input-consumed",
          kind: "message",
          consumed_at: "2026-09-16T12:00:01.000Z",
          at_step: 2,
          queued_event_id: queued.event_id,
        },
      },
    });
    const client = new LiveTraceGraphClient({ sdk, minRetryMs: 60_000, maxRetryMs: 60_000 });

    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Observe queued guidance", "plan");

    expect(client.getSnapshot().run?.inputQueue).toMatchObject({
      pending: [],
      lastConsumed: { input_id: "input-consumed", at_step: 2 },
    });
    expect(client.getSnapshot().run?.events.find(({ id }) => id === consumed.event_id)).toMatchObject({
      title: "User input consumed",
      kind: "query",
      inputId: "input-consumed",
      inputKind: "message",
      atStep: 2,
    });
    await client.chooseProject("disposable_fixture");
  });

  it.each(["completed", "failed", "cancelled", "interrupted", "needs_manual_review"] as const)(
    "refuses steering input while the Run is %s",
    async (status) => {
      const sdk = new FakeSdk(projection(status, [], [event(1, "run.created")]));
      const client = new LiveTraceGraphClient({ sdk });

      await client.initialize();
      await client.chooseProject("disposable_fixture");
      await client.startRun("Restore a stopped Run", "plan");

      await expect(client.submitUserInput("message", "Do more work"))
        .rejects.toThrow(status === "interrupted" || status === "needs_manual_review" ? "recovery or manual review" : "Run has stopped");
      expect(sdk.userInputSubmissions).toHaveLength(0);
      await client.chooseProject("disposable_fixture");
    },
  );

  it.each(["completed", "failed", "cancelled", "interrupted", "needs_manual_review"] as const)(
    "refuses user Todo updates while the Run is %s",
    async (status) => {
      const sdk = new FakeSdk({
        ...projection(status, [], [event(1, "run.created")]),
        mode: "execute",
        todos: {
          items: [{
            todo_id: "todo-locked",
            title: "Cannot change this Todo",
            state: "pending",
            depends_on: [],
            evidence_event_ids: [],
            created_by: "model",
          }],
          last_sequence: 1,
        },
      });
      const client = new LiveTraceGraphClient({ sdk });

      await client.initialize();
      await client.chooseProject("disposable_fixture");
      await client.startRun("Restore a stopped Run", "execute");

      await expect(client.updateTodo({ operation: "update", todo_id: "todo-locked", state: "done" }))
        .rejects.toThrow(status === "interrupted" || status === "needs_manual_review" ? "recovery or manual review" : "terminal Run");
      expect(sdk.todoWriteInputs).toHaveLength(0);
      await client.chooseProject("disposable_fixture");
    },
  );

  it("settles the live wait at plan.ready without marking the Run terminal or reconnecting", async () => {
    const sdk = new FakeSdk(projection("running", [], [event(1, "run.started")]));
    const ready = event(2, "plan.ready", { data: { todo_ids: ["todo-plan"], todo_count: 1 } });
    sdk.streamedEvents = [ready];
    sdk.projectionAfterStreamEvent = {
      ...projection("awaiting_plan_approval", [], [event(1, "run.started"), ready]),
      pending_plan: { plan_event_id: ready.event_id, todo_ids: ["todo-plan"] },
      todos: {
        items: [{
          todo_id: "todo-plan",
          title: "Review the plan",
          state: "pending",
          depends_on: [],
          evidence_event_ids: [],
          created_by: "model",
        }],
        last_sequence: ready.sequence,
      },
    };
    const client = new LiveTraceGraphClient({ sdk, minRetryMs: 60_000, maxRetryMs: 60_000 });

    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Pause after planning", "plan");
    await new Promise((resolve) => globalThis.setTimeout(resolve, 10));

    expect(client.getSnapshot().connection.state).toBe("live");
    expect(client.getSnapshot().run).toMatchObject({
      status: "awaiting_plan_approval",
      mode: "plan",
      pendingPlan: { eventId: ready.event_id },
    });
    await client.chooseProject("disposable_fixture");
  });

  it("lists, searches, restores, and resumes a durable interrupted session", async () => {
    const sdk = new FakeSdk({
      ...projection("interrupted", [], [event(1, "run.created"), event(2, "run.interrupted")]),
      session_id: durableSession.session_id,
    });
    sdk.sessionSummaries = [durableSession];
    sdk.recoveryReport = {
      scanned_sessions: 1,
      truncated_session_ids: [],
      interrupted_run_ids: ["run_live"],
      reconciled_action_ids: [],
      aborted_action_ids: [],
      diverged_action_ids: [],
      recovered_at: occurredAt,
    };
    const client = new LiveTraceGraphClient({ sdk });

    await client.initialize();
    expect(client.getSnapshot()).toMatchObject({
      sessions: [{ session_id: "session-durable" }],
      recovery: { interrupted_run_ids: ["run_live"] },
    });

    await client.searchSessions("checkout");
    expect(sdk.sessionQueries.at(-1)).toMatchObject({ q: "checkout", view: "roots", limit: 50 });

    await client.openSession("session-durable");
    expect(sdk.openedSessionIds).toEqual(["session-durable"]);
    expect(client.getSnapshot()).toMatchObject({
      selectedSessionId: "session-durable",
      sessionViewState: "restored",
      run: { id: "run_live", status: "interrupted" },
    });

    await client.resumeSession("session-durable");
    expect(sdk.resumedSessionIds).toEqual(["session-durable"]);
    expect(client.getSnapshot()).toMatchObject({
      selectedSessionId: "session-durable",
      sessionViewState: "resumed",
      run: { id: "run_live", status: "needs_approval" },
    });
  });

  it("rebuilds estimate and provider usage from a historical durable projection", async () => {
    const contextRef = artifact("context_manifest", "artifact_metered_context");
    const contextEvent = meteredContextEvent(1, "model_call_current", contextRef);
    const usageEvent = providerUsageEvent(2, "model_call_current", {
      input_tokens: 1_320,
      output_tokens: 280,
      cached_input_tokens: 420,
      reasoning_output_tokens: 90,
      total_tokens: 1_600,
      estimated_input_tokens: 1_000,
      delta_ratio: 1.32,
      anomaly: true,
      provider_reported_cost: { amount: 0.0042, currency: "USD" },
      cost_status: "provider_reported",
    });
    const anomalyEvent = event(3, "model.usage_anomaly", {
      model_call_id: "model_call_current",
      context_manifest_ref: "manifest_metered",
      data: { ...usageEvent.data },
    });
    const sdk = new FakeSdk({
      ...projection("completed", [contextRef], [contextEvent, usageEvent, anomalyEvent, event(4, "run.completed")]),
      session_id: durableSession.session_id,
    });
    sdk.sessionSummaries = [durableSession];
    sdk.artifacts.set(contextRef.artifact_id, {
      status: "available",
      artifact: contextRef,
      content: meteredContextManifest("manifest_metered", "model_call_current"),
    });
    const client = new LiveTraceGraphClient({ sdk });

    await client.initialize();
    await client.openSession(durableSession.session_id);

    expect(client.getSnapshot().run?.contextBudget).toMatchObject({
      modelCallId: "model_call_current",
      estimate: {
        estimatorId: "heuristic:openai:gpt-test:r2",
        confidence: "calibrated",
        inputTokens: 1_000,
        perSection: { system: 0, goal: 0, history: 0, tool: 0, repo: 1_000, memory: 0 },
      },
      providerUsage: {
        modelCallId: "model_call_current",
        provider: "openai",
        model: "gpt-test",
        inputTokens: 1_320,
        outputTokens: 280,
        cachedInputTokens: 420,
        reasoningOutputTokens: 90,
        totalTokens: 1_600,
        cost: { status: "provider_reported", amount: 0.0042, currency: "USD" },
        anomaly: true,
      },
    });
    expect(client.getSnapshot().sessionViewState).toBe("restored");
    expect(client.getSnapshot().eventEvidence.event_1?.contextBudget?.providerUsage?.totalTokens).toBe(1_600);
  });

  it("soft-deletes the selected session and clears only its restored view", async () => {
    const sdk = new FakeSdk({
      ...projection("completed", [], [event(1, "run.completed")]),
      session_id: durableSession.session_id,
    });
    sdk.sessionSummaries = [durableSession];
    const client = new LiveTraceGraphClient({ sdk });

    await client.initialize();
    await client.renameSession(durableSession.session_id, "Renamed durable session");
    expect(client.getSnapshot().sessions[0]?.title).toBe("Renamed durable session");
    await client.openSession(durableSession.session_id);
    await client.deleteSession(durableSession.session_id);

    expect(sdk.deletedSessionIds).toEqual([durableSession.session_id]);
    expect(client.getSnapshot()).toMatchObject({
      selectedSessionId: null,
      run: null,
      sessions: [],
    });
  });

  it("selects the exact Host-picked directory, exposes its location, and delegates reveal", async () => {
    const linkedProject: ProjectSummary = {
      project_id: "project_linked",
      label: "Selected workspace",
      workspace_kind: "managed_local",
      capabilities: fixtureProject.capabilities,
      location: {
        kind: "linked_directory",
        display_path: "/Users/cain/Projects/selected-workspace",
        can_reveal: true,
        access: "read_write",
      },
    };
    const sdk = new FakeSdk(projection("completed"), [fixtureProject]);
    sdk.openLocalResult = linkedProject;
    const client = new LiveTraceGraphClient({ sdk });

    await client.initialize();
    await client.openLocalProject("read_write");

    expect(sdk.openLocalInputs).toEqual([{ access: "read_write" }]);
    expect(client.getSnapshot().project).toEqual({
      id: "project_linked",
      name: "Selected workspace",
      pathLabel: "/Users/cain/Projects/selected-workspace",
      workspaceKind: "managed_local",
      location: {
        kind: "linked_directory",
        displayPath: "/Users/cain/Projects/selected-workspace",
        canReveal: true,
        access: "read_write",
      },
    });
    expect(client.getSnapshot().availableProjects.map((project) => project.id)).toEqual([
      "project_fixture",
      "project_linked",
    ]);

    await client.revealProject("project_linked");
    expect(sdk.revealedProjects).toEqual([{ projectId: "project_linked" }]);

    await client.removeProject("project_linked");
    expect(sdk.removedProjects).toEqual([{ projectId: "project_linked" }]);
    expect(client.getSnapshot()).toMatchObject({ project: null, run: null });
    expect(client.getSnapshot().availableProjects.map((project) => project.id)).toEqual(["project_fixture"]);
  });

  it("returns home without dropping the Host project list", async () => {
    const client = new LiveTraceGraphClient({ sdk: new FakeSdk() });

    await client.initialize();
    await client.chooseProjectById("project_local");
    await client.returnHome();

    expect(client.getSnapshot()).toMatchObject({ project: null, run: null });
    expect(client.getSnapshot().availableProjects.map((project) => project.id)).toEqual([
      "project_fixture",
      "project_local",
    ]);
  });

  it("keeps plain chat projectless and sends bounded history plus reasoning effort to the next turn", async () => {
    const sdk = new FakeSdk({
      ...projection("completed", [], [event(1, "model.decision"), event(2, "run.completed")]),
      project_id: "project_plain_chat",
      run_id: "run_chat_first",
      task: "First plain question",
      outcome: "First plain answer",
    });
    const client = new LiveTraceGraphClient({ sdk });

    await client.initialize();
    await client.startChat("First plain question", "high");

    expect(client.getSnapshot().project).toBeNull();
    expect(sdk.chatInputs[0]).toMatchObject({
      task: "First plain question",
      reasoning_effort: "high",
      conversation_history: [],
    });
    expect(sdk.chatInputs[0]).not.toHaveProperty("project_id");

    sdk.currentProjection = {
      ...projection("completed", [], [event(1, "run.completed")]),
      project_id: "project_plain_chat",
      run_id: "run_chat_second",
      task: "Second plain question",
      outcome: "Second plain answer",
    };
    await client.startChat("Second plain question", "xhigh");

    expect(client.getSnapshot().project).toBeNull();
    expect(client.getSnapshot().conversation).toEqual([
      expect.objectContaining({
        runId: "run_chat_first",
        task: "First plain question",
        response: "First plain answer",
      }),
    ]);
    expect(sdk.chatInputs[1]).toMatchObject({
      task: "Second plain question",
      reasoning_effort: "xhigh",
      conversation_history: [
        { role: "user", content: "First plain question" },
        { role: "assistant", content: "First plain answer" },
      ],
    });
    expect(sdk.chatInputs[1]).not.toHaveProperty("project_id");
  });

  it("stages ordered project and hidden-chat attachments before starting each new Run", async () => {
    const sdk = new FakeSdk();
    sdk.attachmentUploadHandler = async (input, index) => index === 0
      ? {
          status: "accepted",
          upload_id: "upload:image",
          source: "user_upload",
          delivery: input.delivery,
          bytes: 4,
          expires_at: "2026-09-16T12:10:00.000Z",
          media_type: "image/png",
          sha256: hash,
        }
      : {
          status: "rejected",
          upload_id: "upload:pdf-rejected",
          source: "user_upload",
          delivery: input.delivery,
          bytes: 3,
          expires_at: "2026-09-16T12:10:00.000Z",
          declared_media_type: input.declared_media_type,
          code: "media_type_mismatch",
          reason: "Declared PDF bytes did not contain a PDF signature",
        };
    const client = new LiveTraceGraphClient({ sdk });

    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Inspect selected files", "plan", "default", [{
      id: "draft:image",
      label: "diagram.png",
      file: new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }),
      declaredMediaType: "image/png",
      delivery: "inline",
    }, {
      id: "draft:pdf",
      label: "notes.pdf",
      file: new Blob([Uint8Array.from([1, 2, 3])], { type: "application/pdf" }),
      declaredMediaType: "application/pdf",
      delivery: "offload",
    }]);

    expect(sdk.attachmentUploads).toEqual([
      expect.objectContaining({ target: "project", project_id: fixtureProject.project_id, declared_media_type: "image/png", delivery: "inline" }),
      expect.objectContaining({ target: "project", project_id: fixtureProject.project_id, declared_media_type: "application/pdf", delivery: "offload" }),
    ]);
    expect(sdk.startInputs.at(-1)).toMatchObject({
      attachment_upload_ids: ["upload:image", "upload:pdf-rejected"],
    });

    sdk.attachmentUploads.length = 0;
    sdk.attachmentUploadHandler = null;
    await client.startChat("Explain this screenshot", "medium", [{
      id: "draft:chat-image",
      label: "screen.png",
      file: new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }),
      declaredMediaType: "image/png",
      delivery: "offload",
    }]);

    expect(sdk.attachmentUploads).toHaveLength(1);
    expect(sdk.attachmentUploads[0]).toMatchObject({ target: "chat", declared_media_type: "image/png" });
    expect(sdk.attachmentUploads[0]).not.toHaveProperty("project_id");
    expect(sdk.chatInputs.at(-1)).toMatchObject({ attachment_upload_ids: ["upload:1"] });
  });

  it("maps relation-scoped attachment cards and disables content reads in replay", async () => {
    const attachment = {
      attachment_id: "attachment:image",
      media_type: "image/png" as const,
      bytes: 4,
      sha256: hash,
      source: "user_upload" as const,
    };
    const timeline = [
      event(1, "run.created"),
      event(2, "attachment.added", { data: { upload_id: "upload:image" } }),
      event(3, "attachment.offloaded", { data: { upload_id: "upload:image" } }),
      event(4, "attachment.rejected", { data: { upload_id: "upload:rejected", code: "media_type_mismatch" } }),
    ];
    const sdk = new FakeSdk({
      ...projection("completed", [], timeline),
      session_id: "session-attachment",
      attachments: {
        items: [{
          status: "offloaded",
          upload_id: "upload:image",
          attachment,
          delivery: "offload",
          deduplicated: false,
          pdf_extraction: { status: "not_applicable" },
          offload_reason: "default_policy",
        }],
        last_sequence: 3,
      },
    });
    sdk.attachmentContent = {
      attachmentId: attachment.attachment_id,
      mediaType: attachment.media_type,
      sha256: attachment.sha256,
      bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
    };
    const client = new LiveTraceGraphClient({ sdk });

    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Inspect an uploaded image", "plan");

    expect(client.getSnapshot().run?.attachments).toEqual([expect.objectContaining({
      id: attachment.attachment_id,
      status: "offloaded",
      mediaType: "image/png",
      sha256: hash,
    })]);
    expect(client.getSnapshot().run?.events.slice(1)).toMatchObject([
      { kind: "attachment", title: "Attachment added", state: "succeeded" },
      { kind: "attachment", title: "Attachment offloaded", state: "succeeded" },
      { kind: "attachment", title: "Attachment rejected", state: "denied" },
    ]);
    await expect(client.loadAttachment(attachment.attachment_id)).resolves.toEqual({
      mediaType: "image/png",
      bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
    });
    await expect(client.loadAttachment("attachment:other")).rejects.toThrow(/no longer related/u);
    expect(sdk.attachmentContentRequests).toEqual([{ runId: "run_live", attachmentId: "attachment:image" }]);

    await client.enterReplay(1);
    await expect(client.loadAttachment(attachment.attachment_id)).rejects.toThrow(/unavailable while viewing a replay/u);
    expect(sdk.attachmentContentRequests).toHaveLength(1);
    await client.returnToLive();
    await client.returnHome();
  });

  it("maps only safe ProjectSummary fields and exposes Host-registered project choices", async () => {
    const client = new LiveTraceGraphClient({ sdk: new FakeSdk() });

    await client.initialize();
    expect(client.getSnapshot().availableProjects).toHaveLength(2);
    await client.chooseProject("readonly_local");

    expect(client.getSnapshot().project).toEqual({
      id: "project_local",
      name: "Registered repository",
      pathLabel: "Host-managed · read-only",
      workspaceKind: "readonly_local",
    });
    expect(client.getSnapshot().project).not.toHaveProperty("branch");
    expect(client.getSnapshot().dataSource).toBe("live");
  });

  it("hydrates canonical context, diff, graph, and test Artifacts without demo fallbacks", async () => {
    const contextRef = artifact("context_manifest");
    const diffRef = artifact("diff");
    const graphRef = artifact("graph_delta");
    const testRef = artifact("test_log");
    const timeline = [
      event(1, "context.built", { context_manifest_ref: "manifest_live" }),
      event(2, "model.decision", {
        data: { decision: { risk: "medium", public_reason: "Bounded by the Host policy" } },
      }),
      event(3, "patch.applied", { patch_event_id: "patch_event_live", graph_delta_id: "graph_delta_live" }),
    ];
    const sdk = new FakeSdk(projection("completed", [contextRef, diffRef, graphRef, testRef], timeline));
    sdk.artifacts.set(contextRef.artifact_id, {
      status: "available",
      artifact: contextRef,
      content: JSON.stringify({
        manifest_id: "manifest_live",
        project_id: fixtureProject.project_id,
        run_id: "run_live",
        turn_id: "turn_live",
        model_call_id: "call_live",
        token_limit: 8_192,
        reserved_output_tokens: 1_024,
        input_tokens: 320,
        items: [{
          item_id: "context_repo",
          section: "repo",
          label: "Repository evidence",
          source: { source_id: "source_repo", source_type: "repository", trust: "trusted" },
          original_tokens: 640,
          included_tokens: 320,
          action: "truncated",
          reason: "Only relevant source ranges were included",
        }],
        fixed_constraints_preserved: true,
        created_at: occurredAt,
      }),
    });
    sdk.artifacts.set(diffRef.artifact_id, {
      status: "available",
      artifact: diffRef,
      content: "diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-oldValue\n+newValue",
    });
    sdk.artifacts.set(graphRef.artifact_id, {
      status: "available",
      artifact: graphRef,
      content: JSON.stringify({
        graph_delta_id: "graph_delta_live",
        project_id: fixtureProject.project_id,
        base_snapshot_id: "graph_before",
        result_snapshot_id: "graph_after",
        patch_event_id: "patch_event_live",
        created_at: occurredAt,
        node_changes: [{
          change: "added",
          after: { id: "node_index", kind: "file", label: "index.ts", file_path: "src/index.ts" },
        }],
        edge_changes: [],
      }),
    });
    sdk.artifacts.set(testRef.artifact_id, {
      status: "available",
      artifact: testRef,
      content: "PASS src/index.test.ts\n1 test passed",
    });
    const client = new LiveTraceGraphClient({ sdk });

    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Inspect real evidence", "plan");

    const snapshot = client.getSnapshot();
    expect(snapshot.run).toMatchObject({ inputTokens: 320, tokenLimit: 8_192, reservedOutput: 1_024 });
    expect(snapshot.run?.events[1]).toMatchObject({ kind: "decision", risk: "medium", rationale: "Bounded by the Host policy" });
    expect(snapshot.contextSources).toEqual([expect.objectContaining({ name: "Repository evidence", action: "truncated", tokens: 320 })]);
    expect(snapshot.changedFiles).toEqual([expect.objectContaining({ path: "src/index.ts", additions: 1, deletions: 1 })]);
    expect(snapshot.graphNodes).toEqual([expect.objectContaining({ after: { label: "index.ts", path: "src/index.ts" }, state: "added" })]);
    expect(snapshot.evidence.test).toMatchObject({ status: "available", content: "PASS src/index.test.ts\n1 test passed" });
  });

  it("loads only active Context item archives on demand, including historical event scope", async () => {
    const oldContext = artifact("context_manifest", "artifact_context_archive_old_manifest");
    const newContext = artifact("context_manifest", "artifact_context_archive_new_manifest");
    const oldArchive = artifact("spilled_tool_output", "artifact_context_archive_old_active");
    const newArchive = artifact("context_source_archive", "artifact_context_archive_new_active");
    const supersededArchive = artifact("spilled_tool_output", "artifact_context_archive_superseded");
    const timeline = [
      event(1, "context.built", {
        event_id: "context_archive_event_old",
        context_manifest_ref: "manifest_archive_old",
        artifact_refs: [oldContext],
      }),
      event(2, "context.built", {
        event_id: "context_archive_event_new",
        context_manifest_ref: "manifest_archive_new",
        artifact_refs: [newContext],
      }),
      event(3, "run.completed"),
    ];
    const sdk = new FakeSdk(projection(
      "completed",
      [oldContext, oldArchive, supersededArchive, newContext, newArchive],
      timeline,
    ));
    sdk.artifacts.set(oldContext.artifact_id, {
      status: "available",
      artifact: oldContext,
      content: archivedContextManifest("manifest_archive_old", "item_archive_old", oldArchive, supersededArchive),
    });
    sdk.artifacts.set(newContext.artifact_id, {
      status: "available",
      artifact: newContext,
      content: archivedContextManifest("manifest_archive_new", "item_archive_new", newArchive),
    });
    sdk.artifacts.set(oldArchive.artifact_id, { status: "available", artifact: oldArchive, content: "historical archive bytes" });
    sdk.artifacts.set(newArchive.artifact_id, { status: "available", artifact: newArchive, content: "latest archive bytes" });
    sdk.artifacts.set(supersededArchive.artifact_id, { status: "available", artifact: supersededArchive, content: "must remain hidden" });
    const client = new LiveTraceGraphClient({ sdk });

    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Inspect lazy Context archives", "plan");

    expect(sdk.artifactRequests.map(({ artifactId }) => artifactId)).toEqual(expect.arrayContaining([
      oldContext.artifact_id,
      newContext.artifact_id,
    ]));
    expect(sdk.artifactRequests.map(({ artifactId }) => artifactId)).not.toEqual(expect.arrayContaining([
      oldArchive.artifact_id,
      newArchive.artifact_id,
      supersededArchive.artifact_id,
    ]));
    expect(client.getSnapshot().contextSources).toEqual([
      expect.objectContaining({ itemId: "item_archive_new", name: "Repeated archive label", archive: expect.objectContaining({ artifactId: newArchive.artifact_id, status: "idle" }) }),
    ]);
    expect(client.getSnapshot().eventEvidence.context_archive_event_old?.contextSources).toEqual([
      expect.objectContaining({ itemId: "item_archive_old", archive: expect.objectContaining({ artifactId: oldArchive.artifact_id }) }),
    ]);

    await expect(client.loadContextArchive("run_live", oldArchive.artifact_id)).resolves.toMatchObject({
      status: "available",
      content: "historical archive bytes",
    });
    await expect(client.loadContextArchive("run_live", oldArchive.artifact_id)).resolves.toMatchObject({
      status: "available",
      content: "historical archive bytes",
    });
    await expect(client.loadContextArchive("run_live", supersededArchive.artifact_id)).rejects.toThrow(
      "not referenced by an active manifest item",
    );
    expect(sdk.artifactRequests.filter(({ artifactId }) => artifactId === oldArchive.artifact_id)).toHaveLength(1);
    expect(sdk.artifactRequests.some(({ artifactId }) => artifactId === supersededArchive.artifact_id)).toBe(false);
  });

  it("marks a referenced Artifact unavailable instead of inventing review content", async () => {
    const diffRef = artifact("diff");
    const sdk = new FakeSdk(projection("completed", [diffRef], [event(1, "run.completed")]));
    sdk.artifacts.set(diffRef.artifact_id, {
      status: "unavailable",
      artifact_id: diffRef.artifact_id,
      reason: "out_of_scope",
    });
    const client = new LiveTraceGraphClient({ sdk });

    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Inspect unavailable evidence", "plan");

    expect(client.getSnapshot().changedFiles).toEqual([]);
    expect(client.getSnapshot().diffs).toEqual({});
    expect(client.getSnapshot().evidence.diff).toMatchObject({
      status: "unavailable",
      artifactId: diffRef.artifact_id,
      message: "Artifact unavailable: out_of_scope",
    });
  });

  it("hydrates evidence by selected event relations instead of leaking the run-level latest artifacts", async () => {
    const contextOld = artifact("context_manifest", "artifact_context_old");
    const diffOld = artifact("diff", "artifact_diff_old");
    const graphOld = artifact("graph_delta", "artifact_graph_old");
    const testOld = artifact("test_log", "artifact_test_old");
    const contextNew = artifact("context_manifest", "artifact_context_new");
    const diffNew = artifact("diff", "artifact_diff_new");
    const graphNew = artifact("graph_delta", "artifact_graph_new");
    const testNew = artifact("test_log", "artifact_test_new");
    const timeline = [
      event(1, "context.built", {
        event_id: "context_event_old",
        context_manifest_ref: "manifest_old",
        artifact_refs: [contextOld],
      }),
      event(2, "model.decision", { context_manifest_ref: "manifest_old" }),
      event(3, "patch.applied", { event_id: "patch_old", artifact_refs: [diffOld], data: { scope: ["src/old.ts"] } }),
      event(4, "graph.delta_created", {
        event_id: "graph_event_old",
        patch_event_id: "patch_old",
        graph_delta_id: "delta_old",
        artifact_refs: [graphOld],
      }),
      event(5, "test.completed", {
        event_id: "test_event_old",
        patch_event_id: "patch_old",
        test_receipt_id: "receipt_old",
        artifact_refs: [testOld],
      }),
      event(6, "context.built", {
        event_id: "context_event_new",
        context_manifest_ref: "manifest_new",
        artifact_refs: [contextNew],
      }),
      event(7, "patch.applied", { event_id: "patch_new", artifact_refs: [diffNew], data: { scope: ["src/new.ts"] } }),
      event(8, "graph.delta_created", {
        event_id: "graph_event_new",
        patch_event_id: "patch_new",
        graph_delta_id: "delta_new",
        artifact_refs: [graphNew],
      }),
      event(9, "test.completed", {
        event_id: "test_event_new",
        patch_event_id: "patch_new",
        test_receipt_id: "receipt_new",
        artifact_refs: [testNew],
      }),
      event(10, "run.completed"),
    ];
    const refs = [contextOld, diffOld, graphOld, testOld, contextNew, diffNew, graphNew, testNew];
    const sdk = new FakeSdk(projection("completed", refs, timeline));
    const put = (ref: ArtifactRef, content: string) => sdk.artifacts.set(ref.artifact_id, {
      status: "available",
      artifact: ref,
      content,
    });
    put(contextOld, contextManifest("manifest_old", 111));
    put(contextNew, contextManifest("manifest_new", 222));
    put(diffOld, "diff --git a/src/old.ts b/src/old.ts\n--- a/src/old.ts\n+++ b/src/old.ts\n@@ -1 +1 @@\n-old-before\n+old-after");
    put(diffNew, "diff --git a/src/new.ts b/src/new.ts\n--- a/src/new.ts\n+++ b/src/new.ts\n@@ -1 +1 @@\n-new-before\n+new-after");
    put(graphOld, graphDelta("delta_old", "patch_old", "old-before.ts", "old-after.ts"));
    put(graphNew, graphDelta("delta_new", "patch_new", "new-before.ts", "new-after.ts"));
    put(testOld, "OLD TEST RECEIPT · PASS");
    put(testNew, "NEW TEST RECEIPT · PASS");
    const client = new LiveTraceGraphClient({ sdk });

    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Inspect event-scoped evidence", "plan");

    const snapshot = client.getSnapshot();
    expect(snapshot.evidence.diff.content).toContain("new-after");
    const oldPatch = snapshot.eventEvidence.patch_old;
    expect(oldPatch).toMatchObject({ patchEventId: "patch_old", graphDeltaId: "delta_old", testReceiptId: "receipt_old" });
    expect(oldPatch?.evidence.diff.content).toContain("old-after");
    expect(oldPatch?.evidence.diff.content).not.toContain("new-after");
    expect(oldPatch?.evidence.test.content).toBe("OLD TEST RECEIPT · PASS");
    expect(oldPatch?.graphNodes[0]).toMatchObject({
      before: { label: "old-before.ts" },
      after: { label: "old-after.ts" },
    });
    expect(snapshot.eventEvidence.context_event_old).toMatchObject({
      contextManifestId: "manifest_old",
      inputTokens: 111,
    });
    expect(snapshot.eventEvidence.test_event_old?.evidence.diff.content).toContain("old-after");
    expect(snapshot.eventEvidence.test_event_old?.evidence.test.content).toBe("OLD TEST RECEIPT · PASS");
  });

  it("enables approval only after the complete PatchPreview Artifact is verified", async () => {
    const previewRef = artifact("patch_preview");
    const sdk = new FakeSdk(pendingProjection(previewRef));
    const additions = Array.from({ length: 320 }, (_, index) => `+line-${index}`).join("\n");
    const fullDiff = `--- a/src/index.ts\n+++ b/src/index.ts\n@@\n-old\n${additions}\n+final-marker`;
    expect(fullDiff.length).toBeGreaterThan(2_000);
    sdk.artifacts.set(previewRef.artifact_id, {
      status: "available",
      artifact: previewRef,
      content: fullDiff,
    });
    const client = new LiveTraceGraphClient({ sdk, minRetryMs: 60_000, maxRetryMs: 60_000 });

    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Review the complete patch", "execute");
    await waitForApprovalEvidence(client, "available");

    expect(client.getSnapshot().run?.approval).toMatchObject({
      reviewReady: true,
      additions: 321,
      reviewMessage: "Complete PatchPreview Artifact verified by the Host.",
    });
    expect(client.getSnapshot().evidence.diff).toMatchObject({
      status: "available",
      content: expect.stringContaining("final-marker"),
    });
    expect(client.getSnapshot().changedFiles).toEqual([
      expect.objectContaining({ path: "src/index.ts", additions: 321, deletions: 1 }),
    ]);
    await client.chooseProject("disposable_fixture");
  });

  it("blocks approval when the complete PatchPreview Artifact is unavailable", async () => {
    const previewRef = artifact("patch_preview");
    const client = new LiveTraceGraphClient({
      sdk: new FakeSdk(pendingProjection(previewRef)),
      minRetryMs: 60_000,
      maxRetryMs: 60_000,
    });

    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Do not approve incomplete evidence", "execute");
    await waitForApprovalEvidence(client, "unavailable");

    expect(client.getSnapshot().run?.approval).toMatchObject({ reviewReady: false });
    expect(client.getSnapshot().evidence.diff.status).toBe("unavailable");
    await expect(client.approve("approval_live")).rejects.toThrow(
      "complete PatchPreview Artifact must be verified",
    );
    await client.chooseProject("disposable_fixture");
  });

  it("surfaces an interrupted SSE stream as reconnecting while preserving the last durable sequence", async () => {
    const sdk = new FakeSdk(projection("running", [], [event(1, "run.started")]));
    sdk.streamError = new Error("SSE transport interrupted");
    const client = new LiveTraceGraphClient({ sdk, minRetryMs: 60_000, maxRetryMs: 60_000 });

    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Watch the event stream", "plan");
    await new Promise((resolve) => globalThis.setTimeout(resolve, 10));

    expect(client.getSnapshot().connection).toMatchObject({
      state: "reconnecting",
      message: "SSE transport interrupted",
      lastSequence: 1,
    });
    expect(client.getSnapshot().run).toMatchObject({ status: "reconnecting", lastSequence: 1 });
    await expect(client.stop()).rejects.toThrow("unavailable while reconnecting");
    expect(sdk.userInputSubmissions).toHaveLength(0);

    await client.chooseProject("disposable_fixture");
  });

  it("advances the connection cursor when a refreshed projection jumps ahead of an SSE event", async () => {
    const first = event(1, "run.started");
    const sdk = new FakeSdk(projection("running", [], [first]));
    sdk.streamedEvents = [event(2, "context.built")];
    sdk.projectionAfterStreamEvent = projection("running", [], [
      first,
      event(2, "context.built"),
      event(3, "model.decision"),
      event(4, "tool.started"),
      event(5, "tool.completed"),
    ]);
    const client = new LiveTraceGraphClient({ sdk, minRetryMs: 60_000, maxRetryMs: 60_000 });

    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Observe projection catch-up", "plan");
    await new Promise((resolve) => globalThis.setTimeout(resolve, 10));

    expect(client.getSnapshot().connection.lastSequence).toBe(5);
    expect(client.getSnapshot().run?.lastSequence).toBe(5);

    await client.chooseProject("disposable_fixture");
  });

  it("pairs a live provider usage update to the matching context model call", async () => {
    const contextEvent = meteredContextEvent(2, "model_call_current");
    const first = event(1, "run.started");
    const matchingUsage = providerUsageEvent(3, "model_call_current", {
      input_tokens: 1_250,
      output_tokens: 250,
      total_tokens: 1_500,
      estimated_input_tokens: 1_000,
      delta_ratio: 1.25,
      cost_status: "unavailable",
    });
    const matchingAnomaly = event(4, "model.usage_anomaly", {
      model_call_id: "model_call_current",
      context_manifest_ref: "manifest_metered",
      data: { ...matchingUsage.data, anomaly: true },
    });
    const unrelatedNewerUsage = providerUsageEvent(5, "model_call_other", {
      provider: "other-provider",
      model: "other-model",
      input_tokens: 9_000,
      output_tokens: 1,
      total_tokens: 9_001,
      estimated_input_tokens: 9_000,
      cost_status: "unavailable",
    });
    const sdk = new FakeSdk(projection("running", [], [first, contextEvent]));
    sdk.streamedEvents = [matchingUsage];
    sdk.projectionAfterStreamEvent = projection("completed", [], [
      first,
      contextEvent,
      matchingUsage,
      matchingAnomaly,
      unrelatedNewerUsage,
      event(6, "run.completed"),
    ]);
    const client = new LiveTraceGraphClient({ sdk, minRetryMs: 60_000, maxRetryMs: 60_000 });

    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Observe durable provider usage", "plan");
    await new Promise((resolve) => globalThis.setTimeout(resolve, 10));

    expect(client.getSnapshot().run?.contextBudget).toMatchObject({
      estimate: { confidence: "calibrated", inputTokens: 1_000 },
      providerUsage: {
        modelCallId: "model_call_current",
        provider: "openai",
        model: "gpt-test",
        inputTokens: 1_250,
        totalTokens: 1_500,
        cost: { status: "unavailable" },
        anomaly: true,
      },
    });
    expect(client.getSnapshot().run?.contextBudget?.providerUsage?.provider).not.toBe("other-provider");
  });

  it("rejects an internally inconsistent context budget event", async () => {
    const base = meteredContextEvent(1, "model_call_invalid_budget");
    const invalid = {
      ...base,
      data: {
        ...base.data,
        input_budget_tokens: 0,
        warning_threshold_tokens: 900,
        compression_threshold_tokens: 100,
      },
    };
    const sdk = new FakeSdk(projection("completed", [], [invalid, event(2, "run.completed")]));
    const client = new LiveTraceGraphClient({ sdk });

    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Reject malformed Context budget", "plan");

    expect(client.getSnapshot().run?.contextBudget).toBeUndefined();
  });

  it("shows the latest repair usage without inheriting an older initial anomaly", async () => {
    const contextEvent = meteredContextEvent(1, "model_call_repaired");
    const initialUsage = providerUsageEvent(2, "model_call_repaired", {
      input_tokens: 1_400,
      output_tokens: 100,
      total_tokens: 1_500,
      estimated_input_tokens: 1_000,
      delta_ratio: 1.4,
      anomaly: true,
    });
    const initialAnomaly = event(3, "model.usage_anomaly", {
      model_call_id: "model_call_repaired",
      data: { ...initialUsage.data },
    });
    const repairUsage = providerUsageEvent(4, "model_call_repaired", {
      input_tokens: 220,
      output_tokens: 80,
      total_tokens: 300,
      request_kind: "repair",
      request_sequence: 2,
      anomaly: false,
    });
    const malformedRepairAnomaly = event(5, "model.usage_anomaly", {
      model_call_id: "model_call_repaired",
      data: { ...repairUsage.data, anomaly: false },
    });
    const sdk = new FakeSdk(projection("completed", [], [
      // Historical projections are schema-valid even when a transport returns
      // timeline entries out of array order. Highest durable sequence wins.
      repairUsage,
      malformedRepairAnomaly,
      initialUsage,
      initialAnomaly,
      contextEvent,
      event(6, "run.completed"),
    ]));
    const client = new LiveTraceGraphClient({ sdk });

    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Inspect repaired usage", "plan");

    expect(client.getSnapshot().run?.contextBudget?.providerUsage).toMatchObject({
      requestKind: "repair",
      requestSequence: 2,
      inputTokens: 220,
      totalTokens: 300,
      anomaly: false,
    });
  });

  it("settles start events when the run has already completed", async () => {
    const sdk = new FakeSdk(projection("completed", [], [
      event(1, "run.created"),
      event(2, "run.started"),
      event(3, "tool.started", {
        operation_id: "operation_read",
        data: { tool_name: "read_file", path: "src/index.ts" },
      }),
      event(4, "tool.completed", {
        operation_id: "operation_read",
        data: { receipt: { tool_name: "read_file", duration_ms: 12 }, observation: { facts: { path: "src/index.ts" } } },
      }),
      event(5, "run.completed"),
    ]));
    const client = new LiveTraceGraphClient({ sdk });

    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Explain a concept", "plan");

    expect(client.getSnapshot().run?.events.map((item) => item.state)).toEqual([
      "succeeded", "succeeded", "succeeded", "succeeded", "succeeded",
    ]);
    expect(client.getSnapshot().run?.events[2]).toMatchObject({
      operationId: "operation_read",
      toolName: "read_file",
      target: "src/index.ts",
    });
  });

  it("renders Tool batch lifecycle events with explicit titles and states", async () => {
    const sdk = new FakeSdk(projection("running", [], [
      event(1, "tool.batch_started", {
        operation_id: "batch:parallel-read",
        data: { requested_count: 2, effective_concurrency: 2 },
      }),
      event(2, "tool.batch_completed", {
        operation_id: "batch:parallel-read",
        data: { completed_count: 2, failed_count: 0 },
      }),
    ]));
    const client = new LiveTraceGraphClient({ sdk, minRetryMs: 60_000, maxRetryMs: 60_000 });

    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Inspect independent files", "plan");

    expect(client.getSnapshot().run?.events).toEqual([
      expect.objectContaining({
        kind: "tool",
        title: "Tool batch started",
        state: "running",
        operationId: "batch:parallel-read",
      }),
      expect.objectContaining({
        kind: "tool",
        title: "Tool batch completed",
        state: "succeeded",
        operationId: "batch:parallel-read",
      }),
    ]);

    await client.chooseProject("readonly_local");
  });

  it("forwards the selected public reasoning effort without changing its enum", async () => {
    const sdk = new FakeSdk(projection("completed", [], [
      event(1, "model.request_started", { model_call_id: "model_call_one" }),
      event(2, "model.decision", { model_call_id: "model_call_one" }),
      event(3, "run.completed"),
    ]));
    const client = new LiveTraceGraphClient({ sdk });

    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Investigate carefully", "plan", "xhigh");

    expect(sdk.startInputs.at(-1)?.reasoning_effort).toBe("xhigh");
    expect(client.getSnapshot().run?.events.slice(0, 2).map((item) => item.operationId)).toEqual([
      "model_call_one",
      "model_call_one",
    ]);
  });

  it("keeps earlier turns in one project conversation and sends bounded history to the next run", async () => {
    const sdk = new FakeSdk({
      ...projection("completed", [], [event(1, "model.decision"), event(2, "run.completed")]),
      run_id: "run_first",
      task: "First question",
      outcome: "First answer",
    });
    const client = new LiveTraceGraphClient({ sdk });

    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("First question", "plan");

    sdk.currentProjection = {
      ...projection("completed", [], [event(1, "run.completed")]),
      run_id: "run_second",
      task: "Follow-up question",
      outcome: "Second answer",
    };
    await client.startRun("Follow-up question", "plan");

    expect(client.getSnapshot().conversation).toEqual([
      expect.objectContaining({ runId: "run_first", task: "First question", response: "First answer" }),
    ]);
    expect(sdk.startInputs[1]?.conversation_history).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
    ]);
  });

  it("projects durable sandbox evidence without exposing a browser escalation input", async () => {
    const sandboxReport = {
      report_version: 1 as const,
      mode: "workspace-write" as const,
      enforcement: "full" as const,
      platform: "darwin" as const,
      mechanisms: ["seatbelt", "network-deny"],
      unmet_constraints: [],
    };
    const sdk = new FakeSdk({
      ...projection("completed", [], [
        event(1, "sandbox.enforced", { data: { sandbox_report: sandboxReport } }),
        event(2, "tool.completed", {
          data: {
            receipt: {
              receipt_id: "receipt_test",
              tool_call_id: "call_test",
              tool_name: "run_test",
              status: "succeeded",
              started_at: occurredAt,
              completed_at: occurredAt,
              duration_ms: 4,
              output_summary: "Tests passed",
              artifact_refs: [],
              metadata: { sandbox_report: sandboxReport },
            },
          },
        }),
        event(3, "run.completed"),
      ]),
      sandbox_report: sandboxReport,
    });
    const client = new LiveTraceGraphClient({ sdk });

    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Run tests in the sandbox", "execute");

    expect(client.getSnapshot().run?.sandboxReport).toEqual(sandboxReport);
    expect(client.getSnapshot().run?.events[0]).toMatchObject({
      kind: "sandbox",
      title: "Sandbox enforced",
      sandboxReport,
    });
    expect(client.getSnapshot().run?.events[1]).toMatchObject({
      kind: "tool",
      toolName: "run_test",
      sandboxReport,
    });
    expect(sdk.startInputs.at(-1)).not.toHaveProperty("sandbox_mode");
    expect(sdk.startInputs.at(-1)).not.toHaveProperty("sandboxMode");
    expect(sdk.startInputs.at(-1)).not.toHaveProperty("preset_key");
    expect(sdk.startInputs.at(-1)).not.toHaveProperty("permission");
  });

  it("reads and updates only a Host-advertised permission preset key", async () => {
    const sdk = new FakeSdk();
    const client = new LiveTraceGraphClient({ sdk });

    await client.initialize();
    await expect(client.getPermissionConfig()).resolves.toMatchObject({
      active_preset: "workspace-write",
      sandbox_mode: "workspace-write",
      approval_policy: "on-write",
    });
    await expect(client.configurePermissionPreset({ preset_key: "read-only" })).resolves.toMatchObject({
      active_preset: "read-only",
      sandbox_mode: "read-only",
      approval_policy: "never",
    });

    expect(sdk.permissionInputs).toEqual([{ preset_key: "read-only" }]);
    expect(sdk.permissionInputs[0]).not.toHaveProperty("sandbox_mode");
    expect(sdk.permissionInputs[0]).not.toHaveProperty("approval_policy");
    expect(sdk.permissionInputs[0]).not.toHaveProperty("host_rules");
  });

  it("rejects a permission response that leaks Host policy internals", async () => {
    const sdk = new FakeSdk();
    sdk.permissionSettings = {
      ...permissionSettings,
      path_scope: ["private/**"],
      host_rules: [],
    } as never;
    const client = new LiveTraceGraphClient({ sdk });

    await client.initialize();
    await expect(client.getPermissionConfig()).rejects.toThrow();
  });

  it("projects the fixed permission snapshot and a typed policy explanation", async () => {
    const permission = {
      preset_key: "workspace-write" as const,
      label: "Workspace write",
      sandbox_mode: "workspace-write" as const,
      approval_policy: "on-write" as const,
      policy_digest: hash,
    };
    const decision = {
      decision_id: "decision_policy",
      preset_key: "workspace-write" as const,
      policy_digest: hash,
      tool_name: "commit_patch",
      side_effect: "write" as const,
      kind: "ask" as const,
      source: "configured-rule" as const,
      matched_rule_id: "require_patch_approval",
      priority: 100,
      explanation: "Workspace writes require one-time approval.",
      action_digest: hash,
    };
    const sdk = new FakeSdk({
      ...projection("awaiting_approval", [], [
        event(1, "permission.configured", { data: { permission } }),
        event(2, "policy.evaluated", { data: { decision } }),
      ]),
      permission,
    });
    const client = new LiveTraceGraphClient({ sdk });

    await client.initialize();
    await client.chooseProject("disposable_fixture");
    await client.startRun("Inspect permission policy", "execute");

    expect(client.getSnapshot().run?.permission).toEqual(permission);
    expect(client.getSnapshot().run?.events[0]).toMatchObject({
      kind: "permission",
      title: "Permission configured",
      permission,
    });
    expect(client.getSnapshot().run?.events[1]).toMatchObject({
      kind: "decision",
      title: "Policy evaluated",
      state: "waiting",
      rationale: decision.explanation,
      policyDecision: decision,
    });
  });
});

function contextManifest(manifestId: string, inputTokens: number): string {
  return JSON.stringify({
    manifest_id: manifestId,
    project_id: fixtureProject.project_id,
    run_id: "run_live",
    turn_id: `turn_${manifestId}`,
    model_call_id: `call_${manifestId}`,
    token_limit: 8_192,
    reserved_output_tokens: 1_024,
    input_tokens: inputTokens,
    items: [{
      item_id: `item_${manifestId}`,
      section: "repo",
      label: `${manifestId} repository evidence`,
      source: { source_id: `source_${manifestId}`, source_type: "repository", trust: "trusted" },
      original_tokens: inputTokens,
      included_tokens: inputTokens,
      action: "kept",
      reason: "Selected event fixture",
    }],
    fixed_constraints_preserved: true,
    created_at: occurredAt,
  });
}

function meteredContextEvent(
  sequence: number,
  modelCallId: string,
  contextRef?: ArtifactRef,
): WireSessionEvent {
  return event(sequence, "context.built", {
    model_call_id: modelCallId,
    context_manifest_ref: "manifest_metered",
    ...(contextRef === undefined ? {} : { artifact_refs: [contextRef] }),
    data: {
      manifest_id: "manifest_metered",
      input_tokens: 1_000,
      token_limit: 8_192,
      reserved_output_tokens: 1_024,
      input_budget_tokens: 7_168,
      warning_threshold_tokens: 5_000,
      compression_threshold_tokens: 6_000,
      token_estimator: "heuristic_v2",
      context_status: "healthy",
      token_estimate: {
        estimator_id: "heuristic:openai:gpt-test:r2",
        confidence: "calibrated",
        input_tokens: 1_000,
        output_tokens: 512,
        cached_tokens: 120,
        per_section: { system: 100, goal: 100, history: 200, tool: 100, repo: 400, memory: 100 },
      },
    },
  });
}

function providerUsageEvent(
  sequence: number,
  modelCallId: string,
  overrides: Record<string, unknown> = {},
): WireSessionEvent {
  return event(sequence, "model.usage_reported", {
    model_call_id: modelCallId,
    context_manifest_ref: "manifest_metered",
    data: {
      model_call_id: modelCallId,
      provider: "openai",
      model: "gpt-test",
      estimator_id: "heuristic:openai:gpt-test:r2",
      confidence: "provider_reported",
      input_tokens: 1_000,
      output_tokens: 200,
      total_tokens: 1_200,
      estimated_input_tokens: 1_000,
      delta_ratio: 1,
      anomaly: false,
      calibration_revision: 2,
      request_kind: "initial",
      request_sequence: 1,
      calibration_applied: true,
      cost_status: "unavailable",
      ...overrides,
    },
  });
}

function meteredContextManifest(manifestId: string, modelCallId: string): string {
  return JSON.stringify({
    manifest_id: manifestId,
    project_id: fixtureProject.project_id,
    run_id: "run_live",
    turn_id: "turn_metered",
    model_call_id: modelCallId,
    token_limit: 8_192,
    reserved_output_tokens: 1_024,
    input_tokens: 1_000,
    token_estimate: {
      estimator_id: "heuristic:openai:gpt-test:r2",
      confidence: "calibrated",
      input_tokens: 1_000,
      output_tokens: 512,
      cached_tokens: 120,
      per_section: { system: 0, goal: 0, history: 0, tool: 0, repo: 1_000, memory: 0 },
    },
    budget: {
      input_budget_tokens: 7_168,
      warning_threshold_tokens: 5_000,
      compression_threshold_tokens: 6_000,
      token_estimator: "heuristic_v2",
      status: "healthy",
    },
    items: [{
      item_id: "item_metered",
      section: "repo",
      label: "Metered repository evidence",
      source: { source_id: "source_metered", source_type: "repository", trust: "trusted" },
      original_tokens: 1_000,
      included_tokens: 1_000,
      action: "kept",
      reason: "Historical provider usage fixture",
    }],
    fixed_constraints_preserved: true,
    created_at: occurredAt,
  });
}

function archivedContextManifest(
  manifestId: string,
  itemId: string,
  activeArchive: ArtifactRef,
  supersededArchive?: ArtifactRef,
): string {
  return JSON.stringify({
    manifest_id: manifestId,
    project_id: fixtureProject.project_id,
    run_id: "run_live",
    turn_id: `turn_${manifestId}`,
    model_call_id: `model_call_${manifestId}`,
    token_limit: 8_192,
    reserved_output_tokens: 1_024,
    input_tokens: 100,
    compression: {
      strategy: "none",
      applied_strategy: "bounded_tool_output",
      trigger: "hard_budget",
      before_tokens: 200,
      after_tokens: 100,
      original_history_tokens: 0,
      checkpoint_tokens: 0,
      preserved_recent_message_count: 0,
      compacted_history_message_count: 0,
    },
    items: [{
      item_id: itemId,
      section: "tool",
      label: "Repeated archive label",
      source: { source_id: `source_${itemId}`, source_type: "tool", trust: "trusted" },
      original_tokens: 200,
      included_tokens: 100,
      action: "externalized",
      reason: "spill_ref",
      artifact_ref: activeArchive,
    }],
    compaction_steps: [{
      strategy_id: "spill",
      section: "tool",
      tokens_before: 200,
      tokens_after: 100,
      archived_artifact_refs: supersededArchive === undefined
        ? [activeArchive]
        : [activeArchive, supersededArchive],
    }],
    fixed_constraints_preserved: true,
    created_at: occurredAt,
  });
}

function graphDelta(deltaId: string, patchEventId: string, beforeLabel: string, afterLabel: string): string {
  return JSON.stringify({
    graph_delta_id: deltaId,
    project_id: fixtureProject.project_id,
    base_snapshot_id: `base_${deltaId}`,
    result_snapshot_id: `result_${deltaId}`,
    patch_event_id: patchEventId,
    created_at: occurredAt,
    node_changes: [{
      change: "changed",
      before: { id: `node_${deltaId}`, kind: "file", label: beforeLabel, file_path: `src/${beforeLabel}` },
      after: { id: `node_${deltaId}`, kind: "file", label: afterLabel, file_path: `src/${afterLabel}` },
    }],
    edge_changes: [],
  });
}

async function waitForApprovalEvidence(
  client: LiveTraceGraphClient,
  status: "available" | "unavailable",
): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (client.getSnapshot().evidence.diff.status === status) return;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for approval evidence status ${status}`);
}
