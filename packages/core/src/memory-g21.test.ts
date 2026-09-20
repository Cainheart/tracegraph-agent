import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryCandidateEvaluatedDataSchema,
  MemoryRecalledDataSchema,
  WorkspaceHandleSchema,
  type ContextManifest,
  type MemoryCandidate,
  type MemoryRecord,
  type SessionEventProposal,
} from "@tracegraph/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { DeterministicContextBuilder } from "./context.js";
import { sha256 } from "./crypto.js";
import { JsonlEventLedger } from "./event-ledger.js";
import {
  JsonlMemoryStore,
  MemoryManager,
  type MemoryRecordStore,
  type MemoryRetriever,
} from "./memory.js";
import { projectRun } from "./projection.js";
import { createAgentRuntime, type AgentRuntime } from "./runtime.js";
import type { ModelAdapter } from "./types.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("G-21 memory manager", () => {
  it("rejects illegal candidates before the ledger and records semantic rejection", async () => {
    const harness = await createHarness("reject");
    const manager = managerFor(harness.ledger, harness.store, undefined, sequenceIds());
    await expect(manager.remember({
      projectId: "project:one",
      runId: "run:one",
      sessionId: "session:one",
      candidate: { ...candidate(), unknown_key: true },
    })).rejects.toThrow();
    expect((await harness.ledger.list("run:one")).map((event) => event.type)).toEqual(["run.created"]);

    const rejected = await manager.remember({
      projectId: "project:one",
      runId: "run:one",
      sessionId: "session:one",
      candidate: { ...candidate(), source_refs: [] },
    });
    expect(rejected.admission.decision).toBe("rejected");
    const events = await harness.ledger.list("run:one");
    expect(events.map((event) => event.type)).toEqual(["run.created", "memory.candidate_evaluated"]);
    expect(events[1]?.data).toMatchObject({ accepted: false, reason: expect.stringContaining("source") });
    expect(events[1]?.data).not.toHaveProperty("content");

    const retried = await manager.remember({
      projectId: "project:one",
      runId: "run:one",
      sessionId: "session:one",
      candidate: { ...candidate(), source_refs: [] },
    });
    expect(retried.admission).toEqual(rejected.admission);
    expect((await harness.ledger.list("run:one"))).toHaveLength(2);
    await expect(manager.remember({
      projectId: "project:one",
      runId: "run:one",
      sessionId: "session:one",
      candidate: { ...candidate(), content: "conflicting rejected candidate", source_refs: [] },
    })).rejects.toMatchObject({ code: "memory_candidate_conflict" });
  });

  it("writes, indexes, recalls, and injects attributed retrieval nodes within budget", async () => {
    const harness = await createHarness("happy");
    const retriever = new FixtureRetriever();
    const manager = managerFor(harness.ledger, harness.store, retriever, sequenceIds());
    const remembered = await manager.remember({
      projectId: "project:one",
      runId: "run:one",
      sessionId: "session:one",
      candidate: candidate(),
    });
    expect(remembered.record?.content_hash).toBe(sha256(candidate().content));

    const recalled = await manager.recall({
      projectId: "project:one",
      runId: "run:one",
      sessionId: "session:one",
      query: "durable fact",
      budget: { max_tokens: 24, max_hits: 1 },
    });
    expect(recalled.hits).toHaveLength(1);
    expect(recalled.data.injected_tokens).toBeLessThanOrEqual(24);
    expect(recalled.hits[0]?.attribution).toMatchObject({
      hit_id: "chunk:guide",
      score: 8.25,
      source_path: "docs/guide.md",
      start_line: 10,
    });

    const built = new DeterministicContextBuilder({
      now: () => new Date("2026-09-19T00:00:03.000Z"),
      idFactory: sequenceIds(),
    }).build({
      projectId: "project:one",
      runId: "run:one",
      turnId: "turn:one",
      modelCallId: "model-call:one",
      task: "Use the guide",
      workspaceKind: "readonly_local",
      observations: [],
      retrievedMemory: recalled.hits,
      tokenLimit: 2_000,
      reservedOutputTokens: 256,
    });
    const memoryItem = built.manifest.items.find((item) => item.section === "memory");
    const memoryNode = built.manifest.nodes?.find((node) => node.kind === "retrieved");
    expect(memoryItem).toMatchObject({ action: "retrieved", retrieval: { hit_id: "chunk:guide" } });
    expect(memoryNode).toMatchObject({ section: "memory", kind: "retrieved", retrieval: { score: 8.25 } });
    expect(built.modelContext).toContain("[memory]");

    const events = await harness.ledger.list("run:one");
    expect(events.map((event) => event.type)).toEqual([
      "run.created",
      "memory.candidate_evaluated",
      "memory.written",
      "retrieval.index_updated",
      "memory.recalled",
    ]);
    const recallData = MemoryRecalledDataSchema.parse(events.at(-1)?.data);
    expect(recallData.query_hash).toBe(sha256("durable fact"));
    expect(events.at(-1)?.data).not.toHaveProperty("query");

    const projectionBefore = projectRun(events);
    const reopened = new JsonlEventLedger(harness.eventsDir);
    const projectionAfter = projectRun(await reopened.list("run:one"));
    expect(projectionAfter).toEqual(projectionBefore);
  });

  it("recovers an admitted record after a crash seam without creating a second memory", async () => {
    const harness = await createHarness("retry");
    const store = new PersistThenFailStore();
    const manager = managerFor(harness.ledger, store, undefined, sequenceIds());
    const input = {
      projectId: "project:one",
      runId: "run:one",
      sessionId: "session:one",
      candidate: candidate(),
    } as const;

    await expect(manager.remember(input)).rejects.toThrow("injected post-persist failure");
    expect(store.records).toHaveLength(1);
    expect((await harness.ledger.list("run:one")).map((event) => event.type)).toEqual([
      "run.created",
      "memory.candidate_evaluated",
    ]);

    const recovered = await manager.remember(input);
    expect(recovered.record?.memory_id).toBe(store.records[0]?.memory_id);
    expect(store.records).toHaveLength(1);
    const events = await harness.ledger.list("run:one");
    expect(events.filter((event) => event.type === "memory.candidate_evaluated")).toHaveLength(1);
    expect(events.filter((event) => event.type === "memory.written")).toHaveLength(1);

    await expect(manager.remember({
      ...input,
      candidate: { ...candidate(), content: "conflicting reuse" },
    })).rejects.toMatchObject({ code: "memory_candidate_conflict" });
  });

  it("reuses the committed admission after failure before the Memory store write", async () => {
    const harness = await createHarness("retry-before-store");
    const store = new FailBeforePersistStore();
    const manager = managerFor(harness.ledger, store, undefined, sequenceIds());
    const input = {
      projectId: "project:one",
      runId: "run:one",
      sessionId: "session:one",
      candidate: candidate(),
    } as const;

    await expect(manager.remember(input)).rejects.toThrow("injected pre-persist failure");
    const evaluated = (await harness.ledger.list("run:one")).at(-1);
    expect(evaluated?.type).toBe("memory.candidate_evaluated");
    const committedMemoryId = MemoryCandidateEvaluatedDataSchema.parse(evaluated?.data).resulting_memory_id;

    const recovered = await manager.remember(input);
    expect(recovered.record?.memory_id).toBe(committedMemoryId);
    expect(store.records).toHaveLength(1);
    expect((await harness.ledger.list("run:one")).filter((event) => (
      event.type === "memory.candidate_evaluated"
    ))).toHaveLength(1);
  });

  it("fails retrieval closed to an empty, durable degraded recall", async () => {
    const harness = await createHarness("degraded");
    const retriever: MemoryRetriever = {
      async search() {
        return { project_id: "project:one", hits: [{ injected: "invalid" }] };
      },
    };
    const manager = managerFor(harness.ledger, harness.store, retriever, sequenceIds());
    const result = await manager.recall({
      projectId: "project:one",
      runId: "run:one",
      sessionId: "session:one",
      query: "unsafe response",
      budget: { max_tokens: 20, max_hits: 2 },
    });
    expect(result.hits).toEqual([]);
    expect(result.data).toMatchObject({ status: "degraded", failure_code: "retriever_invalid_response" });
    const event = (await harness.ledger.list("run:one")).at(-1);
    expect(event?.type).toBe("memory.recalled");
    expect(event?.data).not.toHaveProperty("query");
  });

  it("blocks a BM25 hit when its canonical Memory record belongs to another Run", async () => {
    const harness = await createHarness("run-scope");
    const retriever = new StoredMemoryRetriever();
    const manager = managerFor(harness.ledger, harness.store, retriever, sequenceIds());
    await manager.remember({
      projectId: "project:one",
      runId: "run:one",
      sessionId: "session:one",
      candidate: {
        ...candidate(),
        scope: { kind: "run", project_id: "project:one", run_id: "run:one" },
      },
    });
    await harness.ledger.append(runCreated("run:two"));

    const recalled = await manager.recall({
      projectId: "project:one",
      runId: "run:two",
      sessionId: "session:one",
      query: "durable fact",
    });
    expect(recalled.hits).toEqual([]);
    expect(recalled.data.blocked_hits).toEqual([{
      hit_id: "chunk:stored-memory",
      reason: "cross_run_scope",
    }]);
    expect((await harness.ledger.list("run:two")).at(-1)?.data).toMatchObject({
      blocked_hits: [{ hit_id: "chunk:stored-memory", reason: "cross_run_scope" }],
      injected_tokens: 0,
    });
  });

  it("indexes global Memory separately and recalls it from another project", async () => {
    const harness = await createHarness("global-scope");
    const retriever = new ProjectScopedMemoryRetriever();
    const manager = managerFor(harness.ledger, harness.store, retriever, sequenceIds());
    await manager.remember({
      projectId: "project:one",
      runId: "run:one",
      sessionId: "session:one",
      candidate: { ...candidate(), scope: { kind: "global" } },
    });
    await harness.ledger.append(runCreated("run:two", "project:two"));

    const recalled = await manager.recall({
      projectId: "project:two",
      runId: "run:two",
      sessionId: "session:one",
      query: "durable fact",
    });

    expect(retriever.searchProjects).toEqual([
      "project:two",
      "tracegraph:global-memory",
    ]);
    expect(recalled.hits).toHaveLength(1);
    expect(recalled.hits[0]?.content).toContain("durable fact");
    expect(recalled.data.blocked_hits).toEqual([]);
  });

  it("automatically injects retrieval into a production Run before the model request", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracegraph-memory-runtime-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    let seenManifest: ContextManifest | undefined;
    const model: ModelAdapter = {
      name: "g21-capture-model",
      async decide(input) {
        seenManifest = input.contextManifest;
        return {
          decision_id: "decision:g21-finish",
          kind: "finish",
          public_reason: "Retrieved evidence is sufficient.",
          evidence_refs: [],
          risk: "none",
          final_answer: "Completed with retrieval.",
        };
      },
    };
    const runtime = await createAgentRuntime({
      dataDir: join(root, "data"),
      model,
      retriever: new FixtureRetriever(),
      retrievalBudget: { max_tokens: 64, max_hits: 2 },
    });
    const workspace = WorkspaceHandleSchema.parse({
      handle_id: "workspace:g21",
      project_id: "project:one",
      real_root: workspaceRoot,
      workspace_kind: "readonly_local",
      capabilities: {
        index: false,
        read: false,
        search: false,
        run_command: false,
        preview_patch: false,
        commit_patch: false,
        test: false,
      },
      created_at: "2026-09-19T00:00:00.000Z",
    });
    const started = await runtime.startRun({
      command_id: "command:g21-runtime",
      project_id: workspace.project_id,
      task: "Use the durable fact from the guide.",
      mode: "execute",
      workspace,
    });
    const completed = await waitForTerminal(runtime, started.run_id);
    expect(completed.status).toBe("completed");
    expect(completed.timeline.map((event) => event.type)).toContain("memory.recalled");
    expect(completed.timeline.findIndex((event) => event.type === "memory.recalled"))
      .toBeLessThan(completed.timeline.findIndex((event) => event.type === "context.built"));
    expect(seenManifest?.items.some((item) => (
      item.section === "memory" && item.action === "retrieved" && item.retrieval?.source_path === "docs/guide.md"
    ))).toBe(true);
    expect(seenManifest?.nodes?.some((node) => node.kind === "retrieved")).toBe(true);
  });
});

