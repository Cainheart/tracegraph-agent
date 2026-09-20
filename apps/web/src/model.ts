import type {
  PermissionSnapshot,
  PolicyDecision,
  SandboxReport,
  SessionRecoveryReport,
  SessionSummary,
  PendingUserInput,
  ConsumedUserInputFact,
  TodoItem,
  TeamProjection,
  TokenEstimateConfidence,
  TokenSection,
} from "@tracegraph/contracts";

export type WorkspaceKind = "disposable_fixture" | "readonly_local" | "managed_local";
export type RunMode = "plan" | "execute";
export type ReasoningEffort = "default" | "low" | "medium" | "high" | "xhigh" | "max";

export type RunStatus =
  | "empty"
  | "ready"
  | "indexing"
  | "running"
  | "awaiting_plan_approval"
  | "needs_approval"
  | "needs_manual_review"
  | "ready_for_review"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "historical"
  | "reconnecting";

export type EventKind =
  | "query"
  | "context"
  | "decision"
  | "tool"
  | "approval"
  | "patch"
  | "graph"
  | "test"
  | "permission"
  | "sandbox"
  | "todo"
  | "subagent"
  | "team"
  | "attachment"
  | "run";

export type EventState = "waiting" | "running" | "succeeded" | "failed" | "denied";

export interface ContextArchiveLoadResult {
  readonly status: EvidenceStatus;
  readonly message: string;
  readonly content?: string;
}

export interface ContextSource {
  /** Stable manifest identity; labels are display text and may repeat. */
  readonly itemId: string;
  readonly name: string;
  readonly tokens: number;
  readonly originalTokens?: number;
  readonly action: "pinned" | "kept" | "truncated" | "masked" | "externalized" | "retrieved";
  readonly reason: string;
  readonly color: string;
  readonly archive?: {
    readonly artifactId: string;
    readonly locator: string;
    /** `idle` means the active manifest exposes metadata, but bytes were not requested. */
    readonly status: "idle" | EvidenceStatus;
    readonly message: string;
    readonly content?: string;
  };
}

/** Preflight accounting produced before the provider request is sent. */
export interface ContextTokenEstimateSnapshot {
  readonly estimatorId: string;
  readonly confidence: TokenEstimateConfidence;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens?: number;
  readonly perSection: Readonly<Record<TokenSection, number>>;
}

/** Immutable post-call accounting reported by the provider. */
export interface ProviderUsageSnapshot {
  readonly modelCallId: string;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly totalTokens: number;
  readonly requestKind: "initial" | "repair" | "summary";
  readonly requestSequence: number;
  readonly estimatedInputTokens?: number;
  readonly deltaRatio?: number;
  readonly cost:
    | { readonly status: "provider_reported"; readonly amount: number; readonly currency: string }
    | { readonly status: "unavailable" };
  readonly anomaly: boolean;
}

/** A host-computed, inspectable context budget. Token values may be estimates. */
export interface ContextBudgetSnapshot {
  readonly modelCallId?: string;
  readonly windowTokens: number;
  readonly inputBudgetTokens: number;
  readonly usedTokens: number;
  readonly reservedOutputTokens: number;
  readonly warningThresholdTokens: number;
  readonly compressionThresholdTokens: number;
  readonly estimator: "heuristic_v2" | "provider_tokenizer";
  readonly status: "healthy" | "warning" | "compressed";
  /** Preflight budget evidence; never relabelled as provider-reported usage. */
  readonly estimate?: ContextTokenEstimateSnapshot;
  /** Latest durable provider usage paired to this Context by model_call_id. */
  readonly providerUsage?: ProviderUsageSnapshot;
  readonly compression?: {
    readonly strategy: "none" | "tiered_history_checkpoint";
    /** The effective operation, including bounded tool evidence. */
    readonly appliedStrategy: "none" | "tiered_history_checkpoint" | "bounded_history" | "bounded_tool_output" | "mixed" | "strategy_chain";
    readonly trigger: "within_budget" | "warning_threshold" | "compression_threshold" | "hard_budget";
    readonly beforeTokens: number;
    readonly afterTokens: number;
    readonly checkpointTokens: number;
    readonly preservedRecentMessageCount: number;
    readonly compactedHistoryMessageCount: number;
  };
}

