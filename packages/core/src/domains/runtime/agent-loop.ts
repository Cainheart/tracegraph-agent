import {
  ActionRejectedError,
  approvalActionDigest,
  validateToolCall,
  type PolicyEngine,
  type ToolRegistry,
} from "../tools/runtime-service.js";
import {
  ContextManifestSchema,
  ContextPolicySchema,
  DecisionSchema,
  MemoryUseEventDataSchema,
  ModelUsageReportSchema,
  ObservationSchema,
  ReceiptSchema,
  ToolBatchCompletedDataSchema,
  ToolBatchStartedDataSchema,
  isTerminalEventType,
  type ArtifactRef,
  type ContextCompression,
  type ContextManifest,
  type ContextPolicy,
  type Decision,
  type EffectivePermissionPolicy,
  type ModelUsageReport,
  type MemoryUseEventData,
  type ModelImageInput,
  type Observation,
  type PolicyDecision,
  type ReasoningEffort,
  type RunMode,
  type SessionEvent,
  type SessionEventProposal,
  type StartRunInput,
  type ToolCall,
  type ToolFailureCode,
  type ToolName,
  type WorkspaceHandle,
} from "@tracegraph/contracts";
import { containsSensitiveStructuredData, redactSecrets, redactSensitiveText, redactStructuredValue, sha256 } from "../../kernel/crypto.js";
import {
  ModelRequestError,
  type ModelAdapter,
  type ModelInput,
  type PublicModelProgressUpdate,
  type PublicModelRequestMetadata,
  type RawToolResult,
  type ToolDefinition,
} from "../../kernel/types.js";
import { DEFAULT_CONTEXT_POLICY, DeterministicContextBuilder, type ContextBuildNotice } from "../context/runtime-service.js";
import { ArtifactStore, JsonlEventLedger, projectRun } from "../evidence/runtime-service.js";
import { ExtensionManager, type ExtensionRuntimeError } from "../extensions/manager.js";
import type { SkillRegistrySnapshotInternal } from "../skill/skill.js";
import { RuntimeFeatureDriverRegistry } from "./runtime-feature-drivers.js";
import {
  assessNoProgress,
  buildProgressFingerprint,
  type NoProgressPolicy,
  type ProgressFingerprint,
} from "./no-progress-guard.js";
import { planModelProviderRetry, retryTaxonomySnapshot } from "./retry-policy.js";
import type { CancellationController } from "./cancellation-controller.js";
import { transitionTurnStart } from "./run-state-machine.js";

export type ValidatedToolCall = ReturnType<typeof validateToolCall>;

interface PendingPatch {
  pendingApproval: unknown;
  previewCall: ToolCall;
}

export interface ExecutedTool {
  receipt: import("@tracegraph/contracts").Receipt;
  observation: Observation;
  raw: RawToolResult;
  artifactRefs: ArtifactRef[];
  event: SessionEvent;
  sandboxReport?: import("@tracegraph/contracts").SandboxReport;
  walRecord?: import("@tracegraph/contracts").ActionWalRecord;
  walTransactionId?: string;
}

export interface PolicyAllowedToolExecutionBinding {
  readonly kind: "policy-allow";
  readonly actionDigest: string;
  readonly policyDigest: string;
  readonly canonicalTargetDigest?: string;
}

export interface ApprovedOnceToolExecutionBinding {
  readonly kind: "approved-once";
  readonly actionDigest: string;
  readonly policyDigest: string;
  readonly canonicalTargetDigest?: string;
  readonly approvalId: string;
  readonly approvalTokenId: string;
}

export type ToolExecutionBinding = PolicyAllowedToolExecutionBinding | ApprovedOnceToolExecutionBinding;

export interface PreparedToolCall {
  readonly index: number;
  readonly call: ToolCall;
  readonly validated: ValidatedToolCall;
  readonly policyDecision: PolicyDecision;
  readonly executionBinding: ToolExecutionBinding;
  readonly serializedReason?: "approval_required" | "concurrency_unsafe" | "write_side_effect";
}

export interface PendingToolExecution extends Omit<ExecutedTool, "event"> {
  readonly refetchedContextArtifact?: ArtifactRef;
  readonly refetchedContextRange?: {
    readonly offset: number;
    readonly returnedBytes: number;
    readonly totalBytes: number;
    readonly nextOffset?: number;
    readonly truncated: boolean;
  };
}

export interface ScheduledToolResult {
  readonly prepared: PreparedToolCall;
  readonly executed: ExecutedTool;
}

export interface ToolBatchScheduleResult {
  readonly completed: readonly ScheduledToolResult[];
  readonly actualPeakConcurrency: number;
}

export interface ActionIdentityRepair {
  readonly code: "action_id_conflict";
  readonly modelActionId: string;
  readonly canonicalActionId: string;
}

export interface AgentLoopState {
  readonly cancellation: CancellationController;
  readonly actionSignatures: Map<string, string>;
  readonly cancelInputId?: string;
  readonly conversationHistory: StartRunInput["conversation_history"];
  readonly lastPatchEventId?: string;
  readonly maxTurns?: number;
  readonly mode: RunMode;
  readonly model: ModelAdapter;
  readonly requestBudget?:import("./shared-run-budget.js").ModelRequestBudget;
  readonly modelImages: ModelImageInput[];
  readonly noProgressFingerprints: ProgressFingerprint[];
  readonly noProgressEvidence: Set<string>;
  readonly observations: Observation[];
  readonly orchestration: { readonly depth: number };
  readonly pendingPatch?: PendingPatch;
  readonly pendingPlan?: unknown;
  readonly permissionPolicy: EffectivePermissionPolicy;
  readonly policyEngine: PolicyEngine;
  readonly projectId: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly rolePrompt?: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly skillToolAllowlist?: ReadonlySet<ToolName>;
  readonly skills: SkillRegistrySnapshotInternal;
  readonly stopped: boolean;
  readonly subagentBudget?: {
    maxTokens: number;
    inputTokens: number;
    outputTokens: number;
    confidence: "exact" | "calibrated" | "estimated" | "provider_reported";
  };
  readonly task: string;
  readonly toolAllowlist?: ReadonlySet<ToolName>;
  turn: number;
  readonly workspace: WorkspaceHandle;
}

