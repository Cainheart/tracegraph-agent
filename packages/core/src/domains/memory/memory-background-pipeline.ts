import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  MemoryBackgroundJobSchema,
  MemoryConsolidationResultSchema,
  MemoryEpisodeExtractionResultSchema,
  MemoryDerivedCandidateRequestSchema,
  isTerminalEventType,
  type MemoryBackgroundJob,
  type MemoryConsolidationResult,
  type MemoryEpisodeExtractionInput,
  type SessionEvent,
} from "@tracegraph/contracts";
import { redactSensitiveText, sha256, stableStringify } from "../../kernel/crypto.js";
import type { ModelAdapter } from "../../kernel/types.js";
import { MemoryControlService } from "./memory-control.js";
import {
  assertCandidateEvidenceSequences,
  buildMemoryEpisodeExtractionInput,
  projectMemoryEpisode,
} from "./memory-episode.js";

const MAX_EXTRACTION_ATTEMPTS = 5;
const BASE_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 15 * 60_000;
const LEASE_DURATION_MS = 2 * 60_000;
const RECOVERY_BATCH_SIZE = 32;

const BackgroundJobStateSchema = z.object({
  schemaVersion: z.enum(["tracegraph.memory-background-job.v1", "tracegraph.memory-background-job.v2"]),
  runId: z.string().min(1).max(160),
  sourceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(),
  status: z.enum(["waiting", "running", "retry", "complete", "exhausted"]),
  attempts: z.number().int().nonnegative().max(MAX_EXTRACTION_ATTEMPTS),
  nextAttemptAt: z.string().datetime({ offset: true }).optional(),
  candidateCount: z.number().int().nonnegative().max(8).default(0),
  lastErrorCode: z.string().min(1).max(100).optional(),
  consolidationResults: z.array(MemoryConsolidationResultSchema).max(8).optional(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
type BackgroundJobState = z.infer<typeof BackgroundJobStateSchema>;

export interface MemoryEpisodeRunLedger {
  list(runId: string): Promise<SessionEvent[]>;
  listRunIds(): Promise<string[]>;
  iterateRunIdBatches?(batchSize: number): AsyncIterable<string[]>;
  subscribe(listener: (event: SessionEvent) => void): () => void;
}

export interface MemoryEpisodeExtractor {
  readonly id: string;
  canExtract(): boolean;
  extract(input: MemoryEpisodeExtractionInput, options: { signal: AbortSignal }): Promise<unknown>;
}

export interface MemoryBackgroundPipelineOptions {
  readonly root: string;
  readonly ownerId: string;
  readonly ledger: MemoryEpisodeRunLedger;
  readonly control: MemoryControlService;
  readonly extractor?: MemoryEpisodeExtractor;
  readonly now?: () => Date;
}

/** Bounded post-settlement worker. Job files are operational projections; Run and Memory facts remain in the Evidence Ledger. */
export class MemoryBackgroundPipeline {
  readonly #root: string;
  readonly #ledger: MemoryEpisodeRunLedger;
  readonly #control: MemoryControlService;
  readonly #extractor: MemoryEpisodeExtractor | undefined;
  readonly #now: () => Date;
  readonly #queued = new Set<string>();
  readonly #queue: string[] = [];
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #active = new Map<string, { task: Promise<void>; controller: AbortController }>();
  readonly #jobIndex = new Map<string, MemoryBackgroundJob[]>();
  #historyLoaded = false;
  #recoveryTask: Promise<void> | undefined;
  #closed = false;

  constructor(options: MemoryBackgroundPipelineOptions) {
    this.#root = join(options.root, sha256(options.ownerId).slice("sha256:".length));
    this.#ledger = options.ledger;
    this.#control = options.control;
    this.#extractor = options.extractor;
    this.#now = options.now ?? (() => new Date());
  }

  /** Called from the canonical ledger listener; it never awaits background work. */
  scheduleSettledRun(event: SessionEvent): void {
    if (this.#closed || !isTerminalEventType(event.type)) return;
    this.#enqueue(event.run_id);
  }

  get historyLoaded(): boolean { return this.#historyLoaded; }

  /** Repairs the terminal-commit-before-enqueue crash window and rebuilds the disposable read index. */
  recoverSettledRuns(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#recoveryTask !== undefined) return this.#recoveryTask;
    this.#recoveryTask = this.#recoverSettledRuns().finally(() => { this.#recoveryTask = undefined; });
    return this.#recoveryTask;
  }

  async #recoverSettledRuns(): Promise<void> {
    this.#historyLoaded = false;
    this.#jobIndex.clear();
    for await (const runs of this.#runIdBatches()) {
      if (this.#closed) return;
      for (const { runId, projectId } of runs) {
        const state = await this.#readState(runId);
        if (state !== undefined) this.#indexJob(projectId, state);
        if (state?.status === "complete" || state?.status === "exhausted") continue;
        if (state?.status === "retry" && state.nextAttemptAt !== undefined
          && Date.parse(state.nextAttemptAt) > this.#now().getTime()) {
          this.#scheduleRetry(runId, Date.parse(state.nextAttemptAt) - this.#now().getTime());
          continue;
        }
        if (state?.status === "waiting" && !this.#extractor?.canExtract()) continue;
        this.#enqueue(runId);
      }
      await this.#drainQueued();
    }
    if (!this.#closed) this.#historyLoaded = true;
  }

  /** Bounded read-only projection: request cost is independent of historical Run/ledger size. */
  async listJobs(scope: { allowedScopeIds: readonly string[] }): Promise<MemoryBackgroundJob[]> {
    if (scope.allowedScopeIds.length === 0) return [];
    const jobs: MemoryBackgroundJob[] = [];
    for (const projectId of new Set(scope.allowedScopeIds)) {
      jobs.push(...this.#jobIndex.get(projectId) ?? []);
      jobs.sort(compareJobs);
      jobs.splice(100);
    }
    // Return copies so callers cannot alter the worker's operational projection.
    return jobs.map((job) => MemoryBackgroundJobSchema.parse(job));
  }

  #indexJob(projectId: string, state: BackgroundJobState): void {
    const job = MemoryBackgroundJobSchema.parse({
      runId: state.runId, projectId,
      ...(state.sourceDigest === undefined ? {} : { sourceDigest: state.sourceDigest }),
      status: state.status, attempts: state.attempts, candidateCount: state.candidateCount,
      ...(state.nextAttemptAt === undefined ? {} : { nextAttemptAt: state.nextAttemptAt }),
      ...(state.lastErrorCode === undefined ? {} : { lastErrorCode: safeErrorCode({ code: state.lastErrorCode }) }),
      updatedAt: state.updatedAt,
      consolidationResults: state.consolidationResults ?? [],
      resultDetailsAvailable: state.consolidationResults !== undefined,
    });
    const jobs = (this.#jobIndex.get(projectId) ?? []).filter((value) => value.runId !== job.runId);
    jobs.push(job);
    jobs.sort(compareJobs);
    this.#jobIndex.set(projectId, jobs.slice(0, 100));
  }

  /** Requeues waiting runs after Host model settings are configured. */
  async resumeWaiting(): Promise<void> {
    if (this.#closed || !this.#extractor?.canExtract()) return;
    for await (const runs of this.#runIdBatches()) {
      for (const { runId, projectId } of runs) {
        const state = await this.#readState(runId);
        if (state !== undefined) this.#indexJob(projectId, state);
        if (state === undefined || state.status === "waiting") {
          // The durable waiting marker can be observed before the old worker's
          // lease release/finally completes. Do not lose a configuration-change
          // wakeup to active-task deduplication in that window.
          await this.#active.get(runId)?.task;
          this.#enqueue(runId);
        }
      }
      await this.#drainQueued();
    }
  }

  async *#runIdBatches(): AsyncGenerator<Array<{ runId: string; projectId: string }>> {
    if (this.#ledger.iterateRunIdBatches !== undefined) {
      for await (const runIds of this.#ledger.iterateRunIdBatches(RECOVERY_BATCH_SIZE)) {
        yield await this.#canonicalRunIds(runIds);
      }
      return;
    }
    const runIds = await this.#ledger.listRunIds();
    for (let offset = 0; offset < runIds.length; offset += RECOVERY_BATCH_SIZE) {
      yield await this.#canonicalRunIds(runIds.slice(offset, offset + RECOVERY_BATCH_SIZE));
    }
  }

  async #canonicalRunIds(inventoryIds: readonly string[]): Promise<Array<{ runId: string; projectId: string }>> {
    const ids = new Map<string, string>();
    for (const inventoryId of inventoryIds) {
      // File inventories may contain sanitized names (run:UUID -> run_UUID).
      // Job identity always follows the durable event, never a filename alias.
      const first = (await this.#ledger.list(inventoryId))[0];
      if (first !== undefined) ids.set(first.run_id, first.project_id);
    }
    return [...ids].map(([runId, projectId]) => ({ runId, projectId }));
  }

  async #drainQueued(): Promise<void> {
    while (!this.#closed && (this.#queue.length > 0 || this.#active.size > 0)) {
      if (this.#active.size === 0) {
        this.#pump();
        continue;
      }
      await Promise.all([...this.#active.values()].map(({ task }) => task));
    }
  }

  async shutdown(): Promise<void> {
    this.#closed = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    for (const active of this.#active.values()) active.controller.abort(new Error("Runtime is shutting down"));
    await Promise.allSettled([...this.#active.values()].map(({ task }) => task));
  }

  #enqueue(runId: string): void {
    if (this.#closed || this.#queued.has(runId) || this.#active.has(runId)) return;
    this.#queued.add(runId);
    this.#queue.push(runId);
    this.#pump();
  }

  #pump(): void {
    if (this.#closed) return;
    // One worker per owner/scope at a time makes consolidation ordering explicit.
    while (this.#active.size < 1 && this.#queue.length > 0) {
      const runId = this.#queue.shift()!;
      this.#queued.delete(runId);
      const controller = new AbortController();
      const task = this.#process(runId, controller.signal)
        .catch(() => undefined)
        .finally(() => {
          this.#active.delete(runId);
          this.#pump();
        });
      this.#active.set(runId, { task, controller });
    }
  }

  async #process(runId: string, signal: AbortSignal): Promise<void> {
    let projectId: string | undefined;
    const release = await this.#claimLease();
    if (release === undefined) {
      // Another Runtime may own the same owner-scoped queue. Keep this process
      // recoverable if that process exits before recording completion.
      this.#scheduleRetry(runId, BASE_RETRY_DELAY_MS);
      return;
    }
    try {
      const prior = await this.#readState(runId);
      const events = await this.#ledger.list(runId);
      projectId = events[0]?.project_id;
      // Only a trusted Runtime admission can write this durable creation fact.
      // Explicit one-shot media work must not incur a later chat-model request,
      // including when this worker recovers settled history after a restart.
      if (events.find((event) => event.type === "run.created")?.data.background_model_derivation === false) return;
      // A competing worker may have completed the durable job while this
      // instance waited for the owner lease. Refresh its disposable projection
      // before skipping extraction so a historical running marker cannot stick.
      if (prior !== undefined && projectId !== undefined) this.#indexJob(projectId, prior);
      if (prior?.status === "complete" || prior?.status === "exhausted") return;
      if (events.length === 0 || !isTerminalEventType(events.at(-1)!.type)) return;
      const episode = projectMemoryEpisode(events);
      if (prior?.sourceDigest !== undefined && prior.sourceDigest !== episode.sourceDigest) {
        throw new MemoryBackgroundPipelineError("memory_background_source_changed", "Settled Run source digest changed");
      }
      if (this.#extractor === undefined || !this.#extractor.canExtract()) {
        await this.#writeState(runId, {
          schemaVersion: "tracegraph.memory-background-job.v2",
          runId,
          sourceDigest: episode.sourceDigest,
          status: "waiting",
          attempts: prior?.attempts ?? 0,
          candidateCount: prior?.consolidationResults?.filter((result) => result.action === "candidate").length ?? 0,
          consolidationResults: prior?.consolidationResults ?? [],
          updatedAt: this.#now().toISOString(),
        }, projectId);
        return;
      }

      const attempts = (prior?.attempts ?? 0) + 1;
      const running: BackgroundJobState = {
        schemaVersion: "tracegraph.memory-background-job.v2",
        runId,
        sourceDigest: episode.sourceDigest,
        status: "running",
        attempts: prior?.attempts ?? 0,
        candidateCount: prior?.consolidationResults?.filter((result) => result.action === "candidate").length ?? 0,
        consolidationResults: prior?.consolidationResults ?? [],
        updatedAt: this.#now().toISOString(),
      };
      await this.#writeState(runId, running, projectId);
      const extractionInput = buildMemoryEpisodeExtractionInput(episode, events);
      const extractionController = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
      const extracted = MemoryEpisodeExtractionResultSchema.parse(
        await this.#extractor.extract(extractionInput, { signal: extractionController }),
      );
      extractionController.throwIfAborted();
      if (extracted.candidates.length < (prior?.consolidationResults?.length ?? 0)) {
        throw new MemoryBackgroundPipelineError("memory_background_result_changed", "Extractor omitted a previously committed candidate slot");
      }
      let candidateCount = 0;
      const consolidationResults: MemoryConsolidationResult[] = [];
      for (const [index, candidate] of extracted.candidates.entries()) {
        extractionController.throwIfAborted();
        const claim = redactSensitiveText(candidate.claim).trim();
        if (claim.length === 0) throw new MemoryBackgroundPipelineError("memory_background_extraction_failed", "Candidate is empty after redaction");
        if (candidate.evidenceSequences.some((sequence) => !extractionInput.evidenceSequences.includes(sequence))) {
          throw new MemoryBackgroundPipelineError(
            "memory_background_evidence_not_presented",
            "Extractor cited an event that was not included in its bounded input",
          );
        }
        const evidenceRefs = assertCandidateEvidenceSequences(episode, events, candidate.evidenceSequences);
        const citedSummaries = evidenceRefs.map((ref) => {
          const event = events[ref.sequence - 1]!;
          return event.summary.toLocaleLowerCase();
        }).join("\n").normalize("NFKC").toLocaleLowerCase();
        const normalizedKey = candidate.normalizedKey?.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
        // Conflict keys can be used by MEM-045 only when their literal subject appears in cited evidence.
        const acceptedKey = normalizedKey !== undefined && citedSummaries.includes(normalizedKey) ? normalizedKey : undefined;
        const commandId = `memory-episode:${sha256(stableStringify({
          extractor: this.#extractor.id,
          episode: episode.episodeId,
          index,
        })).slice("sha256:".length, 48)}`;
        const request = MemoryDerivedCandidateRequestSchema.parse({
          command_id: commandId,
          kind: candidate.kind,
          claim,
          ...(acceptedKey === undefined ? {} : { normalized_key: acceptedKey }),
          project_id: episode.projectId,
          run_id: episode.runId,
          source_digest: episode.sourceDigest,
          episode_id: episode.episodeId,
          extractor_id: this.#extractor.id,
          ...(candidate.confidence === undefined ? {} : { inference_confidence: candidate.confidence }),
          evidence_refs: evidenceRefs,
        });
        const previousResult = prior?.consolidationResults?.[index];
        if (previousResult !== undefined && previousResult.requestDigest !== sha256(stableStringify(request))) {
          throw new MemoryBackgroundPipelineError("memory_background_result_changed", "Extractor changed a previously committed candidate slot");
        }
        const result = previousResult ?? await this.#control.consolidateDerivedCandidate(request);
        consolidationResults.push(result);
        if (result.action === "candidate") candidateCount += 1;
        // Persist every committed result before moving to another candidate slot.
        if (previousResult === undefined) {
          await this.#writeState(runId, { ...running, candidateCount, consolidationResults, updatedAt: this.#now().toISOString() }, projectId);
        }
      }
      // The Episode summary remains a projection. Candidate summaries/claims are stored only as reviewable seeds.
      void extracted.summary;
      extractionController.throwIfAborted();
      await this.#writeState(runId, {
        ...running,
        status: "complete",
        attempts,
        nextAttemptAt: undefined,
        candidateCount,
        consolidationResults,
        lastErrorCode: undefined,
        updatedAt: this.#now().toISOString(),
      }, projectId);
    } catch (error) {
      if (signal.aborted || this.#closed) {
        const prior = await this.#readState(runId);
        await this.#writeState(runId, {
          schemaVersion: "tracegraph.memory-background-job.v2",
          runId,
          ...(prior?.sourceDigest === undefined ? {} : { sourceDigest: prior.sourceDigest }),
          status: "retry",
          attempts: prior?.attempts ?? 0,
          candidateCount: prior?.consolidationResults?.filter((result) => result.action === "candidate").length ?? 0,
          consolidationResults: prior?.consolidationResults ?? [],
          updatedAt: this.#now().toISOString(),
        }, projectId).catch(() => undefined);
        return;
      }
      await this.#recordFailure(runId, error, projectId);
    } finally {
      await release();
    }
  }

  async #recordFailure(runId: string, error: unknown, projectId: string | undefined): Promise<void> {
    const previous = await this.#readState(runId);
    const attempts = Math.min((previous?.attempts ?? 0) + 1, MAX_EXTRACTION_ATTEMPTS);
    const exhausted = attempts >= MAX_EXTRACTION_ATTEMPTS;
    const delay = Math.min(BASE_RETRY_DELAY_MS * 2 ** Math.max(0, attempts - 1), MAX_RETRY_DELAY_MS);
    const nextAttemptAt = exhausted ? undefined : new Date(this.#now().getTime() + delay).toISOString();
    await this.#writeState(runId, {
      schemaVersion: "tracegraph.memory-background-job.v2",
      runId,
      ...(previous?.sourceDigest === undefined ? {} : { sourceDigest: previous.sourceDigest }),
      status: exhausted ? "exhausted" : "retry",
      attempts,
      ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
      candidateCount: previous?.consolidationResults?.filter((result) => result.action === "candidate").length ?? 0,
      consolidationResults: previous?.consolidationResults ?? [],
      lastErrorCode: safeErrorCode(error),
      updatedAt: this.#now().toISOString(),
    }, projectId);
    if (nextAttemptAt !== undefined) this.#scheduleRetry(runId, delay);
  }

  #scheduleRetry(runId: string, delayMs: number): void {
    if (this.#closed) return;
    const prior = this.#timers.get(runId);
    if (prior !== undefined) clearTimeout(prior);
    const timer = setTimeout(() => {
      this.#timers.delete(runId);
      this.#enqueue(runId);
    }, Math.min(Math.max(delayMs, 0), MAX_RETRY_DELAY_MS));
    timer.unref();
    this.#timers.set(runId, timer);
  }

  async #claimLease(): Promise<(() => Promise<void>) | undefined> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const leasePath = this.#leasePath();
    const token = randomUUID();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(leasePath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
        await handle.writeFile(token, "utf8");
        await handle.sync();
        await handle.close();
        const heartbeat = setInterval(() => {
          void (async () => {
            if (await readFile(leasePath, "utf8") !== token) return;
            const now = new Date();
            await utimes(leasePath, now, now);
          })().catch(() => undefined);
        }, Math.floor(LEASE_DURATION_MS / 3));
        heartbeat.unref();
        return async () => {
          clearInterval(heartbeat);
          try {
            if (await readFile(leasePath, "utf8") === token) await unlink(leasePath);
          } catch {
            // A stale takeover may already have replaced this lease.
          }
        };
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        const info = await lstat(leasePath).catch(() => undefined);
        if (info === undefined) continue;
        if (!info.isFile() || info.isSymbolicLink()) {
          throw new MemoryBackgroundPipelineError("memory_background_lease_invalid", "Memory extraction lease is not a regular file");
        }
        if (this.#now().getTime() - info.mtimeMs < LEASE_DURATION_MS) return undefined;
        const stalePath = `${leasePath}.stale.${randomUUID()}`;
        await rename(leasePath, stalePath).catch(() => undefined);
        await unlink(stalePath).catch(() => undefined);
      }
    }
    return undefined;
  }

  async #readState(runId: string): Promise<BackgroundJobState | undefined> {
    try {
      const parsed = BackgroundJobStateSchema.safeParse(JSON.parse(await readFile(this.#statePath(runId), "utf8")) as unknown);
      if (!parsed.success || parsed.data.runId !== runId) {
        throw new MemoryBackgroundPipelineError("memory_background_state_corrupt", "Memory extraction job state is invalid");
      }
      return parsed.data;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  async #writeState(runId: string, stateValue: BackgroundJobState, projectId: string | undefined): Promise<void> {
    const state = BackgroundJobStateSchema.parse(stateValue);
    if (state.runId !== runId) throw new MemoryBackgroundPipelineError("memory_background_state_corrupt", "Memory job identity changed");
    const path = this.#statePath(runId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      await handle.writeFile(JSON.stringify(state), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, path);
      const directory = await open(dirname(path), fsConstants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
      if (projectId !== undefined) this.#indexJob(projectId, state);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  #statePath(runId: string): string {
    return join(this.#root, `${sha256(runId).slice("sha256:".length)}.job.json`);
  }

  #leasePath(): string {
    // Consolidation is serialized across every Run for one owner, including
    // separate Host processes sharing the same local data directory.
    return join(this.#root, "owner.lease");
  }
}

export class MemoryBackgroundPipelineError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MemoryBackgroundPipelineError";
    this.code = code;
  }
}

export function createModelMemoryEpisodeExtractor(model: ModelAdapter): MemoryEpisodeExtractor | undefined {
  if (model.extractMemoryEpisode === undefined) return undefined;
  return {
    id: "model-extractor:v1",
    canExtract: () => model.canExtractMemoryEpisode?.() ?? true,
    extract: (input, options) => model.extractMemoryEpisode!(input, options),
  };
}

const SAFE_JOB_ERROR_CODES = new Set([
  "memory_background_source_changed", "memory_background_result_changed", "memory_background_evidence_not_presented",
  "memory_background_lease_invalid", "memory_background_state_corrupt", "memory_background_extraction_failed",
  "memory_control_not_found", "memory_control_scope_denied", "memory_control_deleted", "memory_control_conflict",
  "memory_control_invalid_command", "memory_control_corrupt", "memory_episode_invalid_source",
  "memory_episode_unbounded_source", "memory_episode_evidence_mismatch",
]);

function safeErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    && SAFE_JOB_ERROR_CODES.has(error.code)) return error.code;
  return "memory_background_extraction_failed";
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function compareJobs(left: MemoryBackgroundJob, right: MemoryBackgroundJob): number {
  return right.updatedAt.localeCompare(left.updatedAt) || left.runId.localeCompare(right.runId);
}
