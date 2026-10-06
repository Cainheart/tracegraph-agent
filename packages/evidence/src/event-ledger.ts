import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, opendir, readFile, readdir, rename, unlink, lstat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  SCHEMA_VERSION,
  SessionEventProposalSchema,
  SessionEventSchema,
  ExtensionErrorDataSchema,
  TeamMemberLostDataSchema,
  TeamSweepCompletedDataSchema,
  IdentifierSchema,
  MemoryFeedbackEventDraftSchema,
  MemoryFeedbackEventSchema,
  MemoryControlEventDraftSchema,
  MemoryControlEventSchema,
  MemoryLifecycleEventDraftSchema,
  MemoryLifecycleEventSchema,
  ExperienceLifecycleEventDraftSchema,
  ExperienceLifecycleEventSchema,
  MemoryUseEventDataSchema,
  MemoryUseRequestSummarySchema,
  Sha256Schema,
  isTerminalEventType,
  type MemoryFeedbackEvent,
  type MemoryFeedbackEventDraft,
  type MemoryControlEvent,
  type MemoryControlEventDraft,
  type MemoryLifecycleEvent,
  type MemoryLifecycleEventDraft,
  type ExperienceLifecycleEvent,
  type ExperienceLifecycleEventDraft,
  type MemoryUseRequestSummary,
  type SessionEvent,
  type SessionEventProposal,
} from "@tracegraph/contracts";
import type { EvidencePrimitives } from "./ports.js";

type Listener = (event: SessionEvent) => void;

export interface AtomicEventScope {
  readonly project_id: string;
  readonly run_id: string;
  readonly session_id?: string;
}

export interface AtomicAppendResult {
  /** One resolved Event per input proposal, followed by the finalize receipt. */
  readonly events: readonly SessionEvent[];
  /** Events newly committed by this transaction; duplicates are omitted. */
  readonly appended: readonly SessionEvent[];
}

export interface MemoryLifecycleAppendResult {
  readonly event: MemoryLifecycleEvent;
  /** True when the idempotency key resolved to an event committed earlier. */
  readonly replayed: boolean;
}

export interface ExperienceLifecycleAppendResult {
  readonly event: ExperienceLifecycleEvent;
  readonly replayed: boolean;
}

export interface MemoryFeedbackAppendResult {
  readonly event: MemoryFeedbackEvent;
  readonly replayed: boolean;
}

export interface MemoryControlAppendResult {
  readonly event: MemoryControlEvent;
  readonly replayed: boolean;
}

export interface JsonlEventLedgerOptions {
  readonly primitives: EvidencePrimitives;
  readonly now?: () => Date;
  readonly idFactory?: (prefix: string) => string;
  /** Injectable only for durability-boundary tests. */
  readonly replaceDurably?: (path: string, content: string) => Promise<void>;
}

export class JsonlEventLedger {
  readonly #root: string;
  readonly #now: () => Date;
  readonly #idFactory: (prefix: string) => string;
  readonly #primitives: EvidencePrimitives;
  readonly #replaceDurably: (path: string, content: string) => Promise<void>;
  #queue: Promise<void> = Promise.resolve();
  readonly #listeners = new Set<Listener>();

