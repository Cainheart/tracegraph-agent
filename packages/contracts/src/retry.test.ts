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
    summary: "Transient provider failure; retry 2 of 6 in 500ms",
    artifact_refs: [],
    turn_id: "turn:retry:1",
    model_call_id: "model-call:retry",
    data: {
      retry_scope: "model_provider",
      attempt: 1,
      next_attempt: 2,
      max_attempts: 6,
      delay_ms: 500,
      reason_code: "http_503",
    },
  };

  it("accepts a bounded retry fact and rejects inconsistent attempt counters", () => {
    expect(WireSessionEventSchema.safeParse(event).success).toBe(true);
    expect(WireSessionEventSchema.safeParse({
      ...event,
      data: { ...event.data, attempt: 5, next_attempt: 6, delay_ms: 20_000 },
    }).success).toBe(false);
  });
});
