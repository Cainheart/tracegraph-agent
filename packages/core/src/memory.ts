import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  MemoryCandidateEvaluatedDataSchema,
  MemoryCandidateSchema,
  MemoryAdmissionSchema,
  MemoryRecallBudgetSchema,
  MemoryRecallResultSchema,
  MemoryRecordSchema,
  MemoryRememberResultSchema,
  MemoryRecalledDataSchema,
  MemoryWrittenDataSchema,
  RetrievalIndexUpdatedDataSchema,
  RetrievalIndexUpdateResponseSchema,
  RetrievalReceiptSchema,
  RetrievalSearchResponseSchema,
  type MemoryAdmission,
  type MemoryCandidate,
  type MemoryRecallBudget,
  type MemoryRecallResult,
  type MemoryRecord,
  type MemoryRecallBlockedHit,
  type MemoryRememberResult,
  type RetrievalReceipt,
  type SessionEvent,
  type SessionEventProposal,
} from "@tracegraph/contracts";
import { defaultIdFactory, sha256, stableStringify } from "./crypto.js";

export function evaluateMemoryCandidate(
  candidate: MemoryCandidate,
  options: { now?: Date; idFactory?: (prefix: string) => string } = {},
): MemoryAdmission {
  const now = options.now ?? new Date();
  const idFactory = options.idFactory ?? defaultIdFactory;
  let decision: MemoryAdmission["decision"] = "confirmed";
  let reason = "candidate has a scoped, attributable source";

  if (candidate.source_refs.length === 0) {
    decision = "rejected";
    reason = "memory without source evidence is not admissible";
  } else if (candidate.expires_at !== undefined && Date.parse(candidate.expires_at) <= now.getTime()) {
    decision = "expired";
    reason = "candidate is already expired";
  } else if (candidate.trust !== "trusted") {
    decision = "quarantined";
    reason = "untrusted memory requires review";
  }

  return MemoryAdmissionSchema.parse({
    admission_id: idFactory("memory-admission"),
    candidate_id: candidate.candidate_id,
    decision,
    reason,
    decided_at: now.toISOString(),
    ...(decision === "confirmed" ? { resulting_memory_id: idFactory("memory") } : {}),
  });
}

export function materializeMemoryRecord(
  candidate: MemoryCandidate,
  admission: MemoryAdmission,
  options: { now?: Date } = {},
): MemoryRecord {
  if (admission.decision !== "confirmed" || admission.resulting_memory_id === undefined) {
    throw new Error("only a confirmed admission can create a memory record");
  }
  return MemoryRecordSchema.parse({
    memory_id: admission.resulting_memory_id,
    content: candidate.content,
    scope: candidate.scope,
    origin: candidate.origin,
    trust: candidate.trust,
    version: 1,
    status: "confirmed",
    source_refs: candidate.source_refs,
    created_at: (options.now ?? new Date()).toISOString(),
    ...(candidate.expires_at === undefined ? {} : { expires_at: candidate.expires_at }),
    supersedes: candidate.supersedes,
    content_hash: sha256(candidate.content),
    candidate_id: candidate.candidate_id,
    candidate_hash: sha256(stableStringify(candidate)),
    admission_id: admission.admission_id,
    admitted_at: admission.decided_at,
    admission_reason: admission.reason,
  });
}

export const DEFAULT_MEMORY_RECALL_BUDGET: MemoryRecallBudget = {
  max_tokens: 4_096,
  max_hits: 8,
};

export const MAX_MEMORY_QUERY_CHARS = 2_000;
const GLOBAL_MEMORY_RETRIEVAL_PROJECT_ID = "tracegraph:global-memory";

export interface MemoryRetriever {
  search(input: {
    project_id: string;
    query: string;
    top_k?: number;
  }, options?: { signal?: AbortSignal }): Promise<unknown>;
  ingest?(input: {
    project_id: string;
    source_path: string;
    content: string;
  }): Promise<unknown>;
}

export interface MemoryEventSink {
  append(proposal: SessionEventProposal): Promise<SessionEvent>;
}

export interface MemoryRecordStore {
  initialize(): Promise<void>;
  list(): Promise<readonly MemoryRecord[]>;
  write(record: MemoryRecord): Promise<void>;
}

