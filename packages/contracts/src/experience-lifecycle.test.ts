import { describe, expect, it } from "vitest";
import {
  EXPERIENCE_LIFECYCLE_TRANSITIONS,
  ExperienceLifecycleCommandSchema,
  ExperienceLifecycleEventDraftSchema,
  ExperienceLifecycleEventSchema,
  ExperienceRetrievalAttributionSchema,
  RetrievedExperienceHitSchema,
} from "./experience-lifecycle.js";
import type { ExperienceLifecycleAction } from "./experience-lifecycle.js";

const hash = `sha256:${"a".repeat(64)}`;
const actor = { type: "user" as const, id: "user:one" };
const evidenceRef = {
  kind: "run_event" as const,
  projectId: "project:one",
  runId: "run:one",
  eventId: "event:one:1",
  sequence: 1,
  eventType: "run.completed",
  eventHash: hash,
};

const REASON_CODES: Readonly<Record<ExperienceLifecycleAction, string>> = {
  validate: "review_accepted",
  reject: "review_rejected",
  dispute: "user_challenge",
  resolve: "resolution_confirmed",
  retire: "user_requested_retirement",
};

function lifecycleEventDraft(action: ExperienceLifecycleAction) {
  const transition = EXPERIENCE_LIFECYCLE_TRANSITIONS[action];
  return {
    schemaVersion: "tracegraph.experience-lifecycle-event.v1" as const,
    eventType: "experience.lifecycle.transitioned" as const,
    ownerId: "owner:one",
    caseId: "experience:one",
    caseVersion: 1,
    action,
    fromStatus: transition.from[0]!,
    toStatus: transition.to,
    actor,
    reasonCode: REASON_CODES[action],
    idempotencyKey: `experience-lifecycle:${action}:1`,
    occurredAt: "2026-10-01T00:00:00.000Z",
    expectedSequence: 0,
  };
}

function lifecycleEvent(action: ExperienceLifecycleAction) {
  const { expectedSequence: _draftOnly, ...draft } = lifecycleEventDraft(action);
  return {
    ...draft,
    eventId: `experience-event:${action}`,
    sequence: 1,
    eventHash: hash,
  };
}

function attribution() {
  return {
    rank: 1,
    hitId: "experience-hit:one",
    caseId: "experience:one",
    caseVersion: 1,
    contentHash: hash,
    score: 0.5,
    sourcePath: `experience/${encodeURIComponent("experience:one")}.md`,
    evidenceRefs: [evidenceRef],
    injectedTokens: 32,
  };
}

describe("Experience lifecycle contracts", () => {
  it.each(["validate", "reject", "dispute", "resolve", "retire"] as const)(
    "accepts the canonical %s transition from its declared source status",
    (action) => {
      const draft = lifecycleEventDraft(action);
      expect(ExperienceLifecycleEventDraftSchema.parse(draft)).toEqual(draft);
      const event = lifecycleEvent(action);
      expect(ExperienceLifecycleEventSchema.parse(event)).toEqual(event);
      const { previousEventHash: _optional, ...firstEvent } = { ...event, previousEventHash: hash };
      expect(ExperienceLifecycleEventSchema.parse(firstEvent).previousEventHash).toBeUndefined();
    },
  );

  it("rejects a status pair or reason code that contradicts the declared action", () => {
    expect(ExperienceLifecycleEventDraftSchema.safeParse({
      ...lifecycleEventDraft("validate"),
      toStatus: "retired",
    }).success).toBe(false);
    expect(ExperienceLifecycleEventDraftSchema.safeParse({
      ...lifecycleEventDraft("validate"),
      fromStatus: "validated",
    }).success).toBe(false);
    expect(ExperienceLifecycleEventDraftSchema.safeParse({
      ...lifecycleEventDraft("validate"),
      reasonCode: "user_challenge",
    }).success).toBe(false);
    expect(ExperienceLifecycleEventSchema.safeParse({
      ...lifecycleEvent("retire"),
      reasonCode: "resolution_confirmed",
    }).success).toBe(false);
    expect(ExperienceLifecycleEventSchema.safeParse({
      ...lifecycleEvent("retire"),
      actor: { type: "system", id: "system:one" },
    }).success).toBe(false);
  });

  it("keeps the lifecycle command bounded to explicit user intent", () => {
    const command = {
      ownerId: "owner:one",
      caseId: "experience:one",
      caseVersion: 1,
      expectedSequence: 0,
      action: "validate" as const,
      actor,
      reasonCode: "review_accepted",
      idempotencyKey: "experience-lifecycle:validate:1",
    };
    expect(ExperienceLifecycleCommandSchema.parse(command)).toEqual(command);
    expect(ExperienceLifecycleCommandSchema.safeParse({
      ...command,
      expectedSequence: -1,
    }).success).toBe(false);
    expect(ExperienceLifecycleCommandSchema.safeParse({
      ...command,
      callerAssignedStatus: "validated",
    }).success).toBe(false);
  });

  it("requires attribution to point at the canonical Case path", () => {
    const valid = attribution();
    expect(ExperienceRetrievalAttributionSchema.parse(valid)).toEqual(valid);
    expect(ExperienceRetrievalAttributionSchema.safeParse({
      ...valid,
      sourcePath: "experience/experience%3Aother.md",
    }).success).toBe(false);
    expect(ExperienceRetrievalAttributionSchema.safeParse({
      ...valid,
      injectedTokens: 0,
    }).success).toBe(false);
    expect(RetrievedExperienceHitSchema.parse({ content: "A retrieved Case.", attribution: valid }))
      .toEqual({ content: "A retrieved Case.", attribution: valid });
    expect(RetrievedExperienceHitSchema.safeParse({
      content: "   ",
      attribution: valid,
    }).success).toBe(false);
  });
});