class FixtureRetriever implements MemoryRetriever {
  async ingest(input: { project_id: string; source_path: string; content: string }) {
    return {
      schema_version: "tracegraph.retrieval.v1",
      project_id: input.project_id,
      source_path: input.source_path,
      document_hash: sha256(input.content),
      status: "updated",
      generation: 1,
      source_chunk_count: 1,
      total_indexed_chunks: 1,
    };
  }

  async search(input: { project_id: string; query: string; top_k?: number }) {
    const content = "A long retrieved fact with enough words to exercise the explicit token budget and line provenance.";
    return {
      schema_version: "tracegraph.retrieval.v1",
      project_id: input.project_id,
      query_hash: sha256(input.query),
      total_indexed_chunks: 1,
      hits: [{
        rank: 1,
        chunk_id: "chunk:guide",
        content_hash: sha256(content),
        score: 8.25,
        source_path: "docs/guide.md",
        start_line: 10,
        end_line: 12,
        heading_path: ["Guide", "Durability"],
        content,
      }],
    };
  }
}

class StoredMemoryRetriever implements MemoryRetriever {
  #stored: { project_id: string; source_path: string; content: string } | undefined;

  async ingest(input: { project_id: string; source_path: string; content: string }) {
    this.#stored = input;
    return {
      schema_version: "tracegraph.retrieval.v1",
      project_id: input.project_id,
      source_path: input.source_path,
      document_hash: sha256(input.content),
      status: "updated",
      generation: 1,
      source_chunk_count: 1,
      total_indexed_chunks: 1,
    };
  }