/**
 * Small append-only canonical store for admitted memories. Retrieval indexes
 * are rebuildable projections and never replace these attributed records.
 */
export class JsonlMemoryStore implements MemoryRecordStore {
  readonly #path: string;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await appendFile(this.#path, "", { encoding: "utf8", mode: 0o600 });
  }

  async list(): Promise<readonly MemoryRecord[]> {
    const text = await readFile(this.#path, "utf8");
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line, index) => {
        try {
          return MemoryRecordSchema.parse(JSON.parse(line));
        } catch (error) {
          throw new MemoryStoreError(
            "memory_store_corrupt",
            `Memory record ${index + 1} is invalid`,
            { cause: error },
          );
        }
      });
  }

  async write(recordValue: MemoryRecord): Promise<void> {
    const record = MemoryRecordSchema.parse(recordValue);
    const operation = this.#writeQueue.then(async () => {
      const records = await this.list();
      const existing = records.find((item) => item.memory_id === record.memory_id);
      if (existing !== undefined) {
        if (stableStringify(existing) === stableStringify(record)) return;
        throw new MemoryStoreError("memory_id_conflict", `Memory id ${record.memory_id} already exists`);
      }
      await appendFile(this.#path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    });
    this.#writeQueue = operation.catch(() => undefined);
    return operation;
  }
}

export interface RememberMemoryInput {
  readonly projectId: string;
  readonly runId: string;
  readonly sessionId?: string;
  readonly candidate: unknown;
}

export interface RecallMemoryInput {
  readonly projectId: string;
  readonly runId: string;
  readonly sessionId?: string;
  readonly query: string;
  readonly budget?: MemoryRecallBudget;
  readonly signal?: AbortSignal;
}

export class MemoryManager {
  readonly #store: MemoryRecordStore;
  readonly #events: MemoryEventSink;
  readonly #retriever: MemoryRetriever | undefined;
  readonly #now: () => Date;
  readonly #idFactory: (prefix: string) => string;
  readonly #estimateTokens: (content: string) => number;
  #rememberQueue: Promise<void> = Promise.resolve();

  constructor(options: {
    store: MemoryRecordStore;
    events: MemoryEventSink;
    retriever?: MemoryRetriever;
    now?: () => Date;
    idFactory?: (prefix: string) => string;
    estimateTokens?: (content: string) => number;
  }) {
    this.#store = options.store;
    this.#events = options.events;
    this.#retriever = options.retriever;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? defaultIdFactory;
    this.#estimateTokens = options.estimateTokens ?? conservativeMemoryTokens;
  }

  get retrievalAvailable(): boolean {
    return this.#retriever !== undefined;
  }