/**
 * A volatile public-process item received over the Host live SSE channel.
 * It is intentionally separate from TraceEvent: TraceEvent is replayable
 * ledger history, while this is a short-lived display projection.
 */
export interface PublicActivitySnapshot {
  readonly id: string;
  readonly sourceEventId: string;
  readonly sourceEventType: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly kind: "run" | "context" | "model" | "tool";
  readonly status: "started" | "completed" | "failed" | "cancelled" | "info";
  readonly summary: string;
}

/**
 * A volatile model surface snapshot. `thinking_snapshot` is retained only so
 * older Host payloads remain parseable; the browser deliberately filters it
 * because provider-native reasoning is not a public explanation.
 */
export interface ModelSurfaceSnapshot {
  readonly id: string;
  readonly modelCallId: string;
  readonly cursor: number;
  readonly timestamp: string;
  readonly type: "public_plan_snapshot" | "thinking_snapshot" | "answer_snapshot";
  readonly status: "streaming" | "completed" | "failed" | "cancelled";
  readonly text: string;
}

export interface TraceEvent {
  readonly id: string;
  readonly sequence: number;
  readonly kind: EventKind;
  readonly title: string;
  readonly summary: string;
  readonly timestamp: string;
  readonly state: EventState;
  readonly duration?: string;
  readonly depth?: number;
  readonly risk?: "low" | "medium" | "high";
  /** Durable evidence of the process boundary applied to this operation. */
  readonly sandboxReport?: SandboxReport;
  /** Public, bounded permission snapshot emitted by the Host. */
  readonly permission?: PermissionSnapshot;
  /** Host policy result, including the matched rule explanation when present. */
  readonly policyDecision?: PolicyDecision;
  readonly rationale?: string;
  /** Public, persisted operation metadata used by the chat activity surface. */
  readonly operationId?: string;
  readonly toolName?: string;
  readonly target?: string;
  readonly input?: string;
  readonly output?: string;
  readonly contextManifestRef?: string;
  readonly patchRef?: string;
  readonly graphDeltaRef?: string;
  readonly testReceiptRef?: string;
  readonly evidenceRefs?: readonly string[];
  readonly memoryRef?: string;
  /** Durable G14 steering metadata, when this event records queue activity. */
  readonly inputId?: string;
  readonly inputKind?: "message" | "cancel" | "approve_hint";
  readonly atStep?: number;
}

export interface ChangedFile {
  readonly path: string;
  readonly status: "modified" | "added" | "deleted";
  readonly additions: number;
  readonly deletions: number;
}

export interface DiffLine {
  readonly number: number | null;
  readonly type: "context" | "added" | "removed" | "meta";
  readonly content: string;
}

export interface GraphNode {
  readonly id: string;
  readonly state: "added" | "removed" | "changed" | "unchanged" | "partial";
  readonly before?: GraphNodeVersion;
  readonly after?: GraphNodeVersion;
  readonly x: number;
  readonly y: number;
}

export interface GraphNodeVersion {
  readonly label: string;
  readonly path: string;
}

export interface GraphEdge {
  readonly id: string;
  readonly state: "added" | "removed" | "changed" | "partial";
  readonly before?: GraphEdgeVersion;
  readonly after?: GraphEdgeVersion;
}

export interface GraphEdgeVersion {
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly confidence: number;
}

export interface ApprovalRequest {
  readonly id: string;
  readonly action: string;
  readonly risk: "high" | "medium" | "low";
  readonly target: string;
  readonly files: number;
  readonly additions: number;
  readonly deletions: number;
  readonly expiresAt: string;
  readonly rollbackAvailable: boolean;
  readonly reviewReady: boolean;
  readonly reviewMessage: string;
}

