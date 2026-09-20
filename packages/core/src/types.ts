import type {
  ArtifactRef,
  BoundedJsonSchema,
  ContextManifest,
  Decision,
  GraphDelta,
  GraphSnapshot,
  GitBaseContext,
  ModelUsageReport,
  ModelCapabilities,
  ModelImageInput,
  ModelTool,
  ReceiptStatus,
  ReasoningEffort,
  RunMode,
  SandboxMode,
  ToolCall,
  ToolName,
  TodoList,
  TodoMutationResult,
  TodoWriteInput,
  ValidatedAction,
  WorkspaceHandle,
} from "@tracegraph/contracts";
import type { ZodType } from "zod";
import type { SandboxRunner } from "./sandbox/runner.js";

export interface ModelInput {
  projectId: string;
  runId: string;
  task: string;
  mode: RunMode;
  reasoningEffort: ReasoningEffort;
  turn: number;
  context: string;
  contextManifest: ContextManifest;
  /** Volatile, verified image bytes for this request only. Never persist them in Context or Ledger. */
  images?: readonly ModelImageInput[];
  observations: readonly ModelObservation[];
  /** Explicitly projected model-visible Tool schemas; never Host descriptors. */
  toolSchemas: readonly ModelTool[];
  /** Trusted role instruction frozen by a Host-owned subagent profile. */
  rolePrompt?: string;
  /** Hard provider output ceiling for this request. */
  maxOutputTokens?: number;
  /** Volatile provider/model deltas for the live presentation surface. */
  onPublicProgress?: (update: PublicModelProgressUpdate) => void;
  /**
   * Canonical usage reported by a completed provider HTTP response. This is a
   * best-effort accounting side channel: adapters must never fail an otherwise
   * valid model response because usage is absent, malformed, or rejected by a
   * consumer callback.
   */
  onUsage?: (usage: ModelUsageReport) => void;
  signal?: AbortSignal;
}

/**
 * A dedicated, auditable model request for Context compaction.  It is kept
 * separate from `ModelInput` because a summary is data for a later decision,
 * not an agent Decision itself.  The Context layer owns validation of the
 * provider's unknown response and the fallback policy.
 */
export interface ContextSummaryInput {
  projectId: string;
  runId: string;
  modelCallId: string;
  promptVersion: string;
  targetTokens: number;
  sourceText: string;
  onUsage?: (usage: ModelUsageReport) => void;
  signal?: AbortSignal;
}

/**
 * A bounded incremental fragment from a provider/model surface. The runtime
 * may forward the explicitly public fields to the live UI, but must not
 * persist them as a substitute for the canonical event ledger. The
 * `thinking_delta` compatibility kind is intentionally dropped by Runtime:
 * provider-native reasoning is private scratchpad data, not public progress.
 */
export interface PublicModelProgressUpdate {
  readonly kind: "public_reason_delta" | "thinking_delta" | "final_answer_delta";
  readonly text: string;
}

export interface PublicModelRequestMetadata {
  adapter: string;
  provider?: string;
  model?: string;
  requested_reasoning_effort: ReasoningEffort;
  applied_reasoning_effort?: string;
  reasoning_configuration: "provider_default" | "native" | "mapped" | "unsupported";
}

export interface ModelObservation {
  status: ReceiptStatus;
  summary: string;
  facts: Readonly<Record<string, unknown>>;
}

export interface ModelAdapter {
  readonly name: string;
  /** Trusted adapter capability declaration. Absence is fail-closed. */
  capabilities?(): ModelCapabilities;
  /** Stable public identity used to select provider/model token calibration. */
  usageIdentity?(): { provider: string; model: string };
  publicRequestMetadata?(input: ModelInput): PublicModelRequestMetadata;
  decide(input: ModelInput): Promise<unknown>;
  /**
   * Produce an untrusted structured Context summary through the configured
   * provider.  Callers must validate the unknown result before using it.
   */
  summarizeContext?(input: ContextSummaryInput): Promise<unknown>;
}

export class ModelRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ModelRequestError";
    this.code = code;
  }
}

export interface RawToolResult {
  status: ReceiptStatus;
  code: string;
  summary: string;
  content?: string | undefined;
  mimeType?: string | undefined;
  facts?: Record<string, unknown> | undefined;
}