  remember(input: RememberMemoryInput): Promise<MemoryRememberResult> {
    const operation = this.#rememberQueue.then(
      () => this.#rememberInOrder(input),
      () => this.#rememberInOrder(input),
    );
    this.#rememberQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #rememberInOrder(input: RememberMemoryInput): Promise<MemoryRememberResult> {
    const candidate = MemoryCandidateSchema.parse(input.candidate);
    assertCandidateScope(candidate, input.projectId, input.runId);
    const records = await this.#store.list();
    const candidateHash = sha256(stableStringify(candidate));
    const priorCandidate = records.find((record) => record.candidate_id === candidate.candidate_id);
    if (priorCandidate !== undefined && priorCandidate.candidate_hash !== candidateHash) {
      throw new MemoryStoreError("memory_candidate_conflict", `Candidate id ${candidate.candidate_id} was already used`);
    }
    const duplicate = findDuplicateMemory(records, candidate);
    const proposedAdmission = priorCandidate !== undefined
      ? MemoryAdmissionSchema.parse({
        admission_id: priorCandidate.admission_id ?? `legacy:${priorCandidate.memory_id}`,
        candidate_id: candidate.candidate_id,
        decision: "confirmed",
        reason: priorCandidate.admission_reason ?? "candidate has a scoped, attributable source",
        decided_at: priorCandidate.admitted_at ?? priorCandidate.created_at,
        resulting_memory_id: priorCandidate.memory_id,
      })
      : duplicate === undefined
        ? evaluateMemoryCandidate(candidate, { now: this.#now(), idFactory: this.#idFactory })
      : MemoryAdmissionSchema.parse({
        admission_id: this.#idFactory("memory-admission"),
        candidate_id: candidate.candidate_id,
        decision: "rejected",
        reason: `duplicate of ${duplicate.memory_id}`,
        decided_at: this.#now().toISOString(),
      });
    const evaluatedData = MemoryCandidateEvaluatedDataSchema.parse({
      admission_id: proposedAdmission.admission_id,
      candidate_id: candidate.candidate_id,
      candidate_hash: candidateHash,
      decided_at: proposedAdmission.decided_at,
      accepted: proposedAdmission.decision === "confirmed",
      decision: proposedAdmission.decision,
      reason: proposedAdmission.reason,
      source_count: candidate.source_refs.length,
      ...(proposedAdmission.resulting_memory_id === undefined
        ? {}
        : { resulting_memory_id: proposedAdmission.resulting_memory_id }),
    });
    const evaluated = await this.#events.append({
      type: "memory.candidate_evaluated",
      project_id: input.projectId,
      run_id: input.runId,
      attempt: 0,
      artifact_refs: [],
      ...(input.sessionId === undefined ? {} : { session_id: input.sessionId }),
      summary: evaluatedData.accepted ? "Memory candidate accepted" : "Memory candidate rejected",
      idempotency_key: `memory-evaluate:${candidate.candidate_id}`,
      data: evaluatedData,
    });
    const canonicalEvaluation = MemoryCandidateEvaluatedDataSchema.parse(evaluated.data);
    if (canonicalEvaluation.candidate_hash !== candidateHash) {
      throw new MemoryStoreError(
        "memory_candidate_conflict",
        `Candidate id ${candidate.candidate_id} was already used`,
      );
    }
    // The committed Event owns the admission identity. A retry after the
    // evaluation commit but before the store write must reuse the same record.
    const admission = MemoryAdmissionSchema.parse({
      admission_id: canonicalEvaluation.admission_id,
      candidate_id: canonicalEvaluation.candidate_id,
      decision: canonicalEvaluation.decision,
      reason: canonicalEvaluation.reason,
      decided_at: canonicalEvaluation.decided_at,
      ...(canonicalEvaluation.resulting_memory_id === undefined
        ? {}
        : { resulting_memory_id: canonicalEvaluation.resulting_memory_id }),
    });
    if (admission.decision !== "confirmed") {
      return MemoryRememberResultSchema.parse({ admission });
    }

