import { describe, expect, it } from "vitest";
import {
  MemoryFeedbackEventDraftSchema,
  MemoryFeedbackEventSchema,
  MemoryRecallGateResultSchema,
} from "./memory-governance.js";

const feedbackDraft = {
  schemaVersion: "tracegraph.memory-feedback.v1",
  eventType: "memory.feedback",
  ownerId: "owner:one",
  memoryId: "memory:one",
  memoryVersion: 2,
  expectedSequence: 0,
  action: "reported",
  runId: "run:one",
  memoryUseId: "memory-use:one",
  contextManifestId: "context:one",
  feedback: "stale",
  actor: { type: "user", id: "user:one" },
  idempotencyKey: "feedback:one",
  occurredAt: "2026-09-30T00:00:00.000Z",
} as const;

describe("Memory governance contracts", () => {
  it("accepts content-free versioned feedback and rejects claim text", () => {
    expect(MemoryFeedbackEventDraftSchema.parse(feedbackDraft).action).toBe("reported");
    expect(MemoryFeedbackEventDraftSchema.safeParse({ ...feedbackDraft, claim: "private memory text" }).success).toBe(false);
    expect(MemoryFeedbackEventSchema.safeParse({
      ...feedbackDraft,
      eventId: "feedback-event:one",
      sequence: 1,
      eventHash: `sha256:${"a".repeat(64)}`,
      claim: "private memory text",
    }).success).toBe(false);
  });

  it("allows dismissal only as a content-free review event shape", () => {
    const dismissed = MemoryFeedbackEventDraftSchema.parse({
      schemaVersion: "tracegraph.memory-feedback.v1",
      eventType: "memory.feedback",
      ownerId: "owner:one",
      memoryId: "memory:one",
      memoryVersion: 2,
      expectedSequence: 1,
      action: "review_dismissed",
      feedbackEventId: "feedback-event:one",
      actor: { type: "user", id: "user:one" },
      idempotencyKey: "feedback:review:one",
      occurredAt: "2026-09-30T00:05:00.000Z",
    });
    expect(dismissed.action).toBe("review_dismissed");
    expect(MemoryFeedbackEventDraftSchema.safeParse({
      schemaVersion: "tracegraph.memory-feedback.v1",
      eventType: "memory.feedback",
      ownerId: "owner:one",
      memoryId: "memory:one",
      memoryVersion: 2,
      expectedSequence: 1,
      action: "review_dismissed",
      feedbackEventId: "feedback-event:one",
      feedback: "stale",
      actor: { type: "user", id: "user:one" },
      idempotencyKey: "feedback:review:one",
      occurredAt: "2026-09-30T00:05:00.000Z",
    }).success).toBe(false);
  });

  it("validates bounded conflict and recall-gate projections", () => {
    const gate = MemoryRecallGateResultSchema.parse({
      eligible: [{ memoryId: "memory:safe", version: 1 }],
      blocked: [{ memoryId: "memory:conflict", version: 2, reason: "unresolved_conflict" }],
      conflicts: [{
        conflictId: "conflict:one",
        ownerId: "owner:one",
        normalizedKeyDigest: `sha256:${"b".repeat(64)}`,
        participants: [
          { memoryId: "memory:conflict", version: 2, status: "active" },
          { memoryId: "memory:other", version: 1, status: "active" },
        ],
      }],
      feedbackReviewRequired: [],
    });
    expect(gate.blocked[0]?.reason).toBe("unresolved_conflict");
  });
});
