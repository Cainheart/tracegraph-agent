import { describe, expect, it } from "vitest";
import {
  MemoryFeedbackEventDraftSchema,
  MemoryFeedbackEventSchema,
  MemoryUseEventDataSchema,
  type MemoryFeedbackEvent,
  type MemoryFeedbackEventDraft,
  type MemoryRecordV2,
} from "@tracegraph/contracts";
import { sha256, stableStringify } from "../../kernel/crypto.js";
import {
  MemoryFeedbackService,
  type MemoryFeedbackJournal,
  MemoryGovernanceError,
  detectMemoryConflicts,
  evaluateMemoryRecallEligibility,
  replayMemoryFeedback,
} from "./memory-governance.js";
import type { MemoryUseProjection } from "./memory-use.js";

function activeMemory(overrides: Partial<MemoryRecordV2> = {}): MemoryRecordV2 {
  return {
    schemaVersion: 2,
    memoryId: "memory:one",
    version: 1,
    kind: "fact",
    claim: "The project uses an append-only ledger.",
    normalizedKey: "project architecture",
    status: "active",
    scope: { ownerId: "owner:one", projectId: "project:one", visibility: "private" },
    provenance: {
      origin: "user",
      evidenceRefs: [{ source_id: "source:user", source_type: "user", trust: "trusted" }],
      createdBy: { type: "user", id: "user:one" },
    },
    assessment: { sourceTrust: "authoritative", verification: "asserted" },
    validity: {
      validFrom: "2026-09-01T00:00:00.000Z",
      applicability: ["project:one"],
      invalidators: [],
    },
    governance: {
      sensitivity: "internal",
      consent: "explicit",
      retentionPolicy: "review-annually",
      allowModelUse: true,
      allowExport: false,
    },
    lineage: { supersedes: [], contradictedBy: [], derivedFrom: [] },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

const request = {
  ownerId: "owner:one",
  projectId: "project:one",
} as const;

describe("Memory conflict, staleness, and use feedback governance", () => {
  it("derives deterministic conflicts by explicit normalized key and overlapping scope", () => {
    const first = activeMemory({ memoryId: "memory:canada", normalizedKey: "  Country   of residence ", claim: "Country: Canada" });
    const second = activeMemory({ memoryId: "memory:china", normalizedKey: "country of residence", claim: "Country: China" });
    const conflict = detectMemoryConflicts([first, second], new Date("2026-09-30T00:00:00.000Z"));
    expect(conflict).toHaveLength(1);
    expect(conflict[0]?.participants.map((item) => item.memoryId)).toEqual(["memory:canada", "memory:china"]);
    expect(JSON.stringify(conflict)).not.toContain("Country: Canada");
    expect(detectMemoryConflicts([second, first], new Date("2026-09-30T00:00:00.000Z"))).toEqual(conflict);
    expect(detectMemoryConflicts([
      first,
      activeMemory({ memoryId: "memory:copy", normalizedKey: "country of residence", claim: "Country: Canada" }),
    ])).toEqual([]);
  });

  it("does not merge disjoint scopes or infer conflicts without a normalized key", () => {
    const first = activeMemory({ memoryId: "memory:one", normalizedKey: "favorite language", claim: "Language: Chinese" });
    const otherProject = activeMemory({
      memoryId: "memory:two",
      normalizedKey: "favorite language",
      claim: "Language: English",
      scope: { ownerId: "owner:one", projectId: "project:two", visibility: "private" },
    });
    const noKey = activeMemory({ memoryId: "memory:no-key", normalizedKey: undefined, claim: "Language: English" });
    expect(detectMemoryConflicts([first, otherProject])).toEqual([]);
    expect(detectMemoryConflicts([noKey, activeMemory({ ...first, normalizedKey: undefined })])).toEqual([]);
  });

  it("blocks every unresolved conflict member and excludes stale or out-of-scope records", () => {
    const canada = activeMemory({ memoryId: "memory:canada", normalizedKey: "residence", claim: "Residence: Canada" });
    const china = activeMemory({ memoryId: "memory:china", normalizedKey: " RESIDENCE ", claim: "Residence: China" });
    const expired = activeMemory({
      memoryId: "memory:expired",
      normalizedKey: "old-fact",
      validity: {
        validFrom: "2026-09-01T00:00:00.000Z",
        validUntil: "2026-09-29T00:00:00.000Z",
        applicability: [],
        invalidators: [],
      },
    });
    const anotherProject = activeMemory({
      memoryId: "memory:other-project",
      normalizedKey: "other-fact",
      scope: { ownerId: "owner:one", projectId: "project:two", visibility: "private" },
    });
    const eligible = activeMemory({ memoryId: "memory:safe", normalizedKey: "safe-fact" });
    const gate = evaluateMemoryRecallEligibility({
      records: [canada, china, expired, anotherProject, eligible],
      request,
      now: new Date("2026-09-30T00:00:00.000Z"),
    });
    expect(gate.conflicts).toHaveLength(1);
    expect(gate.eligible).toEqual([{ memoryId: "memory:safe", version: 1 }]);
    expect(gate.blocked).toEqual(expect.arrayContaining([
      { memoryId: "memory:canada", version: 1, reason: "unresolved_conflict" },
      { memoryId: "memory:china", version: 1, reason: "unresolved_conflict" },
      { memoryId: "memory:expired", version: 1, reason: "expired" },
      { memoryId: "memory:other-project", version: 1, reason: "scope_mismatch" },
    ]));
  });

  it("records version-bound feedback and keeps adverse reports out until explicitly reviewed", async () => {
    let now = new Date("2026-09-30T01:00:00.000Z");
    const record = activeMemory();
    const journal = new InMemoryMemoryFeedbackJournal();
    const use = memoryUseFor(record);
    const service = new MemoryFeedbackService({
      journal,
      uses: { getMemoryUse: async () => use },
      now: () => now,
    });
    const staleCommand = {
      memoryVersion: record.version,
      runId: use.runId,
      memoryUseId: use.memoryUseId,
      contextManifestId: use.contextManifestRef,
      feedback: "stale",
      actor: { type: "user", id: "user:one" },
      expectedSequence: 0,
      idempotencyKey: "feedback:stale:one",
    } as const;
    const stale = await service.record(record, staleCommand);
    expect(stale.projection.feedbackCounts.stale).toBe(1);
    expect(stale.projection.reviewRequired).toHaveLength(1);
    expect(await service.record(record, { ...staleCommand, idempotencyKey: "feedback:stale:retry" }))
      .toMatchObject({ event: stale.event, replayed: true });
    await expect(service.record(record, {
      ...staleCommand,
      feedback: "helpful",
      idempotencyKey: "feedback:stale:changed",
    })).rejects.toMatchObject<Partial<MemoryGovernanceError>>({ code: "memory_feedback_already_recorded" });
    const gate = evaluateMemoryRecallEligibility({ records: [record], request, feedback: [stale.projection] });
    expect(gate.eligible).toEqual([]);
    expect(gate.blocked).toEqual([{ memoryId: record.memoryId, version: record.version, reason: "feedback_requires_review" }]);
    expect(gate.feedbackReviewRequired[0]).toMatchObject({ memoryUseId: use.memoryUseId, feedback: "stale" });

    now = new Date("2026-09-30T01:05:00.000Z");
    const dismissed = await service.dismissReview(record, {
      memoryVersion: record.version,
      feedbackEventId: stale.event.eventId,
      actor: { type: "user", id: "user:one" },
      expectedSequence: 1,
      idempotencyKey: "feedback:review:dismiss:one",
    });
    expect(dismissed.projection.feedbackCounts.stale).toBe(1);
    expect(dismissed.projection.reviewRequired).toEqual([]);
    expect(evaluateMemoryRecallEligibility({ records: [record], request, feedback: [dismissed.projection] }).eligible)
      .toEqual([{ memoryId: record.memoryId, version: record.version }]);

    const retry = await service.record(record, staleCommand);
    expect(retry.replayed).toBe(true);
    expect(retry.projection.reviewRequired).toEqual([]);
  });

  it("requires a response-backed MemoryUse with the exact Memory version and manifest", async () => {
    const record = activeMemory();
    const mismatchUse = memoryUseFor(activeMemory({ memoryId: "memory:other" }));
    const service = new MemoryFeedbackService({
      journal: new InMemoryMemoryFeedbackJournal(),
      uses: { getMemoryUse: async () => mismatchUse },
    });
    const command = {
      memoryVersion: record.version,
      runId: mismatchUse.runId,
      memoryUseId: mismatchUse.memoryUseId,
      contextManifestId: mismatchUse.contextManifestRef,
      feedback: "helpful",
      actor: { type: "user", id: "user:one" },
      expectedSequence: 0,
      idempotencyKey: "feedback:mismatch",
    };
    await expect(service.record(record, command)).rejects.toMatchObject<Partial<MemoryGovernanceError>>({
      code: "memory_feedback_use_mismatch",
    });
    const unavailableService = new MemoryFeedbackService({
      journal: new InMemoryMemoryFeedbackJournal(),
      uses: { getMemoryUse: async () => undefined },
    });
    await expect(unavailableService.record(record, command)).rejects.toMatchObject<Partial<MemoryGovernanceError>>({
      code: "memory_feedback_use_unavailable",
    });
    const wrongDigestUse = memoryUseFor(record, `sha256:${"e".repeat(64)}`);
    const wrongDigestService = new MemoryFeedbackService({
      journal: new InMemoryMemoryFeedbackJournal(),
      uses: { getMemoryUse: async () => wrongDigestUse },
    });
    await expect(wrongDigestService.record(record, command)).rejects.toMatchObject<Partial<MemoryGovernanceError>>({
      code: "memory_feedback_use_mismatch",
    });
  });

  it("replay rejects hash-chain tampering and does not infer a positive truth score", async () => {
    const record = activeMemory();
    const journal = new InMemoryMemoryFeedbackJournal();
    const use = memoryUseFor(record);
    const secondUse = memoryUseFor(record, undefined, "memory-use:two", "context:two");
    const service = new MemoryFeedbackService({
      journal,
      uses: { getMemoryUse: async (_runId, memoryUseId) => memoryUseId === secondUse.memoryUseId ? secondUse : use },
    });
    const command = (feedback: "helpful" | "irrelevant", sequence: number, selectedUse: MemoryUseProjection) => ({
      memoryVersion: record.version,
      runId: selectedUse.runId,
      memoryUseId: selectedUse.memoryUseId,
      contextManifestId: selectedUse.contextManifestRef,
      feedback,
      actor: { type: "user" as const, id: "user:one" },
      expectedSequence: sequence,
      idempotencyKey: `feedback:${feedback}:${sequence}`,
    });
    await service.record(record, command("helpful", 0, use));
    const irrelevant = await service.record(record, command("irrelevant", 1, secondUse));
    expect(irrelevant.projection.feedbackCounts).toEqual({ helpful: 1, irrelevant: 1, incorrect: 0, stale: 0 });
    expect(evaluateMemoryRecallEligibility({ records: [record], request, feedback: [irrelevant.projection] }).eligible)
      .toEqual([{ memoryId: record.memoryId, version: record.version }]);
    expect(() => replayMemoryFeedback(record, [{ ...irrelevant.event, feedback: "stale" }])).toThrow(/hash chain/u);
  });
});

class InMemoryMemoryFeedbackJournal implements MemoryFeedbackJournal {
  readonly #events = new Map<string, MemoryFeedbackEvent[]>();
  #sequence = 0;

  async listMemoryFeedback(ownerId: string, memoryId: string, memoryVersion: number) {
    return [...(this.#events.get(`${ownerId}\u0000${memoryId}\u0000${memoryVersion}`) ?? [])];
  }

  async appendMemoryFeedback(draftValue: MemoryFeedbackEventDraft) {
    const draft = MemoryFeedbackEventDraftSchema.parse(draftValue);
    const key = `${draft.ownerId}\u0000${draft.memoryId}\u0000${draft.memoryVersion}`;
    const events = this.#events.get(key) ?? [];
    const duplicate = events.find((event) => event.idempotencyKey === draft.idempotencyKey);
    if (duplicate !== undefined) return { event: duplicate, replayed: true };
    if (draft.expectedSequence !== events.length) throw new Error("memory feedback sequence conflict");
    const previous = events.at(-1);
    const body = {
      schemaVersion: draft.schemaVersion,
      eventType: draft.eventType,
      eventId: `feedback-event:${++this.#sequence}`,
      ownerId: draft.ownerId,
      memoryId: draft.memoryId,
      memoryVersion: draft.memoryVersion,
      sequence: events.length + 1,
      action: draft.action,
      ...(draft.action === "reported" ? {
        runId: draft.runId,
        memoryUseId: draft.memoryUseId,
        contextManifestId: draft.contextManifestId,
        feedback: draft.feedback,
      } : { feedbackEventId: draft.feedbackEventId }),
      actor: draft.actor,
      idempotencyKey: draft.idempotencyKey,
      occurredAt: draft.occurredAt,
      ...(previous === undefined ? {} : { previousEventHash: previous.eventHash }),
    };
    const persisted = MemoryFeedbackEventSchema.parse({
      ...body,
      eventHash: sha256(stableStringify(body)),
    });
    this.#events.set(key, [...events, persisted]);
    return { event: persisted, replayed: false };
  }
}

function memoryUseFor(
  record: MemoryRecordV2,
  contentHash = record.contentDigest ?? sha256(record.claim),
  memoryUseId = "memory-use:one",
  contextManifestId = "context:one",
): MemoryUseProjection {
  const memoryRef = {
    record_schema_version: "tracegraph.memory-record.v2",
    memory_id: record.memoryId,
    version: record.version,
    content_hash: contentHash,
    evidence_refs: [{ source_id: "source:user", source_type: "user", trust: "trusted" }],
  };
  const retrieval = {
    rank: 1,
    hit_id: "chunk:one",
    content_hash: `sha256:${"b".repeat(64)}`,
    score: 1,
    source_path: `memory/${encodeURIComponent(record.memoryId)}.md`,
    start_line: 1,
    end_line: 1,
    heading_path: [],
    injected_tokens: 2,
    memory_ref: memoryRef,
  };
  const dispatchIntent = MemoryUseEventDataSchema.parse({
    memory_use_id: memoryUseId,
    stage: "dispatch_intent",
    manifest_id: contextManifestId,
    rendered_context_digest: `sha256:${"c".repeat(64)}`,
    token_estimate: {
      estimator_id: "heuristic_v2",
      confidence: "estimated",
      input_tokens: 2,
      output_tokens: 0,
      per_section: { system: 0, goal: 0, history: 0, tool: 0, repo: 0, memory: 2, experience: 0 },
    },
    memory_items: [{
      context_item_id: "context-item:one",
      memory_ref: memoryRef,
      retrieval,
      content_digest: `sha256:${"d".repeat(64)}`,
      included_tokens: 2,
    }],
  });
  if (dispatchIntent.stage !== "dispatch_intent") throw new Error("Expected a dispatch intent");
  return {
    memoryUseId,
    projectId: "project:one",
    runId: "run:one",
    turnId: "turn:one",
    modelCallId: "model-call:one",
    contextManifestRef: contextManifestId,
    status: "response",
    dispatchIntent,
    lastEventId: "event:memory-use-response",
  };
}
