import {
  MemoryConflictGroupSchema,
  MemoryFeedbackEventDraftSchema,
  MemoryFeedbackEventSchema,
  MemoryFeedbackProjectionSchema,
  MemoryRecordV2Schema,
  MemoryRecallGateResultSchema,
  MemoryFeedbackReviewDismissalCommandSchema,
  MemoryUseFeedbackCommandSchema,
  type MemoryConflictGroup,
  type MemoryFeedbackEvent,
  type MemoryFeedbackEventDraft,
  type MemoryFeedbackProjection,
  type MemoryFeedbackReview,
  type MemoryFeedbackReviewDismissalCommand,
  type MemoryRecordV2,
  type MemoryRecallGateResult,
  type MemoryUseFeedbackCommand,
} from "@tracegraph/contracts";
import type { MemoryUseProjection } from "./memory-use.js";
import { sha256, stableStringify } from "../../kernel/crypto.js";

export type MemoryGovernanceErrorCode =
  | "memory_governance_invalid_record"
  | "memory_feedback_invalid_command"
  | "memory_feedback_use_unavailable"
  | "memory_feedback_use_mismatch"
  | "memory_feedback_sequence_conflict"
  | "memory_feedback_idempotency_conflict"
  | "memory_feedback_already_recorded"
  | "memory_feedback_review_not_open"
  | "memory_feedback_corrupt";

export class MemoryGovernanceError extends Error {
  readonly code: MemoryGovernanceErrorCode;

  constructor(code: MemoryGovernanceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MemoryGovernanceError";
    this.code = code;
  }
}

export interface MemoryFeedbackJournal {
  listMemoryFeedback(ownerId: string, memoryId: string, memoryVersion: number): Promise<readonly MemoryFeedbackEvent[]>;
  appendMemoryFeedback(draft: MemoryFeedbackEventDraft): Promise<{ event: MemoryFeedbackEvent; replayed: boolean }>;
}

export interface MemoryUseLookup {
  getMemoryUse(runId: string, memoryUseId: string): Promise<MemoryUseProjection | undefined>;
}

export interface MemoryFeedbackResult {
  readonly event: MemoryFeedbackEvent;
  readonly projection: MemoryFeedbackProjection;
  readonly replayed: boolean;
}

export class MemoryFeedbackService {
  readonly #journal: MemoryFeedbackJournal;
  readonly #uses: MemoryUseLookup;
  readonly #now: () => Date;

  constructor(options: {
    journal: MemoryFeedbackJournal;
    uses: MemoryUseLookup;
    now?: () => Date;
  }) {
    this.#journal = options.journal;
    this.#uses = options.uses;
    this.#now = options.now ?? (() => new Date());
  }

