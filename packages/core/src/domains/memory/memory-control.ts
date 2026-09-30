import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  MemoryCandidateCreateRequestSchema,
  MemoryControlEventDraftSchema,
  MemoryControlListResponseSchema,
  MemoryCorrectionRequestSchema,
  MemoryDerivedCandidateRequestSchema,
  MemoryDeleteRequestSchema,
  MemoryRecordV2Schema,
  MemoryReviewRequestSchema,
  MemoryRevokeRequestSchema,
  MemoryUseRequestSummarySchema,
  type MemoryControlEvent,
  type MemoryControlEventDraft,
  type MemoryControlItem,
  type MemoryControlListResponse,
  type MemoryRunEvidenceRef,
  type MemoryRecordV2,
  type SessionEvent,
} from "@tracegraph/contracts";
import { redactSensitiveText, sha256, stableStringify } from "../../kernel/crypto.js";
import { detectMemoryConflicts, replayMemoryFeedback } from "./memory-governance.js";
import { assertCandidateEvidenceSequences, projectMemoryEpisode } from "./memory-episode.js";
import { MemoryLifecycleService } from "./memory-lifecycle.js";

export type MemoryControlErrorCode =
  | "memory_control_not_found"
  | "memory_control_scope_denied"
  | "memory_control_deleted"
  | "memory_control_conflict"
  | "memory_control_invalid_command"
  | "memory_control_corrupt";

export class MemoryControlError extends Error {
  readonly code: MemoryControlErrorCode;
  readonly statusCode: number;

  constructor(code: MemoryControlErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MemoryControlError";
    this.code = code;
    this.statusCode = code === "memory_control_not_found" || code === "memory_control_scope_denied" ? 404
      : code === "memory_control_deleted" ? 410
        : code === "memory_control_conflict" ? 409
          : code === "memory_control_invalid_command" ? 400
            : 500;
  }
}

export interface MemoryV2RecordStore {
  initialize(): Promise<void>;
  list(ownerId: string): Promise<readonly MemoryRecordV2[]>;
  writeCandidate(record: MemoryRecordV2): Promise<void>;
  delete(ownerId: string, memoryIds: readonly string[]): Promise<void>;
}

export interface MemoryControlJournal {
  list?(runId: string): Promise<SessionEvent[]>;
  listMemoryLifecycle(ownerId: string, memoryId: string): Promise<readonly import("@tracegraph/contracts").MemoryLifecycleEvent[]>;
  listMemoryControl(ownerId: string, memoryId: string): Promise<readonly MemoryControlEvent[]>;
  appendMemoryControl(draft: MemoryControlEventDraft): Promise<{ event: MemoryControlEvent; replayed: boolean }>;
  listMemoryFeedback(ownerId: string, memoryId: string, memoryVersion: number): Promise<readonly import("@tracegraph/contracts").MemoryFeedbackEvent[]>;
  listMemoryUseRequests(memoryId: string, memoryVersion: number, contentDigest: string): Promise<readonly import("@tracegraph/contracts").MemoryUseRequestSummary[]>;
}

export interface MemoryControlScope {
  /** Host-derived ids of projects/workspaces visible to this local capability. */
  readonly allowedScopeIds: readonly string[];
}

/**
 * Canonical local payload store for reviewed V2 Memory records. It contains
 * immutable candidate seeds; mutable status is always replayed from Lifecycle.
 */
