import { describe, expect, it } from "vitest";
import { ModelRequestError } from "../../kernel/types.js";
import {
  MODEL_PROVIDER_RETRY_POLICY,
  planModelProviderRetry,
  retryTaxonomySnapshot,
} from "./retry-policy.js";

describe("runtime retry taxonomy", () => {
  it("plans bounded deterministic backoff for explicitly transient provider failures", () => {
    expect(MODEL_PROVIDER_RETRY_POLICY).toEqual({ maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 1_000 });
    expect(planModelProviderRetry(new ModelRequestError("model_http_503", "unavailable"), 1, false)).toEqual({
      attempt: 1,
      nextAttempt: 2,
      maxAttempts: 3,
      delayMs: 250,
      reasonCode: "http_503",
    });
    expect(planModelProviderRetry(new ModelRequestError("ECONNRESET", "connection lost"), 2, false)).toEqual({
      attempt: 2,
      nextAttempt: 3,
      maxAttempts: 3,
      delayMs: 500,
      reasonCode: "transport_network_error",
    });
    expect(planModelProviderRetry(new ModelRequestError("model_http_504", "gateway timeout"), 3, false))
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
        max_attempts: 3,
        base_backoff_ms: 250,
        max_backoff_ms: 1_000,
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