  async record(seedRecordValue: unknown, commandValue: unknown): Promise<MemoryFeedbackResult> {
    const record = parseGovernanceRecord(seedRecordValue);
    let command: MemoryUseFeedbackCommand;
    try {
      command = MemoryUseFeedbackCommandSchema.parse(commandValue);
    } catch (error) {
      throw new MemoryGovernanceError("memory_feedback_invalid_command", "Memory use feedback command is invalid", { cause: error });
    }
    if (command.memoryVersion !== record.version) {
      throw new MemoryGovernanceError("memory_feedback_invalid_command", "Feedback targets a different Memory version");
    }

    const events = await this.#journal.listMemoryFeedback(record.scope.ownerId, record.memoryId, record.version);
    const projection = replayMemoryFeedback(record, events);
    const duplicate = events.find((event) => event.idempotencyKey === command.idempotencyKey);
    if (duplicate !== undefined) {
      if (!sameReportedFeedbackIntent(duplicate, record, command)) {
        throw new MemoryGovernanceError(
          "memory_feedback_idempotency_conflict",
          `Idempotency key ${command.idempotencyKey} was already used for a different feedback action`,
        );
      }
      return { event: duplicate, projection, replayed: true };
    }
    const existingUseFeedback = events.find((event) => event.action === "reported"
      && event.runId === command.runId
      && event.memoryUseId === command.memoryUseId
      && event.actor.id === command.actor.id);
    if (existingUseFeedback !== undefined) {
      if (!sameReportedFeedbackIntent(existingUseFeedback, record, command)) {
        throw new MemoryGovernanceError(
          "memory_feedback_already_recorded",
          "This user already submitted different feedback for the same MemoryUse",
        );
      }
      return { event: existingUseFeedback, projection, replayed: true };
    }
    if (command.expectedSequence !== events.length) {
      throw new MemoryGovernanceError(
        "memory_feedback_sequence_conflict",
        `Expected feedback sequence ${command.expectedSequence}, found ${events.length}`,
      );
    }

    const use = await this.#uses.getMemoryUse(command.runId, command.memoryUseId);
    if (use === undefined || use.status !== "response") {
      throw new MemoryGovernanceError(
        "memory_feedback_use_unavailable",
        "Feedback requires a MemoryUse that received a validated Adapter response",
      );
    }
    if (use.runId !== command.runId
      || use.memoryUseId !== command.memoryUseId
      || use.contextManifestRef !== command.contextManifestId
      || !use.dispatchIntent.memory_items.some((item) => (
        item.memory_ref.record_schema_version === "tracegraph.memory-record.v2"
        && item.memory_ref.content_hash === (record.contentDigest ?? sha256(record.claim))
        && item.memory_ref.memory_id === record.memoryId
        && item.memory_ref.version === record.version
      ))) {
      throw new MemoryGovernanceError(
        "memory_feedback_use_mismatch",
        "Feedback does not match the Memory version and ContextManifest recorded by the Run",
      );
    }

    const draft = MemoryFeedbackEventDraftSchema.parse({
      schemaVersion: "tracegraph.memory-feedback.v1",
      eventType: "memory.feedback",
      ownerId: record.scope.ownerId,
      memoryId: record.memoryId,
      memoryVersion: record.version,
      expectedSequence: command.expectedSequence,
      action: "reported",
      runId: command.runId,
      memoryUseId: command.memoryUseId,
      contextManifestId: command.contextManifestId,
      feedback: command.feedback,
      actor: command.actor,
      idempotencyKey: command.idempotencyKey,
      occurredAt: this.#now().toISOString(),
    });
    const appended = await this.#journal.appendMemoryFeedback(draft);
    const nextProjection = replayMemoryFeedback(record, [...events, appended.event]);
    return { event: appended.event, projection: nextProjection, replayed: appended.replayed };
  }

  async dismissReview(seedRecordValue: unknown, commandValue: unknown): Promise<MemoryFeedbackResult> {
    const record = parseGovernanceRecord(seedRecordValue);
    let command: MemoryFeedbackReviewDismissalCommand;
    try {
      command = MemoryFeedbackReviewDismissalCommandSchema.parse(commandValue);
    } catch (error) {
      throw new MemoryGovernanceError("memory_feedback_invalid_command", "Memory feedback review command is invalid", { cause: error });
    }
    if (command.memoryVersion !== record.version) {
      throw new MemoryGovernanceError("memory_feedback_invalid_command", "Review targets a different Memory version");
    }

    const events = await this.#journal.listMemoryFeedback(record.scope.ownerId, record.memoryId, record.version);
    const projection = replayMemoryFeedback(record, events);
    const duplicate = events.find((event) => event.idempotencyKey === command.idempotencyKey);
    if (duplicate !== undefined) {
      if (!sameDismissalIntent(duplicate, record, command)) {
        throw new MemoryGovernanceError(
          "memory_feedback_idempotency_conflict",
          `Idempotency key ${command.idempotencyKey} was already used for a different review action`,
        );
      }
      return { event: duplicate, projection, replayed: true };
    }
    if (command.expectedSequence !== events.length) {
      throw new MemoryGovernanceError(
        "memory_feedback_sequence_conflict",
        `Expected feedback sequence ${command.expectedSequence}, found ${events.length}`,
      );
    }
    if (!projection.reviewRequired.some((review) => review.feedbackEventId === command.feedbackEventId)) {
      throw new MemoryGovernanceError(
        "memory_feedback_review_not_open",
        "Only an unresolved incorrect/stale report can be dismissed after review",
      );
    }

    const draft = MemoryFeedbackEventDraftSchema.parse({
      schemaVersion: "tracegraph.memory-feedback.v1",
      eventType: "memory.feedback",
      ownerId: record.scope.ownerId,
      memoryId: record.memoryId,
      memoryVersion: record.version,
      expectedSequence: command.expectedSequence,
      action: "review_dismissed",
      feedbackEventId: command.feedbackEventId,
      actor: command.actor,
      idempotencyKey: command.idempotencyKey,
      occurredAt: this.#now().toISOString(),
    });
    const appended = await this.#journal.appendMemoryFeedback(draft);
    const nextProjection = replayMemoryFeedback(record, [...events, appended.event]);
    return { event: appended.event, projection: nextProjection, replayed: appended.replayed };
  }
}