export interface ProjectSnapshot {
  readonly id: string;
  readonly name: string;
  readonly branch?: string;
  readonly pathLabel: string;
  readonly workspaceKind: WorkspaceKind;
  readonly location?: {
    readonly kind: "managed_storage" | "linked_directory" | "temporary";
    readonly displayPath: string;
    readonly canReveal: boolean;
    readonly access: "read_write" | "read_only";
  };
}

export interface RunSnapshot {
  readonly id: string;
  readonly status: RunStatus;
  readonly mode: RunMode;
  readonly task: string;
  readonly elapsed?: string;
  readonly currentStep: string;
  readonly lastSequence: number;
  readonly inputTokens?: number;
  readonly tokenLimit?: number;
  readonly reservedOutput?: number;
  /** Number of model/tool orchestration turns used by this Run. */
  readonly turnsCompleted?: number;
  /** Host-side deterministic orchestration guard, independent of token budget. */
  readonly turnLimit?: number;
  /** Latest durable sandbox report projected by the Host. */
  readonly sandboxReport?: SandboxReport;
  /** Effective permission preset and digest fixed for this Run. */
  readonly permission?: PermissionSnapshot;
  readonly contextBudget?: ContextBudgetSnapshot;
  /** Ephemeral public activity for the current in-flight Run only. */
  readonly publicActivities?: readonly PublicActivitySnapshot[];
  /** Ephemeral, real model output from the dedicated public surface stream. */
  readonly modelSurface?: readonly ModelSurfaceSnapshot[];
  readonly indexedFiles?: number;
  readonly scanScope?: string;
  readonly events: readonly TraceEvent[];
  /** Canonical Todo projection rebuilt from this Run's durable ledger. */
  readonly todos: readonly TodoItem[];
  /** Durable mailbox state rebuilt from user.input_* ledger events. */
  readonly inputQueue: {
    readonly pending: readonly PendingUserInput[];
    readonly lastConsumed?: ConsumedUserInputFact;
  };
  /** Read-only delegation summaries projected from the parent Run ledger. */
  readonly subagents: readonly SubagentSnapshot[];
  /** Durable G08 roster, mailbox, and shared task board from the root Run ledger. */
  readonly team?: TeamProjection;
  /** Durable attachment projection rebuilt from attachment.* ledger events. */
  readonly attachments: readonly AttachmentSnapshot[];
  /** Exact plan.ready revision that the user may approve. */
  readonly pendingPlan?: {
    readonly eventId: string;
    readonly todoIds: readonly string[];
  };
  readonly approval?: ApprovalRequest;
  readonly outcome?: string;
}

export type AttachmentDelivery = "offload" | "inline";
export type AttachmentMediaType = "image/png" | "image/jpeg" | "application/pdf";

/** Browser-local bytes waiting to be staged before a new Run starts. */
export interface PendingAttachment {
  readonly id: string;
  readonly label: string;
  readonly file: Blob;
  readonly declaredMediaType: string;
  readonly delivery: AttachmentDelivery;
}

export interface AttachmentPreviewContent {
  readonly mediaType: AttachmentMediaType;
  readonly bytes: Uint8Array;
}

export interface AttachmentSnapshot {
  readonly id: string;
  readonly status: "added" | "offloaded" | "rejected";
  readonly mediaType?: AttachmentMediaType;
  readonly bytes: number;
  readonly delivery: AttachmentDelivery;
  readonly source: "user_upload" | "tool_output";
  readonly sha256?: string;
  readonly rejectionCode?: string;
  readonly reason?: string;
  readonly pdfExtraction?:
    | { readonly status: "not_applicable" }
    | { readonly status: "extracted"; readonly artifactId: string; readonly characters: number }
    | { readonly status: "failed"; readonly code: string; readonly reason: string };
}