  async search(input: { project_id: string; query: string; top_k?: number }) {
    const stored = this.#stored;
    if (stored === undefined) throw new Error("fixture was not indexed");
    return {
      schema_version: "tracegraph.retrieval.v1",
      project_id: input.project_id,
      query_hash: sha256(input.query),
      total_indexed_chunks: 1,
      hits: [{
        rank: 1,
        chunk_id: "chunk:stored-memory",
        content_hash: sha256(stored.content),
        score: 4.5,
        source_path: stored.source_path,
        start_line: 1,
        end_line: 1,
        heading_path: [],
        content: stored.content,
      }],
    };
  }
}

class ProjectScopedMemoryRetriever implements MemoryRetriever {
  readonly #stored = new Map<string, { source_path: string; content: string }>();
  readonly searchProjects: string[] = [];

  async ingest(input: { project_id: string; source_path: string; content: string }) {
    this.#stored.set(input.project_id, input);
    return {
      schema_version: "tracegraph.retrieval.v1",
      project_id: input.project_id,
      source_path: input.source_path,
      document_hash: sha256(input.content),
      status: "updated",
      generation: 1,
      source_chunk_count: 1,
      total_indexed_chunks: 1,
    };
  }

  async search(input: { project_id: string; query: string; top_k?: number }) {
    this.searchProjects.push(input.project_id);
    const stored = this.#stored.get(input.project_id);
    return {
      schema_version: "tracegraph.retrieval.v1",
      project_id: input.project_id,
      query_hash: sha256(input.query),
      total_indexed_chunks: stored === undefined ? 0 : 1,
      hits: stored === undefined ? [] : [{
        rank: 1,
        chunk_id: "chunk:global-memory",
        content_hash: sha256(stored.content),
        score: 6.5,
        source_path: stored.source_path,
        start_line: 1,
        end_line: 1,
        heading_path: [],
        content: stored.content,
      }],
    };
  }
}

