import {
  MemoryLifecycleCommandSchema,
  MemoryLifecycleEventDraftSchema,
  MemoryLifecycleEventSchema,
  MemoryRecordV2Schema,
  MEMORY_LIFECYCLE_TRANSITIONS,
  type MemoryLifecycleAction,
  type MemoryLifecycleCommand,
  type MemoryLifecycleEvent,
  type MemoryLifecycleEventDraft,
  type MemoryRecordV2,
  type MemoryStatusV2,
} from "@tracegraph/contracts";
import { sha256, stableStringify } from "../../kernel/crypto.js";

export type MemoryLifecycleErrorCode =
  | "memory_lifecycle_invalid_record"
  | "memory_lifecycle_invalid_command"
  | "memory_lifecycle_invalid_transition"
  | "memory_lifecycle_version_conflict"
  | "memory_lifecycle_identity_conflict"
  | "memory_lifecycle_idempotency_conflict"
  | "memory_lifecycle_corrupt";

export class MemoryLifecycleError extends Error {
  readonly code: MemoryLifecycleErrorCode;

  constructor(code: MemoryLifecycleErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MemoryLifecycleError";
    this.code = code;
  }
}

export interface MemoryLifecycleJournal {
  listMemoryLifecycle(ownerId: string, memoryId: string): Promise<readonly MemoryLifecycleEvent[]>;
  appendMemoryLifecycle(draft: MemoryLifecycleEventDraft): Promise<{ event: MemoryLifecycleEvent; replayed: boolean }>;
}

export interface MemoryLifecycleTransitionResult {
  readonly record: MemoryRecordV2;
  readonly event: MemoryLifecycleEvent;
  readonly replayed: boolean;
}

export class MemoryLifecycleService {
  readonly #journal: MemoryLifecycleJournal;
  readonly #now: () => Date;

  constructor(options: {
    journal: MemoryLifecycleJournal;
    now?: () => Date;
  }) {
    this.#journal = options.journal;
    this.#now = options.now ?? (() => new Date());
  }

  async read(seedRecordValue: unknown): Promise<{ record: MemoryRecordV2; sequence: number }> {
    const seedRecord = parseLifecycleSeed(seedRecordValue);
    const events = await this.#journal.listMemoryLifecycle(seedRecord.scope.ownerId, seedRecord.memoryId);
    return { record: replayMemoryLifecycle(seedRecord, events), sequence: events.length };
  }

  async transition(seedRecordValue: unknown, commandValue: unknown): Promise<MemoryLifecycleTransitionResult> {
    const seedRecord = parseLifecycleSeed(seedRecordValue);
    let command: MemoryLifecycleCommand;
    try {
      command = MemoryLifecycleCommandSchema.parse(commandValue);
    } catch (error) {
      throw new MemoryLifecycleError("memory_lifecycle_invalid_command", "Memory lifecycle command is invalid", { cause: error });
    }
    if (command.ownerId !== seedRecord.scope.ownerId || command.memoryId !== seedRecord.memoryId) {
      throw new MemoryLifecycleError("memory_lifecycle_identity_conflict", "Lifecycle command does not match the Memory owner and identity");
    }
    if (command.memoryVersion !== seedRecord.version) {
      throw new MemoryLifecycleError("memory_lifecycle_version_conflict", "Lifecycle command targets a different Memory record version");
    }

    const events = await this.#journal.listMemoryLifecycle(command.ownerId, command.memoryId);
    const current = replayMemoryLifecycle(seedRecord, events);
    const duplicate = events.find((event) => event.idempotencyKey === command.idempotencyKey);
    if (duplicate !== undefined) {
      if (!sameCommandIntent(duplicate, command)) {
        throw new MemoryLifecycleError(
          "memory_lifecycle_idempotency_conflict",
          `Idempotency key ${command.idempotencyKey} was already used for a different lifecycle transition`,
        );
      }
      return { record: current, event: duplicate, replayed: true };
    }
    if (command.expectedSequence !== events.length) {
      throw new MemoryLifecycleError(
        "memory_lifecycle_version_conflict",
        `Expected lifecycle sequence ${command.expectedSequence}, found ${events.length}`,
      );
    }

    const transitionAt = this.#now();
    const toStatus = planTransition(current, command, transitionAt);
    const draft = MemoryLifecycleEventDraftSchema.parse({
      schemaVersion: "tracegraph.memory-lifecycle-event.v1",
      eventType: "memory.lifecycle.transitioned",
      ownerId: command.ownerId,
      memoryId: command.memoryId,
      memoryVersion: command.memoryVersion,
      expectedSequence: command.expectedSequence,
      action: command.action,
      fromStatus: current.status,
      toStatus,
      actor: command.actor,
      reasonCode: command.reasonCode,
      ...(command.relatedMemoryId === undefined ? {} : { relatedMemoryId: command.relatedMemoryId }),
      ...(command.validUntil === undefined ? {} : { validUntil: command.validUntil }),
      idempotencyKey: command.idempotencyKey,
      occurredAt: transitionAt.toISOString(),
    });
    const appended = await this.#journal.appendMemoryLifecycle(draft);
    const event = appended.event;
    const updatedRecord = replayMemoryLifecycle(seedRecord, [...events, event]);
    return { record: updatedRecord, event, replayed: appended.replayed };
  }
}