/** Replay content-free feedback and derive only unresolved review signals/counts. */
export function replayMemoryFeedback(
  seedRecordValue: unknown,
  eventValues: readonly unknown[],
): MemoryFeedbackProjection {
  const record = parseGovernanceRecord(seedRecordValue);
  const events = eventValues.map((value, index) => {
    try {
      return MemoryFeedbackEventSchema.parse(value);
    } catch (error) {
      throw new MemoryGovernanceError("memory_feedback_corrupt", `Memory feedback event ${index + 1} is invalid`, { cause: error });
    }
  });
  const counts = { helpful: 0, irrelevant: 0, incorrect: 0, stale: 0 };
  const pending = new Map<string, MemoryFeedbackReview>();
  const idempotencyKeys = new Set<string>();
  let previousHash: string | undefined;

  for (const [index, event] of events.entries()) {
    const { eventHash, ...body } = event;
    if (event.ownerId !== record.scope.ownerId
      || event.memoryId !== record.memoryId
      || event.memoryVersion !== record.version
      || event.sequence !== index + 1
      || event.previousEventHash !== previousHash
      || idempotencyKeys.has(event.idempotencyKey)
      || sha256(stableStringify(body)) !== eventHash) {
      throw new MemoryGovernanceError("memory_feedback_corrupt", `Memory feedback event ${index + 1} breaks its identity, sequence, idempotency, or hash chain`);
    }
    idempotencyKeys.add(event.idempotencyKey);
    if (event.action === "reported") {
      counts[event.feedback] += 1;
      if (event.feedback === "incorrect" || event.feedback === "stale") {
        pending.set(event.eventId, {
          feedbackEventId: event.eventId,
          memoryId: event.memoryId,
          memoryVersion: event.memoryVersion,
          feedback: event.feedback,
          runId: event.runId,
          memoryUseId: event.memoryUseId,
          contextManifestId: event.contextManifestId,
          occurredAt: event.occurredAt,
        });
      }
    } else {
      if (!pending.delete(event.feedbackEventId)) {
        throw new MemoryGovernanceError("memory_feedback_corrupt", `Memory feedback event ${index + 1} dismisses no open review`);
      }
    }
    previousHash = event.eventHash;
  }
  return MemoryFeedbackProjectionSchema.parse({
    ownerId: record.scope.ownerId,
    memoryId: record.memoryId,
    memoryVersion: record.version,
    sequence: events.length,
    feedbackCounts: counts,
    reviewRequired: [...pending.values()],
  });
}

export interface MemoryRecallRequestScope {
  readonly ownerId: string;
  readonly workspaceId?: string;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly runId?: string;
}

/**
 * Build a fail-closed V2 recall decision from a complete owner-scoped snapshot.
 * Conflict detection uses explicit normalizedKey only; it performs no semantic
 * or model-based claim inference.
 */
