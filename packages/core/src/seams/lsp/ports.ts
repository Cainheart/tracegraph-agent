import type {
  LspDiagnosticsRequest,
  LspDiagnosticsResult,
  LspManagerEvent,
} from "@tracegraph/contracts";

export interface LspRuntimeSubscription {
  dispose(): void | Promise<void>;
}

export interface LspRuntimeDiagnosticsInput {
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly request: LspDiagnosticsRequest;
  readonly signal?: AbortSignal;
}

/** Host-selected LSP provider port; Core does not depend on its implementation package. */
export interface LspRuntimePort {
  onEvent(listener: (event: LspManagerEvent) => void | Promise<void>): LspRuntimeSubscription;
  stop(): Promise<void>;
  diagnostics(
    input: LspRuntimeDiagnosticsInput,
    eventSink?: (event: LspManagerEvent) => void | Promise<void>,
  ): Promise<LspDiagnosticsResult>;
}
