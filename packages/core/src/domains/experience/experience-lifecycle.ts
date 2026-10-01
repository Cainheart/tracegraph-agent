import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ExperienceCaseSchema,
  ExperienceLifecycleEventDraftSchema,
  ExperienceLifecycleEventSchema,
  EXPERIENCE_LIFECYCLE_TRANSITIONS,
  IdentifierSchema,
  RetrievedExperienceHitSchema,
  type ExperienceCase,
  type ExperienceLifecycleAction,
  type ExperienceLifecycleEvent,
  type ExperienceLifecycleEventDraft,
  type RetrievedExperienceHit,
} from "@tracegraph/contracts";
import { estimateTokens } from "@tracegraph/context";
import { sha256, stableStringify } from "../../kernel/crypto.js";

export type ExperienceLifecycleJournal = {
  listExperienceLifecycle(ownerId: string, caseId: string): Promise<readonly ExperienceLifecycleEvent[]>;
  appendExperienceLifecycle(draft: ExperienceLifecycleEventDraft): Promise<{ event: ExperienceLifecycleEvent; replayed: boolean }>;
};

export interface ExperienceCaseStore {
  initialize(): Promise<void>;
  list(ownerId: string): Promise<readonly ExperienceCase[]>;
  writeCandidate(ownerId: string, value: ExperienceCase): Promise<void>;
}

export class JsonlExperienceCaseStore implements ExperienceCaseStore {
  readonly #root: string;

  constructor(root: string) { this.#root = root; }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
  }

  async list(ownerValue: string): Promise<ExperienceCase[]> {
    const ownerId = IdentifierSchema.parse(ownerValue);
    let content: string;
    try {
      content = await readFile(this.#path(ownerId), "utf8");
    } catch (error) {
      if (hasCode(error, "ENOENT")) return [];
      throw error;
    }
    if (content.length === 0) return [];
    if (!content.endsWith("\n")) throw new ExperienceLifecycleError("experience_corrupt", "Experience seed file has a partial final row");
    const result: ExperienceCase[] = [];
    const seen = new Set<string>();
    for (const [index, line] of content.split("\n").filter(Boolean).entries()) {
      let item: ExperienceCase;
      try { item = ExperienceCaseSchema.parse(JSON.parse(line) as unknown); }
      catch (error) { throw new ExperienceLifecycleError("experience_corrupt", `Experience seed ${index + 1} is invalid`, { cause: error }); }
      if (item.status !== "candidate") throw new ExperienceLifecycleError("experience_corrupt", "Experience seed status must remain candidate");
      if (seen.has(item.caseId)) throw new ExperienceLifecycleError("experience_corrupt", "Experience store has a duplicate Case id");
      seen.add(item.caseId);
      result.push(item);
    }
    return result;
  }

  async writeCandidate(ownerValue: string, value: ExperienceCase): Promise<void> {
    const ownerId = IdentifierSchema.parse(ownerValue);
    const candidate = ExperienceCaseSchema.parse(value);
    if (candidate.status !== "candidate") throw new ExperienceLifecycleError("experience_invalid", "Only candidate Experience seeds can be persisted");
    const existing = await this.list(ownerId);
    const prior = existing.find((item) => item.caseId === candidate.caseId);
    if (prior !== undefined) {
      if (stableStringify(prior) === stableStringify(candidate)) return;
      throw new ExperienceLifecycleError("experience_conflict", "Experience Case identity already has a different immutable seed");
    }
    await this.#replace(ownerId, [...existing, candidate]);
  }

  #path(ownerId: string): string {
    return join(this.#root, sha256(ownerId).slice(7), "cases.jsonl");
  }

  async #replace(ownerId: string, records: readonly ExperienceCase[]): Promise<void> {
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

export type ExperienceLifecycleErrorCode =
  | "experience_not_found"
  | "experience_scope_denied"
  | "experience_conflict"
  | "experience_invalid"
  | "experience_corrupt";

export class ExperienceLifecycleError extends Error {
  readonly code: ExperienceLifecycleErrorCode;
  constructor(code: ExperienceLifecycleErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExperienceLifecycleError";
    this.code = code;
  }
}

export interface ExperienceScope {
  readonly allowedScopeIds: readonly string[];
}

export interface ExperienceTaskFacts {
  readonly task: string;
  readonly facts: Readonly<Record<string, string | number | boolean>>;
}

export class ExperienceCaseService {
  readonly #ownerId: string;
  readonly #actorId: string;
  readonly #store: ExperienceCaseStore;
  readonly #journal: ExperienceLifecycleJournal;
  readonly #now: () => Date;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: {
    ownerId: string;
    actorId: string;
    store: ExperienceCaseStore;
    journal: ExperienceLifecycleJournal;
    now?: () => Date;
  }) {
    this.#ownerId = IdentifierSchema.parse(options.ownerId);
    this.#actorId = IdentifierSchema.parse(options.actorId);
    this.#store = options.store;
    this.#journal = options.journal;
    this.#now = options.now ?? (() => new Date());
  }

