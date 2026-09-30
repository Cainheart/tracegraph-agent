import type {
  ModelUsageReport,
  ReceiptStatus,
  TokenEstimate,
  TokenMeterInput,
  TokenUsageObservation,
} from "@tracegraph/contracts";

/** The bounded, attributed observation projected into a model request. */
export interface ContextModelObservation {
  status: ReceiptStatus;
  summary: string;
  facts: Readonly<Record<string, unknown>>;
}

/** Provider-neutral request passed to the host's dedicated summary adapter. */
export interface ContextSummaryRequest {
  projectId: string;
  runId: string;
  modelCallId: string;
  promptVersion: string;
  targetTokens: number;
  sourceText: string;
  onUsage?: (usage: ModelUsageReport) => void;
  signal?: AbortSignal;
}

/** Token-accounting port consumed by Context without owning its provider. */
export interface TokenMeter {
  initialize(): Promise<void>;
  estimate(input: TokenMeterInput): TokenEstimate;
  observeUsage(
    modelCallId: string,
    usage: ModelUsageReport,
    estimatedInputTokens: number,
  ): Promise<TokenUsageObservation>;
  revision(): number;
}