/** Rebuilds the status projection from an immutable candidate seed and events. */
export function replayMemoryLifecycle(
  seedRecordValue: unknown,
  eventValues: readonly unknown[],
): MemoryRecordV2 {
  let record = parseLifecycleSeed(seedRecordValue);
  const events = eventValues.map((value, index) => {
    try {
      return MemoryLifecycleEventSchema.parse(value);
    } catch (error) {
      throw new MemoryLifecycleError("memory_lifecycle_corrupt", `Memory lifecycle event ${index + 1} is invalid`, { cause: error });
    }
  });

  let previousHash: string | undefined;
  for (const [index, event] of events.entries()) {
    const { eventHash, ...body } = event;
    if (event.sequence !== index + 1
      || event.ownerId !== record.scope.ownerId
      || event.memoryId !== record.memoryId
      || event.memoryVersion !== record.version
      || event.previousEventHash !== previousHash
      || sha256(stableStringify(body)) !== eventHash) {
      throw new MemoryLifecycleError("memory_lifecycle_corrupt", `Memory lifecycle event ${index + 1} does not match its seed or hash chain`);
    }
    if (event.fromStatus !== record.status) {
      throw new MemoryLifecycleError("memory_lifecycle_corrupt", `Memory lifecycle event ${index + 1} does not follow the prior status`);
    }
    const command = commandFromEvent(event);
    const toStatus = planTransition(record, command, new Date(event.occurredAt));
    if (toStatus !== event.toStatus) {
      throw new MemoryLifecycleError("memory_lifecycle_corrupt", `Memory lifecycle event ${index + 1} has an invalid target status`);
    }
    record = nextRecord(record, event);
    previousHash = event.eventHash;
  }
  return record;
}