export type SubagentStatus = "running" | "completed" | "failed" | "interrupted" | "budget_exceeded";

export interface SubagentChildRunSnapshot {
  readonly id: string;
  readonly sessionId?: string;
  readonly status: RunStatus;
  readonly task: string;
  readonly lastSequence: number;
  readonly events: readonly TraceEvent[];
  readonly outcome?: string;
}

export interface SubagentSnapshot {
  readonly id: string;
  readonly name: string;
  readonly status: SubagentStatus;
  readonly childRunId: string;
  readonly childSessionId: string;
  readonly contextScope: "isolated" | "fork";
  readonly depth: number;
  readonly messageCount: number;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly failureReason?: string;
  readonly resultSummary?: string;
  readonly budget: {
    readonly maxSteps: number;
    readonly maxTokens: number;
  };
  readonly detail:
    | { readonly state: "idle" | "loading" }
    | { readonly state: "error"; readonly message: string }
    | { readonly state: "available"; readonly run: SubagentChildRunSnapshot };
}

export interface ConversationTurn {
  readonly runId: string;
  readonly task: string;
  readonly status: RunStatus;
  readonly response: string;
  readonly events: readonly TraceEvent[];
}

export type EvidenceStatus = "demo" | "loading" | "available" | "unavailable" | "corrupt" | "not_present";

export interface EvidenceSlot {
  readonly status: EvidenceStatus;
  readonly artifactId?: string;
  readonly message: string;
  readonly content?: string;
}

export interface EvidenceSnapshot {
  readonly context: EvidenceSlot;
  readonly diff: EvidenceSlot;
  readonly graph: EvidenceSlot;
  readonly test: EvidenceSlot;
}

export interface EventEvidenceSnapshot {
  readonly contextSources: readonly ContextSource[];
  readonly changedFiles: readonly ChangedFile[];
  readonly diffs: Readonly<Record<string, readonly DiffLine[]>>;
  readonly graphNodes: readonly GraphNode[];
  readonly graphEdges: readonly GraphEdge[];
  readonly evidence: EvidenceSnapshot;
  readonly contextManifestId?: string;
  readonly patchEventId?: string;
  readonly graphDeltaId?: string;
  readonly testReceiptId?: string;
  readonly inputTokens?: number;
  readonly tokenLimit?: number;
  readonly reservedOutput?: number;
  readonly contextBudget?: ContextBudgetSnapshot;
}

export interface ConnectionSnapshot {
  readonly state: "connecting" | "live" | "reconnecting" | "offline";
  readonly message: string;
  readonly lastSequence: number;
}

export interface WorkbenchSnapshot {
  readonly dataSource: "demo" | "live";
  readonly connection: ConnectionSnapshot;
  readonly project: ProjectSnapshot | null;
  readonly availableProjects: readonly ProjectSnapshot[];
  /** Canonical durable session summaries returned by the Host. */
  readonly sessions: readonly SessionSummary[];
  readonly selectedSessionId: string | null;
  readonly sessionViewState: "restored" | "resumed" | null;
  /** Startup recovery facts; null means the Host reported no recovery scan. */
  readonly recovery: SessionRecoveryReport | null;
  readonly run: RunSnapshot | null;
  readonly conversation: readonly ConversationTurn[];
  readonly contextSources: readonly ContextSource[];
  readonly changedFiles: readonly ChangedFile[];
  readonly diffs: Readonly<Record<string, readonly DiffLine[]>>;
  readonly graphNodes: readonly GraphNode[];
  readonly graphEdges: readonly GraphEdge[];
  readonly evidence: EvidenceSnapshot;
  /**
   * Evidence resolved from the canonical relations on each event. This is
   * deliberately separate from the run-level latest projection above: a
   * selected event must never inherit unrelated newer evidence.
   */
  readonly eventEvidence: Readonly<Record<string, EventEvidenceSnapshot>>;
  /**
   * A bounded, read-only view of an earlier durable Run projection. The live
   * authority remains outside this presentation snapshot so a lower replay
   * sequence can never replace the canonical live head.
   */
  readonly replay?: ReplayViewState;
}