export function evaluateMemoryRecallEligibility(input: {
  readonly records: readonly unknown[];
  readonly request: MemoryRecallRequestScope;
  readonly now?: Date;
  readonly feedback?: readonly MemoryFeedbackProjection[];
}): MemoryRecallGateResult {
  const records = input.records.map(parseGovernanceRecord);
  const now = input.now ?? new Date();
  if (records.some((record) => record.scope.ownerId !== input.request.ownerId)) {
    throw new MemoryGovernanceError("memory_governance_invalid_record", "Recall evaluation requires one complete owner-scoped Memory snapshot");
  }
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.memoryId)) {
      throw new MemoryGovernanceError("memory_governance_invalid_record", "Recall snapshot must contain only one current version per Memory id");
    }
    ids.add(record.memoryId);
  }
  const feedbackByVersion = new Map<string, MemoryFeedbackProjection>();
  for (const feedback of input.feedback ?? []) {
    if (feedback.ownerId !== input.request.ownerId || !records.some((record) => (
      record.memoryId === feedback.memoryId && record.version === feedback.memoryVersion
    ))) {
      throw new MemoryGovernanceError("memory_governance_invalid_record", "Feedback projection does not match the current owner Memory snapshot");
    }
    const key = feedbackKey(feedback.memoryId, feedback.memoryVersion);
    if (feedbackByVersion.has(key)) {
      throw new MemoryGovernanceError("memory_governance_invalid_record", "Recall snapshot contains duplicate feedback projections");
    }
    feedbackByVersion.set(key, feedback);
  }

  const conflicts = detectMemoryConflicts(records, now);
  const conflictRefs = new Set(conflicts.flatMap((group) => group.participants.map((participant) => participant.memoryId)));
  const feedbackReviewRequired = [...feedbackByVersion.values()].flatMap((feedback) => feedback.reviewRequired);
  const pendingFeedbackRefs = new Set(feedbackReviewRequired.map((review) => feedbackKey(review.memoryId, review.memoryVersion)));
  const eligible: MemoryRecallGateResult["eligible"] = [];
  const blocked: MemoryRecallGateResult["blocked"] = [];

  for (const record of records) {
    const item = { memoryId: record.memoryId, version: record.version };
    let reason: MemoryRecallGateResult["blocked"][number]["reason"] | undefined;
    if (record.status !== "active") reason = "not_active";
    else if (conflictRefs.has(record.memoryId)) reason = "unresolved_conflict";
    else if (pendingFeedbackRefs.has(feedbackKey(record.memoryId, record.version))) reason = "feedback_requires_review";
    else if (record.scope.ownerId !== input.request.ownerId) reason = "owner_mismatch";
    else if (!scopeMatches(record, input.request)) reason = "scope_mismatch";
    else if (Date.parse(record.validity.validFrom) > now.getTime()) reason = "not_yet_valid";
    else if (record.validity.validUntil !== undefined && Date.parse(record.validity.validUntil) <= now.getTime()) reason = "expired";
    else if (!record.governance.allowModelUse) reason = "model_use_disabled";
    else if (record.governance.consent === "none") reason = "consent_missing";
    else if (record.governance.sensitivity === "secret" || record.governance.sensitivity === "unknown") reason = "sensitivity_blocked";
    else if (record.assessment.sourceTrust !== "authoritative" && record.assessment.sourceTrust !== "trusted") reason = "source_untrusted";
    if (reason === undefined) eligible.push(item);
    else blocked.push({ ...item, reason });
  }
  return MemoryRecallGateResultSchema.parse({ eligible, blocked, conflicts, feedbackReviewRequired });
}