function planTransition(record: MemoryRecordV2, command: MemoryLifecycleCommand, now: Date): MemoryStatusV2 {
  const transition = MEMORY_LIFECYCLE_TRANSITIONS[command.action];
  if (!transition.from.includes(record.status)) {
    throw new MemoryLifecycleError(
      "memory_lifecycle_invalid_transition",
      `Cannot apply ${command.action} while Memory status is ${record.status}`,
    );
  }
  if (command.action === "review_activate" || command.action === "resolve_active") {
    assertCanActivate(record, now);
  }
  if ((command.action === "supersede" || command.action === "resolve_superseded")
    && command.relatedMemoryId === record.memoryId) {
    throw new MemoryLifecycleError("memory_lifecycle_invalid_transition", "A Memory cannot supersede itself");
  }
  if (command.action === "revalidate") {
    if (command.validUntil === undefined || Date.parse(command.validUntil) <= now.getTime()) {
      throw new MemoryLifecycleError("memory_lifecycle_invalid_transition", "Revalidation requires a validity end after the transition time");
    }
  } else if (command.validUntil !== undefined) {
    throw new MemoryLifecycleError("memory_lifecycle_invalid_transition", "Only revalidation can change the validity end");
  }
  if (command.action === "expire" && command.reasonCode === "retention_elapsed") {
    if (record.validity.validUntil === undefined || Date.parse(record.validity.validUntil) > now.getTime()) {
      throw new MemoryLifecycleError("memory_lifecycle_invalid_transition", "Retention expiry requires an elapsed validUntil timestamp");
    }
  }
  return transition.to;
}

function assertCanActivate(record: MemoryRecordV2, now: Date): void {
  if (record.kind === "legacy_unclassified"
    || record.governance.consent === "none"
    || record.governance.sensitivity === "secret"
    || record.governance.sensitivity === "unknown") {
    throw new MemoryLifecycleError(
      "memory_lifecycle_invalid_transition",
      "Memory requires user-reviewed classification, consent, and governance before activation",
    );
  }
  if (Date.parse(record.validity.validFrom) > now.getTime()
    || (record.validity.validUntil !== undefined && Date.parse(record.validity.validUntil) <= now.getTime())) {
    throw new MemoryLifecycleError("memory_lifecycle_invalid_transition", "Memory is outside its valid time interval");
  }
}

function nextRecord(record: MemoryRecordV2, event: MemoryLifecycleEvent): MemoryRecordV2 {
  const updated = {
    ...record,
    status: event.toStatus,
    updatedAt: event.occurredAt,
    ...(event.action === "revalidate"
      ? {
        validity: {
          ...record.validity,
          validFrom: event.occurredAt,
          validUntil: event.validUntil!,
        },
      }
      : {}),
  };
  try {
    return MemoryRecordV2Schema.parse(updated);
  } catch (error) {
    throw new MemoryLifecycleError("memory_lifecycle_invalid_transition", "Lifecycle transition violates the Memory V2 record contract", { cause: error });
  }
}

function parseLifecycleSeed(value: unknown): MemoryRecordV2 {
  let record: MemoryRecordV2;
  try {
    record = MemoryRecordV2Schema.parse(value);
  } catch (error) {
    throw new MemoryLifecycleError("memory_lifecycle_invalid_record", "Memory lifecycle requires a valid V2 seed record", { cause: error });
  }
  if (record.status !== "candidate") {
    throw new MemoryLifecycleError("memory_lifecycle_invalid_record", "Memory lifecycle seed must be the immutable candidate record");
  }
  return record;
}

function commandFromEvent(event: MemoryLifecycleEvent): MemoryLifecycleCommand {
  return {
    ownerId: event.ownerId,
    memoryId: event.memoryId,
    memoryVersion: event.memoryVersion,
    expectedSequence: event.sequence - 1,
    action: event.action,
    actor: event.actor,
    reasonCode: event.reasonCode,
    ...(event.relatedMemoryId === undefined ? {} : { relatedMemoryId: event.relatedMemoryId }),
    ...(event.validUntil === undefined ? {} : { validUntil: event.validUntil }),
    idempotencyKey: event.idempotencyKey,
  };
}

function sameCommandIntent(event: MemoryLifecycleEvent, command: MemoryLifecycleCommand): boolean {
  return event.ownerId === command.ownerId
    && event.memoryId === command.memoryId
    && event.memoryVersion === command.memoryVersion
    && event.action === command.action
    && event.actor.type === command.actor.type
    && event.actor.id === command.actor.id
    && event.reasonCode === command.reasonCode
    && event.relatedMemoryId === command.relatedMemoryId
    && event.validUntil === command.validUntil;
}