type LoopEventProposal = Omit<SessionEventProposal, "project_id" | "run_id" | "attempt" | "artifact_refs">
  & { artifact_refs?: ArtifactRef[] };

export interface AgentLoopHelpers {
  readonly abortable: <T>(operation: Promise<T>, signal: AbortSignal) => Promise<T>;
  readonly actionRejectionFailureCode: (code: string) => ToolFailureCode;
  readonly commandSignature: (value: unknown) => string;
  readonly contextBuildNoticeSummary: (notice: ContextBuildNotice) => string;
  readonly contextCompactionCompletedSummary: (compression: ContextCompression) => string;
  readonly contextCompactionStartedSummary: (input: { strategies: readonly string[] }) => string;
  readonly decisionToolCalls: (decision: Decision) => readonly ToolCall[];
  readonly isPlanModeDefinitionAllowed: (definition: ToolDefinition) => boolean;
  readonly isPlanModeToolAllowed: (validated: ValidatedToolCall) => boolean;
  readonly modelRequestSummary: (metadata: PublicModelRequestMetadata) => string;
  readonly modelUsageIdentity: (model: ModelAdapter) => { provider: string; model: string };
  readonly observationWithEligibleEvidence: (observation: Observation, event: SessionEvent) => Observation;
  readonly plannedToolConcurrency: (calls: readonly PreparedToolCall[], maximum: number) => number;
  readonly policyDenialCode: (decision: PolicyDecision) => string;
  readonly policyTargetForCall: (input: unknown) => { path?: string; diffLines?: number };
  readonly publicDecisionActivity: (decision: Decision) => { summary: string; data: Record<string, unknown> };
  readonly publicError: (error: unknown) => string;
  readonly publicModelRequestMetadata: (model: ModelAdapter, input: ModelInput) => PublicModelRequestMetadata;
  readonly publicPlanForDecision: (decision: Decision) => string | undefined;
  readonly toolBatchFailureCode: (raw: RawToolResult) => ToolFailureCode;
  readonly toolBypassesWorkspaceCapabilities: (toolName: ToolCall["tool_name"]) => boolean;
  readonly toolSerializationReason: (
    validated: ValidatedToolCall,
    decision: PolicyDecision,
  ) => Pick<PreparedToolCall, "serializedReason"> | Record<string, never>;
}

export interface AgentLoopPorts<State extends AgentLoopState> {
  readonly append: (state: State, proposal: LoopEventProposal) => Promise<SessionEvent>;
  readonly appendExtensionError: (state: State, error: ExtensionRuntimeError, sourceEvent: SessionEvent) => Promise<void>;
  readonly appendPolicyDecision: (state: State, actionId: string, decision: PolicyDecision) => Promise<void>;
  readonly appendPolicyDenied: (state: State, actionId: string, decision: PolicyDecision, code: string) => Promise<void>;
  readonly answerPolicyApproval: (
    state: State,
    call: ToolCall,
    decision: PolicyDecision,
  ) => Promise<ToolExecutionBinding | undefined>;
  readonly artifacts: ArtifactStore;
  readonly chargeSubagentBudget: (
    state: State,
    estimatedInputTokens: number,
    reports: readonly ModelUsageReport[],
    decision: Decision,
  ) => boolean;
  readonly contextBuilder: DeterministicContextBuilder;
  readonly contextPolicy: ContextPolicy | undefined;
  readonly consumeNextUserInput: (state: State, atStep: number) => Promise<"none" | "message" | "cancelled">;
  readonly createCommandError: (code: string, message: string) => Error;
  readonly createPendingPatch: (state: State, call: ToolCall, executed: ExecutedTool) => Promise<void>;
  readonly effectiveToolAllowlist: (state: State) => ReadonlySet<ToolName>;
  readonly extensionManager: ExtensionManager;
  readonly fail: (state: State, code: string, summary: string, data?: Record<string, unknown>) => Promise<void>;
  readonly featureDrivers: RuntimeFeatureDriverRegistry;
  readonly flushModelSurfaceForCall: (
    runId: string,
    modelCallId: string,
    status: "completed" | "failed" | "cancelled",
    publicPlanOverride?: string,
  ) => void;
  readonly flushModelUsage: (
    state: State,
    turnId: string,
    modelCallId: string,
    contextManifestRef: string,
    estimatedInputTokens: number,
    reports: readonly ModelUsageReport[],
  ) => Promise<void>;
  readonly helpers: AgentLoopHelpers;
  readonly idFactory: (prefix: string) => string;
  readonly isTerminal: (runId: string) => Promise<boolean>;
  readonly ledger: JsonlEventLedger;
  readonly maxToolConcurrency: number;
  readonly noProgressPolicy: NoProgressPolicy;
  readonly now: () => Date;
  readonly planModeDenialDecision: (
    state: State,
    call: ToolCall,
    definition: ToolDefinition,
    actionDigest: string,
  ) => PolicyDecision;
  readonly queueModelSurface: (state: State, modelCallId: string, update: PublicModelProgressUpdate) => void;
  readonly repairActionIdentities: (
    state: State,
    decision: Decision,
  ) => { decision: Decision; repairs: readonly ActionIdentityRepair[] };
  readonly scheduleToolCalls: (state: State, calls: readonly PreparedToolCall[]) => Promise<ToolBatchScheduleResult>;
  readonly skillAllowlistDenialDecision: (
    state: State,
    call: ToolCall,
    sideEffect: ToolDefinition["sideEffect"],
    actionDigest: string,
  ) => PolicyDecision;
  readonly subagentAllowlistDenialDecision: (
    state: State,
    call: ToolCall,
    sideEffect: ToolDefinition["sideEffect"],
    actionDigest: string,
  ) => PolicyDecision;
  readonly toolRegistry: ToolRegistry;
  readonly transitionAfterFinish: (state: State, outcome: string, intent: import("@tracegraph/contracts").FinishIntent, review?:import("@tracegraph/contracts").DeliveryReviewResult) => Promise<boolean>;
  /** Generic trusted continuation gate; false retains the deterministic ceiling. */
  readonly continueAfterTurnLimit?: (state:State)=>Promise<boolean>;
  /** Runtime-owned policy for a settled failure; never an automatic Tool retry. */
  readonly continueAfterToolFailure?: (state:State,call:ToolCall,result:ExecutedTool)=>Promise<boolean>;
  readonly withRunControl: <T>(runId: string, operation: () => Promise<T>) => Promise<T>;
}