export interface ReplayDiffSnapshot {
  readonly fromSequence: number;
  readonly toSequence: number;
  readonly fromProjectionHash: string;
  readonly toProjectionHash: string;
  readonly addedEvents: readonly TraceEvent[];
  readonly removedEvents: readonly TraceEvent[];
  readonly addedEvidenceCount: number;
  readonly removedEvidenceCount: number;
  readonly toolResults: readonly {
    readonly kind: "added" | "removed";
    readonly eventId: string;
    readonly sequence: number;
    readonly type: string;
    readonly toolName?: string;
    readonly summary: string;
  }[];
  readonly todoChanges: readonly {
    readonly todoId: string;
    readonly title: string;
    readonly kind: "added" | "removed" | "changed";
    readonly beforeState?: string;
    readonly afterState?: string;
  }[];
  readonly approvalChanged: boolean;
  readonly statusBefore: string;
  readonly statusAfter: string;
  readonly modeBefore: string;
  readonly modeAfter: string;
}

export type ReplayViewState = {
  readonly state: "loading" | "active" | "restoring";
  readonly runId: string;
  readonly requestedSequence: number;
  readonly headSequence: number;
  readonly availableSequences: readonly number[];
  readonly projectionHash?: string;
  readonly expiresAt?: string;
  readonly diff?: ReplayDiffSnapshot;
};

export type InspectorTab =
  | "summary"
  | "io"
  | "context"
  | "memory"
  | "changes"
  | "architecture"
  | "evidence"
  | "timing";

export type MainView = "chat" | "trajectory" | "changes";

export function canUseExecuteMode(project: ProjectSnapshot | null): boolean {
  return project?.workspaceKind === "disposable_fixture" || project?.workspaceKind === "managed_local";
}

export function getInspectorTabs(event: TraceEvent | null, linked?: EventEvidenceSnapshot): readonly InspectorTab[] {
  if (!event) return [];

  const tabs: InspectorTab[] = ["summary"];
  if (event.input || event.output || event.kind === "tool") tabs.push("io");
  if (event.contextManifestRef || linked?.evidence.context.status === "available" || linked?.evidence.context.status === "demo") tabs.push("context");
  if (event.memoryRef) tabs.push("memory");
  if (event.patchRef || linked?.evidence.diff.status === "available" || linked?.evidence.diff.status === "demo") tabs.push("changes");
  if (event.graphDeltaRef || linked?.evidence.graph.status === "available" || linked?.evidence.graph.status === "demo") tabs.push("architecture");
  if (event.evidenceRefs?.length || event.testReceiptRef || linked?.evidence.test.status === "available" || linked?.evidence.test.status === "demo") tabs.push("evidence");
  if (event.duration) tabs.push("timing");
  return tabs;
}

export function getStatusLabel(status: RunStatus): string {
  const labels: Record<RunStatus, string> = {
    empty: "No project",
    ready: "Project ready",
    indexing: "Indexing",
    running: "Running",
    awaiting_plan_approval: "Plan ready for approval",
    needs_approval: "Needs approval",
    needs_manual_review: "Needs manual review",
    ready_for_review: "Ready for review",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    interrupted: "Interrupted",
    historical: "Historical run",
    reconnecting: "Reconnecting",
  };
  return labels[status];
}

export function getStatusTone(status: RunStatus): "neutral" | "active" | "warning" | "success" | "danger" {
  if (status === "running" || status === "indexing") return "active";
  if (status === "awaiting_plan_approval" || status === "needs_approval" || status === "needs_manual_review" || status === "ready_for_review" || status === "reconnecting" || status === "interrupted") return "warning";
  if (status === "completed" || status === "historical") return "success";
  if (status === "failed" || status === "cancelled") return "danger";
  return "neutral";
}