    const record = priorCandidate
      ?? materializeMemoryRecord(candidate, admission, { now: this.#now() });
    await this.#store.write(record);
    let indexUpdate: ReturnType<typeof RetrievalIndexUpdatedDataSchema.parse> | undefined;
    if (this.#retriever?.ingest !== undefined) {
      try {
        const indexProjectId = record.scope.kind === "global"
          ? GLOBAL_MEMORY_RETRIEVAL_PROJECT_ID
          : input.projectId;
        const rawUpdate = await this.#retriever.ingest({
          project_id: indexProjectId,
          source_path: memorySourcePath(record.memory_id),
          content: record.content,
        });
        const parsed = RetrievalIndexUpdateResponseSchema.parse(rawUpdate);
        if (parsed.project_id !== indexProjectId) throw new Error("retrieval index project mismatch");
        indexUpdate = RetrievalIndexUpdatedDataSchema.parse({
          source_path: parsed.source_path,
          document_hash: parsed.document_hash,
          status: parsed.status,
          generation: parsed.generation,
          source_chunk_count: parsed.source_chunk_count,
          total_indexed_chunks: parsed.total_indexed_chunks,
        });
      } catch {
        // The canonical memory write remains valid. The absence of an index
        // Event makes the rebuildable retrieval projection visibly stale.
      }
    }
    const writtenData = MemoryWrittenDataSchema.parse({
      admission_id: admission.admission_id,
      candidate_id: candidate.candidate_id,
      memory_id: record.memory_id,
      content_hash: record.content_hash ?? sha256(record.content),
      scope: record.scope,
      source_refs: record.source_refs,
    });
    const written = await this.#events.append({
      type: "memory.written",
      project_id: input.projectId,
      run_id: input.runId,
      attempt: 0,
      artifact_refs: [],
      ...(input.sessionId === undefined ? {} : { session_id: input.sessionId }),
      summary: `Memory ${record.memory_id} written`,
      idempotency_key: `memory-write:${record.memory_id}`,
      data: writtenData,
    });
    if (indexUpdate !== undefined) {
      await this.#events.append({
        type: "retrieval.index_updated",
        project_id: input.projectId,
        run_id: input.runId,
        attempt: 0,
        artifact_refs: [],
        ...(input.sessionId === undefined ? {} : { session_id: input.sessionId }),
        caused_by_event_id: written.event_id,
        summary: `Retrieval index ${indexUpdate.status} for ${indexUpdate.source_path}`,
        idempotency_key: `retrieval-index:${record.memory_id}:${indexUpdate.document_hash}`,
        data: indexUpdate,
      });
    }
    return MemoryRememberResultSchema.parse({ admission, record });
  }

  async recall(input: RecallMemoryInput): Promise<MemoryRecallResult> {
    const query = input.query.trim();
    if (query.length === 0 || query.length > MAX_MEMORY_QUERY_CHARS) {
      throw new RangeError(`Memory query must contain 1-${MAX_MEMORY_QUERY_CHARS} characters`);
    }
    const budget = MemoryRecallBudgetSchema.parse(input.budget ?? DEFAULT_MEMORY_RECALL_BUDGET);
    const retrievalId = this.#idFactory("memory-retrieval");
    const queryHash = sha256(query);
    let result: MemoryRecallResult;

    if (this.#retriever === undefined) {
      result = degradedRecall(retrievalId, queryHash, budget, "retriever_unavailable");
    } else {
      try {
        const records = await this.#store.list();
        const searchProjects = records.some((record) => record.scope.kind === "global")
          ? [input.projectId, GLOBAL_MEMORY_RETRIEVAL_PROJECT_ID]
          : [input.projectId];
        const responses = await Promise.all(searchProjects.map(async (searchProject) => ({
          searchProject,
          parsed: RetrievalSearchResponseSchema.safeParse(await this.#retriever!.search(
            {
              project_id: searchProject,
              query,
              top_k: budget.max_hits,
            },
            input.signal === undefined ? undefined : { signal: input.signal },
          )),
        })));
        if (responses.some(({ searchProject, parsed }) => (
          !parsed.success
          || parsed.data.project_id !== searchProject
          || parsed.data.query_hash !== queryHash
          || (searchProject === GLOBAL_MEMORY_RETRIEVAL_PROJECT_ID
            && parsed.data.hits.some((hit) => !hit.source_path.startsWith("memory/")))
        ))) {
          result = degradedRecall(retrievalId, queryHash, budget, "retriever_invalid_response");
        } else {
          const rawHits = responses.flatMap(({ parsed }) => (
            parsed.success ? parsed.data.hits : []
          ));
          const scoped = filterScopedMemoryHits(
            rawHits,
            records,
            input.projectId,
            input.runId,
            this.#now(),
          );
          const hits = selectRetrievedHits(scoped.hits, budget, this.#estimateTokens);
          const attributions = hits.map((hit) => hit.attribution);
          const data = MemoryRecalledDataSchema.parse({
            retrieval_id: retrievalId,
            query_hash: queryHash,
            status: "completed",
            budget,
            hits: attributions,
            blocked_hits: scoped.blocked,
            injected_tokens: attributions.reduce((total, hit) => total + hit.injected_tokens, 0),
          });
          result = MemoryRecallResultSchema.parse({ data, hits });
        }
      } catch (error) {
        if (input.signal?.aborted === true) throw error;
        result = degradedRecall(retrievalId, queryHash, budget, "retriever_failed");
      }
    }

    await this.#events.append({
      type: "memory.recalled",
      project_id: input.projectId,
      run_id: input.runId,
      attempt: 0,
      artifact_refs: [],
      ...(input.sessionId === undefined ? {} : { session_id: input.sessionId }),
      summary: result.data.status === "completed"
        ? `Recalled ${result.hits.length} memory items within ${result.data.injected_tokens} tokens`
        : "Memory retrieval degraded without injected context",
      idempotency_key: `memory-recall:${retrievalId}`,
      data: result.data,
    });
    return result;
  }
}