export interface ToolExecutionContext {
  projectId: string;
  runId: string;
  workspace: WorkspaceHandle;
  signal?: AbortSignal;
  /**
   * Host-selected child-process isolation. Runtime always supplies both
   * fields; they remain optional so standalone Tool contract tests can inject
   * only the boundary they exercise.
   */
  sandboxMode?: SandboxMode;
  sandboxRunner?: SandboxRunner;
  /**
   * Host-only durability boundary around the irreversible filesystem rename.
   * The callback receives exact bytes so a private WAL can preserve a rollback
   * image; none of this payload is exposed to the model or public Event data.
   */
  patchMutation?: PatchMutationLifecycle;
  /**
   * Host-owned cancellation fence for an irreversible durable mutation. Tool
   * code may arm it only after the prepare boundary has completed and after a
   * final signal check. Once armed, the execution wrapper must let the Tool
   * and Host durability callbacks settle before observing abort or timeout.
   */
  cancellationShield?: ToolCancellationShield;
  /** Host-owned bridge for bounded retrieval of a previously spilled Artifact. */
  readArtifact?(input: { locator: string; offset: number; limit: number }): Promise<{
    artifactId: string;
    content: string;
    contentHash: string;
    mimeType: string;
    offset: number;
    returnedBytes: number;
    totalBytes: number;
    nextOffset?: number;
    truncated: boolean;
  }>;
  /**
   * Host-owned, run-scoped public Artifact index. Implementations must return
   * metadata only: Tool code never receives Artifact content through this
   * bridge.
   */
  listArtifacts?(): Promise<readonly ArtifactRef[]>;
  /**
   * Host-owned bridge to the canonical Run Todo ledger. `todo_write` mutates
   * only that ledger; it never grants or consumes a Workspace capability.
   */
  todos?: TodoToolBridge;
  /** Host-owned child-run control plane. Never supplied by model input. */
  subagents?: SubagentToolBridge;
  /** Host-owned G-08 root-team bridge with actor identity derived by Runtime. */
  team?: TeamToolBridge;
  /** Host-owned Skill registry bridge. Bodies are returned only as bounded tool output. */
  skills?: SkillToolBridge;
  /** Host-owned MCP bridge; it binds tool-called facts to the current Run. */
  mcp?: McpToolBridge;
  /** Host-owned bridge for bounded LSP diagnostics and semantic locations. */
  lsp?: LspToolBridge;
  /**
   * Composition-root escape hatch for crash/durability fences that must be
   * observed above the ordinary Tool failure boundary (for example Action
   * WAL reconciliation interrupts).
   */
  isHostBoundaryError?(error: unknown): boolean;
}

export interface SubagentToolBridge {
  spawn(input: unknown, control?: {
    /** Combined parent/tool-timeout signal owned by the Tool wrapper. */
    signal?: AbortSignal;
    /** Armed by Runtime only when durable launch becomes authoritative. */
    cancellationShield?: ToolCancellationShield;
  }): Promise<unknown>;
  sendMessage(input: unknown): Promise<unknown>;
  list(input: unknown): Promise<unknown>;
  interrupt(input: unknown): Promise<unknown>;
}

export interface TodoToolBridge {
  read(): Promise<TodoList>;
  write(input: TodoWriteInput): Promise<TodoMutationResult>;
}

export interface TeamToolBridge {
  read(input: unknown): Promise<unknown>;
  writeTask(input: unknown): Promise<unknown>;
  sendMailbox(input: unknown): Promise<unknown>;
  claimMailbox(input: unknown): Promise<unknown>;
  heartbeat(input: unknown): Promise<unknown>;
}

export interface SkillToolBridge {
  load(input: unknown): Promise<RawToolResult>;
}

/** Host-owned bridge for a namespaced MCP Tool invocation. */
export interface McpToolBridge {
  call(
    entry: unknown,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<RawToolResult>;
}

/** Host-owned bridge for the bounded LSP diagnostics Tool. */
export interface LspToolBridge {
  getDiagnostics(input: unknown, signal?: AbortSignal): Promise<RawToolResult>;
}

export interface ToolCancellationShield {
  arm(): void;
  isArmed(): boolean;
}

export interface PatchMutationSnapshot {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly existed: boolean;
  readonly before: string;
  readonly after: string;
  readonly beforeHash: string;
  readonly afterHash: string;
}

export interface PatchMutationLifecycle {
  prepare(snapshot: PatchMutationSnapshot): Promise<void>;
  applied(snapshot: PatchMutationSnapshot): Promise<void>;
}

export type ToolSideEffect = "none" | "read" | "write" | "execute";

export interface ToolPresentationMeta {
  readonly callLabel: string;
  readonly resultLabel: string;
}

export interface ToolDefinition<TInput = unknown, TOutput = RawToolResult> {
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: ZodType<TInput>;
  /** Host-only runtime contract; it must never cross the model boundary. */
  readonly outputSchema: ZodType<TOutput>;
  readonly capability: keyof WorkspaceHandle["capabilities"];
  readonly requiresApproval: boolean;
  readonly timeoutMs: number;
  readonly concurrencySafe: boolean;
  readonly sideEffect: ToolSideEffect;
  readonly maxResultBytes: number;
  /** Optional provider-facing schema supplied by a bounded remote contract. */
  readonly modelInputSchema?: BoundedJsonSchema;
  readonly presentation: ToolPresentationMeta;
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
  /** Convert validated host output into the bounded model/public surface. */
  render(input: TInput, output: TOutput): RawToolResult;
}

export interface ToolExecutionRecord {
  action: ValidatedAction;
  result: RawToolResult;
}

export interface CodeGraphProvider {
  createSnapshot(input: { projectId: string; workspaceRoot: string; signal?: AbortSignal }): Promise<GraphSnapshot>;
  createDelta(input: {
    base: GraphSnapshot;
    result: GraphSnapshot;
    patchEventId?: string;
    signal?: AbortSignal;
  }): Promise<GraphDelta>;
  /**
   * Host/composition-owned read-only Git probe. It is deliberately optional
   * for legacy embeddings; Runtime records an explicit unavailable context
   * instead of treating absence as a clean working tree.
   */
  captureGitContext?(input: {
    workspaceRoot: string;
    signal?: AbortSignal;
  }): Promise<GitBaseContext>;
}

export interface AgentRuntimeHooks {
  onDecision?(decision: Decision): void;
  onToolCall?(toolCall: ToolCall): void;
}
