import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  MemoryEpisodeExtractionResultSchema,
  MemoryDerivedCandidateRequestSchema,
  isTerminalEventType,
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
  schemaVersion: z.literal("tracegraph.memory-background-job.v1"),
  runId: z.string().min(1).max(160),
  sourceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(),
  status: z.enum(["waiting", "retry", "complete", "exhausted"]),
  attempts: z.number().int().nonnegative().max(MAX_EXTRACTION_ATTEMPTS),
  nextAttemptAt: z.string().datetime({ offset: true }).optional(),
  candidateCount: z.number().int().nonnegative().max(8).default(0),
  lastErrorCode: z.string().min(1).max(100).optional(),
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

  /** Repairs the terminal-commit-before-enqueue crash window in bounded batches. */
  async recoverSettledRuns(): Promise<void> {
    if (this.#closed) return;
    for await (const runIds of this.#runIdBatches()) {
      if (this.#closed) return;
      for (const runId of runIds) {
        const state = await this.#readState(runId);
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
  }

  /** Requeues waiting runs after Host model settings are configured. */
  async resumeWaiting(): Promise<void> {
    if (this.#closed || !this.#extractor?.canExtract()) return;
    for await (const runIds of this.#runIdBatches()) {
      for (const runId of runIds) {
        const state = await this.#readState(runId);
        if (state === undefined || state.status === "waiting") this.#enqueue(runId);
      }
      await this.#drainQueued();
    }
  }

  async *#runIdBatches(): AsyncGenerator<string[]> {
    if (this.#ledger.iterateRunIdBatches !== undefined) {
      yield* this.#ledger.iterateRunIdBatches(RECOVERY_BATCH_SIZE);
      return;
    }
    const runIds = await this.#ledger.listRunIds();
    for (let offset = 0; offset < runIds.length; offset += RECOVERY_BATCH_SIZE) {
      yield runIds.slice(offset, offset + RECOVERY_BATCH_SIZE);
    }
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
    const release = await this.#claimLease();
    if (release === undefined) {
      // Another Runtime may own the same owner-scoped queue. Keep this process
      // recoverable if that process exits before recording completion.
      this.#scheduleRetry(runId, BASE_RETRY_DELAY_MS);
      return;
    }
    try {
      const prior = await this.#readState(runId);
      if (prior?.status === "complete" || prior?.status === "exhausted") return;
      const events = await this.#ledger.list(runId);
      if (events.length === 0 || !isTerminalEventType(events.at(-1)!.type)) return;
      const episode = projectMemoryEpisode(events);
      if (prior?.sourceDigest !== undefined && prior.sourceDigest !== episode.sourceDigest) {
        throw new MemoryBackgroundPipelineError("memory_background_source_changed", "Settled Run source digest changed");
      }
      if (this.#extractor === undefined || !this.#extractor.canExtract()) {
        await this.#writeState(runId, {
          schemaVersion: "tracegraph.memory-background-job.v1",
          runId,
          sourceDigest: episode.sourceDigest,
          status: "waiting",
          attempts: prior?.attempts ?? 0,
          candidateCount: 0,
          updatedAt: this.#now().toISOString(),
        });
        return;
      }

      const attempts = (prior?.attempts ?? 0) + 1;
      const running: BackgroundJobState = {
        schemaVersion: "tracegraph.memory-background-job.v1",
        runId,
        sourceDigest: episode.sourceDigest,
        status: "retry",
        attempts: prior?.attempts ?? 0,
        nextAttemptAt: this.#now().toISOString(),
        candidateCount: 0,
        updatedAt: this.#now().toISOString(),
      };
      await this.#writeState(runId, running);
      const extractionInput = buildMemoryEpisodeExtractionInput(episode, events);
      const extractionController = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
      const extracted = MemoryEpisodeExtractionResultSchema.parse(
        await this.#extractor.extract(extractionInput, { signal: extractionController }),
      );
      extractionController.throwIfAborted();
      let candidateCount = 0;
      for (const [index, candidate] of extracted.candidates.entries()) {
        extractionController.throwIfAborted();
        const claim = redactSensitiveText(candidate.claim).trim();
        if (claim.length === 0) continue;
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
        await this.#control.createDerivedCandidate(request);
        candidateCount += 1;
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
        lastErrorCode: undefined,
        updatedAt: this.#now().toISOString(),
      });
    } catch (error) {
      if (signal.aborted || this.#closed) {
        const prior = await this.#readState(runId);
        await this.#writeState(runId, {
          schemaVersion: "tracegraph.memory-background-job.v1",
          runId,
          ...(prior?.sourceDigest === undefined ? {} : { sourceDigest: prior.sourceDigest }),
          status: "retry",
          attempts: prior?.attempts ?? 0,
          candidateCount: prior?.candidateCount ?? 0,
          updatedAt: this.#now().toISOString(),
        }).catch(() => undefined);
        return;
      }
      await this.#recordFailure(runId, error);
    } finally {
      await release();
    }
  }

  async #recordFailure(runId: string, error: unknown): Promise<void> {
    const previous = await this.#readState(runId);
    const attempts = Math.min((previous?.attempts ?? 0) + 1, MAX_EXTRACTION_ATTEMPTS);
    const exhausted = attempts >= MAX_EXTRACTION_ATTEMPTS;
    const delay = Math.min(BASE_RETRY_DELAY_MS * 2 ** Math.max(0, attempts - 1), MAX_RETRY_DELAY_MS);
    const nextAttemptAt = exhausted ? undefined : new Date(this.#now().getTime() + delay).toISOString();
    await this.#writeState(runId, {
      schemaVersion: "tracegraph.memory-background-job.v1",
      runId,
      ...(previous?.sourceDigest === undefined ? {} : { sourceDigest: previous.sourceDigest }),
      status: exhausted ? "exhausted" : "retry",
      attempts,
      ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
      candidateCount: previous?.candidateCount ?? 0,
      lastErrorCode: safeErrorCode(error),
      updatedAt: this.#now().toISOString(),
    });
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

  async #writeState(runId: string, stateValue: BackgroundJobState): Promise<void> {
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

function safeErrorCode(error: unknown): string {
  if (error instanceof MemoryBackgroundPipelineError) return error.code;
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code.slice(0, 100);
  }
  return "memory_background_extraction_failed";
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