export class AgentLoopCoordinator<State extends AgentLoopState> {
  readonly #ports: AgentLoopPorts<State>;

  constructor(ports: AgentLoopPorts<State>) {
    this.#ports = ports;
  }

  resetNoProgress(state: State): void {
    state.noProgressFingerprints.length = 0;
    state.noProgressEvidence.clear();
  }

  async continueRun(state: State): Promise<void> {
    let consecutiveInvalidBatches = 0;
    modelTurns: while (
      !state.stopped
      && state.pendingPatch === undefined
      && state.pendingPlan === undefined
      && !(await this.#ports.isTerminal(state.runId))
    ) {
      const turnTransition = transitionTurnStart({
        completedTurns: state.turn,
        ...(state.maxTurns===undefined?{}:{maxTurns:state.maxTurns}),
        orchestrationDepth: state.orchestration.depth,
      });
      if (turnTransition.kind === "budget_exhausted") {
        if(await this.#ports.continueAfterTurnLimit?.(state))continue;
        await this.#ports.fail(
          state,
          turnTransition.failureCode,
          `Run exceeded the deterministic turn budget after ${state.turn} model turns (limit: ${state.maxTurns})`,
          { turns_completed: state.turn, ...(state.maxTurns === undefined ? {} : { max_turns: state.maxTurns }) },
        );
        return;
      }
      const steering = await this.#ports.consumeNextUserInput(state, turnTransition.turn);
      if (steering === "cancelled" || state.stopped) return;
      if (steering === "message") this.resetNoProgress(state);
      state.turn = turnTransition.turn;
      const turnId = this.#ports.idFactory("turn");
      const modelCallId = this.#ports.idFactory("model-call");
      const tokenMeterIdentity = this.#ports.helpers.modelUsageIdentity(state.model);
      const summaryUsage = new Map<string, Map<string, ModelUsageReport>>();
      let contextCompactionStarted = false;
      const featureTurnContext = await this.#ports.featureDrivers.contributeTurn({
        projectId: state.projectId,
        runId: state.runId,
        sessionId: state.sessionId,
        task: state.task,
        turn: state.turn,
        signal: state.cancellation.signal,
      });
      const extensionSourceEvent = (await this.#ports.ledger.list(state.runId)).at(-1);
      if (extensionSourceEvent === undefined) {
        throw this.#ports.createCommandError("run_not_found", "Run is unavailable for extension Context strategies");
      }
      const extensionContext = await this.#ports.extensionManager.collectContextContributions({
        projectId: state.projectId,
        runId: state.runId,
        task: state.task,
        turn: state.turn,
      });
      for (const error of extensionContext.errors) {
        await this.#ports.appendExtensionError(state, error, extensionSourceEvent);
      }
      const extensionObservations = extensionContext.contributions.map((item) => ObservationSchema.parse({
        observation_id: this.#ports.idFactory("extension-observation"),
        action_id: this.#ports.idFactory("extension-context"),
        receipt_id: this.#ports.idFactory("extension-receipt"),
        status: "success",
        summary: item.contribution.summary,
        facts: redactStructuredValue({
          ...(item.contribution.facts ?? {}),
          extension_name: item.extensionName,
          strategy_name: item.strategyName,
        }),
        artifact_refs: [],
        created_at: this.#ports.now().toISOString(),
      }));
      const modelCapabilities = state.model.capabilities?.();
      const configuredContextPolicy = this.#ports.contextPolicy ?? DEFAULT_CONTEXT_POLICY;
      const contextWindowTokens = modelCapabilities?.context_window_tokens;
      const modelContextPolicy = contextWindowTokens === undefined && modelCapabilities?.max_output_tokens === undefined
        ? this.#ports.contextPolicy
        : ContextPolicySchema.parse({
          ...configuredContextPolicy,
          ...(contextWindowTokens === undefined ? {} : { window_tokens: contextWindowTokens }),
          ...(modelCapabilities?.max_output_tokens === undefined ? {} : {
            reserved_output_tokens: Math.max(256, Math.min(modelCapabilities.max_output_tokens, (contextWindowTokens ?? configuredContextPolicy.window_tokens) - 256)),
          }),
        });
      const built = await this.#ports.contextBuilder.buildWithStrategies({
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
        retrievedMemory: featureTurnContext.retrievedMemory ?? [],
        retrievedExperience: featureTurnContext.retrievedExperience ?? [],
        tokenMeterIdentity,
        ...(modelContextPolicy === undefined ? {} : { contextPolicy: modelContextPolicy }),
      }, {
        artifactStore: this.#ports.artifacts,
        signal: state.cancellation.signal,
        onCompactionStarted: async (details) => {
          if (contextCompactionStarted) return;
          contextCompactionStarted = true;
          await this.#ports.append(state, {
            type: "context.compaction_started",
            summary: this.#ports.helpers.contextCompactionStartedSummary(details),
            turn_id: turnId,
            model_call_id: modelCallId,
            data: { ...details },
          });
        },
        ...(state.orchestration.depth > 0 || state.model.summarizeContext === undefined ? {} : {
          summarize: async (summaryInput) => state.model.summarizeContext!({
            ...summaryInput,
            ...(state.requestBudget?{requestBudget:state.requestBudget}:{}),
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
      const manifestArtifact = await this.#ports.artifacts.put({
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
        await this.#ports.append(state, {
          type: notice.type,
          summary: this.#ports.helpers.contextBuildNoticeSummary(notice),
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
        await this.#ports.flushModelUsage(
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
        await this.#ports.append(state, {
          type: "context.compaction_completed",
          summary: this.#ports.helpers.contextCompactionCompletedSummary(contextCompression),
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
        await this.#ports.append(state, {
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
      await this.#ports.append(state, {
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
        await this.#ports.fail(
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
      let providerUsageReported = false;
      const captureUsage = (providerAttempt: number, usageValue: unknown): void => {
        const parsed = ModelUsageReportSchema.safeParse(usageValue);
        if (!parsed.success) return;
        providerUsageReported = true;
        if (reportedUsage.size >= 16) return;
        const key = `${providerAttempt}:${parsed.data.request_kind}:${parsed.data.request_sequence}`;
        if (!reportedUsage.has(key)) reportedUsage.set(key, parsed.data);
      };
      const maxOutputTokens = remainingSubagentTokens ?? modelCapabilities?.max_output_tokens;
      const modelInput: ModelInput = {
        projectId: state.projectId,
        runId: state.runId,
        task: state.task,
        mode: state.mode,
        reasoningEffort: state.reasoningEffort,
        turn: state.turn,
        context: built.modelContext,
        contextManifest: ContextManifestSchema.parse(built.manifest),
        ...(state.requestBudget?{requestBudget:state.requestBudget}:{}),
        ...(state.turn === 1 && state.modelImages.length > 0
          ? { images: state.modelImages.map((image) => ({ ...image })) }
          : {}),
        observations: built.modelObservations,
        toolSchemas: this.#ports.toolRegistry.modelSchemas(this.#ports.effectiveToolAllowlist(state)),
        ...(state.rolePrompt === undefined ? {} : { rolePrompt: state.rolePrompt }),
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        signal: state.cancellation.signal,
        onUsage: (usageValue) => captureUsage(1, usageValue),
      };
      // Keep raw image bytes only in this request object. They must not remain
      // attached to long-lived Run state after the first request is assembled.
      if (modelInput.images !== undefined) state.modelImages.length = 0;
      const modelRequest = this.#ports.helpers.publicModelRequestMetadata(state.model, modelInput);
      const memoryUseIntent = createMemoryUseDispatchIntent(built.manifest);
      const appendMemoryUseStatus = memoryUseIntent === undefined
        ? undefined
        : async (data: MemoryUseEventData): Promise<void> => {
          await this.#ports.append(state, {
            type: "memory.use_status",
            summary: `MemoryUse ${data.stage}`,
            turn_id: turnId,
            model_call_id: modelCallId,
            context_manifest_ref: built.manifest.manifest_id,
            data,
          });
        };
      await this.#ports.append(state, {
        type: "model.request_started",
        summary: this.#ports.helpers.modelRequestSummary(modelRequest),
        turn_id: turnId,
        model_call_id: modelCallId,
        context_manifest_ref: built.manifest.manifest_id,
        data: {
          ...modelRequest,
          retry_taxonomy: retryTaxonomySnapshot(state.maxTurns),
        },
      });
      if (state.stopped) return;
      if (memoryUseIntent !== undefined) {
        await appendMemoryUseStatus!(memoryUseIntent);
        if (state.stopped) {
          await appendMemoryUseStatus!(MemoryUseEventDataSchema.parse({
            memory_use_id: memoryUseIntent.memory_use_id,
            stage: "unknown",
            reason: "run_interrupted",
          }));
          return;
        }
      }

      modelInput.onPublicProgress = (update) => {
        if (state.stopped) return;
        this.#ports.queueModelSurface(state, modelCallId, update);
      };

      let decision;
      let adapterReturned = false;
      let adapterAttempted = false;
      let adapterInvocationRecorded = false;
      let providerAttempts = 0;
      const retryDelays: number[] = [];
      try {
        let rawResponse: unknown;
        while (true) {
          const attempt = providerAttempts + 1;
          const attemptInput: ModelInput = {
            ...modelInput,
            onUsage: (usageValue) => captureUsage(attempt, usageValue),
          };
          const adapterResponse = state.cancellation.startJob(
            "model",
            () => state.model.decide(attemptInput),
          );
          if (adapterResponse === undefined) return;
          providerAttempts = attempt;
          adapterAttempted = true;
          const settledAdapterResponse = adapterResponse.then(
            (value) => ({ status: "response" as const, value }),
            (error: unknown) => ({ status: "error" as const, error }),
          );
          if (!adapterInvocationRecorded && appendMemoryUseStatus !== undefined && memoryUseIntent !== undefined) {
            await appendMemoryUseStatus(MemoryUseEventDataSchema.parse({
              memory_use_id: memoryUseIntent.memory_use_id,
              stage: "adapter_invoked",
              adapter_name: modelRequest.adapter,
            }));
            adapterInvocationRecorded = true;
          }
          const settled = await this.#ports.helpers.abortable(
            settledAdapterResponse,
            state.cancellation.signal,
          );
          if (settled.status === "response") {
            rawResponse = settled.value;
            adapterReturned = true;
            break;
          }

          const retry = planModelProviderRetry(
            settled.error,
            providerAttempts,
            providerUsageReported,
          );
          if (retry === undefined || state.stopped || state.cancellation.signal.aborted) {
            throw settled.error;
          }
          await this.#ports.append(state, {
            type: "model.retry_scheduled",
            summary: `Transient provider failure; retry ${retry.nextAttempt} of ${retry.maxAttempts} in ${retry.delayMs}ms`,
            turn_id: turnId,
            model_call_id: modelCallId,
            context_manifest_ref: built.manifest.manifest_id,
            data: {
              retry_scope: "model_provider",
              attempt: retry.attempt,
              next_attempt: retry.nextAttempt,
              max_attempts: retry.maxAttempts,
              delay_ms: retry.delayMs,
              reason_code: retry.reasonCode,
            },
          });
          retryDelays.push(retry.delayMs);
          await waitForRetryDelay(retry.delayMs, state.cancellation.signal);
          if (state.stopped || state.cancellation.signal.aborted) {
            throw state.cancellation.signal.reason ?? new Error("Model retry interrupted");
          }
        }
        decision = DecisionSchema.parse(rawResponse);
        const serializedDecision = JSON.stringify(decision);
        if (
          redactSecrets(serializedDecision) !== serializedDecision
          || containsSensitiveStructuredData(decision)
        ) {
          throw new Error("Decision contained credential-like material");
        }
        if (appendMemoryUseStatus !== undefined && memoryUseIntent !== undefined) {
          await appendMemoryUseStatus(MemoryUseEventDataSchema.parse({
            memory_use_id: memoryUseIntent.memory_use_id,
            stage: "response",
          }));
        }
      } catch (error) {
        this.#ports.flushModelSurfaceForCall(
          state.runId,
          modelCallId,
          state.stopped ? "cancelled" : "failed",
        );
        await this.#ports.flushModelUsage(
          state,
          turnId,
          modelCallId,
          built.manifest.manifest_id,
          built.manifest.input_tokens,
          [...reportedUsage.values()],
        );
        const requestFailed = error instanceof ModelRequestError;
        if (appendMemoryUseStatus !== undefined && memoryUseIntent !== undefined) {
          if (adapterAttempted && !adapterInvocationRecorded) {
            await appendMemoryUseStatus(MemoryUseEventDataSchema.parse({
              memory_use_id: memoryUseIntent.memory_use_id,
              stage: "adapter_invoked",
              adapter_name: modelRequest.adapter,
            }));
            adapterInvocationRecorded = true;
          }
          await appendMemoryUseStatus(state.stopped
            ? MemoryUseEventDataSchema.parse({
              memory_use_id: memoryUseIntent.memory_use_id,
              stage: "unknown",
              reason: "run_interrupted",
            })
            : state.cancellation.signal.aborted
            ? MemoryUseEventDataSchema.parse({
              memory_use_id: memoryUseIntent.memory_use_id,
              stage: "unknown",
              reason: "aborted",
            })
            : MemoryUseEventDataSchema.parse({
              memory_use_id: memoryUseIntent.memory_use_id,
              stage: "failed",
              reason: requestFailed ? "request_failed" : adapterReturned ? "invalid_response" : "adapter_error",
            }));
        }
        if (state.stopped) return;
        const errorMessage = this.#ports.helpers.publicError(error);
        await this.#ports.append(state, {
          type: requestFailed ? "model.request_failed" : "model.output_invalid",
          summary: requestFailed ? errorMessage : "Model output failed canonical Decision validation",
          turn_id: turnId,
          model_call_id: modelCallId,
          context_manifest_ref: built.manifest.manifest_id,
          data: {
            error: errorMessage,
            ...modelRequest,
            provider_attempts: providerAttempts,
            provider_retry_count: retryDelays.length,
            provider_retry_delays_ms: retryDelays,
            ...(requestFailed ? { code: error.code } : {}),
          },
        });
        await this.#ports.fail(
          state,
          requestFailed ? "model_request_failed" : "model_output_invalid",
          requestFailed ? errorMessage : "Model output was not a valid Decision",
        );
        return;
      }
      await this.#ports.flushModelUsage(
        state,
        turnId,
        modelCallId,
        built.manifest.manifest_id,
        built.manifest.input_tokens,
        [...reportedUsage.values()],
      );
      if (state.stopped) {
        this.#ports.flushModelSurfaceForCall(state.runId, modelCallId, "cancelled");
        await this.#ports.append(state, {
          type: "action.late_ignored",
          summary: "Model result ignored because the run was stopped",
          turn_id: turnId,
          model_call_id: modelCallId,
          context_manifest_ref: built.manifest.manifest_id,
          data: { phase: "model" },
        });
        return;
      }
      if (!this.#ports.chargeSubagentBudget(
        state,
        built.manifest.input_tokens,
        [...reportedUsage.values()],
        decision,
      )) {
        this.#ports.flushModelSurfaceForCall(state.runId, modelCallId, "failed");
        await this.#ports.fail(
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
      const actionRepair = this.#ports.repairActionIdentities(state, decision);
      decision = actionRepair.decision;
      const decisionCalls = this.#ports.helpers.decisionToolCalls(decision);
      // A public preview becomes complete only after the complete Decision has
      // passed both schema and credential checks. Before this point it remains
      // an untrusted, volatile preview rather than a completed answer.
      // Replace the volatile provider preview with the same short, safe public
      // plan once the full Decision is validated. Providers sometimes echo
      // the answer into `public_reason`; keeping that text would make the UI
      // look as if it were exposing model chain-of-thought. Do not synthesize
      // a plan when the provider did not publish one.
      this.#ports.flushModelSurfaceForCall(
        state.runId,
        modelCallId,
        "completed",
        this.#ports.helpers.publicPlanForDecision(decision),
      );
      const publicDecision = this.#ports.helpers.publicDecisionActivity(decision);
      await this.#ports.append(state, {
        type: "model.decision",
        summary: publicDecision.summary,
        turn_id: turnId,
        model_call_id: modelCallId,
        context_manifest_ref: built.manifest.manifest_id,
        ...(decisionCalls.length === 1 ? { action_id: decisionCalls[0]!.action_id } : {}),
        data: {
          ...publicDecision.data,
          ...modelRequest,
          provider_attempts: providerAttempts,
          provider_retry_count: retryDelays.length,
          provider_retry_delays_ms: retryDelays,
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
        if (await this.#ports.transitionAfterFinish(state, outcome, decision.finish_intent ?? "answer",decision.review_result)) return;
        continue;
      }
      if (decisionCalls.length === 0) {
        await this.#ports.fail(state, "missing_tool_call", "Tool Decision did not include a ToolCall");
        return;
      }

      // Validate the complete batch before starting any member. A denied or
      // malformed later call must never arrive after an earlier side effect.
      const preparedCalls: PreparedToolCall[] = [];
      const signatures: Array<{ actionId: string; signature: string }> = [];
      for (const [index, call] of decisionCalls.entries()) {
        const actionSignature = this.#ports.helpers.commandSignature({
          tool_name: call.tool_name,
          arguments: call.arguments,
        });
        const priorActionSignature = state.actionSignatures.get(call.action_id);
        if (priorActionSignature !== undefined) {
          const code = priorActionSignature === actionSignature
            ? "action_id_duplicate"
            : "action_id_conflict";
          await this.#ports.append(state, {
            type: "action.rejected",
            summary: "Model reused an action_id; duplicate tool execution was blocked",
            action_id: call.action_id,
            data: { code },
          });
          await this.#ports.fail(state, code, "Model action_id values must be unique within a Run");
          return;
        }
        try {
          const registeredDefinition = this.#ports.toolRegistry.get(call.tool_name);
          const disabledFeature = this.#ports.featureDrivers.disabledOwnerForTool(call.tool_name);
          if (disabledFeature !== undefined) {
            const message = `Runtime feature '${disabledFeature}' is disabled`;
            await this.#ports.append(state, {
              type: "action.rejected",
              summary: message,
              action_id: call.action_id,
              data: { code: "feature_disabled", feature: disabledFeature },
            });
            await this.#ports.fail(state, "feature_disabled", message);
            return;
          }
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
            const denial = this.#ports.skillAllowlistDenialDecision(
              state,
              call,
              registeredDefinition?.sideEffect ?? "none",
              actionDigest,
            );
            await this.#ports.appendPolicyDecision(state, call.action_id, denial);
            await this.#ports.appendPolicyDenied(state, call.action_id, denial, "skill_tool_denied");
            await this.#ports.fail(state, "skill_tool_denied", denial.explanation);
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
            const denial = this.#ports.subagentAllowlistDenialDecision(
              state,
              call,
              registeredDefinition?.sideEffect ?? "none",
              actionDigest,
            );
            await this.#ports.appendPolicyDecision(state, call.action_id, denial);
            await this.#ports.appendPolicyDenied(state, call.action_id, denial, "subagent_tool_denied");
            await this.#ports.fail(state, "subagent_tool_denied", denial.explanation);
            return;
          }
          if (
            state.mode === "plan"
            && registeredDefinition !== undefined
            && !this.#ports.helpers.isPlanModeDefinitionAllowed(registeredDefinition)
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
            const denial = this.#ports.planModeDenialDecision(
              state,
              call,
              registeredDefinition,
              actionDigest,
            );
            await this.#ports.appendPolicyDecision(state, call.action_id, denial);
            await this.#ports.appendPolicyDenied(state, call.action_id, denial, "plan_mode_denied");
            await this.#ports.fail(state, "plan_mode_denied", denial.explanation);
            return;
          }
          const validated = validateToolCall({
            call,
            registry: this.#ports.toolRegistry,
            projectId: state.projectId,
            runId: state.runId,
            workspace: state.workspace,
            mode: state.mode,
            sandboxMode: state.permissionPolicy.preset.sandbox_mode,
            now: this.#ports.now(),
            policyPrevalidated: true,
          });
          const policyTarget = this.#ports.helpers.policyTargetForCall(validated.parsedInput);
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
          if (state.mode === "plan" && !this.#ports.helpers.isPlanModeToolAllowed(validated)) {
            const denial = this.#ports.planModeDenialDecision(state, call, validated.definition, actionDigest);
            await this.#ports.appendPolicyDecision(state, call.action_id, denial);
            await this.#ports.appendPolicyDenied(state, call.action_id, denial, "plan_mode_denied");
            await this.#ports.fail(state, "plan_mode_denied", denial.explanation);
            return;
          }
          const capabilityAllowed = this.#ports.helpers.toolBypassesWorkspaceCapabilities(call.tool_name)
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
          await this.#ports.appendPolicyDecision(state, call.action_id, policyDecision);
          if (policyDecision.kind === "deny") {
            const denialCode = this.#ports.helpers.policyDenialCode(policyDecision);
            await this.#ports.appendPolicyDenied(state, call.action_id, policyDecision, denialCode);
            await this.#ports.fail(state, denialCode, policyDecision.explanation);
            return;
          }
          if (call.tool_name === "commit_patch") {
            await this.#ports.append(state, {
              type: "action.rejected",
              summary: "commit_patch requires a Runtime-created preview and bound one-time authorization",
              action_id: call.action_id,
              data: { code: "approval_preview_required", failure_class: "denied" },
            });
            await this.#ports.fail(state, "approval_preview_required", "Direct commit_patch calls are not allowed");
            return;
          }
          const executionBinding = policyDecision.kind === "ask"
            ? await this.#ports.answerPolicyApproval(state, call, policyDecision)
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
            ...this.#ports.helpers.toolSerializationReason(validated, policyDecision),
          });
          signatures.push({ actionId: call.action_id, signature: actionSignature });
        } catch (error) {
          if (!(error instanceof ActionRejectedError)) throw error;
          if (error.code === "schema_invalid") {
            consecutiveInvalidBatches += 1;
            const retrying = consecutiveInvalidBatches <= 2;
            const summary = retrying
              ? "The tool request needs correction; checking its arguments again."
              : "The model could not provide valid tool arguments. Try continuing with a more specific request.";
            const now = this.#ports.now().toISOString();
            const receipt = ReceiptSchema.parse({
              receipt_id: this.#ports.idFactory("validation-receipt"),
              action_id: call.action_id,
              tool_name: call.tool_name,
              status: "failure",
              transport_status: "unknown",
              business_status: "failure",
              code: "schema_invalid",
              summary,
              started_at: now,
              completed_at: now,
              duration_ms: 0,
              artifact_refs: [],
              metadata: { phase: "validation", executed: false },
            });
            const observation = ObservationSchema.parse({
              observation_id: this.#ports.idFactory("validation-observation"),
              action_id: call.action_id,
              receipt_id: receipt.receipt_id,
              status: "failure",
              summary,
              facts: {
                tool_name: call.tool_name,
                code: "schema_invalid",
                executed: false,
                batch_executed: false,
                validation_error: this.#ports.helpers.publicError(error).slice(0, 2_000),
                recovery: "Correct the rejected arguments using the tool schema. No tool in this batch ran. Do not claim completion or reuse this rejection as success evidence.",
              },
              artifact_refs: [],
              created_at: now,
            });
            await this.#ports.append(state, {
              type: "action.rejected",
              summary,
              action_id: call.action_id,
              data: {
                code: error.code,
                failure_class: "invalid_arguments",
                correction_attempt: consecutiveInvalidBatches,
                retrying,
                receipt,
                observation,
              },
            });
            state.observations.push(observation);
            if (retrying) continue modelTurns;
            await this.#ports.fail(state, error.code, summary);
            return;
          }
          await this.#ports.append(state, {
            type: error.code === "capability_denied"
              || error.code === "plan_mode_denied"
              || error.code === "sandbox_denied"
              ? "policy.denied"
              : "action.rejected",
            summary: error.message,
            action_id: call.action_id,
            data: {
              code: error.code,
              failure_class: this.#ports.helpers.actionRejectionFailureCode(error.code),
            },
          });
          await this.#ports.fail(state, error.code, error.message);
          return;
        }
      }
      consecutiveInvalidBatches = 0;
      for (const { actionId, signature } of signatures) state.actionSignatures.set(actionId, signature);

      const isBatch = decision.tool_calls !== undefined;
      const batchId = isBatch ? this.#ports.idFactory("tool-batch") : undefined;
      const actionIds = preparedCalls.map(({ call }) => call.action_id);
      const plannedEffectiveConcurrency = this.#ports.helpers.plannedToolConcurrency(preparedCalls, this.#ports.maxToolConcurrency);
      const serializedActions = preparedCalls.flatMap(({ call, serializedReason }) => (
        serializedReason === undefined ? [] : [{ action_id: call.action_id, reason: serializedReason }]
      ));
      let batchStartedEvent: SessionEvent | undefined;
      const batchStartedAt = this.#ports.now();
      if (batchId !== undefined) {
        const data = ToolBatchStartedDataSchema.parse({
          batch_id: batchId,
          requested_count: preparedCalls.length,
          max_concurrency: this.#ports.maxToolConcurrency,
          effective_concurrency: plannedEffectiveConcurrency,
          action_ids: actionIds,
          parallel_action_ids: preparedCalls
            .filter(({ serializedReason }) => serializedReason === undefined)
            .map(({ call }) => call.action_id),
          serialized_actions: serializedActions,
        });
        batchStartedEvent = await this.#ports.withRunControl(state.runId, async () => {
          const events = await this.#ports.ledger.list(state.runId);
          if (
            events.some((event) => isTerminalEventType(event.type))
            || state.stopped
            || state.cancelInputId !== undefined
            || projectRun(events).input_queue.pending.some((input) => input.kind === "cancel")
          ) return undefined;
          return this.#ports.append(state, {
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

      const scheduled = await this.#ports.scheduleToolCalls(state, preparedCalls);
      for (const { prepared, executed } of scheduled.completed) {
        state.observations.push(this.#ports.helpers.observationWithEligibleEvidence(executed.observation, executed.event));
        if (prepared.call.tool_name === "run_test") {
          await this.#ports.append(state, {
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
        const completedAt = this.#ports.now();
        const results = scheduled.completed.map(({ prepared, executed }) => ({
          action_id: prepared.call.action_id,
          status: executed.raw.status,
          duration_ms: executed.receipt.duration_ms,
          code: executed.raw.code,
          ...(executed.raw.status === "success" ? {} : { failure_code: this.#ports.helpers.toolBatchFailureCode(executed.raw) }),
        }));
        const data = ToolBatchCompletedDataSchema.parse({
          batch_id: batchId,
          requested_count: preparedCalls.length,
          completed_count: results.length,
          failed_count: results.filter(({ status }) => status !== "success").length,
          max_concurrency: this.#ports.maxToolConcurrency,
          effective_concurrency: scheduled.actualPeakConcurrency,
          total_duration_ms: Math.max(0, completedAt.getTime() - batchStartedAt.getTime()),
          action_ids: actionIds,
          results,
        });
        await this.#ports.append(state, {
          type: "tool.batch_completed",
          summary: `Completed ${results.length} of ${preparedCalls.length} checked tool calls`,
          operation_id: batchId,
          ...(batchStartedEvent === undefined ? {} : { caused_by_event_id: batchStartedEvent.event_id }),
          data,
        });
      }
      if (state.stopped) return;
      if (preview !== undefined) {
        await this.#ports.createPendingPatch(state, preview.prepared.call, preview.executed);
      }
      if (state.stopped) return;
      if (firstFailure?.executed.raw.code === "subagent_recovery_pending") {
        // The parent must remain nonterminal while its child link is active.
        // Startup reconciliation will close the child and append the
        // hash-linked parent receipt before marking the parent interrupted.
        return;
      }
      if (firstFailure?.executed.raw.status === "unknown") {
        await this.#ports.fail(state, "unknown_side_effect", "Tool outcome is unknown; automatic retry is disabled");
        return;
      }
      if (firstFailure !== undefined) {
        if(!await this.#ports.continueAfterToolFailure?.(state,firstFailure.prepared.call,firstFailure.executed)){
          await this.#ports.fail(state, firstFailure.executed.raw.code, firstFailure.executed.raw.summary);
          return;
        }
      }
      if (preview !== undefined) return;

      const fingerprint = buildProgressFingerprint(
        scheduled.completed.map(({ prepared, executed }) => ({
          normalizedToolCall: this.#ports.helpers.commandSignature({
            tool_name: prepared.call.tool_name,
            arguments: prepared.call.arguments,
          }),
          toolName: prepared.call.tool_name,
          sideEffect: prepared.validated.definition.sideEffect,
          result: executed.raw,
        })),
        state.noProgressEvidence,
      );
      const assessment = assessNoProgress(
        state.noProgressFingerprints,
        fingerprint,
        this.#ports.noProgressPolicy,
      );
      const hasQueuedSteering = assessment.triggered
        && projectRun(await this.#ports.ledger.list(state.runId)).input_queue.pending
          .some(({ kind }) => kind !== "cancel");
      if (assessment.triggered && !hasQueuedSteering) {
        const repeatedPercent = Math.round(assessment.repeatedCallRatio * 100);
        await this.#ports.fail(
          state,
          "no_progress_detected",
          `Run stopped after ${assessment.noProgressTurns} consecutive Tool turns produced no new evidence (${repeatedPercent}% repeated calls in the ${assessment.recentTurns}-turn window)`,
          {
            no_progress_guard: {
              policy: {
                window_turns: this.#ports.noProgressPolicy.windowTurns,
                minimum_no_progress_turns: this.#ports.noProgressPolicy.minimumNoProgressTurns,
                minimum_repeated_call_ratio: this.#ports.noProgressPolicy.minimumRepeatedCallRatio,
              },
              recent_turns: assessment.recentTurns,
              no_progress_turns: assessment.noProgressTurns,
              repeated_call_count: assessment.repeatedCallCount,
              total_call_count: assessment.totalCallCount,
              repeated_call_ratio: assessment.repeatedCallRatio,
              fingerprint: {
                normalized_tool_calls: fingerprint.normalizedToolCalls,
                ...(fingerprint.workspaceDeltaHash === undefined
                  ? {}
                  : { workspace_delta_hash: fingerprint.workspaceDeltaHash }),
                ...(fingerprint.diagnosticsHash === undefined
                  ? {}
                  : { diagnostics_hash: fingerprint.diagnosticsHash }),
                ...(fingerprint.goalStateHash === undefined
                  ? {}
                  : { goal_state_hash: fingerprint.goalStateHash }),
                new_evidence_count: fingerprint.newEvidenceCount,
                unresolved_error_codes: fingerprint.unresolvedErrorCodes,
              },
            },
          },
        );
        return;
      }
      state.noProgressFingerprints.push(fingerprint);
      if (state.noProgressFingerprints.length > this.#ports.noProgressPolicy.windowTurns) {
        state.noProgressFingerprints.splice(
          0,
          state.noProgressFingerprints.length - this.#ports.noProgressPolicy.windowTurns,
        );
      }
    }
  }
}

function waitForRetryDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error("Model retry interrupted"));
  }
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("Model retry interrupted"));
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function createMemoryUseDispatchIntent(
  manifest: ContextManifest,
): Extract<MemoryUseEventData, { stage: "dispatch_intent" }> | undefined {
  const memoryItems = manifest.items
    .filter((item) => (
      item.section === "memory"
      && item.retrieval?.memory_ref !== undefined
      && item.content !== undefined
      && item.included_tokens > 0
    ))
    .map((item) => ({
      context_item_id: item.item_id,
      memory_ref: item.retrieval!.memory_ref!,
      retrieval: item.retrieval!,
      content_digest: sha256(item.content!),
      included_tokens: item.included_tokens,
    }));
  if (memoryItems.length === 0) return undefined;
  if (manifest.rendered_context_digest === undefined || manifest.token_estimate === undefined) {
    throw new TypeError("MemoryUse requires a ContextManifest with rendered digest and token estimate");
  }
  const memoryUseId = `memory-use:${sha256(manifest.manifest_id).slice(7)}`;
  return MemoryUseEventDataSchema.parse({
    memory_use_id: memoryUseId,
    stage: "dispatch_intent",
    manifest_id: manifest.manifest_id,
    rendered_context_digest: manifest.rendered_context_digest,
    token_estimate: manifest.token_estimate,
    memory_items: memoryItems,
  }) as Extract<MemoryUseEventData, { stage: "dispatch_intent" }>;
}