/** Derive deterministic unresolved conflicts for same-key, overlapping active claims. */
export function detectMemoryConflicts(recordsValue: readonly unknown[], now = new Date()): MemoryConflictGroup[] {
  const records = recordsValue.map(parseGovernanceRecord);
  const groups = new Map<string, MemoryRecordV2[]>();
  const seen = new Set<string>();
  for (const record of records) {
    if (record.status !== "active" && record.status !== "disputed") continue;
    if (Date.parse(record.validity.validFrom) > now.getTime()
      || (record.validity.validUntil !== undefined && Date.parse(record.validity.validUntil) <= now.getTime())) continue;
    const key = normalizeConflictKey(record.normalizedKey);
    if (key === undefined) continue;
    const bucket = groups.get(`${record.scope.ownerId}\u0000${key}`) ?? [];
    bucket.push(record);
    groups.set(`${record.scope.ownerId}\u0000${key}`, bucket);
    const identity = `${record.scope.ownerId}\u0000${record.memoryId}`;
    if (seen.has(identity)) {
      throw new MemoryGovernanceError("memory_governance_invalid_record", "Conflict input contains duplicate Memory identities");
    }
    seen.add(identity);
  }

  const conflicts: MemoryConflictGroup[] = [];
  for (const [compositeKey, bucket] of groups) {
    if (bucket.length < 2) continue;
    const [ownerId, key] = compositeKey.split("\u0000", 2) as [string, string];
    const digests = bucket.map((record) => sha256(record.claim));
    const adjacency = bucket.map(() => new Set<number>());
    for (let left = 0; left < bucket.length; left += 1) {
      for (let right = left + 1; right < bucket.length; right += 1) {
        const first = bucket[left]!;
        const second = bucket[right]!;
        if (digests[left] === digests[right] || !scopesOverlap(first, second)) continue;
        adjacency[left]!.add(right);
        adjacency[right]!.add(left);
      }
    }
    const visited = new Set<number>();
    for (let start = 0; start < bucket.length; start += 1) {
      if (visited.has(start) || adjacency[start]!.size === 0) continue;
      const component: number[] = [];
      const stack = [start];
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (visited.has(current)) continue;
        visited.add(current);
        component.push(current);
        stack.push(...adjacency[current]!);
      }
      const participants = component.map((index) => bucket[index]!)
        .sort((left, right) => left.memoryId.localeCompare(right.memoryId) || left.version - right.version)
        .map((record) => ({ memoryId: record.memoryId, version: record.version, status: record.status }));
      const normalizedKeyDigest = sha256(key);
      conflicts.push(MemoryConflictGroupSchema.parse({
        conflictId: `conflict:${sha256(stableStringify({ ownerId, normalizedKeyDigest, participants })).slice("sha256:".length)}`,
        ownerId,
        normalizedKeyDigest,
        participants,
      }));
    }
  }
  return conflicts.sort((left, right) => left.conflictId.localeCompare(right.conflictId));
}

function parseGovernanceRecord(value: unknown): MemoryRecordV2 {
  try {
    return MemoryRecordV2Schema.parse(value);
  } catch (error) {
    throw new MemoryGovernanceError("memory_governance_invalid_record", "Memory governance requires a valid V2 record", { cause: error });
  }
}

function normalizeConflictKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase("und").replace(/\s+/gu, " ");
  return normalized.length === 0 ? undefined : normalized;
}

function scopesOverlap(left: MemoryRecordV2, right: MemoryRecordV2): boolean {
  const dimensions = ["workspaceId", "projectId", "sessionId", "runId"] as const;
  return dimensions.every((dimension) => (
    left.scope[dimension] === undefined
    || right.scope[dimension] === undefined
    || left.scope[dimension] === right.scope[dimension]
  ));
}

function scopeMatches(record: MemoryRecordV2, request: MemoryRecallRequestScope): boolean {
  const dimensions = ["workspaceId", "projectId", "sessionId", "runId"] as const;
  return dimensions.every((dimension) => (
    record.scope[dimension] === undefined || record.scope[dimension] === request[dimension]
  ));
}

function feedbackKey(memoryId: string, memoryVersion: number): string {
  return `${memoryId}\u0000${memoryVersion}`;
}

function sameReportedFeedbackIntent(
  event: MemoryFeedbackEvent,
  record: MemoryRecordV2,
  command: MemoryUseFeedbackCommand,
): boolean {
  return event.action === "reported"
    && event.ownerId === record.scope.ownerId
    && event.memoryId === record.memoryId
    && event.memoryVersion === record.version
    && event.runId === command.runId
    && event.memoryUseId === command.memoryUseId
    && event.contextManifestId === command.contextManifestId
    && event.feedback === command.feedback
    && event.actor.id === command.actor.id;
}

function sameDismissalIntent(
  event: MemoryFeedbackEvent,
  record: MemoryRecordV2,
  command: MemoryFeedbackReviewDismissalCommand,
): boolean {
  return event.action === "review_dismissed"
    && event.ownerId === record.scope.ownerId
    && event.memoryId === record.memoryId
    && event.memoryVersion === record.version
    && event.feedbackEventId === command.feedbackEventId
    && event.actor.id === command.actor.id;
}