export function getEventIcon(kind: EventKind): string {
  const icons: Record<EventKind, string> = {
    query: "message",
    context: "layers",
    decision: "route",
    tool: "terminal",
    approval: "shield",
    patch: "diff",
    graph: "graph",
    test: "check",
    permission: "shield",
    sandbox: "shield",
    todo: "check",
    subagent: "route",
    team: "route",
    attachment: "file",
    run: "flag",
  };
  return icons[kind];
}

export function totalDiff(files: readonly ChangedFile[]): { additions: number; deletions: number } {
  return files.reduce(
    (totals, file) => ({
      additions: totals.additions + file.additions,
      deletions: totals.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}

export function adjacentReplaySequence(
  availableSequences: readonly number[],
  currentSequence: number,
  direction: -1 | 1,
): number | null {
  const index = availableSequences.indexOf(currentSequence);
  if (index < 0) return null;
  return availableSequences[index + direction] ?? null;
}

export function graphForVersion(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  version: "before" | "after",
): {
  nodes: readonly (GraphNode & GraphNodeVersion)[];
  edges: readonly (GraphEdge & GraphEdgeVersion)[];
} {
  return {
    nodes: nodes.flatMap((node) => {
      const value = node[version];
      return value ? [{ ...node, ...value }] : [];
    }),
    edges: edges.flatMap((edge) => {
      const value = edge[version];
      return value ? [{ ...edge, ...value }] : [];
    }),
  };
}

export function evidenceForSelection(
  snapshot: WorkbenchSnapshot,
  event: TraceEvent | null,
): EventEvidenceSnapshot {
  if (event) {
    return snapshot.eventEvidence[event.id] ?? emptyEventEvidence(
      "The selected event has no linked evidence projection.",
    );
  }

  const latestContext = [...(snapshot.run?.events ?? [])].reverse().find((item) => item.contextManifestRef);
  const latestPatch = [...(snapshot.run?.events ?? [])].reverse().find((item) => item.kind === "patch" || item.patchRef);
  const latestGraph = [...(snapshot.run?.events ?? [])].reverse().find((item) => item.graphDeltaRef);
  const latestTest = [...(snapshot.run?.events ?? [])].reverse().find((item) => item.testReceiptRef);
  return {
    contextSources: snapshot.contextSources,
    changedFiles: snapshot.changedFiles,
    diffs: snapshot.diffs,
    graphNodes: snapshot.graphNodes,
    graphEdges: snapshot.graphEdges,
    evidence: snapshot.evidence,
    ...(latestContext?.contextManifestRef ? { contextManifestId: latestContext.contextManifestRef } : {}),
    ...(latestPatch?.patchRef ? { patchEventId: latestPatch.patchRef } : {}),
    ...(latestGraph?.graphDeltaRef ? { graphDeltaId: latestGraph.graphDeltaRef } : {}),
    ...(latestTest?.testReceiptRef ? { testReceiptId: latestTest.testReceiptRef } : {}),
    ...(snapshot.run?.inputTokens === undefined ? {} : { inputTokens: snapshot.run.inputTokens }),
    ...(snapshot.run?.tokenLimit === undefined ? {} : { tokenLimit: snapshot.run.tokenLimit }),
    ...(snapshot.run?.reservedOutput === undefined ? {} : { reservedOutput: snapshot.run.reservedOutput }),
  };
}

export function emptyEventEvidence(message = "No evidence was linked to this event."): EventEvidenceSnapshot {
  const slot = (label: string): EvidenceSlot => ({
    status: "not_present",
    message: `${label}: ${message}`,
  });
  return {
    contextSources: [],
    changedFiles: [],
    diffs: {},
    graphNodes: [],
    graphEdges: [],
    evidence: {
      context: slot("Context"),
      diff: slot("Diff"),
      graph: slot("Graph delta"),
      test: slot("Test evidence"),
    },
  };
}
