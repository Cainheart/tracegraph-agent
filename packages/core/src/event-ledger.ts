import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  SCHEMA_VERSION,
  SessionEventProposalSchema,
  SessionEventSchema,
  ExtensionErrorDataSchema,
  TeamMemberLostDataSchema,
  TeamSweepCompletedDataSchema,
  isTerminalEventType,
  type SessionEvent,
  type SessionEventProposal,
} from "@tracegraph/contracts";
import {
  defaultIdFactory,
  redactSensitiveText,
  redactStructuredArtifactValue,
  sha256,
  stableStringify,
} from "./crypto.js";

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

interface JsonlEventLedgerOptions {
  readonly now?: () => Date;
  readonly idFactory?: (prefix: string) => string;
  /** Injectable only for durability-boundary tests. */
  readonly replaceDurably?: (path: string, content: string) => Promise<void>;
}

export class JsonlEventLedger {
  readonly #root: string;
  readonly #now: () => Date;
  readonly #idFactory: (prefix: string) => string;
  readonly #replaceDurably: (path: string, content: string) => Promise<void>;
  #queue: Promise<void> = Promise.resolve();
  readonly #listeners = new Set<Listener>();

  constructor(root: string, options: JsonlEventLedgerOptions = {}) {
    this.#root = root;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? defaultIdFactory;
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
    const proposal = normalizeProposal(proposalInput);
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
   * Stage a same-Run batch plus a receipt derived from the staged Event ids,
   * then commit the complete hash-chain tail with one durable file replace.
   * No listener observes an Event until that replace succeeds.
   */
  appendAtomic(
    scope: AtomicEventScope,
    proposalInputs: readonly SessionEventProposal[],
    finalize?: (resolved: readonly SessionEvent[]) => SessionEventProposal,
  ): Promise<AtomicAppendResult> {
    const proposals = proposalInputs.map(normalizeProposal);
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
        const receiptProposal = normalizeProposal(finalize(resolved));
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
      if (sha256(stableStringify(body)) !== eventHash) {
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
      event: SessionEventSchema.parse({ ...body, event_hash: sha256(stableStringify(body)) }),
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

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function normalizeProposal(proposalInput: SessionEventProposal): SessionEventProposal {
  const parsed = SessionEventProposalSchema.parse(proposalInput);
  // The ledger is the final persistence boundary. Runtime callers already
  // redact their public facts, but enforcing it here also protects startup
  // and maintenance events that do not pass through AgentRuntime.
  return SessionEventProposalSchema.parse({
    ...parsed,
    summary: redactSensitiveText(parsed.summary),
    data: redactStructuredArtifactValue(parsed.data),
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
