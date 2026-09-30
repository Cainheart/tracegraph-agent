import type {
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
  ToolCall,
  MemoryEpisodeExtractionInput,
  MemoryEpisodeExtractionResult,
} from "@tracegraph/contracts";

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
  /** Optional background-only extraction capability; output is still untrusted and review-gated. */
  extractMemoryEpisode?(input: MemoryEpisodeExtractionInput, options?: { signal?: AbortSignal }): Promise<MemoryEpisodeExtractionResult>;
  /** Lets the background scheduler avoid retrying an unconfigured optional capability. */
  canExtractMemoryEpisode?(): boolean;
}

export class ModelRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ModelRequestError";
    this.code = code;
  }
}

export type {
  LspToolBridge,
  McpToolBridge,
  PatchMutationLifecycle,
  PatchMutationSnapshot,
  RawToolResult,
  SkillToolBridge,
  SubagentToolBridge,
  TeamToolBridge,
  TodoToolBridge,
  ToolCancellationShield,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionRecord,
  ToolPresentationMeta,
  ToolSideEffect,
} from "./tool/index.js";

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