class PersistThenFailStore implements MemoryRecordStore {
  readonly records: MemoryRecord[] = [];
  #fail = true;

  async initialize(): Promise<void> {}

  async list(): Promise<readonly MemoryRecord[]> {
    return this.records;
  }

  async write(record: MemoryRecord): Promise<void> {
    if (!this.records.some((item) => item.memory_id === record.memory_id)) this.records.push(record);
    if (this.#fail) {
      this.#fail = false;
      throw new Error("injected post-persist failure");
    }
  }
}

class FailBeforePersistStore implements MemoryRecordStore {
  readonly records: MemoryRecord[] = [];
  #fail = true;

  async initialize(): Promise<void> {}

  async list(): Promise<readonly MemoryRecord[]> {
    return this.records;
  }

  async write(record: MemoryRecord): Promise<void> {
    if (this.#fail) {
      this.#fail = false;
      throw new Error("injected pre-persist failure");
    }
    if (!this.records.some((item) => item.memory_id === record.memory_id)) this.records.push(record);
  }
}

function candidate(): MemoryCandidate {
  return {
    candidate_id: "candidate:one",
    content: "A durable fact from an attributable user source.",
    scope: { kind: "project", project_id: "project:one" },
    origin: "user",
    trust: "trusted",
    source_refs: [{ source_id: "user:message:1", source_type: "user", trust: "trusted" }],
    proposed_at: "2026-09-19T00:00:01.000Z",
    supersedes: [],
  };
}

