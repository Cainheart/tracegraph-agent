import { describe, expect, it } from "vitest";
import { ModelRequestError } from "../../kernel/types.js";
import {
  MODEL_PROVIDER_RETRY_POLICY,
  planModelProviderRetry,
  retryTaxonomySnapshot,
} from "./retry-policy.js";

describe("runtime retry taxonomy", () => {
  it("plans bounded deterministic backoff for explicitly transient provider failures", () => {
    expect(MODEL_PROVIDER_RETRY_POLICY).toEqual({ maxAttempts: 6, baseDelayMs: 500, maxDelayMs: 10_000 });
    expect(planModelProviderRetry(new ModelRequestError("model_http_503", "unavailable"), 1, false)).toEqual({
      attempt: 1,
      nextAttempt: 2,
      maxAttempts: 6,
      delayMs: 500,
      reasonCode: "http_503",
    });
    expect(planModelProviderRetry(new ModelRequestError("ECONNRESET", "connection lost"), 2, false)).toEqual({
      attempt: 2,
      nextAttempt: 3,
      maxAttempts: 6,
      delayMs: 1_000,
      reasonCode: "transport_network_error",
    });
    expect(planModelProviderRetry(new ModelRequestError("model_http_504", "gateway timeout"), 6, false))
      .toBeUndefined();
  });

  it("fails closed for permanent, untyped, and already-answered requests", () => {
    expect(planModelProviderRetry(new ModelRequestError("model_http_401", "unauthorized"), 1, false))
      .toBeUndefined();
    expect(planModelProviderRetry(new ModelRequestError("model_http_400", "invalid request"), 1, false))
      .toBeUndefined();
    expect(planModelProviderRetry(new Error("transient"), 1, false)).toBeUndefined();
    expect(planModelProviderRetry(new ModelRequestError("model_http_503", "unavailable"), 1, true))
      .toBeUndefined();
  });

  it("publishes independent bounded policies for providers, Tools, and Actions", () => {
    expect(retryTaxonomySnapshot(8)).toMatchObject({
      version: "retry-taxonomy.v1",
      model_provider: {
        max_attempts: 6,
        base_backoff_ms: 500,
        max_backoff_ms: 10_000,
        stop_after_provider_usage: true,
      },
      tool: {
        max_automatic_dispatch_attempts: 1,
        replay_policy: "disabled",
        run_turn_limit: 8,
      },
      action: {
        max_dispatch_attempts_per_operation: 1,
        unknown_outcome: "reconcile_only",
      },
    });
  });
});
