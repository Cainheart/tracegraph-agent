import { ModelRequestError } from "../../kernel/types.js";

export const MODEL_PROVIDER_RETRY_POLICY = Object.freeze({
  // Five retries after the original request. This applies only before a
  // Decision is accepted; Tools and side effects have separate dispatch rules.
  maxAttempts: 6,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
});

const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_TRANSPORT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ETIMEDOUT",
]);

export type ModelRetryReasonCode =
  | "http_408"
  | "http_425"
  | "http_429"
  | "http_500"
  | "http_502"
  | "http_503"
  | "http_504"
  | "transport_timeout"
  | "transport_network_error";

export interface ModelRetryPlan {
  readonly attempt: number;
  readonly nextAttempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly reasonCode: ModelRetryReasonCode;
}

/**
 * Public, bounded snapshot written with each logical model request. Tool and
 * Action entries make their independent single-dispatch limits explicit.
 */
export function retryTaxonomySnapshot(maxTurns?: number): Record<string, unknown> {
  return {
    version: "retry-taxonomy.v1",
    model_provider: {
      max_attempts: MODEL_PROVIDER_RETRY_POLICY.maxAttempts,
      retryable_http_statuses: [...TRANSIENT_HTTP_STATUSES].sort((left, right) => left - right),
      retryable_transport_classes: ["timeout", "selected_network_errors"],
      base_backoff_ms: MODEL_PROVIDER_RETRY_POLICY.baseDelayMs,
      max_backoff_ms: MODEL_PROVIDER_RETRY_POLICY.maxDelayMs,
      stop_after_provider_usage: true,
    },
    tool: {
      max_automatic_dispatch_attempts: 1,
      replay_policy: "disabled",
      new_model_authored_actions_are_separate: true,
      run_turn_limit: maxTurns ?? null,
    },
    action: {
      max_dispatch_attempts_per_operation: 1,
      unknown_outcome: "reconcile_only",
    },
  };
}

/** Return a retry plan only for explicitly transient, pre-response failures. */
export function planModelProviderRetry(
  error: unknown,
  attemptsMade: number,
  providerUsageReported: boolean,
): ModelRetryPlan | undefined {
  if (
    !(error instanceof ModelRequestError)
    || providerUsageReported
    || attemptsMade < 1
    || attemptsMade >= MODEL_PROVIDER_RETRY_POLICY.maxAttempts
  ) return undefined;

  const reasonCode = retryReasonCode(error.code);
  if (reasonCode === undefined) return undefined;
  const delayMs = Math.min(
    MODEL_PROVIDER_RETRY_POLICY.baseDelayMs * 2 ** (attemptsMade - 1),
    MODEL_PROVIDER_RETRY_POLICY.maxDelayMs,
  );
  return {
    attempt: attemptsMade,
    nextAttempt: attemptsMade + 1,
    maxAttempts: MODEL_PROVIDER_RETRY_POLICY.maxAttempts,
    delayMs,
    reasonCode,
  };
}

function retryReasonCode(code: string): ModelRetryReasonCode | undefined {
  if (code === "model_timeout") return "transport_timeout";
  if (code === "network_error" || TRANSIENT_TRANSPORT_CODES.has(code)) return "transport_network_error";

  const match = /^model_http_(\d{3})$/u.exec(code);
  if (match === null) return undefined;
  const status = Number(match[1]);
  if (!TRANSIENT_HTTP_STATUSES.has(status)) return undefined;
  return `http_${status}` as ModelRetryReasonCode;
}