function managerFor(
  ledger: JsonlEventLedger,
  store: MemoryRecordStore,
  retriever: MemoryRetriever | undefined,
  idFactory: (prefix: string) => string,
): MemoryManager {
  return new MemoryManager({
    store,
    events: ledger,
    ...(retriever === undefined ? {} : { retriever }),
    now: () => new Date("2026-09-19T00:00:02.000Z"),
    idFactory,
    estimateTokens: (content) => Math.max(1, Math.ceil(content.length / 4)),
  });
}

async function createHarness(name: string): Promise<{
  ledger: JsonlEventLedger;
  store: JsonlMemoryStore;
  eventsDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `tracegraph-memory-${name}-`));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const eventsDir = join(root, "events");
  const ledger = new JsonlEventLedger(eventsDir, {
    now: () => new Date("2026-09-19T00:00:00.000Z"),
    idFactory: sequenceIds(),
  });
  const store = new JsonlMemoryStore(join(root, "memory", "records.jsonl"));
  await Promise.all([ledger.initialize(), store.initialize()]);
  await ledger.append(runCreated());
  return { ledger, store, eventsDir };
}

function runCreated(runId = "run:one", projectId = "project:one"): SessionEventProposal {
  return {
    type: "run.created",
    project_id: projectId,
    run_id: runId,
    session_id: "session:one",
    attempt: 0,
    summary: "Run created",
    artifact_refs: [],
    data: {
      task: "Use durable memory",
      mode: "execute",
      workspace_kind: "readonly_local",
    },
  };
}

function sequenceIds(): (prefix: string) => string {
  let sequence = 0;
  return (prefix) => `${prefix}:${++sequence}`;
}

async function waitForTerminal(runtime: AgentRuntime, runId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const projection = await runtime.getProjection(runId);
    if (["completed", "failed", "cancelled"].includes(projection.status)) return projection;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for G-21 runtime completion");
}