function degradedRecall(
  retrievalId: string,
  queryHash: string,
  budget: MemoryRecallBudget,
  failureCode: "retriever_unavailable" | "retriever_invalid_response" | "retriever_failed",
): MemoryRecallResult {
  return MemoryRecallResultSchema.parse({
    data: {
      retrieval_id: retrievalId,
      query_hash: queryHash,
      status: "degraded",
      budget,
      hits: [],
      blocked_hits: [],
      injected_tokens: 0,
      failure_code: failureCode,
    },
    hits: [],
  });
}

function filterScopedMemoryHits(
  hits: readonly ReturnType<typeof RetrievalSearchResponseSchema.parse>["hits"][number][],
  records: readonly MemoryRecord[],
  projectId: string,
  runId: string,
  now: Date,
): {
  hits: ReturnType<typeof RetrievalSearchResponseSchema.parse>["hits"];
  blocked: MemoryRecallBlockedHit[];
} {
  const recordsByPath = new Map(records.map((record) => [memorySourcePath(record.memory_id), record]));
  const supersededIds = new Set(
    records
      .filter((record) => record.status === "confirmed")
      .flatMap((record) => record.supersedes),
  );
  const allowed: ReturnType<typeof RetrievalSearchResponseSchema.parse>["hits"] = [];
  const blocked: MemoryRecallBlockedHit[] = [];
  for (const hit of hits) {
    if (!hit.source_path.startsWith("memory/")) {
      allowed.push(hit);
      continue;
    }
    const record = recordsByPath.get(hit.source_path);
    const reason = record === undefined
      ? "memory_record_missing"
      : memoryRecallBlockReason(record, supersededIds, projectId, runId, now);
    if (reason === undefined) {
      allowed.push(hit);
    } else {
      blocked.push({ hit_id: hit.chunk_id, reason });
    }
  }
  return { hits: allowed, blocked };
}

function memoryRecallBlockReason(
  record: MemoryRecord,
  supersededIds: ReadonlySet<string>,
  projectId: string,
  runId: string,
  now: Date,
): MemoryRecallBlockedHit["reason"] | undefined {
  if (record.status !== "confirmed") return `status_${record.status}` as MemoryRecallBlockedHit["reason"];
  if (supersededIds.has(record.memory_id)) return "superseded";
  if (record.expires_at !== undefined && Date.parse(record.expires_at) <= now.getTime()) return "expired";
  if (record.source_refs.length === 0) return "missing_source";
  if (record.trust !== "trusted") return "untrusted";
  if (record.scope.kind !== "global" && record.scope.project_id !== projectId) return "cross_project_scope";
  if (record.scope.kind === "run" && record.scope.run_id !== runId) return "cross_run_scope";
  return undefined;
}

function selectRetrievedHits(
  rawHits: readonly ReturnType<typeof RetrievalSearchResponseSchema.parse>["hits"][number][],
  budget: MemoryRecallBudget,
  estimate: (content: string) => number,
): MemoryRecallResult["hits"] {
  const unique = new Map<string, (typeof rawHits)[number]>();
  for (const hit of rawHits) {
    const current = unique.get(hit.chunk_id);
    if (current === undefined || hit.score > current.score) unique.set(hit.chunk_id, hit);
  }
  const ordered = [...unique.values()].sort((left, right) => (
    right.score - left.score || left.chunk_id.localeCompare(right.chunk_id)
  ));
  const selected: MemoryRecallResult["hits"][number][] = [];
  let used = 0;
  for (const hit of ordered) {
    if (selected.length >= budget.max_hits || used >= budget.max_tokens) break;
    const remaining = budget.max_tokens - used;
    const content = fitMemoryContent(hit.content, remaining, estimate);
    if (content === undefined) continue;
    const injectedTokens = estimate(content);
    const includedLineCount = content.split("\n").length;
    selected.push({
      content,
      attribution: {
        rank: selected.length + 1,
        hit_id: hit.chunk_id,
        content_hash: hit.content_hash,
        score: hit.score,
        source_path: hit.source_path,
        start_line: hit.start_line,
        end_line: Math.min(hit.end_line, hit.start_line + includedLineCount - 1),
        heading_path: hit.heading_path,
        injected_tokens: injectedTokens,
      },
    });
    used += injectedTokens;
  }
  return selected;
}