export class JsonlMemoryV2RecordStore implements MemoryV2RecordStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
  }

  async list(ownerId: string): Promise<MemoryRecordV2[]> {
    const path = this.#path(ownerId);
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if (hasCode(error, "ENOENT")) return [];
      throw error;
    }
    if (content.length === 0) return [];
    if (!content.endsWith("\n")) throw new MemoryControlError("memory_control_corrupt", "Memory V2 record file has a partial final row");
    const records: MemoryRecordV2[] = [];
    const identities = new Set<string>();
    for (const [index, line] of content.split("\n").filter(Boolean).entries()) {
      let record: MemoryRecordV2;
      try {
        record = MemoryRecordV2Schema.parse(JSON.parse(line) as unknown);
      } catch (error) {
        throw new MemoryControlError("memory_control_corrupt", `Memory V2 record ${index + 1} is invalid`, { cause: error });
      }
      if (record.scope.ownerId !== ownerId || record.status !== "candidate") {
        throw new MemoryControlError("memory_control_corrupt", `Memory V2 record ${index + 1} is outside its immutable owner-scoped candidate store`);
      }
      if (record.contentDigest !== undefined && record.contentDigest !== sha256(record.claim)) {
        throw new MemoryControlError("memory_control_corrupt", `Memory V2 record ${index + 1} claim digest does not match its content`);
      }
      const identity = `${record.memoryId}\u0000${record.version}`;
      if (identities.has(identity)) throw new MemoryControlError("memory_control_corrupt", "Memory V2 store contains a duplicate identity/version");
      identities.add(identity);
      records.push(record);
    }
    return records;
  }

  async writeCandidate(recordValue: MemoryRecordV2): Promise<void> {
    const record = MemoryRecordV2Schema.parse(recordValue);
    if (record.status !== "candidate") throw new MemoryControlError("memory_control_invalid_command", "Only immutable candidate seeds can be stored");
    const records = await this.list(record.scope.ownerId);
    const sameId = records.find((item) => item.memoryId === record.memoryId);
    if (sameId !== undefined) {
      if (sameId.version === record.version && sameId.contentDigest === record.contentDigest && sameId.claim === record.claim) return;
      throw new MemoryControlError("memory_control_conflict", `Memory identity ${record.memoryId} already has a different immutable record`);
    }
    await this.#replace(record.scope.ownerId, [...records, record]);
  }

  async delete(ownerId: string, memoryIds: readonly string[]): Promise<void> {
    const remove = new Set(memoryIds);
    if (remove.size === 0) return;
    await this.#replace(ownerId, (await this.list(ownerId)).filter((record) => !remove.has(record.memoryId)));
  }

  #path(ownerId: string): string {
    return join(this.#root, sha256(ownerId).slice("sha256:".length), "records.jsonl");
  }

  async #replace(ownerId: string, records: readonly MemoryRecordV2[]): Promise<void> {
    const path = this.#path(ownerId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      const body = records.map((record) => JSON.stringify(record)).join("\n");
      await handle.writeFile(body.length === 0 ? "" : `${body}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, path);
      const directory = await open(dirname(path), fsConstants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

export interface MemoryControlServiceOptions {
  readonly ownerId: string;
  readonly actorId: string;
  readonly records: MemoryV2RecordStore;
  readonly journal: MemoryControlJournal;
  readonly lifecycle: MemoryLifecycleService;
  readonly now?: () => Date;
}

/** The one domain command/query service shared by Host, CLI, and Web. */
export class MemoryControlService {
  readonly #ownerId: string;
  readonly #actorId: string;
  readonly #records: MemoryV2RecordStore;
  readonly #journal: MemoryControlJournal;
  readonly #lifecycle: MemoryLifecycleService;
  readonly #now: () => Date;
  #mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: MemoryControlServiceOptions) {
    this.#ownerId = options.ownerId;
    this.#actorId = options.actorId;
    this.#records = options.records;
    this.#journal = options.journal;
    this.#lifecycle = options.lifecycle;
    this.#now = options.now ?? (() => new Date());
  }

  async list(scope: MemoryControlScope): Promise<MemoryControlListResponse> {
    const stored = await this.#records.list(this.#ownerId);
    const visible: MemoryControlItem[] = [];
    const projectedRecords: MemoryRecordV2[] = [];
    for (const seed of stored) {
      if (!hasScopeAccess(seed, scope)) continue;
      const controlEvents = await this.#journal.listMemoryControl(this.#ownerId, seed.memoryId);
      const creation = controlEvents.find(isMemoryCreationEvent);
      if (creation === undefined) {
        // The immutable payload is written before its creation fact is appended. A reader that lands
        // inside that window sees an uncommitted candidate, which is pending rather than corrupt.
        continue;
      }
      if (creation.contentDigest !== (seed.contentDigest ?? sha256(seed.claim))) {
        throw new MemoryControlError("memory_control_corrupt", `Memory ${seed.memoryId} content does not match its committed control fact`);
      }
      if (controlEvents.some((event) => event.action === "deleted")) {
        await this.#records.delete(this.#ownerId, [seed.memoryId]);
        continue;
      }
      const lifecycle = await this.#lifecycle.read(seed);
      const record = lifecycle.record;
      const feedbackEvents = await this.#journal.listMemoryFeedback(this.#ownerId, record.memoryId, record.version);
      const feedback = replayMemoryFeedback(seed, feedbackEvents);
      const contentDigest = record.contentDigest ?? sha256(record.claim);
      const memoryUseRequests = (await this.#journal.listMemoryUseRequests(record.memoryId, record.version, contentDigest))
        .map((value) => MemoryUseRequestSummarySchema.parse(value));
      projectedRecords.push(record);
      visible.push({ record, lifecycleSequence: lifecycle.sequence, feedback, memoryUseRequests });
    }
    return MemoryControlListResponseSchema.parse({
      items: visible.sort((left, right) => left.record.createdAt.localeCompare(right.record.createdAt)
        || left.record.memoryId.localeCompare(right.record.memoryId)),
      conflicts: detectMemoryConflicts(projectedRecords, this.#now()),
    });
  }

  createCandidate(inputValue: unknown, scope: MemoryControlScope): Promise<MemoryControlItem> {
    return this.#mutate(() => this.#createCandidate(inputValue, scope));
  }

  /** Core-only path for an extractor result; it can only create a review candidate. */
  createDerivedCandidate(inputValue: unknown): Promise<MemoryControlItem> {
    return this.#mutate(() => this.#createDerivedCandidate(inputValue));
  }

  review(memoryId: string, inputValue: unknown, scope: MemoryControlScope): Promise<MemoryControlItem> {
    return this.#mutate(async () => {
      const input = MemoryReviewRequestSchema.parse(inputValue);
      const seed = await this.#requireRecord(memoryId, scope);
      const result = await this.#lifecycle.transition(seed, {
        ownerId: this.#ownerId,
        memoryId: seed.memoryId,
        memoryVersion: seed.version,
        expectedSequence: input.expected_sequence,
        action: input.action,
        actor: { type: "user", id: this.#actorId },
        reasonCode: input.action === "review_activate" ? "review_accepted" : "review_rejected",
        idempotencyKey: input.command_id,
      });
      return this.#item(seed, result.record, result.event.sequence);
    });
  }

  correct(memoryId: string, inputValue: unknown, scope: MemoryControlScope): Promise<MemoryControlItem> {
    return this.#mutate(async () => {
      const input = MemoryCorrectionRequestSchema.parse(inputValue);
      const oldSeed = await this.#requireRecord(memoryId, scope);
      const oldState = await this.#lifecycle.read(oldSeed);
      const replacementId = `memory:${sha256(`${this.#ownerId}:${input.command_id}`).slice("sha256:".length, 40)}`;
      const existing = (await this.#records.list(this.#ownerId)).find((record) => record.memoryId === replacementId);
      const priorControl = (await this.#journal.listMemoryControl(this.#ownerId, replacementId))
        .find((event) => event.idempotencyKey === input.command_id);
      if (priorControl !== undefined && (priorControl.action !== "corrected"
        || priorControl.relatedMemoryId !== oldSeed.memoryId
        || priorControl.contentDigest !== sha256(input.claim))) {
        throw new MemoryControlError("memory_control_conflict", "Correction command id was reused for different content or intent");
      }
      const priorLifecycle = (await this.#journal.listMemoryLifecycle(this.#ownerId, oldSeed.memoryId))
        .find((event) => event.idempotencyKey === `correction:${input.command_id}`);
      if (priorLifecycle !== undefined) {
        const expectedNormalizedKey = input.normalized_key ?? oldSeed.normalizedKey;
        if (existing === undefined
          || priorControl?.action !== "corrected"
          || priorControl.relatedMemoryId !== oldSeed.memoryId
          || priorControl.contentDigest !== sha256(input.claim)
          || priorLifecycle.sequence !== input.expected_sequence + 1
          || priorLifecycle.relatedMemoryId !== replacementId
          || priorLifecycle.actor.id !== this.#actorId
          || existing.claim !== input.claim
          || existing.normalizedKey !== expectedNormalizedKey) {
          throw new MemoryControlError("memory_control_conflict", "Correction command id was reused for different content or intent");
        }
        const replacementState = await this.#lifecycle.read(existing);
        return this.#item(existing, replacementState.record, replacementState.sequence);
      }
      if (oldState.record.status === "revoked") throw new MemoryControlError("memory_control_conflict", "Revoked Memory cannot be corrected");
      if (input.expected_sequence !== oldState.sequence) {
        throw new MemoryControlError("memory_control_conflict", `Expected lifecycle sequence ${input.expected_sequence}, found ${oldState.sequence}`);
      }
      const now = this.#now().toISOString();
      const replacement = existing ?? MemoryRecordV2Schema.parse({
        ...oldSeed,
        memoryId: replacementId,
        version: oldSeed.version + 1,
        claim: input.claim,
        contentDigest: sha256(input.claim),
        contentArtifactRef: undefined,
        ...(input.normalized_key === undefined ? {} : { normalizedKey: input.normalized_key }),
        status: "candidate",
        provenance: {
          ...oldSeed.provenance,
          evidenceRefs: [...oldSeed.provenance.evidenceRefs, {
            source_id: `source:${sha256(`${this.#ownerId}:${input.command_id}`).slice("sha256:".length, 40)}`,
            source_type: "user",
            trust: "trusted",
            description: "User-authored correction",
          }],
          createdBy: { type: "user", id: this.#actorId },
        },
        lineage: {
          ...oldSeed.lineage,
          supersedes: [...new Set([oldSeed.memoryId, ...oldSeed.lineage.supersedes])],
        },
        createdAt: now,
        updatedAt: now,
      });
      if (existing !== undefined && (existing.claim !== input.claim
        || existing.normalizedKey !== (input.normalized_key ?? oldSeed.normalizedKey)
        || existing.lineage.supersedes[0] !== oldSeed.memoryId)) {
        throw new MemoryControlError("memory_control_conflict", "Correction command id was reused for different content");
      }
      if (existing === undefined) await this.#records.writeCandidate(replacement);
      try {
        await this.#appendControl(replacement, {
          action: "corrected",
          relatedMemoryId: oldSeed.memoryId,
          idempotencyKey: input.command_id,
        });
      } catch (error) {
        if (existing === undefined) await this.#records.delete(this.#ownerId, [replacementId]);
        throw error;
      }

      const action = oldState.record.status === "active"
        ? "supersede"
        : oldState.record.status === "disputed"
          ? "resolve_superseded"
          : oldState.record.status === "candidate"
            ? "review_reject"
            : "revoke";
      const reasonCode = action === "supersede" ? "replacement_accepted"
        : action === "resolve_superseded" ? "correction_accepted"
          : action === "review_reject" ? "review_rejected"
            : "user_requested_forget";
      const transitioned = await this.#lifecycle.transition(oldSeed, {
        ownerId: this.#ownerId,
        memoryId: oldSeed.memoryId,
        memoryVersion: oldSeed.version,
        expectedSequence: input.expected_sequence,
        action,
        actor: { type: "user", id: this.#actorId },
        reasonCode,
        ...(action === "supersede" || action === "resolve_superseded" ? { relatedMemoryId: replacementId } : {}),
        idempotencyKey: `correction:${input.command_id}`,
      });
      const replacementState = await this.#lifecycle.read(replacement);
      return this.#item(replacement, replacementState.record, replacementState.sequence);
    });
  }

  revoke(memoryId: string, inputValue: unknown, scope: MemoryControlScope): Promise<MemoryControlItem> {
    return this.#mutate(async () => {
      const input = MemoryRevokeRequestSchema.parse(inputValue);
      const seed = await this.#requireRecord(memoryId, scope);
      const current = await this.#lifecycle.read(seed);
      const action = current.record.status === "candidate" ? "review_reject" : "revoke";
      const result = await this.#lifecycle.transition(seed, {
        ownerId: this.#ownerId,
        memoryId: seed.memoryId,
        memoryVersion: seed.version,
        expectedSequence: input.expected_sequence,
        action,
        actor: { type: "user", id: this.#actorId },
        reasonCode: action === "review_reject" ? "review_rejected" : "user_requested_forget",
        idempotencyKey: input.command_id,
      });
      return this.#item(seed, result.record, result.event.sequence);
    });
  }

  delete(memoryId: string, commandId: string, scope: MemoryControlScope): Promise<{ deletedMemoryIds: readonly string[] }> {
    return this.#mutate(async () => {
      const records = await this.#records.list(this.#ownerId);
      const selectedEvents = await this.#journal.listMemoryControl(this.#ownerId, memoryId);
      const priorDeletion = selectedEvents.find((event) => event.action === "deleted");
      const parsedCommandId = MemoryDeleteRequestSchema.parse({ command_id: commandId }).command_id;
      const familyIds = priorDeletion?.deletedMemoryIds
        ?? relatedSupersessionFamily(records, (await this.#requireRecord(memoryId, scope)).memoryId)
          .map((record) => record.memoryId).sort();
      if (!familyIds.includes(memoryId) || new Set(familyIds).size !== familyIds.length) {
        throw new MemoryControlError("memory_control_corrupt", "Memory deletion tombstone has an invalid lineage set");
      }
      const tombstoneScopeIds = priorDeletion?.action === "deleted"
        ? priorDeletion.deletedScopeIds
        : [...new Set(records.filter((record) => familyIds.includes(record.memoryId)).flatMap(recordScopeIds))].sort();
      if (!tombstoneScopeIds.every((id) => scope.allowedScopeIds.includes(id))) {
        throw new MemoryControlError("memory_control_not_found", "Memory was not found");
      }
      const byId = new Map(records.map((record) => [record.memoryId, record]));
      const family = familyIds.map((id) => byId.get(id)).filter((record): record is MemoryRecordV2 => record !== undefined);
      for (const record of family) {
        if (!hasScopeAccess(record, scope)) throw new MemoryControlError("memory_control_scope_denied", "Memory lineage crosses the caller's visible scope");
      }
      if (family.length !== familyIds.length) {
        const missing = familyIds.filter((id) => !byId.has(id));
        for (const missingId of missing) {
          const events = await this.#journal.listMemoryControl(this.#ownerId, missingId);
          if (!events.some((event) => event.action === "deleted"
            && sameStringSet(event.deletedMemoryIds, familyIds)
            && sameStringSet(event.deletedScopeIds, tombstoneScopeIds))) {
            throw new MemoryControlError("memory_control_corrupt", "Memory payload is missing without a matching deletion tombstone");
          }
        }
      }
      for (const record of family) {
        const events = await this.#journal.listMemoryControl(this.#ownerId, record.memoryId);
        const tombstone = events.find((event) => event.action === "deleted");
        if (tombstone !== undefined) {
          if (!sameStringSet(tombstone.deletedMemoryIds, familyIds)
            || !sameStringSet(tombstone.deletedScopeIds, tombstoneScopeIds)) {
            throw new MemoryControlError("memory_control_corrupt", "Memory family tombstones disagree about deletion scope");
          }
          continue;
        }
        await this.#appendControl(record, {
          action: "deleted",
          deletedMemoryIds: familyIds,
          deletedScopeIds: tombstoneScopeIds,
          idempotencyKey: `delete:${sha256(`${this.#ownerId}:${parsedCommandId}:${record.memoryId}`).slice("sha256:".length)}`,
        });
      }
      // A content-free tombstone is durable before payload removal. If physical
      // replacement fails, every read remains fail-closed and retry can scrub.
      await this.#records.delete(this.#ownerId, familyIds);
      return { deletedMemoryIds: familyIds };
    });
  }

  async #createCandidate(inputValue: unknown, scope: MemoryControlScope): Promise<MemoryControlItem> {
    const input = MemoryCandidateCreateRequestSchema.parse(inputValue);
    if (input.project_id !== undefined && !scope.allowedScopeIds.includes(input.project_id)) {
      throw new MemoryControlError("memory_control_scope_denied", "Candidate project is outside the caller's visible scope");
    }
    const memoryId = `memory:${sha256(`${this.#ownerId}:${input.command_id}`).slice("sha256:".length, 40)}`;
    const contentDigest = sha256(input.claim);
    const prior = (await this.#records.list(this.#ownerId)).find((record) => record.memoryId === memoryId);
    const priorControlEvents = await this.#journal.listMemoryControl(this.#ownerId, memoryId);
    if (priorControlEvents.some((event) => event.action === "deleted")) {
      throw new MemoryControlError("memory_control_deleted", "Memory has been deleted");
    }
    const priorCreation = priorControlEvents.find(isMemoryCreationEvent);
    if (prior !== undefined && !candidateMatchesInput(prior, input, this.#ownerId, this.#actorId)) {
      throw new MemoryControlError("memory_control_conflict", "Candidate command id was reused for different content");
    }
    if (priorCreation !== undefined && (priorCreation.action !== "candidate_created"
      || priorCreation.contentDigest !== contentDigest)) {
      throw new MemoryControlError("memory_control_conflict", "Candidate command id was reused for a different Memory command");
    }
    if (priorCreation !== undefined && prior === undefined) {
      throw new MemoryControlError("memory_control_corrupt", "Candidate creation fact has no matching immutable payload");
    }
    const now = this.#now().toISOString();
    const record = prior ?? MemoryRecordV2Schema.parse({
      schemaVersion: 2,
      memoryId,
      version: 1,
      kind: input.kind,
      claim: input.claim,
      contentDigest,
      ...(input.normalized_key === undefined ? {} : { normalizedKey: input.normalized_key }),
      status: "candidate",
      scope: { ownerId: this.#ownerId, ...(input.project_id === undefined ? {} : { projectId: input.project_id }), visibility: "private" },
      provenance: {
        origin: "user",
        evidenceRefs: [{
          source_id: `source:${sha256(`${this.#ownerId}:${input.command_id}`).slice("sha256:".length, 40)}`,
          source_type: "user",
          trust: "trusted",
          description: input.source_description ?? "Entered by the user for review",
        }],
        createdBy: { type: "user", id: this.#actorId },
      },
      assessment: { sourceTrust: "authoritative", verification: "asserted" },
      validity: {
        validFrom: now,
        ...(input.valid_until === undefined ? {} : { validUntil: input.valid_until }),
        applicability: [],
        invalidators: [],
      },
      governance: {
        sensitivity: input.sensitivity ?? "personal",
        consent: "explicit",
        retentionPolicy: input.retention_policy ?? "user-managed",
        allowModelUse: input.allow_model_use ?? false,
        allowExport: false,
      },
      lineage: { supersedes: [], contradictedBy: [], derivedFrom: [] },
      createdAt: now,
      updatedAt: now,
    });
    if (prior === undefined) await this.#records.writeCandidate(record);
    try {
      if (priorCreation === undefined) await this.#appendControl(record, { action: "candidate_created", idempotencyKey: input.command_id });
    } catch (error) {
      if (prior === undefined) await this.#records.delete(this.#ownerId, [memoryId]);
      throw error;
    }
    const projected = await this.#lifecycle.read(record);
    return this.#item(record, projected.record, projected.sequence);
  }

  async #createDerivedCandidate(inputValue: unknown): Promise<MemoryControlItem> {
    const input = MemoryDerivedCandidateRequestSchema.parse(inputValue);
    if (this.#journal.list === undefined) {
      throw new MemoryControlError("memory_control_invalid_command", "Derived candidates require the canonical Run Ledger");
    }
    const runEvents = await this.#journal.list(input.run_id);
    const episode = projectMemoryEpisode(runEvents);
    if (episode.episodeId !== input.episode_id
      || episode.projectId !== input.project_id
      || episode.sourceDigest !== input.source_digest) {
      throw new MemoryControlError("memory_control_invalid_command", "Derived Memory source is not the expected settled Run episode");
    }
    let canonicalEvidence: MemoryRunEvidenceRef[];
    try {
      canonicalEvidence = assertCandidateEvidenceSequences(episode, runEvents, input.evidence_refs.map((ref) => ref.sequence));
    } catch (error) {
      throw new MemoryControlError("memory_control_invalid_command", "Derived Memory evidence does not belong to the settled Run", { cause: error });
    }
    if (canonicalEvidence.some((ref, index) => stableStringify(ref) !== stableStringify(input.evidence_refs[index]))) {
      throw new MemoryControlError("memory_control_invalid_command", "Derived Memory evidence reference does not match canonical event identity");
    }
    if (input.evidence_refs.some((ref) => ref.projectId !== input.project_id || ref.runId !== input.run_id)) {
      throw new MemoryControlError("memory_control_invalid_command", "Derived Memory evidence must match its project and Run scope");
    }
    const sequences = input.evidence_refs.map((ref) => ref.sequence);
    if (new Set(sequences).size !== sequences.length) {
      throw new MemoryControlError("memory_control_invalid_command", "Derived Memory evidence sequences must be unique");
    }
    const claim = redactSensitiveText(input.claim).trim();
    if (claim.length === 0) throw new MemoryControlError("memory_control_invalid_command", "Derived Memory claim is empty after redaction");
    const memoryId = `memory:${sha256(`${this.#ownerId}:${input.command_id}`).slice("sha256:".length, 40)}`;
    const contentDigest = sha256(claim);
    const records = await this.#records.list(this.#ownerId);
    const sameScope = records.filter((record) => record.scope.projectId === input.project_id);
    const exactDuplicate = sameScope.find((record) => record.claim === claim);
    if (exactDuplicate !== undefined && exactDuplicate.memoryId !== memoryId) {
      const projected = await this.#lifecycle.read(exactDuplicate);
      return this.#item(exactDuplicate, projected.record, projected.sequence);
    }
    const relatedByKey = input.normalized_key === undefined
      ? []
      : sameScope.filter((record) => record.normalizedKey === input.normalized_key && record.claim !== claim);
    const prior = records.find((record) => record.memoryId === memoryId);
    const priorEvents = await this.#journal.listMemoryControl(this.#ownerId, memoryId);
    if (priorEvents.some((event) => event.action === "deleted")) {
      throw new MemoryControlError("memory_control_deleted", "Derived Memory candidate has been deleted");
    }
    const priorCreation = priorEvents.find(isMemoryCreationEvent);
    if (prior !== undefined && (prior.claim !== claim
      || prior.contentDigest !== contentDigest
      || prior.provenance.createdFromEpisode !== input.episode_id
      || prior.scope.projectId !== input.project_id
      || prior.normalizedKey !== input.normalized_key)) {
      throw new MemoryControlError("memory_control_conflict", "Derived candidate command id was reused for different content");
    }
    if (priorCreation !== undefined && (priorCreation.action !== "derived_candidate_created"
      || priorCreation.contentDigest !== contentDigest
      || priorCreation.episodeId !== input.episode_id
      || priorCreation.sourceDigest !== input.source_digest)) {
      throw new MemoryControlError("memory_control_conflict", "Derived candidate command id was reused for different provenance");
    }
    if (priorCreation !== undefined && prior === undefined) {
      throw new MemoryControlError("memory_control_corrupt", "Derived candidate creation fact has no matching immutable payload");
    }
    const now = this.#now().toISOString();
    const record = prior ?? MemoryRecordV2Schema.parse({
      schemaVersion: 2,
      memoryId,
      version: 1,
      kind: input.kind,
      claim,
      contentDigest,
      ...(input.normalized_key === undefined ? {} : { normalizedKey: input.normalized_key }),
      status: "candidate",
      scope: { ownerId: this.#ownerId, projectId: input.project_id, visibility: "private" },
      provenance: {
        origin: "model_inference",
        evidenceRefs: input.evidence_refs,
        createdBy: { type: "model", id: input.extractor_id },
        createdFromEpisode: input.episode_id,
      },
      assessment: {
        sourceTrust: "trusted",
        ...(input.inference_confidence === undefined ? {} : { inferenceConfidence: input.inference_confidence }),
        verification: "inferred",
      },
      validity: { validFrom: now, applicability: [], invalidators: [] },
      governance: {
        sensitivity: "internal",
        consent: "policy",
        retentionPolicy: "user-managed",
        allowModelUse: false,
        allowExport: false,
      },
      lineage: { supersedes: [], contradictedBy: [], derivedFrom: relatedByKey.map((record) => record.memoryId).slice(0, 100) },
      createdAt: now,
      updatedAt: now,
    });
    if (prior === undefined) await this.#records.writeCandidate(record);
    try {
      if (priorCreation === undefined) {
        await this.#appendControl(record, {
          action: "derived_candidate_created",
          episodeId: input.episode_id,
          sourceDigest: input.source_digest,
          actor: { type: "system", id: input.extractor_id },
          idempotencyKey: input.command_id,
        });
      }
    } catch (error) {
      if (prior === undefined) await this.#records.delete(this.#ownerId, [memoryId]);
      throw error;
    }
    const projected = await this.#lifecycle.read(record);
    return this.#item(record, projected.record, projected.sequence);
  }

  async #appendControl(
    record: MemoryRecordV2,
    action: { action: "corrected"; relatedMemoryId: string; idempotencyKey: string }
      | { action: "candidate_created"; idempotencyKey: string }
      | { action: "derived_candidate_created"; episodeId: string; sourceDigest: string; actor: { type: "system"; id: string }; idempotencyKey: string }
      | { action: "deleted"; deletedMemoryIds: readonly string[]; deletedScopeIds: readonly string[]; idempotencyKey: string },
  ): Promise<MemoryControlEvent> {
    const events = await this.#journal.listMemoryControl(this.#ownerId, record.memoryId);
    const draft = MemoryControlEventDraftSchema.parse({
      schemaVersion: "tracegraph.memory-control.v1",
      eventType: "memory.control.commanded",
      ownerId: this.#ownerId,
      memoryId: record.memoryId,
      memoryVersion: record.version,
      expectedSequence: events.length,
      action: action.action,
      ...(action.action === "candidate_created" || action.action === "corrected" || action.action === "derived_candidate_created"
        ? { contentDigest: record.contentDigest ?? sha256(record.claim) }
        : {}),
      ...(action.action === "derived_candidate_created" ? { episodeId: action.episodeId, sourceDigest: action.sourceDigest } : {}),
      ...(action.action === "corrected" ? { relatedMemoryId: action.relatedMemoryId } : {}),
      ...(action.action === "deleted" ? { deletedMemoryIds: action.deletedMemoryIds } : {}),
      ...(action.action === "deleted" ? { deletedScopeIds: action.deletedScopeIds } : {}),
      actor: action.action === "derived_candidate_created" ? action.actor : { type: "user", id: this.#actorId },
      idempotencyKey: action.idempotencyKey,
      occurredAt: this.#now().toISOString(),
    });
    return (await this.#journal.appendMemoryControl(draft)).event;
  }

  async #requireRecord(memoryId: string, scope: MemoryControlScope): Promise<MemoryRecordV2> {
    const records = await this.#records.list(this.#ownerId);
    const record = records.find((item) => item.memoryId === memoryId);
    if (record === undefined) {
      const tombstone = await this.#journal.listMemoryControl(this.#ownerId, memoryId);
      if (tombstone.some((event) => event.action === "deleted")) throw new MemoryControlError("memory_control_deleted", "Memory has been deleted");
      throw new MemoryControlError("memory_control_not_found", "Memory was not found");
    }
    if (!hasScopeAccess(record, scope)) throw new MemoryControlError("memory_control_not_found", "Memory was not found");
    const controlEvents = await this.#journal.listMemoryControl(this.#ownerId, memoryId);
    if (controlEvents.some((event) => event.action === "deleted")) {
      await this.#records.delete(this.#ownerId, [memoryId]);
      throw new MemoryControlError("memory_control_deleted", "Memory has been deleted");
    }
    const creation = controlEvents.find(isMemoryCreationEvent);
    if (creation === undefined) {
      throw new MemoryControlError("memory_control_not_found", "Memory was not found");
    }
    if (creation.contentDigest !== (record.contentDigest ?? sha256(record.claim))) {
      throw new MemoryControlError("memory_control_corrupt", `Memory ${memoryId} content does not match its committed control fact`);
    }
    return record;
  }

  async #item(seed: MemoryRecordV2, record: MemoryRecordV2, lifecycleSequence: number): Promise<MemoryControlItem> {
    const feedbackEvents = await this.#journal.listMemoryFeedback(this.#ownerId, record.memoryId, record.version);
    const feedback = replayMemoryFeedback(seed, feedbackEvents);
    return {
      record,
      lifecycleSequence,
      feedback,
      memoryUseRequests: [...await this.#journal.listMemoryUseRequests(
        record.memoryId,
        record.version,
        record.contentDigest ?? sha256(record.claim),
      )],
    };
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationQueue.then(operation, operation);
    this.#mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function hasScopeAccess(record: MemoryRecordV2, scope: MemoryControlScope): boolean {
  return recordScopeIds(record).every((id) => scope.allowedScopeIds.includes(id));
}

function isMemoryCreationEvent(event: MemoryControlEvent): event is Extract<MemoryControlEvent, { action: "candidate_created" | "derived_candidate_created" | "corrected" }> {
  return event.action === "candidate_created"
    || event.action === "derived_candidate_created"
    || event.action === "corrected";
}

function recordScopeIds(record: MemoryRecordV2): string[] {
  return [record.scope.projectId, record.scope.workspaceId].filter((id): id is string => id !== undefined);
}

function candidateMatchesInput(
  record: MemoryRecordV2,
  input: ReturnType<typeof MemoryCandidateCreateRequestSchema.parse>,
  ownerId: string,
  actorId: string,
): boolean {
  const source = record.provenance.evidenceRefs[0];
  return record.status === "candidate"
    && record.version === 1
    && record.kind === input.kind
    && record.claim === input.claim
    && record.contentDigest === sha256(input.claim)
    && record.normalizedKey === input.normalized_key
    && record.scope.ownerId === ownerId
    && record.scope.projectId === input.project_id
    && record.scope.workspaceId === undefined
    && record.scope.visibility === "private"
    && record.provenance.origin === "user"
    && record.provenance.createdBy.type === "user"
    && record.provenance.createdBy.id === actorId
    && source !== undefined && "source_type" in source
    && source?.source_type === "user"
    && source.source_id === `source:${sha256(`${ownerId}:${input.command_id}`).slice("sha256:".length, 40)}`
    && source.description === (input.source_description ?? "Entered by the user for review")
    && record.assessment.sourceTrust === "authoritative"
    && record.assessment.verification === "asserted"
    && record.validity.validUntil === input.valid_until
    && record.governance.sensitivity === (input.sensitivity ?? "personal")
    && record.governance.consent === "explicit"
    && record.governance.retentionPolicy === (input.retention_policy ?? "user-managed")
    && record.governance.allowModelUse === (input.allow_model_use ?? false)
    && record.governance.allowExport === false;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && new Set(left).size === left.length
    && left.every((value) => right.includes(value));
}

function relatedSupersessionFamily(records: readonly MemoryRecordV2[], selectedId: string): MemoryRecordV2[] {
  const byId = new Map(records.map((record) => [record.memoryId, record]));
  const related = new Set([selectedId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (related.has(record.memoryId) || record.lineage.supersedes.some((id) => related.has(id))) {
        if (!related.has(record.memoryId)) { related.add(record.memoryId); changed = true; }
        for (const id of record.lineage.supersedes) {
          if (byId.has(id) && !related.has(id)) { related.add(id); changed = true; }
        }
      }
    }
  }
  return [...related].map((id) => byId.get(id)).filter((record): record is MemoryRecordV2 => record !== undefined);
}

function hasCode(value: unknown, code: string): boolean {
  return typeof value === "object" && value !== null && "code" in value && value.code === code;
}