  constructor(root: string, options: JsonlEventLedgerOptions) {
    this.#root = root;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? options.primitives.defaultIdFactory;
    this.#primitives = options.primitives;
    this.#replaceDurably = options.replaceDurably ?? replaceEventLedgerDurably;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  append(proposalInput: SessionEventProposal): Promise<SessionEvent> {
    const proposal = normalizeProposal(proposalInput, this.#primitives);
    return this.#serialize(async () => {
      await this.initialize();
      const events = await this.#readList(proposal.run_id);
      const staged = this.#stage(events, proposal);
      if (!staged.appended) return staged.event;
      await this.#replaceDurably(
        this.#path(proposal.run_id),
        `${[...events, staged.event].map((item) => JSON.stringify(item)).join("\n")}\n`,
      );
      this.#notify(staged.event);
      return staged.event;
    });
  }

  /**
   * Read an owner-scoped Memory aggregate stream from the canonical Evidence
   * Ledger namespace. This is separate from, and never mixed into, a Run's
   * SessionEvent sequence.
   */
  async listMemoryLifecycle(ownerIdValue: string, memoryIdValue: string): Promise<MemoryLifecycleEvent[]> {
    const ownerId = IdentifierSchema.parse(ownerIdValue);
    const memoryId = IdentifierSchema.parse(memoryIdValue);
    await this.#queue;
    return this.#readMemoryLifecycleList(ownerId, memoryId);
  }

  /** Read a separate owner-scoped Experience aggregate stream from the canonical Ledger. */
  async listExperienceLifecycle(ownerIdValue: string, caseIdValue: string): Promise<ExperienceLifecycleEvent[]> {
    const ownerId = IdentifierSchema.parse(ownerIdValue);
    const caseId = IdentifierSchema.parse(caseIdValue);
    await this.#queue;
    return this.#readExperienceLifecycleList(ownerId, caseId);
  }

  /** Persist one CAS-checked Experience lifecycle transition in its own Ledger namespace. */
  appendExperienceLifecycle(draftValue: ExperienceLifecycleEventDraft): Promise<ExperienceLifecycleAppendResult> {
    const draft = ExperienceLifecycleEventDraftSchema.parse(draftValue);
    const ownerId = IdentifierSchema.parse(draft.ownerId);
    const caseId = IdentifierSchema.parse(draft.caseId);
    return this.#serialize(async () => {
      const events = await this.#readExperienceLifecycleList(ownerId, caseId);
      const duplicate = events.find((event) => event.idempotencyKey === draft.idempotencyKey);
      if (duplicate !== undefined) {
        if (!sameExperienceLifecycleIntent(duplicate, draft)) {
          throw new EventInvariantError("Experience lifecycle idempotency key conflicts with a committed transition");
        }
        return { event: duplicate, replayed: true };
      }
      if (draft.expectedSequence !== events.length) {
        throw new EventInvariantError(`Experience lifecycle sequence conflict: expected ${draft.expectedSequence}, found ${events.length}`);
      }
      const previous = events.at(-1);
      if (draft.fromStatus !== (previous?.toStatus ?? "candidate")) {
        throw new EventInvariantError("Experience lifecycle transition does not follow the aggregate status");
      }
      if (previous !== undefined && draft.caseVersion !== previous.caseVersion) {
        throw new EventInvariantError("Experience lifecycle transition targets a different Case version");
      }
      const body = {
        schemaVersion: draft.schemaVersion,
        eventType: draft.eventType,
        eventId: this.#idFactory("experience-event"),
        ownerId,
        caseId,
        caseVersion: draft.caseVersion,
        sequence: events.length + 1,
        action: draft.action,
        fromStatus: draft.fromStatus,
        toStatus: draft.toStatus,
        actor: draft.actor,
        reasonCode: draft.reasonCode,
        idempotencyKey: draft.idempotencyKey,
        occurredAt: draft.occurredAt,
        ...(previous === undefined ? {} : { previousEventHash: previous.eventHash }),
      };
      if (events.some((event) => event.eventId === body.eventId)) {
        throw new EventInvariantError("Experience lifecycle event id factory returned a duplicate identity");
      }
      const event = ExperienceLifecycleEventSchema.parse({
        ...body,
        eventHash: this.#primitives.sha256(this.#primitives.stableStringify(body)),
      });
      const path = this.#experienceLifecyclePath(ownerId, caseId);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await this.#replaceDurably(path, `${[...events, event].map((item) => JSON.stringify(item)).join("\n")}\n`);
      return { event, replayed: false };
    });
  }

  async listMemoryControl(ownerIdValue: string, memoryIdValue: string): Promise<MemoryControlEvent[]> {
    const ownerId = IdentifierSchema.parse(ownerIdValue);
    const memoryId = IdentifierSchema.parse(memoryIdValue);
    await this.#queue;
    return this.#readMemoryControlList(ownerId, memoryId);
  }

  /** Append a content-free create/correct/delete command fact to the Memory Ledger. */
  appendMemoryControl(draftValue: MemoryControlEventDraft): Promise<MemoryControlAppendResult> {
    const draft = MemoryControlEventDraftSchema.parse(draftValue);
    const ownerId = IdentifierSchema.parse(draft.ownerId);
    const memoryId = IdentifierSchema.parse(draft.memoryId);
    return this.#serialize(async () => {
      const events = await this.#readMemoryControlList(ownerId, memoryId);
      const duplicate = events.find((event) => event.idempotencyKey === draft.idempotencyKey);
      if (duplicate !== undefined) {
        if (!sameMemoryControlIntent(duplicate, draft)) {
          throw new EventInvariantError("Memory control idempotency key conflicts with a committed command");
        }
        return { event: duplicate, replayed: true };
      }
      if (draft.expectedSequence !== events.length) {
        throw new EventInvariantError(
          `Memory control sequence conflict: expected ${draft.expectedSequence}, found ${events.length}`,
        );
      }
      if (events.some((event) => event.action === "deleted")) {
        throw new EventInvariantError("Deleted Memory identity is terminal and cannot be changed");
      }
      if (isMemoryControlCreation(draft.action)
        && events.some((event) => isMemoryControlCreation(event.action))) {
        throw new EventInvariantError("Memory identity already has a content creation fact");
      }
      const previous = events.at(-1);
      const { expectedSequence: _expectedSequence, ...draftBody } = draft;
      const body = {
        ...draftBody,
        eventId: this.#idFactory("memory-control"),
        sequence: events.length + 1,
        ...(previous === undefined ? {} : { previousEventHash: previous.eventHash }),
      };
      if (events.some((event) => event.eventId === body.eventId)) {
        throw new EventInvariantError("Memory control event id factory returned a duplicate identity");
      }
      const event = MemoryControlEventSchema.parse({
        ...body,
        eventHash: this.#primitives.sha256(this.#primitives.stableStringify(body)),
      });
      const path = this.#memoryControlPath(ownerId, memoryId);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await this.#replaceDurably(path, `${[...events, event].map((item) => JSON.stringify(item)).join("\n")}\n`);
      return { event, replayed: false };
    });
  }

  /** Read response/failed/unknown state for content-matched MemoryUse requests. */
  async listMemoryUseRequests(
    memoryIdValue: string,
    memoryVersionValue: number,
    contentDigestValue: string,
  ): Promise<MemoryUseRequestSummary[]> {
    const memoryId = IdentifierSchema.parse(memoryIdValue);
    if (!Number.isSafeInteger(memoryVersionValue) || memoryVersionValue < 1) {
      throw new TypeError("MemoryUse version must be a positive safe integer");
    }
    const contentDigest = Sha256Schema.parse(contentDigestValue);
    const files = await readdir(this.#root, { withFileTypes: true });
    const requests = new Map<string, MemoryUseRequestSummary>();
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const runId = file.name.slice(0, -".jsonl".length);
      let events: SessionEvent[];
      try {
        events = await this.list(runId);
      } catch (error) {
        // A corrupt Run stream must not be converted into apparently complete
        // Memory-use evidence. Fail the read instead of silently skipping it.
        throw error;
      }
      for (const event of events) {
        if (event.type !== "memory.use_status") continue;
        const data = MemoryUseEventDataSchema.parse(event.data);
        if (data.stage === "dispatch_intent") {
          const matching = data.memory_items.some((item) => (
            item.memory_ref.record_schema_version === "tracegraph.memory-record.v2"
            && item.memory_ref.memory_id === memoryId
            && item.memory_ref.version === memoryVersionValue
            && item.memory_ref.content_hash === contentDigest
          ));
          if (!matching) continue;
          requests.set(`${event.run_id}\u0000${data.memory_use_id}`, MemoryUseRequestSummarySchema.parse({
            runId: event.run_id,
            memoryUseId: data.memory_use_id,
            memoryVersion: memoryVersionValue,
            contextManifestId: data.manifest_id,
            stage: data.stage,
            occurredAt: event.occurred_at,
          }));
          continue;
        }
        const key = `${event.run_id}\u0000${data.memory_use_id}`;
        const prior = requests.get(key);
        if (prior === undefined) continue;
        requests.set(key, MemoryUseRequestSummarySchema.parse({
          ...prior,
          stage: data.stage,
          occurredAt: event.occurred_at,
        }));
      }
    }
    return [...requests.values()].sort((left, right) => (
      left.occurredAt.localeCompare(right.occurredAt)
      || left.runId.localeCompare(right.runId)
      || left.memoryUseId.localeCompare(right.memoryUseId)
    ));
  }

  /** Persist one CAS-checked lifecycle transition in the canonical Ledger. */
  appendMemoryLifecycle(draftValue: MemoryLifecycleEventDraft): Promise<MemoryLifecycleAppendResult> {
    const draft = MemoryLifecycleEventDraftSchema.parse(draftValue);
    const ownerId = IdentifierSchema.parse(draft.ownerId);
    const memoryId = IdentifierSchema.parse(draft.memoryId);
    return this.#serialize(async () => {
      const events = await this.#readMemoryLifecycleList(ownerId, memoryId);
      const duplicate = events.find((event) => event.idempotencyKey === draft.idempotencyKey);
      if (duplicate !== undefined) {
        if (!sameMemoryLifecycleIntent(duplicate, draft)) {
          throw new EventInvariantError("Memory lifecycle idempotency key conflicts with a committed transition");
        }
        return { event: duplicate, replayed: true };
      }
      if (draft.expectedSequence !== events.length) {
        throw new EventInvariantError(
          `Memory lifecycle sequence conflict: expected ${draft.expectedSequence}, found ${events.length}`,
        );
      }
      const previous = events.at(-1);
      if (draft.fromStatus !== (previous?.toStatus ?? "candidate")) {
        throw new EventInvariantError("Memory lifecycle transition does not follow the aggregate status");
      }
      if (previous !== undefined && draft.memoryVersion !== previous.memoryVersion) {
        throw new EventInvariantError("Memory lifecycle transition targets a different record version");
      }
      const eventId = this.#idFactory("memory-event");
      if (events.some((event) => event.eventId === eventId)) {
        throw new EventInvariantError("Memory lifecycle event id factory returned a duplicate identity");
      }
      const body = {
        schemaVersion: draft.schemaVersion,
        eventType: draft.eventType,
        eventId,
        ownerId,
        memoryId,
        memoryVersion: draft.memoryVersion,
        sequence: events.length + 1,
        action: draft.action,
        fromStatus: draft.fromStatus,
        toStatus: draft.toStatus,
        actor: draft.actor,
        reasonCode: draft.reasonCode,
        ...(draft.relatedMemoryId === undefined ? {} : { relatedMemoryId: draft.relatedMemoryId }),
        ...(draft.validUntil === undefined ? {} : { validUntil: draft.validUntil }),
        idempotencyKey: draft.idempotencyKey,
        occurredAt: draft.occurredAt,
        ...(previous === undefined ? {} : { previousEventHash: previous.eventHash }),
      };
      const event = MemoryLifecycleEventSchema.parse({
        ...body,
        eventHash: this.#primitives.sha256(this.#primitives.stableStringify(body)),
      });
      const path = this.#memoryLifecyclePath(ownerId, memoryId);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await this.#replaceDurably(
        path,
        `${[...events, event].map((item) => JSON.stringify(item)).join("\n")}\n`,
      );
      return { event, replayed: false };
    });
  }

  /** Read content-free feedback for one immutable Memory record version. */
  async listMemoryFeedback(
    ownerIdValue: string,
    memoryIdValue: string,
    memoryVersionValue: number,
  ): Promise<MemoryFeedbackEvent[]> {
    const ownerId = IdentifierSchema.parse(ownerIdValue);
    const memoryId = IdentifierSchema.parse(memoryIdValue);
    if (!Number.isSafeInteger(memoryVersionValue) || memoryVersionValue < 1) {
      throw new TypeError("Memory feedback version must be a positive safe integer");
    }
    const memoryVersion = memoryVersionValue;
    await this.#queue;
    return this.#readMemoryFeedbackList(ownerId, memoryId, memoryVersion);
  }

  /** Persist one owner-scoped, CAS-checked feedback fact in the canonical Ledger. */
  appendMemoryFeedback(draftValue: MemoryFeedbackEventDraft): Promise<MemoryFeedbackAppendResult> {
    const draft = MemoryFeedbackEventDraftSchema.parse(draftValue);
    const ownerId = IdentifierSchema.parse(draft.ownerId);
    const memoryId = IdentifierSchema.parse(draft.memoryId);
    return this.#serialize(async () => {
      const events = await this.#readMemoryFeedbackList(ownerId, memoryId, draft.memoryVersion);
      const duplicate = events.find((event) => event.idempotencyKey === draft.idempotencyKey);
      if (duplicate !== undefined) {
        if (!sameMemoryFeedbackIntent(duplicate, draft)) {
          throw new EventInvariantError("Memory feedback idempotency key conflicts with a committed fact");
        }
        return { event: duplicate, replayed: true };
      }
      if (draft.expectedSequence !== events.length) {
        throw new EventInvariantError(
          `Memory feedback sequence conflict: expected ${draft.expectedSequence}, found ${events.length}`,
        );
      }
      assertMemoryFeedbackTransition(events, draft);
      const previous = events.at(-1);
      const body = {
        schemaVersion: draft.schemaVersion,
        eventType: draft.eventType,
        eventId: this.#idFactory("memory-feedback"),
        ownerId,
        memoryId,
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
      if (events.some((event) => event.eventId === body.eventId)) {
        throw new EventInvariantError("Memory feedback event id factory returned a duplicate identity");
      }
      const event = MemoryFeedbackEventSchema.parse({
        ...body,
        eventHash: this.#primitives.sha256(this.#primitives.stableStringify(body)),
      });
      const path = this.#memoryFeedbackPath(ownerId, memoryId, draft.memoryVersion);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await this.#replaceDurably(
        path,
        `${[...events, event].map((item) => JSON.stringify(item)).join("\n")}\n`,
      );
      return { event, replayed: false };
    });
  }

  /**
   * Stage a same-Run batch plus a receipt derived from the staged Event ids,
   * then commit the complete hash-chain tail with one durable file replace.
   * No listener observes an Event until that replace succeeds.
   */
  appendAtomic(
    scope: AtomicEventScope,
    proposalInputs: readonly SessionEventProposal[],
    finalize?: (resolved: readonly SessionEvent[]) => SessionEventProposal,
  ): Promise<AtomicAppendResult> {
    const proposals = proposalInputs.map((proposal) => normalizeProposal(proposal, this.#primitives));
    if (proposals.length === 0 && finalize === undefined) {
      return Promise.reject(new EventInvariantError("atomic Event batch cannot be empty"));
    }
    assertAtomicScope(scope, proposals);
    return this.#serialize(async () => {
      await this.initialize();
      const existing = await this.#readList(scope.run_id);
      const working = [...existing];
      const resolved: SessionEvent[] = [];
      const appended: SessionEvent[] = [];
      for (const proposal of proposals) {
        const staged = this.#stage(working, proposal);
        resolved.push(staged.event);
        if (staged.appended) {
          working.push(staged.event);
          appended.push(staged.event);
        }
      }
      let receiptEvent: SessionEvent | undefined;
      if (finalize !== undefined) {
        const receiptProposal = normalizeProposal(finalize(resolved), this.#primitives);
        assertAtomicScope(scope, [receiptProposal]);
        const receipt = this.#stage(working, receiptProposal);
        if (!receipt.appended && appended.length > 0) {
          throw new EventInvariantError("an atomic receipt duplicate cannot accept new preceding Events");
        }
        if (receipt.appended) {
          working.push(receipt.event);
          appended.push(receipt.event);
        }
        receiptEvent = receipt.event;
      }
      if (appended.length > 0) {
        await this.#replaceDurably(
          this.#path(scope.run_id),
          `${working.map((item) => JSON.stringify(item)).join("\n")}\n`,
        );
        for (const event of appended) this.#notify(event);
      }
      return {
        events: receiptEvent === undefined ? resolved : [...resolved, receiptEvent],
        appended,
      };
    });
  }

  async list(runId: string): Promise<SessionEvent[]> {
    await this.#queue;
    return this.#readList(runId);
  }

  /** Query surfaces must not load an arbitrarily large or linked Run stream. */
  async listBounded(runId:string,limits:{maxBytes:number;maxEvents:number}):Promise<SessionEvent[]> {
    if(!Number.isSafeInteger(limits.maxBytes)||limits.maxBytes<1||limits.maxBytes>16_777_216||!Number.isSafeInteger(limits.maxEvents)||limits.maxEvents<1||limits.maxEvents>50_000)throw new RangeError("Invalid bounded Ledger read limits");
    await this.#queue;
    let handle;
    try{
      const path=this.#path(runId),before=await lstat(path);
      if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)throw new LedgerCorruptionError("Ledger stream is not an independent regular file");
      handle=await open(path,fsConstants.O_RDONLY|(fsConstants.O_NOFOLLOW??0));
      const metadata=await handle.stat();
      if(!metadata.isFile()||metadata.nlink!==1||metadata.dev!==before.dev||metadata.ino!==before.ino||metadata.size>limits.maxBytes)throw new LedgerCorruptionError("Ledger stream exceeds bounded query limits");
      const bytes=Buffer.alloc(limits.maxBytes+1);let offset=0;
      while(offset<bytes.length){const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}
      if(offset>limits.maxBytes)throw new LedgerCorruptionError("Ledger stream exceeds bounded query limits");
      const content=new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,offset));
      if(content.split("\n").length-1>limits.maxEvents)throw new LedgerCorruptionError("Ledger event count exceeds bounded query limits");
      return this.#parseList(content);
    }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return [];throw error;}
    finally{await handle?.close();}
  }

  /** Bounded-work callers use this inventory to recover post-settlement jobs. */
  async listRunIds(): Promise<string[]> {
    await this.#queue;
    await this.initialize();
    const entries = await readdir(this.#root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => IdentifierSchema.safeParse(entry.name.slice(0, -".jsonl".length)))
      .filter((result): result is { success: true; data: string } => result.success)
      .map(({ data }) => data)
      .sort();
  }

  /** Stream run IDs in bounded batches so startup recovery does not materialize the full inventory. */
  async *iterateRunIdBatches(batchSize = 32): AsyncGenerator<string[]> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
      throw new RangeError("Run inventory batch size must be between 1 and 1000");
    }
    await this.#queue;
    await this.initialize();
    const directory = await opendir(this.#root);
    let batch: string[] = [];
    for await (const entry of directory) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const parsed = IdentifierSchema.safeParse(entry.name.slice(0, -".jsonl".length));
      if (!parsed.success) continue;
      batch.push(parsed.data);
      if (batch.length === batchSize) {
        yield batch;
        batch = [];
      }
    }
    if (batch.length > 0) yield batch;
  }

  async #readList(runId: string): Promise<SessionEvent[]> {
    await this.initialize();
    let content: string;
    try {
      content = await readFile(this.#path(runId), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
    return this.#parseList(content);
  }

  #parseList(content:string):SessionEvent[] {
    if (content.length === 0) {
      return [];
    }
    if (!content.endsWith("\n")) {
      throw new LedgerCorruptionError("partial trailing JSONL record");
    }
    const events: SessionEvent[] = [];
    for (const line of content.split("\n").filter(Boolean)) {
      let parsed: SessionEvent;
      try {
        parsed = SessionEventSchema.parse(JSON.parse(line));
      } catch (error) {
        throw new LedgerCorruptionError("invalid event schema", { cause: error });
      }
      const { event_hash: eventHash, ...body } = parsed;
      if (this.#primitives.sha256(this.#primitives.stableStringify(body)) !== eventHash) {
        throw new LedgerCorruptionError(`event hash mismatch at sequence ${parsed.sequence}`);
      }
      const previous = events.at(-1);
      if (parsed.sequence !== (previous?.sequence ?? 0) + 1) {
        throw new LedgerCorruptionError(`non-monotonic sequence ${parsed.sequence}`);
      }
      if (previous !== undefined && parsed.previous_event_hash !== previous.event_hash) {
        throw new LedgerCorruptionError(`broken hash chain at sequence ${parsed.sequence}`);
      }
      events.push(parsed);
    }
    if (events.filter((event) => isTerminalEventType(event.type)).length > 1) {
      throw new LedgerCorruptionError("multiple terminal events");
    }
    return events;
  }

  async #readMemoryLifecycleList(ownerId: string, memoryId: string): Promise<MemoryLifecycleEvent[]> {
    await this.initialize();
    let content: string;
    try {
      content = await readFile(this.#memoryLifecyclePath(ownerId, memoryId), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    if (content.length === 0) return [];
    if (!content.endsWith("\n")) {
      throw new LedgerCorruptionError("partial trailing Memory lifecycle event");
    }
    const events: MemoryLifecycleEvent[] = [];
    for (const [index, line] of content.split("\n").filter(Boolean).entries()) {
      let event: MemoryLifecycleEvent;
      try {
        event = MemoryLifecycleEventSchema.parse(JSON.parse(line) as unknown);
      } catch (error) {
        throw new LedgerCorruptionError(`invalid Memory lifecycle event at sequence ${index + 1}`, { cause: error });
      }
      const { eventHash, ...body } = event;
      const previous = events.at(-1);
      if (event.ownerId !== ownerId || event.memoryId !== memoryId) {
        throw new LedgerCorruptionError(`Memory lifecycle aggregate identity mismatch at sequence ${index + 1}`);
      }
      if (event.sequence !== index + 1
        || event.fromStatus !== (previous?.toStatus ?? "candidate")
        || (previous !== undefined && event.memoryVersion !== previous.memoryVersion)) {
        throw new LedgerCorruptionError(`Memory lifecycle sequence/status mismatch at sequence ${index + 1}`);
      }
      if (event.previousEventHash !== previous?.eventHash) {
        throw new LedgerCorruptionError(`Memory lifecycle hash chain is broken at sequence ${event.sequence}`);
      }
      if (this.#primitives.sha256(this.#primitives.stableStringify(body)) !== eventHash) {
        throw new LedgerCorruptionError(`Memory lifecycle event hash mismatch at sequence ${event.sequence}`);
      }
      events.push(event);
    }
    return events;
  }

  async #readExperienceLifecycleList(ownerId: string, caseId: string): Promise<ExperienceLifecycleEvent[]> {
    await this.initialize();
    let content: string;
    try {
      content = await readFile(this.#experienceLifecyclePath(ownerId, caseId), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    if (content.length === 0) return [];
    if (!content.endsWith("\n")) throw new LedgerCorruptionError("partial trailing Experience lifecycle event");
    const events: ExperienceLifecycleEvent[] = [];
    for (const [index, line] of content.split("\n").filter(Boolean).entries()) {
      let event: ExperienceLifecycleEvent;
      try {
        event = ExperienceLifecycleEventSchema.parse(JSON.parse(line) as unknown);
      } catch (error) {
        throw new LedgerCorruptionError(`invalid Experience lifecycle event at sequence ${index + 1}`, { cause: error });
      }
      const { eventHash, ...body } = event;
      const previous = events.at(-1);
      if (event.ownerId !== ownerId || event.caseId !== caseId) {
        throw new LedgerCorruptionError(`Experience lifecycle aggregate identity mismatch at sequence ${index + 1}`);
      }
      if (event.sequence !== index + 1
        || event.fromStatus !== (previous?.toStatus ?? "candidate")
        || (previous !== undefined && event.caseVersion !== previous.caseVersion)) {
        throw new LedgerCorruptionError(`Experience lifecycle sequence/status mismatch at sequence ${index + 1}`);
      }
      if (event.previousEventHash !== previous?.eventHash) {
        throw new LedgerCorruptionError(`Experience lifecycle hash chain is broken at sequence ${event.sequence}`);
      }
      if (this.#primitives.sha256(this.#primitives.stableStringify(body)) !== eventHash) {
        throw new LedgerCorruptionError(`Experience lifecycle event hash mismatch at sequence ${event.sequence}`);
      }
      events.push(event);
    }
    return events;
  }

  async #readMemoryControlList(ownerId: string, memoryId: string): Promise<MemoryControlEvent[]> {
    await this.initialize();
    let content: string;
    try {
      content = await readFile(this.#memoryControlPath(ownerId, memoryId), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    if (content.length === 0) return [];
    if (!content.endsWith("\n")) throw new LedgerCorruptionError("partial trailing Memory control event");
    const events: MemoryControlEvent[] = [];
    for (const [index, line] of content.split("\n").filter(Boolean).entries()) {
      let event: MemoryControlEvent;
      try {
        event = MemoryControlEventSchema.parse(JSON.parse(line) as unknown);
      } catch (error) {
        throw new LedgerCorruptionError(`invalid Memory control event at sequence ${index + 1}`, { cause: error });
      }
      const { eventHash, ...body } = event;
      const previous = events.at(-1);
      if (event.ownerId !== ownerId || event.memoryId !== memoryId
        || event.sequence !== index + 1
        || event.previousEventHash !== previous?.eventHash
        || events.some((prior) => prior.idempotencyKey === event.idempotencyKey)
        || this.#primitives.sha256(this.#primitives.stableStringify(body)) !== eventHash) {
        throw new LedgerCorruptionError(`Memory control chain is invalid at sequence ${index + 1}`);
      }
      if (previous?.action === "deleted") throw new LedgerCorruptionError("Memory control event follows a terminal deletion");
      if (isMemoryControlCreation(event.action)
        && events.some((prior) => isMemoryControlCreation(prior.action))) {
        throw new LedgerCorruptionError("Memory control identity has multiple creation facts");
      }
      events.push(event);
    }
    return events;
  }

  async #readMemoryFeedbackList(
    ownerId: string,
    memoryId: string,
    memoryVersion: number,
  ): Promise<MemoryFeedbackEvent[]> {
    await this.initialize();
    let content: string;
    try {
      content = await readFile(this.#memoryFeedbackPath(ownerId, memoryId, memoryVersion), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    if (content.length === 0) return [];
    if (!content.endsWith("\n")) throw new LedgerCorruptionError("partial trailing Memory feedback event");
    const events: MemoryFeedbackEvent[] = [];
    for (const [index, line] of content.split("\n").filter(Boolean).entries()) {
      let event: MemoryFeedbackEvent;
      try {
        event = MemoryFeedbackEventSchema.parse(JSON.parse(line) as unknown);
      } catch (error) {
        throw new LedgerCorruptionError(`invalid Memory feedback event at sequence ${index + 1}`, { cause: error });
      }
      const { eventHash, ...body } = event;
      const previous = events.at(-1);
      if (event.ownerId !== ownerId || event.memoryId !== memoryId || event.memoryVersion !== memoryVersion) {
        throw new LedgerCorruptionError(`Memory feedback aggregate identity mismatch at sequence ${index + 1}`);
      }
      if (event.sequence !== index + 1 || event.previousEventHash !== previous?.eventHash) {
        throw new LedgerCorruptionError(`Memory feedback sequence/hash chain is broken at sequence ${index + 1}`);
      }
      if (events.some((prior) => prior.eventId === event.eventId)) {
        throw new LedgerCorruptionError(`duplicate Memory feedback event id at sequence ${index + 1}`);
      }
      if (events.some((prior) => prior.idempotencyKey === event.idempotencyKey)) {
        throw new LedgerCorruptionError(`duplicate Memory feedback idempotency key at sequence ${index + 1}`);
      }
      if (this.#primitives.sha256(this.#primitives.stableStringify(body)) !== eventHash) {
        throw new LedgerCorruptionError(`Memory feedback event hash mismatch at sequence ${index + 1}`);
      }
      try {
        assertMemoryFeedbackTransition(events, event);
      } catch (error) {
        throw new LedgerCorruptionError(`invalid Memory feedback transition at sequence ${index + 1}`, { cause: error });
      }
      events.push(event);
    }
    return events;
  }

  #stage(
    events: readonly SessionEvent[],
    proposal: SessionEventProposal,
  ): { readonly event: SessionEvent; readonly appended: boolean } {
    const duplicate = proposal.idempotency_key === undefined
      ? undefined
      : events.find((event) => event.idempotency_key === proposal.idempotency_key);
    if (duplicate !== undefined) return { event: duplicate, appended: false };
    assertAppendInvariants(events, proposal);
    const previous = events.at(-1);
    const body = {
      schema_version: SCHEMA_VERSION,
      event_id: this.#idFactory("event"),
      project_id: proposal.project_id,
      run_id: proposal.run_id,
      ...(proposal.session_id === undefined ? {} : { session_id: proposal.session_id }),
      sequence: (previous?.sequence ?? 0) + 1,
      occurred_at: this.#now().toISOString(),
      attempt: proposal.attempt,
      summary: proposal.summary,
      artifact_refs: proposal.artifact_refs,
      ...(proposal.idempotency_key === undefined ? {} : { idempotency_key: proposal.idempotency_key }),
      ...(proposal.turn_id === undefined ? {} : { turn_id: proposal.turn_id }),
      ...(proposal.operation_id === undefined ? {} : { operation_id: proposal.operation_id }),
      ...(proposal.parent_event_id === undefined ? {} : { parent_event_id: proposal.parent_event_id }),
      ...(proposal.caused_by_event_id === undefined ? {} : { caused_by_event_id: proposal.caused_by_event_id }),
      ...(proposal.context_manifest_ref === undefined ? {} : { context_manifest_ref: proposal.context_manifest_ref }),
      ...(proposal.model_call_id === undefined ? {} : { model_call_id: proposal.model_call_id }),
      ...(proposal.action_id === undefined ? {} : { action_id: proposal.action_id }),
      ...(proposal.patch_event_id === undefined ? {} : { patch_event_id: proposal.patch_event_id }),
      ...(proposal.graph_delta_id === undefined ? {} : { graph_delta_id: proposal.graph_delta_id }),
      ...(proposal.test_receipt_id === undefined ? {} : { test_receipt_id: proposal.test_receipt_id }),
      ...(previous === undefined ? {} : { previous_event_hash: previous.event_hash }),
      type: proposal.type,
      data: proposal.data,
    };
    return {
      event: SessionEventSchema.parse({
        ...body,
        event_hash: this.#primitives.sha256(this.#primitives.stableStringify(body)),
      }),
      appended: true,
    };
  }

  #notify(event: SessionEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // Subscribers are projections/transport notifications, not part of
        // the canonical commit. A faulty listener cannot roll back or make
        // an already-durable append appear to have failed.
      }
    }
  }

  #path(runId: string): string {
    return join(this.#root, `${runId.replace(/[^A-Za-z0-9_.-]/gu, "_")}.jsonl`);
  }

  #memoryLifecyclePath(ownerId: string, memoryId: string): string {
    const ownerHash = this.#primitives.sha256(ownerId).slice("sha256:".length);
    const memoryHash = this.#primitives.sha256(memoryId).slice("sha256:".length);
    return join(this.#root, "memory", ownerHash, `${memoryHash}.jsonl`);
  }

  #memoryControlPath(ownerId: string, memoryId: string): string {
    const ownerHash = this.#primitives.sha256(ownerId).slice("sha256:".length);
    const memoryHash = this.#primitives.sha256(memoryId).slice("sha256:".length);
    return join(this.#root, "memory", ownerHash, `${memoryHash}.control.jsonl`);
  }

  #memoryFeedbackPath(ownerId: string, memoryId: string, memoryVersion: number): string {
    const ownerHash = this.#primitives.sha256(ownerId).slice("sha256:".length);
    const memoryHash = this.#primitives.sha256(memoryId).slice("sha256:".length);
    return join(this.#root, "memory", ownerHash, `${memoryHash}.v${memoryVersion}.feedback.jsonl`);
  }

  #experienceLifecyclePath(ownerId: string, caseId: string): string {
    const ownerHash = this.#primitives.sha256(ownerId).slice("sha256:".length);
    const caseHash = this.#primitives.sha256(caseId).slice("sha256:".length);
    return join(this.#root, "experience", ownerHash, `${caseHash}.jsonl`);
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function sameMemoryLifecycleIntent(
  event: MemoryLifecycleEvent,
  draft: MemoryLifecycleEventDraft,
): boolean {
  return event.ownerId === draft.ownerId
    && event.memoryId === draft.memoryId
    && event.memoryVersion === draft.memoryVersion
    && event.action === draft.action
    && event.fromStatus === draft.fromStatus
    && event.toStatus === draft.toStatus
    && event.actor.type === draft.actor.type
    && event.actor.id === draft.actor.id
    && event.reasonCode === draft.reasonCode
    && event.relatedMemoryId === draft.relatedMemoryId
    && event.validUntil === draft.validUntil;
}

function sameExperienceLifecycleIntent(
  event: ExperienceLifecycleEvent,
  draft: ExperienceLifecycleEventDraft,
): boolean {
  return event.ownerId === draft.ownerId
    && event.caseId === draft.caseId
    && event.caseVersion === draft.caseVersion
    && event.action === draft.action
    && event.fromStatus === draft.fromStatus
    && event.toStatus === draft.toStatus
    && event.actor.type === draft.actor.type
    && event.actor.id === draft.actor.id
    && event.reasonCode === draft.reasonCode;
}

function sameMemoryControlIntent(
  event: MemoryControlEvent,
  draft: MemoryControlEventDraft,
): boolean {
  if (event.ownerId !== draft.ownerId
    || event.memoryId !== draft.memoryId
    || event.memoryVersion !== draft.memoryVersion
    || event.action !== draft.action
    || event.actor.type !== draft.actor.type
    || event.actor.id !== draft.actor.id) return false;
  if (event.action === "candidate_created" && draft.action === "candidate_created") {
    return event.contentDigest === draft.contentDigest;
  }
  if (event.action === "derived_candidate_created" && draft.action === "derived_candidate_created") {
    return event.contentDigest === draft.contentDigest
      && event.episodeId === draft.episodeId
      && event.sourceDigest === draft.sourceDigest;
  }
  if (event.action === "corrected" && draft.action === "corrected") {
    return event.contentDigest === draft.contentDigest
      && event.relatedMemoryId === draft.relatedMemoryId;
  }
  return event.action === "deleted" && draft.action === "deleted"
    && event.deletedMemoryIds.length === draft.deletedMemoryIds.length
    && event.deletedMemoryIds.every((memoryId) => draft.deletedMemoryIds.includes(memoryId))
    && event.deletedScopeIds.length === draft.deletedScopeIds.length
    && event.deletedScopeIds.every((scopeId) => draft.deletedScopeIds.includes(scopeId));
}

function isMemoryControlCreation(action: MemoryControlEvent["action"] | MemoryControlEventDraft["action"]): boolean {
  return action === "candidate_created" || action === "derived_candidate_created" || action === "corrected";
}

function sameMemoryFeedbackIntent(
  event: MemoryFeedbackEvent,
  draft: MemoryFeedbackEventDraft,
): boolean {
  if (event.ownerId !== draft.ownerId
    || event.memoryId !== draft.memoryId
    || event.memoryVersion !== draft.memoryVersion
    || event.action !== draft.action
    || event.actor.type !== draft.actor.type
    || event.actor.id !== draft.actor.id) return false;
  return event.action === "reported" && draft.action === "reported"
    ? event.runId === draft.runId
      && event.memoryUseId === draft.memoryUseId
      && event.contextManifestId === draft.contextManifestId
      && event.feedback === draft.feedback
    : event.action === "review_dismissed" && draft.action === "review_dismissed"
      && event.feedbackEventId === draft.feedbackEventId;
}

function assertMemoryFeedbackTransition(
  events: readonly MemoryFeedbackEvent[],
  next: MemoryFeedbackEventDraft | MemoryFeedbackEvent,
): void {
  if (next.action === "reported") {
    if (events.some((event) => event.action === "reported"
      && event.runId === next.runId
      && event.memoryUseId === next.memoryUseId
      && event.actor.id === next.actor.id)) {
      throw new EventInvariantError("A user can report feedback only once for a given MemoryUse and version");
    }
    return;
  }
  const target = events.find((event) => event.eventId === next.feedbackEventId);
  if (target?.action !== "reported" || (target.feedback !== "incorrect" && target.feedback !== "stale")) {
    throw new EventInvariantError("Only an unresolved incorrect/stale Memory feedback can be dismissed");
  }
  if (events.some((event) => event.action === "review_dismissed" && event.feedbackEventId === target.eventId)) {
    throw new EventInvariantError("Memory feedback review was already dismissed");
  }
}

function normalizeProposal(
  proposalInput: SessionEventProposal,
  primitives: EvidencePrimitives,
): SessionEventProposal {
  const parsed = SessionEventProposalSchema.parse(proposalInput);
  // The ledger is the final persistence boundary. Runtime callers already
  // redact their public facts, but enforcing it here also protects startup
  // and maintenance events that do not pass through AgentRuntime.
  return SessionEventProposalSchema.parse({
    ...parsed,
    summary: primitives.redactSensitiveText(parsed.summary),
    data: primitives.redactStructuredArtifactValue(parsed.data),
  });
}

function assertAtomicScope(scope: AtomicEventScope, proposals: readonly SessionEventProposal[]): void {
  for (const proposal of proposals) {
    if (
      proposal.project_id !== scope.project_id
      || proposal.run_id !== scope.run_id
      || proposal.session_id !== scope.session_id
    ) {
      throw new EventInvariantError("atomic Event batch must remain in one project, Run, and Session scope");
    }
  }
}

function assertAppendInvariants(
  events: readonly SessionEvent[],
  proposal: SessionEventProposal,
): void {
  if (isTerminalEventType(proposal.type) && hasIncompleteHeartbeatSweep(events)) {
    throw new EventInvariantError(
      `run ${proposal.run_id} has an incomplete heartbeat sweep that must be repaired before terminal`,
    );
  }
  const terminal = events.find((event) => isTerminalEventType(event.type));
  if (terminal !== undefined && isTerminalEventType(proposal.type)) {
    throw new EventInvariantError(`run ${proposal.run_id} cannot have more than one terminal event`);
  }
  // Session metadata remains mutable after a Run has ended: users may rename
  // or trash a session later, and maintenance may add bounded reconciliation
  // facts. Ordinary Run/team work stays closed after terminal.
  if (
    terminal !== undefined
    && proposal.type !== "action.late_ignored"
    && proposal.type !== "action.reconciled"
    && proposal.type !== "action.diverged"
    && proposal.type !== "action.rollback_refused"
    && proposal.type !== "action.verified"
    && proposal.type !== "patch.rolled_back"
    && proposal.type !== "extension.error"
    && !proposal.type.startsWith("session.")
  ) {
    throw new EventInvariantError(`run ${proposal.run_id} already has terminal event ${terminal.type}`);
  }
  if (proposal.type === "extension.error") {
    const data = ExtensionErrorDataSchema.parse(proposal.data);
    const source = events.find((event) => event.event_id === data.source_event_id);
    if (source === undefined || source.type !== data.source_event_type) {
      throw new EventInvariantError("extension.error must reference an existing non-extension Event in the same Run");
    }
  }
}

function hasIncompleteHeartbeatSweep(events: readonly SessionEvent[]): boolean {
  const referenced = new Set<string>();
  for (const event of events) {
    if (event.type !== "team.sweep_completed") continue;
    const parsed = TeamSweepCompletedDataSchema.safeParse(event.data);
    if (!parsed.success) continue;
    for (const eventId of parsed.data.member_lost_event_ids) referenced.add(eventId);
  }
  return events.some((event) => {
    if (event.type !== "team.member_lost" || referenced.has(event.event_id)) return false;
    const parsed = TeamMemberLostDataSchema.safeParse(event.data);
    return parsed.success && parsed.data.reason === "heartbeat_timeout";
  });
}

async function replaceEventLedgerDurably(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  const temporary = resolve(
    directory,
    `.${basename(path)}.tracegraph-${process.pid}-${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(content, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class EventInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventInvariantError";
  }
}

export class LedgerCorruptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LedgerCorruptionError";
  }
}