function fitMemoryContent(
  content: string,
  tokenBudget: number,
  estimate: (content: string) => number,
): string | undefined {
  if (tokenBudget <= 0) return undefined;
  const bounded = content.slice(0, 12_000);
  if (estimate(bounded) <= tokenBudget) return bounded;
  let low = 1;
  let high = bounded.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = bounded.slice(0, middle).trimEnd();
    if (candidate.length > 0 && estimate(candidate) <= tokenBudget) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best.length === 0 ? undefined : best;
}

function findDuplicateMemory(records: readonly MemoryRecord[], candidate: MemoryCandidate): MemoryRecord | undefined {
  const contentHash = sha256(candidate.content);
  return records.find((record) => (
    record.status === "confirmed"
    && (record.content_hash ?? sha256(record.content)) === contentHash
    && stableStringify(record.scope) === stableStringify(candidate.scope)
  ));
}

function assertCandidateScope(candidate: MemoryCandidate, projectId: string, runId: string): void {
  if (candidate.scope.kind !== "global" && candidate.scope.project_id !== projectId) {
    throw new MemoryStoreError("memory_scope_mismatch", "Memory candidate belongs to another project");
  }
  if (candidate.scope.kind === "run" && candidate.scope.run_id !== runId) {
    throw new MemoryStoreError("memory_scope_mismatch", "Memory candidate belongs to another run");
  }
}

function memorySourcePath(memoryId: string): string {
  return `memory/${encodeURIComponent(memoryId)}.md`;
}

function conservativeMemoryTokens(content: string): number {
  return Math.max(1, Math.ceil([...content].length / 3));
}

export class MemoryStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "MemoryStoreError";
    this.code = code;
  }
}

export function retrieveMemoryFixture(input: {
  records: readonly MemoryRecord[];
  projectId: string;
  runId: string;
  query: string;
  now?: Date;
  idFactory?: (prefix: string) => string;
}): { records: MemoryRecord[]; receipt: RetrievalReceipt } {
  const now = input.now ?? new Date();
  const retrieved: MemoryRecord[] = [];
  const blocked: string[] = [];
  const reasons: Record<string, string> = {};
  const supersededIds = new Set(
    input.records
      .filter((record) => record.status === "confirmed")
      .flatMap((record) => record.supersedes),
  );

  for (const record of input.records) {
    let reason: string | undefined;
    if (record.status !== "confirmed") {
      reason = `status_${record.status}`;
    } else if (supersededIds.has(record.memory_id)) {
      reason = "superseded";
    } else if (record.expires_at !== undefined && Date.parse(record.expires_at) <= now.getTime()) {
      reason = "expired";
    } else if (record.source_refs.length === 0) {
      reason = "missing_source";
    } else if (record.trust !== "trusted") {
      reason = "untrusted";
    } else if (record.scope.kind !== "global" && record.scope.project_id !== input.projectId) {
      reason = "cross_project_scope";
    } else if (record.scope.kind === "run" && record.scope.run_id !== input.runId) {
      reason = "cross_run_scope";
    }
    if (reason === undefined) {
      retrieved.push(record);
    } else {
      blocked.push(record.memory_id);
      reasons[record.memory_id] = reason;
    }
  }

  const receipt = RetrievalReceiptSchema.parse({
    retrieval_id: (input.idFactory ?? defaultIdFactory)("memory-retrieval"),
    project_id: input.projectId,
    run_id: input.runId,
    query: input.query,
    retrieved_memory_ids: retrieved.map((record) => record.memory_id),
    blocked_memory_ids: blocked,
    reasons,
    created_at: now.toISOString(),
  });
  return { records: retrieved, receipt };
}
