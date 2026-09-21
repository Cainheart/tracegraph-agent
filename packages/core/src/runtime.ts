import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  ApprovalCommandSchema,
  ApprovePlanCommandSchema,
  ApprovalBoundGrantSchema,
  ApprovalBoundValidatedActionSchema,
  ApprovalDeniedDataSchema,
  ApprovalExpiredDataSchema,
  ApprovalGrantedDataSchema,
  ApprovalOutcomeSchema,
  BUILTIN_TOOL_NAMES,
  AttachmentAddedDataSchema,
  ArtifactRefSchema,
  ContextManifestSchema,
  CodeIntelUpdatedDataSchema,
  CodeStaleBaseDetectedDataSchema,
  DEFAULT_SUBAGENT_LIMITS,
  DecisionSchema,
  GraphDeltaSchema,
  GraphSnapshotSchema,
  GitBaseContextSchema,
  IdentifierSchema,
  LivePublicActivitySchema,
  LspDiagnosticsRequestSchema,
  LspDiagnosticsReceivedDataSchema,
  LspServerUnavailableDataSchema,
  ModelCapabilitiesSchema,
  MAX_PENDING_USER_INPUTS,
  MAX_CODE_INTEL_CHANGED_FILES,
  MAX_CODE_INTEL_CHANGED_SYMBOLS,
  MAX_USER_INPUT_BODY_CHARS,
  MAX_TOOL_CALLS_PER_DECISION,
  ModelUsageReportSchema,
  MemoryRecallBudgetSchema,
  ModelSurfaceEventSchema,
  PendingUserInputSchema,
  ObservationSchema,
  PatchPreviewSchema,
  PlanApprovedDataSchema,
  PlanReadyDataSchema,
  BoundPendingApprovalSchema,
  PendingApprovalSchema,
  PermissionConfiguredDataSchema,
  PolicyDeniedDataSchema,
  PolicyDecisionSchema,
  PolicyEvaluatedDataSchema,
  ReceiptSchema,
  RollbackActionInputSchema,
  RunRecoveryStateSchema,
  SkillConflictDataSchema,
  SkillLoadFailedDataSchema,
  SkillLoadInputSchema,
  SkillRegistryLoadedDataSchema,
  SandboxConfiguredDataSchema,
  SandboxDisabledDataSchema,
  SandboxEnforcedDataSchema,
  SandboxModeSchema,
  SandboxPlatformSchema,
  SandboxReportSchema,
  SendSubagentMessageInputSchema,
  SESSION_FORMAT_VERSION,
  SessionEventReferenceSchema,
  SessionHeaderSchema,
  SessionPendingPatchRecoveryStateSchema,
  StartRunInputSchema,
  StopRunCommandSchema,
  SpawnSubagentInputSchema,
  SubagentBudgetSchema,
  SubagentCompletedDataSchema,
  SubagentFailedDataSchema,
  SubagentInterruptedDataSchema,
  SubagentLimitsSchema,
  SubagentListProjectionSchema,
  SubagentMessageSentDataSchema,
  SubagentResultSchema,
  SubagentRunLinkSchema,
  SubagentSpecSchema,
  SubagentStartedDataSchema,
  InterruptSubagentInputSchema,
  ListSubagentsInputSchema,
  SubmitUserInputCommandSchema,
  SubmitUserInputResultSchema,
  CreateTeamRequestSchema,
  TeamHeartbeatRequestSchema,
  TeamHeartbeatInputSchema,
  TeamMailboxClaimRequestSchema,
  TeamMailboxClaimInputSchema,
  TeamMailboxSendRequestSchema,
  TeamMailboxSendInputSchema,
  TeamMutationResultSchema,
  TeamReadResponseSchema,
  TeamSweepCompletedDataSchema,
  TeamSweepLostMembersRequestSchema,
  TeamTaskWriteRequestSchema,
  TeamTaskWriteInputSchema,
  TeamReadInputSchema,
  ToolBatchCompletedDataSchema,
  ToolBatchStartedDataSchema,
  ToolCallSchema,
  TodoWriteInputSchema,
  UserInputConsumedDataSchema,
  UserInputQueuedDataSchema,
  WorkspaceHandleSchema,
  isTerminalEventType,
  type ApprovalCommand,
  type ApprovePlanCommand,
  type ApprovalDenialReason,
  type ApprovalOutcome,
  type ActionWalRecord,
  type ArtifactRef,
  type ArtifactWireResponse,
  type AttachmentStageReceipt,
  type AttachmentAddedData,
  type ContextCompression,
  type ContextPolicy,
  type ChangedSymbol,
  type GitBaseContext,
  type Decision,
  type GraphSnapshot,
  type GraphDelta,
  type LivePublicActivity,
  type ModelSurfaceEvent,
  type ModelImageInput,
  type ModelUsageReport,
  type MemoryCandidate,
  type MemoryRecallBudget,
  type MemoryRecallResult,
  type MemoryRememberResult,
  type Observation,
  type PatchPreview,
  type BoundPendingApproval,
  type PendingApproval,
  type EffectivePermissionPolicy,
  type ExtensionRunSnapshot,
  type PolicyDecision,
  type ReasoningEffort,
  type Receipt,
  type ReplayDiff,
  type ReplayDiffQuery,
  type ReplaySnapshot,
  type ReplaySnapshotRequest,
  type RollbackActionInput,
  type RunProjection,
  type RunMode,
  type SandboxMode,
  type SandboxReport,
  type SessionEvent,
  type SessionEventProposal,
  type StartRunInput,
  type StopRunCommand,
  type SubagentBudget,
  type SubagentLimits,
  type SubagentListProjection,
  type SubagentResult,
  type SubagentRunLink,
  type SubagentStartedData,
  type SendSubagentMessageInput,
  type InterruptSubagentInput,
  type SubmitUserInputCommand,
  type SubmitUserInputResult,
  type CreateTeamRequest,
  type TeamHeartbeatRequest,
  type TeamMailboxClaimRequest,
  type TeamMailboxSendRequest,
  type TeamMutationResult,
  type TeamReadResponse,
  type TeamSweepLostMembersRequest,
  type TeamTaskWriteInput,
  type TeamTaskWriteRequest,
  type TeamCommand,
  type ToolCall,
  type ToolName,
  type ToolFailureCode,
  type TodoList,
  type TodoMutationResult,
  type TodoWriteInput,
  type PendingUserInput,
  type WorkspaceHandle,
  type SkillProjectInspection,
  type McpToolCatalogEntry,
} from "@tracegraph/contracts";
import {
  NoopTelemetrySink,
  SafeTelemetry,
  type TelemetrySink,
  type TelemetryStatus,
} from "@tracegraph/telemetry";
import {
  ApprovalTokenStore,
  ApprovalTokenStoreError,
} from "./approval-token-store.js";
import {
  ActionWal,
  ActionWalError,
  RecoveryLedger,
} from "./action-wal.js";
import { ArtifactStore } from "./artifact-store.js";
import {
  AttachmentStore,
  type AttachmentContent,
  type StageAttachmentInput,
} from "./attachment.js";
import { DeterministicContextBuilder, estimateTokens, type ContextBuildNotice } from "./context.js";
import { SkillRegistry, type SkillRegistrySnapshotInternal } from "./skill.js";
import { McpManager, type McpManagerEvent } from "./mcp/index.js";
import { createLspToolsExtension, lspResultToRaw, LspManager, type LspManagerEvent } from "./lsp/index.js";
import {
  containsSensitiveStructuredData,
  defaultIdFactory,
  redactSecrets,
  redactSensitiveText,
  redactStructuredArtifactValue,
  redactStructuredValue,
  sha256,
  stableStringify,
} from "./crypto.js";
import {
  JsonlEventLedger,
  type AtomicAppendResult,
  type AtomicEventScope,
} from "./event-ledger.js";
import {
  ExtensionManager,
  ExtensionManagerError,
  type ExtensionRunLease,
  type ExtensionRuntimeError,
} from "./extension.js";
import {
  DEFAULT_MEMORY_RECALL_BUDGET,
  JsonlMemoryStore,
  MAX_MEMORY_QUERY_CHARS,
  MemoryManager,
  type MemoryRecordStore,
  type MemoryRetriever,
} from "./memory.js";
import { DeterministicFakeModel } from "./fake-model.js";
import {
  CORE_BUILTIN_PERMISSION_PRESETS,
  PolicyEngine,
  approvalActionDigest,
  createEffectivePermissionPolicy,
} from "./policy-engine.js";
import { projectRun } from "./projection.js";
import { replayDiffFromEvents, replaySnapshotFromEvents } from "./replay.js";
import { RuntimeTelemetryProjector } from "./runtime-telemetry.js";
import { createSandboxRunner, type SandboxRunner } from "./sandbox/runner.js";
import {
  SessionLeaseConflictError,
  type SessionLease,
  type SessionStore,
} from "./session-store.js";
import { CalibratedTokenMeter, type TokenMeter } from "./token-meter.js";
import {
  DEFAULT_MAX_SUBAGENT_DEPTH,
  SubagentDomainError,
  SubagentPermitPool,
  SubagentRegistry,
  type ResolvedSubagentProfile,
} from "./subagent.js";
import {
  TodoDomainService,
  isEligibleTodoCompletionEvidence,
  projectTodos,
} from "./todo.js";
import {
  TeamDomainError,
  TeamDomainService,
  assertExternalTeamCommandId,
  type TeamCommandScope,
} from "./team.js";
import {
  ActionRejectedError,
  CommitPatchInputSchema,
  PatchInputSchema,
  ToolRegistry,
  createArtifactToolsExtension,
  createCoreToolRegistry,
  createRunStateToolsExtension,
  executeToolDefinition,
  resolvePatchTarget,
  validateToolCall,
} from "./tool-registry.js";
import {
  TEAM_READ_MODEL_EXCERPT_BYTES,
  TODO_READ_MODEL_EXCERPT_BYTES,
} from "./tool-output-limits.js";
import {
  ModelRequestError,
  type CodeGraphProvider,
  type ModelAdapter,
  type ModelInput,
  type PublicModelProgressUpdate,
  type PublicModelRequestMetadata,
  type RawToolResult,
  type PatchMutationSnapshot,
  type TeamToolBridge,
  type SkillToolBridge,
  type McpToolBridge,
  type LspToolBridge,
  type ToolCancellationShield,
  type ToolDefinition,
} from "./types.js";

export type ActionCommitFaultPoint =
  | "after_prepare_before_apply"
  | "after_apply_before_applied"
  | "after_applied_before_event"
  | "after_patch_event_before_committed"
  | "after_verified_event_before_verified"
  | "after_rollback_before_event";

export interface RollbackPolicy {
  /** Rollback is deliberately disabled unless the composition root opts in. */
  enabled: boolean;
  /** Managed workspaces additionally require both this flag and force=true. */
  allowForce: boolean;
}

export interface ActionReconciliationResult {
  runId: string;
  reconciledActionIds: string[];
  abortedActionIds: string[];
  divergedActionIds: string[];
}

export interface AgentRuntimeOptions {
  dataDir: string;
  /** Optional process-local telemetry transport. The default is a zero-I/O noop sink. */
  telemetrySink?: TelemetrySink;
  /** Optional durable session index. The event ledger remains authoritative. */
  sessionStore?: SessionStore;
  /** Provider-aware token estimation and post-call usage calibration. */
  tokenMeter?: TokenMeter;
  /** Durable write-ahead log for filesystem patch actions. */
  actionWal?: ActionWal;
  /** Injectable durable attachment staging/materialization boundary. */
  attachmentStore?: AttachmentStore;
  /** Durable ledger of automatic/manual recovery recipe attempts. */
  recoveryLedger?: RecoveryLedger;
  rollbackPolicy?: Partial<RollbackPolicy>;
  /** Deterministic crash seam used by adversarial durability tests. */
  actionCommitFaultInjector?: (point: ActionCommitFaultPoint) => void | Promise<void>;
  model?: ModelAdapter;
  now?: () => Date;
  idFactory?: (prefix: string) => string;
  toolRegistry?: ToolRegistry;
  /** Trusted in-process extension kernel. Core never loads module paths itself. */
  extensionManager?: ExtensionManager;
  /** Project/user Skill registry; only SKILL.md metadata and bodies are read. */
  skillRegistry?: SkillRegistry;
  /** Optional process-local MCP lifecycle and Tool bridge. */
  mcpManager?: McpManager | undefined;
  /** Optional process-local LSP lifecycle, semantic diagnostics and Tool bridge. */
  lspManager?: LspManager | undefined;
  codeGraph?: CodeGraphProvider;
  /**
   * Host-selected Context budget policy.  It is passed to every deterministic
   * Context build and recorded in the resulting manifest for replay.
   */
  contextPolicy?: ContextPolicy;
  /** Optional local or remote retrieval seam. Missing retrieval leaves existing Runs unchanged. */
  retriever?: MemoryRetriever;
  /** Maximum retrieved Context admitted per turn. */
  retrievalBudget?: MemoryRecallBudget;
  /** Injectable canonical store for failure and durability tests. */
  memoryStore?: MemoryRecordStore;
  maxTurns?: number;
  /** Maximum number of explicitly concurrency-safe tool calls run at once. */
  maxToolConcurrency?: number;
  /** Trusted child-agent profiles and optional profile-specific providers. */
  subagentRegistry?: SubagentRegistry;
  /** Process-wide active child ceiling for this Runtime instance. */
  maxParallelSubagents?: number;
  /** Delegation depth ceiling. Root Runs have depth zero. */
  maxSubagentDepth?: number;
  /** Host-owned process isolation policy; browser requests cannot override it. */
  sandboxMode?: SandboxMode;
  /**
   * Host-owned effective permission policy. Prefer permissionPolicyResolver
   * when repository policy differs by Workspace. Browser requests never set
   * either option.
   */
  permissionPolicy?: EffectivePermissionPolicy;
  permissionPolicyResolver?: (
    workspace: WorkspaceHandle,
  ) => EffectivePermissionPolicy | Promise<EffectivePermissionPolicy>;
  /** Optional trusted approval integration. Missing/throwing/invalid answers fail closed. */
  approvalAnswerer?: (request: ApprovalAnswererRequest) => ApprovalOutcome | Promise<ApprovalOutcome>;
  /** Injectable Host-owned one-time token store, primarily for adversarial tests. */
  approvalTokenStore?: ApprovalTokenStore;
  /** Injectable OS boundary for platform and adversarial Runtime tests. */
  sandboxRunner?: SandboxRunner;
}

export interface ApprovalAnswererRequest {
  readonly approvalId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly actionId: string;
  readonly toolName: string;
  readonly actionDigest: string;
  readonly policyDigest: string;
  readonly scope: readonly string[];
  readonly expiresAt: string;
  readonly explanation: string;
}

/** Default guard against an unbounded model/tool loop. This is not a token limit. */
export const DEFAULT_MAX_TURNS = 12;
export const DEFAULT_MAX_TOOL_CONCURRENCY = 4;
export const DEFAULT_SANDBOX_MODE: SandboxMode = "workspace-write";

export interface AgentRuntime {
  /** Current process-local telemetry health; it is not canonical Run state. */
  getTelemetryStatus(): TelemetryStatus;
  /** Explicit best-effort export boundary. This method never rejects. */
  flushTelemetry(): Promise<void>;
  /** Read-only inspection used by CLI/Host settings; no Run is created. */
  inspectSkills(workspace: WorkspaceHandle): Promise<SkillProjectInspection>;
  /** Stage opaque attachment bytes before a Run exists. This writes no Run event. */
  stageAttachment(input: StageAttachmentInput): Promise<AttachmentStageReceipt>;
  /** Read bytes only after the canonical Run projection proves the attachment relation. */
  getAttachmentContent(input: {
    attachmentId: string;
    runId: string;
    projectId: string;
  }): Promise<AttachmentContent>;
  startRun(input: StartRunInput): Promise<RunProjection>;
  submitUserInput(command: SubmitUserInputCommand): Promise<SubmitUserInputResult>;
  approvePlan(command: ApprovePlanCommand): Promise<RunProjection>;
  readTodos(runId: string, projectId: string): Promise<TodoList>;
  writeTodo(input: UserTodoWriteCommand): Promise<TodoMutationResult>;
  readTeam(runId: string, projectId: string): Promise<TeamReadResponse>;
  createTeam(runId: string, projectId: string, request: CreateTeamRequest): Promise<TeamMutationResult>;
  writeTeamTask(runId: string, projectId: string, request: TeamTaskWriteRequest): Promise<TeamMutationResult>;
  /** Trusted Host ingress after deriving the member from canonical child provenance. */
  writeTeamTaskAsMember(
    runId: string,
    projectId: string,
    subagentId: string,
    request: TeamTaskWriteRequest,
  ): Promise<TeamMutationResult>;
  sendTeamMailbox(runId: string, projectId: string, request: TeamMailboxSendRequest): Promise<TeamMutationResult>;
  sendTeamMailboxAsMember(
    runId: string,
    projectId: string,
    subagentId: string,
    request: TeamMailboxSendRequest,
  ): Promise<TeamMutationResult>;
  claimTeamMailbox(runId: string, projectId: string, request: TeamMailboxClaimRequest): Promise<TeamMutationResult>;
  claimTeamMailboxAsMember(
    runId: string,
    projectId: string,
    subagentId: string,
    request: TeamMailboxClaimRequest,
  ): Promise<TeamMutationResult>;
  /** Trusted worker ingress; HTTP/browser callers must not choose this identity. */
  heartbeatTeamMember(
    runId: string,
    projectId: string,
    subagentId: string,
    request: TeamHeartbeatRequest,
  ): Promise<TeamMutationResult>;
  /** Explicit scheduler sweep; timeout is read from the frozen team projection. */
  expireTeamMembers(
    runId: string,
    projectId: string,
    request: TeamSweepLostMembersRequest,
  ): Promise<TeamMutationResult>;
  remember(runId: string, candidate: MemoryCandidate): Promise<MemoryRememberResult>;
  recall(runId: string, query: string, budget?: MemoryRecallBudget): Promise<MemoryRecallResult>;
  approve(command: ApprovalCommand): Promise<RunProjection>;
  reject(command: ApprovalCommand): Promise<RunProjection>;
  stop(command: StopRunCommand): Promise<RunProjection>;
  rollback(input: RollbackActionInput): Promise<RunProjection>;
  reconcileActions(
    input: SessionRunLocator & { workspace: WorkspaceHandle },
  ): Promise<ActionReconciliationResult>;
  getProjection(runId: string): Promise<RunProjection>;
  listSubagents(runId: string, projectId: string): Promise<SubagentListProjection>;
  sendSubagentMessage(
    runId: string,
    projectId: string,
    input: SendSubagentMessageInput,
  ): Promise<SubagentListProjection>;
  interruptSubagent(
    runId: string,
    projectId: string,
    input: InterruptSubagentInput,
  ): Promise<SubagentResult>;
  subscribe(runId: string, listener: (event: SessionEvent) => void): () => void;
  /**
   * Subscribe to an ephemeral, safe presentation projection of actual runtime
   * work.  This never exposes provider private reasoning or raw model/tool
   * payloads, and is intentionally not part of replayable ledger history.
   */
  subscribeLive(runId: string, listener: (activity: LivePublicActivity) => void): () => void;
  /**
   * Return the process-local buffer used to bridge the race between starting a
   * Run and attaching its live SSE stream. It is deliberately volatile.
   */
  listLiveActivities(runId: string, afterSequence?: number): readonly LivePublicActivity[];
  /**
   * Subscribe to actual provider-streamed public model text. This channel has
   * an independent cursor and is volatile; replay remains ledger-only.
   */
  subscribeModelSurface(runId: string, listener: (event: ModelSurfaceEvent) => void): () => void;
  listModelSurface(runId: string, afterCursor?: number): readonly ModelSurfaceEvent[];
  replayAt(input: ReplaySnapshotRequest): Promise<ReplaySnapshot>;
  replayDiff(input: ReplayDiffQuery): Promise<ReplayDiff>;
  replay(runId: string): Promise<RunProjection>;
  markRunInterrupted(input: SessionRunLocator & { reason?: string }): Promise<RunProjection>;
  resumeRun(input: ResumeInterruptedRunInput): Promise<RunProjection>;
  recordSessionFact(input: RecordSessionFactInput, lease?: SessionLease): Promise<SessionEvent>;
  getArtifact(input: { artifactId: string; runId: string; projectId: string }): Promise<ArtifactWireResponse>;
}

export interface UserTodoWriteCommand {
  command_id: string;
  project_id: string;
  run_id: string;
  updated_by: "user";
  input: TodoWriteInput;
}

export interface SessionRunLocator {
  sessionId: string;
  runId: string;
  projectId: string;
}

export interface ResumeInterruptedRunInput extends SessionRunLocator {
  commandId: string;
  workspace: WorkspaceHandle;
}

export interface RecordSessionFactInput extends SessionRunLocator {
  type: "session.title_changed" | "session.closed" | "session.tail_truncated";
  summary: string;
  data?: Record<string, unknown>;
  idempotencyKey: string;
}

interface PendingPatch {
  pendingApproval: PendingApproval;
  previewCall: ToolCall;
}

interface SessionScopedState {
  runId: string;
  sessionId: string;
  projectId: string;
  sessionLease?: SessionLease;
  lastSessionEntryId?: string;
  indexedSessionEventIds: Set<string>;
  extensionLease?: ExtensionRunLease;
}

interface RunState extends SessionScopedState {
  task: string;
  conversationHistory: StartRunInput["conversation_history"];
  mode: RunMode;
  reasoningEffort: ReasoningEffort;
  workspace: WorkspaceHandle;
  /** Frozen adapter identity for this Run; child profiles may override it. */
  model: ModelAdapter;
  rolePrompt?: string;
  /** A hard capability ceiling in addition to the frozen G-06 policy. */
  toolAllowlist?: ReadonlySet<ToolName>;
  /** G-10 Skill scope, narrowed after load_skill succeeds. */
  skillToolAllowlist?: ReadonlySet<ToolName>;
  loadedSkill?: string;
  skills: SkillRegistrySnapshotInternal;
  orchestration: {
    depth: number;
    limits: SubagentLimits;
    delegation?: SubagentStartedData;
  };
  maxTurns: number;
  subagentBudget?: {
    maxTokens: number;
    inputTokens: number;
    outputTokens: number;
    confidence: "exact" | "calibrated" | "estimated" | "provider_reported";
  };
  /** Frozen for this Run and persisted in its recovery Artifact. */
  permissionPolicy: EffectivePermissionPolicy;
  policyEngine: PolicyEngine;
  /** Immutable extension/tool surface frozen before run.created. */
  extensionSnapshot: ExtensionRunSnapshot;
  observations: Observation[];
  /** Volatile image bytes admitted only to the first model request. */
  modelImages: ModelImageInput[];
  turn: number;
  pendingPatch?: PendingPatch;
  pendingPlan?: { planEventId: string; todoIds: readonly string[] };
  /** Durable cancel input whose terminal transition is waiting for a safe boundary. */
  cancelInputId?: string;
  baseGraph?: GraphSnapshot;
  /** Last durable Git base captured for CodeGraph approval fencing. */
  codeIntelGitContext?: GitBaseContext;
  lastPatchEventId?: string;
  stopped: boolean;
  abortController: AbortController;
  commandQueue: Promise<void>;
  actionSignatures: Map<string, string>;
  /**
   * Number of runtime-owned action identities minted for this run.  The model
   * supplies an action_id as a correlation hint, but the Harness owns the
   * canonical identity.  Keeping the counter on the run makes collision
   * repair deterministic and independent of provider output.
   */
  canonicalActionSequence: number;
}

interface ActionIdentityRepair {
  readonly code: "action_id_conflict";
  readonly modelActionId: string;
  readonly canonicalActionId: string;
}

interface PendingModelSurface {
  readonly runId: string;
  readonly projectId: string;
  readonly modelCallId: string;
  readonly type: "public_plan_snapshot" | "answer_snapshot";
  text: string;
  timer?: ReturnType<typeof setTimeout>;
}

interface CommandBinding {
  signature: string;
  result: Promise<RunProjection>;
}

interface InputCommandBinding {
  signature: string;
  result: Promise<SubmitUserInputResult>;
}

interface ExecutedTool {
  receipt: Receipt;
  observation: Observation;
  raw: RawToolResult;
  artifactRefs: ArtifactRef[];
  event: SessionEvent;
  sandboxReport?: SandboxReport;
  walRecord?: ActionWalRecord;
  walTransactionId?: string;
}

type ValidatedToolCall = ReturnType<typeof validateToolCall>;

interface PreparedToolCall {
  readonly index: number;
  readonly call: ToolCall;
  readonly validated: ValidatedToolCall;
  readonly policyDecision: PolicyDecision;
  readonly executionBinding: ToolExecutionBinding;
  readonly serializedReason?: "approval_required" | "concurrency_unsafe" | "write_side_effect";
}

interface PendingToolExecution extends Omit<ExecutedTool, "event"> {
  readonly refetchedContextArtifact?: ArtifactRef;
  readonly refetchedContextRange?: {
    readonly offset: number;
    readonly returnedBytes: number;
    readonly totalBytes: number;
    readonly nextOffset?: number;
    readonly truncated: boolean;
  };
}

interface ScheduledToolResult {
  readonly prepared: PreparedToolCall;
  readonly executed: ExecutedTool;
}

interface ToolBatchScheduleResult {
  readonly completed: readonly ScheduledToolResult[];
  readonly actualPeakConcurrency: number;
}

interface PolicyAllowedToolExecutionBinding {
  readonly kind: "policy-allow";
  readonly actionDigest: string;
  readonly policyDigest: string;
  readonly canonicalTargetDigest?: string;
}

interface ApprovedOnceToolExecutionBinding {
  readonly kind: "approved-once";
  readonly actionDigest: string;
  readonly policyDigest: string;
  readonly canonicalTargetDigest?: string;
  readonly approvalId: string;
  readonly approvalTokenId: string;
}

type ToolExecutionBinding =
  | PolicyAllowedToolExecutionBinding
  | ApprovedOnceToolExecutionBinding;

type RuntimeEventProposal = Omit<
  SessionEventProposal,
  "project_id" | "run_id" | "attempt" | "artifact_refs"
> & { artifact_refs?: ArtifactRef[] };

export async function createAgentRuntime(options: AgentRuntimeOptions): Promise<AgentRuntime> {
  const maxToolConcurrency = options.maxToolConcurrency ?? DEFAULT_MAX_TOOL_CONCURRENCY;
  const sandboxMode = SandboxModeSchema.parse(options.sandboxMode ?? DEFAULT_SANDBOX_MODE);
  SandboxPlatformSchema.parse(process.platform);
  if (
    !Number.isInteger(maxToolConcurrency)
    || maxToolConcurrency < 1
    || maxToolConcurrency > MAX_TOOL_CALLS_PER_DECISION
  ) {
    throw new RangeError(
      `maxToolConcurrency must be an integer between 1 and ${MAX_TOOL_CALLS_PER_DECISION}`,
    );
  }
  await mkdir(options.dataDir, { recursive: true });
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? defaultIdFactory;
  const ledger = new JsonlEventLedger(join(options.dataDir, "events"), { now, idFactory });
  const artifacts = new ArtifactStore(join(options.dataDir, "artifacts"), { now, idFactory });
  const attachmentStore = options.attachmentStore
    ?? new AttachmentStore(join(options.dataDir, "attachments"), { artifacts, now, idFactory });
  const tokenMeter = options.tokenMeter ?? new CalibratedTokenMeter({
    calibrationPath: join(options.dataDir, "token-calibration.json"),
    now,
  });
  const actionWal = options.actionWal ?? new ActionWal(join(options.dataDir, "wal"), { now, idFactory });
  const recoveryLedger = options.recoveryLedger
    ?? new RecoveryLedger(join(options.dataDir, "recovery"), { now, idFactory });
  const memoryStore = options.memoryStore
    ?? new JsonlMemoryStore(join(options.dataDir, "memory", "records.jsonl"));
  const model = options.model ?? new DeterministicFakeModel({ idFactory });
  const skillRegistry = options.skillRegistry ?? new SkillRegistry();
  const subagentLimits = SubagentLimitsSchema.parse({
    max_parallel_subagents: options.maxParallelSubagents ?? DEFAULT_SUBAGENT_LIMITS.max_parallel_subagents,
    max_depth: options.maxSubagentDepth ?? DEFAULT_SUBAGENT_LIMITS.max_depth,
  });
  const subagentRegistry = options.subagentRegistry ?? SubagentRegistry.withReadonlyDefault(model);
  let extensionManager = options.extensionManager;
  let toolRegistry = options.toolRegistry;
  if (extensionManager !== undefined && toolRegistry !== undefined && extensionManager.toolRegistry !== toolRegistry) {
    throw new TypeError("extensionManager and toolRegistry must share the same ToolRegistry");
  }
  if (extensionManager === undefined) {
    toolRegistry ??= createCoreToolRegistry();
    extensionManager = new ExtensionManager({ toolRegistry, now });
    // A caller-supplied registry is an explicit compatibility composition.
    // The default composition proves the two existing capability groups use
    // the same reversible extension surface as external trusted extensions.
    if (options.toolRegistry === undefined) {
      await extensionManager.activateAll([
        createArtifactToolsExtension(),
        createRunStateToolsExtension(),
      ]);
    }
  } else {
    toolRegistry = extensionManager.toolRegistry;
  }
  if (options.lspManager !== undefined && toolRegistry.get("get_diagnostics") === undefined) {
    await extensionManager.activate(createLspToolsExtension(options.lspManager));
  }
  await Promise.all([
    ledger.initialize(),
    artifacts.initialize(),
    attachmentStore.initialize(),
    options.sessionStore?.initialize(),
    // Token accounting is optional evidence, not a startup dependency. An
    // unsafe/corrupt calibration store remains rejected by the meter itself,
    // while Runtime degrades to per-call heuristic estimates and uncalibrated
    // provider reports instead of making the Agent unavailable.
    tokenMeter.initialize().catch(() => undefined),
    // A writable Runtime must never silently bypass its action journal.
    actionWal.initialize(),
    recoveryLedger.initialize(),
    memoryStore.initialize(),
  ]);
  return new AgentRuntimeImpl({
    ...options,
    maxToolConcurrency,
    sandboxMode,
    sandboxRunner: options.sandboxRunner ?? createSandboxRunner(),
    now,
    idFactory,
    ledger,
    artifacts,
    attachmentStore,
    tokenMeter,
    actionWal,
    recoveryLedger,
    memoryStore,
    skillRegistry,
    mcpManager: options.mcpManager,
    lspManager: options.lspManager,
    model,
    subagentRegistry,
    subagentLimits,
    toolRegistry,
    extensionManager,
    telemetrySink: extensionManager.telemetrySink(options.telemetrySink ?? new NoopTelemetrySink()),
  });
}

class AgentRuntimeImpl implements AgentRuntime {
  readonly #now: () => Date;
  readonly #idFactory: (prefix: string) => string;
  readonly #ledger: JsonlEventLedger;
  readonly #artifacts: ArtifactStore;
  readonly #attachmentStore: AttachmentStore;
  readonly #sessionStore: SessionStore | undefined;
  readonly #model: ModelAdapter;
  readonly #tokenMeter: TokenMeter;
  readonly #actionWal: ActionWal;
  readonly #recoveryLedger: RecoveryLedger;
  readonly #rollbackPolicy: RollbackPolicy;
  readonly #actionCommitFaultInjector: AgentRuntimeOptions["actionCommitFaultInjector"];
  readonly #toolRegistry: ToolRegistry;
  readonly #extensionManager: ExtensionManager;
  readonly #codeGraph: CodeGraphProvider | undefined;
  readonly #contextPolicy: ContextPolicy | undefined;
  readonly #memory: MemoryManager;
  readonly #skillRegistry: SkillRegistry;
  readonly #mcpManager: McpManager | undefined;
  readonly #mcpLifecycleEvents: McpManagerEvent[];
  readonly #mcpListener: { dispose(): void | Promise<void> } | undefined;
  readonly #lspManager: LspManager | undefined;
  readonly #lspListener: { dispose(): void | Promise<void> } | undefined;
  readonly #retrievalBudget: MemoryRecallBudget;
  readonly #maxTurns: number;
  readonly #maxToolConcurrency: number;
  readonly #subagentRegistry: SubagentRegistry;
  readonly #subagentLimits: SubagentLimits;
  readonly #subagentPermits: SubagentPermitPool;
  readonly #defaultPermissionPolicy: EffectivePermissionPolicy;
  readonly #permissionPolicyResolver: AgentRuntimeOptions["permissionPolicyResolver"];
  readonly #approvalAnswerer: AgentRuntimeOptions["approvalAnswerer"];
  readonly #approvalTokenStore: ApprovalTokenStore;
  readonly #sandboxRunner: SandboxRunner;
  readonly #todos: TodoDomainService;
  readonly #teams: TeamDomainService;
  readonly #contextBuilder: DeterministicContextBuilder;
  readonly #telemetry: SafeTelemetry;
  readonly #runtimeTelemetry: RuntimeTelemetryProjector;
  readonly #runs = new Map<string, RunState>();
  readonly #commandRuns = new Map<string, CommandBinding>();
  readonly #inputCommandRuns = new Map<string, InputCommandBinding>();
  readonly #liveActivities = new Map<string, LivePublicActivity[]>();
  readonly #liveListeners = new Map<string, Set<(activity: LivePublicActivity) => void>>();
  readonly #modelSurfaceEvents = new Map<string, ModelSurfaceEvent[]>();
  readonly #modelSurfaceListeners = new Map<string, Set<(event: ModelSurfaceEvent) => void>>();
  readonly #modelSurfaceCursors = new Map<string, number>();
  readonly #pendingModelSurface = new Map<string, PendingModelSurface>();
  readonly #appendQueues = new Map<string, Promise<void>>();
  /**
   * Serializes authority-bearing control transitions which must observe one
   * durable Run state: input check+append, input consumption, and terminal or
   * plan-ready transitions. This is deliberately separate from appendQueues;
   * ordering individual writes alone cannot make the preceding checks atomic.
   */
  readonly #controlQueues = new Map<string, Promise<void>>();

  constructor(options: AgentRuntimeOptions & {
    now: () => Date;
    idFactory: (prefix: string) => string;
    ledger: JsonlEventLedger;
    artifacts: ArtifactStore;
    attachmentStore: AttachmentStore;
    tokenMeter: TokenMeter;
    actionWal: ActionWal;
    recoveryLedger: RecoveryLedger;
    memoryStore: MemoryRecordStore;
    skillRegistry: SkillRegistry;
    model: ModelAdapter;
    subagentRegistry: SubagentRegistry;
    subagentLimits: SubagentLimits;
    toolRegistry: ToolRegistry;
    extensionManager: ExtensionManager;
    mcpManager?: McpManager | undefined;
    lspManager?: LspManager | undefined;
  }) {
    this.#now = options.now;
    this.#idFactory = options.idFactory;
    this.#ledger = options.ledger;
    this.#artifacts = options.artifacts;
    this.#attachmentStore = options.attachmentStore;
    this.#sessionStore = options.sessionStore;
    this.#model = options.model;
    this.#tokenMeter = options.tokenMeter;
    this.#actionWal = options.actionWal;
    this.#recoveryLedger = options.recoveryLedger;
    this.#rollbackPolicy = {
      enabled: options.rollbackPolicy?.enabled ?? false,
      allowForce: options.rollbackPolicy?.allowForce ?? false,
    };
    this.#actionCommitFaultInjector = options.actionCommitFaultInjector;
    this.#toolRegistry = options.toolRegistry;
    this.#extensionManager = options.extensionManager;
    this.#codeGraph = options.codeGraph;
    this.#contextPolicy = options.contextPolicy;
    this.#retrievalBudget = MemoryRecallBudgetSchema.parse(
      options.retrievalBudget ?? DEFAULT_MEMORY_RECALL_BUDGET,
    );
    this.#maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.#maxToolConcurrency = options.maxToolConcurrency ?? DEFAULT_MAX_TOOL_CONCURRENCY;
    this.#subagentRegistry = options.subagentRegistry;
    this.#subagentLimits = options.subagentLimits;
    this.#subagentPermits = new SubagentPermitPool(options.subagentLimits.max_parallel_subagents);
    this.#defaultPermissionPolicy = options.permissionPolicy === undefined
      ? legacyPermissionPolicy(SandboxModeSchema.parse(options.sandboxMode ?? DEFAULT_SANDBOX_MODE))
      : PolicyEngine.fromEffective(options.permissionPolicy, { idFactory: this.#idFactory }).effectivePolicy();
    this.#permissionPolicyResolver = options.permissionPolicyResolver;
    this.#approvalAnswerer = options.approvalAnswerer;
    this.#approvalTokenStore = options.approvalTokenStore ?? new ApprovalTokenStore({
      now: this.#now,
      idFactory: this.#idFactory,
    });
    this.#sandboxRunner = options.sandboxRunner ?? createSandboxRunner();
    this.#telemetry = new SafeTelemetry(options.telemetrySink ?? new NoopTelemetrySink(), {
      now: this.#now,
    });
    this.#runtimeTelemetry = new RuntimeTelemetryProjector(this.#telemetry);
    this.#todos = new TodoDomainService({
      list: (runId) => this.#ledger.list(runId),
      append: (proposal) => this.#appendTodoProposal(proposal),
    });
    this.#teams = new TeamDomainService({
      list: (runId) => this.#ledger.list(runId),
      append: (proposal) => this.#appendTodoProposal(proposal),
      appendAtomic: (scope, proposals, finalize) => this.#appendTeamAtomic(scope, proposals, finalize),
    }, {
      now: this.#now,
      idFactory: this.#idFactory,
      defaultLimits: {
        max_parallel_workers: options.subagentLimits.max_parallel_subagents,
      },
      evidenceResolver: async ({
        projectId,
        coordinatorRunId,
        member,
        evidenceEventIds,
        beforeActionId,
      }) => {
        if (
          member.link.parent_run_id !== coordinatorRunId
          || member.link.parent_session_id === member.link.child_session_id
        ) return false;
        const childEvents = await this.#ledger.list(member.link.child_run_id);
        const childCreated = childEvents[0];
        if (
          childCreated?.type !== "run.created"
          || childCreated.project_id !== projectId
          || childCreated.run_id !== member.link.child_run_id
          || childCreated.session_id !== member.link.child_session_id
          || childCreated.data.parent_run_id !== coordinatorRunId
          || childCreated.data.parent_session_id !== member.link.parent_session_id
          || childCreated.data.subagent_id !== member.link.subagent_id
        ) return false;
        const beforeSequence = beforeActionId === undefined
          ? Number.POSITIVE_INFINITY
          : childEvents.find((event) => (
            event.type === "tool.started" && event.action_id === beforeActionId
          ))?.sequence;
        if (beforeSequence === undefined) return false;
        return evidenceEventIds.length > 0 && evidenceEventIds.every((eventId) => {
          const event = childEvents.find(({ event_id: candidate }) => candidate === eventId);
          return event !== undefined
            && event.project_id === projectId
            && event.run_id === member.link.child_run_id
            && event.session_id === member.link.child_session_id
            && event.sequence < beforeSequence
            && isEligibleTeamTaskEvidence(event);
        });
      },
    });
    this.#memory = new MemoryManager({
      store: options.memoryStore,
      events: { append: (proposal) => this.#appendTodoProposal(proposal) },
      ...(options.retriever === undefined ? {} : { retriever: options.retriever }),
      now: this.#now,
      idFactory: this.#idFactory,
      estimateTokens,
    });
    this.#skillRegistry = options.skillRegistry;
    this.#mcpManager = options.mcpManager;
    this.#mcpLifecycleEvents = (options.mcpManager?.history() ?? []).filter((event) => event.type !== "mcp.tool_called");
    this.#mcpListener = options.mcpManager?.onEvent(async (event) => {
      if (event.type === "mcp.tool_called") return;
      const active = [...this.#runs.values()];
      if (active.length === 0) {
        this.#mcpLifecycleEvents.push(event);
        return;
      }
      await Promise.all(active.map((state) => this.#appendMcpEvent(state, event)));
    });
    this.#lspManager = options.lspManager;
    this.#lspListener = options.lspManager?.onEvent(async (event) => {
      // Tool executions pass an event sink through the LSP bridge, which
      // binds the event to the exact Run. Do not append that same project-
      // scoped event again from the process-wide observer.
      if (typeof event.data.project_id === "string") return;
      const projectId = event.data.project_id;
      const active = [...this.#runs.values()].filter((state) => projectId === undefined || projectId === state.projectId);
      await Promise.all(active.map((state) => this.#appendLspEvent(state, event)));
    });
    this.#contextBuilder = new DeterministicContextBuilder({
      now: this.#now,
      idFactory: this.#idFactory,
      tokenMeter: this.#tokenMeter,
    });
  }

  getTelemetryStatus(): TelemetryStatus {
    return this.#telemetry.status();
  }

  async flushTelemetry(): Promise<void> {
    try {
      await this.#telemetry.flush();
    } catch {
      // SafeTelemetry already converts sink failures into degraded status.
      // Keep this outer fence so telemetry can never become a Runtime failure
      // boundary if the emitter implementation evolves.
    }
  }

  async inspectSkills(workspace: WorkspaceHandle): Promise<SkillProjectInspection> {
    const parsed = WorkspaceHandleSchema.parse(workspace);
    const snapshot = await this.#skillRegistry.scan(parsed.real_root);
    return {
      project_id: parsed.project_id,
      label: parsed.project_id,
      registry: this.#skillRegistry.publicSnapshot(snapshot),
    };
  }

  async stageAttachment(input: StageAttachmentInput): Promise<AttachmentStageReceipt> {
    return this.#attachmentStore.stageAttachment(input);
  }

  async startRun(inputValue: StartRunInput): Promise<RunProjection> {
    const input = StartRunInputSchema.parse(inputValue);
    const signature = commandSignature(input);
    return this.#runCommand(input.command_id, signature, async () => {
      if (input.project_id !== input.workspace.project_id) {
        throw new RuntimeCommandError("workspace_project_mismatch", "WorkspaceHandle belongs to another project");
      }
      const workspace = WorkspaceHandleSchema.parse(input.workspace);
      const extensionLease = this.#extensionManager.acquireRunLease();
      const extensionSnapshot = extensionLease.snapshot;
      let permissionPolicy: EffectivePermissionPolicy;
      try {
        permissionPolicy = await this.#resolvePermissionPolicy(workspace, extensionSnapshot);
      } catch (error) {
        extensionLease.release();
        throw error;
      }
      const policyEngine = PolicyEngine.fromEffective(permissionPolicy, { idFactory: this.#idFactory });
      const runId = this.#idFactory("run");
      const skills = await this.#skillRegistry.scan(workspace.real_root);
      let session: {
        sessionId: string;
        created: boolean;
        lease?: SessionLease;
        lastEntryId?: string;
        indexedEventIds: Set<string>;
      };
      try {
        session = await this.#prepareSession(input);
      } catch (error) {
        extensionLease.release();
        throw error;
      }
      const recoveryState = RunRecoveryStateSchema.parse({
        version: 5,
        kind: "run_recovery_state",
        task: redactSensitiveText(input.task),
        conversation_history: (input.conversation_history ?? []).map((message) => ({
          role: message.role,
          content: redactSensitiveText(message.content),
        })),
        mode: input.mode,
        reasoning_effort: input.reasoning_effort ?? "default",
        effective_policy: permissionPolicy,
        orchestration: {
          depth: 0,
          limits: this.#subagentLimits,
        },
        extensions: extensionSnapshot,
        skills: {
          registry_digest: skills.registry_digest,
          active_tool_names: [],
        },
      });
      let recoveryArtifact: ArtifactRef;
      try {
        recoveryArtifact = await this.#artifacts.put({
          projectId: input.project_id,
          runId,
          kind: "recovery_state",
          mimeType: "application/json",
          content: JSON.stringify(recoveryState),
        });
      } catch (error) {
        extensionLease.release();
        await session.lease?.release().catch(() => undefined);
        throw error;
      }
      const state: RunState = {
        runId,
        sessionId: session.sessionId,
        projectId: input.project_id,
        task: recoveryState.task,
        conversationHistory: recoveryState.conversation_history,
        mode: input.mode,
        reasoningEffort: input.reasoning_effort ?? "default",
        workspace,
        model: this.#model,
        orchestration: { depth: 0, limits: this.#subagentLimits },
        maxTurns: this.#maxTurns,
        permissionPolicy,
        policyEngine,
        extensionSnapshot,
        skills,
        extensionLease,
        observations: [],
        modelImages: [],
        turn: 0,
        stopped: false,
        abortController: new AbortController(),
        commandQueue: Promise.resolve(),
        actionSignatures: new Map(),
        canonicalActionSequence: 0,
        ...(session.lease === undefined ? {} : { sessionLease: session.lease }),
        ...(session.lastEntryId === undefined ? {} : { lastSessionEntryId: session.lastEntryId }),
        indexedSessionEventIds: session.indexedEventIds,
      };
      try {
        await this.#append(state, {
          type: "run.created",
          summary: "Run created",
          idempotency_key: commandEventKey(input.command_id, "run.created"),
          data: {
            task: recoveryState.task,
            mode: input.mode,
            reasoning_effort: state.reasoningEffort,
            workspace_kind: workspace.workspace_kind,
            conversation_message_count: state.conversationHistory?.length ?? 0,
            _internal_recovery_artifact: recoveryArtifact,
            // Keep the orchestration guard visible in the durable Run record.
            // This is separate from the Context window and provider output cap.
            max_turns: state.maxTurns,
            subagent_limits: this.#subagentLimits,
          },
        });
        await this.#claimRunAttachments(state, input.attachment_upload_ids ?? []);
        if (session.created) {
          await this.#append(state, {
            type: "session.opened",
            summary: "Durable session opened",
            idempotency_key: `${runId}:session.opened`,
            data: { session_version: SESSION_FORMAT_VERSION },
          });
        }
        await this.#append(state, {
          type: "permission.configured",
          summary: `Permission preset configured as ${permissionPolicy.preset.key}`,
          data: PermissionConfiguredDataSchema.parse({ permission: policyEngine.snapshot() }),
        });
        await this.#recordSkillRegistry(state);
        await this.#recordMcpEvents(state);
        await this.#recordSandboxConfiguration(state);
        await this.#append(state, {
          type: "run.started",
          summary: workspace.capabilities.index
            ? "Workspace preflight and indexing started"
            : "Conversation started without workspace indexing",
          idempotency_key: commandEventKey(input.command_id, "run.started"),
          data: { phase: workspace.capabilities.index ? "indexing" : "conversation" },
        });
        this.#runs.set(runId, state);
      } catch (error) {
        extensionLease.release();
        await state.sessionLease?.release().catch(() => undefined);
        throw error;
      }

      void this.#enqueue(state, () => this.#bootstrapRun(state));
      return this.getProjection(runId);
    });
  }

  async #claimRunAttachments(state: RunState, uploadIds: readonly string[]): Promise<void> {
    if (uploadIds.length === 0) return;
    const capabilities = modelCapabilities(state.model);
    for (const uploadId of uploadIds) {
      const result = await this.#attachmentStore.claimAttachment({
        uploadId,
        projectId: state.projectId,
        sessionId: state.sessionId,
        runId: state.runId,
        modelCapabilities: capabilities,
      });
      if (result.status === "rejected") {
        await this.#append(state, {
          type: "attachment.rejected",
          summary: `Attachment rejected (${result.rejected.code})`,
          idempotency_key: attachmentEventKey(state.runId, uploadId, "rejected"),
          data: result.rejected,
        });
        continue;
      }

      await this.#append(state, {
        type: "attachment.added",
        summary: `Attachment added (${result.added.attachment.media_type})`,
        idempotency_key: attachmentEventKey(state.runId, uploadId, "added"),
        artifact_refs: result.artifactRefs,
        data: result.added,
      });
      if (result.offloaded !== undefined) {
        const originalRef = result.artifactRefs.find(
          (artifact) => artifact.artifact_id === result.added.attachment.attachment_id,
        );
        await this.#append(state, {
          type: "attachment.offloaded",
          summary: `Attachment available by reference (${result.offloaded.reason})`,
          idempotency_key: attachmentEventKey(state.runId, uploadId, "offloaded"),
          artifact_refs: originalRef === undefined ? [] : [originalRef],
          data: result.offloaded,
        });
      }
      state.observations.push(attachmentObservation(result.added, result.artifactRefs, this.#now()));
      if (result.modelImage !== undefined) state.modelImages.push(result.modelImage);
    }
  }

  async #recordSkillRegistry(state: RunState): Promise<void> {
    const registry = SkillRegistryLoadedDataSchema.parse({
      registry_digest: state.skills.registry_digest,
      skill_names: state.skills.skills.map(({ name }) => name),
      loaded_count: state.skills.skills.length,
      conflict_count: state.skills.conflicts.length,
      diagnostic_count: state.skills.diagnostics.length,
    });
    await this.#append(state, {
      type: "skill.registry_loaded",
      summary: `Loaded ${registry.loaded_count} local Skill catalog entries`,
      data: registry,
    });
    for (const conflict of state.skills.conflicts) {
      await this.#append(state, {
        type: "skill.conflict",
        summary: `Skill ${conflict.name} resolved with ${conflict.winner} precedence`,
        data: SkillConflictDataSchema.parse(conflict),
      });
    }
    for (const diagnostic of state.skills.diagnostics) {
      await this.#append(state, {
        type: "skill.load_failed",
        summary: `Skill file skipped: ${diagnostic.message}`,
        data: SkillLoadFailedDataSchema.parse(diagnostic),
      });
    }
  }

  async #recordMcpEvents(state: RunState): Promise<void> {
    const pending = this.#mcpLifecycleEvents.splice(0, this.#mcpLifecycleEvents.length);
    for (const event of pending) await this.#appendMcpEvent(state, event);
  }

  async #appendMcpEvent(state: RunState, event: McpManagerEvent): Promise<void> {
    await this.#append(state, {
      type: event.type,
      summary: mcpEventSummary(event),
      data: event.data,
    });
  }

  async #appendLspEvent(state: RunState, event: LspManagerEvent): Promise<void> {
    const projectId = event.data.project_id;
    if (typeof projectId === "string" && projectId !== state.projectId) return;
    const data = event.type === "lsp.diagnostics_received"
      ? LspDiagnosticsReceivedDataSchema.parse(event.data)
      : LspServerUnavailableDataSchema.parse(event.data);
    await this.#append(state, {
      type: event.type,
      summary: lspEventSummary(event),
      data,
    });
  }

  #skillToolBridge(state: RunState): SkillToolBridge {
    return {
      load: (input) => this.#loadSkill(state, input),
    };
  }

  async #loadSkill(state: RunState, inputValue: unknown): Promise<RawToolResult> {
    const input = SkillLoadInputSchema.safeParse(inputValue);
    if (!input.success) {
      return { status: "failure", code: "invalid_skill_name", summary: "Skill name is invalid" };
    }
    const skill = this.#skillRegistry.find(state.skills, input.data.name);
    if (skill === undefined) {
      await this.#append(state, {
        type: "skill.load_failed",
        summary: `Skill ${input.data.name} was not found in the frozen registry`,
        data: SkillLoadFailedDataSchema.parse({
          source: "project",
          path: "registry",
          code: "read_failed",
          message: "Skill was not found in the frozen registry",
          skill_name: input.data.name,
        }),
      });
      return { status: "failure", code: "skill_not_found", summary: `Skill ${input.data.name} is not available` };
    }
    const globalAllowed = new Set(state.permissionPolicy.preset.allowed_tools);
    if (!globalAllowed.has("load_skill")) {
      return {
        status: "failure",
        code: "skill_loader_denied",
        summary: "The active permission preset does not allow load_skill",
      };
    }
    const declared = [...skill.allowed_tools];
    const unknownTools = declared.filter((toolName) => this.#toolRegistry.get(toolName) === undefined);
    const effective = declared.filter((toolName) => (
      this.#toolRegistry.get(toolName) !== undefined
      && globalAllowed.has(toolName)
      && (state.toolAllowlist === undefined || state.toolAllowlist.has(toolName))
    ));
    const active = new Set<ToolName>(effective);
    active.add("load_skill");
    state.skillToolAllowlist = active;
    state.loadedSkill = skill.name;
    return {
      status: "success",
      code: "skill_loaded",
      summary: `Loaded Skill ${skill.name} v${skill.version}`,
      content: skill.body,
      mimeType: "text/markdown",
      // `content` is deliberately mirrored as a fact so the Observation
      // projection carries a bounded excerpt into the next Context Manifest;
      // the full body remains available through the canonical tool Artifact.
      facts: {
        content: skill.body,
        skill_name: skill.name,
        skill_version: skill.version,
        skill_source: skill.source,
        registry_digest: state.skills.registry_digest,
        declared_allowed_tools: declared,
        effective_allowed_tools: [...effective],
        ...(unknownTools.length === 0 ? {} : { ignored_tools: unknownTools }),
      },
    };
  }

  submitUserInput(commandValue: SubmitUserInputCommand): Promise<SubmitUserInputResult> {
    const command = SubmitUserInputCommandSchema.parse(commandValue);
    const signature = commandSignature(command);
    return this.#runInputCommand(command.command_id, signature, async () => {
      const idempotencyKey = userInputQueuedEventKey(command.command_id);
      const canonicalBody = redactSensitiveText(command.body);
      const inputDigest = userInputDigest(command.kind, command.body);
      const durableEvents = await this.#ledger.list(command.run_id);
      assertRunBelongsToProject(durableEvents, command.run_id, command.project_id);
      // Validate the complete durable mailbox before using a single queued
      // fact as an idempotency receipt. This makes corrupt consumption links,
      // kinds, FIFO order, and steps fail closed even on a lost-response retry.
      const durableProjection = projectRun(durableEvents);
      const durableReplay = replaySubmittedUserInput(
        durableEvents,
        command,
        signature,
        canonicalBody,
        inputDigest,
        idempotencyKey,
      );
      if (durableReplay !== undefined) {
        const active = this.#runs.get(command.run_id);
        if (active === undefined || active.projectId !== command.project_id) {
          if (
            findUserInputCommandEvent(durableEvents, command.command_id, idempotencyKey) !== undefined
            || isTerminalProjectionStatus(durableProjection.status)
          ) return durableReplay;
          // A logical duplicate may arrive after a Host restart while the Run
          // is view-only/interrupted. Persist a command receipt without adding
          // another logical queue item so that this command id cannot be
          // rebound to another payload after a later resume.
          return this.#withRunControl(command.run_id, async () => {
            const events = await this.#ledger.list(command.run_id);
            assertRunBelongsToProject(events, command.run_id, command.project_id);
            const projection = projectRun(events);
            const replay = replaySubmittedUserInput(
              events,
              command,
              signature,
              canonicalBody,
              inputDigest,
              idempotencyKey,
            );
            if (replay === undefined) {
              throw new RuntimeCommandError(
                "input_replay_unavailable",
                "Durable user input disappeared while binding a retry",
              );
            }
            if (
              findUserInputCommandEvent(events, command.command_id, idempotencyKey) === undefined
              && !isTerminalProjectionStatus(projection.status)
            ) {
              await this.#bindDuplicateUserInputCommandLocked(
                events,
                projection,
                command,
                signature,
                inputDigest,
                idempotencyKey,
              );
            }
            return replay;
          });
        }

        let cancelQueued = false;
        try {
          return await this.#withRunControl(active.runId, async () => {
            const events = await this.#ledger.list(active.runId);
            assertRunBelongsToProject(events, active.runId, active.projectId);
            const projection = projectRun(events);
            const replay = replaySubmittedUserInput(
              events,
              command,
              signature,
              canonicalBody,
              inputDigest,
              idempotencyKey,
            );
            if (replay === undefined) {
              throw new RuntimeCommandError(
                "input_replay_unavailable",
                "Durable user input disappeared while reconciling a retry",
              );
            }
            if (command.kind === "cancel") {
              // Arm before repairing the secondary Session index. The Event
              // Ledger is authoritative; an index failure must not leave a
              // durable cancel unable to abort an in-flight provider call.
              // A terminal replay is also finalized again so a terminal Event
              // committed before Session indexing can repair that index/lease.
              cancelQueued = isTerminalProjectionStatus(projection.status)
                ? true
                : this.#armCancellationLocked(active, events, command.input_id);
            }
            const priorCommand = findUserInputCommandEvent(events, command.command_id, idempotencyKey);
            if (priorCommand === undefined) {
              await this.#bindDuplicateUserInputCommandLocked(
                events,
                projection,
                command,
                signature,
                inputDigest,
                idempotencyKey,
              );
            } else {
              await this.#repairUserInputCommandIndexLocked(active, priorCommand);
            }
            return replay;
          });
        } finally {
          if (cancelQueued) this.#scheduleUserCancellationFinalizer(active, command.input_id);
        }
      }

      // Only a genuinely new input requires a live mutable Run. Durable
      // retries remain replayable after restart or after the Run terminates.
      if (isTerminalProjectionStatus(durableProjection.status)) {
        throw new RuntimeCommandError("run_terminal", "A terminal Run cannot accept user input");
      }
      if (
        durableProjection.status === "interrupted"
        || durableProjection.status === "needs_manual_review"
      ) {
        throw new RuntimeCommandError(
          "run_not_mutable",
          "User input is unavailable while the Run requires recovery or manual review",
        );
      }
      if (durableProjection.input_queue.pending.some((input) => input.kind === "cancel")) {
        throw new RuntimeCommandError("run_cancelling", "Run cancellation is already queued");
      }
      const state = this.#requireRun(command.run_id, command.project_id);
      let cancelQueued = false;
      try {
        return await this.#withRunControl(state.runId, async () => {
          const events = await this.#ledger.list(state.runId);
          assertRunBelongsToProject(events, state.runId, state.projectId);
          const projection = projectRun(events);
          const replay = replaySubmittedUserInput(
            events,
            command,
            signature,
            canonicalBody,
            inputDigest,
            idempotencyKey,
          );
          if (replay !== undefined) {
            if (command.kind === "cancel") {
              cancelQueued = isTerminalProjectionStatus(projection.status)
                ? true
                : this.#armCancellationLocked(state, events, command.input_id);
            }
            const priorCommand = findUserInputCommandEvent(events, command.command_id, idempotencyKey);
            if (priorCommand === undefined) {
              await this.#bindDuplicateUserInputCommandLocked(
                events,
                projection,
                command,
                signature,
                inputDigest,
                idempotencyKey,
              );
            } else {
              await this.#repairUserInputCommandIndexLocked(state, priorCommand);
            }
            return replay;
          }

          if (isTerminalProjectionStatus(projection.status)) {
            throw new RuntimeCommandError("run_terminal", "A terminal Run cannot accept user input");
          }
          if (projection.status === "interrupted" || projection.status === "needs_manual_review") {
            throw new RuntimeCommandError(
              "run_not_mutable",
              "User input is unavailable while the Run requires recovery or manual review",
            );
          }
          if (projection.input_queue.pending.some((input) => input.kind === "cancel")) {
            throw new RuntimeCommandError("run_cancelling", "Run cancellation is already queued");
          }
          if (state.stopped) {
            throw new RuntimeCommandError("run_cancelling", "Run is already stopping");
          }
          const queueLimit = command.kind === "cancel"
            ? MAX_PENDING_USER_INPUTS
            : MAX_PENDING_USER_INPUTS - 1;
          if (projection.input_queue.pending.length >= queueLimit) {
            throw new RuntimeCommandError("input_queue_full", "Run user input queue is full");
          }

          const input = PendingUserInputSchema.parse({
            input_id: command.input_id,
            run_id: state.runId,
            kind: command.kind,
            body: canonicalBody,
            actor: command.actor,
            submitted_at: this.#now().toISOString(),
          });
          let queuedEvent: SessionEvent;
          try {
            queuedEvent = await this.#append(state, {
              type: "user.input_queued",
              summary: command.kind === "cancel"
                ? command.actor === "parent_agent"
                  ? "Parent agent requested child Run cancellation"
                  : "User requested Run cancellation"
                : command.actor === "parent_agent"
                  ? "Parent-agent message queued for the next safe step"
                  : "User input queued for the next safe step",
              idempotency_key: idempotencyKey,
              data: UserInputQueuedDataSchema.parse({
                input,
                _internal_command_digest: signature,
                _internal_input_digest: inputDigest,
              }),
            });
          } catch (error) {
            // #append may fail after the Event Ledger commit while repairing
            // the secondary Session index. A committed cancel must still win
            // authority and unblock a provider even though this call reports
            // the indexing failure to its caller.
            if (command.kind === "cancel") {
              const committedEvents = await this.#ledger.list(state.runId);
              projectRun(committedEvents);
              const committed = replaySubmittedUserInput(
                committedEvents,
                command,
                signature,
                canonicalBody,
                inputDigest,
                idempotencyKey,
              );
              if (committed !== undefined) {
                cancelQueued = this.#armCancellationLocked(state, committedEvents, command.input_id);
              }
            }
            throw error;
          }
          const queuedData = queuedEvent.type === "user.input_queued"
            ? UserInputQueuedDataSchema.safeParse(queuedEvent.data)
            : undefined;
          if (
            queuedData === undefined
            || !queuedData.success
            || queuedData.data.input.input_id !== input.input_id
            || queuedData.data._internal_command_digest !== signature
            || queuedData.data._internal_input_digest !== inputDigest
          ) {
            throw new RuntimeCommandError(
              "command_id_conflict",
              "User input idempotency key resolved to a different durable event",
            );
          }
          if (command.kind === "cancel") {
            // The cancellation fact is durable before the current provider or
            // Tool observes abort. A write Tool may shield its irreversible
            // rename/WAL boundary, so terminalization remains queued behind the
            // active Runtime operation.
            cancelQueued = this.#armCancellationLocked(state, [
              ...events,
              ...(events.some((event) => event.event_id === queuedEvent.event_id) ? [] : [queuedEvent]),
            ], input.input_id);
          }
          return SubmitUserInputResultSchema.parse({ input, disposition: "queued" });
        });
      } finally {
        if (cancelQueued) this.#scheduleUserCancellationFinalizer(state, command.input_id);
      }
    });
  }

  async approvePlan(commandValue: ApprovePlanCommand): Promise<RunProjection> {
    const command = ApprovePlanCommandSchema.parse(commandValue);
    const signature = commandSignature(command);
    return this.#runCommand(command.command_id, signature, async () => {
      const idempotencyKey = commandEventKey(command.command_id, "plan.approved");
      const durableEvents = await this.#ledger.list(command.run_id);
      assertRunBelongsToProject(durableEvents, command.run_id, command.project_id);
      const priorCommand = durableEvents.find((event) => event.idempotency_key === idempotencyKey);
      if (priorCommand !== undefined) {
        if (
          priorCommand.type !== "plan.approved"
          || priorCommand.data.plan_event_id !== command.plan_event_id
        ) {
          throw new RuntimeCommandError(
            "command_id_conflict",
            "Command id was already used with a different plan approval payload",
          );
        }
        return projectRun(durableEvents);
      }
      if (durableEvents.some((event) => event.type === "plan.approved")) {
        throw new RuntimeCommandError("plan_already_approved", "This Run plan was already approved");
      }

      const state = this.#requireRun(command.run_id, command.project_id);
      const projection = await this.#enqueue(
        state,
        () => this.#withRunControl(state.runId, async () => {
        if (state.cancelInputId !== undefined) {
          throw new RuntimeCommandError("run_cancelling", "Run cancellation is already queued");
        }
        if (state.mode !== "plan") {
          throw new RuntimeCommandError("plan_already_approved", "This Run is already in execute mode");
        }
        if (await this.#isTerminal(state.runId)) {
          throw new RuntimeCommandError("plan_not_approvable", "A terminal Run plan cannot be approved");
        }
        const currentEvents = await this.#ledger.list(state.runId);
        const current = projectRun(currentEvents);
        if (current.status !== "awaiting_plan_approval" || current.pending_plan === undefined) {
          throw new RuntimeCommandError("plan_not_approvable", "Run has no plan awaiting approval");
        }
        if (current.pending_plan.plan_event_id !== command.plan_event_id) {
          throw new RuntimeCommandError(
            "plan_revision_mismatch",
            "Approval does not match the current plan revision",
          );
        }
        const approvedRevisionIndex = currentEvents.findIndex(
          (event) => event.event_id === command.plan_event_id && event.type === "plan.ready",
        );
        if (approvedRevisionIndex < 0) {
          throw new RuntimeCommandError(
            "plan_revision_mismatch",
            "Approval does not match an available plan revision",
          );
        }
        const laterTodoMutation = [...currentEvents.slice(approvedRevisionIndex + 1)]
          .reverse()
          .find((event) => isTodoMutationEventType(event.type));
        if (laterTodoMutation !== undefined) {
          // A process may stop after committing todo.* but before committing
          // the replacement plan.ready. Repair that crash window before
          // refusing the stale approval, so the caller can retry against the
          // new optimistic-lock revision without another Todo edit.
          const todos = projectTodos(currentEvents);
          const data = PlanReadyDataSchema.parse({
            todo_ids: todos.items.map(({ todo_id: todoId }) => todoId),
            todo_count: todos.items.length,
          });
          const refreshed = await this.#append(state, {
            type: "plan.ready",
            summary: "Updated plan is ready for approval",
            idempotency_key: `${state.runId}:plan.refresh:${command.plan_event_id}:${laterTodoMutation.event_id}`,
            caused_by_event_id: laterTodoMutation.event_id,
            data,
          });
          state.pendingPlan = { planEventId: refreshed.event_id, todoIds: data.todo_ids };
          throw new RuntimeCommandError(
            "plan_revision_mismatch",
            "Todo changes superseded the requested plan revision",
          );
        }
        const approved = await this.#append(state, {
          type: "plan.approved",
          summary: "Plan approved for execution",
          idempotency_key: idempotencyKey,
          caused_by_event_id: command.plan_event_id,
          data: PlanApprovedDataSchema.parse({
            plan_event_id: command.plan_event_id,
            todo_ids: current.pending_plan.todo_ids,
            approved_by: "user",
          }),
        });
        state.mode = "execute";
        delete state.pendingPlan;
        const after = await this.#ledger.list(state.runId);
        const result = projectRun(after);
        if (approved.type !== "plan.approved" || result.mode !== "execute") {
          throw new RuntimeCommandError("plan_approval_invariant", "Plan approval did not enter execute mode");
        }
          return result;
        }),
      );
      void this.#enqueue(state, () => (
        this.#codeGraph !== undefined
        && state.workspace.capabilities.index
        && state.baseGraph === undefined
          ? this.#bootstrapRun(state)
          : this.#continueRun(state)
      ));
      return projection;
    });
  }

  async readTodos(runIdValue: string, projectIdValue: string): Promise<TodoList> {
    const runId = IdentifierSchema.parse(runIdValue);
    const projectId = IdentifierSchema.parse(projectIdValue);
    const events = await this.#ledger.list(runId);
    assertRunBelongsToProject(events, runId, projectId);
    return projectTodos(events);
  }

  async writeTodo(inputValue: UserTodoWriteCommand): Promise<TodoMutationResult> {
    const commandId = IdentifierSchema.parse(inputValue.command_id);
    const projectId = IdentifierSchema.parse(inputValue.project_id);
    const runId = IdentifierSchema.parse(inputValue.run_id);
    if (inputValue.updated_by !== "user") {
      throw new RuntimeCommandError("todo_actor_invalid", "External Todo commands must be user-authored");
    }
    const input = TodoWriteInputSchema.parse(inputValue.input);
    const todoIdempotencyKey = `command:${sha256(commandId)}:todo.write`;
    const operation = async (): Promise<TodoMutationResult> => {
      const events = await this.#ledger.list(runId);
      assertRunBelongsToProject(events, runId, projectId);
      const before = projectRun(events);
      const existingCommand = events.find((event) => event.idempotency_key === todoIdempotencyKey);
      const scope = {
        projectId,
        runId,
        ...(events[0]?.session_id === undefined ? {} : { sessionId: events[0].session_id }),
        updatedBy: "user" as const,
        idempotencyKey: todoIdempotencyKey,
      };
      if (existingCommand !== undefined) {
        // Lost-response retries must replay the durable mutation even if the
        // Run became terminal afterward. TodoDomainService still verifies the
        // payload digest, so a reused command id cannot bypass conflict checks.
        const replayed = await this.#todos.write(scope, input);
        if (
          before.status === "awaiting_plan_approval"
          && !before.input_queue.pending.some((item) => item.kind === "cancel")
          && this.#runs.get(runId)?.cancelInputId === undefined
        ) {
          await this.#ensurePlanReadyAfterTodo(events, replayed, commandId);
        }
        return replayed;
      }
      if (
        before.input_queue.pending.some((item) => item.kind === "cancel")
        || this.#runs.get(runId)?.cancelInputId !== undefined
      ) {
        throw new RuntimeCommandError("run_cancelling", "Run cancellation is already queued");
      }
      if (isTerminalProjectionStatus(before.status)) {
        throw new RuntimeCommandError("run_terminal", "A terminal Run Todo list cannot be changed");
      }
      if (before.status === "interrupted" || before.status === "needs_manual_review") {
        throw new RuntimeCommandError(
          "run_not_mutable",
          "Todo changes are unavailable while the Run requires recovery or manual review",
        );
      }
      const mutation = await this.#todos.write({
        ...scope,
      }, input);
      if (before.status === "awaiting_plan_approval") {
        await this.#ensurePlanReadyAfterTodo(events, mutation, commandId);
      }
      return mutation;
    };
    const active = this.#runs.get(runId);
    return active === undefined
      ? operation()
      : this.#enqueue(active, () => this.#withRunControl(runId, operation));
  }

  async readTeam(runIdValue: string, projectIdValue: string): Promise<TeamReadResponse> {
    const runId = IdentifierSchema.parse(runIdValue);
    const projectId = IdentifierSchema.parse(projectIdValue);
    const events = await this.#ledger.list(runId);
    assertRunBelongsToProject(events, runId, projectId);
    return TeamReadResponseSchema.parse({ team: await this.#teams.read(runId) });
  }

  async createTeam(
    runIdValue: string,
    projectIdValue: string,
    requestValue: CreateTeamRequest,
  ): Promise<TeamMutationResult> {
    const request = CreateTeamRequestSchema.parse(requestValue);
    assertExternalTeamCommandId(request.command_id);
    const runId = IdentifierSchema.parse(runIdValue);
    const projectId = IdentifierSchema.parse(projectIdValue);
    return this.#withRunControl(runId, async () => {
      const before = await this.#ledger.list(runId);
      assertRunBelongsToProject(before, runId, projectId);
      const sessionId = before[0]?.session_id;
      const scope: TeamCommandScope = {
        projectId,
        runId,
        ...(sessionId === undefined ? {} : { sessionId }),
        actor: { kind: "user" },
      };
      const projection = projectRun(before);
      const runningIds = new Set(
        projection.subagents.items
          .filter(({ status }) => status === "running")
          .map(({ link }) => link.subagent_id),
      );
      const runningStarted = before.flatMap((event) => {
        if (event.type !== "subagent.started") return [];
        const parsed = SubagentStartedDataSchema.safeParse(event.data);
        return parsed.success && runningIds.has(parsed.data.link.subagent_id) ? [parsed.data] : [];
      });
      await this.#teams.createWithRunningMembers(scope, request.command_id, runningStarted);
      const after = await this.#ledger.list(runId);
      const team = await this.#teams.read(runId);
      if (team === undefined) throw new TeamDomainError("team_not_found", "Team creation did not replay");
      return teamCreateMutationResult(request.command_id, before, after, team);
    });
  }

  async writeTeamTask(
    runIdValue: string,
    projectIdValue: string,
    requestValue: TeamTaskWriteRequest,
  ): Promise<TeamMutationResult> {
    const request = TeamTaskWriteRequestSchema.parse(requestValue);
    return this.#executeTeamCommand(
      runIdValue,
      projectIdValue,
      request.command_id,
      { kind: "user" },
      teamTaskCommand(request.command_id, request.input),
    );
  }

  async writeTeamTaskAsMember(
    runIdValue: string,
    projectIdValue: string,
    subagentIdValue: string,
    requestValue: TeamTaskWriteRequest,
  ): Promise<TeamMutationResult> {
    const request = TeamTaskWriteRequestSchema.parse(requestValue);
    const subagentId = IdentifierSchema.parse(subagentIdValue);
    return this.#executeTeamCommand(
      runIdValue,
      projectIdValue,
      request.command_id,
      { kind: "member", subagent_id: subagentId },
      teamTaskCommand(request.command_id, request.input),
    );
  }

  async sendTeamMailbox(
    runIdValue: string,
    projectIdValue: string,
    requestValue: TeamMailboxSendRequest,
  ): Promise<TeamMutationResult> {
    const request = TeamMailboxSendRequestSchema.parse(requestValue);
    return this.#executeTeamCommand(runIdValue, projectIdValue, request.command_id, { kind: "user" }, {
      command_id: request.command_id,
      operation: "deliver_mailbox",
      message_id: `team-message:${sha256(request.command_id)}`,
      ...request.input,
    });
  }

  async sendTeamMailboxAsMember(
    runIdValue: string,
    projectIdValue: string,
    subagentIdValue: string,
    requestValue: TeamMailboxSendRequest,
  ): Promise<TeamMutationResult> {
    const request = TeamMailboxSendRequestSchema.parse(requestValue);
    const subagentId = IdentifierSchema.parse(subagentIdValue);
    return this.#executeTeamCommand(
      runIdValue,
      projectIdValue,
      request.command_id,
      { kind: "member", subagent_id: subagentId },
      {
        command_id: request.command_id,
        operation: "deliver_mailbox",
        message_id: `team-message:${sha256(request.command_id)}`,
        ...request.input,
      },
    );
  }

  async claimTeamMailbox(
    runIdValue: string,
    projectIdValue: string,
    requestValue: TeamMailboxClaimRequest,
  ): Promise<TeamMutationResult> {
    const request = TeamMailboxClaimRequestSchema.parse(requestValue);
    return this.#executeTeamCommand(runIdValue, projectIdValue, request.command_id, { kind: "user" }, {
      command_id: request.command_id,
      operation: "claim_mailbox",
      message_id: request.input.message_id,
    });
  }

  async claimTeamMailboxAsMember(
    runIdValue: string,
    projectIdValue: string,
    subagentIdValue: string,
    requestValue: TeamMailboxClaimRequest,
  ): Promise<TeamMutationResult> {
    const request = TeamMailboxClaimRequestSchema.parse(requestValue);
    const subagentId = IdentifierSchema.parse(subagentIdValue);
    return this.#executeTeamCommand(
      runIdValue,
      projectIdValue,
      request.command_id,
      { kind: "member", subagent_id: subagentId },
      { command_id: request.command_id, operation: "claim_mailbox", message_id: request.input.message_id },
    );
  }

  async heartbeatTeamMember(
    runIdValue: string,
    projectIdValue: string,
    subagentIdValue: string,
    requestValue: TeamHeartbeatRequest,
  ): Promise<TeamMutationResult> {
    const request = TeamHeartbeatRequestSchema.parse(requestValue);
    const subagentId = IdentifierSchema.parse(subagentIdValue);
    return this.#executeTeamCommand(
      runIdValue,
      projectIdValue,
      request.command_id,
      { kind: "member", subagent_id: subagentId },
      { command_id: request.command_id, operation: "heartbeat", subagent_id: subagentId },
    );
  }

  async expireTeamMembers(
    runIdValue: string,
    projectIdValue: string,
    requestValue: TeamSweepLostMembersRequest,
  ): Promise<TeamMutationResult> {
    const request = TeamSweepLostMembersRequestSchema.parse(requestValue);
    assertExternalTeamCommandId(request.command_id);
    const runId = IdentifierSchema.parse(runIdValue);
    const projectId = IdentifierSchema.parse(projectIdValue);
    return this.#withRunControl(runId, async () => {
      const before = await this.#ledger.list(runId);
      assertRunBelongsToProject(before, runId, projectId);
      const sessionId = before[0]?.session_id;
      const team = await this.#teams.expireMembers({
        projectId,
        runId,
        ...(sessionId === undefined ? {} : { sessionId }),
        actor: { kind: "user" },
      }, request.command_id);
      const after = await this.#ledger.list(runId);
      return teamSweepMutationResult(request.command_id, before, after, team);
    });
  }

  async #executeTeamCommand(
    runIdValue: string,
    projectIdValue: string,
    commandId: string,
    actor: TeamCommandScope["actor"],
    command: Parameters<TeamDomainService["execute"]>[1],
  ): Promise<TeamMutationResult> {
    assertExternalTeamCommandId(commandId);
    const runId = IdentifierSchema.parse(runIdValue);
    const projectId = IdentifierSchema.parse(projectIdValue);
    return this.#withRunControl(runId, async () => {
      const before = await this.#ledger.list(runId);
      assertRunBelongsToProject(before, runId, projectId);
      const sessionId = before[0]?.session_id;
      const team = await this.#teams.execute({
        projectId,
        runId,
        ...(sessionId === undefined ? {} : { sessionId }),
        actor,
      }, command);
      const after = await this.#ledger.list(runId);
      return teamMutationResult(commandId, before, after, team);
    });
  }

  async remember(runIdValue: string, candidate: MemoryCandidate): Promise<MemoryRememberResult> {
    const runId = IdentifierSchema.parse(runIdValue);
    const events = await this.#ledger.list(runId);
    const first = events[0];
    if (first === undefined) throw new RuntimeCommandError("run_not_found", "Run is unavailable");
    if (isTerminalProjectionStatus(projectRun(events).status)) {
      throw new RuntimeCommandError("run_terminal", "A terminal Run cannot accept new memory");
    }
    const operation = () => this.#memory.remember({
      projectId: first.project_id,
      runId,
      ...(first.session_id === undefined ? {} : { sessionId: first.session_id }),
      candidate,
    });
    const active = this.#runs.get(runId);
    return active === undefined ? operation() : this.#enqueue(active, operation);
  }

  async recall(
    runIdValue: string,
    query: string,
    budget?: MemoryRecallBudget,
  ): Promise<MemoryRecallResult> {
    const runId = IdentifierSchema.parse(runIdValue);
    const events = await this.#ledger.list(runId);
    const first = events[0];
    if (first === undefined) throw new RuntimeCommandError("run_not_found", "Run is unavailable");
    if (isTerminalProjectionStatus(projectRun(events).status)) {
      throw new RuntimeCommandError("run_terminal", "A terminal Run cannot append recall evidence");
    }
    return this.#memory.recall({
      projectId: first.project_id,
      runId,
      ...(first.session_id === undefined ? {} : { sessionId: first.session_id }),
      query,
      budget: budget ?? this.#retrievalBudget,
    });
  }

  async #ensurePlanReadyAfterTodo(
    eventsBeforeMutation: readonly SessionEvent[],
    mutation: TodoMutationResult,
    commandId: string,
  ): Promise<void> {
    const first = eventsBeforeMutation[0];
    if (first === undefined) {
      throw new RuntimeCommandError("run_not_found", "Run is unavailable");
    }
    const todos = await this.#todos.read(first.run_id);
    const data = PlanReadyDataSchema.parse({
      todo_ids: todos.items.map(({ todo_id: todoId }) => todoId),
      todo_count: todos.items.length,
    });
    const ready = await this.#appendTodoProposal({
      type: "plan.ready",
      project_id: first.project_id,
      run_id: first.run_id,
      ...(first.session_id === undefined ? {} : { session_id: first.session_id }),
      attempt: 0,
      summary: "Updated plan is ready for approval",
      artifact_refs: [],
      idempotency_key: `command:${sha256(commandId)}:plan.ready`,
      caused_by_event_id: mutation.event_id,
      data,
    });
    const active = this.#runs.get(first.run_id);
    if (active !== undefined) {
      active.pendingPlan = { planEventId: ready.event_id, todoIds: data.todo_ids };
    }
  }

  async approve(commandValue: ApprovalCommand): Promise<RunProjection> {
    const command = ApprovalCommandSchema.parse(commandValue);
    if (command.type !== "approve") {
      throw new RuntimeCommandError("command_type_mismatch", "approve() requires type=approve");
    }
    const signature = commandSignature(command);
    return this.#runCommand(command.command_id, signature, async () => {
      const state = this.#requireRun(command.run_id, command.project_id);
      return this.#enqueue(state, () => this.#approveLocked(state, command));
    });
  }

  async #approveLocked(
    state: RunState,
    command: ApprovalCommand,
    source: "user" | "policy" = "user",
  ): Promise<RunProjection> {
    if (state.cancelInputId !== undefined) {
      throw new RuntimeCommandError("run_cancelling", "Run cancellation is already queued");
    }
    if (state.stopped) return this.getProjection(state.runId);
    const pending = this.#requirePending(state, command);
    const boundPending = BoundPendingApprovalSchema.safeParse(pending.pendingApproval);
    const preview = pending.pendingApproval.preview;
    if (Date.parse(preview.expires_at) <= this.#now().getTime()) {
      return this.#withRunControl(state.runId, async () => {
        this.#assertControlMutationAllowedLocked(state, await this.#ledger.list(state.runId));
        if (source === "user") {
          await this.#append(state, {
            type: "approval.expired",
            summary: "Patch approval expired before use",
            action_id: preview.action_id,
            data: boundPending.success
              ? ApprovalExpiredDataSchema.parse({
                  approval_id: pending.pendingApproval.approval_id,
                  action_id: preview.action_id,
                  action_digest: boundPending.data.action_digest,
                  expired_at: this.#now().toISOString(),
                })
              : { approval_id: pending.pendingApproval.approval_id },
          });
        } else {
          await this.#append(state, {
            type: "action.rejected",
            summary: "Automatic patch commit rejected because its preview expired",
            action_id: preview.action_id,
            data: { code: "patch_preview_expired" },
          });
        }
        delete state.pendingPatch;
        await this.#appendTerminalLocked(
          state,
          "run.failed",
          source === "user"
            ? "The one-time patch approval expired"
            : "The patch preview expired before automatic commit",
          { code: source === "user" ? "approval_expired" : "patch_preview_expired" },
        );
        return this.getProjection(state.runId);
      });
    }

    if (!boundPending.success) {
      return this.#withRunControl(state.runId, async () => {
        this.#assertControlMutationAllowedLocked(state, await this.#ledger.list(state.runId));
        delete state.pendingPatch;
        await this.#appendTerminalLocked(
          state,
          "run.failed",
          "Legacy approval is not bound to the effective policy",
          { code: "approval_binding_unavailable" },
        );
        return this.getProjection(state.runId);
      });
    }

    if (await this.#requeueApprovalForStaleCodeBase(state, pending, boundPending.data)) {
      return this.getProjection(state.runId);
    }

    const patchInput = PatchInputSchema.parse(pending.previewCall.arguments);
    const commitCall: ToolCall = {
      action_id: preview.action_id,
      tool_name: "commit_patch",
      arguments: {
        ...patchInput,
        base_hash: preview.base_hash,
        patch_hash: preview.patch_hash,
      },
    };
    const actualBinding = await this.#patchActionBinding(state, commitCall, preview.scope);
    if (actualBinding.actionDigest !== boundPending.data.action_digest) {
      return this.#withRunControl(state.runId, async () => {
        this.#assertControlMutationAllowedLocked(state, await this.#ledger.list(state.runId));
        if (source === "user") {
          await this.#appendApprovalDenied(state, {
            pending: boundPending.data,
            reason: "digest_mismatch",
            explanation: "The patch target or action changed after approval was requested",
          });
        } else {
          await this.#append(state, {
            type: "action.rejected",
            summary: "Automatic patch commit rejected because its canonical action changed",
            action_id: preview.action_id,
            data: {
              code: "action_digest_mismatch",
              action_digest: boundPending.data.action_digest,
              actual_action_digest: actualBinding.actionDigest,
            },
          });
        }
        delete state.pendingPatch;
        await this.#appendTerminalLocked(
          state,
          "run.failed",
          source === "user"
            ? "The approval did not match the actual patch action"
            : "The policy-authorized patch did not match the actual patch action",
          { code: source === "user" ? "approval_digest_mismatch" : "action_digest_mismatch" },
        );
        return this.getProjection(state.runId);
      });
    }

    const policyBinding: ToolExecutionBinding = {
      kind: "policy-allow",
      actionDigest: actualBinding.actionDigest,
      policyDigest: state.permissionPolicy.policy_digest,
      canonicalTargetDigest: actualBinding.canonicalTargetDigest,
    };
    const executionBinding = await this.#withRunControl<ToolExecutionBinding | undefined>(
      state.runId,
      async () => {
        this.#assertControlMutationAllowedLocked(state, await this.#ledger.list(state.runId));
        if (source !== "user") {
          delete state.pendingPatch;
          return policyBinding;
        }
        try {
          const token = this.#approvalTokenStore.issue({
            approvalId: boundPending.data.approval_id,
            projectId: state.projectId,
            runId: state.runId,
            actionId: preview.action_id,
            actionDigest: actualBinding.actionDigest,
            policyDigest: state.permissionPolicy.policy_digest,
            scope: preview.scope,
            expiresAt: preview.expires_at,
          });
          this.#approvalTokenStore.consume({
            tokenId: token.token_id,
            approvalId: boundPending.data.approval_id,
            projectId: state.projectId,
            runId: state.runId,
            actionId: preview.action_id,
            actionDigest: actualBinding.actionDigest,
            policyDigest: state.permissionPolicy.policy_digest,
            scope: preview.scope,
          });
          const consumedAt = this.#now().toISOString();
          const grant = ApprovalBoundGrantSchema.parse({
            approval_id: boundPending.data.approval_id,
            action_id: preview.action_id,
            token_id: token.token_id,
            action_digest: actualBinding.actionDigest,
            policy_digest: state.permissionPolicy.policy_digest,
            base_hash: preview.base_hash,
            patch_hash: preview.patch_hash,
            scope: preview.scope,
            expires_at: preview.expires_at,
            granted_at: token.issued_at,
            consumed_at: consumedAt,
            outcome: "allowed-once",
            single_use: true,
          });
          await this.#append(state, {
            type: "approval.granted",
            summary: "One-time approval granted and atomically consumed",
            action_id: preview.action_id,
            data: { approval: grant },
          });
          delete state.pendingPatch;
          return {
            kind: "approved-once",
            approvalId: grant.approval_id,
            approvalTokenId: grant.token_id,
            actionDigest: grant.action_digest,
            policyDigest: grant.policy_digest,
            canonicalTargetDigest: actualBinding.canonicalTargetDigest,
          };
        } catch (error) {
          const denial = approvalTokenDenial(error);
          await this.#appendApprovalDenied(state, {
            pending: boundPending.data,
            reason: denial.reason,
            explanation: denial.explanation,
          });
          delete state.pendingPatch;
          await this.#appendTerminalLocked(
            state,
            "run.failed",
            denial.explanation,
            { code: denial.code },
          );
          return undefined;
        }
      },
    );
    if (executionBinding === undefined) return this.getProjection(state.runId);
    const executed = await this.#executeTool(state, commitCall, executionBinding);
    if (executed === undefined) return this.getProjection(state.runId);
    state.observations.push(observationWithEligibleEvidence(executed.observation, executed.event));
    if (executed.raw.status !== "success") {
      if (executed.raw.code === "stale_base") {
        await this.#append(state, {
          type: "action.stale",
          summary: "Approved patch was rejected because the base hash changed",
          action_id: preview.action_id,
          artifact_refs: executed.artifactRefs,
          data: { receipt: executed.receipt },
        });
      }
      if (!state.stopped) {
        await this.#fail(state, executed.raw.code, executed.raw.summary);
      }
      return this.getProjection(state.runId);
    }

    if (executed.walRecord === undefined || executed.walTransactionId === undefined) {
      throw new ActionCommitInterruptedError(
        "A successful commit_patch did not cross the Action WAL applied boundary",
      );
    }
    const patchEvent = await this.#append(state, {
      type: "patch.applied",
      summary: executed.raw.summary,
      idempotency_key: `action-wal:${executed.walTransactionId}:patch.applied`,
      action_id: preview.action_id,
      caused_by_event_id: executed.event.event_id,
      artifact_refs: executed.artifactRefs,
      data: {
        receipt_id: executed.receipt.receipt_id,
        preview_id: preview.preview_id,
        base_hash: preview.base_hash,
        patch_hash: preview.patch_hash,
        scope: preview.scope,
        wal_id: executed.walTransactionId,
        verified: true,
      },
    });
    state.lastPatchEventId = patchEvent.event_id;
    await this.#injectActionFault("after_patch_event_before_committed");
    await this.#actionWal.advance({
      runId: state.runId,
      actionId: preview.action_id,
      phase: "committed",
      eventId: patchEvent.event_id,
      receiptId: executed.receipt.receipt_id,
    });
    const verifiedEvent = await this.#append(state, {
      type: "action.verified",
      summary: "Applied patch matches its approved hash and durable ledger fact",
      idempotency_key: `action-wal:${executed.walTransactionId}:verified`,
      action_id: preview.action_id,
      patch_event_id: patchEvent.event_id,
      caused_by_event_id: patchEvent.event_id,
      data: {
        wal_id: executed.walTransactionId,
        patch_hash: preview.patch_hash,
        scope: preview.scope,
        verified: true,
      },
    });
    await this.#injectActionFault("after_verified_event_before_verified");
    await this.#actionWal.advance({
      runId: state.runId,
      actionId: preview.action_id,
      phase: "verified",
      eventId: verifiedEvent.event_id,
    });
    if (state.stopped) return this.getProjection(state.runId);
    if (this.#codeGraph !== undefined && state.baseGraph !== undefined) {
      try {
        const resultGraph = await this.#captureGraphSnapshot(state, "Result graph snapshot created");
        const delta = GraphDeltaSchema.parse(await abortable(
          this.#codeGraph.createDelta({
            base: state.baseGraph,
            result: resultGraph,
            patchEventId: patchEvent.event_id,
            signal: state.abortController.signal,
          }),
          state.abortController.signal,
        ));
        if (
          delta.project_id !== state.projectId
          || delta.base_snapshot_id !== state.baseGraph.snapshot_id
          || delta.result_snapshot_id !== resultGraph.snapshot_id
          || delta.patch_event_id !== patchEvent.event_id
        ) {
          throw new Error("CodeGraph delta did not match the active project, snapshots, and patch event");
        }
        const deltaArtifact = await this.#artifacts.put({
          projectId: state.projectId,
          runId: state.runId,
          kind: "graph_delta",
          mimeType: "application/json",
          content: JSON.stringify(delta, null, 2),
        });
        await this.#append(state, {
          type: "graph.delta_created",
          summary: "Architecture delta created",
          patch_event_id: patchEvent.event_id,
          graph_delta_id: delta.graph_delta_id,
          artifact_refs: [deltaArtifact],
          data: {
            graph_delta_id: delta.graph_delta_id,
            base_snapshot_id: delta.base_snapshot_id,
            result_snapshot_id: delta.result_snapshot_id,
          },
        });
        const gitContext = await this.#captureCodeIntelGitContext(state);
        await this.#appendCodeIntelUpdated(state, {
          phase: "post_patch",
          gitContext,
          baseSnapshotId: state.baseGraph.snapshot_id,
          resultSnapshotId: resultGraph.snapshot_id,
          changedFiles: preview.scope,
          changedSymbols: changedSymbolsFromGraphDelta(delta),
          patchEventId: patchEvent.event_id,
          graphDeltaId: delta.graph_delta_id,
        });
        // The Runtime's own approved patch is now part of the comparison
        // point for the next approval. Only subsequent external Git changes
        // can invalidate that replacement baseline.
        state.codeIntelGitContext = gitContext;
        state.baseGraph = resultGraph;
      } catch (error) {
        if (!state.stopped) {
          await this.#fail(state, "graph_delta_failed", publicError(error));
        }
        return this.getProjection(state.runId);
      }
    }
    if (!state.stopped) await this.#continueRun(state);
    return this.getProjection(state.runId);
  }

  async reject(commandValue: ApprovalCommand): Promise<RunProjection> {
    const command = ApprovalCommandSchema.parse(commandValue);
    if (command.type !== "reject") {
      throw new RuntimeCommandError("command_type_mismatch", "reject() requires type=reject");
    }
    const signature = commandSignature(command);
    return this.#runCommand(command.command_id, signature, async () => {
      const state = this.#requireRun(command.run_id, command.project_id);
      return this.#enqueue(state, () => this.#rejectLocked(state, command));
    });
  }

  async #rejectLocked(state: RunState, command: ApprovalCommand): Promise<RunProjection> {
    return this.#withRunControl(state.runId, async () => {
      const events = await this.#ledger.list(state.runId);
      this.#assertControlMutationAllowedLocked(state, events);
      const pending = this.#requirePending(state, command);
      const bound = BoundPendingApprovalSchema.safeParse(pending.pendingApproval);
      if (bound.success) {
        await this.#appendApprovalDenied(state, {
          pending: bound.data,
          reason: "rejected",
          explanation: command.reason ?? "User rejected the patch",
        });
      } else {
        await this.#append(state, {
          type: "approval.denied",
          summary: command.reason ?? "User rejected the patch",
          action_id: pending.pendingApproval.action_id,
          data: { approval_id: pending.pendingApproval.approval_id },
        });
      }
      delete state.pendingPatch;
      await this.#appendTerminalLocked(
        state,
        "run.cancelled",
        "Run cancelled after patch rejection",
        { code: "approval_denied" },
      );
      return this.getProjection(state.runId);
    });
  }

  async stop(commandValue: StopRunCommand): Promise<RunProjection> {
    const command = StopRunCommandSchema.parse(commandValue);
    const signature = commandSignature(command);
    return this.#runCommand(command.command_id, signature, async () => {
      const state = this.#requireRun(command.run_id, command.project_id);
      state.modelImages.length = 0;
      state.stopped = true;
      state.abortController.abort(new Error("Run stopped by user"));
      return this.#enqueue(state, async () => {
        delete state.pendingPatch;
        await this.#terminal(state, "run.cancelled", command.reason ?? "Run stopped by user", { code: "user_stop" });
        return this.getProjection(state.runId);
      });
    });
  }

  async getProjection(runId: string): Promise<RunProjection> {
    const events = await this.#ledger.list(runId);
    if (events.length === 0) {
      throw new RuntimeCommandError("run_not_found", "Run is unavailable");
    }
    return projectRun(events);
  }

  async listSubagents(runId: string, projectId: string): Promise<SubagentListProjection> {
    const parent = this.#requireRun(runId, projectId);
    return this.#listSubagents(parent, ListSubagentsInputSchema.parse({}));
  }

  async sendSubagentMessage(
    runId: string,
    projectId: string,
    inputValue: SendSubagentMessageInput,
  ): Promise<SubagentListProjection> {
    const parent = this.#requireRun(runId, projectId);
    await this.#sendSubagentMessage(parent, SendSubagentMessageInputSchema.parse(inputValue));
    return this.#listSubagents(parent, ListSubagentsInputSchema.parse({}));
  }

  async interruptSubagent(
    runId: string,
    projectId: string,
    inputValue: InterruptSubagentInput,
  ): Promise<SubagentResult> {
    const parent = this.#requireRun(runId, projectId);
    return this.#interruptSubagent(parent, InterruptSubagentInputSchema.parse(inputValue));
  }

  subscribe(runId: string, listener: (event: SessionEvent) => void): () => void {
    return this.#ledger.subscribe((event) => {
      if (event.run_id === runId) listener(event);
    });
  }

  subscribeLive(runId: string, listener: (activity: LivePublicActivity) => void): () => void {
    const listeners = this.#liveListeners.get(runId) ?? new Set<(activity: LivePublicActivity) => void>();
    this.#liveListeners.set(runId, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#liveListeners.delete(runId);
    };
  }

  listLiveActivities(runId: string, afterSequence = 0): readonly LivePublicActivity[] {
    return (this.#liveActivities.get(runId) ?? [])
      .filter((activity) => activity.sequence > afterSequence)
      .map((activity) => ({ ...activity }));
  }

  subscribeModelSurface(runId: string, listener: (event: ModelSurfaceEvent) => void): () => void {
    const listeners = this.#modelSurfaceListeners.get(runId) ?? new Set<(event: ModelSurfaceEvent) => void>();
    this.#modelSurfaceListeners.set(runId, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#modelSurfaceListeners.delete(runId);
    };
  }

  listModelSurface(runId: string, afterCursor = 0): readonly ModelSurfaceEvent[] {
    return (this.#modelSurfaceEvents.get(runId) ?? [])
      .filter((event) => event.cursor > afterCursor)
      .map((event) => ({ ...event }));
  }

  async replay(runId: string): Promise<RunProjection> {
    // Replay is intentionally only Event -> Projection. No model/tool dependency is consulted.
    return projectRun(await this.#ledger.list(runId));
  }

  async replayAt(input: ReplaySnapshotRequest): Promise<ReplaySnapshot> {
    return replaySnapshotFromEvents(await this.#ledger.list(input.run_id), input);
  }

  async replayDiff(input: ReplayDiffQuery): Promise<ReplayDiff> {
    // Both endpoints are derived from this one stable, fully validated ledger
    // read, so a concurrent append cannot give the two snapshots different heads.
    return replayDiffFromEvents(await this.#ledger.list(input.run_id), input);
  }

  async reconcileActions(
    inputValue: SessionRunLocator & { workspace: WorkspaceHandle },
  ): Promise<ActionReconciliationResult> {
    const input = parseSessionRunLocator(inputValue);
    const workspace = WorkspaceHandleSchema.parse(inputValue.workspace);
    if (workspace.project_id !== input.projectId) {
      throw new RuntimeCommandError("workspace_project_mismatch", "WorkspaceHandle belongs to another project");
    }
    const initialEvents = await this.#ledger.list(input.runId);
    assertRunBelongsToSession(initialEvents, input);
    const records = await this.#actionWal.list(input.runId);
    const latest = latestWalRecords(records);
    if (latest.length === 0) {
      return { runId: input.runId, reconciledActionIds: [], abortedActionIds: [], divergedActionIds: [] };
    }

    const scope = await this.#openMaintenanceScope(input);
    const result: ActionReconciliationResult = {
      runId: input.runId,
      reconciledActionIds: [],
      abortedActionIds: [],
      divergedActionIds: [],
    };
    try {
      for (const durable of latest) {
        const transactionId = records.find(
          (record) => record.action_id === durable.action_id && record.phase === "prepare",
        )?.wal_id;
        if (transactionId === undefined) {
          throw new ActionWalError(
            "action_wal_corrupt",
            `Action ${durable.action_id} has no prepare record`,
          );
        }
        if (durable.phase === "verified" || durable.phase === "aborted") {
          await this.#closeRecoveredAttemptIfNeeded(
            scope.state,
            durable,
            transactionId,
            workspace,
          );
          continue;
        }

        const bindingFailure = await walWorkspaceBindingFailure(durable, workspace);
        if (bindingFailure !== undefined) {
          await this.#markActionDiverged(scope.state, durable, transactionId, bindingFailure, []);
          result.divergedActionIds.push(durable.action_id);
          continue;
        }

        let disk: WalDiskState;
        try {
          disk = await inspectWalTargets(durable, workspace);
        } catch (error) {
          await this.#markActionDiverged(
            scope.state,
            durable,
            transactionId,
            "target_unavailable",
            [],
            publicError(error),
          );
          result.divergedActionIds.push(durable.action_id);
          continue;
        }

        if (durable.phase === "prepare" && disk.classification === "before") {
          const attempt = await this.#recoveryLedger.startAttempt({
            project_id: durable.project_id,
            run_id: durable.run_id,
            action_id: durable.action_id,
            recipe_id: "replay_missing_event",
            automatic: true,
          });
          if (attempt.state === "escalated") {
            await this.#appendActionDivergedEvent(
              scope.state,
              durable,
              transactionId,
              "automatic_recovery_exhausted",
              disk.hashes,
            );
            result.divergedActionIds.push(durable.action_id);
            continue;
          }
          try {
            await this.#appendScoped(scope.state, {
              type: "action.reconciled",
              summary: "Prepared patch had no filesystem effect and was closed safely",
              idempotency_key: `action-wal:${transactionId}:not-applied`,
              action_id: durable.action_id,
              data: {
                wal_id: transactionId,
                outcome: "not_applied",
                recovered: true,
                target_paths: durable.targets.map((target) => target.target_path),
              },
            });
            await this.#actionWal.advance({
              runId: durable.run_id,
              actionId: durable.action_id,
              phase: "aborted",
              recovered: true,
              reason: "filesystem still matches the before image",
            });
            await this.#recoveryLedger.finishAttempt({
              recovery_id: attempt.recovery_id,
              state: "succeeded",
            });
            result.abortedActionIds.push(durable.action_id);
          } catch (error) {
            await this.#finishRecoveryFailure(attempt.recovery_id, error);
            throw error;
          }
          continue;
        }

        if (disk.classification !== "after") {
          await this.#markActionDiverged(
            scope.state,
            durable,
            transactionId,
            "filesystem_hash_mismatch",
            disk.hashes,
          );
          result.divergedActionIds.push(durable.action_id);
          continue;
        }

        const attempt = await this.#recoveryLedger.startAttempt({
          project_id: durable.project_id,
          run_id: durable.run_id,
          action_id: durable.action_id,
          recipe_id: "replay_missing_event",
          automatic: true,
        });
        if (attempt.state === "escalated") {
          await this.#appendActionDivergedEvent(
            scope.state,
            durable,
            transactionId,
            "automatic_recovery_exhausted",
            disk.hashes,
          );
          result.divergedActionIds.push(durable.action_id);
          continue;
        }
        try {
          let current = durable;
          if (current.phase === "prepare") {
            current = await this.#actionWal.advance({
              runId: current.run_id,
              actionId: current.action_id,
              phase: "applied",
              recovered: true,
            });
          }
          await this.#recoverAppliedAction(scope.state, current, transactionId);
          await this.#recoveryLedger.finishAttempt({
            recovery_id: attempt.recovery_id,
            state: "succeeded",
          });
          result.reconciledActionIds.push(durable.action_id);
        } catch (error) {
          await this.#finishRecoveryFailure(attempt.recovery_id, error);
          throw error;
        }
      }
    } finally {
      await scope.release();
    }
    return result;
  }

  async rollback(inputValue: RollbackActionInput): Promise<RunProjection> {
    const input = RollbackActionInputSchema.parse(inputValue);
    const signature = commandSignature(input);
    return this.#runCommand(input.command_id, signature, async () => {
      const events = await this.#ledger.list(input.run_id);
      if (events.length === 0) {
        throw new RuntimeCommandError("run_not_found", "Run is unavailable");
      }
      const first = events[0]!;
      if (first.project_id !== input.project_id || input.workspace.project_id !== input.project_id) {
        throw new RuntimeCommandError("workspace_project_mismatch", "Rollback workspace belongs to another project");
      }
      if (first.session_id === undefined) {
        throw new RuntimeCommandError("rollback_session_unavailable", "Rollback requires a durable Session identity");
      }
      const commandKey = `rollback-command:${sha256(input.command_id)}`;
      const commandFingerprint = sha256(stableStringify({
        run_id: input.run_id,
        action_id: input.action_id,
        force: input.force,
      }));
      const priorCommand = events.find((event) => event.idempotency_key === commandKey);
      if (priorCommand !== undefined) {
        if (priorCommand.data.command_fingerprint !== commandFingerprint) {
          throw new RuntimeCommandError(
            "command_id_conflict",
            "Command id was already used with a different rollback payload",
          );
        }
        return this.getProjection(input.run_id);
      }
      if (events.some((event) => event.type === "patch.rolled_back" && event.action_id === input.action_id)) {
        return this.getProjection(input.run_id);
      }

      const locator: SessionRunLocator = {
        sessionId: first.session_id,
        runId: input.run_id,
        projectId: input.project_id,
      };
      const scope = await this.#openMaintenanceScope(locator);
      try {
        const projection = projectRun(events);
        if (!isQuiescentProjectionStatus(projection.status)) {
          return await this.#refuseRollback(scope.state, input, commandKey, commandFingerprint, "run_not_quiescent");
        }
        if (!this.#rollbackPolicy.enabled) {
          return await this.#refuseRollback(scope.state, input, commandKey, commandFingerprint, "rollback_policy_disabled");
        }
        if (input.workspace.workspace_kind === "readonly_local") {
          return await this.#refuseRollback(scope.state, input, commandKey, commandFingerprint, "workspace_readonly");
        }
        if (
          input.workspace.workspace_kind !== "disposable_fixture"
          && (!input.force || !this.#rollbackPolicy.allowForce)
        ) {
          return await this.#refuseRollback(scope.state, input, commandKey, commandFingerprint, "force_not_allowed");
        }

        const records = await this.#actionWal.list(input.run_id);
        const durable = latestWalRecords(records).find((record) => record.action_id === input.action_id);
        const transactionId = records.find(
          (record) => record.action_id === input.action_id && record.phase === "prepare",
        )?.wal_id;
        if (durable === undefined || transactionId === undefined) {
          return await this.#refuseRollback(scope.state, input, commandKey, commandFingerprint, "action_wal_unavailable");
        }
        if (durable.phase !== "verified") {
          return await this.#refuseRollback(scope.state, input, commandKey, commandFingerprint, "action_not_verified");
        }
        const bindingFailure = await walWorkspaceBindingFailure(durable, input.workspace);
        if (bindingFailure !== undefined) {
          return await this.#refuseRollback(scope.state, input, commandKey, commandFingerprint, bindingFailure);
        }
        if (durable.targets.length !== 1) {
          return await this.#refuseRollback(
            scope.state,
            input,
            commandKey,
            commandFingerprint,
            "multi_target_rollback_unsupported",
          );
        }
        let disk: WalDiskState;
        try {
          disk = await inspectWalTargets(durable, input.workspace);
        } catch {
          return await this.#refuseRollback(
            scope.state,
            input,
            commandKey,
            commandFingerprint,
            "target_unavailable",
          );
        }
        if (disk.classification !== "after") {
          return await this.#refuseRollback(
            scope.state,
            input,
            commandKey,
            commandFingerprint,
            "target_modified_after_apply",
            disk.hashes,
          );
        }
        const target = durable.targets[0]!;
        let before: Buffer | null;
        try {
          before = await this.#actionWal.readBeforeImage({
            projectId: input.project_id,
            runId: input.run_id,
            actionId: input.action_id,
            target,
          });
        } catch {
          return await this.#refuseRollback(
            scope.state,
            input,
            commandKey,
            commandFingerprint,
            "backup_unavailable_or_corrupt",
          );
        }
        const attempt = await this.#recoveryLedger.startAttempt({
          project_id: input.project_id,
          run_id: input.run_id,
          action_id: input.action_id,
          recipe_id: "restore_from_backup",
          automatic: false,
        });
        if (attempt.state !== "started") {
          return await this.#refuseRollback(scope.state, input, commandKey, commandFingerprint, "rollback_attempt_unavailable");
        }
        let mutationAttempted = false;
        try {
          const resolvedTarget = await resolvePatchTarget(input.workspace, target.target_path);
          if (!resolvedTarget.exists) {
            throw new ActionCommitInterruptedError("Rollback target disappeared after its hash precondition");
          }
          if (target.existed) {
            if (before === null || sha256(before) !== target.before_hash) {
              throw new ActionCommitInterruptedError("Rollback before image is unavailable or corrupt");
            }
            mutationAttempted = true;
            await replaceTargetDurably(resolvedTarget.path, before);
          } else {
            mutationAttempted = true;
            await unlink(resolvedTarget.path);
            await syncParentDirectory(dirname(resolvedTarget.path));
          }
          const restored = await inspectWalTargets(durable, input.workspace);
          if (restored.classification !== "before") {
            throw new ActionCommitInterruptedError("Rollback did not restore the expected before state");
          }
          await this.#injectActionFault("after_rollback_before_event");
          const originalPatch = [...events].reverse().find(
            (event) => event.type === "patch.applied" && event.action_id === input.action_id,
          );
          const rolledBack = await this.#appendScoped(scope.state, {
            type: "patch.rolled_back",
            summary: `Rolled back ${target.target_path}`,
            idempotency_key: commandKey,
            action_id: input.action_id,
            ...(originalPatch === undefined ? {} : { patch_event_id: originalPatch.event_id }),
            data: {
              wal_id: transactionId,
              target_paths: durable.targets.map((item) => item.target_path),
              before_hashes: durable.targets.map((item) => item.before_hash),
              after_hashes: durable.targets.map((item) => item.after_hash),
              force: input.force,
              recovered: false,
              command_fingerprint: commandFingerprint,
            },
          });
          await this.#recoveryLedger.finishAttempt({
            recovery_id: attempt.recovery_id,
            state: "succeeded",
          });
          return projectRun(await this.#ledger.list(rolledBack.run_id));
        } catch (error) {
          // Once a restore syscall has started, the outcome is uncertain. Keep
          // the attempt open so startup reconciliation can classify the actual
          // before/after hashes and replay only the missing canonical event.
          if (!mutationAttempted) await this.#finishRecoveryFailure(attempt.recovery_id, error);
          throw error;
        }
      } finally {
        await scope.release();
      }
    });
  }

  async markRunInterrupted(inputValue: SessionRunLocator & { reason?: string }): Promise<RunProjection> {
    const input = parseSessionRunLocator(inputValue);
    let events = await this.#ledger.list(input.runId);
    assertRunBelongsToSession(events, input);
    let current = projectRun(events);
    if (isFinishedProjectionStatus(current.status)) return current;
    if (current.status === "interrupted") {
      if (current.subagents.active_count === 0) return current;
      const recoveryScope = await this.#openSessionScope(input);
      try {
        await this.#reconcileSubagentsAfterRestart(recoveryScope.state, events);
      } finally {
        await recoveryScope.release();
      }
      return this.getProjection(input.runId);
    }

    const scope = await this.#openSessionScope(input);
    try {
      await this.#reconcileSubagentsAfterRestart(scope.state, events);
      events = await this.#ledger.list(input.runId);
      current = projectRun(events);
      // A crash can occur after the safe-boundary consumption fact is durable
      // but before run.cancelled is appended. Consumption proves no Model or
      // Tool is still in flight in this restarted process, so repair the sole
      // missing terminal fact rather than weakening it to run.interrupted.
      const consumedCancel = [...events].reverse().find((event) => {
        if (event.type !== "user.input_consumed") return false;
        const parsed = UserInputConsumedDataSchema.safeParse(event.data);
        return parsed.success && parsed.data.kind === "cancel";
      });
      if (consumedCancel !== undefined) {
        const recoveredCancel = UserInputConsumedDataSchema.parse(consumedCancel.data);
        const queuedCancel = events.find((event) => event.event_id === recoveredCancel.queued_event_id);
        const cancelActor = queuedCancel?.type === "user.input_queued"
          ? UserInputQueuedDataSchema.parse(queuedCancel.data).input.actor
          : "user";
        await this.#appendScoped(scope.state, {
          type: "run.cancelled",
          summary: cancelActor === "parent_agent"
            ? "Child Run cancelled by parent agent"
            : "Run cancelled by user",
          idempotency_key: `${input.runId}:terminal`,
          data: {
            reason: cancelActor === "parent_agent" ? "parent_agent_cancel" : "user_cancel",
            last_sequence: consumedCancel.sequence,
          },
        });
        return this.getProjection(input.runId);
      }
      await this.#appendScoped(scope.state, {
        type: "run.interrupted",
        summary: "Run was interrupted by a Host restart",
        idempotency_key: `${input.runId}:interrupted:${events.at(-1)!.event_id}`,
        data: {
          previous_status: current.status,
          awaiting_approval: current.status === "awaiting_approval",
          reason: redactSensitiveText(inputValue.reason ?? "host_restart"),
        },
      });
    } finally {
      await scope.release();
    }
    return this.getProjection(input.runId);
  }

  async resumeRun(inputValue: ResumeInterruptedRunInput): Promise<RunProjection> {
    const locator = parseSessionRunLocator(inputValue);
    const commandId = IdentifierSchema.parse(inputValue.commandId);
    const workspace = WorkspaceHandleSchema.parse(inputValue.workspace);
    if (workspace.project_id !== locator.projectId) {
      throw new RuntimeCommandError("workspace_project_mismatch", "WorkspaceHandle belongs to another project");
    }

    let events = await this.#ledger.list(locator.runId);
    assertRunBelongsToSession(events, locator);
    const resumeKey = `command:${sha256(commandId)}:run.resumed`;
    if (events.some((event) => event.idempotency_key === resumeKey)) {
      const resumedProjection = projectRun(events);
      if (resumedProjection.subagents.active_count > 0) {
        const recoveryScope = await this.#openSessionScope(locator);
        try {
          await this.#reconcileSubagentsAfterRestart(recoveryScope.state, events);
        } finally {
          await recoveryScope.release();
        }
      }
      return this.getProjection(locator.runId);
    }
    const current = projectRun(events);
    if (current.status !== "interrupted") {
      throw new RuntimeCommandError("run_not_interrupted", "Only an interrupted Run can be resumed");
    }

    const interruptedIndex = findLastEventIndex(events, "run.interrupted");
    if (interruptedIndex < 0) {
      throw new RuntimeCommandError("run_not_interrupted", "Interrupted Run has no recovery marker");
    }
    const beforeInterruption = projectRun(events.slice(0, interruptedIndex));
    const scope = await this.#openSessionScope(locator);
    let leaseTransferred = false;
    try {
      await this.#reconcileSubagentsAfterRestart(scope.state, events);
      events = await this.#ledger.list(locator.runId);
      const recoveredCancel = beforeInterruption.input_queue.pending.find((input) => input.kind === "cancel");
      if (recoveredCancel !== undefined) {
        // Explicit resume happens in a fresh process after run.interrupted, so
        // no old Model/Tool Promise can still be in flight here. Restore only
        // the common Run shell for every prior status (including indexing and
        // running): a durable cancel wins without reissuing approval, indexing,
        // model, or tool work. Unknown external effects remain governed by the
        // Action WAL reconciliation path rather than being retried here.
        const runRecovery = await this.#loadRunRecovery(events[0]!);
        const permissionPolicy = runRecovery.version === 2 || runRecovery.version === 3 || runRecovery.version === 4 || runRecovery.version === 5
          ? runRecovery.effective_policy
          : legacyRecoveryPermissionPolicy(events, this.#defaultPermissionPolicy);
        const state = await this.#restoreRunState({
          locator,
          workspace,
          events,
          recovery: runRecovery,
          permissionPolicy,
          sessionState: scope.state,
        });
        await this.#append(state, {
          type: "run.resumed",
          summary: "Interrupted Run restored to finish a durable user cancellation",
          idempotency_key: resumeKey,
          data: {
            restored_status: beforeInterruption.status,
            interrupted_event_id: events[interruptedIndex]!.event_id,
            cancellation_pending: true,
            ...(beforeInterruption.pending_plan === undefined
              ? {}
              : { plan_event_id: beforeInterruption.pending_plan.plan_event_id }),
          },
        });
        this.#runs.set(locator.runId, state);
        leaseTransferred = true;
        state.stopped = true;
        state.abortController.abort(new Error("Run cancelled by recovered user input"));
        await this.#finalizeUserCancellation(state, recoveredCancel.input_id);
        return this.getProjection(locator.runId);
      }
      if (beforeInterruption.status === "awaiting_plan_approval" && beforeInterruption.pending_plan !== undefined) {
        const runRecovery = await this.#loadRunRecovery(events[0]!);
        const permissionPolicy = runRecovery.version === 2 || runRecovery.version === 3 || runRecovery.version === 4 || runRecovery.version === 5
          ? runRecovery.effective_policy
          : legacyRecoveryPermissionPolicy(events, this.#defaultPermissionPolicy);
        const state = await this.#restoreRunState({
          locator,
          workspace,
          events,
          recovery: runRecovery,
          permissionPolicy,
          sessionState: scope.state,
        });
        await this.#recordSandboxConfiguration(state);
        await this.#append(state, {
          type: "run.resumed",
          summary: "Interrupted plan restored and remains ready for approval",
          idempotency_key: resumeKey,
          data: {
            restored_status: "awaiting_plan_approval",
            interrupted_event_id: events[interruptedIndex]!.event_id,
            plan_event_id: beforeInterruption.pending_plan.plan_event_id,
          },
        });
        this.#runs.set(locator.runId, state);
        leaseTransferred = true;
        return this.getProjection(locator.runId);
      }
      if (beforeInterruption.status !== "awaiting_approval" || beforeInterruption.pending_approval === undefined) {
        await this.#appendScoped(scope.state, {
          type: "run.resumed",
          summary: "Interrupted Run replayed as a read-only recovery view",
          idempotency_key: resumeKey,
          data: { restored_status: "interrupted", view_only: true },
        });
        return this.getProjection(locator.runId);
      }

      const approvalEvent = [...events.slice(0, interruptedIndex)]
        .reverse()
        .find((event) => event.type === "approval.requested");
      if (approvalEvent === undefined) {
        throw new RuntimeCommandError("approval_recovery_unavailable", "Pending approval event is unavailable");
      }
      const pendingRecovery = await this.#loadPendingPatchRecovery(approvalEvent);
      let recoveredPatchInput: ReturnType<typeof PatchInputSchema.parse>;
      try {
        recoveredPatchInput = PatchInputSchema.parse(pendingRecovery.preview_call.arguments);
      } catch {
        throw new RuntimeCommandError(
          "approval_recovery_invalid",
          "Persisted approval recovery arguments are invalid",
        );
      }
      if (
        pendingRecovery.pending_approval.action_id !== beforeInterruption.pending_approval.action_id
        || pendingRecovery.preview_call.action_id !== beforeInterruption.pending_approval.action_id
        || pendingRecovery.preview_call.tool_name !== "preview_patch"
        || recoveredPatchInput.path !== beforeInterruption.pending_approval.preview.path
        || !beforeInterruption.pending_approval.preview.scope.includes(recoveredPatchInput.path)
      ) {
        throw new RuntimeCommandError("approval_recovery_invalid", "Persisted approval recovery state does not match the ledger");
      }

      const runRecovery = await this.#loadRunRecovery(events[0]!);
      const permissionPolicy = runRecovery.version === 2 || runRecovery.version === 3 || runRecovery.version === 4 || runRecovery.version === 5
        ? runRecovery.effective_policy
        : legacyRecoveryPermissionPolicy(events, this.#defaultPermissionPolicy);
      const renewedPreview = PatchPreviewSchema.parse({
        ...beforeInterruption.pending_approval.preview,
        expires_at: new Date(this.#now().getTime() + 5 * 60_000).toISOString(),
      });
      const legacyRenewedPending = PendingApprovalSchema.parse({
        ...beforeInterruption.pending_approval,
        approval_id: this.#idFactory("approval"),
        preview: renewedPreview,
      });
      const state = await this.#restoreRunState({
        locator,
        workspace,
        events,
        recovery: runRecovery,
        permissionPolicy,
        sessionState: scope.state,
        pendingPatch: {
          pendingApproval: legacyRenewedPending,
          previewCall: pendingRecovery.preview_call,
        },
      });
      // Recovery always reissues approval. Re-capture the static baseline so a
      // later approved patch still yields a graph/code-intel delta instead of
      // comparing against an in-memory snapshot that disappeared at restart.
      // Semantic enrichment is best-effort here: it must not turn the durable
      // no-tool recovery path into a failed Run.
      if (this.#codeGraph !== undefined && state.workspace.capabilities.index) {
        try {
          const gitContext = await this.#captureCodeIntelGitContext(state);
          state.baseGraph = await this.#captureGraphSnapshot(state, "Recovered baseline graph snapshot created");
          await this.#appendCodeIntelUpdated(state, {
            phase: "baseline",
            gitContext,
            baseSnapshotId: state.baseGraph.snapshot_id,
            changedFiles: [],
            changedSymbols: [],
          });
          state.codeIntelGitContext = gitContext;
        } catch {
          // The reissued approval remains valid under the durable recovery
          // rules; a later commit still has its original file-hash fence.
        }
      }
      const recoveredCommitCall: ToolCall = {
        action_id: renewedPreview.action_id,
        tool_name: "commit_patch",
        arguments: {
          ...recoveredPatchInput,
          base_hash: renewedPreview.base_hash,
          patch_hash: renewedPreview.patch_hash,
        },
      };
      const { actionDigest } = await this.#patchActionBinding(
        state,
        recoveredCommitCall,
        renewedPreview.scope,
      );
      const renewedPending = BoundPendingApprovalSchema.parse({
        ...legacyRenewedPending,
        tool_name: "commit_patch",
        action_digest: actionDigest,
        policy_digest: state.permissionPolicy.policy_digest,
      });
      state.pendingPatch = {
        pendingApproval: renewedPending,
        previewCall: pendingRecovery.preview_call,
      };
      const pendingRecoveryArtifact = await this.#artifacts.put({
        projectId: state.projectId,
        runId: state.runId,
        kind: "recovery_state",
        mimeType: "application/json",
        content: JSON.stringify(SessionPendingPatchRecoveryStateSchema.parse({
          version: 1,
          kind: "pending_patch_recovery_state",
          pending_approval: renewedPending,
          preview_call: pendingRecovery.preview_call,
        })),
      });
      await this.#recordSandboxConfiguration(state);
      await this.#append(state, {
        type: "run.resumed",
        summary: "Interrupted Run restored without replaying a tool",
        idempotency_key: resumeKey,
        data: {
          restored_status: "awaiting_approval",
          interrupted_event_id: events[interruptedIndex]!.event_id,
        },
      });
      await this.#append(state, {
        type: "approval.requested",
        summary: `Approval reissued to modify ${renewedPreview.path}`,
        idempotency_key: `command:${sha256(commandId)}:approval.requested`,
        action_id: renewedPending.action_id,
        artifact_refs: renewedPreview.artifact_ref === undefined ? [] : [renewedPreview.artifact_ref],
        data: {
          pending_approval: renewedPending,
          approval_id: renewedPending.approval_id,
          action_id: renewedPending.action_id,
          tool_name: renewedPending.tool_name,
          action_digest: renewedPending.action_digest,
          policy_digest: renewedPending.policy_digest,
          expires_at: renewedPreview.expires_at,
          recovered_from_event_id: approvalEvent.event_id,
          _internal_recovery_artifact: pendingRecoveryArtifact,
        },
      });
      this.#runs.set(locator.runId, state);
      leaseTransferred = true;
      events = await this.#ledger.list(locator.runId);
      return projectRun(events);
    } finally {
      if (!leaseTransferred) await scope.release();
    }
  }

  async #recordSandboxConfiguration(state: RunState): Promise<SandboxReport> {
    const sandboxMode = state.permissionPolicy.preset.sandbox_mode;
    const report = await this.#probeSandbox(state.workspace, sandboxMode);
    const configured = SandboxConfiguredDataSchema.parse({
      mode: sandboxMode,
      platform: report.platform,
    });
    await this.#append(state, {
      type: "sandbox.configured",
      summary: `Sandbox mode configured as ${sandboxMode}`,
      data: configured,
    });

    if (report.enforcement === "none") {
      const disabled = SandboxDisabledDataSchema.parse({
        reason: sandboxMode === "danger-full-access"
          ? "explicit_danger_full_access"
          : "enforcement_unavailable",
        sandbox_report: report,
      });
      await this.#append(state, {
        type: "sandbox.disabled",
        summary: sandboxMode === "danger-full-access"
          ? "OS sandbox explicitly disabled by Host configuration"
          : "Requested OS sandbox enforcement is unavailable; process execution will fail closed",
        data: disabled,
      });
      return report;
    }

    const enforced = SandboxEnforcedDataSchema.parse({ sandbox_report: report });
    await this.#append(state, {
      type: "sandbox.enforced",
      summary: report.enforcement === "full"
        ? "OS sandbox enforcement is active"
        : "OS sandbox enforcement is only partially active",
      data: enforced,
    });
    return report;
  }

  async #probeSandbox(workspace: WorkspaceHandle, sandboxMode: SandboxMode): Promise<SandboxReport> {
    try {
      const report = SandboxReportSchema.parse(await this.#sandboxRunner.probe({
        mode: sandboxMode,
        workspaceRoot: workspace.real_root,
      }));
      if (report.mode !== sandboxMode) {
        return unavailableSandboxReport(sandboxMode, report.platform, "sandbox_mode_mismatch");
      }
      return report;
    } catch {
      const platform = process.platform === "darwin" || process.platform === "linux" || process.platform === "win32"
        ? process.platform
        : undefined;
      if (platform === undefined) {
        throw new RuntimeCommandError("sandbox_platform_unsupported", "The current OS has no sandbox report contract");
      }
      if (sandboxMode === "danger-full-access") {
        return SandboxReportSchema.parse({
          report_version: 1,
          mode: sandboxMode,
          enforcement: "none",
          platform,
          mechanisms: [],
          unmet_constraints: [],
        });
      }
      return unavailableSandboxReport(sandboxMode, platform, "sandbox_probe_failed");
    }
  }

  async recordSessionFact(
    inputValue: RecordSessionFactInput,
    suppliedLease?: SessionLease,
  ): Promise<SessionEvent> {
    const input = parseSessionRunLocator(inputValue);
    const idempotencyKey = IdentifierSchema.parse(inputValue.idempotencyKey);
    const events = await this.#ledger.list(input.runId);
    assertRunBelongsToSession(events, input);
    const scope = await this.#openSessionScope(input, suppliedLease);
    try {
      return await this.#appendScoped(scope.state, {
        type: inputValue.type,
        summary: redactSensitiveText(inputValue.summary),
        idempotency_key: idempotencyKey,
        data: inputValue.data ?? {},
      });
    } finally {
      await scope.release();
    }
  }

  async getArtifact(input: {
    artifactId: string;
    runId: string;
    projectId: string;
  }): Promise<ArtifactWireResponse> {
    const projection = await this.getProjection(input.runId);
    const expected = projection.artifact_refs.find(
      (artifact) => artifact.artifact_id === input.artifactId,
    );
    if (projection.project_id !== input.projectId || expected === undefined) {
      return {
        status: "unavailable",
        artifact_id: input.artifactId,
        reason: "out_of_scope",
      };
    }
    const result = await this.#artifacts.get(input);
    if (
      result.status === "available"
      && (
        result.artifact.content_hash !== expected.content_hash
        || result.artifact.kind !== expected.kind
        || result.artifact.mime_type !== expected.mime_type
        || result.artifact.byte_length !== expected.byte_length
        || result.artifact.project_id !== expected.project_id
        || result.artifact.run_id !== expected.run_id
      )
    ) {
      return {
        status: "corrupt",
        artifact_id: input.artifactId,
        expected_hash: expected.content_hash,
        actual_hash: result.artifact.content_hash,
        reason: "artifact metadata does not match the canonical event reference",
      };
    }
    return result;
  }

  async getAttachmentContent(input: {
    attachmentId: string;
    runId: string;
    projectId: string;
  }): Promise<AttachmentContent> {
    const projection = await this.getProjection(input.runId);
    const item = projection.attachments.items.find((candidate) => {
      if (candidate.status === "rejected") return false;
      return candidate.attachment.attachment_id === input.attachmentId;
    });
    if (
      projection.project_id !== input.projectId
      || item === undefined
      || item.status === "rejected"
    ) {
      throw new RuntimeCommandError("attachment_out_of_scope", "Attachment is unavailable in this Run");
    }
    const content = await this.#attachmentStore.getContent(input);
    if (
      content.attachment.attachment_id !== item.attachment.attachment_id
      || content.attachment.media_type !== item.attachment.media_type
      || content.attachment.bytes !== item.attachment.bytes
      || content.attachment.sha256 !== item.attachment.sha256
      || content.attachment.source !== item.attachment.source
    ) {
      throw new RuntimeCommandError(
        "attachment_metadata_mismatch",
        "Attachment bytes do not match the canonical Run projection",
      );
    }
    return content;
  }

  #teamToolBridge(state: RunState, actionId: string): TeamToolBridge {
    const delegation = state.orchestration.delegation;
    const rootRunId = delegation?.link.parent_run_id ?? state.runId;
    const rootSessionId = delegation?.link.parent_session_id ?? state.sessionId;
    const actor: TeamCommandScope["actor"] = delegation === undefined
      ? { kind: "lead" }
      : { kind: "member", subagent_id: delegation.link.subagent_id };
    const scope: TeamCommandScope = {
      projectId: state.projectId,
      runId: rootRunId,
      sessionId: rootSessionId,
      actor,
      ...(delegation === undefined ? {} : { evidenceBeforeActionId: actionId }),
    };
    const commandId = (operation: string) => (
      `team-tool:${sha256(`${rootRunId}:${state.runId}:${actionId}:${operation}`)}`
    );
    const mutate = async (command: TeamCommand): Promise<TeamMutationResult> => {
      return this.#withRunControl(rootRunId, async () => {
        const before = await this.#ledger.list(rootRunId);
        const team = await this.#teams.execute(scope, command);
        const after = await this.#ledger.list(rootRunId);
        return teamMutationResult(command.command_id, before, after, team);
      });
    };
    return {
      read: async (input) => {
        TeamReadInputSchema.parse(input);
        return TeamReadResponseSchema.parse({ team: await this.#teams.read(rootRunId) });
      },
      writeTask: async (inputValue) => {
        const input = TeamTaskWriteInputSchema.parse(inputValue);
        const id = commandId("task");
        return mutate(teamTaskCommand(id, input));
      },
      sendMailbox: async (inputValue) => {
        const input = TeamMailboxSendInputSchema.parse(inputValue);
        const id = commandId("mailbox-send");
        return mutate({
          command_id: id,
          operation: "deliver_mailbox",
          message_id: `team-message:${sha256(id)}`,
          ...input,
        });
      },
      claimMailbox: async (inputValue) => {
        const input = TeamMailboxClaimInputSchema.parse(inputValue);
        const id = commandId("mailbox-claim");
        return mutate({
          command_id: id,
          operation: "claim_mailbox",
          message_id: input.message_id,
        });
      },
      heartbeat: async (inputValue) => {
        TeamHeartbeatInputSchema.parse(inputValue);
        if (actor.kind !== "member") {
          throw new TeamDomainError("authority_denied", "Only a joined worker may heartbeat");
        }
        const id = commandId("heartbeat");
        return mutate({
          command_id: id,
          operation: "heartbeat",
          subagent_id: actor.subagent_id,
        });
      },
    };
  }

  async #retireTeamMemberIfJoined(
    parent: SessionScopedState,
    link: SubagentRunLink,
  ): Promise<void> {
    await this.#withRunControl(parent.runId, async () => {
      const team = await this.#teams.read(parent.runId);
      const member = team?.roster.members.find(({ link: candidate }) => candidate.subagent_id === link.subagent_id);
      if (member === undefined || member.status !== "active") return;
      await this.#teams.retireTerminalMember({
        projectId: parent.projectId,
        runId: parent.runId,
        sessionId: parent.sessionId,
        actor: { kind: "lead" },
      }, link.subagent_id, `team-retire:${sha256(`${parent.runId}:${link.subagent_id}`)}`);
    });
  }

  async #spawnSubagent(
    parent: RunState,
    inputValue: unknown,
    actionId: string,
    control: {
      signal?: AbortSignal;
      cancellationShield?: ToolCancellationShield;
    } = {},
  ): Promise<SubagentResult> {
    const input = SpawnSubagentInputSchema.parse(inputValue);
    const depth = parent.orchestration.depth + 1;
    if (depth > parent.orchestration.limits.max_depth) {
      throw new SubagentDomainError(
        "subagent_depth_exceeded",
        `Subagent depth ${depth} exceeds limit ${parent.orchestration.limits.max_depth}`,
      );
    }
    if (parent.mode !== "execute") {
      throw new SubagentDomainError("subagent_plan_mode_denied", "Subagents cannot be launched from plan mode");
    }
    const profile = this.#subagentRegistry.resolve(input.profile_name, parent.model);
    const budget = SubagentBudgetSchema.parse({
      max_steps: input.budget?.max_steps ?? profile.defaultBudget.max_steps,
      max_tokens: input.budget?.max_tokens ?? profile.defaultBudget.max_tokens,
    });
    if (
      budget.max_steps > profile.budgetCeiling.max_steps
      || budget.max_tokens > profile.budgetCeiling.max_tokens
    ) {
      throw new SubagentDomainError(
        "subagent_budget_ceiling_exceeded",
        "Requested subagent budget exceeds the trusted profile ceiling",
      );
    }
    const effectiveTools = profile.toolAllowlist.filter((toolName) => (
      this.#toolRegistry.get(toolName) !== undefined
      && parent.permissionPolicy.preset.allowed_tools.includes(toolName)
      && (parent.toolAllowlist === undefined || parent.toolAllowlist.has(toolName))
      && (depth < parent.orchestration.limits.max_depth || !isSubagentControlTool(toolName))
    ));
    if (effectiveTools.length === 0) {
      throw new SubagentDomainError("subagent_allowlist_empty", "Subagent profile has no effective tools");
    }

    const parentEvents = await this.#ledger.list(parent.runId);
    this.#assertControlMutationAllowedLocked(parent, parentEvents);
    const forkManifest = input.context_scope === "fork"
      ? [...parentEvents].reverse().find((event) => (
          event.type === "context.built" && event.context_manifest_ref !== undefined
        ))?.context_manifest_ref
      : undefined;
    if (input.context_scope === "fork" && forkManifest === undefined) {
      throw new SubagentDomainError(
        "subagent_fork_context_unavailable",
        "Forked subagent requires a durable parent Context manifest",
      );
    }

    const controlSignal = control.signal ?? parent.abortController.signal;
    const releasePermit = await this.#subagentPermits.acquire(controlSignal);
    const link = SubagentRunLinkSchema.parse({
      subagent_id: this.#idFactory("subagent"),
      parent_run_id: parent.runId,
      parent_session_id: parent.sessionId,
      child_run_id: this.#idFactory("run"),
      child_session_id: this.#idFactory("session"),
    });
    const spec = SubagentSpecSchema.parse({
      subagent_id: link.subagent_id,
      parent_run_id: parent.runId,
      name: profile.name,
      provider_key: profile.providerKey,
      role_prompt_version: profile.rolePromptVersion,
      role_prompt_hash: profile.rolePromptHash,
      tool_allowlist: effectiveTools,
      context_scope: input.context_scope,
      budget,
      depth,
      ...(forkManifest === undefined ? {} : { fork_context_manifest_ref: forkManifest }),
    });
    const startedData = SubagentStartedDataSchema.parse({
      link,
      spec,
      limits: parent.orchestration.limits,
      task_packet_hash: sha256(stableStringify(input.task_packet)),
    });
    const operationKey = `subagent:${sha256(`${parent.runId}:${actionId}:${link.subagent_id}`)}`;
    let childStarted = false;
    let launchTerminal: SessionEvent | undefined;
    let recoveryPending = false;
    let removeControlAbort = (): void => undefined;
    try {
      if (controlSignal.aborted) throw abortReason(controlSignal);
      await this.#withRunControl(parent.runId, async () => {
        const startedProposal: RuntimeEventProposal = {
          type: "subagent.started",
          summary: `Subagent ${profile.name} started`,
          idempotency_key: `${operationKey}:started`,
          operation_id: link.subagent_id,
          data: startedData,
        };
        if (await this.#teams.read(parent.runId) === undefined) {
          await this.#appendScoped(parent, startedProposal);
          return;
        }
        await this.#teams.appendStartedAndJoin({
          projectId: parent.projectId,
          runId: parent.runId,
          sessionId: parent.sessionId,
          actor: { kind: "lead" },
        }, {
          ...startedProposal,
          project_id: parent.projectId,
          run_id: parent.runId,
          session_id: parent.sessionId,
          attempt: 0,
          artifact_refs: [],
        });
      });
      // The shield begins only after the durable parent start receipt exists.
      // From here cancellation must close the child/launch state before the
      // Tool wrapper is allowed to observe abort or timeout.
      control.cancellationShield?.arm();
      try {
        if (controlSignal.aborted) throw abortReason(controlSignal);
        await this.#startChildRun(parent, startedData, input.task_packet, profile);
        childStarted = true;
      } catch (error) {
        const childEvents = await this.#ledger.list(link.child_run_id);
        launchTerminal = childEvents.find((event) => isTerminalEventType(event.type));
        if (launchTerminal !== undefined) {
          // run.created became durable before launch failed. Treat this as an
          // execution-stage child with a hash-linked terminal proof, not as a
          // proofless pre-launch failure.
          childStarted = true;
        } else if (childEvents.length > 0) {
          // A child ledger already exists, but the persistence boundary is too
          // unhealthy to write its terminal proof. Never misclassify that as
          // a proofless launch failure or terminate the parent with an active
          // link. Keep the relation recoverable for restart reconciliation.
          childStarted = true;
          recoveryPending = true;
          throw new SubagentDomainError(
            "subagent_recovery_pending",
            "Durable child launch requires restart reconciliation",
          );
        } else {
          const result = SubagentResultSchema.parse({
            subagent_id: link.subagent_id,
            child_run_id: link.child_run_id,
            status: "failed",
            summary: publicError(error),
            artifact_refs: [],
          });
          await this.#append(parent, {
            type: "subagent.failed",
            summary: result.summary,
            idempotency_key: `${operationKey}:terminal`,
            operation_id: link.subagent_id,
            data: SubagentFailedDataSchema.parse({
              link,
              result,
              reason: "launch_failed",
              failure_stage: "launch",
            }),
          });
          await this.#retireTeamMemberIfJoined(parent, link);
          return result;
        }
      }

      const initialBody = redactSensitiveText(input.task_packet.task);
      const initialMessageId = this.#idFactory("subagent-message");
      await this.#appendScoped(parent, {
        type: "subagent.message_sent",
        summary: `Initial task delivered to subagent ${profile.name}`,
        idempotency_key: `${operationKey}:initial-message`,
        operation_id: link.subagent_id,
        data: SubagentMessageSentDataSchema.parse({
          link,
          message: {
            message_id: initialMessageId,
            kind: "initial_task",
            actor: "parent_agent",
            body: initialBody,
            body_hash: sha256(input.task_packet.task),
            sent_at: this.#now().toISOString(),
          },
          _internal_message_digest: sha256(stableStringify(input.task_packet)),
        }),
      });

      if (launchTerminal !== undefined) {
        return this.#recordSubagentTerminal(parent, startedData, launchTerminal);
      }

      const cascade = () => {
        void this.#cancelChild(link, "parent_or_tool_cancelled").catch(() => undefined);
      };
      controlSignal.addEventListener("abort", cascade, { once: true });
      removeControlAbort = () => controlSignal.removeEventListener("abort", cascade);
      if (controlSignal.aborted) cascade();

      const childTerminal = await this.#waitForRunTerminal(link.child_run_id);
      return this.#recordSubagentTerminal(parent, startedData, childTerminal);
    } catch (error) {
      if (childStarted && !recoveryPending) {
        // A parent Session-index failure after durable child launch must not
        // strand a running projection. Cancel and reconcile from the canonical
        // child terminal before the parent Runtime is allowed to fail.
        await this.#cancelChild(link, "subagent_parent_receipt_failed").catch(() => undefined);
        const terminal = await this.#waitForRunTerminal(link.child_run_id).catch(() => undefined);
        if (terminal !== undefined) {
          await this.#recordSubagentTerminal(parent, startedData, terminal).catch(() => undefined);
        }
      }
      throw error;
    } finally {
      removeControlAbort();
      if (childStarted && !recoveryPending && !(await this.#isTerminal(link.child_run_id))) {
        await this.#cancelChild(link, "subagent_scope_closed").catch(() => undefined);
        await this.#waitForRunTerminal(link.child_run_id).catch(() => undefined);
      }
      // Holding the permit is deliberate while a durable child remains
      // unresolved in this process. A restarted Runtime reconstructs safety
      // by closing inherited links before it accepts resumed work.
      if (!recoveryPending) releasePermit();
    }
  }

  async #startChildRun(
    parent: RunState,
    delegation: SubagentStartedData,
    taskPacket: ReturnType<typeof SpawnSubagentInputSchema.parse>["task_packet"],
    profile: ResolvedSubagentProfile,
  ): Promise<void> {
    const { link, spec } = delegation;
    const session = await this.#prepareChildSession(parent, link, taskPacket.task);
    const task = renderSubagentTaskPacket(taskPacket);
    const conversationHistory = spec.context_scope === "isolated"
      ? []
      : [...(parent.conversationHistory ?? [])];
    let extensionLease: ExtensionRunLease;
    try {
      extensionLease = this.#extensionManager.acquireRunLease();
    } catch (error) {
      await session.lease?.release().catch(() => undefined);
      throw error;
    }
    const extensionSnapshot = extensionLease.snapshot;
    if (extensionSnapshot.config_digest !== parent.extensionSnapshot.config_digest) {
      extensionLease.release();
      await session.lease?.release().catch(() => undefined);
      throw new RuntimeCommandError(
        "extension_configuration_drift",
        "Child Run extension surface differs from its parent Run",
      );
    }
    const skills = await this.#skillRegistry.scan(parent.workspace.real_root);
    const recoveryState = RunRecoveryStateSchema.parse({
      version: 5,
      kind: "run_recovery_state",
      task,
      conversation_history: conversationHistory,
      mode: "execute",
      reasoning_effort: parent.reasoningEffort,
      effective_policy: parent.permissionPolicy,
      orchestration: {
        depth: spec.depth,
        limits: delegation.limits,
        delegation,
      },
      extensions: extensionSnapshot,
      skills: {
        registry_digest: skills.registry_digest,
        active_tool_names: [],
      },
    });
    let recoveryArtifact: ArtifactRef;
    try {
      recoveryArtifact = await this.#artifacts.put({
        projectId: parent.projectId,
        runId: link.child_run_id,
        kind: "recovery_state",
        mimeType: "application/json",
        content: JSON.stringify(recoveryState),
      });
    } catch (error) {
      extensionLease.release();
      await session.lease?.release().catch(() => undefined);
      throw error;
    }
    const state: RunState = {
      runId: link.child_run_id,
      sessionId: link.child_session_id,
      projectId: parent.projectId,
      task,
      conversationHistory,
      mode: "execute",
      reasoningEffort: parent.reasoningEffort,
      workspace: parent.workspace,
      model: profile.model,
      rolePrompt: profile.rolePrompt,
      toolAllowlist: new Set(spec.tool_allowlist as ToolName[]),
      skills,
      orchestration: { depth: spec.depth, limits: delegation.limits, delegation },
      maxTurns: spec.budget.max_steps,
      subagentBudget: {
        maxTokens: spec.budget.max_tokens,
        inputTokens: 0,
        outputTokens: 0,
        confidence: "estimated",
      },
      permissionPolicy: parent.permissionPolicy,
      policyEngine: PolicyEngine.fromEffective(parent.permissionPolicy, { idFactory: this.#idFactory }),
      extensionSnapshot,
      extensionLease,
      observations: spec.context_scope === "isolated"
        ? []
        : parent.observations.map((observation) => ObservationSchema.parse(observation)),
      modelImages: [],
      turn: 0,
      stopped: false,
      abortController: new AbortController(),
      commandQueue: Promise.resolve(),
      actionSignatures: new Map(),
      canonicalActionSequence: 0,
      ...(session.lease === undefined ? {} : { sessionLease: session.lease }),
      ...(session.lastEntryId === undefined ? {} : { lastSessionEntryId: session.lastEntryId }),
      indexedSessionEventIds: session.indexedEventIds,
    };
    // Register before the first child event so any partial durable launch can
    // be driven to a canonical terminal state instead of becoming an
    // unaddressable orphan between run.created and run.started.
    this.#runs.set(state.runId, state);
    try {
      await this.#append(state, {
        type: "run.created",
        summary: "Child Run created",
        idempotency_key: `${link.child_run_id}:run.created`,
        data: {
          task,
          mode: "execute",
          reasoning_effort: state.reasoningEffort,
          workspace_kind: state.workspace.workspace_kind,
          conversation_message_count: conversationHistory.length,
          _internal_recovery_artifact: recoveryArtifact,
          max_turns: state.maxTurns,
          subagent_limits: delegation.limits,
          subagent_id: link.subagent_id,
          parent_run_id: parent.runId,
          parent_session_id: parent.sessionId,
          subagent_depth: spec.depth,
        },
      });
      if (session.created) {
        await this.#append(state, {
          type: "session.opened",
          summary: "Durable child session opened",
          idempotency_key: `${link.child_run_id}:session.opened`,
          data: { session_version: SESSION_FORMAT_VERSION, parent_session_id: parent.sessionId },
        });
      }
      await this.#append(state, {
        type: "permission.configured",
        summary: `Child inherited permission preset ${parent.permissionPolicy.preset.key}`,
        data: PermissionConfiguredDataSchema.parse({ permission: state.policyEngine.snapshot() }),
      });
        await this.#recordSkillRegistry(state);
        await this.#recordMcpEvents(state);
        await this.#recordSandboxConfiguration(state);
      await this.#append(state, {
        type: "run.started",
        summary: state.workspace.capabilities.index
          ? "Child workspace preflight and indexing started"
          : "Child conversation started without workspace indexing",
        idempotency_key: `${link.child_run_id}:run.started`,
        data: { phase: state.workspace.capabilities.index ? "indexing" : "conversation" },
      });
    } catch (error) {
      let durableEvents: SessionEvent[] | undefined;
      try {
        durableEvents = await this.#ledger.list(state.runId);
      } catch {
        // An unreadable ledger is not evidence that launch never became
        // durable. Preserve process/session state for explicit recovery.
      }
      if (durableEvents?.length === 0) {
        // No canonical child fact exists, so this is the sole safe window in
        // which the process registration and freshly-created child Session
        // may be removed. The private recovery Artifact is intentionally left
        // untouched because ArtifactStore has no scoped delete API.
        if (this.#runs.get(state.runId) === state) this.#runs.delete(state.runId);
        const lease = state.sessionLease;
        delete state.sessionLease;
        if (this.#sessionStore !== undefined && lease !== undefined) {
          try {
            await this.#sessionStore.delete(state.sessionId, lease);
          } finally {
            await lease.release().catch(() => undefined);
          }
        }
      } else if (
        durableEvents !== undefined
        && durableEvents.length > 0
        && !durableEvents.some((event) => isTerminalEventType(event.type))
      ) {
        try {
          await this.#fail(state, "subagent_launch_failed", publicError(error));
        } catch {
          // Session indexing is derived state. If it is the failing boundary,
          // commit the terminal proof directly to the canonical ledger while
          // leaving that Session to ordinary index-tail recovery.
          await this.#appendScoped({
            runId: state.runId,
            sessionId: state.sessionId,
            projectId: state.projectId,
            indexedSessionEventIds: new Set(),
          }, {
            type: "run.failed",
            summary: publicError(error),
            idempotency_key: `${state.runId}:terminal`,
            data: { code: "subagent_launch_failed" },
          }).catch(() => undefined);
          state.stopped = true;
        }
      }
      await this.#releaseSessionLease(state).catch(() => undefined);
      state.extensionLease?.release();
      delete state.extensionLease;
      throw error;
    }
    void this.#enqueue(state, () => this.#bootstrapRun(state));
  }

  async #listSubagents(parent: RunState, inputValue: unknown): Promise<SubagentListProjection> {
    ListSubagentsInputSchema.parse(inputValue);
    return SubagentListProjectionSchema.parse((await this.getProjection(parent.runId)).subagents);
  }

  async #sendSubagentMessage(parent: RunState, inputValue: unknown): Promise<unknown> {
    const input = SendSubagentMessageInputSchema.parse(inputValue);
    return this.#withRunControl(parent.runId, async () => {
      const child = await this.#requireDirectSubagent(parent, input.subagent_id, true);
      const messageId = this.#idFactory("subagent-message");
      const body = redactSensitiveText(input.message);
      const queued = await this.submitUserInput({
        type: "submit_user_input",
        command_id: this.#idFactory("subagent-command"),
        input_id: messageId,
        project_id: parent.projectId,
        run_id: child.link.child_run_id,
        kind: "message",
        body,
        actor: "parent_agent",
      });
      await this.#append(parent, {
        type: "subagent.message_sent",
        summary: `Message queued for subagent ${child.name}`,
        idempotency_key: `subagent-message:${sha256(`${parent.runId}:${messageId}`)}`,
        operation_id: child.link.subagent_id,
        data: SubagentMessageSentDataSchema.parse({
          link: child.link,
          message: {
            message_id: messageId,
            kind: "message",
            actor: "parent_agent",
            body,
            body_hash: sha256(input.message),
            sent_at: queued.input.submitted_at,
          },
          _internal_message_digest: sha256(input.message),
        }),
      });
      return { input: queued.input, disposition: queued.disposition };
    });
  }

  async #interruptSubagent(parent: RunState, inputValue: unknown): Promise<SubagentResult> {
    const input = InterruptSubagentInputSchema.parse(inputValue);
    const child = await this.#requireDirectSubagent(parent, input.subagent_id, false);
    if (child.status !== "running" && child.result !== undefined) return child.result;
    await this.#cancelChild(child.link, input.reason ?? "parent_interrupt");
    const terminal = await this.#waitForRunTerminal(child.link.child_run_id);
    const parentEvents = await this.#ledger.list(parent.runId);
    const started = parentEvents.find((event) => (
      event.type === "subagent.started"
      && event.data.link !== undefined
      && (event.data.link as { subagent_id?: unknown }).subagent_id === input.subagent_id
    ));
    if (started === undefined) {
      throw new SubagentDomainError("subagent_start_missing", "Subagent start receipt is unavailable");
    }
    return this.#recordSubagentTerminal(parent, SubagentStartedDataSchema.parse(started.data), terminal);
  }

  async #requireDirectSubagent(parent: RunState, subagentId: string, requireRunning: boolean) {
    const list = await this.#listSubagents(parent, {});
    const child = list.items.find(({ link }) => link.subagent_id === subagentId);
    if (child === undefined || child.link.parent_run_id !== parent.runId) {
      throw new SubagentDomainError("subagent_not_found", "Subagent is not a direct child of this Run");
    }
    if (requireRunning && child.status !== "running") {
      throw new SubagentDomainError("subagent_terminal", "A terminal subagent cannot accept messages");
    }
    return child;
  }

  async #cancelChild(link: SubagentRunLink, _reason: string): Promise<void> {
    const events = await this.#ledger.list(link.child_run_id);
    if (events.some((event) => isTerminalEventType(event.type))) return;
    try {
      await this.submitUserInput({
        type: "submit_user_input",
        command_id: `subagent-cancel-command:${sha256(`${link.parent_run_id}:${link.subagent_id}`)}`,
        input_id: `subagent-cancel:${sha256(`${link.parent_run_id}:${link.subagent_id}`)}`,
        project_id: events[0]?.project_id ?? this.#runs.get(link.child_run_id)?.projectId ?? "unknown",
        run_id: link.child_run_id,
        kind: "cancel",
        // Every cancellation source converges on one idempotent command. The
        // source-specific reason is intentionally not part of the durable
        // payload; otherwise timeout, explicit interrupt, and parent abort can
        // race the same command id with conflicting signatures.
        body: "Cancel delegated child Run",
        actor: "parent_agent",
      });
    } catch (error) {
      if (await this.#isTerminal(link.child_run_id)) return;
      throw error;
    }
  }

  async #waitForRunTerminal(runId: string): Promise<SessionEvent> {
    const existing = (await this.#ledger.list(runId)).find((event) => isTerminalEventType(event.type));
    if (existing !== undefined) return existing;
    return new Promise<SessionEvent>((resolvePromise, rejectPromise) => {
      let settled = false;
      const unsubscribe = this.subscribe(runId, (event) => {
        if (!isTerminalEventType(event.type) || settled) return;
        settled = true;
        unsubscribe();
        resolvePromise(event);
      });
      void this.#ledger.list(runId).then((events) => {
        const terminal = events.find((event) => isTerminalEventType(event.type));
        if (terminal === undefined || settled) return;
        settled = true;
        unsubscribe();
        resolvePromise(terminal);
      }, (error: unknown) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        rejectPromise(error instanceof Error ? error : new Error("Failed to inspect child Run"));
      });
    });
  }

  /**
   * Crash recovery never resumes opaque child work. Every parent-side active
   * link is reconciled from the canonical child ledger: an already-terminal
   * child gets its missing receipt, while a nonterminal child (and any nested
   * descendants) is deterministically cancelled first. This also means a
   * restarted Runtime begins with zero inherited process-local permits.
   */
  async #reconcileSubagentsAfterRestart(
    parent: SessionScopedState,
    parentEventsValue: readonly SessionEvent[],
    ancestorRunIds: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    if (ancestorRunIds.has(parent.runId)) {
      throw new RuntimeCommandError("subagent_recovery_corrupt", "Subagent recovery graph contains a Run cycle");
    }
    const recoveryPath = new Set(ancestorRunIds);
    recoveryPath.add(parent.runId);
    let parentEvents = [...parentEventsValue];
    let projected = projectRun(parentEvents);
    for (const projectedChild of projected.subagents.items.filter(({ status }) => status === "running")) {
      // A preceding iteration or retry may already have completed this link.
      parentEvents = await this.#ledger.list(parent.runId);
      projected = projectRun(parentEvents);
      const current = projected.subagents.items.find(
        ({ link }) => link.subagent_id === projectedChild.link.subagent_id,
      );
      if (current === undefined || current.status !== "running") continue;
      const startedEvent = parentEvents.find((event) => (
        event.type === "subagent.started"
        && event.data.link !== undefined
        && (event.data.link as { subagent_id?: unknown }).subagent_id === current.link.subagent_id
      ));
      if (startedEvent === undefined) {
        throw new RuntimeCommandError(
          "subagent_recovery_corrupt",
          "Active subagent projection has no canonical start event",
        );
      }
      const delegation = SubagentStartedDataSchema.parse(startedEvent.data);
      if (recoveryPath.has(current.link.child_run_id)) {
        throw new RuntimeCommandError("subagent_recovery_corrupt", "Subagent recovery graph contains a child cycle");
      }
      let childEvents = await this.#ledger.list(current.link.child_run_id);
      if (childEvents.length === 0) {
        const result = SubagentResultSchema.parse({
          subagent_id: current.link.subagent_id,
          child_run_id: current.link.child_run_id,
          status: "failed",
          summary: "Child Run was not durably created before Host restart",
          artifact_refs: [],
        });
        await this.#appendScoped(parent, {
          type: "subagent.failed",
          summary: result.summary,
          idempotency_key: `subagent:${sha256(`${parent.runId}:${current.link.subagent_id}`)}:terminal`,
          operation_id: current.link.subagent_id,
          data: SubagentFailedDataSchema.parse({
            link: current.link,
            result,
            reason: "launch_failed",
            failure_stage: "launch",
          }),
        });
        await this.#retireTeamMemberIfJoined(parent, current.link);
        continue;
      }
      assertRecoveredChildProvenance(parent, delegation, childEvents);

      if (current.message_count === 0) {
        let recoveredTask = "Recovered durable child launch after Host restart.";
        try {
          recoveredTask = (await this.#loadRunRecovery(childEvents[0]!)).task;
        } catch {
          // The child ledger remains authoritative even if its private task
          // recovery Artifact is unavailable; use a bounded recovery marker.
        }
        const body = redactSensitiveText(recoveredTask).slice(0, MAX_USER_INPUT_BODY_CHARS);
        const messageId = `subagent-recovery-message:${sha256(`${parent.runId}:${current.link.subagent_id}`)}`;
        await this.#appendScoped(parent, {
          type: "subagent.message_sent",
          summary: `Recovered initial task receipt for subagent ${current.name}`,
          idempotency_key: `${messageId}:event`,
          operation_id: current.link.subagent_id,
          data: SubagentMessageSentDataSchema.parse({
            link: current.link,
            message: {
              message_id: messageId,
              kind: "initial_task",
              actor: "parent_agent",
              body,
              body_hash: sha256(body),
              sent_at: this.#now().toISOString(),
            },
            _internal_message_digest: sha256(body),
          }),
        });
      }

      let childTerminal = childEvents.find((event) => isTerminalEventType(event.type));
      if (childTerminal === undefined) {
        let childScope: { state: SessionScopedState; release(): Promise<void> };
        try {
          childScope = await this.#openMaintenanceScope({
            sessionId: current.link.child_session_id,
            runId: current.link.child_run_id,
            projectId: parent.projectId,
          });
        } catch {
          // A canonical terminal must not depend on a derived Session index
          // being healthy. Tail repair can index this event later.
          childScope = {
            state: {
              sessionId: current.link.child_session_id,
              runId: current.link.child_run_id,
              projectId: parent.projectId,
              indexedSessionEventIds: new Set(),
            },
            release: async () => undefined,
          };
        }
        try {
          await this.#reconcileSubagentsAfterRestart(childScope.state, childEvents, recoveryPath);
          childEvents = await this.#ledger.list(current.link.child_run_id);
          childTerminal = childEvents.find((event) => isTerminalEventType(event.type));
          if (childTerminal === undefined) {
            childTerminal = await this.#appendScoped(childScope.state, {
              type: "run.cancelled",
              summary: "Child Run cancelled during Host restart reconciliation",
              idempotency_key: `${current.link.child_run_id}:terminal`,
              data: { reason: "parent_agent_cancel", recovery: true },
            });
          }
        } finally {
          await childScope.release();
        }
      }
      await this.#recordSubagentTerminal(parent, delegation, childTerminal);
    }
    // Repair the narrow crash window where the parent-side G-07 terminal
    // receipt committed but team.member_lost did not. No worker is relaunched
    // and no task is reassigned; retirement only reopens its claimed work.
    parentEvents = await this.#ledger.list(parent.runId);
    projected = projectRun(parentEvents);
    for (const member of projected.team?.roster.members.filter(({ status }) => status === "active") ?? []) {
      const child = projected.subagents.items.find(
        ({ link }) => link.subagent_id === member.link.subagent_id,
      );
      if (child !== undefined && child.status !== "running") {
        await this.#retireTeamMemberIfJoined(parent, member.link);
      }
    }
  }

  async #recordSubagentTerminal(
    parent: SessionScopedState,
    delegation: SubagentStartedData,
    terminal: SessionEvent,
  ): Promise<SubagentResult> {
    const { link } = delegation;
    const childState = this.#runs.get(link.child_run_id);
    const childEvents = await this.#ledger.list(link.child_run_id);
    assertRecoveredChildProvenance(parent, delegation, childEvents);
    const canonicalTerminal = childEvents.find((event) => event.event_id === terminal.event_id);
    if (
      canonicalTerminal === undefined
      || !isTerminalEventType(canonicalTerminal.type)
      || canonicalTerminal.event_hash !== terminal.event_hash
      || canonicalTerminal.run_id !== link.child_run_id
      || canonicalTerminal.project_id !== parent.projectId
      || canonicalTerminal.session_id !== link.child_session_id
    ) {
      throw new RuntimeCommandError(
        "subagent_terminal_proof_invalid",
        "Child terminal proof does not match the delegated child ledger",
      );
    }
    terminal = canonicalTerminal;
    const childProjection = projectRun(childEvents);
    const replayedUsage = subagentUsageFromEvents(childEvents, delegation.spec.budget.max_tokens);
    const usage = childState?.subagentBudget === undefined
      ? replayedUsage
      : {
          steps: childState.turn,
          input_tokens: childState.subagentBudget.inputTokens,
          output_tokens: childState.subagentBudget.outputTokens,
          total_tokens: childState.subagentBudget.inputTokens + childState.subagentBudget.outputTokens,
          confidence: childState.subagentBudget.confidence,
          costs: replayedUsage.costs,
        };
    const budgetExceeded = terminal.type === "run.failed" && (
      terminal.data.code === "subagent_token_budget_exceeded"
      || terminal.data.code === "subagent_step_budget_exceeded"
    );
    const status = terminal.type === "run.completed"
      ? "completed"
      : terminal.type === "run.cancelled"
        ? "interrupted"
        : budgetExceeded
          ? "budget_exceeded"
          : "failed";
    const summary = redactSensitiveText(
      childProjection.outcome ?? terminal.summary ?? "Subagent reached a terminal state",
    ).slice(0, 8_000);
    const result = SubagentResultSchema.parse({
      subagent_id: link.subagent_id,
      child_run_id: link.child_run_id,
      status,
      summary,
      artifact_refs: childProjection.artifact_refs
        .filter((ref) => ref.run_id === link.child_run_id && ref.kind !== "recovery_state")
        .slice(0, 64),
      usage,
    });
    const childTerminalEventHash = terminal.event_hash;
    const terminalKey = `subagent:${sha256(`${parent.runId}:${link.subagent_id}`)}:terminal`;
    await this.#withRunControl(parent.runId, async () => {
      if (status === "completed") {
        await this.#appendScoped(parent, {
          type: "subagent.completed",
          summary,
          idempotency_key: terminalKey,
          operation_id: link.subagent_id,
          data: SubagentCompletedDataSchema.parse({
            link,
            result,
            child_terminal_event_id: terminal.event_id,
            child_terminal_event_hash: childTerminalEventHash,
          }),
        });
      } else if (status === "interrupted") {
        await this.#appendScoped(parent, {
          type: "subagent.interrupted",
          summary,
          idempotency_key: terminalKey,
          operation_id: link.subagent_id,
          data: SubagentInterruptedDataSchema.parse({
            link,
            result,
            reason: terminal.data.reason === undefined ? "parent_interrupt" : String(terminal.data.reason),
            child_terminal_event_id: terminal.event_id,
            child_terminal_event_hash: childTerminalEventHash,
          }),
        });
      } else {
        await this.#appendScoped(parent, {
          type: "subagent.failed",
          summary,
          idempotency_key: terminalKey,
          operation_id: link.subagent_id,
          data: SubagentFailedDataSchema.parse({
            link,
            result,
            reason: budgetExceeded ? "budget_exceeded" : String(terminal.data.code ?? "child_failed").slice(0, 160),
            failure_stage: "execution",
            child_terminal_event_id: terminal.event_id,
            child_terminal_event_hash: childTerminalEventHash,
          }),
        });
      }
    });
    await this.#retireTeamMemberIfJoined(parent, link);
    return result;
  }

  #effectiveToolAllowlist(state: RunState): ReadonlySet<ToolName> {
    // Project capabilities are part of the Host authority boundary, so they
    // must shape the model-visible catalog as well as the later policy check.
    // Previously a no-capability plain-chat workspace still advertised
    // `list_dir`/`read_file`; a provider could then choose one and the Run
    // failed with a capability denial before it ever produced an answer.
    const workspace = new Set<ToolName>();
    for (const definition of this.#toolRegistry.list()) {
      if (
        toolBypassesWorkspaceCapabilities(definition.name)
        || state.workspace.capabilities[definition.capability]
      ) workspace.add(definition.name);
    }

    const parent = state.toolAllowlist;
    const skill = state.skillToolAllowlist;
    if (parent !== undefined) {
      for (const toolName of [...workspace]) {
        if (!parent.has(toolName)) workspace.delete(toolName);
      }
    }
    if (skill !== undefined) {
      for (const toolName of [...workspace]) {
        if (!skill.has(toolName)) workspace.delete(toolName);
      }
    }
    return workspace;
  }

  async #bootstrapRun(state: RunState): Promise<void> {
    if (state.stopped) return;
    if (this.#codeGraph !== undefined && state.workspace.capabilities.index) {
      try {
        const gitContext = await this.#captureCodeIntelGitContext(state);
        state.baseGraph = await this.#captureGraphSnapshot(
          state,
          "Baseline graph snapshot created",
        );
        await this.#appendCodeIntelUpdated(state, {
          phase: "baseline",
          gitContext,
          baseSnapshotId: state.baseGraph.snapshot_id,
          changedFiles: [],
          changedSymbols: [],
        });
        state.codeIntelGitContext = gitContext;
      } catch (error) {
        if (!state.stopped) {
          await this.#fail(state, "indexing_failed", publicError(error));
        }
        return;
      }
    }
    if (state.stopped) return;
    try {
      await this.#continueRun(state);
    } catch (error) {
      if (!state.stopped && !(await this.#isTerminal(state.runId))) {
        await this.#fail(state, "runtime_failed", publicError(error));
      }
    }
  }

  async #continueRun(state: RunState): Promise<void> {
    while (
      !state.stopped
      && state.pendingPatch === undefined
      && state.pendingPlan === undefined
      && !(await this.#isTerminal(state.runId))
    ) {
      if (state.turn >= state.maxTurns) {
        await this.#fail(
          state,
          state.orchestration.depth > 0 ? "subagent_step_budget_exceeded" : "turn_budget_exhausted",
          `Run exceeded the deterministic turn budget after ${state.turn} model turns (limit: ${state.maxTurns})`,
          { turns_completed: state.turn, max_turns: state.maxTurns },
        );
        return;
      }
      const steering = await this.#consumeNextUserInput(state, state.turn + 1);
      if (steering === "cancelled" || state.stopped) return;
      state.turn += 1;
      const turnId = this.#idFactory("turn");
      const modelCallId = this.#idFactory("model-call");
      const tokenMeterIdentity = modelUsageIdentity(state.model);
      const summaryUsage = new Map<string, Map<string, ModelUsageReport>>();
      let contextCompactionStarted = false;
      const retrievedMemory = this.#memory.retrievalAvailable
        ? (await this.#memory.recall({
          projectId: state.projectId,
          runId: state.runId,
          sessionId: state.sessionId,
          query: state.task.slice(0, MAX_MEMORY_QUERY_CHARS),
          budget: this.#retrievalBudget,
          signal: state.abortController.signal,
        })).hits
        : [];
      const extensionSourceEvent = (await this.#ledger.list(state.runId)).at(-1);
      if (extensionSourceEvent === undefined) {
        throw new RuntimeCommandError("run_not_found", "Run is unavailable for extension Context strategies");
      }
      const extensionContext = await this.#extensionManager.collectContextContributions({
        projectId: state.projectId,
        runId: state.runId,
        task: state.task,
        turn: state.turn,
      });
      for (const error of extensionContext.errors) {
        await this.#appendExtensionError(state, error, extensionSourceEvent);
      }
      const extensionObservations = extensionContext.contributions.map((item) => ObservationSchema.parse({
        observation_id: this.#idFactory("extension-observation"),
        action_id: this.#idFactory("extension-context"),
        receipt_id: this.#idFactory("extension-receipt"),
        status: "success",
        summary: item.contribution.summary,
        facts: redactStructuredValue({
          ...(item.contribution.facts ?? {}),
          extension_name: item.extensionName,
          strategy_name: item.strategyName,
        }),
        artifact_refs: [],
        created_at: this.#now().toISOString(),
      }));
      const built = await this.#contextBuilder.buildWithStrategies({
        projectId: state.projectId,
        runId: state.runId,
        turnId,
        modelCallId,
        task: state.task,
        workspaceKind: state.workspace.workspace_kind,
        conversationHistory: state.conversationHistory ?? [],
        observations: [...state.observations, ...extensionObservations],
        skillCatalog: state.skills.skills.map(({ name, description, version, allowed_tools, source }) => ({
          name,
          description,
          version,
          allowed_tools,
          source,
        })),
        retrievedMemory,
        tokenMeterIdentity,
        ...(this.#contextPolicy === undefined ? {} : { contextPolicy: this.#contextPolicy }),
      }, {
        artifactStore: this.#artifacts,
        signal: state.abortController.signal,
        onCompactionStarted: async (details) => {
          if (contextCompactionStarted) return;
          contextCompactionStarted = true;
          await this.#append(state, {
            type: "context.compaction_started",
            summary: contextCompactionStartedSummary(details),
            turn_id: turnId,
            model_call_id: modelCallId,
            data: { ...details },
          });
        },
        ...(state.orchestration.depth > 0 || state.model.summarizeContext === undefined ? {} : {
          summarize: async (summaryInput) => state.model.summarizeContext!({
            ...summaryInput,
            onUsage: (usageValue) => {
              const parsed = ModelUsageReportSchema.safeParse(usageValue);
              if (!parsed.success || parsed.data.request_kind !== "summary") return;
              const reports = summaryUsage.get(summaryInput.modelCallId) ?? new Map<string, ModelUsageReport>();
              if (reports.size >= 16) return;
              const key = `${parsed.data.request_kind}:${parsed.data.request_sequence}`;
              if (!reports.has(key)) reports.set(key, parsed.data);
              summaryUsage.set(summaryInput.modelCallId, reports);
            },
          }),
        }),
      });
      const contextBudget = built.manifest.budget;
      const contextCompression = built.manifest.compression;
      const contextSteps = built.manifest.compaction_steps ?? [];
      const archivedContextArtifacts = [...new Map(
        contextSteps
          .flatMap((step) => step.archived_artifact_refs)
          .map((ref) => [ref.artifact_id, ref]),
      ).values()];
      const manifestArtifact = await this.#artifacts.put({
        projectId: state.projectId,
        runId: state.runId,
        kind: "context_manifest",
        mimeType: "application/json",
        content: JSON.stringify(built.manifest, null, 2),
      });
      for (const notice of built.notices) {
        const noticeModelCallId = notice.type === "context.summary_created" || notice.type === "context.summary_failed"
          ? notice.data.summary_model_call_id
          : notice.model_call_id;
        await this.#append(state, {
          type: notice.type,
          summary: contextBuildNoticeSummary(notice),
          turn_id: turnId,
          model_call_id: noticeModelCallId,
          context_manifest_ref: built.manifest.manifest_id,
          ...(notice.type === "context.summary_failed" ? {} : { artifact_refs: [notice.artifact_ref] }),
          data: notice.data,
        });
      }
      for (const [summaryModelCallId, reports] of summaryUsage) {
        const sourceTokens = built.notices.find((notice) => (
          (notice.type === "context.summary_created" || notice.type === "context.summary_failed")
          && notice.data.summary_model_call_id === summaryModelCallId
        ));
        await this.#flushModelUsage(
          state,
          turnId,
          summaryModelCallId,
          built.manifest.manifest_id,
          sourceTokens?.type === "context.summary_created" ? sourceTokens.data.source_tokens : 0,
          [...reports.values()],
        );
      }
      if (
        contextCompression !== undefined
        && (contextCompression.applied_strategy !== "none" || contextCompactionStarted)
      ) {
        await this.#append(state, {
          type: "context.compaction_completed",
          summary: contextCompactionCompletedSummary(contextCompression),
          turn_id: turnId,
          model_call_id: modelCallId,
          context_manifest_ref: built.manifest.manifest_id,
          artifact_refs: [manifestArtifact, ...archivedContextArtifacts],
          data: {
            strategy: contextCompression.strategy,
            applied_strategy: contextCompression.applied_strategy,
            trigger: contextCompression.trigger,
            before_tokens: contextCompression.before_tokens,
            after_tokens: contextCompression.after_tokens,
            checkpoint_tokens: contextCompression.checkpoint_tokens,
            preserved_recent_message_count: contextCompression.preserved_recent_message_count,
            compacted_history_message_count: contextCompression.compacted_history_message_count,
            steps: contextSteps,
          },
        });
      }
      if (contextBudget?.status === "warning") {
        await this.#append(state, {
          type: "context.budget_warning",
          summary: `Context is at ${built.manifest.input_tokens} of ${contextBudget.input_budget_tokens} estimated input tokens; compression begins at ${contextBudget.compression_threshold_tokens}`,
          turn_id: turnId,
          model_call_id: modelCallId,
          context_manifest_ref: built.manifest.manifest_id,
          artifact_refs: [manifestArtifact],
          data: {
            input_tokens: built.manifest.input_tokens,
            input_budget_tokens: contextBudget.input_budget_tokens,
            warning_threshold_tokens: contextBudget.warning_threshold_tokens,
            compression_threshold_tokens: contextBudget.compression_threshold_tokens,
            token_estimator: contextBudget.token_estimator,
          },
        });
      }
      await this.#append(state, {
        type: "context.built",
        summary: `Context built with ${built.manifest.input_tokens} input tokens`,
        turn_id: turnId,
        model_call_id: modelCallId,
        context_manifest_ref: built.manifest.manifest_id,
        artifact_refs: [manifestArtifact],
        data: {
          manifest_id: built.manifest.manifest_id,
          input_tokens: built.manifest.input_tokens,
          token_limit: built.manifest.token_limit,
          reserved_output_tokens: built.manifest.reserved_output_tokens,
          ...(built.manifest.token_estimate === undefined ? {} : {
            token_estimate: {
              estimator_id: built.manifest.token_estimate.estimator_id,
              confidence: built.manifest.token_estimate.confidence,
              input_tokens: built.manifest.token_estimate.input_tokens,
              output_tokens: built.manifest.token_estimate.output_tokens,
              ...(built.manifest.token_estimate.cached_tokens === undefined
                ? {}
                : { cached_tokens: built.manifest.token_estimate.cached_tokens }),
              per_section: built.manifest.token_estimate.per_section,
            },
          }),
          ...(contextBudget === undefined ? {} : {
            input_budget_tokens: contextBudget.input_budget_tokens,
            warning_threshold_tokens: contextBudget.warning_threshold_tokens,
            compression_threshold_tokens: contextBudget.compression_threshold_tokens,
            token_estimator: contextBudget.token_estimator,
            context_status: contextBudget.status,
          }),
          ...(contextCompression === undefined ? {} : {
            compression: {
              strategy: contextCompression.strategy,
              applied_strategy: contextCompression.applied_strategy,
              trigger: contextCompression.trigger,
              before_tokens: contextCompression.before_tokens,
              after_tokens: contextCompression.after_tokens,
              checkpoint_tokens: contextCompression.checkpoint_tokens,
              preserved_recent_message_count: contextCompression.preserved_recent_message_count,
              compacted_history_message_count: contextCompression.compacted_history_message_count,
              steps: contextSteps,
            },
          }),
        },
      });
      if (state.stopped) return;

      const remainingSubagentTokens = state.subagentBudget === undefined
        ? undefined
        : state.subagentBudget.maxTokens
          - state.subagentBudget.inputTokens
          - state.subagentBudget.outputTokens
          - built.manifest.input_tokens;
      if (remainingSubagentTokens !== undefined && remainingSubagentTokens < 1) {
        await this.#fail(
          state,
          "subagent_token_budget_exceeded",
          "Subagent token budget was exhausted before the next model request",
          {
            max_tokens: state.subagentBudget!.maxTokens,
            consumed_tokens: state.subagentBudget!.inputTokens + state.subagentBudget!.outputTokens,
            next_input_tokens: built.manifest.input_tokens,
          },
        );
        return;
      }

      const reportedUsage = new Map<string, ModelUsageReport>();
      const modelInput: ModelInput = {
        projectId: state.projectId,
        runId: state.runId,
        task: state.task,
        mode: state.mode,
        reasoningEffort: state.reasoningEffort,
        turn: state.turn,
        context: built.modelContext,
        contextManifest: ContextManifestSchema.parse(built.manifest),
        ...(state.turn === 1 && state.modelImages.length > 0
          ? { images: state.modelImages.map((image) => ({ ...image })) }
          : {}),
        observations: built.modelObservations,
        toolSchemas: this.#toolRegistry.modelSchemas(this.#effectiveToolAllowlist(state)),
        ...(state.rolePrompt === undefined ? {} : { rolePrompt: state.rolePrompt }),
        ...(remainingSubagentTokens === undefined ? {} : { maxOutputTokens: remainingSubagentTokens }),
        signal: state.abortController.signal,
        onUsage: (usageValue) => {
          if (reportedUsage.size >= 16) return;
          const parsed = ModelUsageReportSchema.safeParse(usageValue);
          if (!parsed.success) return;
          const key = `${parsed.data.request_kind}:${parsed.data.request_sequence}`;
          if (!reportedUsage.has(key)) reportedUsage.set(key, parsed.data);
        },
      };
      // Keep raw image bytes only in this request object. They must not remain
      // attached to long-lived Run state after the first request is assembled.
      if (modelInput.images !== undefined) state.modelImages.length = 0;
      const modelRequest = publicModelRequestMetadata(state.model, modelInput);
      await this.#append(state, {
        type: "model.request_started",
        summary: modelRequestSummary(modelRequest),
        turn_id: turnId,
        model_call_id: modelCallId,
        context_manifest_ref: built.manifest.manifest_id,
        data: { ...modelRequest },
      });
      if (state.stopped) return;

      modelInput.onPublicProgress = (update) => {
        if (state.stopped) return;
        this.#queueModelSurface(state, modelCallId, update);
      };

      let decision;
      try {
        decision = DecisionSchema.parse(await abortable(
          state.model.decide(modelInput),
          state.abortController.signal,
        ));
        const serializedDecision = JSON.stringify(decision);
        if (
          redactSecrets(serializedDecision) !== serializedDecision
          || containsSensitiveStructuredData(decision)
        ) {
          throw new Error("Decision contained credential-like material");
        }
      } catch (error) {
        this.#flushModelSurfaceForCall(
          state.runId,
          modelCallId,
          state.stopped ? "cancelled" : "failed",
        );
        await this.#flushModelUsage(
          state,
          turnId,
          modelCallId,
          built.manifest.manifest_id,
          built.manifest.input_tokens,
          [...reportedUsage.values()],
        );
        if (state.stopped) return;
        const requestFailed = error instanceof ModelRequestError;
        const errorMessage = publicError(error);
        await this.#append(state, {
          type: requestFailed ? "model.request_failed" : "model.output_invalid",
          summary: requestFailed ? errorMessage : "Model output failed canonical Decision validation",
          turn_id: turnId,
          model_call_id: modelCallId,
          context_manifest_ref: built.manifest.manifest_id,
          data: {
            error: errorMessage,
            ...modelRequest,
            ...(requestFailed ? { code: error.code } : {}),
          },
        });
        await this.#fail(
          state,
          requestFailed ? "model_request_failed" : "model_output_invalid",
          requestFailed ? errorMessage : "Model output was not a valid Decision",
        );
        return;
      }
      await this.#flushModelUsage(
        state,
        turnId,
        modelCallId,
        built.manifest.manifest_id,
        built.manifest.input_tokens,
        [...reportedUsage.values()],
      );
      if (state.stopped) {
        this.#flushModelSurfaceForCall(state.runId, modelCallId, "cancelled");
        await this.#append(state, {
          type: "action.late_ignored",
          summary: "Model result ignored because the run was stopped",
          turn_id: turnId,
          model_call_id: modelCallId,
          context_manifest_ref: built.manifest.manifest_id,
          data: { phase: "model" },
        });
        return;
      }
      if (!this.#chargeSubagentBudget(
        state,
        built.manifest.input_tokens,
        [...reportedUsage.values()],
        decision,
      )) {
        this.#flushModelSurfaceForCall(state.runId, modelCallId, "failed");
        await this.#fail(
          state,
          "subagent_token_budget_exceeded",
          "Subagent provider usage exceeded its hard token budget",
          {
            max_tokens: state.subagentBudget!.maxTokens,
            consumed_tokens: state.subagentBudget!.inputTokens + state.subagentBudget!.outputTokens,
          },
        );
        return;
      }
      // Provider/tool-call IDs are correlation hints, not an idempotency
      // boundary.  DeepSeek-compatible providers and local JSON adapters may
      // reuse a short id such as `action:1` on the next model turn even when
      // the tool or arguments changed.  Normalize that collision before the
      // decision is written or executed.  The original id is retained only as
      // redacted audit metadata; all receipts/observations use the canonical
      // runtime-owned id.
      const actionRepair = this.#repairActionIdentities(state, decision);
      decision = actionRepair.decision;
      const decisionCalls = decisionToolCalls(decision);
      // A public preview becomes complete only after the complete Decision has
      // passed both schema and credential checks. Before this point it remains
      // an untrusted, volatile preview rather than a completed answer.
      // Replace the volatile provider preview with a short, safe public plan
      // once the full Decision is validated. Providers sometimes echo the
      // answer into `public_reason`; keeping that text would make the UI look
      // as if it were exposing model chain-of-thought. The durable activity
      // and the final model surface use the same normalized summary.
      this.#flushModelSurfaceForCall(
        state.runId,
        modelCallId,
        "completed",
        publicPlanForDecision(decision),
      );
      const publicDecision = publicDecisionActivity(decision);
      await this.#append(state, {
        type: "model.decision",
        summary: publicDecision.summary,
        turn_id: turnId,
        model_call_id: modelCallId,
        context_manifest_ref: built.manifest.manifest_id,
        ...(decisionCalls.length === 1 ? { action_id: decisionCalls[0]!.action_id } : {}),
        data: {
          ...publicDecision.data,
          ...modelRequest,
          ...(state.subagentBudget === undefined ? {} : {
            _internal_subagent_budget: {
              max_tokens: state.subagentBudget.maxTokens,
              input_tokens: state.subagentBudget.inputTokens,
              output_tokens: state.subagentBudget.outputTokens,
              confidence: state.subagentBudget.confidence,
            },
          }),
          ...(actionRepair.repairs.length === 0 ? {} : {
            action_id_repaired: true,
            action_id_repairs: actionRepair.repairs.map((repair) => ({
              model_action_id: redactSensitiveText(repair.modelActionId).slice(0, 160),
              canonical_action_id: repair.canonicalActionId,
              code: repair.code,
            })),
            ...(actionRepair.repairs.length !== 1 ? {} : {
              model_action_id: redactSensitiveText(actionRepair.repairs[0]!.modelActionId).slice(0, 160),
              canonical_action_id: actionRepair.repairs[0]!.canonicalActionId,
              action_id_repair_code: actionRepair.repairs[0]!.code,
            }),
          }),
        },
      });
      if (decision.kind === "finish") {
        const outcome = decision.final_answer ?? "Run completed";
        if (await this.#transitionAfterFinish(state, outcome)) return;
        continue;
      }
      if (decisionCalls.length === 0) {
        await this.#fail(state, "missing_tool_call", "Tool Decision did not include a ToolCall");
        return;
      }

      // Validate the complete batch before starting any member. A denied or
      // malformed later call must never arrive after an earlier side effect.
      const preparedCalls: PreparedToolCall[] = [];
      const signatures: Array<{ actionId: string; signature: string }> = [];
      for (const [index, call] of decisionCalls.entries()) {
        const actionSignature = commandSignature({
          tool_name: call.tool_name,
          arguments: call.arguments,
        });
        const priorActionSignature = state.actionSignatures.get(call.action_id);
        if (priorActionSignature !== undefined) {
          const code = priorActionSignature === actionSignature
            ? "action_id_duplicate"
            : "action_id_conflict";
          await this.#append(state, {
            type: "action.rejected",
            summary: "Model reused an action_id; duplicate tool execution was blocked",
            action_id: call.action_id,
            data: { code },
          });
          await this.#fail(state, code, "Model action_id values must be unique within a Run");
          return;
        }
        try {
          const registeredDefinition = this.#toolRegistry.get(call.tool_name);
          if (state.skillToolAllowlist !== undefined && !state.skillToolAllowlist.has(call.tool_name)) {
            const actionDigest = approvalActionDigest({
              projectId: state.projectId,
              runId: state.runId,
              actionId: call.action_id,
              toolName: call.tool_name,
              workspaceHandleId: state.workspace.handle_id,
              policyDigest: state.permissionPolicy.policy_digest,
              arguments: call.arguments,
              scope: ["."],
            });
            const denial = this.#skillAllowlistDenialDecision(
              state,
              call,
              registeredDefinition?.sideEffect ?? "none",
              actionDigest,
            );
            await this.#appendPolicyDecision(state, call.action_id, denial);
            await this.#appendPolicyDenied(state, call.action_id, denial, "skill_tool_denied");
            await this.#fail(state, "skill_tool_denied", denial.explanation);
            return;
          }
          if (state.toolAllowlist !== undefined && !state.toolAllowlist.has(call.tool_name)) {
            const actionDigest = approvalActionDigest({
              projectId: state.projectId,
              runId: state.runId,
              actionId: call.action_id,
              toolName: call.tool_name,
              workspaceHandleId: state.workspace.handle_id,
              policyDigest: state.permissionPolicy.policy_digest,
              arguments: call.arguments,
              scope: ["."],
            });
            const denial = this.#subagentAllowlistDenialDecision(
              state,
              call,
              registeredDefinition?.sideEffect ?? "none",
              actionDigest,
            );
            await this.#appendPolicyDecision(state, call.action_id, denial);
            await this.#appendPolicyDenied(state, call.action_id, denial, "subagent_tool_denied");
            await this.#fail(state, "subagent_tool_denied", denial.explanation);
            return;
          }
          if (
            state.mode === "plan"
            && registeredDefinition !== undefined
            && !isPlanModeDefinitionAllowed(registeredDefinition)
          ) {
            // Plan authority is decided from trusted registry metadata before
            // parsing provider-supplied arguments. A malformed write/execute
            // payload must not disguise the more important plan-mode denial.
            const actionDigest = approvalActionDigest({
              projectId: state.projectId,
              runId: state.runId,
              actionId: call.action_id,
              toolName: call.tool_name,
              workspaceHandleId: state.workspace.handle_id,
              policyDigest: state.permissionPolicy.policy_digest,
              arguments: call.arguments,
              scope: ["."],
            });
            const denial = this.#planModeDenialDecision(
              state,
              call,
              registeredDefinition,
              actionDigest,
            );
            await this.#appendPolicyDecision(state, call.action_id, denial);
            await this.#appendPolicyDenied(state, call.action_id, denial, "plan_mode_denied");
            await this.#fail(state, "plan_mode_denied", denial.explanation);
            return;
          }
          const validated = validateToolCall({
            call,
            registry: this.#toolRegistry,
            projectId: state.projectId,
            runId: state.runId,
            workspace: state.workspace,
            mode: state.mode,
            sandboxMode: state.permissionPolicy.preset.sandbox_mode,
            now: this.#now(),
            policyPrevalidated: true,
          });
          const policyTarget = policyTargetForCall(validated.parsedInput);
          const actionDigest = approvalActionDigest({
            projectId: state.projectId,
            runId: state.runId,
            actionId: call.action_id,
            toolName: call.tool_name,
            workspaceHandleId: state.workspace.handle_id,
            policyDigest: state.permissionPolicy.policy_digest,
            arguments: call.arguments,
            ...(policyTarget.path === undefined ? {} : { path: policyTarget.path }),
            scope: policyTarget.path === undefined ? ["."] : [policyTarget.path],
          });
          if (state.mode === "plan" && !isPlanModeToolAllowed(validated)) {
            const denial = this.#planModeDenialDecision(state, call, validated.definition, actionDigest);
            await this.#appendPolicyDecision(state, call.action_id, denial);
            await this.#appendPolicyDenied(state, call.action_id, denial, "plan_mode_denied");
            await this.#fail(state, "plan_mode_denied", denial.explanation);
            return;
          }
          const capabilityAllowed = toolBypassesWorkspaceCapabilities(call.tool_name)
            || state.workspace.capabilities[validated.definition.capability];
          const policyDecision = state.policyEngine.evaluate({
            toolName: call.tool_name,
            sideEffect: validated.definition.sideEffect,
            capabilityAllowed,
            runMode: state.mode,
            ...(policyTarget.path === undefined ? {} : { path: policyTarget.path }),
            ...(policyTarget.diffLines === undefined ? {} : { diffLines: policyTarget.diffLines }),
            actionDigest,
          });
          await this.#appendPolicyDecision(state, call.action_id, policyDecision);
          if (policyDecision.kind === "deny") {
            const denialCode = policyDenialCode(policyDecision);
            await this.#appendPolicyDenied(state, call.action_id, policyDecision, denialCode);
            await this.#fail(state, denialCode, policyDecision.explanation);
            return;
          }
          if (call.tool_name === "commit_patch") {
            await this.#append(state, {
              type: "action.rejected",
              summary: "commit_patch requires a Runtime-created preview and bound one-time authorization",
              action_id: call.action_id,
              data: { code: "approval_preview_required", failure_class: "denied" },
            });
            await this.#fail(state, "approval_preview_required", "Direct commit_patch calls are not allowed");
            return;
          }
          const executionBinding = policyDecision.kind === "ask"
            ? await this.#answerPolicyApproval(state, call, policyDecision)
            : {
                kind: "policy-allow" as const,
                actionDigest,
                policyDigest: state.permissionPolicy.policy_digest,
              };
          if (executionBinding === undefined) return;
          preparedCalls.push({
            index,
            call,
            validated,
            policyDecision,
            executionBinding,
            ...toolSerializationReason(validated, policyDecision),
          });
          signatures.push({ actionId: call.action_id, signature: actionSignature });
        } catch (error) {
          if (!(error instanceof ActionRejectedError)) throw error;
          await this.#append(state, {
            type: error.code === "capability_denied"
              || error.code === "plan_mode_denied"
              || error.code === "sandbox_denied"
              ? "policy.denied"
              : "action.rejected",
            summary: error.message,
            action_id: call.action_id,
            data: {
              code: error.code,
              failure_class: actionRejectionFailureCode(error.code),
            },
          });
          await this.#fail(state, error.code, error.message);
          return;
        }
      }
      for (const { actionId, signature } of signatures) state.actionSignatures.set(actionId, signature);

      const isBatch = decision.tool_calls !== undefined;
      const batchId = isBatch ? this.#idFactory("tool-batch") : undefined;
      const actionIds = preparedCalls.map(({ call }) => call.action_id);
      const plannedEffectiveConcurrency = plannedToolConcurrency(preparedCalls, this.#maxToolConcurrency);
      const serializedActions = preparedCalls.flatMap(({ call, serializedReason }) => (
        serializedReason === undefined ? [] : [{ action_id: call.action_id, reason: serializedReason }]
      ));
      let batchStartedEvent: SessionEvent | undefined;
      const batchStartedAt = this.#now();
      if (batchId !== undefined) {
        const data = ToolBatchStartedDataSchema.parse({
          batch_id: batchId,
          requested_count: preparedCalls.length,
          max_concurrency: this.#maxToolConcurrency,
          effective_concurrency: plannedEffectiveConcurrency,
          action_ids: actionIds,
          parallel_action_ids: preparedCalls
            .filter(({ serializedReason }) => serializedReason === undefined)
            .map(({ call }) => call.action_id),
          serialized_actions: serializedActions,
        });
        batchStartedEvent = await this.#withRunControl(state.runId, async () => {
          const events = await this.#ledger.list(state.runId);
          if (
            events.some((event) => isTerminalEventType(event.type))
            || state.stopped
            || state.cancelInputId !== undefined
            || projectRun(events).input_queue.pending.some((input) => input.kind === "cancel")
          ) return undefined;
          return this.#append(state, {
            type: "tool.batch_started",
            summary: `Started a checked batch of ${preparedCalls.length} tool calls`,
            operation_id: batchId,
            data,
          });
        });
        // Cancellation and batch publication share the control gate. If the
        // durable cancel wins, no new batch authority or scheduler work starts;
        // if the batch wins, its already-started work may settle normally.
        if (batchStartedEvent === undefined) return;
      }

      const scheduled = await this.#scheduleToolCalls(state, preparedCalls);
      for (const { prepared, executed } of scheduled.completed) {
        state.observations.push(observationWithEligibleEvidence(executed.observation, executed.event));
        if (prepared.call.tool_name === "run_test") {
          await this.#append(state, {
            type: "test.completed",
            summary: executed.raw.summary,
            action_id: prepared.call.action_id,
            ...(state.lastPatchEventId === undefined
              ? {}
              : { patch_event_id: state.lastPatchEventId }),
            test_receipt_id: executed.receipt.receipt_id,
            artifact_refs: executed.artifactRefs,
            data: {
              receipt: executed.receipt,
              ...(executed.sandboxReport === undefined
                ? {}
                : { sandbox_report: executed.sandboxReport }),
            },
          });
        }
      }
      const firstFailure = scheduled.completed.find(({ executed }) => executed.raw.status !== "success");
      const preview = scheduled.completed.find(({ prepared, executed }) => (
        prepared.call.tool_name === "preview_patch" && executed.raw.status === "success"
      ));
      if (batchId !== undefined) {
        const completedAt = this.#now();
        const results = scheduled.completed.map(({ prepared, executed }) => ({
          action_id: prepared.call.action_id,
          status: executed.raw.status,
          duration_ms: executed.receipt.duration_ms,
          code: executed.raw.code,
          ...(executed.raw.status === "success" ? {} : { failure_code: toolBatchFailureCode(executed.raw) }),
        }));
        const data = ToolBatchCompletedDataSchema.parse({
          batch_id: batchId,
          requested_count: preparedCalls.length,
          completed_count: results.length,
          failed_count: results.filter(({ status }) => status !== "success").length,
          max_concurrency: this.#maxToolConcurrency,
          effective_concurrency: scheduled.actualPeakConcurrency,
          total_duration_ms: Math.max(0, completedAt.getTime() - batchStartedAt.getTime()),
          action_ids: actionIds,
          results,
        });
        await this.#append(state, {
          type: "tool.batch_completed",
          summary: `Completed ${results.length} of ${preparedCalls.length} checked tool calls`,
          operation_id: batchId,
          ...(batchStartedEvent === undefined ? {} : { caused_by_event_id: batchStartedEvent.event_id }),
          data,
        });
      }
      if (state.stopped) return;
      if (preview !== undefined) {
        await this.#createPendingPatch(state, preview.prepared.call, preview.executed);
      }
      if (state.stopped) return;
      if (firstFailure?.executed.raw.code === "subagent_recovery_pending") {
        // The parent must remain nonterminal while its child link is active.
        // Startup reconciliation will close the child and append the
        // hash-linked parent receipt before marking the parent interrupted.
        return;
      }
      if (firstFailure?.executed.raw.status === "unknown") {
        await this.#fail(state, "unknown_side_effect", "Tool outcome is unknown; automatic retry is disabled");
        return;
      }
      if (firstFailure !== undefined) {
        await this.#fail(state, firstFailure.executed.raw.code, firstFailure.executed.raw.summary);
        return;
      }
      if (preview !== undefined) return;
    }
  }

  /**
   * Atomically decide whether a validated finish Decision may transition the
   * Run. A user input queued while the provider was working wins the control
   * gate, so the Decision is treated as stale and the next loop consumes one
   * mailbox item before issuing another model request.
   */
  async #transitionAfterFinish(state: RunState, outcome: string): Promise<boolean> {
    return this.#withRunControl(state.runId, async () => {
      const events = await this.#ledger.list(state.runId);
      if (events.some((event) => isTerminalEventType(event.type))) return true;
      if (projectRun(events).input_queue.pending.length > 0) return false;

      if (state.mode === "plan") {
        const todos = projectTodos(events);
        if (todos.items.length === 0) {
          await this.#appendTerminalLocked(
            state,
            "run.failed",
            "Plan Mode must create at least one Todo before requesting approval",
            { code: "plan_missing_todos" },
          );
          return true;
        }
        const data = PlanReadyDataSchema.parse({
          todo_ids: todos.items.map(({ todo_id: todoId }) => todoId),
          todo_count: todos.items.length,
        });
        const ready = await this.#append(state, {
          type: "plan.ready",
          summary: "Plan is ready for approval",
          idempotency_key: `${state.runId}:plan.ready`,
          data,
        });
        state.pendingPlan = { planEventId: ready.event_id, todoIds: data.todo_ids };
        return true;
      }

      await this.#appendTerminalLocked(
        state,
        "run.completed",
        "Run completed",
        { code: "completed", outcome },
      );
      return true;
    });
  }

  async #flushModelUsage(
    state: RunState,
    turnId: string,
    modelCallId: string,
    contextManifestRef: string,
    estimatedInputTokens: number,
    reports: readonly ModelUsageReport[],
  ): Promise<void> {
    const orderedReports = [...reports].sort((left, right) => (
      left.request_sequence - right.request_sequence
      || left.request_kind.localeCompare(right.request_kind)
    ));
    for (const usage of orderedReports) {
      let data: Record<string, unknown>;
      let anomaly = false;
      if (usage.request_kind === "initial") {
        try {
          const observation = await this.#tokenMeter.observeUsage(
            modelCallId,
            usage,
            estimatedInputTokens,
          );
          anomaly = observation.anomaly;
          data = {
            ...observation,
            cost_status: usage.provider_reported_cost === undefined
              ? "unavailable"
              : "provider_reported",
          };
        } catch {
          // A provider report is still useful audit evidence when calibration
          // storage or binding fails. Metering is never allowed to fail the
          // model call that produced it.
          data = uncalibratedUsageData(modelCallId, usage, estimatedInputTokens);
          anomaly = data.anomaly === true;
        }
      } else {
        // Repair is a second, differently-shaped request. Comparing it with
        // the initial Context Manifest would poison provider/model calibration.
        data = uncalibratedUsageData(modelCallId, usage);
      }

      const usageKey = `${modelCallId}:${usage.request_kind}:${usage.request_sequence}`;
      try {
        await this.#append(state, {
          type: "model.usage_reported",
          summary: `${usage.provider} reported ${usage.total_tokens} tokens for the ${usage.request_kind} model request`,
          idempotency_key: `model-usage:${sha256(usageKey)}`,
          turn_id: turnId,
          model_call_id: modelCallId,
          context_manifest_ref: contextManifestRef,
          data,
        });
      } catch {
        // Usage is optional accounting metadata. A late terminal race, a
        // malformed third-party adapter, or calibration persistence failure
        // must not change the Run outcome.
        continue;
      }
      if (!anomaly) continue;
      try {
        await this.#append(state, {
          type: "model.usage_anomaly",
          summary: "Provider-reported input usage differs from the preflight estimate by more than 25%",
          idempotency_key: `model-usage-anomaly:${sha256(usageKey)}`,
          turn_id: turnId,
          model_call_id: modelCallId,
          context_manifest_ref: contextManifestRef,
          data,
        });
      } catch {
        // The canonical usage report above remains sufficient evidence if the
        // derived warning cannot be appended during shutdown.
      }
    }
  }

  #chargeSubagentBudget(
    state: RunState,
    estimatedInputTokens: number,
    reports: readonly ModelUsageReport[],
    decision: Decision,
  ): boolean {
    const budget = state.subagentBudget;
    if (budget === undefined) return true;
    let inputTokens: number;
    let outputTokens: number;
    if (reports.length > 0) {
      inputTokens = reports.reduce((total, report) => total + report.input_tokens, 0);
      outputTokens = reports.reduce((total, report) => total + report.output_tokens, 0);
      budget.confidence = "provider_reported";
    } else {
      inputTokens = estimatedInputTokens;
      outputTokens = estimateTokens(JSON.stringify(decision));
      budget.confidence = "estimated";
    }
    budget.inputTokens += inputTokens;
    budget.outputTokens += outputTokens;
    return budget.inputTokens + budget.outputTokens <= budget.maxTokens;
  }

  #repairActionIdentities(state: RunState, decision: Decision): {
    decision: Decision;
    repairs: readonly ActionIdentityRepair[];
  } {
    const calls = decisionToolCalls(decision);
    if (decision.kind !== "tool_call" || calls.length === 0) {
      return { decision, repairs: [] };
    }
    const reservedIds = new Set(calls.map(({ action_id: actionId }) => actionId));
    const repairs: ActionIdentityRepair[] = [];
    const repairedCalls = calls.map((call) => {
      const signature = commandSignature({
        tool_name: call.tool_name,
        arguments: call.arguments,
      });
      const priorSignature = state.actionSignatures.get(call.action_id);
      if (priorSignature === undefined || priorSignature === signature) return call;

      // The model has issued a different call under an already-used provider
      // id. Mint a deterministic run-local identity without colliding with a
      // sibling in the same batch.
      let canonicalActionId: string;
      do {
        canonicalActionId = `action:runtime:${state.turn}:${++state.canonicalActionSequence}`;
      } while (state.actionSignatures.has(canonicalActionId) || reservedIds.has(canonicalActionId));
      reservedIds.add(canonicalActionId);
      repairs.push({
        code: "action_id_conflict",
        modelActionId: call.action_id,
        canonicalActionId,
      });
      return { ...call, action_id: canonicalActionId };
    });
    return {
      decision: decision.tool_calls === undefined
        ? { ...decision, tool_call: repairedCalls[0] }
        : { ...decision, tool_calls: repairedCalls },
      repairs,
    };
  }

  async #executeTool(
    state: RunState,
    call: ToolCall,
    executionBinding: ToolExecutionBinding,
  ): Promise<ExecutedTool | undefined> {
    if (executionBinding.policyDigest !== state.permissionPolicy.policy_digest) {
      await this.#append(state, {
        type: "action.rejected",
        summary: "Tool execution binding belongs to a different effective policy",
        action_id: call.action_id,
        data: { code: "policy_digest_mismatch", failure_class: "denied" },
      });
      await this.#fail(
        state,
        "policy_digest_mismatch",
        "The tool execution binding does not match the Run policy",
      );
      return undefined;
    }
    const validated = validateToolCall({
      call,
      registry: this.#toolRegistry,
      projectId: state.projectId,
      runId: state.runId,
      workspace: state.workspace,
      mode: state.mode,
      sandboxMode: state.permissionPolicy.preset.sandbox_mode,
      now: this.#now(),
      ...(executionBinding.kind !== "approved-once" ? {} : {
        approvalId: executionBinding.approvalId,
        approvalTokenId: executionBinding.approvalTokenId,
      }),
      actionDigest: executionBinding.actionDigest,
      policyDigest: executionBinding.policyDigest,
      policyPrevalidated: true,
    });
    if (executionBinding.kind === "approved-once") {
      ApprovalBoundValidatedActionSchema.parse(validated.action);
    }
    // Approval proves user intent for one exact write; it cannot widen a
    // delegated child's frozen capability ceiling. This guard covers direct
    // post-approval execution paths which do not return through the model-loop
    // prepare/final-authorization checks.
    if (state.toolAllowlist !== undefined && !state.toolAllowlist.has(call.tool_name)) {
      const denial = this.#subagentAllowlistDenialDecision(
        state,
        call,
        validated.definition.sideEffect,
        executionBinding.actionDigest,
      );
      await this.#appendPolicyDecision(state, call.action_id, denial);
      await this.#appendPolicyDenied(state, call.action_id, denial, "subagent_tool_denied");
      await this.#fail(state, "subagent_tool_denied", denial.explanation);
      return undefined;
    }
    if (state.skillToolAllowlist !== undefined && !state.skillToolAllowlist.has(call.tool_name)) {
      const denial = this.#skillAllowlistDenialDecision(
        state,
        call,
        validated.definition.sideEffect,
        executionBinding.actionDigest,
      );
      await this.#appendPolicyDecision(state, call.action_id, denial);
      await this.#appendPolicyDenied(state, call.action_id, denial, "skill_tool_denied");
      await this.#fail(state, "skill_tool_denied", denial.explanation);
      return undefined;
    }
    if (state.mode === "plan" && !isPlanModeToolAllowed(validated)) {
      const denial = this.#planModeDenialDecision(
        state,
        call,
        validated.definition,
        executionBinding.actionDigest,
      );
      await this.#appendPolicyDecision(state, call.action_id, denial);
      await this.#appendPolicyDenied(state, call.action_id, denial, "plan_mode_denied");
      await this.#fail(state, "plan_mode_denied", denial.explanation);
      return undefined;
    }
    const policyDecision = state.policyEngine.evaluate({
      toolName: call.tool_name,
      sideEffect: validated.definition.sideEffect,
      capabilityAllowed: toolBypassesWorkspaceCapabilities(call.tool_name)
        || state.workspace.capabilities[validated.definition.capability],
      runMode: state.mode,
      ...policyTargetForCall(validated.parsedInput),
      actionDigest: executionBinding.actionDigest,
    });
    if (policyDecision.kind === "deny") {
      const denialCode = policyDenialCode(policyDecision);
      await this.#appendPolicyDecision(state, call.action_id, policyDecision);
      await this.#appendPolicyDenied(state, call.action_id, policyDecision, denialCode);
      await this.#fail(state, denialCode, policyDecision.explanation);
      return undefined;
    }
    if (policyDecision.kind === "ask" && executionBinding.kind !== "approved-once") {
      await this.#appendPolicyDecision(state, call.action_id, policyDecision);
      await this.#append(state, {
        type: "action.rejected",
        summary: "Final policy evaluation requires a one-time approval",
        action_id: call.action_id,
        data: { code: "approval_required", failure_class: "denied" },
      });
      await this.#fail(state, "approval_required", "The tool action requires a one-time approval");
      return undefined;
    }
    const prepared: PreparedToolCall = {
      index: 0,
      call,
      validated,
      policyDecision,
      executionBinding,
      ...toolSerializationReason(validated, policyDecision),
    };
    const startedAt = await this.#recordToolStarted(state, prepared);
    if (startedAt === undefined) return undefined;
    const pending = await this.#runPreparedTool(state, prepared, startedAt);
    return this.#recordToolCompleted(state, prepared, pending);
  }

  async #recordToolStarted(state: RunState, prepared: PreparedToolCall): Promise<Date | undefined> {
    return this.#withRunControl(state.runId, async () => {
      const events = await this.#ledger.list(state.runId);
      try {
        this.#assertControlMutationAllowedLocked(state, events);
      } catch (error) {
        if (error instanceof RuntimeCommandError && (
          error.code === "run_cancelling" || error.code === "run_terminal"
        )) return undefined;
        throw error;
      }
      const startedAt = this.#now();
      const publicActivity = publicToolActivity(prepared.call.tool_name, prepared.validated.parsedInput);
      await this.#append(state, {
        type: "tool.started",
        summary: publicActivity.summary,
        action_id: prepared.call.action_id,
        operation_id: prepared.call.action_id,
        data: publicActivity.data,
      });
      return startedAt;
    });
  }

  async #runPreparedTool(
    state: RunState,
    prepared: PreparedToolCall,
    startedAt: Date,
  ): Promise<PendingToolExecution> {
    const { call, validated } = prepared;
    let raw: RawToolResult;
    let transportFailed = false;
    let appliedWalRecord: ActionWalRecord | undefined;
    let walTransactionId: string | undefined;
    let refetchedContextArtifact: ArtifactRef | undefined;
    let refetchedContextRange: {
      offset: number;
      returnedBytes: number;
      totalBytes: number;
      nextOffset?: number;
      truncated: boolean;
    } | undefined;
    const cancellationShield = validated.definition.sideEffect === "write"
      || call.tool_name === "spawn_subagent"
      ? createToolCancellationShield()
      : undefined;
    try {
      raw = await executeToolDefinition(validated.definition, validated.parsedInput, {
        projectId: state.projectId,
        runId: state.runId,
        workspace: state.workspace,
        signal: state.abortController.signal,
        sandboxMode: state.permissionPolicy.preset.sandbox_mode,
        sandboxRunner: this.#sandboxRunner,
        todos: {
          read: () => this.#todos.read(state.runId),
          write: (input) => this.#todos.write({
            projectId: state.projectId,
            runId: state.runId,
            sessionId: state.sessionId,
            updatedBy: "model",
            idempotencyKey: `todo-action:${sha256(call.action_id)}`,
          }, input),
        },
        subagents: {
          spawn: (input, control) => this.#spawnSubagent(state, input, call.action_id, control),
          sendMessage: (input) => this.#sendSubagentMessage(state, input),
          list: (input) => this.#listSubagents(state, input),
          interrupt: (input) => this.#interruptSubagent(state, input),
        },
        team: this.#teamToolBridge(state, call.action_id),
        skills: this.#skillToolBridge(state),
        ...(this.#mcpManager === undefined ? {} : {
          mcp: {
            call: (entry: unknown, input: Record<string, unknown>, signal?: AbortSignal) => (
              this.#mcpManager!.callTool(
                entry as McpToolCatalogEntry,
                input,
                signal,
                (event) => this.#appendMcpEvent(state, event),
              )
            ),
          } satisfies McpToolBridge,
        }),
        ...(this.#lspManager === undefined ? {} : {
          lsp: {
            getDiagnostics: async (input: unknown, signal?: AbortSignal) => {
              const request = LspDiagnosticsRequestSchema.parse(input);
              const diagnosticsInput = {
                projectId: state.projectId,
                workspaceRoot: state.workspace.real_root,
                request,
                ...(signal === undefined ? {} : { signal }),
              };
              const result = await this.#lspManager!.diagnostics(
                diagnosticsInput,
                (event) => this.#appendLspEvent(state, event),
              );
              return lspResultToRaw(result);
            },
          } satisfies LspToolBridge,
        }),
        ...(cancellationShield === undefined ? {} : { cancellationShield }),
        isHostBoundaryError: (error) => (
          error instanceof ActionCommitInterruptedError || error instanceof ActionWalError
        ),
        readArtifact: async ({ locator, offset, limit }) => {
          const artifactId = parseArtifactLocator(locator);
          const result = await this.#artifacts.getInternal({
            artifactId,
            projectId: state.projectId,
            runId: state.runId,
          });
          if (result.status !== "available") {
            throw new Error(`Archived Context source is ${result.status}`);
          }
          if (
            result.artifact.kind !== "spilled_tool_output"
            && result.artifact.kind !== "context_source_archive"
          ) {
            throw new Error("Artifact locator does not reference an archived Context source");
          }
          refetchedContextArtifact = result.artifact;
          const chunk = boundedUtf8Chunk(result.content, offset, limit);
          refetchedContextRange = chunk;
          return {
            artifactId: result.artifact.artifact_id,
            content: chunk.content,
            contentHash: result.artifact.content_hash,
            mimeType: result.artifact.mime_type,
            offset: chunk.offset,
            returnedBytes: chunk.returnedBytes,
            totalBytes: chunk.totalBytes,
            ...(chunk.nextOffset === undefined ? {} : { nextOffset: chunk.nextOffset }),
            truncated: chunk.truncated,
          };
        },
        listArtifacts: async () => {
          const events = await this.#ledger.list(state.runId);
          const visible = new Map<string, ArtifactRef>();
          for (const event of events) {
            for (const ref of event.artifact_refs) {
              if (
                ref.project_id !== state.projectId
                || ref.run_id !== state.runId
                || ref.kind === "recovery_state"
              ) continue;
              if (!visible.has(ref.artifact_id)) visible.set(ref.artifact_id, ref);
            }
          }
          return [...visible.values()].sort((left, right) => (
            left.created_at.localeCompare(right.created_at)
            || left.artifact_id.localeCompare(right.artifact_id)
          ));
        },
        ...(call.tool_name !== "commit_patch" ? {} : {
          patchMutation: {
            prepare: async (snapshot: PatchMutationSnapshot) => {
              if (
                prepared.executionBinding === undefined
                || sha256(snapshot.absolutePath) !== prepared.executionBinding.canonicalTargetDigest
              ) {
                throw new ActionRejectedError(
                  "action_digest_mismatch",
                  "Patch canonical target changed after authorization and before mutation",
                );
              }
              try {
                const canonicalRoot = await realpath(state.workspace.real_root);
                const preparedWalRecord = await this.#actionWal.prepareAction({
                  projectId: state.projectId,
                  runId: state.runId,
                  actionId: call.action_id,
                  workspaceHandleId: state.workspace.handle_id,
                  workspaceRootHash: sha256(canonicalRoot),
                  workspaceKind: state.workspace.workspace_kind,
                  patchHash: snapshot.afterHash,
                  targets: [{
                    targetPath: snapshot.relativePath,
                    existed: snapshot.existed,
                    ...(snapshot.existed ? { beforeContent: snapshot.before } : {}),
                    afterHash: snapshot.afterHash,
                  }],
                });
                walTransactionId = preparedWalRecord.wal_id;
                await this.#injectActionFault("after_prepare_before_apply");
              } catch (error) {
                throw actionCommitInterrupted("Action WAL prepare did not complete", error);
              }
            },
            applied: async (snapshot: PatchMutationSnapshot) => {
              try {
                const actual = await readFile(snapshot.absolutePath);
                if (sha256(actual) !== snapshot.afterHash) {
                  throw new Error("Committed patch bytes do not match the approved after hash");
                }
                await this.#injectActionFault("after_apply_before_applied");
                appliedWalRecord = await this.#actionWal.advance({
                  runId: state.runId,
                  actionId: call.action_id,
                  phase: "applied",
                });
                await this.#injectActionFault("after_applied_before_event");
              } catch (error) {
                throw actionCommitInterrupted("Applied patch could not cross the WAL boundary", error);
              }
            },
          },
        }),
      });
    } catch (error) {
      if (error instanceof ActionCommitInterruptedError || error instanceof ActionWalError) {
        throw error;
      }
      transportFailed = true;
      raw = {
        status: "failure",
        code: "internal",
        summary: publicError(error),
      };
    }
    raw = {
      ...raw,
      code: redactSensitiveText(raw.code).slice(0, 160),
      summary: redactSensitiveText(raw.summary).slice(0, 2_000),
    };
    let sandboxReport: SandboxReport | undefined;
    if (call.tool_name === "run_test") {
      const sandboxMode = state.permissionPolicy.preset.sandbox_mode;
      const parsed = SandboxReportSchema.safeParse(raw.facts?.sandbox_report);
      if (parsed.success && parsed.data.mode === sandboxMode) {
        sandboxReport = parsed.data;
        const executableEnforcement = sandboxMode === "danger-full-access"
          ? sandboxReport.enforcement === "none"
          : sandboxReport.enforcement === "full";
        if (raw.status === "success" && (raw.facts?.started !== true || !executableEnforcement)) {
          raw = {
            status: "failure",
            code: "sandbox_unavailable",
            summary: "Test execution was rejected because the sandbox evidence does not prove an allowed start",
            facts: { sandbox_report: sandboxReport, started: false },
          };
        }
      } else {
        const probed = await this.#probeSandbox(state.workspace, sandboxMode);
        sandboxReport = sandboxMode === "danger-full-access"
          ? probed
          : unavailableSandboxReport(
            sandboxMode,
            probed.platform,
            "sandbox_execution_report_invalid",
          );
        raw = {
          status: "failure",
          code: "sandbox_unavailable",
          summary: "Test execution was blocked because the sandbox result could not be verified",
          facts: { sandbox_report: sandboxReport, started: false },
        };
      }
    }
    const completedAt = this.#now();
    const reusedContextArtifact = call.tool_name === "read_artifact"
      && raw.status === "success"
      ? refetchedContextArtifact
      : undefined;
    const reusesRefetchedContextArtifact = reusedContextArtifact !== undefined;
    const listsArtifactMetadata = call.tool_name === "list_artifacts" && raw.status === "success";
    // A read_artifact page is a bounded view over the original run-scoped
    // archive. Reference that archive directly; never duplicate each page as
    // a new tool_output Artifact.
    const artifactRefs: ArtifactRef[] = reusedContextArtifact === undefined
      ? []
      : [reusedContextArtifact];
    // list_artifacts is a bounded metadata view over canonical refs. Persisting
    // its JSON response would make each listing appear in the next listing and
    // recursively pollute the run Artifact index.
    let artifactContent = reusesRefetchedContextArtifact || listsArtifactMetadata
      ? undefined
      : raw.content;
    let artifactMimeType = raw.mimeType ?? "text/plain";
    if (
      !reusesRefetchedContextArtifact
      && !listsArtifactMetadata
      && artifactContent === undefined
      && raw.facts !== undefined
    ) {
      const serializedFacts = JSON.stringify(raw.facts);
      // Preserve large, otherwise observation-truncated tool evidence before
      // the canonical ledger receives only its bounded public projection.
      if (Buffer.byteLength(serializedFacts, "utf8") > 12 * 1024) {
        artifactContent = serializedFacts;
        artifactMimeType = "application/json";
      }
    }
    if (artifactContent !== undefined) {
      artifactRefs.push(await this.#artifacts.put({
        projectId: state.projectId,
        runId: state.runId,
        // Todo lists remain refetchable even when Context's per-observation
        // token budget (rather than the 4K excerpt bound) causes truncation.
        kind: call.tool_name === "todo_read" || call.tool_name === "team_read"
          ? "spilled_tool_output"
          : call.tool_name === "preview_patch"
          ? "patch_preview"
          : call.tool_name === "run_test"
            ? "test_log"
            : call.tool_name === "commit_patch"
              ? "diff"
              : "tool_output",
        mimeType: artifactMimeType,
        content: artifactContent,
      }));
    }
    const outputBytes = toolResultEnvelopeBytes(raw);
    const receipt = ReceiptSchema.parse({
      receipt_id: this.#idFactory("receipt"),
      action_id: call.action_id,
      tool_name: call.tool_name,
      status: raw.status,
      transport_status: transportFailed ? "failure" : raw.status === "unknown" ? "unknown" : "success",
      business_status: raw.status,
      code: raw.code,
      summary: raw.summary,
      started_at: startedAt.toISOString(),
      completed_at: completedAt.toISOString(),
      duration_ms: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      artifact_refs: artifactRefs,
      metadata: {
        ...(outputBytes === undefined ? {} : { output_bytes: outputBytes }),
        ...(sandboxReport === undefined ? {} : { sandbox_report: sandboxReport }),
        ...(raw.status === "success" ? {} : {
          failure_code: toolBatchFailureCode(raw),
          business_code: raw.code,
        }),
      },
    });
    const sanitizedFacts = sanitizeObservationFacts(raw.facts, call.tool_name, raw.code);
    const refetchableStateRead = (
      call.tool_name === "todo_read" || call.tool_name === "team_read"
    ) && raw.status === "success";
    const stateReadArtifact = refetchableStateRead
      ? artifactRefs.find((artifact) => artifact.kind === "spilled_tool_output")
      : undefined;
    const stateReadRefetchFacts = stateReadArtifact === undefined
      ? {}
      : {
          locator: `artifact:${stateReadArtifact.artifact_id}`,
          artifact_id: stateReadArtifact.artifact_id,
          content_truncated: typeof raw.content === "string"
            && Buffer.byteLength(raw.content, "utf8") > (
              call.tool_name === "team_read"
                ? TEAM_READ_MODEL_EXCERPT_BYTES
                : TODO_READ_MODEL_EXCERPT_BYTES
            ),
        };
    const observation = ObservationSchema.parse({
      observation_id: this.#idFactory("observation"),
      action_id: call.action_id,
      receipt_id: receipt.receipt_id,
      status: raw.status,
      summary: raw.summary,
      facts: { ...sanitizedFacts, ...stateReadRefetchFacts },
      artifact_refs: artifactRefs,
      created_at: completedAt.toISOString(),
    });
    return {
      receipt,
      observation,
      raw,
      artifactRefs,
      ...(sandboxReport === undefined ? {} : { sandboxReport }),
      ...(appliedWalRecord === undefined ? {} : { walRecord: appliedWalRecord }),
      ...(walTransactionId === undefined ? {} : { walTransactionId }),
      ...(refetchedContextArtifact === undefined ? {} : { refetchedContextArtifact }),
      ...(refetchedContextRange === undefined ? {} : { refetchedContextRange }),
    };
  }

  async #recordToolCompleted(
    state: RunState,
    prepared: PreparedToolCall,
    pending: PendingToolExecution,
    executionParallel = false,
  ): Promise<ExecutedTool> {
    const { call } = prepared;
    const { raw, receipt, observation, artifactRefs, walTransactionId, sandboxReport } = pending;
    const recordedReceipt = ReceiptSchema.parse({
      ...receipt,
      metadata: { ...receipt.metadata, execution_parallel: executionParallel },
    });
    const eventType = raw.status === "success"
      ? "tool.completed"
      : raw.status === "failure"
        ? "tool.failed"
        : "tool.unknown";
    const event = await this.#append(state, {
      type: eventType,
      summary: raw.summary,
      ...(eventType === "tool.completed" && walTransactionId !== undefined
        ? { idempotency_key: `action-wal:${walTransactionId}:tool.completed` }
        : {}),
      action_id: call.action_id,
      operation_id: call.action_id,
      artifact_refs: artifactRefs,
      data: {
        receipt: recordedReceipt,
        observation,
        ...(sandboxReport === undefined ? {} : { sandbox_report: sandboxReport }),
        ...(raw.status === "success" ? {} : {
          code: toolBatchFailureCode(raw),
          business_code: raw.code,
        }),
      },
    });
    if (call.tool_name === "read_artifact" && raw.status === "success" && pending.refetchedContextArtifact !== undefined) {
      const refetchedContextArtifact = pending.refetchedContextArtifact;
      const refetchedContextRange = pending.refetchedContextRange;
      await this.#append(state, {
        type: "context.spill_refetched",
        summary: "Archived Context source was retrieved through its opaque locator",
        action_id: call.action_id,
        operation_id: call.action_id,
        caused_by_event_id: event.event_id,
        artifact_refs: [refetchedContextArtifact],
        data: {
          artifact_id: refetchedContextArtifact.artifact_id,
          content_hash: refetchedContextArtifact.content_hash,
          locator: `artifact:${refetchedContextArtifact.artifact_id}`,
          ...(refetchedContextRange === undefined ? {} : {
            offset: refetchedContextRange.offset,
            bytes_read: refetchedContextRange.returnedBytes,
            total_bytes: refetchedContextRange.totalBytes,
            truncated: refetchedContextRange.truncated,
            ...(refetchedContextRange.nextOffset === undefined
              ? {}
              : { next_offset: refetchedContextRange.nextOffset }),
          }),
        },
      });
    }
    return {
      ...pending,
      receipt: recordedReceipt,
      event,
    };
  }

  async #scheduleToolCalls(
    state: RunState,
    preparedCalls: readonly PreparedToolCall[],
  ): Promise<ToolBatchScheduleResult> {
    const completed: ScheduledToolResult[] = [];
    let active = 0;
    let actualPeakConcurrency = 0;

    const executeChunk = async (chunk: readonly PreparedToolCall[]): Promise<readonly ScheduledToolResult[]> => {
      // Approval may await an external Host integration. Re-evaluate every
      // action after that await and before publishing any tool.started event.
      // Validate the whole chunk first so one late denial cannot arrive after
      // an earlier member in the same concurrency-safe wave has executed.
      for (const prepared of chunk) {
        if (!(await this.#finalAuthorizePreparedCall(state, prepared))) return [];
      }
      // Persist starts in request order before any tool code runs. Tool bodies
      // may execute concurrently, but all durable event/session writes remain
      // explicitly ordered so the Session parent chain cannot fork.
      const starts: Array<{ prepared: PreparedToolCall; startedAt: Date }> = [];
      for (const prepared of chunk) {
        const startedAt = await this.#recordToolStarted(state, prepared);
        if (startedAt === undefined) break;
        starts.push({ prepared, startedAt });
      }
      const pending = await Promise.all(starts.map(async ({ prepared, startedAt }) => {
        active += 1;
        actualPeakConcurrency = Math.max(actualPeakConcurrency, active);
        try {
          return await this.#runPreparedTool(state, prepared, startedAt);
        } catch (error) {
          if (error instanceof ActionCommitInterruptedError || error instanceof ActionWalError) throw error;
          return this.#internalToolFailure(prepared.call, startedAt, error);
        } finally {
          active -= 1;
        }
      }));
      const results: ScheduledToolResult[] = [];
      for (let index = 0; index < starts.length; index += 1) {
        const prepared = starts[index]?.prepared;
        const result = pending[index];
        if (prepared === undefined || result === undefined) continue;
        results.push({
          prepared,
          executed: await this.#recordToolCompleted(state, prepared, result, starts.length > 1),
        });
      }
      return results;
    };

    let cursor = 0;
    while (cursor < preparedCalls.length && !state.stopped) {
      const current = preparedCalls[cursor];
      if (current === undefined) break;
      if (current.serializedReason !== undefined) {
        const results = await executeChunk([current]);
        completed.push(...results);
        cursor += 1;
        if (state.stopped) return { completed, actualPeakConcurrency };
        if (results.some(({ prepared, executed }) => toolStopsBatch(prepared.call, executed.raw))) break;
        continue;
      }

      let safeEnd = cursor;
      while (
        safeEnd < preparedCalls.length
        && preparedCalls[safeEnd]?.serializedReason === undefined
      ) safeEnd += 1;
      for (let offset = cursor; offset < safeEnd; offset += this.#maxToolConcurrency) {
        const chunk = preparedCalls.slice(offset, Math.min(safeEnd, offset + this.#maxToolConcurrency));
        const results = await executeChunk(chunk);
        completed.push(...results);
        if (state.stopped) return { completed, actualPeakConcurrency };
        if (results.some(({ prepared, executed }) => toolStopsBatch(prepared.call, executed.raw))) {
          return { completed, actualPeakConcurrency };
        }
      }
      cursor = safeEnd;
    }
    return { completed, actualPeakConcurrency };
  }

  async #finalAuthorizePreparedCall(
    state: RunState,
    prepared: PreparedToolCall,
  ): Promise<boolean> {
    const binding = prepared.executionBinding;
    if (binding.policyDigest !== state.permissionPolicy.policy_digest) {
      await this.#append(state, {
        type: "action.rejected",
        summary: "Tool execution binding belongs to a different effective policy",
        action_id: prepared.call.action_id,
        data: { code: "policy_digest_mismatch", failure_class: "denied" },
      });
      await this.#fail(
        state,
        "policy_digest_mismatch",
        "The tool execution binding does not match the Run policy",
      );
      return false;
    }

    const policyTarget = policyTargetForCall(prepared.validated.parsedInput);
    const actualActionDigest = approvalActionDigest({
      projectId: state.projectId,
      runId: state.runId,
      actionId: prepared.call.action_id,
      toolName: prepared.call.tool_name,
      workspaceHandleId: state.workspace.handle_id,
      policyDigest: state.permissionPolicy.policy_digest,
      arguments: prepared.call.arguments,
      ...(policyTarget.path === undefined ? {} : { path: policyTarget.path }),
      scope: policyTarget.path === undefined ? ["."] : [policyTarget.path],
    });
    if (actualActionDigest !== binding.actionDigest) {
      await this.#append(state, {
        type: "action.rejected",
        summary: "Tool action changed after policy evaluation",
        action_id: prepared.call.action_id,
        data: { code: "action_digest_mismatch", failure_class: "denied" },
      });
      await this.#fail(state, "action_digest_mismatch", "The tool action binding no longer matches");
      return false;
    }

    if (binding.kind === "approved-once") {
      const boundAction = ApprovalBoundValidatedActionSchema.safeParse({
        ...prepared.validated.action,
        approval_id: binding.approvalId,
        approval_token_id: binding.approvalTokenId,
        action_digest: binding.actionDigest,
        policy_digest: binding.policyDigest,
      });
      if (!boundAction.success) {
        await this.#append(state, {
          type: "action.rejected",
          summary: "One-time approval binding is incomplete",
          action_id: prepared.call.action_id,
          data: { code: "approval_binding_invalid", failure_class: "denied" },
        });
        await this.#fail(state, "approval_binding_invalid", "The one-time approval binding is invalid");
        return false;
      }
    }

    if (state.toolAllowlist !== undefined && !state.toolAllowlist.has(prepared.call.tool_name)) {
      const denial = this.#subagentAllowlistDenialDecision(
        state,
        prepared.call,
        prepared.validated.definition.sideEffect,
        binding.actionDigest,
      );
      await this.#appendPolicyDecision(state, prepared.call.action_id, denial);
      await this.#appendPolicyDenied(state, prepared.call.action_id, denial, "subagent_tool_denied");
      await this.#fail(state, "subagent_tool_denied", denial.explanation);
      return false;
    }
    if (state.skillToolAllowlist !== undefined && !state.skillToolAllowlist.has(prepared.call.tool_name)) {
      const denial = this.#skillAllowlistDenialDecision(
        state,
        prepared.call,
        prepared.validated.definition.sideEffect,
        binding.actionDigest,
      );
      await this.#appendPolicyDecision(state, prepared.call.action_id, denial);
      await this.#appendPolicyDenied(state, prepared.call.action_id, denial, "skill_tool_denied");
      await this.#fail(state, "skill_tool_denied", denial.explanation);
      return false;
    }

    if (state.mode === "plan" && !isPlanModeToolAllowed(prepared.validated)) {
      const denial = this.#planModeDenialDecision(
        state,
        prepared.call,
        prepared.validated.definition,
        binding.actionDigest,
      );
      await this.#appendPolicyDecision(state, prepared.call.action_id, denial);
      await this.#appendPolicyDenied(state, prepared.call.action_id, denial, "plan_mode_denied");
      await this.#fail(state, "plan_mode_denied", denial.explanation);
      return false;
    }

    const capabilityAllowed = toolBypassesWorkspaceCapabilities(prepared.call.tool_name)
      || state.workspace.capabilities[prepared.validated.definition.capability];
    const finalDecision = state.policyEngine.evaluate({
      toolName: prepared.call.tool_name,
      sideEffect: prepared.validated.definition.sideEffect,
      capabilityAllowed,
      runMode: state.mode,
      ...(policyTarget.path === undefined ? {} : { path: policyTarget.path }),
      ...(policyTarget.diffLines === undefined ? {} : { diffLines: policyTarget.diffLines }),
      actionDigest: binding.actionDigest,
    });
    if (finalDecision.kind === "deny") {
      const denialCode = policyDenialCode(finalDecision);
      await this.#appendPolicyDecision(state, prepared.call.action_id, finalDecision);
      await this.#appendPolicyDenied(state, prepared.call.action_id, finalDecision, denialCode);
      await this.#fail(state, denialCode, finalDecision.explanation);
      return false;
    }
    if (finalDecision.kind === "ask" && binding.kind !== "approved-once") {
      await this.#appendPolicyDecision(state, prepared.call.action_id, finalDecision);
      await this.#append(state, {
        type: "action.rejected",
        summary: "Final policy evaluation requires a one-time approval",
        action_id: prepared.call.action_id,
        data: { code: "approval_required", failure_class: "denied" },
      });
      await this.#fail(state, "approval_required", "The tool action requires a one-time approval");
      return false;
    }
    return true;
  }

  #internalToolFailure(call: ToolCall, startedAt: Date, error: unknown): PendingToolExecution {
    const completedAt = this.#now();
    const raw: RawToolResult = {
      status: "failure",
      code: "internal",
      summary: publicError(error),
    };
    const outputBytes = toolResultEnvelopeBytes(raw);
    const receipt = ReceiptSchema.parse({
      receipt_id: this.#idFactory("receipt"),
      action_id: call.action_id,
      tool_name: call.tool_name,
      status: raw.status,
      transport_status: "failure",
      business_status: raw.status,
      code: raw.code,
      summary: raw.summary,
      started_at: startedAt.toISOString(),
      completed_at: completedAt.toISOString(),
      duration_ms: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      artifact_refs: [],
      metadata: {
        failure_code: "internal",
        business_code: raw.code,
        ...(outputBytes === undefined ? {} : { output_bytes: outputBytes }),
      },
    });
    const observation = ObservationSchema.parse({
      observation_id: this.#idFactory("observation"),
      action_id: call.action_id,
      receipt_id: receipt.receipt_id,
      status: raw.status,
      summary: raw.summary,
      facts: {},
      artifact_refs: [],
      created_at: completedAt.toISOString(),
    });
    return { receipt, observation, raw, artifactRefs: [] };
  }

  async #resolvePermissionPolicy(
    workspace: WorkspaceHandle,
    extensionSnapshot: ExtensionRunSnapshot,
  ): Promise<EffectivePermissionPolicy> {
    const candidate = this.#permissionPolicyResolver === undefined
      ? this.#defaultPermissionPolicy
      : await this.#permissionPolicyResolver(workspace);
    // Reconstructing the engine validates both layers and deliberately keeps
    // the supplied digest. A malformed Host integration fails before a Run is
    // created instead of silently falling back to a broader preset.
    const validated = PolicyEngine.fromEffective(candidate, { idFactory: this.#idFactory }).effectivePolicy();
    const builtinNames = new Set<string>(BUILTIN_TOOL_NAMES);
    const allowedNames = new Set<string>(validated.preset.allowed_tools);
    const trustedExtensionTools = extensionSnapshot.active_tool_names
      .filter((name) => !builtinNames.has(name) && !allowedNames.has(name))
      .sort();
    return createEffectivePermissionPolicy({
      preset: {
        ...validated.preset,
        // Existing presets are already canonical. Appending only new names
        // preserves their stable digest when no external extension is active.
        allowed_tools: [...validated.preset.allowed_tools, ...trustedExtensionTools],
      },
      rules: [...validated.host_rules, ...this.#extensionManager.policyRules()],
      projectRules: validated.project_rules,
    });
  }

  async #appendPolicyDecision(
    state: RunState,
    actionId: string,
    decision: PolicyDecision,
  ): Promise<void> {
    await this.#append(state, {
      type: "policy.evaluated",
      summary: decision.explanation,
      action_id: actionId,
      data: PolicyEvaluatedDataSchema.parse({ decision }),
    });
  }

  #planModeDenialDecision(
    state: RunState,
    call: ToolCall,
    definition: ToolDefinition,
    actionDigest: string,
  ): PolicyDecision {
    return PolicyDecisionSchema.parse({
      decision_id: this.#idFactory("policy-decision"),
      preset_key: state.permissionPolicy.preset.key,
      policy_digest: state.permissionPolicy.policy_digest,
      tool_name: call.tool_name,
      side_effect: definition.sideEffect,
      kind: "deny",
      source: "hard-constraint",
      explanation: `${call.tool_name} is not available in plan mode`,
      action_digest: actionDigest,
    });
  }

  #subagentAllowlistDenialDecision(
    state: RunState,
    call: ToolCall,
    sideEffect: ToolDefinition["sideEffect"],
    actionDigest: string,
  ): PolicyDecision {
    return PolicyDecisionSchema.parse({
      decision_id: this.#idFactory("policy-decision"),
      preset_key: state.permissionPolicy.preset.key,
      policy_digest: state.permissionPolicy.policy_digest,
      tool_name: call.tool_name,
      side_effect: sideEffect,
      kind: "deny",
      source: "hard-constraint",
      explanation: `${call.tool_name} is outside the frozen subagent tool allowlist`,
      action_digest: actionDigest,
    });
  }

  #skillAllowlistDenialDecision(
    state: RunState,
    call: ToolCall,
    sideEffect: ToolDefinition["sideEffect"],
    actionDigest: string,
  ): PolicyDecision {
    return PolicyDecisionSchema.parse({
      decision_id: this.#idFactory("policy-decision"),
      preset_key: state.permissionPolicy.preset.key,
      policy_digest: state.permissionPolicy.policy_digest,
      tool_name: call.tool_name,
      side_effect: sideEffect,
      kind: "deny",
      source: "hard-constraint",
      explanation: `${call.tool_name} is outside the active Skill tool allowlist`,
      action_digest: actionDigest,
    });
  }

  async #appendPolicyDenied(
    state: RunState,
    actionId: string,
    decision: PolicyDecision,
    code: string,
  ): Promise<void> {
    await this.#append(state, {
      type: "policy.denied",
      summary: decision.explanation,
      action_id: actionId,
      data: PolicyDeniedDataSchema.parse({
        decision,
        code,
        ...(code === "plan_mode_denied"
          ? { reason: "plan_mode" }
          : code === "subagent_tool_denied"
          ? { reason: "subagent_tool_allowlist" }
            : code === "skill_tool_denied"
              ? { reason: "skill_tool_allowlist" }
            : {}),
      }),
    });
  }

  async #answerPolicyApproval(
    state: RunState,
    call: ToolCall,
    decision: PolicyDecision,
  ): Promise<ApprovedOnceToolExecutionBinding | undefined> {
    const actionDigest = decision.action_digest;
    if (actionDigest === undefined) {
      throw new Error("An ask policy decision must bind an action digest");
    }
    const target = policyTargetForCall(call.arguments);
    const scope = target.path === undefined ? ["."] : [target.path];
    const approvalId = this.#idFactory("approval");
    const expiresAt = new Date(this.#now().getTime() + 5 * 60_000).toISOString();
    const requested = await this.#withRunControl(state.runId, async () => {
      try {
        this.#assertControlMutationAllowedLocked(state, await this.#ledger.list(state.runId));
      } catch (error) {
        if (error instanceof RuntimeCommandError && (
          error.code === "run_cancelling" || error.code === "run_terminal"
        )) return false;
        throw error;
      }
      await this.#append(state, {
        type: "approval.requested",
        summary: `One-time approval requested for ${call.tool_name}`,
        action_id: call.action_id,
        data: {
          approval_id: approvalId,
          action_id: call.action_id,
          tool_name: call.tool_name,
          action_digest: actionDigest,
          policy_digest: state.permissionPolicy.policy_digest,
          expires_at: expiresAt,
        },
      });
      return true;
    });
    if (!requested) return undefined;

    let outcome: ApprovalOutcome;
    try {
      if (this.#approvalAnswerer === undefined) throw new Error("Approval answerer is unavailable");
      outcome = ApprovalOutcomeSchema.parse(await abortable(
        Promise.resolve(this.#approvalAnswerer({
          approvalId,
          projectId: state.projectId,
          runId: state.runId,
          actionId: call.action_id,
          toolName: call.tool_name,
          actionDigest,
          policyDigest: state.permissionPolicy.policy_digest,
          scope,
          expiresAt,
          explanation: decision.explanation,
        })),
        state.abortController.signal,
      ));
    } catch (error) {
      if (state.stopped || state.cancelInputId !== undefined) return undefined;
      const explanation = `Approval answerer unavailable: ${publicError(error)}`;
      await this.#withRunControl(state.runId, async () => {
        try {
          this.#assertControlMutationAllowedLocked(state, await this.#ledger.list(state.runId));
        } catch (controlError) {
          if (controlError instanceof RuntimeCommandError && (
            controlError.code === "run_cancelling" || controlError.code === "run_terminal"
          )) return;
          throw controlError;
        }
        await this.#appendApprovalDenied(state, {
          pending: { approval_id: approvalId, action_id: call.action_id, action_digest: actionDigest },
          reason: "unavailable",
          explanation,
        });
        await this.#appendTerminalLocked(
          state,
          "run.failed",
          explanation,
          { code: "approval_unavailable" },
        );
      });
      return undefined;
    }

    if (outcome !== "allowed-once") {
      const reason = outcome === "rejected" ? "rejected" : outcome === "cancelled" ? "cancelled" : "unavailable";
      const explanation = outcome === "unavailable"
        ? "Approval answerer reported that approval is unavailable"
        : `Approval was ${outcome}`;
      await this.#withRunControl(state.runId, async () => {
        try {
          this.#assertControlMutationAllowedLocked(state, await this.#ledger.list(state.runId));
        } catch (error) {
          if (error instanceof RuntimeCommandError && (
            error.code === "run_cancelling" || error.code === "run_terminal"
          )) return;
          throw error;
        }
        await this.#appendApprovalDenied(state, {
          pending: { approval_id: approvalId, action_id: call.action_id, action_digest: actionDigest },
          reason,
          explanation,
        });
        await this.#appendTerminalLocked(
          state,
          "run.failed",
          explanation,
          { code: `approval_${reason}` },
        );
      });
      return undefined;
    }

    return this.#withRunControl(state.runId, async () => {
      try {
        this.#assertControlMutationAllowedLocked(state, await this.#ledger.list(state.runId));
      } catch (error) {
        if (error instanceof RuntimeCommandError && (
          error.code === "run_cancelling" || error.code === "run_terminal"
        )) return undefined;
        throw error;
      }
      let token;
      try {
        token = this.#approvalTokenStore.issue({
          approvalId,
          projectId: state.projectId,
          runId: state.runId,
          actionId: call.action_id,
          actionDigest,
          policyDigest: state.permissionPolicy.policy_digest,
          scope,
          expiresAt,
        });
        this.#approvalTokenStore.consume({
          tokenId: token.token_id,
          approvalId,
          projectId: state.projectId,
          runId: state.runId,
          actionId: call.action_id,
          actionDigest,
          policyDigest: state.permissionPolicy.policy_digest,
          scope,
        });
      } catch (error) {
        const denial = approvalTokenDenial(error);
        await this.#appendApprovalDenied(state, {
          pending: { approval_id: approvalId, action_id: call.action_id, action_digest: actionDigest },
          reason: denial.reason,
          explanation: denial.explanation,
        });
        await this.#appendTerminalLocked(
          state,
          "run.failed",
          denial.explanation,
          { code: denial.code },
        );
        return undefined;
      }
      await this.#append(state, {
        type: "approval.granted",
        summary: `One-time approval for ${call.tool_name} was atomically consumed`,
        action_id: call.action_id,
        data: ApprovalGrantedDataSchema.parse({ outcome: "allowed-once", token }),
      });
      return {
        kind: "approved-once",
        approvalId,
        approvalTokenId: token.token_id,
        actionDigest,
        policyDigest: state.permissionPolicy.policy_digest,
      };
    });
  }

  async #appendApprovalDenied(
    state: RunState,
    input: {
      pending: { approval_id: string; action_id: string; action_digest: string };
      reason: ApprovalDenialReason;
      explanation: string;
    },
  ): Promise<void> {
    const outcome = input.reason === "rejected"
      ? "rejected"
      : input.reason === "cancelled"
        ? "cancelled"
        : "unavailable";
    const data = ApprovalDeniedDataSchema.parse({
      approval_id: input.pending.approval_id,
      action_id: input.pending.action_id,
      action_digest: input.pending.action_digest,
      outcome,
      reason: input.reason,
      explanation: redactSensitiveText(input.explanation),
    });
    await this.#append(state, {
      type: "approval.denied",
      summary: data.explanation,
      action_id: data.action_id,
      data,
    });
  }

  async #patchActionBinding(
    state: RunState,
    commitCall: ToolCall,
    scope: readonly string[],
  ): Promise<{ actionDigest: string; canonicalTargetDigest: string }> {
    const input = CommitPatchInputSchema.parse(commitCall.arguments);
    const target = await resolvePatchTarget(state.workspace, input.path);
    const canonicalTargetDigest = sha256(target.path);
    return {
      actionDigest: approvalActionDigest({
        projectId: state.projectId,
        runId: state.runId,
        actionId: commitCall.action_id,
        toolName: commitCall.tool_name,
        workspaceHandleId: state.workspace.handle_id,
        policyDigest: state.permissionPolicy.policy_digest,
        arguments: commitCall.arguments,
        path: input.path,
        canonicalTarget: canonicalTargetDigest,
        baseHash: input.base_hash,
        patchHash: input.patch_hash,
        scope,
      }),
      canonicalTargetDigest,
    };
  }

  async #createPendingPatch(
    state: RunState,
    call: ToolCall,
    executed: ExecutedTool,
  ): Promise<void> {
    if (state.stopped) return;
    const facts = executed.raw.facts ?? {};
    const expiresAt = new Date(this.#now().getTime() + 5 * 60_000).toISOString();
    const preview = PatchPreviewSchema.parse({
      preview_id: this.#idFactory("patch-preview"),
      action_id: call.action_id,
      path: facts.path,
      diff: typeof facts.diff === "string" ? facts.diff.slice(0, 2_000) : facts.diff,
      base_hash: facts.base_hash,
      patch_hash: facts.patch_hash,
      scope: facts.scope,
      expires_at: expiresAt,
      ...(executed.artifactRefs[0] === undefined ? {} : { artifact_ref: executed.artifactRefs[0] }),
    });
    const patchInput = PatchInputSchema.parse(call.arguments);
    const commitCall: ToolCall = {
      action_id: preview.action_id,
      tool_name: "commit_patch",
      arguments: {
        ...patchInput,
        base_hash: preview.base_hash,
        patch_hash: preview.patch_hash,
      },
    };
    const { actionDigest } = await this.#patchActionBinding(state, commitCall, preview.scope);
    if (state.stopped) return;
    const policyDecision = state.policyEngine.evaluate({
      toolName: "commit_patch",
      sideEffect: "write",
      capabilityAllowed: state.workspace.capabilities.commit_patch,
      runMode: state.mode,
      path: preview.path,
      diffLines: countTextLines(preview.diff),
      actionDigest,
    });
    if (policyDecision.kind === "deny") {
      const denialCode = policyDenialCode(policyDecision);
      await this.#withRunControl(state.runId, async () => {
        try {
          this.#assertControlMutationAllowedLocked(state, await this.#ledger.list(state.runId));
        } catch (error) {
          if (error instanceof RuntimeCommandError && (
            error.code === "run_cancelling" || error.code === "run_terminal"
          )) return;
          throw error;
        }
        await this.#appendPolicyDecision(state, call.action_id, policyDecision);
        await this.#appendPolicyDenied(state, call.action_id, policyDecision, denialCode);
        await this.#appendTerminalLocked(
          state,
          "run.failed",
          policyDecision.explanation,
          { code: denialCode },
        );
      });
      return;
    }

    const pendingApproval = BoundPendingApprovalSchema.parse({
      approval_id: this.#idFactory("approval"),
      action_id: call.action_id,
      risk: "high",
      preview,
      tool_name: "commit_patch",
      action_digest: actionDigest,
      policy_digest: state.permissionPolicy.policy_digest,
    });
    const pendingRecoveryArtifact = policyDecision.kind === "allow"
      ? undefined
      : await this.#artifacts.put({
          projectId: state.projectId,
          runId: state.runId,
          kind: "recovery_state",
          mimeType: "application/json",
          content: JSON.stringify(SessionPendingPatchRecoveryStateSchema.parse({
            version: 1,
            kind: "pending_patch_recovery_state",
            pending_approval: pendingApproval,
            preview_call: ToolCallSchema.parse(call),
          })),
        });
    const published = await this.#withRunControl(state.runId, async () => {
      try {
        this.#assertControlMutationAllowedLocked(state, await this.#ledger.list(state.runId));
      } catch (error) {
        if (error instanceof RuntimeCommandError && (
          error.code === "run_cancelling" || error.code === "run_terminal"
        )) return false;
        throw error;
      }
      await this.#appendPolicyDecision(state, call.action_id, policyDecision);
      await this.#append(state, {
        type: "patch.preview_created",
        summary: `Patch preview created for ${preview.path}`,
        action_id: call.action_id,
        caused_by_event_id: executed.event.event_id,
        artifact_refs: executed.artifactRefs,
        data: { preview },
      });
      state.pendingPatch = { pendingApproval, previewCall: call };
      if (pendingRecoveryArtifact !== undefined) {
        await this.#append(state, {
          type: "approval.requested",
          summary: `Approval required to modify ${preview.path}`,
          action_id: call.action_id,
          artifact_refs: executed.artifactRefs,
          data: {
            pending_approval: pendingApproval,
            approval_id: pendingApproval.approval_id,
            action_id: pendingApproval.action_id,
            tool_name: "commit_patch",
            action_digest: pendingApproval.action_digest,
            policy_digest: pendingApproval.policy_digest,
            expires_at: preview.expires_at,
            _internal_recovery_artifact: pendingRecoveryArtifact,
          },
        });
      }
      return true;
    });
    if (!published || policyDecision.kind !== "allow") return;
    await this.#approveLocked(state, ApprovalCommandSchema.parse({
      type: "approve",
      command_id: this.#idFactory("command"),
      project_id: state.projectId,
      run_id: state.runId,
      approval_id: pendingApproval.approval_id,
      action_id: pendingApproval.action_id,
    }), "policy");
  }

  async #injectActionFault(point: ActionCommitFaultPoint): Promise<void> {
    if (this.#actionCommitFaultInjector === undefined) return;
    await this.#actionCommitFaultInjector(point);
  }

  /**
   * Git is a Host/composition concern. A missing probe is explicitly durable
   * as unavailable rather than being silently treated as a clean repository.
   */
  async #captureCodeIntelGitContext(state: RunState): Promise<GitBaseContext> {
    const capturedAt = this.#now().toISOString();
    if (this.#codeGraph?.captureGitContext === undefined) {
      return GitBaseContextSchema.parse({
        status: "unavailable",
        captured_at: capturedAt,
        reason: "git_probe_not_configured",
      });
    }
    try {
      return GitBaseContextSchema.parse(await abortable(
        this.#codeGraph.captureGitContext({
          workspaceRoot: state.workspace.real_root,
          signal: state.abortController.signal,
        }),
        state.abortController.signal,
      ));
    } catch (error) {
      if (state.abortController.signal.aborted) throw error;
      return GitBaseContextSchema.parse({
        status: "unavailable",
        captured_at: capturedAt,
        reason: "git_probe_failed",
      });
    }
  }

  async #appendCodeIntelUpdated(
    state: RunState,
    input: {
      phase: "baseline" | "post_patch";
      gitContext: GitBaseContext;
      baseSnapshotId?: string;
      resultSnapshotId?: string;
      changedFiles: readonly string[];
      changedSymbols: readonly ChangedSymbol[];
      patchEventId?: string;
      graphDeltaId?: string;
    },
  ): Promise<void> {
    const changedFiles = [...new Set(input.changedFiles)].sort((left, right) => left.localeCompare(right));
    const changedSymbols = [...input.changedSymbols]
      .sort((left, right) => (
        left.file_path.localeCompare(right.file_path)
        || left.line - right.line
        || left.symbol_id.localeCompare(right.symbol_id)
      ));
    const data = CodeIntelUpdatedDataSchema.parse({
      project_id: state.projectId,
      phase: input.phase,
      git_context: input.gitContext,
      ...(input.baseSnapshotId === undefined ? {} : { base_snapshot_id: input.baseSnapshotId }),
      ...(input.resultSnapshotId === undefined ? {} : { result_snapshot_id: input.resultSnapshotId }),
      changed_files: changedFiles.slice(0, MAX_CODE_INTEL_CHANGED_FILES),
      changed_files_truncated: changedFiles.length > MAX_CODE_INTEL_CHANGED_FILES,
      changed_symbols: changedSymbols.slice(0, MAX_CODE_INTEL_CHANGED_SYMBOLS),
      changed_symbols_truncated: changedSymbols.length > MAX_CODE_INTEL_CHANGED_SYMBOLS,
    });
    await this.#append(state, {
      type: "code.intel_updated",
      summary: input.phase === "baseline"
        ? "Semantic CodeGraph baseline captured"
        : "Semantic CodeGraph updated after patch",
      ...(input.patchEventId === undefined ? {} : { patch_event_id: input.patchEventId }),
      ...(input.graphDeltaId === undefined ? {} : { graph_delta_id: input.graphDeltaId }),
      data,
    });
  }

  /**
   * A Git base drift is distinct from the target-file hash race handled by
   * commit_patch. The old approval has not issued a token yet, so invalidate
   * it and publish a fresh, durable approval instead of executing or failing
   * the Run. A later user click is the required reapproval.
   */
  async #requeueApprovalForStaleCodeBase(
    state: RunState,
    pending: PendingPatch,
    boundPending: BoundPendingApproval,
  ): Promise<boolean> {
    const expected = state.codeIntelGitContext;
    if (expected === undefined || expected.status !== "available") return false;
    const actual = await this.#captureCodeIntelGitContext(state);
    const reason = gitBaseDifference(expected, actual);
    if (reason === undefined) return false;

    const renewedPreview = PatchPreviewSchema.parse({
      ...boundPending.preview,
      expires_at: new Date(this.#now().getTime() + 5 * 60_000).toISOString(),
    });
    const replacement = BoundPendingApprovalSchema.parse({
      ...boundPending,
      approval_id: this.#idFactory("approval"),
      preview: renewedPreview,
    });
    let requeued = false;
    await this.#withRunControl(state.runId, async () => {
      this.#assertControlMutationAllowedLocked(state, await this.#ledger.list(state.runId));
      // Another control operation may have changed the pending request while
      // the fixed Git probe ran. In that case caller will re-read its state.
      if (state.pendingPatch?.pendingApproval.approval_id !== boundPending.approval_id) return;
      const recoveryArtifact = await this.#artifacts.put({
        projectId: state.projectId,
        runId: state.runId,
        kind: "recovery_state",
        mimeType: "application/json",
        content: JSON.stringify(SessionPendingPatchRecoveryStateSchema.parse({
          version: 1,
          kind: "pending_patch_recovery_state",
          pending_approval: replacement,
          preview_call: ToolCallSchema.parse(pending.previewCall),
        })),
      });
      const staleBase = {
        expected,
        actual,
        detected_at: this.#now().toISOString(),
        reason,
        requires_reapproval: true as const,
      };
      await this.#append(state, {
        type: "code.stale_base_detected",
        summary: "Git base changed after patch approval was requested; reapproval is required",
        action_id: boundPending.action_id,
        data: CodeStaleBaseDetectedDataSchema.parse({
          project_id: state.projectId,
          stale_base: staleBase,
        }),
      });
      await this.#appendApprovalDenied(state, {
        pending: boundPending,
        reason: "stale_base",
        explanation: "The repository base changed after the patch preview was approved",
      });
      state.pendingPatch = { pendingApproval: replacement, previewCall: pending.previewCall };
      await this.#append(state, {
        type: "approval.requested",
        summary: `Reapproval required to modify ${renewedPreview.path} after Git base drift`,
        action_id: replacement.action_id,
        artifact_refs: renewedPreview.artifact_ref === undefined ? [] : [renewedPreview.artifact_ref],
        data: {
          pending_approval: replacement,
          approval_id: replacement.approval_id,
          action_id: replacement.action_id,
          tool_name: replacement.tool_name,
          action_digest: replacement.action_digest,
          policy_digest: replacement.policy_digest,
          expires_at: renewedPreview.expires_at,
          _internal_recovery_artifact: recoveryArtifact,
        },
      });
      state.codeIntelGitContext = actual;
      requeued = true;
    });
    return requeued;
  }

  async #captureGraphSnapshot(state: RunState, summary: string): Promise<GraphSnapshot> {
    if (this.#codeGraph === undefined) throw new Error("CodeGraph provider is unavailable");
    const snapshot = GraphSnapshotSchema.parse(await abortable(
      this.#codeGraph.createSnapshot({
        projectId: state.projectId,
        workspaceRoot: state.workspace.real_root,
        signal: state.abortController.signal,
      }),
      state.abortController.signal,
    ));
    if (snapshot.project_id !== state.projectId) {
      throw new Error("CodeGraph snapshot belongs to another project");
    }
    const artifact = await this.#artifacts.put({
      projectId: state.projectId,
      runId: state.runId,
      kind: "graph_snapshot",
      mimeType: "application/json",
      content: JSON.stringify(snapshot, null, 2),
    });
    const enriched: GraphSnapshot = { ...snapshot, artifact_ref: artifact };
    await this.#append(state, {
      type: "graph.snapshot_created",
      summary,
      artifact_refs: [artifact],
      data: { snapshot_id: snapshot.snapshot_id, workspace_hash: snapshot.workspace_hash },
    });
    return enriched;
  }

  async #recoverAppliedAction(
    state: SessionScopedState,
    durable: ActionWalRecord,
    transactionId: string,
  ): Promise<void> {
    let current = durable;
    const events = await this.#ledger.list(durable.run_id);
    let toolEvent = [...events].reverse().find(
      (event) => event.type === "tool.completed" && event.action_id === durable.action_id,
    );
    const parsedReceipt = ReceiptSchema.safeParse(toolEvent?.data.receipt);
    const receipt = parsedReceipt.success
      ? parsedReceipt.data
      : ReceiptSchema.parse({
          receipt_id: this.#idFactory("receipt"),
          action_id: durable.action_id,
          tool_name: "commit_patch",
          status: "success",
          transport_status: "success",
          business_status: "success",
          code: "patch_reconciled",
          summary: "Recovered an applied patch from its durable Action WAL",
          started_at: durable.recorded_at,
          completed_at: this.#now().toISOString(),
          duration_ms: 0,
          artifact_refs: [],
          metadata: { recovered: true, wal_id: transactionId },
        });
    if (toolEvent?.idempotency_key !== undefined) {
      toolEvent = await this.#appendScoped(state, {
        type: "tool.completed",
        summary: toolEvent.summary,
        idempotency_key: toolEvent.idempotency_key,
        action_id: durable.action_id,
        operation_id: durable.action_id,
        artifact_refs: toolEvent.artifact_refs,
        data: toolEvent.data,
      });
    } else if (toolEvent === undefined) {
      const observation = ObservationSchema.parse({
        observation_id: this.#idFactory("observation"),
        action_id: durable.action_id,
        receipt_id: receipt.receipt_id,
        status: "success",
        summary: receipt.summary,
        facts: {
          recovered: true,
          wal_id: transactionId,
          target_paths: durable.targets.map((target) => target.target_path),
        },
        artifact_refs: [],
        created_at: this.#now().toISOString(),
      });
      toolEvent = await this.#appendScoped(state, {
        type: "tool.completed",
        summary: receipt.summary,
        idempotency_key: `action-wal:${transactionId}:tool.completed`,
        action_id: durable.action_id,
        operation_id: durable.action_id,
        data: { receipt, observation, recovered: true, wal_id: transactionId },
      });
    }
    const existingPatch = [...events].reverse().find(
      (event) => event.type === "patch.applied" && event.action_id === durable.action_id,
    );
    const firstTarget = durable.targets[0]!;
    const patchEvent = existingPatch ?? await this.#appendScoped(state, {
      type: "patch.applied",
      summary: `Recovered applied patch for ${firstTarget.target_path}`,
      idempotency_key: `action-wal:${transactionId}:patch.applied`,
      action_id: durable.action_id,
      caused_by_event_id: toolEvent.event_id,
      data: {
        receipt_id: receipt.receipt_id,
        receipt,
        wal_id: transactionId,
        base_hash: firstTarget.before_hash,
        patch_hash: durable.patch_hash,
        scope: durable.targets.map((target) => target.target_path),
        recovered: true,
        verified: true,
      },
    });
    // Re-submit the stable proposal even when the event already existed. The
    // ledger returns the original event, while #appendScoped repairs a missing
    // Session event_ref left by a cross-file crash.
    if (existingPatch?.idempotency_key !== undefined) {
      await this.#appendScoped(state, {
        type: "patch.applied",
        summary: existingPatch.summary,
        idempotency_key: existingPatch.idempotency_key,
        action_id: durable.action_id,
        ...(existingPatch.caused_by_event_id === undefined
          ? {}
          : { caused_by_event_id: existingPatch.caused_by_event_id }),
        artifact_refs: existingPatch.artifact_refs,
        data: existingPatch.data,
      });
    }
    const durableReceiptId = typeof patchEvent.data.receipt_id === "string"
      ? patchEvent.data.receipt_id
      : receipt.receipt_id;
    if (current.phase === "applied") {
      current = await this.#actionWal.advance({
        runId: current.run_id,
        actionId: current.action_id,
        phase: "committed",
        eventId: patchEvent.event_id,
        receiptId: durableReceiptId,
        recovered: true,
      });
    }
    await this.#appendScoped(state, {
      type: "action.reconciled",
      summary: "Action WAL and canonical patch event were reconciled after restart",
      idempotency_key: `action-wal:${transactionId}:reconciled`,
      action_id: durable.action_id,
      patch_event_id: patchEvent.event_id,
      data: {
        wal_id: transactionId,
        outcome: "patch_event_replayed",
        recovered: true,
        target_paths: durable.targets.map((target) => target.target_path),
      },
    });
    const verifiedEvent = await this.#appendScoped(state, {
      type: "action.verified",
      summary: "Recovered patch bytes match their durable hashes and canonical event",
      idempotency_key: `action-wal:${transactionId}:verified`,
      action_id: durable.action_id,
      patch_event_id: patchEvent.event_id,
      caused_by_event_id: patchEvent.event_id,
      data: {
        wal_id: transactionId,
        patch_hash: durable.patch_hash,
        scope: durable.targets.map((target) => target.target_path),
        recovered: true,
        verified: true,
      },
    });
    if (current.phase === "committed") {
      await this.#actionWal.advance({
        runId: current.run_id,
        actionId: current.action_id,
        phase: "verified",
        eventId: verifiedEvent.event_id,
        recovered: true,
      });
    }
  }

  async #markActionDiverged(
    state: SessionScopedState,
    durable: ActionWalRecord,
    transactionId: string,
    reason: string,
    currentHashes: readonly string[],
    detail?: string,
  ): Promise<void> {
    const existing = (await this.#ledger.list(durable.run_id)).find(
      (event) => event.idempotency_key === `action-wal:${transactionId}:diverged`,
    );
    if (existing !== undefined) {
      await this.#appendScoped(state, {
        type: "action.diverged",
        summary: existing.summary,
        idempotency_key: existing.idempotency_key!,
        action_id: durable.action_id,
        artifact_refs: existing.artifact_refs,
        data: existing.data,
      });
      const attempts = await this.#recoveryLedger.list(durable.run_id);
      for (const open of attempts.filter(
        (candidate) => candidate.action_id === durable.action_id
          && candidate.recipe_id === "mark_diverged"
          && candidate.state === "started",
      )) {
        await this.#recoveryLedger.finishAttempt({
          recovery_id: open.recovery_id,
          state: "succeeded",
        });
      }
      return;
    }
    const attempt = await this.#recoveryLedger.startAttempt({
      project_id: durable.project_id,
      run_id: durable.run_id,
      action_id: durable.action_id,
      recipe_id: "mark_diverged",
      automatic: true,
    });
    const finalReason = attempt.state === "escalated"
      ? "automatic_recovery_exhausted"
      : reason;
    try {
      await this.#appendActionDivergedEvent(
        state,
        durable,
        transactionId,
        finalReason,
        currentHashes,
        detail,
      );
      if (attempt.state === "started") {
        await this.#recoveryLedger.finishAttempt({
          recovery_id: attempt.recovery_id,
          state: "succeeded",
        });
      }
    } catch (error) {
      if (attempt.state === "started") await this.#finishRecoveryFailure(attempt.recovery_id, error);
      throw error;
    }
  }

  async #appendActionDivergedEvent(
    state: SessionScopedState,
    durable: ActionWalRecord,
    transactionId: string,
    reason: string,
    currentHashes: readonly string[],
    detail?: string,
  ): Promise<SessionEvent> {
    return this.#appendScoped(state, {
      type: "action.diverged",
      summary: "Action WAL does not match the current workspace; manual review is required",
      idempotency_key: `action-wal:${transactionId}:diverged`,
      action_id: durable.action_id,
      data: {
        wal_id: transactionId,
        reason,
        ...(detail === undefined ? {} : { detail: redactSensitiveText(detail) }),
        phase: durable.phase,
        target_paths: durable.targets.map((target) => target.target_path),
        expected_before_hashes: durable.targets.map((target) => target.before_hash),
        expected_after_hashes: durable.targets.map((target) => target.after_hash),
        current_hashes: currentHashes,
        automatic_rollback: false,
      },
    });
  }

  async #closeRecoveredAttemptIfNeeded(
    state: SessionScopedState,
    durable: ActionWalRecord,
    transactionId: string,
    workspace: WorkspaceHandle,
  ): Promise<void> {
    const attempts = await this.#recoveryLedger.list(durable.run_id);
    for (const attempt of attempts.filter(
      (candidate) => candidate.action_id === durable.action_id && candidate.state === "started",
    )) {
      if (attempt.recipe_id !== "restore_from_backup" || durable.phase !== "verified") {
        await this.#recoveryLedger.finishAttempt({
          recovery_id: attempt.recovery_id,
          state: "succeeded",
        });
        continue;
      }
      const bindingFailure = await walWorkspaceBindingFailure(durable, workspace);
      if (bindingFailure !== undefined) {
        await this.#appendActionDivergedEvent(
          state,
          durable,
          transactionId,
          bindingFailure,
          [],
        );
        await this.#recoveryLedger.finishAttempt({
          recovery_id: attempt.recovery_id,
          state: "escalated",
          escalation_reason: bindingFailure,
        });
        continue;
      }
      const events = await this.#ledger.list(durable.run_id);
      const existingRollback = events.find(
        (event) => event.type === "patch.rolled_back" && event.action_id === durable.action_id,
      );
      if (existingRollback !== undefined) {
        if (existingRollback.idempotency_key !== undefined) {
          await this.#appendScoped(state, {
            type: "patch.rolled_back",
            summary: existingRollback.summary,
            idempotency_key: existingRollback.idempotency_key,
            action_id: durable.action_id,
            ...(existingRollback.patch_event_id === undefined
              ? {}
              : { patch_event_id: existingRollback.patch_event_id }),
            artifact_refs: existingRollback.artifact_refs,
            data: existingRollback.data,
          });
        }
        await this.#appendScoped(state, {
          type: "action.reconciled",
          summary: "Rollback filesystem state and canonical event were reconciled",
          idempotency_key: `action-wal:${transactionId}:rollback-reconciled`,
          action_id: durable.action_id,
          patch_event_id: existingRollback.event_id,
          data: { wal_id: transactionId, outcome: "rollback_event_replayed", recovered: true },
        });
        await this.#recoveryLedger.finishAttempt({
          recovery_id: attempt.recovery_id,
          state: "succeeded",
        });
        continue;
      }
      const disk = await inspectWalTargets(durable, workspace);
      if (disk.classification === "before") {
        const originalPatch = [...events].reverse().find(
          (event) => event.type === "patch.applied" && event.action_id === durable.action_id,
        );
        const rolledBack = await this.#appendScoped(state, {
          type: "patch.rolled_back",
          summary: "Recovered a completed rollback after restart",
          idempotency_key: `action-wal:${transactionId}:rollback-recovered`,
          action_id: durable.action_id,
          ...(originalPatch === undefined ? {} : { patch_event_id: originalPatch.event_id }),
          data: {
            wal_id: transactionId,
            target_paths: durable.targets.map((target) => target.target_path),
            before_hashes: durable.targets.map((target) => target.before_hash),
            after_hashes: durable.targets.map((target) => target.after_hash),
            recovered: true,
          },
        });
        await this.#appendScoped(state, {
          type: "action.reconciled",
          summary: "Rollback filesystem state and canonical event were reconciled",
          idempotency_key: `action-wal:${transactionId}:rollback-reconciled`,
          action_id: durable.action_id,
          patch_event_id: rolledBack.event_id,
          data: { wal_id: transactionId, outcome: "rollback_event_replayed", recovered: true },
        });
        await this.#recoveryLedger.finishAttempt({
          recovery_id: attempt.recovery_id,
          state: "succeeded",
        });
      } else if (disk.classification === "after") {
        await this.#recoveryLedger.finishAttempt({
          recovery_id: attempt.recovery_id,
          state: "failed",
          last_failure: "rollback did not mutate the target",
        });
      } else {
        await this.#appendActionDivergedEvent(
          state,
          durable,
          transactionId,
          "rollback_state_diverged",
          disk.hashes,
        );
        await this.#recoveryLedger.finishAttempt({
          recovery_id: attempt.recovery_id,
          state: "escalated",
          escalation_reason: "rollback_state_diverged",
        });
      }
    }
  }

  async #finishRecoveryFailure(recoveryId: string, error: unknown): Promise<void> {
    await this.#recoveryLedger.finishAttempt({
      recovery_id: recoveryId,
      state: "failed",
      last_failure: publicError(error),
    }).catch(() => undefined);
  }

  async #refuseRollback(
    state: SessionScopedState,
    input: RollbackActionInput,
    idempotencyKey: string,
    commandFingerprint: string,
    reason: string,
    currentHashes: readonly string[] = [],
  ): Promise<RunProjection> {
    await this.#appendScoped(state, {
      type: "action.rollback_refused",
      summary: "Rollback was refused without changing the workspace",
      idempotency_key: idempotencyKey,
      action_id: input.action_id,
      data: {
        reason,
        force: input.force,
        current_hashes: currentHashes,
        command_fingerprint: commandFingerprint,
      },
    });
    return this.getProjection(input.run_id);
  }

  async #openMaintenanceScope(
    input: SessionRunLocator,
  ): Promise<{ state: SessionScopedState; release(): Promise<void> }> {
    if (this.#sessionStore !== undefined) return this.#openSessionScope(input);
    const events = await this.#ledger.list(input.runId);
    assertRunBelongsToSession(events, input);
    return {
      state: {
        runId: input.runId,
        sessionId: input.sessionId,
        projectId: input.projectId,
        indexedSessionEventIds: new Set(),
      },
      release: async () => undefined,
    };
  }

  async #openSessionScope(
    input: SessionRunLocator,
    suppliedLease?: SessionLease,
  ): Promise<{ state: SessionScopedState; release(): Promise<void> }> {
    if (this.#sessionStore === undefined) {
      throw new RuntimeCommandError("session_store_unavailable", "Durable session storage is unavailable");
    }
    const ownedLease = suppliedLease === undefined;
    const lease = suppliedLease ?? await this.#sessionStore.acquireLease(input.sessionId);
    try {
      const stored = await this.#sessionStore.readAll(input.sessionId, lease);
      if (stored.header.project_id !== input.projectId || !stored.header.run_ids.includes(input.runId)) {
        throw new RuntimeCommandError("session_run_mismatch", "Run is outside the durable session scope");
      }
      const state: SessionScopedState = {
        sessionId: input.sessionId,
        projectId: input.projectId,
        runId: input.runId,
        sessionLease: lease,
        ...(stored.entries.at(-1)?.entry_id === undefined
          ? {}
          : { lastSessionEntryId: stored.entries.at(-1)!.entry_id }),
        indexedSessionEventIds: new Set(stored.entries.map((entry) => entry.event_ref.event_id)),
      };
      return {
        state,
        release: async () => {
          if (ownedLease) await lease.release();
        },
      };
    } catch (error) {
      if (ownedLease) await lease.release().catch(() => undefined);
      throw error;
    }
  }

  async #loadRunRecovery(event: SessionEvent) {
    const value = await this.#loadInternalRecoveryArtifact(event, "run_recovery_state");
    return RunRecoveryStateSchema.parse(value);
  }

  async #loadPendingPatchRecovery(event: SessionEvent) {
    const value = await this.#loadInternalRecoveryArtifact(event, "pending_patch_recovery_state");
    return SessionPendingPatchRecoveryStateSchema.parse(value);
  }

  async #loadInternalRecoveryArtifact(
    event: SessionEvent,
    expectedKind: "run_recovery_state" | "pending_patch_recovery_state",
  ): Promise<unknown> {
    const expected = this.#internalRecoveryArtifactRef(event, expectedKind);
    if (expected.kind !== "recovery_state") {
      throw new RuntimeCommandError("recovery_state_invalid", "Recovery Artifact has an invalid kind");
    }
    const result = await this.#artifacts.getInternal({
      artifactId: expected.artifact_id,
      projectId: event.project_id,
      runId: event.run_id,
    });
    if (
      result.status !== "available"
      || result.artifact.content_hash !== expected.content_hash
      || result.artifact.kind !== expected.kind
    ) {
      throw new RuntimeCommandError("recovery_state_unavailable", "Recovery Artifact is missing or corrupt");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.content) as unknown;
    } catch {
      throw new RuntimeCommandError("recovery_state_invalid", "Recovery Artifact is not valid JSON");
    }
    if (
      typeof parsed !== "object"
      || parsed === null
      || !("kind" in parsed)
      || parsed.kind !== expectedKind
    ) {
      throw new RuntimeCommandError("recovery_state_invalid", "Recovery Artifact has an unexpected schema");
    }
    return parsed;
  }

  #internalRecoveryArtifactRef(
    event: SessionEvent,
    expectedKind: "run_recovery_state" | "pending_patch_recovery_state",
  ): ArtifactRef {
    try {
      return ArtifactRefSchema.parse(event.data._internal_recovery_artifact);
    } catch {
      throw new RuntimeCommandError(
        "recovery_state_unavailable",
        `Persisted ${expectedKind} Artifact reference is unavailable`,
      );
    }
  }

  async #restoreRunState(input: {
    locator: SessionRunLocator;
    workspace: WorkspaceHandle;
    events: readonly SessionEvent[];
    recovery: ReturnType<typeof RunRecoveryStateSchema.parse>;
    permissionPolicy: EffectivePermissionPolicy;
    sessionState: SessionScopedState;
    pendingPatch?: PendingPatch;
  }): Promise<RunState> {
    const projection = projectRun(input.events);
    const observations: Observation[] = [];
    const actionSignatures = new Map<string, string>();
    for (const event of input.events) {
      const observation = ObservationSchema.safeParse(event.data.observation);
      if (observation.success) {
        observations.push(observationWithEligibleEvidence(observation.data, event));
      }
      if (event.type === "attachment.added") {
        observations.push(attachmentObservation(
          AttachmentAddedDataSchema.parse(event.data),
          event.artifact_refs,
          new Date(event.occurred_at),
        ));
      }
      if (event.action_id !== undefined) {
        // Any provider reuse of a historical action id must be repaired. The
        // exact old arguments are not needed for this conservative guard.
        actionSignatures.set(event.action_id, `historical:${event.event_id}`);
      }
    }
    const lastPatchEventId = [...input.events]
      .reverse()
      .find((event) => event.type === "patch.applied")?.event_id;
    const recoveredOrchestration = input.recovery.version === 4 || input.recovery.version === 5
      ? input.recovery.orchestration
      : { depth: 0, limits: this.#subagentLimits };
    const delegation = recoveredOrchestration.delegation;
    const orchestration: RunState["orchestration"] = {
      depth: recoveredOrchestration.depth,
      limits: recoveredOrchestration.limits,
      ...(delegation === undefined ? {} : { delegation }),
    };
    const profile = delegation === undefined
      ? undefined
      : this.#subagentRegistry.resolve(delegation.spec.name, this.#model);
    if (profile !== undefined && (
      profile.providerKey !== delegation!.spec.provider_key
      || profile.rolePromptVersion !== delegation!.spec.role_prompt_version
      || profile.rolePromptHash !== delegation!.spec.role_prompt_hash
      || delegation!.spec.tool_allowlist.some((tool) => (
        this.#toolRegistry.get(tool as ToolName) === undefined
        || !input.permissionPolicy.preset.allowed_tools.includes(tool)
      ))
    )) {
      throw new RuntimeCommandError(
        "subagent_profile_drift",
        "Recovered child profile no longer matches its frozen delegation",
      );
    }
    const recoveredBudget = delegation === undefined
      ? undefined
      : recoveredSubagentBudget(input.events, delegation.spec.budget.max_tokens);
    const recoveredHistory = recoveredConversationHistory(
      input.recovery.conversation_history,
      input.events,
    );
    const extensionLease = this.#extensionManager.acquireRunLease();
    const extensionSnapshot = extensionLease.snapshot;
    if (
      input.recovery.version === 5
      && (
        input.recovery.extensions.config_digest !== extensionSnapshot.config_digest
        || stableStringify(input.recovery.extensions.active_tool_names)
          !== stableStringify(extensionSnapshot.active_tool_names)
      )
    ) {
      extensionLease.release();
      throw new RuntimeCommandError(
        "extension_configuration_drift",
        "Recovered Run extension configuration no longer matches its frozen snapshot",
      );
    }
    const skills = await this.#skillRegistry.scan(input.workspace.real_root);
    if (
      input.recovery.version === 5
      && input.recovery.skills !== undefined
      && input.recovery.skills.registry_digest !== skills.registry_digest
    ) {
      extensionLease.release();
      throw new RuntimeCommandError(
        "skill_configuration_drift",
        "Recovered Run Skill registry no longer matches its frozen snapshot",
      );
    }
    const lastLoadedSkill = [...input.events].reverse().find((event) => (
      event.type === "tool.completed"
      && (event.data.receipt as { tool_name?: unknown } | undefined)?.tool_name === "load_skill"
      && (event.data.observation as { status?: unknown } | undefined)?.status === "success"
    ));
    const loadedFacts = lastLoadedSkill?.data.observation;
    const loadedToolNames = loadedFacts !== undefined && typeof loadedFacts === "object" && loadedFacts !== null
      && "facts" in loadedFacts && typeof loadedFacts.facts === "object" && loadedFacts.facts !== null
      && Array.isArray((loadedFacts.facts as { effective_allowed_tools?: unknown }).effective_allowed_tools)
      ? (loadedFacts.facts as { effective_allowed_tools: unknown[] }).effective_allowed_tools
        .filter((tool): tool is string => typeof tool === "string")
      : undefined;
    const loadedSkillName = loadedFacts !== undefined && typeof loadedFacts === "object" && loadedFacts !== null
      && "facts" in loadedFacts && typeof loadedFacts.facts === "object" && loadedFacts.facts !== null
      && typeof (loadedFacts.facts as { skill_name?: unknown }).skill_name === "string"
      ? (loadedFacts.facts as { skill_name: string }).skill_name
      : undefined;
    return {
      ...input.sessionState,
      task: input.recovery.task,
      // The recovery Artifact is immutable start state. Steering messages are
      // rebuilt from queued+consumed Ledger facts so a crash after committing
      // user.input_consumed but before mutating process memory neither loses
      // nor duplicates the next model history message.
      conversationHistory: recoveredHistory,
      mode: projection.mode,
      reasoningEffort: input.recovery.reasoning_effort,
      workspace: input.workspace,
      model: profile?.model ?? this.#model,
      ...(profile === undefined ? {} : { rolePrompt: profile.rolePrompt }),
      ...(delegation === undefined ? {} : {
        toolAllowlist: new Set(delegation.spec.tool_allowlist as ToolName[]),
      }),
      skills,
      ...(loadedSkillName === undefined ? {} : { loadedSkill: loadedSkillName }),
      ...(loadedToolNames === undefined ? {} : {
        skillToolAllowlist: new Set<ToolName>([
          ...loadedToolNames.filter((tool): tool is ToolName => this.#toolRegistry.get(tool) !== undefined),
          "load_skill",
        ]),
      }),
      orchestration,
      maxTurns: delegation?.spec.budget.max_steps ?? this.#maxTurns,
      ...(recoveredBudget === undefined ? {} : { subagentBudget: recoveredBudget }),
      permissionPolicy: input.permissionPolicy,
      policyEngine: PolicyEngine.fromEffective(input.permissionPolicy, { idFactory: this.#idFactory }),
      extensionSnapshot: input.recovery.version === 5 ? input.recovery.extensions : extensionSnapshot,
      extensionLease,
      observations,
      // Raw image bytes are never reconstructed from Ledger events during a
      // resume. Interrupted Runs continue reference-only and remain replay-safe.
      modelImages: [],
      turn: input.events.filter((event) => event.type === "context.built").length,
      ...(input.pendingPatch === undefined ? {} : { pendingPatch: input.pendingPatch }),
      ...(projection.pending_plan === undefined ? {} : {
        pendingPlan: {
          planEventId: projection.pending_plan.plan_event_id,
          todoIds: projection.pending_plan.todo_ids,
        },
      }),
      ...(projection.input_queue.pending.find((item) => item.kind === "cancel")?.input_id === undefined
        ? {}
        : {
            cancelInputId: projection.input_queue.pending.find((item) => item.kind === "cancel")!.input_id,
          }),
      ...(lastPatchEventId === undefined ? {} : { lastPatchEventId }),
      ...(projection.code_intel === undefined
        ? {}
        : { codeIntelGitContext: projection.code_intel.git_context }),
      stopped: false,
      abortController: new AbortController(),
      commandQueue: Promise.resolve(),
      actionSignatures,
      canonicalActionSequence: 0,
    };
  }

  async #prepareSession(input: StartRunInput): Promise<{
    sessionId: string;
    created: boolean;
    lease?: SessionLease;
    lastEntryId?: string;
    indexedEventIds: Set<string>;
  }> {
    const sessionId = input.session_id ?? this.#idFactory("session");
    if (this.#sessionStore === undefined) {
      return {
        sessionId,
        created: input.session_id === undefined,
        indexedEventIds: new Set(),
      };
    }

    let created = false;
    if (input.session_id === undefined) {
      await this.#sessionStore.create(SessionHeaderSchema.parse({
        kind: "header",
        session_version: SESSION_FORMAT_VERSION,
        session_id: sessionId,
        project_id: input.project_id,
        created_at: this.#now().toISOString(),
        title: sessionTitle(input.task),
        run_ids: [],
      }));
      created = true;
    }

    const lease = await this.#sessionStore.acquireLease(sessionId);
    try {
      const existing = await this.#sessionStore.readAll(sessionId, lease);
      if (existing.header.project_id !== input.project_id) {
        throw new RuntimeCommandError(
          "session_project_mismatch",
          "Session belongs to another project",
        );
      }
      return {
        sessionId,
        created,
        lease,
        ...(existing.entries.at(-1)?.entry_id === undefined
          ? {}
          : { lastEntryId: existing.entries.at(-1)!.entry_id }),
        indexedEventIds: new Set(existing.entries.map((entry) => entry.event_ref.event_id)),
      };
    } catch (error) {
      await lease.release().catch(() => undefined);
      throw error;
    }
  }

  async #prepareChildSession(parent: RunState, link: SubagentRunLink, title: string): Promise<{
    sessionId: string;
    created: true;
    lease?: SessionLease;
    lastEntryId?: string;
    indexedEventIds: Set<string>;
  }> {
    if (this.#sessionStore === undefined) {
      return {
        sessionId: link.child_session_id,
        created: true,
        indexedEventIds: new Set(),
      };
    }
    await this.#sessionStore.create(SessionHeaderSchema.parse({
      kind: "header",
      session_version: SESSION_FORMAT_VERSION,
      session_id: link.child_session_id,
      project_id: parent.projectId,
      created_at: this.#now().toISOString(),
      title: sessionTitle(title),
      parent_session_id: link.parent_session_id,
      run_ids: [],
    }));
    const lease = await this.#sessionStore.acquireLease(link.child_session_id);
    try {
      const stored = await this.#sessionStore.readAll(link.child_session_id, lease);
      return {
        sessionId: link.child_session_id,
        created: true,
        lease,
        ...(stored.entries.at(-1)?.entry_id === undefined
          ? {}
          : { lastEntryId: stored.entries.at(-1)!.entry_id }),
        indexedEventIds: new Set(stored.entries.map((entry) => entry.event_ref.event_id)),
      };
    } catch (error) {
      await lease.release().catch(() => undefined);
      throw error;
    }
  }

  async #appendTodoProposal(proposal: SessionEventProposal): Promise<SessionEvent> {
    const events = await this.#ledger.list(proposal.run_id);
    const first = events[0];
    assertRunBelongsToProject(events, proposal.run_id, proposal.project_id);
    if (first?.session_id !== proposal.session_id) {
      throw new RuntimeCommandError("session_run_mismatch", "Todo event is outside the Run session scope");
    }
    const runtimeProposal: RuntimeEventProposal = {
      type: proposal.type,
      summary: proposal.summary,
      artifact_refs: proposal.artifact_refs,
      data: proposal.data,
      ...(proposal.idempotency_key === undefined ? {} : { idempotency_key: proposal.idempotency_key }),
      ...(proposal.turn_id === undefined ? {} : { turn_id: proposal.turn_id }),
      ...(proposal.operation_id === undefined ? {} : { operation_id: proposal.operation_id }),
      ...(proposal.parent_event_id === undefined ? {} : { parent_event_id: proposal.parent_event_id }),
      ...(proposal.caused_by_event_id === undefined ? {} : { caused_by_event_id: proposal.caused_by_event_id }),
      ...(proposal.context_manifest_ref === undefined ? {} : { context_manifest_ref: proposal.context_manifest_ref }),
      ...(proposal.model_call_id === undefined ? {} : { model_call_id: proposal.model_call_id }),
      ...(proposal.action_id === undefined ? {} : { action_id: proposal.action_id }),
      ...(proposal.patch_event_id === undefined ? {} : { patch_event_id: proposal.patch_event_id }),
      ...(proposal.graph_delta_id === undefined ? {} : { graph_delta_id: proposal.graph_delta_id }),
      ...(proposal.test_receipt_id === undefined ? {} : { test_receipt_id: proposal.test_receipt_id }),
    };
    const active = this.#runs.get(proposal.run_id);
    if (active !== undefined) {
      if (active.projectId !== proposal.project_id || active.sessionId !== proposal.session_id) {
        throw new RuntimeCommandError("run_scope_mismatch", "Todo event does not match the active Run");
      }
      return this.#append(active, runtimeProposal);
    }
    if (first?.session_id !== undefined && this.#sessionStore !== undefined) {
      const scope = await this.#openSessionScope({
        sessionId: first.session_id,
        runId: proposal.run_id,
        projectId: proposal.project_id,
      });
      try {
        return await this.#appendScoped(scope.state, runtimeProposal);
      } finally {
        await scope.release();
      }
    }
    return this.#appendScoped({
      runId: proposal.run_id,
      sessionId: first?.session_id ?? proposal.session_id ?? `session:${proposal.run_id}`,
      projectId: proposal.project_id,
      indexedSessionEventIds: new Set(),
    }, runtimeProposal);
  }

  async #appendTeamAtomic(
    scope: AtomicEventScope,
    proposals: readonly SessionEventProposal[],
    finalize?: (resolved: readonly SessionEvent[]) => SessionEventProposal,
  ): Promise<AtomicAppendResult> {
    const events = await this.#ledger.list(scope.run_id);
    const first = events[0];
    assertRunBelongsToProject(events, scope.run_id, scope.project_id);
    if (first?.session_id !== scope.session_id) {
      throw new RuntimeCommandError("session_run_mismatch", "Atomic Team events are outside the Run session scope");
    }
    const active = this.#runs.get(scope.run_id);
    if (active !== undefined) {
      if (active.projectId !== scope.project_id || active.sessionId !== scope.session_id) {
        throw new RuntimeCommandError("run_scope_mismatch", "Atomic Team events do not match the active Run");
      }
      return this.#appendScopedAtomic(active, proposals, finalize);
    }
    if (first?.session_id !== undefined && this.#sessionStore !== undefined) {
      const opened = await this.#openSessionScope({
        sessionId: first.session_id,
        runId: scope.run_id,
        projectId: scope.project_id,
      });
      try {
        return await this.#appendScopedAtomic(opened.state, proposals, finalize);
      } finally {
        await opened.release();
      }
    }
    return this.#appendScopedAtomic({
      runId: scope.run_id,
      sessionId: first?.session_id ?? scope.session_id ?? `session:${scope.run_id}`,
      projectId: scope.project_id,
      indexedSessionEventIds: new Set(),
    }, proposals, finalize);
  }

  async #append(
    state: RunState,
    proposal: RuntimeEventProposal,
  ): Promise<SessionEvent> {
    return this.#appendScoped(state, proposal);
  }

  async #appendScoped(
    state: SessionScopedState,
    proposal: RuntimeEventProposal,
  ): Promise<SessionEvent> {
    const previous = this.#appendQueues.get(state.runId) ?? Promise.resolve();
    const operation = previous.then(
      () => this.#appendScopedInOrder(state, proposal),
      () => this.#appendScopedInOrder(state, proposal),
    );
    const tail = operation.then(() => undefined, () => undefined);
    this.#appendQueues.set(state.runId, tail);
    void tail.then(() => {
      if (this.#appendQueues.get(state.runId) === tail) this.#appendQueues.delete(state.runId);
    });
    return operation;
  }

  async #appendScopedAtomic(
    state: SessionScopedState,
    proposals: readonly SessionEventProposal[],
    finalize?: (resolved: readonly SessionEvent[]) => SessionEventProposal,
  ): Promise<AtomicAppendResult> {
    const previous = this.#appendQueues.get(state.runId) ?? Promise.resolve();
    const operation = previous.then(
      () => this.#appendScopedAtomicInOrder(state, proposals, finalize),
      () => this.#appendScopedAtomicInOrder(state, proposals, finalize),
    );
    const tail = operation.then(() => undefined, () => undefined);
    this.#appendQueues.set(state.runId, tail);
    void tail.then(() => {
      if (this.#appendQueues.get(state.runId) === tail) this.#appendQueues.delete(state.runId);
    });
    return operation;
  }

  async #appendExtensionError(
    state: RunState,
    error: ExtensionRuntimeError,
    sourceEvent: SessionEvent,
  ): Promise<void> {
    const data = this.#extensionManager.toErrorData(error, sourceEvent);
    await this.#append(state, {
      type: "extension.error",
      summary: `Extension ${data.extension_name} failed during ${data.phase}`,
      idempotency_key: `extension-error:${sha256(stableStringify(data))}`,
      caused_by_event_id: data.source_event_id,
      data,
    });
  }

  async #appendScopedInOrder(
    state: SessionScopedState,
    proposal: RuntimeEventProposal,
  ): Promise<SessionEvent> {
    const event = await this.#ledger.append(this.#scopedLedgerProposal(state, proposal));
    await this.#afterCanonicalBatchInOrder(state, [event]);
    return event;
  }

  async #appendScopedAtomicInOrder(
    state: SessionScopedState,
    proposals: readonly SessionEventProposal[],
    finalize?: (resolved: readonly SessionEvent[]) => SessionEventProposal,
  ): Promise<AtomicAppendResult> {
    const result = await this.#ledger.appendAtomic(
      { project_id: state.projectId, run_id: state.runId, session_id: state.sessionId },
      proposals.map((proposal) => this.#scopedLedgerProposal(state, proposal)),
      finalize === undefined
        ? undefined
        : (resolved) => this.#scopedLedgerProposal(state, finalize(resolved)),
    );
    // Canonical facts become visible to derived projections only after the
    // complete batch has reached the durable replace boundary.
    await this.#afterCanonicalBatchInOrder(state, result.appended);
    return result;
  }

  #scopedLedgerProposal(
    state: SessionScopedState,
    proposal: RuntimeEventProposal | SessionEventProposal,
  ): SessionEventProposal {
    return {
      ...proposal,
      // Event summaries are deliberately compact. Full final answers live in
      // the terminal event's redacted `data.outcome` field and are projected
      // separately, so a useful long answer cannot invalidate the run ledger.
      summary: redactSensitiveText(proposal.summary).slice(0, 2_000),
      // Team payloads are already bounded and schema-validated by
      // TeamDomainService. Preserve their complete arrays (up to the Team
      // contract maxima); the generic projection redactor intentionally caps
      // arrays at 100 and would corrupt atomic reopen/evidence receipts.
      data: (proposal.type.startsWith("team.")
        ? redactStructuredArtifactValue(proposal.data)
        : redactStructuredValue(proposal.data)) as Record<string, unknown>,
      project_id: state.projectId,
      run_id: state.runId,
      session_id: state.sessionId,
      attempt: 0,
      artifact_refs: proposal.artifact_refs ?? [],
    };
  }

  async #afterCanonicalBatchInOrder(
    state: SessionScopedState,
    events: readonly SessionEvent[],
  ): Promise<void> {
    // Telemetry is derived only after the canonical ledger commit succeeds.
    // The projector and SafeTelemetry both fail closed to observation loss,
    // never to Run failure.
    const terminal = events.some((event) => isTerminalEventType(event.type));
    try {
      // First publish/index every canonical member in sequence order. Extension
      // callbacks may append new facts, so dispatching one before the rest of
      // an already-committed batch would invert both the Session index and live
      // activity stream relative to the ledger hash chain.
      for (const event of events) {
        this.#runtimeTelemetry.record(event);
        if (isTerminalEventType(event.type)) {
          // Start the best-effort terminal export immediately after the canonical
          // Event commit. Session indexing is a derived projection and may fail;
          // it must not leave an already-durable terminal fact unflushed.
          void this.flushTelemetry();
        }
        await this.#indexSessionEvent(state, event);
        this.#publishLive(event);
      }
      for (const event of events) {
        if (event.type === "extension.error") continue;
        const errors = [
          ...this.#extensionManager.drainTelemetryErrors(),
          ...await this.#extensionManager.dispatchEvent(event),
        ];
        for (const error of errors) {
          await this.#appendExtensionErrorInOrder(state, error, event);
        }
      }
    } finally {
      if (terminal) {
        state.extensionLease?.release();
        delete state.extensionLease;
      }
    }
  }

  async #appendExtensionErrorInOrder(
    state: SessionScopedState,
    error: ExtensionRuntimeError,
    sourceEvent: SessionEvent,
  ): Promise<void> {
    const data = this.#extensionManager.toErrorData(error, sourceEvent);
    const fingerprint = sha256(stableStringify(data));
    await this.#appendScopedInOrder(state, {
      type: "extension.error",
      summary: `Extension ${data.extension_name} failed during ${data.phase}`,
      idempotency_key: `extension-error:${fingerprint}`,
      caused_by_event_id: data.source_event_id,
      data,
    });
  }

  async #indexSessionEvent(state: SessionScopedState, event: SessionEvent): Promise<void> {
    if (
      this.#sessionStore === undefined
      || state.sessionLease === undefined
      || state.indexedSessionEventIds.has(event.event_id)
    ) {
      return;
    }
    await state.sessionLease.heartbeat();
    const entry = SessionEventReferenceSchema.parse({
      kind: "event_ref",
      session_version: SESSION_FORMAT_VERSION,
      entry_id: this.#idFactory("session-entry"),
      ...(state.lastSessionEntryId === undefined
        ? {}
        : { parent_entry_id: state.lastSessionEntryId }),
      created_at: event.occurred_at,
      event_ref: {
        event_id: event.event_id,
        run_id: event.run_id,
        sequence: event.sequence,
      },
    });
    await this.#sessionStore.append(state.sessionId, entry, state.sessionLease);
    state.lastSessionEntryId = entry.entry_id;
    state.indexedSessionEventIds.add(event.event_id);
  }

  #publishLive(event: SessionEvent): void {
    const activity = toLivePublicActivity(event);
    if (activity === undefined) return;
    const activities = this.#liveActivities.get(event.run_id) ?? [];
    // Idempotent ledger appends can return a pre-existing event. Do not make
    // an SSE client see a duplicate activity for that canonical source event.
    if (activities.some((item) => item.source_event_id === activity.source_event_id)) return;
    activities.push(activity);
    // The buffer is only a short reconnect bridge, not a second event store.
    if (activities.length > 128) activities.splice(0, activities.length - 128);
    this.#liveActivities.set(event.run_id, activities);
    for (const listener of this.#liveListeners.get(event.run_id) ?? []) {
      try {
        listener(activity);
      } catch {
        // Live presentation is best-effort. It cannot affect a committed Run.
      }
    }
  }

  /**
   * Coalesce real provider fragments into a latest-safe-snapshot stream. This
   * keeps the UI responsive without treating every token as a ledger fact or
   * causing one React update per transport chunk.
   */
  #queueModelSurface(
    state: RunState,
    modelCallId: string,
    update: PublicModelProgressUpdate,
  ): void {
    // Provider-native reasoning (for example DeepSeek's
    // `reasoning_content` or Anthropic's thinking blocks) is private model
    // scratchpad data.  Keep the compatibility kind in the adapter contract,
    // but never put it on the browser-facing model surface.  The only live
    // model text allowed through this path is the explicit public_reason and
    // final_answer fields from the validated Decision envelope.
    if (update.kind === "thinking_delta") return;
    const type = update.kind === "public_reason_delta"
      ? "public_plan_snapshot"
      : "answer_snapshot";
    const fragment = redactSensitiveText(update.text).replace(/\u0000/gu, "");
    if (!fragment) return;
    const key = `${state.runId}:${modelCallId}:${type}`;
    const pending = this.#pendingModelSurface.get(key) ?? {
      runId: state.runId,
      projectId: state.projectId,
      modelCallId,
      type,
      text: "",
    } satisfies PendingModelSurface;
    if (pending.text.length >= 8_000) return;
    pending.text = `${pending.text}${fragment}`.slice(0, 8_000);
    this.#pendingModelSurface.set(key, pending);
    if (pending.timer !== undefined) return;
    pending.timer = setTimeout(() => this.#flushModelSurface(key, "streaming"), 75);
  }

  #flushModelSurfaceForCall(
    runId: string,
    modelCallId: string,
    status: "completed" | "failed" | "cancelled",
    publicPlanOverride?: string,
  ): void {
    const state = this.#runs.get(runId);
    const key = `${runId}:${modelCallId}:public_plan_snapshot`;
    if (publicPlanOverride !== undefined && state !== undefined) {
      const existing = this.#pendingModelSurface.get(key);
      const pending = existing ?? {
        runId,
        projectId: state.projectId,
        modelCallId,
        type: "public_plan_snapshot",
        text: "",
      } satisfies PendingModelSurface;
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      delete pending.timer;
      pending.text = publicPlanOverride.slice(0, 360);
      this.#pendingModelSurface.set(key, pending);
    }
    for (const [key, pending] of this.#pendingModelSurface) {
      if (pending.runId === runId && pending.modelCallId === modelCallId) {
        this.#flushModelSurface(key, status);
      }
    }
  }

  #flushModelSurface(
    key: string,
    status: "streaming" | "completed" | "failed" | "cancelled",
  ): void {
    const pending = this.#pendingModelSurface.get(key);
    if (pending === undefined || !pending.text) return;
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer);
      delete pending.timer;
    }
    const cursor = (this.#modelSurfaceCursors.get(pending.runId) ?? 0) + 1;
    this.#modelSurfaceCursors.set(pending.runId, cursor);
    const event = ModelSurfaceEventSchema.parse({
      schema_version: "tracegraph.session-event.v1",
      surface_event_id: `surface:${pending.runId}:${cursor}`,
      project_id: pending.projectId,
      run_id: pending.runId,
      model_call_id: pending.modelCallId,
      cursor,
      occurred_at: this.#now().toISOString(),
      type: pending.type,
      status,
      text: pending.text,
    });
    const events = this.#modelSurfaceEvents.get(pending.runId) ?? [];
    events.push(event);
    // A reconnect only needs recent snapshots. Each snapshot supersedes the
    // preceding one for the same model call + surface type.
    if (events.length > 96) events.splice(0, events.length - 96);
    this.#modelSurfaceEvents.set(pending.runId, events);
    for (const listener of this.#modelSurfaceListeners.get(pending.runId) ?? []) {
      try {
        listener(event);
      } catch {
        // Presentation failures cannot affect a validated Decision or Run.
      }
    }
  }

  async #fail(
    state: RunState,
    code: string,
    summary: string,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    await this.#terminal(state, "run.failed", summary, { code, ...data });
  }

  async #terminal(
    state: RunState,
    type: "run.completed" | "run.failed" | "run.cancelled",
    summary: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.#withRunControl(state.runId, async () => {
      const events = await this.#ledger.list(state.runId);
      if (events.some((event) => isTerminalEventType(event.type))) {
        state.modelImages.length = 0;
        state.stopped = true;
        await this.#releaseSessionLease(state);
        return;
      }
      // A durable cancel request wins over a concurrently discovered failure
      // or normal completion. Its finalizer will consume the exact input and
      // append the sole terminal event after the active safe boundary.
      if (
        projectRun(events).input_queue.pending.some((input) => input.kind === "cancel")
        && !(type === "run.cancelled" && (
          data.reason === "user_cancel" || data.reason === "parent_agent_cancel"
        ))
      ) return;
      await this.#appendTerminalLocked(state, type, summary, data);
    });
  }

  async #appendTerminalLocked(
    state: RunState,
    type: "run.completed" | "run.failed" | "run.cancelled",
    summary: string,
    data: Record<string, unknown>,
  ): Promise<SessionEvent> {
    const event = await this.#append(state, {
      type,
      summary,
      data,
      idempotency_key: `${state.runId}:terminal`,
    });
    if (event.type !== type) {
      throw new RuntimeCommandError(
        "terminal_idempotency_conflict",
        "Run terminal idempotency key resolved to a non-terminal transition",
      );
    }
    state.stopped = true;
    state.modelImages.length = 0;
    await this.#releaseSessionLease(state);
    return event;
  }

  async #releaseSessionLease(state: RunState): Promise<void> {
    if (state.sessionLease === undefined) return;
    const lease = state.sessionLease;
    delete state.sessionLease;
    await lease.release();
  }

  async #consumeNextUserInput(state: RunState, atStep: number): Promise<"none" | "message" | "cancelled"> {
    let consumedInput: PendingUserInput | undefined;
    const outcome = await this.#withRunControl(state.runId, async () => {
      const events = await this.#ledger.list(state.runId);
      if (events.some((event) => isTerminalEventType(event.type))) return "none" as const;
      const pending = projectRun(events).input_queue.pending[0];
      if (pending === undefined) return "none" as const;
      const queued = findQueuedInput(events, pending.input_id);
      if (queued === undefined) {
        throw new RuntimeCommandError("input_queue_corrupt", "Pending user input has no queued event");
      }
      const consumedAt = this.#now().toISOString();
      const consumedAtStep = nextUserInputStep(events, atStep);
      const consumed = await this.#append(state, {
        type: "user.input_consumed",
        summary: pending.kind === "cancel"
          ? pending.actor === "parent_agent"
            ? "Parent-agent cancellation consumed at a safe boundary"
            : "User cancellation consumed at a safe boundary"
          : pending.actor === "parent_agent"
            ? "Parent-agent message consumed before the next model request"
            : "User input consumed before the next model request",
        idempotency_key: userInputConsumedEventKey(state.runId, pending.input_id),
        caused_by_event_id: queued.event.event_id,
        data: UserInputConsumedDataSchema.parse({
          input_id: pending.input_id,
          kind: pending.kind,
          consumed_at: consumedAt,
          at_step: consumedAtStep,
          queued_event_id: queued.event.event_id,
        }),
      });
      assertConsumedUserInputEvent(consumed, pending.input_id, queued.event.event_id);
      consumedInput = pending;
      if (pending.kind === "cancel") {
        state.cancelInputId = pending.input_id;
        state.stopped = true;
        state.abortController.abort(new Error(
          pending.actor === "parent_agent" ? "Run cancelled by parent agent" : "Run cancelled by user input",
        ));
        await this.#appendTerminalLocked(
          state,
          "run.cancelled",
          pending.actor === "parent_agent" ? "Child Run cancelled by parent agent" : "Run cancelled by user",
          {
            reason: pending.actor === "parent_agent" ? "parent_agent_cancel" : "user_cancel",
            last_sequence: consumed.sequence,
          },
        );
        return "cancelled" as const;
      }
      return "message" as const;
    });
    if (outcome === "message" && consumedInput !== undefined) {
      state.conversationHistory = [
        ...(state.conversationHistory ?? []),
        { role: "user", content: consumedInput.body },
      ];
    }
    return outcome;
  }

  async #finalizeUserCancellation(state: RunState, inputId: string): Promise<void> {
    await this.#withRunControl(state.runId, async () => {
      const events = await this.#ledger.list(state.runId);
      const terminal = events.find((event) => isTerminalEventType(event.type));
      if (terminal !== undefined) {
        if (terminal.type === "run.cancelled" && (
          terminal.data.reason === "user_cancel" || terminal.data.reason === "parent_agent_cancel"
        )) {
          // Re-submit the same terminal key through #append so a crash after
          // Event Ledger commit but before Session indexing is repaired. The
          // Ledger returns the existing terminal; no second fact is created.
          await this.#appendTerminalLocked(
            state,
            "run.cancelled",
            terminal.summary,
            terminal.data,
          );
          return;
        }
        await this.#releaseSessionLease(state);
        return;
      }
      const queued = findQueuedInput(events, inputId);
      if (queued === undefined || queued.input.kind !== "cancel") {
        throw new RuntimeCommandError("cancel_input_unavailable", "Durable cancel input is unavailable");
      }
      let consumed = findConsumedInputEvent(events, inputId);
      if (consumed === undefined) {
        const consumedAtStep = nextUserInputStep(events, Math.max(1, state.turn));
        consumed = await this.#append(state, {
          type: "user.input_consumed",
          summary: queued.input.actor === "parent_agent"
            ? "Parent-agent cancellation consumed at a safe boundary"
            : "User cancellation consumed at a safe boundary",
          idempotency_key: userInputConsumedEventKey(state.runId, inputId),
          caused_by_event_id: queued.event.event_id,
          data: UserInputConsumedDataSchema.parse({
            input_id: inputId,
            kind: "cancel",
            consumed_at: this.#now().toISOString(),
            at_step: consumedAtStep,
            queued_event_id: queued.event.event_id,
          }),
        });
        assertConsumedUserInputEvent(consumed, inputId, queued.event.event_id);
      }
      await this.#appendTerminalLocked(
        state,
        "run.cancelled",
        queued.input.actor === "parent_agent" ? "Child Run cancelled by parent agent" : "Run cancelled by user",
        {
          reason: queued.input.actor === "parent_agent" ? "parent_agent_cancel" : "user_cancel",
          last_sequence: consumed.sequence,
        },
      );
    });
  }

  #armCancellationLocked(
    state: RunState,
    events: readonly SessionEvent[],
    inputId: string,
  ): boolean {
    if (events.some((event) => isTerminalEventType(event.type))) return false;
    const queued = findQueuedInput(events, inputId);
    if (queued === undefined || queued.input.kind !== "cancel") {
      throw new RuntimeCommandError(
        "cancel_input_unavailable",
        "Durable replay did not resolve to the expected cancel input",
      );
    }
    state.cancelInputId = inputId;
    state.modelImages.length = 0;
    state.stopped = true;
    state.abortController.abort(new Error("Run cancelled by durable user input"));
    return true;
  }

  #scheduleUserCancellationFinalizer(state: RunState, inputId: string): void {
    // Re-enqueue on every durable retry. A prior finalizer may itself have
    // failed after committing consumed/terminal to the Event Ledger but before
    // Session indexing; all steps below are ledger-idempotent and re-runnable.
    void this.#enqueue(state, () => this.#finalizeUserCancellation(state, inputId))
      .catch(() => undefined);
  }

  async #bindDuplicateUserInputCommandLocked(
    events: readonly SessionEvent[],
    projection: RunProjection,
    command: SubmitUserInputCommand,
    commandDigest: string,
    inputDigest: string,
    idempotencyKey: string,
  ): Promise<void> {
    if (isTerminalProjectionStatus(projection.status)) return;
    const prior = findQueuedInput(events, command.input_id);
    if (prior === undefined) {
      throw new RuntimeCommandError(
        "input_replay_unavailable",
        "Duplicate user input has no canonical queued event",
      );
    }
    const first = events[0];
    if (first === undefined) {
      throw new RuntimeCommandError("run_not_found", "Run is unavailable");
    }
    const alias = await this.#appendTodoProposal({
      type: "user.input_queued",
      project_id: command.project_id,
      run_id: command.run_id,
      ...(first.session_id === undefined ? {} : { session_id: first.session_id }),
      attempt: 0,
      summary: "Duplicate user input command bound to its canonical input",
      artifact_refs: [],
      idempotency_key: idempotencyKey,
      data: UserInputQueuedDataSchema.parse({
        input: prior.input,
        _internal_command_digest: commandDigest,
        _internal_input_digest: inputDigest,
      }),
    });
    const parsed = alias.type === "user.input_queued"
      ? UserInputQueuedDataSchema.safeParse(alias.data)
      : undefined;
    if (
      parsed === undefined
      || !parsed.success
      || parsed.data.input.input_id !== command.input_id
      || parsed.data._internal_command_digest !== commandDigest
      || parsed.data._internal_input_digest !== inputDigest
    ) {
      throw new RuntimeCommandError(
        "command_id_conflict",
        "Duplicate command id resolved to a different durable user input binding",
      );
    }
  }

  async #repairUserInputCommandIndexLocked(
    state: RunState,
    event: SessionEvent,
  ): Promise<void> {
    if (event.type !== "user.input_queued" || event.idempotency_key === undefined) {
      throw new RuntimeCommandError(
        "command_id_conflict",
        "User input command receipt is not a queued input event",
      );
    }
    const replayed = await this.#append(state, {
      type: "user.input_queued",
      summary: event.summary,
      idempotency_key: event.idempotency_key,
      data: event.data,
    });
    if (replayed.type !== "user.input_queued" || replayed.event_id !== event.event_id) {
      throw new RuntimeCommandError(
        "command_id_conflict",
        "User input command receipt resolved to another durable event",
      );
    }
  }

  async #isTerminal(runId: string): Promise<boolean> {
    return (await this.#ledger.list(runId)).some((event) => isTerminalEventType(event.type));
  }

  #assertControlMutationAllowedLocked(state: RunState, events: readonly SessionEvent[]): void {
    if (events.some((event) => isTerminalEventType(event.type))) {
      throw new RuntimeCommandError("run_terminal", "A terminal Run cannot accept control mutations");
    }
    if (
      state.stopped
      || state.cancelInputId !== undefined
      || projectRun(events).input_queue.pending.some((input) => input.kind === "cancel")
    ) {
      throw new RuntimeCommandError("run_cancelling", "Run cancellation is already queued");
    }
  }

  #enqueue<T>(state: RunState, operation: () => Promise<T>): Promise<T> {
    const result = state.commandQueue.then(operation, operation);
    state.commandQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  #withRunControl<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#controlQueues.get(runId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    this.#controlQueues.set(runId, tail);
    void tail.then(() => {
      if (this.#controlQueues.get(runId) === tail) this.#controlQueues.delete(runId);
    });
    return result;
  }

  #runInputCommand(
    commandId: string,
    signature: string,
    operation: () => Promise<SubmitUserInputResult>,
  ): Promise<SubmitUserInputResult> {
    if (this.#commandRuns.has(commandId)) {
      return Promise.reject(new RuntimeCommandError(
        "command_id_conflict",
        "Command id was already used for a different command kind",
      ));
    }
    const existing = this.#inputCommandRuns.get(commandId);
    if (existing !== undefined) {
      if (existing.signature !== signature) {
        return Promise.reject(new RuntimeCommandError(
          "command_id_conflict",
          "Command id was already used with a different payload",
        ));
      }
      // Wait for the in-flight owner, then replay through the Ledger path
      // instead of only returning the cached value. In particular, every
      // durable cancel retry must re-arm abort and its idempotent finalizer in
      // case a prior finalizer failed during secondary Session indexing.
      return existing.result.then(() => operation());
    }
    let result: Promise<SubmitUserInputResult>;
    try {
      result = operation();
    } catch (error) {
      result = Promise.reject(error);
    }
    this.#inputCommandRuns.set(commandId, { signature, result });
    void result.catch(() => {
      const current = this.#inputCommandRuns.get(commandId);
      if (current?.result === result) this.#inputCommandRuns.delete(commandId);
    });
    return result;
  }

  #runCommand(
    commandId: string,
    signature: string,
    operation: () => Promise<RunProjection>,
  ): Promise<RunProjection> {
    if (this.#inputCommandRuns.has(commandId)) {
      return Promise.reject(new RuntimeCommandError(
        "command_id_conflict",
        "Command id was already used for a different command kind",
      ));
    }
    const existing = this.#commandRuns.get(commandId);
    if (existing !== undefined) {
      if (existing.signature !== signature) {
        return Promise.reject(new RuntimeCommandError(
          "command_id_conflict",
          "Command id was already used with a different payload",
        ));
      }
      return existing.result.then((projection) => this.getProjection(projection.run_id));
    }
    let result: Promise<RunProjection>;
    try {
      result = operation();
    } catch (error) {
      result = Promise.reject(error);
    }
    this.#commandRuns.set(commandId, { signature, result });
    return result;
  }

  #requireRun(runId: string, projectId: string): RunState {
    const state = this.#runs.get(runId);
    if (state === undefined || state.projectId !== projectId) {
      throw new RuntimeCommandError("run_not_found", "Run is unavailable or outside the project scope");
    }
    return state;
  }

  #requirePending(state: RunState, command: ApprovalCommand): PendingPatch {
    const pending = state.pendingPatch;
    if (pending === undefined) {
      throw new RuntimeCommandError("approval_not_pending", "Run has no pending approval");
    }
    if (
      pending.pendingApproval.approval_id !== command.approval_id
      || pending.pendingApproval.action_id !== command.action_id
    ) {
      throw new RuntimeCommandError("approval_binding_mismatch", "Approval does not match the pending action");
    }
    return pending;
  }
}

export class RuntimeCommandError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RuntimeCommandError";
  }
}

function assertRecoveredChildProvenance(
  parent: SessionScopedState,
  delegation: SubagentStartedData,
  childEvents: readonly SessionEvent[],
): void {
  const { link, spec, limits } = delegation;
  const created = childEvents[0];
  const invalid = created === undefined
    || created.type !== "run.created"
    || created.run_id !== link.child_run_id
    || created.session_id !== link.child_session_id
    || created.project_id !== parent.projectId
    || link.parent_run_id !== parent.runId
    || link.parent_session_id !== parent.sessionId
    || created.data.parent_run_id !== link.parent_run_id
    || created.data.parent_session_id !== link.parent_session_id
    || created.data.subagent_id !== link.subagent_id
    || created.data.subagent_depth !== spec.depth
    || stableStringify(created.data.subagent_limits) !== stableStringify(limits);
  if (invalid) {
    throw new RuntimeCommandError(
      "subagent_recovery_provenance_mismatch",
      "Child Run provenance does not match the parent delegation link",
    );
  }
}

function legacyPermissionPolicy(sandboxMode: SandboxMode): EffectivePermissionPolicy {
  if (sandboxMode === "read-only") {
    return createEffectivePermissionPolicy({ preset: CORE_BUILTIN_PERMISSION_PRESETS["read-only"] });
  }
  if (sandboxMode === "workspace-write") {
    return createEffectivePermissionPolicy({ preset: CORE_BUILTIN_PERMISSION_PRESETS["workspace-write"] });
  }
  // `sandboxMode` predates named permissions. Preserve its historical manual
  // write approval semantics instead of silently turning the old flag into the
  // new full-write/no-approval preset.
  return createEffectivePermissionPolicy({
    preset: {
      ...CORE_BUILTIN_PERMISSION_PRESETS["full-write"],
      key: "custom",
      label: "Legacy danger full access",
      approval_policy: "on-write",
    },
  });
}

function legacyRecoveryPermissionPolicy(
  events: readonly SessionEvent[],
  fallback: EffectivePermissionPolicy,
): EffectivePermissionPolicy {
  const configured = [...events].reverse().find((event) => event.type === "sandbox.configured");
  const parsed = SandboxModeSchema.safeParse(configured?.data.mode);
  if (parsed.success) return legacyPermissionPolicy(parsed.data);
  // Very old ledgers without a sandbox fact are restored under the narrower
  // of the current default and read-only. Never infer write authority.
  return fallback.preset.sandbox_mode === "read-only"
    ? fallback
    : legacyPermissionPolicy("read-only");
}

function policyTargetForCall(input: unknown): { path?: string; diffLines?: number } {
  if (typeof input !== "object" || input === null) return {};
  const record = input as Record<string, unknown>;
  const path = typeof record.path === "string" ? record.path : undefined;
  const expected = typeof record.expected === "string" ? record.expected : undefined;
  const replacement = typeof record.replacement === "string" ? record.replacement : undefined;
  const diffLines = expected === undefined && replacement === undefined
    ? undefined
    : countTextLines(expected ?? "") + countTextLines(replacement ?? "");
  return {
    ...(path === undefined ? {} : { path }),
    ...(diffLines === undefined ? {} : { diffLines }),
  };
}

function countTextLines(value: string): number {
  return value.length === 0 ? 0 : value.split("\n").length;
}

function approvalTokenDenial(error: unknown): {
  code: string;
  reason: ApprovalDenialReason;
  explanation: string;
} {
  if (!(error instanceof ApprovalTokenStoreError)) {
    return {
      code: "approval_token_unavailable",
      reason: "unavailable",
      explanation: `Approval token could not be validated: ${publicError(error)}`,
    };
  }
  if (error.code === "approval_token_expired") {
    return { code: error.code, reason: "token_expired", explanation: error.message };
  }
  if (error.code === "approval_token_consumed") {
    return { code: error.code, reason: "token_consumed", explanation: error.message };
  }
  if (
    error.code === "approval_token_binding_mismatch"
    || error.code === "approval_token_digest_mismatch"
    || error.code === "approval_token_policy_mismatch"
    || error.code === "approval_token_scope_mismatch"
  ) {
    return { code: error.code, reason: "digest_mismatch", explanation: error.message };
  }
  return { code: error.code, reason: "unavailable", explanation: error.message };
}

function policyDenialCode(decision: PolicyDecision): string {
  if (decision.source !== "hard-constraint") return "policy_denied";
  const explanation = decision.explanation.toLowerCase();
  if (explanation.includes("workspace capability")) return "capability_denied";
  if (explanation.includes("plan mode")) return "plan_mode_denied";
  if (explanation.includes("read-only")) return "sandbox_denied";
  if (explanation.includes("outside the permission preset scope")) return "path_scope_denied";
  if (explanation.includes("invalid policy path")) return "invalid_policy_path";
  if (explanation.includes("does not allow")) return "preset_denied";
  return "policy_denied";
}

/**
 * Signals an intentionally exposed crash boundary after an Action WAL record
 * or filesystem mutation. Runtime must not translate this into an ordinary
 * tool failure because startup reconciliation, rather than model retry, owns
 * the uncertain action.
 */
export class ActionCommitInterruptedError extends Error {
  readonly code = "action_commit_interrupted";

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "ActionCommitInterruptedError";
  }
}

function parseSessionRunLocator(input: SessionRunLocator): SessionRunLocator {
  return {
    sessionId: IdentifierSchema.parse(input.sessionId),
    runId: IdentifierSchema.parse(input.runId),
    projectId: IdentifierSchema.parse(input.projectId),
  };
}

function assertRunBelongsToSession(
  events: readonly SessionEvent[],
  input: SessionRunLocator,
): void {
  const first = events[0];
  if (first === undefined) {
    throw new RuntimeCommandError("run_not_found", "Run is unavailable");
  }
  if (
    first.run_id !== input.runId
    || first.project_id !== input.projectId
    || first.session_id !== input.sessionId
    || events.some((event) => (
      event.run_id !== input.runId
      || event.project_id !== input.projectId
      || event.session_id !== input.sessionId
    ))
  ) {
    throw new RuntimeCommandError("session_run_mismatch", "Run is outside the durable session scope");
  }
}

function assertRunBelongsToProject(
  events: readonly SessionEvent[],
  runId: string,
  projectId: string,
): void {
  const first = events[0];
  if (first === undefined) {
    throw new RuntimeCommandError("run_not_found", "Run is unavailable");
  }
  if (
    first.run_id !== runId
    || first.project_id !== projectId
    || events.some((event) => event.run_id !== runId || event.project_id !== projectId)
  ) {
    throw new RuntimeCommandError("project_mismatch", "Run is outside the project scope");
  }
}

function findLastEventIndex(events: readonly SessionEvent[], type: SessionEvent["type"]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === type) return index;
  }
  return -1;
}

function isFinishedProjectionStatus(status: RunProjection["status"]): boolean {
  return isTerminalProjectionStatus(status)
    || status === "needs_manual_review";
}

function isTerminalProjectionStatus(status: RunProjection["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isQuiescentProjectionStatus(status: RunProjection["status"]): boolean {
  return isFinishedProjectionStatus(status) || status === "interrupted";
}

function actionCommitInterrupted(message: string, cause: unknown): ActionCommitInterruptedError {
  if (cause instanceof ActionCommitInterruptedError) return cause;
  return new ActionCommitInterruptedError(message, { cause });
}

interface WalDiskState {
  classification: "before" | "after" | "diverged";
  hashes: string[];
}

function latestWalRecords(records: readonly ActionWalRecord[]): ActionWalRecord[] {
  const latest = new Map<string, ActionWalRecord>();
  for (const record of records) latest.set(record.action_id, record);
  return [...latest.values()].sort((left, right) => left.sequence - right.sequence);
}

async function walWorkspaceBindingFailure(
  durable: ActionWalRecord,
  workspace: WorkspaceHandle,
): Promise<string | undefined> {
  if (durable.project_id !== workspace.project_id) return "workspace_project_mismatch";
  if (durable.workspace_kind !== workspace.workspace_kind) return "workspace_kind_mismatch";
  if (!workspace.capabilities.commit_patch) return "workspace_capability_denied";
  try {
    const canonicalRoot = await realpath(workspace.real_root);
    if (sha256(canonicalRoot) !== durable.workspace_root_hash) return "workspace_root_mismatch";
  } catch {
    return "workspace_root_unavailable";
  }
  return undefined;
}

async function inspectWalTargets(
  durable: ActionWalRecord,
  workspace: WorkspaceHandle,
): Promise<WalDiskState> {
  const states: Array<{ before: boolean; after: boolean; hash: string }> = [];
  for (const target of durable.targets) {
    const resolvedTarget = await resolvePatchTarget(workspace, target.target_path);
    if (!resolvedTarget.exists) {
      states.push({ before: !target.existed, after: false, hash: "missing" });
      continue;
    }
    const info = await lstat(resolvedTarget.path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new ActionCommitInterruptedError("Action WAL target is not a regular file");
    }
    const hash = sha256(await readFile(resolvedTarget.path));
    states.push({
      before: target.existed && hash === target.before_hash,
      after: hash === target.after_hash,
      hash,
    });
  }
  return {
    classification: states.every((state) => state.before)
      ? "before"
      : states.every((state) => state.after)
        ? "after"
        : "diverged",
    hashes: states.map((state) => state.hash),
  };
}

async function replaceTargetDurably(path: string, content: Uint8Array): Promise<void> {
  const temporary = resolve(
    dirname(path),
    `.${basename(path)}.tracegraph-rollback-${process.pid}-${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await syncParentDirectory(dirname(path));
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function syncParentDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(
    directory,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function sessionTitle(task: string): string {
  const title = redactSensitiveText(task).replace(/\s+/gu, " ").trim().slice(0, 120);
  return title || "Untitled session";
}

function contextCompactionStartedSummary(input: { strategies: readonly string[] }): string {
  return input.strategies.length === 0
    ? "Context compaction side effects are starting before the next model request"
    : `Context is starting the configured compaction chain (${input.strategies.join(" -> ")})`;
}

function contextCompactionCompletedSummary(compression: ContextCompression): string {
  const reduction = `${compression.before_tokens} to ${compression.after_tokens} estimated tokens`;
  switch (compression.applied_strategy) {
    case "tiered_history_checkpoint":
      return `Context checkpoint retained ${compression.preserved_recent_message_count} recent messages and reduced ${reduction}`;
    case "bounded_history":
      return `Context bounded conversation history and reduced ${reduction}`;
    case "bounded_tool_output":
      return `Context bounded tool evidence and reduced ${reduction}`;
    case "mixed":
      return `Context checkpointed history, bounded tool evidence, and reduced ${reduction}`;
    case "strategy_chain":
      return `Context strategy chain reduced ${reduction} while retaining archived source locators`;
    case "none":
      return "Context compaction was not required";
  }
}

function contextBuildNoticeSummary(notice: ContextBuildNotice): string {
  switch (notice.type) {
    case "context.tool_output_spilled":
      return `Oversized tool output was archived at ${notice.data.locator}`;
    case "context.summary_created":
      return `Structured Context summary reduced ${notice.data.source_tokens} to ${notice.data.summary_tokens} estimated tokens`;
    case "context.summary_failed":
      return `Context summary was unavailable (${notice.data.reason}); tiered checkpoint fallback was selected`;
    case "context.spill_refetched":
      return `Archived Context source was retrieved from ${notice.data.locator}`;
  }
}

function publicModelRequestMetadata(
  model: ModelAdapter,
  input: ModelInput,
): PublicModelRequestMetadata {
  let described: PublicModelRequestMetadata | undefined;
  try {
    described = model.publicRequestMetadata?.(input);
  } catch {
    // Optional presentation metadata must never prevent a model request.
  }
  const configuration = described?.reasoning_configuration;
  const safeConfiguration = configuration === "provider_default"
    || configuration === "native"
    || configuration === "mapped"
    || configuration === "unsupported"
    ? configuration
    : "provider_default";
  const provider = described?.provider === undefined
    ? undefined
    : redactSensitiveText(described.provider).slice(0, 100);
  const modelName = described?.model === undefined
    ? undefined
    : redactSensitiveText(described.model).slice(0, 200);
  const applied = described?.applied_reasoning_effort === undefined
    ? undefined
    : redactSensitiveText(described.applied_reasoning_effort).slice(0, 32);
  return {
    adapter: redactSensitiveText(described?.adapter ?? model.name).slice(0, 100),
    ...(provider === undefined ? {} : { provider }),
    ...(modelName === undefined ? {} : { model: modelName }),
    requested_reasoning_effort: input.reasoningEffort,
    ...(applied === undefined ? {} : { applied_reasoning_effort: applied }),
    reasoning_configuration: safeConfiguration,
  };
}

function modelCapabilities(model: ModelAdapter): ReturnType<typeof ModelCapabilitiesSchema.parse> {
  try {
    const parsed = ModelCapabilitiesSchema.safeParse(model.capabilities?.());
    return parsed.success ? parsed.data : { image_input: false };
  } catch {
    return { image_input: false };
  }
}

function attachmentEventKey(
  runId: string,
  uploadId: string,
  transition: "added" | "rejected" | "offloaded",
): string {
  const digest = sha256(stableStringify({ run_id: runId, upload_id: uploadId, transition }));
  return `attachment:${transition}:${digest.slice("sha256:".length)}`;
}

function attachmentObservation(
  added: AttachmentAddedData,
  artifactRefs: readonly ArtifactRef[],
  createdAt: Date,
): Observation {
  const digest = sha256(added.upload_id).slice("sha256:".length, "sha256:".length + 32);
  const extraction = added.pdf_extraction;
  return ObservationSchema.parse({
    observation_id: `attachment-observation:${digest}`,
    action_id: `attachment-action:${digest}`,
    receipt_id: `attachment-receipt:${digest}`,
    status: "success",
    summary: extraction.status === "extracted"
      ? `PDF attachment is available by reference; extracted text is available at artifact:${extraction.artifact_id}`
      : extraction.status === "failed"
        ? "PDF attachment is available by reference; text extraction failed"
        : `Image attachment is ${added.delivery === "inline" ? "included with the first model request" : "available by reference"}`,
    facts: {
      kind: "attachment",
      attachment_id: added.attachment.attachment_id,
      media_type: added.attachment.media_type,
      bytes: added.attachment.bytes,
      delivery: added.delivery,
      locator: `artifact:${added.attachment.attachment_id}`,
      pdf_extraction: extraction,
      ...(extraction.status === "extracted"
        ? { extracted_text_locator: `artifact:${extraction.artifact_id}` }
        : {}),
    },
    artifact_refs: artifactRefs,
    created_at: createdAt.toISOString(),
  });
}

/**
 * Resolve the stable provider/model pair used by preflight metering. Adapter
 * identity is optional presentation metadata, so an invalid or throwing
 * implementation must never prevent a Run from reaching the model.
 */
function modelUsageIdentity(model: ModelAdapter): { provider: string; model: string } {
  let described: unknown;
  try {
    described = model.usageIdentity?.();
  } catch {
    // Fall through to the adapter-owned safe identity below.
  }
  const record = typeof described === "object" && described !== null
    ? described as Record<string, unknown>
    : {};
  const adapterName = safeUsageIdentityPart(model.name, "unknown-adapter", 100);
  return {
    provider: safeUsageIdentityPart(record.provider, adapterName, 100),
    model: safeUsageIdentityPart(record.model, "unknown", 200),
  };
}

function safeUsageIdentityPart(value: unknown, fallback: string, maximum: number): string {
  if (typeof value !== "string") return fallback;
  const safe = redactSensitiveText(value).replace(/\s+/gu, " ").trim().slice(0, maximum);
  return safe || fallback;
}

/**
 * Preserve a provider report when it cannot or must not update calibration.
 * Repair requests intentionally omit `delta_ratio` and `calibration_revision`:
 * their input is not represented by the initial Context Manifest estimate.
 */
function uncalibratedUsageData(
  modelCallId: string,
  usage: ModelUsageReport,
  estimatedInputTokens?: number,
): Record<string, unknown> {
  const comparison = estimatedInputTokens === undefined
    ? undefined
    : compareInputUsage(usage.input_tokens, estimatedInputTokens);
  return {
    model_call_id: modelCallId,
    provider: usage.provider,
    model: usage.model,
    estimator_id: "provider_reported_only",
    confidence: "provider_reported",
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    ...(usage.cached_input_tokens === undefined
      ? {}
      : { cached_input_tokens: usage.cached_input_tokens }),
    ...(usage.reasoning_output_tokens === undefined
      ? {}
      : { reasoning_output_tokens: usage.reasoning_output_tokens }),
    total_tokens: usage.total_tokens,
    ...(estimatedInputTokens === undefined ? {} : {
      estimated_input_tokens: estimatedInputTokens,
      delta_ratio: comparison!.deltaRatio,
      anomaly: comparison!.anomaly,
    }),
    request_kind: usage.request_kind,
    request_sequence: usage.request_sequence,
    ...(usage.provider_reported_cost === undefined
      ? {}
      : { provider_reported_cost: usage.provider_reported_cost }),
    calibration_applied: false,
    cost_status: usage.provider_reported_cost === undefined
      ? "unavailable"
      : "provider_reported",
  };
}

function compareInputUsage(
  reportedInputTokens: number,
  estimatedInputTokens: number,
): { deltaRatio: number; anomaly: boolean } {
  const rawRatio = estimatedInputTokens === 0
    ? reportedInputTokens === 0 ? 1 : 100
    : reportedInputTokens / estimatedInputTokens;
  return {
    deltaRatio: Math.min(100, rawRatio),
    anomaly: Math.abs(rawRatio - 1) > 0.25,
  };
}

function modelRequestSummary(metadata: PublicModelRequestMetadata): string {
  const target = metadata.model ?? metadata.provider ?? metadata.adapter;
  if (metadata.reasoning_configuration === "unsupported") {
    return `Requesting a decision from ${target}; ${metadata.requested_reasoning_effort} reasoning is unsupported and was not sent`;
  }
  if (metadata.applied_reasoning_effort !== undefined) {
    return `Requesting a decision from ${target} with ${metadata.applied_reasoning_effort} reasoning`;
  }
  return `Requesting a decision from ${target} with provider-default reasoning`;
}

/**
 * `public_reason` is an explicitly public, constrained planning field — not
 * provider chain-of-thought. Keep it short and redact it before it reaches the
 * event ledger. The UI combines it with durable tool observations, so users
 * can follow the agent's stated plan without seeing private reasoning.
 */
function publicDecisionActivity(decision: Decision): {
  summary: string;
  data: Record<string, unknown>;
} {
  const candidatePlan = publicPlanCandidate(decision);
  const publicPlan = candidatePlan;
  const data: Record<string, unknown> = {
    decision_kind: decision.kind,
    risk: decision.risk,
    evidence_ref_count: decision.evidence_refs.length,
    ...(publicPlan.length === 0 ? {} : { public_plan: publicPlan }),
  };
  if (decision.kind === "finish") {
    return { summary: publicPlan || "Prepared a direct response", data };
  }

  const calls = decisionToolCalls(decision);
  if (calls.length > 1) {
    return {
      summary: publicPlan || `Selected ${calls.length} checked actions`,
      data: {
        ...data,
        tool_call_count: calls.length,
        tool_names: calls.map(({ tool_name: toolName }) => toolName),
        action_ids: calls.map(({ action_id: actionId }) => actionId),
      },
    };
  }
  const toolName = calls[0]?.tool_name;
  const actionLabel = toolName === "read_file"
    ? "a repository file read"
    : toolName === "read_artifact"
      ? "an archived Context source read"
    : toolName === "list_dir"
      ? "the repository structure"
    : toolName === "search"
      ? "a repository search"
      : toolName === "preview_patch"
        ? "a patch preview"
        : toolName === "commit_patch"
          ? "an approved patch application"
          : toolName === "run_test"
            ? "a project test"
            : "the next checked action";
  return {
    summary: publicPlan || `Selected ${actionLabel}`,
    data: toolName === undefined ? data : { ...data, tool_name: toolName },
  };
}

/**
 * The model's native reasoning channel is intentionally private. This helper
 * exposes only an explicit, short public decision summary and rejects the
 * common failure mode where a provider copies the final answer into
 * `public_reason`. The fallback describes the observable action instead.
 */
function publicPlanForDecision(decision: Decision): string {
  const candidate = publicPlanCandidate(decision);
  if (candidate.length > 0) return candidate;
  if (decision.kind === "finish") return "Prepared a direct response";
  const calls = decisionToolCalls(decision);
  if (calls.length > 1) return `Selected ${calls.length} checked actions`;
  const toolName = calls[0]?.tool_name;
  const actionLabel = toolName === "read_file"
    ? "a repository file read"
    : toolName === "read_artifact"
      ? "an archived Context source read"
      : toolName === "list_dir"
        ? "the repository structure"
        : toolName === "search"
          ? "a repository search"
          : toolName === "preview_patch"
            ? "a patch preview"
            : toolName === "commit_patch"
              ? "an approved patch application"
              : toolName === "run_test"
                ? "a project test"
                : "the next checked action";
  return `Selected ${actionLabel}`;
}

function publicPlanCandidate(decision: Decision): string {
  const candidate = redactSensitiveText(decision.public_reason).replace(/\s+/gu, " ").trim().slice(0, 360);
  if (!isSafePublicPlan(candidate)) return "";
  const planComparable = publicPlanComparable(candidate);
  const answerComparable = publicPlanComparable(decision.final_answer);
  // A public plan should explain the next observable decision, not repeat a
  // whole answer. Compare normalized text so Markdown punctuation does not
  // defeat the guard, while allowing a short plan such as "Answer directly".
  if (candidate.length > 240 || (planComparable.length > 24 && answerComparable.length > 24 && (
    planComparable === answerComparable
    || answerComparable.includes(planComparable)
    || planComparable.includes(answerComparable)
  ))) return "";
  return candidate;
}

function publicPlanComparable(value: string | undefined): string {
  return (value ?? "")
    .toLocaleLowerCase()
    .replace(/[`*_>#\[\]().,:;!?/\\-]/gu, "")
    .replace(/\s+/gu, "")
    .slice(0, 800);
}

function decisionToolCalls(decision: Decision): readonly ToolCall[] {
  if (decision.kind !== "tool_call") return [];
  return decision.tool_calls ?? (decision.tool_call === undefined ? [] : [decision.tool_call]);
}

function toolSerializationReason(
  validated: ValidatedToolCall,
  policyDecision: PolicyDecision,
): Pick<PreparedToolCall, "serializedReason"> | Record<string, never> {
  if (validated.definition.sideEffect === "write") return { serializedReason: "write_side_effect" };
  if (policyDecision.kind === "ask") return { serializedReason: "approval_required" };
  if (!validated.definition.concurrencySafe) return { serializedReason: "concurrency_unsafe" };
  return {};
}

/**
 * Plan Mode is a trusted Runtime allowlist, not a provider-supplied label.
 * Requiring both a known read tool and read-like metadata prevents a newly
 * registered write/execute tool (or a capability-disguised definition) from
 * inheriting Plan authority accidentally. todo_write is the sole explicit
 * exception because it mutates only the canonical Run ledger.
 */
function isPlanModeToolAllowed(validated: ValidatedToolCall): boolean {
  return isPlanModeDefinitionAllowed(validated.definition);
}

function isPlanModeDefinitionAllowed(definition: ToolDefinition): boolean {
  if (definition.name === "todo_write") {
    return definition.sideEffect === "none";
  }
  if (definition.sideEffect !== "none" && definition.sideEffect !== "read") {
    return false;
  }
  if (definition.capability !== "read" && definition.capability !== "search") {
    return false;
  }
  if (definition.name.startsWith("mcp_")) return true;
  return new Set([
    "read_file",
    "list_dir",
    "search",
    "read_artifact",
    "list_artifacts",
    "todo_read",
    "team_read",
    "get_diagnostics",
  ]).has(definition.name);
}

function isTodoMutationEventType(type: string): boolean {
  return type === "todo.created"
    || type === "todo.updated"
    || type === "todo.completed"
    || type === "todo.blocked";
}

function teamTaskCommand(commandId: string, input: TeamTaskWriteInput): TeamCommand {
  switch (input.operation) {
    case "create":
      return {
        command_id: commandId,
        operation: "create_task",
        task_id: input.task_id,
        title: input.title!,
        ...(input.detail === undefined ? {} : { detail: input.detail }),
        acceptance: input.acceptance!,
      };
    case "claim":
      return {
        command_id: commandId,
        operation: "claim_task",
        task_id: input.task_id,
        expected_version: input.expected_version!,
      };
    case "complete":
      return {
        command_id: commandId,
        operation: "complete_task",
        task_id: input.task_id,
        expected_version: input.expected_version!,
        evidence_event_ids: input.evidence_event_ids!,
      };
    case "block":
      return {
        command_id: commandId,
        operation: "block_task",
        task_id: input.task_id,
        expected_version: input.expected_version!,
        reason: input.reason!,
      };
    case "cancel":
      return {
        command_id: commandId,
        operation: "cancel_task",
        task_id: input.task_id,
        expected_version: input.expected_version!,
        reason: input.reason!,
      };
    case "reopen":
      return {
        command_id: commandId,
        operation: "reopen_task",
        task_id: input.task_id,
        expected_version: input.expected_version!,
        reason: input.reason!,
      };
  }
}

function teamMutationResult(
  commandId: string,
  before: readonly SessionEvent[],
  after: readonly SessionEvent[],
  team: NonNullable<RunProjection["team"]>,
): TeamMutationResult {
  const matching = after.filter((event) => (
    event.type.startsWith("team.")
    && (
      event.operation_id === commandId
      || event.idempotency_key === `team-command:${sha256(commandId)}`
    )
  ));
  const beforeIds = new Set(before.map(({ event_id: eventId }) => eventId));
  const applied = matching.some(({ event_id: eventId }) => !beforeIds.has(eventId));
  return TeamMutationResultSchema.parse({
    command_id: commandId,
    disposition: applied ? "applied" : matching.length === 0 ? "noop" : "duplicate",
    event_ids: matching.map(({ event_id: eventId }) => eventId),
    team,
  });
}

function teamCreateMutationResult(
  commandId: string,
  before: readonly SessionEvent[],
  after: readonly SessionEvent[],
  team: NonNullable<RunProjection["team"]>,
): TeamMutationResult {
  const createdIndex = after.findIndex((event) => (
    event.type === "team.created"
    && (
      event.operation_id === commandId
      || event.idempotency_key === `team-command:${sha256(commandId)}`
    )
  ));
  if (createdIndex < 0) {
    return TeamMutationResultSchema.parse({ command_id: commandId, disposition: "noop", event_ids: [], team });
  }
  const matching = [after[createdIndex]!];
  for (let index = createdIndex + 1; index < after.length; index += 1) {
    const event = after[index]!;
    if (event.type !== "team.member_joined") break;
    matching.push(event);
  }
  const beforeIds = new Set(before.map(({ event_id: eventId }) => eventId));
  return TeamMutationResultSchema.parse({
    command_id: commandId,
    disposition: beforeIds.has(matching[0]!.event_id) ? "duplicate" : "applied",
    event_ids: matching.map(({ event_id: eventId }) => eventId),
    team,
  });
}

function teamSweepMutationResult(
  commandId: string,
  before: readonly SessionEvent[],
  after: readonly SessionEvent[],
  team: NonNullable<RunProjection["team"]>,
): TeamMutationResult {
  const receipt = after.find((event) => (
    event.type === "team.sweep_completed"
    && (
      event.operation_id === commandId
      || event.idempotency_key === `team-command:${sha256(commandId)}`
    )
  ));
  if (receipt === undefined) {
    return TeamMutationResultSchema.parse({ command_id: commandId, disposition: "noop", event_ids: [], team });
  }
  const parsed = TeamSweepCompletedDataSchema.parse(receipt.data);
  const referenced = new Set(parsed.member_lost_event_ids);
  const matching = [
    ...after.filter(({ event_id: eventId }) => referenced.has(eventId)),
    receipt,
  ];
  const beforeIds = new Set(before.map(({ event_id: eventId }) => eventId));
  const applied = !beforeIds.has(receipt.event_id);
  return TeamMutationResultSchema.parse({
    command_id: commandId,
    disposition: applied ? "applied" : matching.length === 0 ? "noop" : "duplicate",
    event_ids: matching.map(({ event_id: eventId }) => eventId),
    team,
  });
}

function toolBypassesWorkspaceCapabilities(toolName: ToolCall["tool_name"]): boolean {
  return toolName === "read_artifact"
    || toolName === "list_artifacts"
    || toolName === "load_skill"
    || toolName.startsWith("mcp_")
    || toolName === "get_diagnostics"
    || toolName === "todo_read"
    || toolName === "todo_write"
    || isTeamControlTool(toolName)
    || isSubagentControlTool(toolName);
}

function isTeamControlTool(toolName: string): boolean {
  return toolName === "team_read"
    || toolName === "team_task_write"
    || toolName === "team_mailbox_send"
    || toolName === "team_mailbox_claim"
    || toolName === "team_heartbeat";
}

function mcpEventSummary(event: McpManagerEvent): string {
  switch (event.type) {
    case "mcp.server_started": return `MCP server ${String(event.data.server_name ?? "unknown")} started`;
    case "mcp.server_failed": return `MCP server ${String(event.data.server_name ?? "unknown")} failed`;
    case "mcp.server_stopped": return `MCP server ${String(event.data.server_name ?? "unknown")} stopped`;
    case "mcp.tools_changed": return `MCP tools changed for ${String(event.data.server_name ?? "unknown")}`;
    case "mcp.tool_called": return `MCP tool ${String(event.data.qualified_name ?? "unknown")} called`;
  }
}

function lspEventSummary(event: LspManagerEvent): string {
  if (event.type === "lsp.diagnostics_received") {
    return `LSP diagnostics received from ${String(event.data.server_name ?? "unknown")}`;
  }
  return `LSP server ${String(event.data.server_name ?? "unknown")} unavailable`;
}

function isEligibleTeamTaskEvidence(event: SessionEvent): boolean {
  if (event.type === "tool.completed") {
    const receipt = ReceiptSchema.safeParse(event.data.receipt);
    if (receipt.success && isTeamControlTool(receipt.data.tool_name)) return false;
  }
  return isEligibleTodoCompletionEvidence(event);
}

function isSubagentControlTool(toolName: string): boolean {
  return toolName === "spawn_subagent"
    || toolName === "send_subagent_message"
    || toolName === "list_subagents"
    || toolName === "interrupt_subagent";
}

function plannedToolConcurrency(
  calls: readonly PreparedToolCall[],
  maximum: number,
): number {
  let currentSafeWave = 0;
  let plannedPeak = 1;
  for (const call of calls) {
    if (call.serializedReason !== undefined) {
      currentSafeWave = 0;
      continue;
    }
    currentSafeWave += 1;
    plannedPeak = Math.max(plannedPeak, Math.min(maximum, currentSafeWave));
  }
  return Math.min(maximum, Math.min(calls.length, plannedPeak));
}

/** Exact UTF-8 size of the bounded, validated Tool result envelope. */
function toolResultEnvelopeBytes(raw: RawToolResult): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(raw), "utf8");
  } catch {
    // The Tool boundary normally guarantees JSON-safe output. Accounting must
    // still remain optional if a future custom adapter violates that premise.
    return undefined;
  }
}

function toolStopsBatch(call: ToolCall, raw: RawToolResult): boolean {
  return raw.status !== "success" || call.tool_name === "preview_patch";
}

function observationWithEvidence(observation: Observation, eventId: string): Observation {
  return ObservationSchema.parse({
    ...observation,
    facts: {
      ...observation.facts,
      // The canonical Tool event, rather than a receipt assertion, is the
      // evidence a later model-authored Todo completion may cite.
      evidence_event_id: eventId,
    },
  });
}

function observationWithEligibleEvidence(
  observation: Observation,
  event: SessionEvent,
): Observation {
  return isEligibleTodoCompletionEvidence(event)
    ? observationWithEvidence(observation, event.event_id)
    : observation;
}

function toolBatchFailureCode(raw: RawToolResult): ToolFailureCode {
  if (/timeout/iu.test(raw.code)) return "timeout";
  if (/schema|contract|output_invalid/iu.test(raw.code)) return "output_contract_violation";
  if (/denied|forbidden|sensitive|sandbox_unavailable/iu.test(raw.code)) return "denied";
  if (/argument|input_invalid/iu.test(raw.code)) return "invalid_arguments";
  return "internal";
}

function actionRejectionFailureCode(code: string): ToolFailureCode {
  if (code === "schema_invalid") return "invalid_arguments";
  if (
    code === "capability_denied"
    || code === "plan_mode_denied"
    || code === "sandbox_denied"
    || code === "approval_required"
    || code === "tool_not_registered"
  ) return "denied";
  return "internal";
}

function createToolCancellationShield(): ToolCancellationShield {
  let armed = false;
  return {
    arm() {
      armed = true;
    },
    isArmed() {
      return armed;
    },
  };
}

function isSafePublicPlan(value: string): boolean {
  if (value.length === 0) return false;
  // Provider labels are not a trust boundary. These terms are strong signals
  // that a completion is trying to pass private reasoning through the public
  // plan field, so we retain only the structural activity in that case.
  return !/(?:chain[\s_-]*of[\s_-]*thought|private[\s_-]*(?:thought|reasoning)|reasoning[\s_-]*content|scratchpad|internal[\s_-]*reasoning|思维链|私有推理|内部推理|草稿思考)/iu.test(value);
}

function publicToolActivity(
  toolName: string,
  input: unknown,
): { summary: string; data: Record<string, unknown> } {
  const record = typeof input === "object" && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const publicValue = (key: string, maximum = 300): string | undefined =>
    typeof record[key] === "string"
      ? redactSensitiveText(record[key]).slice(0, maximum)
      : undefined;
  const path = publicValue("path");
  if (toolName === "list_dir") {
    return {
      summary: path === undefined ? "Listing the repository structure" : `Listing entries under ${path}`,
      data: { tool_name: toolName, activity: "list_dir", ...(path === undefined ? {} : { path }) },
    };
  }
  if (toolName === "read_file") {
    return {
      summary: path === undefined ? "Reading a repository file" : `Reading ${path}`,
      data: { tool_name: toolName, activity: "read", ...(path === undefined ? {} : { path }) },
    };
  }
  if (toolName === "read_artifact") {
    const locator = publicValue("locator", 180);
    const offset = typeof record.offset === "number" && Number.isSafeInteger(record.offset)
      ? record.offset
      : undefined;
    const limit = typeof record.limit === "number" && Number.isSafeInteger(record.limit)
      ? record.limit
      : undefined;
    return {
      summary: locator === undefined ? "Reading an archived Context source" : `Reading ${locator}`,
      data: {
        tool_name: toolName,
        activity: "read_artifact",
        ...(locator === undefined ? {} : { locator }),
        ...(offset === undefined ? {} : { offset }),
        ...(limit === undefined ? {} : { limit }),
      },
    };
  }
  if (toolName === "search") {
    const pattern = publicValue("pattern", 200);
    return {
      summary: pattern === undefined ? "Searching the repository" : `Searching the repository for ${pattern}`,
      data: { tool_name: toolName, activity: "search", ...(pattern === undefined ? {} : { pattern }) },
    };
  }
  if (toolName === "preview_patch") {
    return {
      summary: path === undefined ? "Preparing a patch preview" : `Preparing a patch preview for ${path}`,
      data: { tool_name: toolName, activity: "preview_patch", ...(path === undefined ? {} : { path }) },
    };
  }
  if (toolName === "commit_patch") {
    return {
      summary: path === undefined ? "Applying an approved patch" : `Applying the approved patch to ${path}`,
      data: { tool_name: toolName, activity: "commit_patch", ...(path === undefined ? {} : { path }) },
    };
  }
  if (toolName === "run_test") {
    const suite = publicValue("suite", 100);
    return {
      summary: suite === undefined ? "Running project tests" : `Running test suite ${suite}`,
      data: { tool_name: toolName, activity: "test", ...(suite === undefined ? {} : { suite }) },
    };
  }
  return { summary: `${redactSensitiveText(toolName)} started`, data: { tool_name: toolName, activity: "tool" } };
}

function publicError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : "unknown error");
}

function parseArtifactLocator(locator: string): string {
  const match = /^artifact:([A-Za-z0-9_.:-]+)$/u.exec(locator);
  if (match?.[1] === undefined) throw new Error("Artifact locator is invalid");
  const artifactId = match[1];
  return IdentifierSchema.parse(artifactId);
}

function boundedUtf8Chunk(content: string, offset: number, limit: number): {
  content: string;
  offset: number;
  returnedBytes: number;
  totalBytes: number;
  nextOffset?: number;
  truncated: boolean;
} {
  const bytes = Buffer.from(content, "utf8");
  if (offset > bytes.byteLength) throw new RangeError("Artifact offset exceeds the source length");
  if (offset < bytes.byteLength && offset > 0 && isUtf8ContinuationByte(bytes[offset]!)) {
    throw new RangeError("Artifact offset must be a UTF-8 character boundary");
  }
  let end = Math.min(bytes.byteLength, offset + limit);
  while (end > offset && end < bytes.byteLength && isUtf8ContinuationByte(bytes[end]!)) end -= 1;
  if (end === offset && offset < bytes.byteLength) {
    throw new RangeError("Artifact limit is too small for the next UTF-8 character");
  }
  const returnedBytes = end - offset;
  const truncated = end < bytes.byteLength;
  return {
    content: bytes.subarray(offset, end).toString("utf8"),
    offset,
    returnedBytes,
    totalBytes: bytes.byteLength,
    ...(truncated ? { nextOffset: end } : {}),
    truncated,
  };
}

function renderSubagentTaskPacket(input: {
  task: string;
  constraints: readonly string[];
  acceptance_criteria: readonly string[];
}): string {
  const sections = [redactSensitiveText(input.task)];
  if (input.constraints.length > 0) {
    sections.push(`Constraints:\n${input.constraints.map((item) => `- ${redactSensitiveText(item)}`).join("\n")}`);
  }
  if (input.acceptance_criteria.length > 0) {
    sections.push(
      `Acceptance criteria:\n${input.acceptance_criteria.map((item) => `- ${redactSensitiveText(item)}`).join("\n")}`,
    );
  }
  return sections.join("\n\n").slice(0, 8_000);
}

function recoveredSubagentBudget(
  events: readonly SessionEvent[],
  maxTokens: number,
): NonNullable<RunState["subagentBudget"]> {
  for (const event of [...events].reverse()) {
    if (event.type !== "model.decision") continue;
    const value = event.data._internal_subagent_budget;
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const inputTokens = safeTokenCount(record.input_tokens);
    const outputTokens = safeTokenCount(record.output_tokens);
    const confidence = record.confidence;
    if (
      inputTokens !== undefined
      && outputTokens !== undefined
      && (confidence === "exact"
        || confidence === "calibrated"
        || confidence === "estimated"
        || confidence === "provider_reported")
    ) {
      return { maxTokens, inputTokens, outputTokens, confidence };
    }
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let providerReported = false;
  for (const event of events) {
    if (event.type !== "model.usage_reported") continue;
    const input = safeTokenCount(event.data.input_tokens);
    const output = safeTokenCount(event.data.output_tokens);
    if (input === undefined || output === undefined) continue;
    inputTokens += input;
    outputTokens += output;
    providerReported = true;
  }
  if (!providerReported) {
    inputTokens = events
      .filter((event) => event.type === "context.built")
      .reduce((total, event) => total + (safeTokenCount(event.data.input_tokens) ?? 0), 0);
    outputTokens = events
      .filter((event) => event.type === "model.decision")
      .reduce((total, event) => total + estimateTokens(JSON.stringify(event.data)), 0);
  }
  return {
    maxTokens,
    inputTokens,
    outputTokens,
    confidence: providerReported ? "provider_reported" : "estimated",
  };
}

function subagentUsageFromEvents(
  events: readonly SessionEvent[],
  maxTokens: number,
): NonNullable<SubagentResult["usage"]> {
  const recovered = recoveredSubagentBudget(events, maxTokens);
  const costs = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "model.usage_reported") continue;
    const value = event.data.provider_reported_cost;
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (
      typeof record.currency !== "string"
      || !/^[A-Z]{3}$/u.test(record.currency)
      || typeof record.amount !== "number"
      || !Number.isFinite(record.amount)
      || record.amount < 0
    ) continue;
    costs.set(record.currency, (costs.get(record.currency) ?? 0) + record.amount);
  }
  return {
    steps: events.filter((event) => event.type === "context.built").length,
    input_tokens: recovered.inputTokens,
    output_tokens: recovered.outputTokens,
    total_tokens: recovered.inputTokens + recovered.outputTokens,
    confidence: recovered.confidence,
    costs: [...costs.entries()].slice(0, 16).map(([currency, amount]) => ({ amount, currency })),
  };
}

function safeTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isUtf8ContinuationByte(value: number): boolean {
  return (value & 0xc0) === 0x80;
}

function commandSignature(value: unknown): string {
  return sha256(stableStringify(value));
}

function userInputDigest(kind: SubmitUserInputCommand["kind"], body: string): string {
  // The raw body is never persisted, but its one-way digest keeps two
  // credential-shaped values from becoming an idempotent collision merely
  // because their public redactions are identical.
  return sha256(stableStringify({ kind, body }));
}

function userInputQueuedEventKey(commandId: string): string {
  // User-controlled command ids must not share the EventLedger idempotency
  // namespace with terminal, consumption, WAL, or recovery transitions.
  return `command:${sha256(commandId)}:user.input_queued`;
}

function replaySubmittedUserInput(
  events: readonly SessionEvent[],
  command: SubmitUserInputCommand,
  commandDigest: string,
  canonicalBody: string,
  inputDigest: string,
  idempotencyKey: string,
): SubmitUserInputResult | undefined {
  const priorCommand = findUserInputCommandEvent(events, command.command_id, idempotencyKey);
  if (priorCommand !== undefined) {
    const priorInput = queuedInputFromEvent(priorCommand);
    if (
      priorInput === undefined
      || priorCommand.data._internal_command_digest !== commandDigest
      || !samePersistedUserInput(
        priorInput,
        command,
        canonicalBody,
        priorCommand.data._internal_input_digest,
        inputDigest,
      )
    ) {
      throw new RuntimeCommandError(
        "command_id_conflict",
        "Command id was already used with a different user input payload",
      );
    }
    return SubmitUserInputResultSchema.parse({
      input: materializeUserInput(events, priorInput),
      disposition: "duplicate",
    });
  }

  const priorInput = findQueuedInput(events, command.input_id);
  if (priorInput === undefined) return undefined;
  if (
    !samePersistedUserInput(
      priorInput.input,
      command,
      canonicalBody,
      priorInput.event.data._internal_input_digest,
      inputDigest,
    )
  ) {
    throw new RuntimeCommandError(
      "input_id_conflict",
      "input_id was already used with a different user input payload",
    );
  }
  return SubmitUserInputResultSchema.parse({
    input: materializeUserInput(events, priorInput.input),
    disposition: "duplicate",
  });
}

function findUserInputCommandEvent(
  events: readonly SessionEvent[],
  commandId: string,
  idempotencyKey: string,
): SessionEvent | undefined {
  const namespacedCommand = events.find((event) => event.idempotency_key === idempotencyKey);
  // Read legacy G14 events whose idempotency key was the raw command id. New
  // appends never write into that user-controlled namespace.
  return namespacedCommand ?? events.find((event) => (
    event.type === "user.input_queued" && event.idempotency_key === commandId
  ));
}

function sameUserInputIdentity(
  input: PendingUserInput,
  command: SubmitUserInputCommand,
): boolean {
  return input.input_id === command.input_id
    && input.run_id === command.run_id
    && input.kind === command.kind
    && input.actor === command.actor;
}

function samePersistedUserInput(
  input: PendingUserInput,
  command: SubmitUserInputCommand,
  canonicalBody: string,
  persistedInputDigest: unknown,
  candidateInputDigest: string,
): boolean {
  if (!sameUserInputIdentity(input, command)) return false;
  // G14 events persist the digest of the raw {kind, body}. Once present, it is
  // the stable body identity across redaction-registry or path-policy changes.
  // Old events without the internal digest can only fall back to their public,
  // canonical body representation.
  return persistedInputDigest !== undefined
    ? persistedInputDigest === candidateInputDigest
    : input.body === canonicalBody;
}

function queuedInputFromEvent(event: SessionEvent): PendingUserInput | undefined {
  if (event.type !== "user.input_queued") return undefined;
  const parsed = UserInputQueuedDataSchema.safeParse(event.data);
  return parsed.success ? parsed.data.input : undefined;
}

function findQueuedInput(
  events: readonly SessionEvent[],
  inputId: string,
): { input: PendingUserInput; event: SessionEvent } | undefined {
  for (const event of events) {
    const input = queuedInputFromEvent(event);
    if (input?.input_id === inputId) return { input, event };
  }
  return undefined;
}

function findConsumedInputEvent(
  events: readonly SessionEvent[],
  inputId: string,
): SessionEvent | undefined {
  return events.find((event) => {
    if (event.type !== "user.input_consumed") return false;
    const parsed = UserInputConsumedDataSchema.safeParse(event.data);
    return parsed.success && parsed.data.input_id === inputId;
  });
}

function assertConsumedUserInputEvent(
  event: SessionEvent,
  inputId: string,
  queuedEventId: string,
): void {
  const parsed = event.type === "user.input_consumed"
    ? UserInputConsumedDataSchema.safeParse(event.data)
    : undefined;
  if (
    parsed === undefined
    || !parsed.success
    || parsed.data.input_id !== inputId
    || parsed.data.queued_event_id !== queuedEventId
  ) {
    throw new RuntimeCommandError(
      "input_consumption_conflict",
      "User input consumption idempotency key resolved to a different durable event",
    );
  }
}

function materializeUserInput(
  events: readonly SessionEvent[],
  input: PendingUserInput,
): SubmitUserInputResult["input"] {
  const safeInput = {
    ...input,
    body: redactSensitiveText(input.body).slice(0, MAX_USER_INPUT_BODY_CHARS),
  };
  const consumedEvent = findConsumedInputEvent(events, input.input_id);
  if (consumedEvent === undefined) return safeInput;
  const consumed = UserInputConsumedDataSchema.parse(consumedEvent.data);
  return {
    ...safeInput,
    consumed_at: consumed.consumed_at,
    consumed_at_step: consumed.at_step,
  };
}

function nextUserInputStep(events: readonly SessionEvent[], proposed: number): number {
  let lastStep = 0;
  for (const event of events) {
    if (event.type !== "user.input_consumed") continue;
    const parsed = UserInputConsumedDataSchema.safeParse(event.data);
    if (parsed.success) lastStep = Math.max(lastStep, parsed.data.at_step);
  }
  const next = Math.max(1, Math.trunc(proposed), lastStep + 1);
  if (next > 1_000_000) {
    throw new RuntimeCommandError("input_step_exhausted", "User input step range is exhausted");
  }
  return next;
}

function userInputConsumedEventKey(runId: string, inputId: string): string {
  return `${runId}:user.input_consumed:${sha256(inputId)}`;
}

function recoveredConversationHistory(
  initial: StartRunInput["conversation_history"],
  events: readonly SessionEvent[],
): NonNullable<StartRunInput["conversation_history"]> {
  const history = (initial ?? []).map((message) => ({
    ...message,
    content: redactSensitiveText(message.content).slice(0, MAX_USER_INPUT_BODY_CHARS),
  }));
  const queued = new Map<string, PendingUserInput>();
  for (const event of events) {
    const input = queuedInputFromEvent(event);
    if (input !== undefined) {
      if (!queued.has(input.input_id)) queued.set(input.input_id, input);
      continue;
    }
    if (event.type !== "user.input_consumed") continue;
    const consumed = UserInputConsumedDataSchema.parse(event.data);
    if (consumed.kind === "cancel") continue;
    const source = queued.get(consumed.input_id);
    if (source === undefined) {
      throw new RuntimeCommandError(
        "input_queue_corrupt",
        `Consumed user input ${consumed.input_id} has no queued source`,
      );
    }
    history.push({
      role: "user",
      content: redactSensitiveText(source.body).slice(0, MAX_USER_INPUT_BODY_CHARS),
    });
  }
  return history;
}

function commandEventKey(
  commandId: string,
  phase: "run.created" | "run.started" | "plan.approved",
): string {
  return `command:${sha256(commandId)}:${phase}`;
}

function changedSymbolsFromGraphDelta(delta: GraphDelta): ChangedSymbol[] {
  const symbols: ChangedSymbol[] = [];
  for (const change of delta.node_changes) {
    const node = change.after ?? change.before;
    if (
      node?.kind !== "symbol"
      || node.symbol_name === undefined
      || node.declaration_kind === undefined
      || node.file_path === undefined
      || node.line === undefined
    ) continue;
    const kind = change.change === "added"
      ? "added"
      : change.change === "removed"
        ? "removed"
        : "changed";
    symbols.push({
      symbol_id: node.id,
      name: node.symbol_name,
      kind: node.declaration_kind,
      file_path: node.file_path,
      line: node.line,
      ...(node.end_line === undefined ? {} : { end_line: node.end_line }),
      change: kind,
    });
  }
  return symbols;
}

function gitBaseDifference(
  expected: GitBaseContext,
  actual: GitBaseContext,
): "base_commit_changed" | "branch_changed" | "worktree_changed" | "git_context_unavailable" | undefined {
  if (expected.status !== "available") return undefined;
  if (actual.status !== "available") return "git_context_unavailable";
  if (expected.base_commit !== actual.base_commit) return "base_commit_changed";
  if (expected.branch !== actual.branch) return "branch_changed";
  if (expected.worktree_fingerprint !== actual.worktree_fingerprint) return "worktree_changed";
  return undefined;
}

function unavailableSandboxReport(
  mode: SandboxMode,
  platform: SandboxReport["platform"],
  unmetConstraint: string,
): SandboxReport {
  return SandboxReportSchema.parse({
    report_version: 1,
    mode,
    enforcement: "none",
    platform,
    mechanisms: [],
    unmet_constraints: mode === "danger-full-access" ? [] : [unmetConstraint],
  });
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}

function sanitizeObservationFacts(
  facts: Record<string, unknown> | undefined,
  toolName: string,
  code: string,
): Record<string, unknown> {
  const safe: Record<string, unknown> = { tool_name: toolName, code };
  for (const [key, value] of Object.entries(facts ?? {})) {
    if (key === "sandbox_report") {
      const parsed = SandboxReportSchema.safeParse(value);
      if (parsed.success) safe.sandbox_report = parsed.data;
      continue;
    }
    if (key === "content" && typeof value === "string") {
      safe.content_excerpt = redactSensitiveText(value).slice(0, 4_000);
      continue;
    }
    if (key === "diff" && typeof value === "string") {
      safe.diff_excerpt = redactSensitiveText(value).slice(0, 2_000);
      continue;
    }
    if (key === "matches" && Array.isArray(value)) {
      safe.matches = redactStructuredValue(value.slice(0, 10));
      continue;
    }
    if (key === "artifacts" && Array.isArray(value)) {
      safe.artifacts = redactStructuredValue(value.slice(0, 50));
      continue;
    }
    if (typeof value === "string") safe[key] = redactSensitiveText(value).slice(0, 1_000);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) safe[key] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === "string")) safe[key] = value.slice(0, 20);
  }
  return safe;
}

/**
 * Convert a durable, already-sanitized runtime fact into the much smaller
 * ephemeral activity used by the live UI.  Do not add `event.data` here: it
 * can contain a Decision, a Receipt, or an Artifact reference and therefore
 * does not belong in a rapid public process feed.
 */
function toLivePublicActivity(event: SessionEvent): LivePublicActivity | undefined {
  const eventType: string = event.type;
  let kind: LivePublicActivity["kind"];
  let status: LivePublicActivity["status"];

  switch (eventType) {
    case "run.created":
    case "run.started":
      kind = "run";
      status = "started";
      break;
    case "context.built":
    case "context.compaction_completed":
    case "context.tool_output_spilled":
    case "context.summary_created":
    case "context.spill_refetched":
      kind = "context";
      status = "completed";
      break;
    case "context.budget_warning":
    case "context.summary_failed":
      kind = "context";
      status = "info";
      break;
    case "context.compaction_started":
      kind = "context";
      status = "started";
      break;
    case "model.request_started":
      kind = "model";
      status = "started";
      break;
    case "model.decision":
      kind = "model";
      status = "completed";
      break;
    case "model.request_failed":
    case "model.output_invalid":
      kind = "model";
      status = "failed";
      break;
    case "tool.started":
      kind = "tool";
      status = "started";
      break;
    case "tool.completed":
      kind = "tool";
      status = "completed";
      break;
    case "tool.failed":
    case "tool.unknown":
      kind = "tool";
      status = "failed";
      break;
    case "run.completed":
      kind = "run";
      status = "completed";
      break;
    case "run.failed":
    case "action.diverged":
      kind = "run";
      status = "failed";
      break;
    case "run.cancelled":
      kind = "run";
      status = "cancelled";
      break;
    case "run.interrupted":
      kind = "run";
      status = "cancelled";
      break;
    case "run.resumed":
      kind = "run";
      status = "started";
      break;
    case "plan.ready":
      kind = "run";
      status = "info";
      break;
    case "plan.approved":
      kind = "run";
      status = "started";
      break;
    case "todo.created":
    case "todo.updated":
    case "todo.completed":
    case "todo.blocked":
      kind = "run";
      status = "info";
      break;
    default:
      return undefined;
  }

  return LivePublicActivitySchema.parse({
    schema_version: event.schema_version,
    activity_id: `live:${event.event_id}`,
    source_event_id: event.event_id,
    source_event_type: eventType,
    project_id: event.project_id,
    run_id: event.run_id,
    sequence: event.sequence,
    occurred_at: event.occurred_at,
    kind,
    status,
    // `summary` is the deliberately public, redacted runtime annotation. It
    // is never a raw provider response or a reasoning-token delta.
    summary: redactSensitiveText(event.summary).slice(0, 800),
    ...(event.turn_id === undefined ? {} : { turn_id: event.turn_id }),
    ...(event.model_call_id === undefined ? {} : { model_call_id: event.model_call_id }),
    ...(event.operation_id === undefined ? {} : { operation_id: event.operation_id }),
    ...(event.action_id === undefined ? {} : { action_id: event.action_id }),
  });
}