  async list(scope: ExperienceScope): Promise<Array<{ case: ExperienceCase; lifecycleSequence: number }>> {
    const seeds = await this.#store.list(this.#ownerId);
    const cases: Array<{ case: ExperienceCase; lifecycleSequence: number }> = [];
    for (const seed of seeds) {
      if (!scope.allowedScopeIds.includes(seed.projectId)) continue;
      const events = await this.#journal.listExperienceLifecycle(this.#ownerId, seed.caseId);
      cases.push({ case: replayExperienceLifecycle(seed, events, this.#ownerId), lifecycleSequence: events.length });
    }
    return cases.sort((left, right) => left.case.caseId.localeCompare(right.case.caseId));
  }

  createCandidate(value: unknown, scope: ExperienceScope): Promise<ExperienceCase> {
    return this.#serialize(async () => {
      const candidate = ExperienceCaseSchema.parse(value);
      if (candidate.status !== "candidate") throw new ExperienceLifecycleError("experience_invalid", "Experience candidate must begin in candidate status");
      if (!scope.allowedScopeIds.includes(candidate.projectId)) throw new ExperienceLifecycleError("experience_not_found", "Project is outside the caller's visible scope");
      await this.#store.writeCandidate(this.#ownerId, candidate);
      return candidate;
    });
  }

  review(caseIdValue: string, input: {
    readonly action: ExperienceLifecycleAction;
    readonly expectedSequence: number;
    readonly commandId: string;
  }, scope: ExperienceScope): Promise<{ case: ExperienceCase; lifecycleSequence: number; replayed: boolean }> {
    return this.#serialize(async () => {
      const caseId = IdentifierSchema.parse(caseIdValue);
      const seed = (await this.#store.list(this.#ownerId)).find((item) => item.caseId === caseId);
      if (seed === undefined) throw new ExperienceLifecycleError("experience_not_found", "Experience Case was not found");
      if (!scope.allowedScopeIds.includes(seed.projectId)) throw new ExperienceLifecycleError("experience_not_found", "Experience Case was not found");
      const events = await this.#journal.listExperienceLifecycle(this.#ownerId, caseId);
      const duplicate = events.find((event) => event.idempotencyKey === input.commandId);
      const current = replayExperienceLifecycle(seed, events, this.#ownerId);
      if (duplicate !== undefined) {
        if (duplicate.action !== input.action || duplicate.actor.id !== this.#actorId) {
          throw new ExperienceLifecycleError("experience_conflict", "Experience review idempotency key was reused for a different command");
        }
        return { case: current, lifecycleSequence: events.length, replayed: true };
      }
      if (!Number.isSafeInteger(input.expectedSequence) || input.expectedSequence !== events.length) {
        throw new ExperienceLifecycleError("experience_conflict", `Expected Experience lifecycle sequence ${input.expectedSequence}, found ${events.length}`);
      }
      const edge = EXPERIENCE_LIFECYCLE_TRANSITIONS[input.action];
      if (!edge.from.includes(current.status)) {
        throw new ExperienceLifecycleError("experience_conflict", `Cannot apply ${input.action} to ${current.status} Experience`);
      }
      const reasonByAction: Record<ExperienceLifecycleAction, string> = {
        validate: "review_accepted",
        reject: "review_rejected",
        dispute: "user_challenge",
        resolve: "resolution_confirmed",
        retire: "user_requested_retirement",
      };
      const draft = ExperienceLifecycleEventDraftSchema.parse({
        schemaVersion: "tracegraph.experience-lifecycle-event.v1",
        eventType: "experience.lifecycle.transitioned",
        ownerId: this.#ownerId,
        caseId,
        caseVersion: seed.version,
        expectedSequence: input.expectedSequence,
        action: input.action,
        fromStatus: current.status,
        toStatus: edge.to,
        actor: { type: "user", id: this.#actorId },
        reasonCode: reasonByAction[input.action],
        idempotencyKey: IdentifierSchema.parse(input.commandId),
        occurredAt: this.#now().toISOString(),
      });
      const appended = await this.#journal.appendExperienceLifecycle(draft);
      return {
        case: replayExperienceLifecycle(seed, [...events, appended.event], this.#ownerId),
        lifecycleSequence: events.length + (appended.replayed ? 0 : 1),
        replayed: appended.replayed,
      };
    });
  }

  async recall(input: {
    readonly projectId: string;
    readonly query: ExperienceTaskFacts;
    readonly maxHits: number;
    readonly maxTokens: number;
  }): Promise<RetrievedExperienceHit[]> {
    const task = input.query.task.slice(0, 8_000);
    const factText = Object.entries(input.query.facts).map(([key, value]) => `${key}=${String(value)}`).join(" ");
    const searchable = normalize(`${task} ${factText}`);
    const queryTerms = words(searchable);
    if (queryTerms.size === 0) return [];
    const candidates = (await this.list({ allowedScopeIds: [IdentifierSchema.parse(input.projectId)] }))
      .filter(({ case: item }) => item.status === "validated")
      .filter(({ case: item }) => item.projectId === input.projectId)
      .filter(({ case: item }) => item.applicability.every((rule) => conditionMatches(rule, input.query.facts)))
      .filter(({ case: item }) => !item.counterexamples.some((example) => (
        example.condition.length >= 8 && searchable.includes(normalize(example.condition))
      )))
      .map(({ case: item }) => ({ item, score: overlap(queryTerms, words(normalize(experienceSearchText(item)))) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || left.item.caseId.localeCompare(right.item.caseId));
    const hits: RetrievedExperienceHit[] = [];
    let tokens = 0;
    for (const { item, score } of candidates) {
      if (hits.length >= input.maxHits) break;
      const content = renderExperienceSuggestion(item);
      const injectedTokens = Math.max(1, estimateTokens(content));
      if (tokens + injectedTokens > input.maxTokens) continue;
      tokens += injectedTokens;
      const sourcePath = `experience/${encodeURIComponent(item.caseId)}.md`;
      hits.push(RetrievedExperienceHitSchema.parse({
        content,
        attribution: {
          rank: hits.length + 1,
          hitId: `experience-hit:${sha256(`${item.caseId}:${item.version}`).slice(7, 39)}`,
          caseId: item.caseId,
          caseVersion: item.version,
          contentHash: sha256(stableStringify(item)),
          score,
          sourcePath,
          evidenceRefs: item.evidenceRefs,
          injectedTokens,
        },
      }));
    }
    return hits;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function replayExperienceLifecycle(
  seedValue: unknown,
  eventValues: readonly unknown[],
  ownerValue?: string,
): ExperienceCase {
  let current = ExperienceCaseSchema.parse(seedValue);
  if (current.status !== "candidate") throw new ExperienceLifecycleError("experience_corrupt", "Experience seed must start in candidate status");
  const events = eventValues.map((value, index) => {
    try { return ExperienceLifecycleEventSchema.parse(value); }
    catch (error) { throw new ExperienceLifecycleError("experience_corrupt", `Experience lifecycle event ${index + 1} is invalid`, { cause: error }); }
  });
  const expectedOwnerId = ownerValue === undefined
    ? events[0]?.ownerId
    : IdentifierSchema.parse(ownerValue);
  let previousHash: string | undefined;
  for (const [index, event] of events.entries()) {
    const { eventHash, ...body } = event;
    const edge = EXPERIENCE_LIFECYCLE_TRANSITIONS[event.action];
    if ((expectedOwnerId !== undefined && event.ownerId !== expectedOwnerId)
      || event.caseId !== current.caseId
      || event.caseVersion !== current.version
      || event.sequence !== index + 1
      || event.previousEventHash !== previousHash
      || event.fromStatus !== current.status
      || !edge.from.includes(current.status)
      || edge.to !== event.toStatus
      || sha256(stableStringify(body)) !== eventHash) {
      throw new ExperienceLifecycleError("experience_corrupt", `Experience lifecycle event ${index + 1} does not match its seed or hash chain`);
    }
    current = ExperienceCaseSchema.parse({ ...current, status: event.toStatus });
    previousHash = event.eventHash;
  }
  return current;
}

function conditionMatches(
  condition: ExperienceCase["applicability"][number],
  facts: Readonly<Record<string, string | number | boolean>>,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(facts, condition.dimension)) return false;
  const actual = facts[condition.dimension];
  if (actual === undefined) return false;
  if (condition.operator === "equals") return normalize(String(actual)) === normalize(condition.value);
  if (condition.operator === "not_equals") return normalize(String(actual)) !== normalize(condition.value);
  if (condition.operator === "contains") return normalize(String(actual)).includes(normalize(condition.value));
  const actualNumber = Number(actual);
  const expectedNumber = Number(condition.value);
  if (!Number.isFinite(actualNumber) || !Number.isFinite(expectedNumber)) return false;
  return condition.operator === "at_least" ? actualNumber >= expectedNumber : actualNumber <= expectedNumber;
}

function renderExperienceSuggestion(item: ExperienceCase): string {
  const actions = item.actions.flatMap((action) => action.steps.map((step) => `- ${step.text}`)).join("\n");
  const applicability = item.applicability.map((rule) => `${rule.dimension} ${rule.operator} ${rule.value}`).join("; ");
  const counterexamples = item.counterexamples.map((example) => `- ${example.condition}: ${example.reason}`).join("\n") || "- None recorded";
  const evidence = item.evidenceRefs.map((ref) => `${ref.runId}#${ref.sequence}`).join(", ");
  return [
    "Advisory only: evaluate this validated Experience against the current task. Do not execute actions without normal Runtime authorization.",
    `Title: ${item.title}`,
    `Objective: ${item.objective}`,
    `Outcome: ${item.outcome.kind} — ${item.outcome.summary}`,
    `Applicable when: ${applicability}`,
    `Counterexamples: ${counterexamples}`,
    `Suggested steps from evidence:`,
    actions,
    `Evidence: ${evidence}`,
  ].join("\n");
}

function experienceSearchText(item: ExperienceCase): string {
  return [item.title, item.objective, item.situation.conditions.map((item) => `${item.dimension} ${item.value}`).join(" "),
    item.actions.flatMap((action) => [action.intent, ...action.steps.map((step) => step.text)]).join(" "), item.outcome.summary].join(" ");
}

function normalize(value: string): string { return value.normalize("NFKC").toLocaleLowerCase("und").trim(); }
function words(value: string): Set<string> { return new Set(value.split(/[^\p{L}\p{N}]+/u).filter((item) => item.length > 1)); }
function overlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let count = 0;
  for (const item of left) if (right.has(item)) count += 1;
  return count / left.size;
}
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
