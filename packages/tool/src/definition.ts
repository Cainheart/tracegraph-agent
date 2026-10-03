import type {
  ArtifactRef,
  BoundedJsonSchema,
  RawToolResult,
  SandboxMode,
  ToolName,
  TodoList,
  TodoMutationResult,
  TodoWriteInput,
  ValidatedAction,
  WorkspaceHandle,
} from "@tracegraph/contracts";
import type { ZodType } from "zod";
import type { SandboxRunner } from "./sandbox-port.js";

export type { RawToolResult } from "@tracegraph/contracts";

export interface ToolExecutionContext {
  /** Runtime-owned binary publication; refs become canonical only with this dispatch's receipt. */
  publishArtifactBytes?(input:{mimeType:"image/png"|"image/jpeg"|"image/webp"|"image/svg+xml";bytes:Uint8Array}):Promise<ArtifactRef>;
  projectId: string;
  runId: string;
  /** Runtime-minted identity for this dispatch, reused by the recovery provider. */
  operationId?: string;
  workspace: WorkspaceHandle;
  signal?: AbortSignal;
  /**
   * Host-owned dispatch gate and job registry. Runtime supplies this so an
   * executor that outlives the abort race remains owned until it settles.
   */
  startOwnedJob?: <T>(start: () => T | PromiseLike<T>) => Promise<T> | undefined;
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
  /** Optional trusted immutable executor lease; public Tool authority must remain identical. */
  forRun?(): {definition:ToolDefinition<TInput,TOutput>;release():void};
  /** Trusted definition only. Internal evidence operations need no filesystem grant. */
  readonly workspaceIndependent?:boolean;
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
