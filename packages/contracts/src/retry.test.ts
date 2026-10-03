import { describe, expect, it } from "vitest";
import { WireSessionEventSchema } from "./event.js";
import { SCHEMA_VERSION } from "./common.js";

describe("model retry Event contract", () => {
  const event = {
    schema_version: SCHEMA_VERSION,
    event_id: "event:model-retry",
    project_id: "project:retry",
    run_id: "run:retry",
    sequence: 4,
    occurred_at: "2026-10-01T00:00:00.000Z",
    type: "model.retry_scheduled",
    summary: "Transient provider failure; retry 2 of 3 in 250ms",
    artifact_refs: [],
    turn_id: "turn:retry:1",
    model_call_id: "model-call:retry",
    data: {
      retry_scope: "model_provider",
      attempt: 1,
      next_attempt: 2,
      max_attempts: 3,
      delay_ms: 250,
      reason_code: "http_503",
    },
  };

  it("accepts a bounded retry fact and rejects inconsistent attempt counters", () => {
    expect(WireSessionEventSchema.safeParse(event).success).toBe(true);
    expect(WireSessionEventSchema.safeParse({
      ...event,
      data: { ...event.data, attempt: 2, next_attempt: 3, delay_ms: 2_000 },
    }).success).toBe(false);
  });
});
