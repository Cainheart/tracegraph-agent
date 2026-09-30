import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryEpisodeExtractionInput, SessionEvent } from "@tracegraph/contracts";
import { sha256 } from "../../kernel/crypto.js";
import { JsonlEventLedger } from "../evidence/runtime-service.js";
import {
  JsonlMemoryV2RecordStore,
  MemoryControlService,
} from "./memory-control.js";
import { MemoryLifecycleService } from "./memory-lifecycle.js";
import { MemoryBackgroundPipeline, type MemoryEpisodeExtractor } from "./memory-background-pipeline.js";

const roots: string[] = [];
const pipelines: MemoryBackgroundPipeline[] = [];
const OWNER_ID = "owner:mem043-tests";
const PROJECT_ID = "project:mem043-tests";
const SCOPE = { allowedScopeIds: [PROJECT_ID] } as const;

afterEach(async () => {
  await Promise.all(pipelines.splice(0).map((pipeline) => pipeline.shutdown()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Memory background Episode pipeline", () => {
  it("recovers settled Runs, creates review-gated candidates with exact lineage, and replays without duplication", async () => {
    const fixture = await createFixture();
    const existing = await fixture.control.createCandidate({
      command_id: "command:mem043-active-source",
      kind: "fact",
      claim: "Deployment mode is canary.",
      normalized_key: "deployment mode",
      project_id: PROJECT_ID,
    }, SCOPE);
    await fixture.control.review(existing.record.memoryId, {
      command_id: "command:mem043-activate-source",
      expected_sequence: 0,
      action: "review_activate",
    }, SCOPE);
    const run = await appendSettledRun(fixture.ledger, "run-mem043-recovery", "Observed deployment mode is stable.");
    let extractionCalls = 0;
    const extractor: MemoryEpisodeExtractor = {
      id: "extractor:mem043-test-v1",
      canExtract: () => true,
      async extract(input) {
        extractionCalls += 1;
        return extractionResult(input, "Deployment mode is stable.", "deployment mode");
      },
    };
    const pipeline = createPipeline(fixture, extractor);

    // Recovery covers the crash window where the terminal event committed before scheduling.
    expect(await fixture.ledger.listRunIds()).toContain(run.runId);
    await pipeline.recoverSettledRuns();
    const state = await waitForJob(fixture.root, run.runId, (job) => job.status === "complete" || (job.attempts ?? 0) > 0);
    const listed = await fixture.control.list(SCOPE);
    const derived = listed.items.find(({ record }) => record.provenance.origin === "model_inference");

    expect(state).toMatchObject({ status: "complete", attempts: 1, candidateCount: 1 });
    expect(extractionCalls).toBe(1);
    expect(derived?.record).toMatchObject({
      status: "candidate",
      kind: "fact",
      claim: "Deployment mode is stable.",
      normalizedKey: "deployment mode",
      provenance: {
        origin: "model_inference",
        createdFromEpisode: expect.any(String),
        evidenceRefs: [{ kind: "run_event", runId: run.runId, projectId: PROJECT_ID }],
      },
      assessment: { verification: "inferred" },
      governance: { allowModelUse: false, allowExport: false },
      lineage: { derivedFrom: [existing.record.memoryId] },
    });
    expect(listed.items.find(({ record }) => record.memoryId === existing.record.memoryId)?.record)
      .toMatchObject({ status: "active", claim: "Deployment mode is canary." });

    const controlFacts = await fixture.ledger.listMemoryControl(OWNER_ID, derived!.record.memoryId);
    expect(controlFacts.map(({ action }) => action)).toEqual(["derived_candidate_created"]);
    expect(JSON.stringify(controlFacts)).not.toContain(derived!.record.claim);

    // A second startup/replay sees the durable completion projection and skips extraction.
    await pipeline.recoverSettledRuns();
    expect(extractionCalls).toBe(1);
    expect((await fixture.control.list(SCOPE)).items).toHaveLength(2);
    await pipeline.shutdown();
  });

  it("uses stable candidate slots after partial commit and retries a malformed evidence result", async () => {
    const fixture = await createFixture();
    const run = await appendSettledRun(fixture.ledger, "run-mem043-retry", "A durable fact from the settled Run.");
    let extractionCalls = 0;
    const extractor: MemoryEpisodeExtractor = {
      id: "extractor:mem043-retry-v1",
      canExtract: () => true,
      async extract(input) {
        extractionCalls += 1;
        const valid = extractionResult(input, "Run completed.");
        return extractionCalls === 1
          ? {
            ...valid,
            candidates: [
              valid.candidates[0]!,
              { kind: "fact", claim: "Uncited fact.", evidenceSequences: [99_999] },
            ],
          }
          : valid;
      },
    };
    const pipeline = createPipeline(fixture, extractor);
    pipeline.scheduleSettledRun(run.terminal);

    const retry = await waitForJob(fixture.root, run.runId, (job) => job.status === "retry" && (job.attempts ?? 0) > 0);
    expect(retry).toMatchObject({ attempts: 1, candidateCount: 0 });
    expect((await fixture.control.list(SCOPE)).items).toHaveLength(1);

    const complete = await waitForJob(fixture.root, run.runId, (job) => job.status === "complete");
    const candidates = (await fixture.control.list(SCOPE)).items;
    expect(complete).toMatchObject({ attempts: 2, candidateCount: 1 });
    expect(extractionCalls).toBe(2);
    expect(candidates).toHaveLength(1);
    expect((await fixture.ledger.listMemoryControl(OWNER_ID, candidates[0]!.record.memoryId))
      .filter(({ action }) => action === "derived_candidate_created")).toHaveLength(1);
    await pipeline.shutdown();
  });

  it("serializes separate pipeline instances with one owner lease", async () => {
    const fixture = await createFixture();
    const firstRun = await appendSettledRun(fixture.ledger, "run-mem043-lease-a", "First event-backed fact.");
    const secondRun = await appendSettledRun(fixture.ledger, "run-mem043-lease-b", "Second event-backed fact.");
    let activeExtractions = 0;
    let maxConcurrentExtractions = 0;
    const extractor: MemoryEpisodeExtractor = {
      id: "extractor:mem043-lease-v1",
      canExtract: () => true,
      async extract(input) {
        activeExtractions += 1;
        maxConcurrentExtractions = Math.max(maxConcurrentExtractions, activeExtractions);
        try {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return extractionResult(input, "Fact from " + input.runId + ".");
        } finally {
          activeExtractions -= 1;
        }
      },
    };
    const firstPipeline = createPipeline(fixture, extractor);
    const secondPipeline = createPipeline(fixture, extractor);

    firstPipeline.scheduleSettledRun(firstRun.terminal);
    secondPipeline.scheduleSettledRun(secondRun.terminal);
    await Promise.all([
      waitForJob(fixture.root, firstRun.runId, (job) => job.status === "complete"),
      waitForJob(fixture.root, secondRun.runId, (job) => job.status === "complete"),
    ]);

    expect(maxConcurrentExtractions).toBe(1);
    expect((await fixture.control.list(SCOPE)).items).toHaveLength(2);
    await Promise.all([firstPipeline.shutdown(), secondPipeline.shutdown()]);
  });

  it("takes over an expired owner lease and creates a candidate", async () => {
    const fixture = await createFixture();
    const run = await appendSettledRun(fixture.ledger, "run-mem043-stale-lease", "Recovered after a stale worker lease.");
    const ownerRoot = join(fixture.root, "memory-v2", "background", sha256(OWNER_ID).slice("sha256:".length));
    const leasePath = join(ownerRoot, "owner.lease");
    await mkdir(ownerRoot, { recursive: true });
    await writeFile(leasePath, "abandoned-worker", "utf8");
    const staleAt = new Date(Date.now() - 10 * 60_000);
    await utimes(leasePath, staleAt, staleAt);

    const extractor: MemoryEpisodeExtractor = {
      id: "extractor:mem043-stale-lease-v1",
      canExtract: () => true,
      async extract(input) {
        return extractionResult(input, "Recovered after a stale worker lease.");
      },
    };
    const pipeline = createPipeline(fixture, extractor);
    pipeline.scheduleSettledRun(run.terminal);

    const state = await waitForJob(fixture.root, run.runId, (job) => job.status === "complete");
    expect(state).toMatchObject({ status: "complete", attempts: 1, candidateCount: 1 });
    expect((await fixture.control.list(SCOPE)).items).toHaveLength(1);
    await pipeline.shutdown();
  });

  it("fails closed on source digest mismatch and deleted Run evidence", async () => {
    const fixture = await createFixture();
    const changedRun = await appendSettledRun(fixture.ledger, "run-mem043-source-changed", "Source changed before consolidation.");
    const extractorCalls: string[] = [];
    const extractor: MemoryEpisodeExtractor = {
      id: "extractor:mem043-source-guard-v1",
      canExtract: () => true,
      async extract(input) {
        extractorCalls.push(input.runId);
        return extractionResult(input, "Should not be created.");
      },
    };
    const pipeline = createPipeline(fixture, extractor);
    const ownerRoot = join(fixture.root, "memory-v2", "background", sha256(OWNER_ID).slice("sha256:".length));
    await mkdir(ownerRoot, { recursive: true });
    const changedStatePath = join(ownerRoot, sha256(changedRun.runId).slice("sha256:".length) + ".job.json");
    await writeFile(changedStatePath, JSON.stringify({
      schemaVersion: "tracegraph.memory-background-job.v1",
      runId: changedRun.runId,
      sourceDigest: sha256("different settled source"),
      status: "retry",
      attempts: 0,
      candidateCount: 0,
      updatedAt: new Date().toISOString(),
    }), "utf8");
    pipeline.scheduleSettledRun(changedRun.terminal);

    const changedState = await waitForJob(fixture.root, changedRun.runId, (job) => (job.attempts ?? 0) > 0);
    expect(changedState).toMatchObject({ status: "retry", attempts: 1, lastErrorCode: "memory_background_source_changed" });
    expect(extractorCalls).toEqual([]);

    const deletedRun = await appendSettledRun(fixture.ledger, "run-mem043-source-deleted", "This evidence will be deleted.");
    await rm(join(fixture.root, "events", deletedRun.runId + ".jsonl"));
    await pipeline.recoverSettledRuns();
    expect(extractorCalls).toEqual([]);
    expect((await fixture.control.list(SCOPE)).items).toEqual([]);
    await pipeline.shutdown();
  });

  it("leaves an in-flight extraction retryable and creates no candidate when shutdown cancels it", async () => {
    const fixture = await createFixture();
    const run = await appendSettledRun(fixture.ledger, "run-mem043-cancelled-extraction", "Cancellation must not create a Memory candidate.");
    let entered!: () => void;
    const extractionEntered = new Promise<void>((resolve) => { entered = resolve; });
    const extractor: MemoryEpisodeExtractor = {
      id: "extractor:mem043-cancel-v1",
      canExtract: () => true,
      async extract(_input, { signal }) {
        entered();
        return await new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(signal.reason ?? new Error("extraction aborted"));
          signal.addEventListener("abort", onAbort, { once: true });
        });
      },
    };
    const pipeline = createPipeline(fixture, extractor);
    pipeline.scheduleSettledRun(run.terminal);
    await extractionEntered;
    await pipeline.shutdown();

    const state = await waitForJob(fixture.root, run.runId, (job) => job.status === "retry");
    expect(state).toMatchObject({ status: "retry", attempts: 0, candidateCount: 0 });
    expect((await fixture.control.list(SCOPE)).items).toEqual([]);
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "tracegraph-mem043-pipeline-"));
  roots.push(root);
  let id = 0;
  const now = () => new Date("2026-09-30T12:00:00.000Z");
  const ledger = new JsonlEventLedger(join(root, "events"), {
    idFactory: (prefix) => prefix + ":mem043:" + (++id),
    now,
  });
  const records = new JsonlMemoryV2RecordStore(join(root, "memory-v2"));
  await records.initialize();
  const control = new MemoryControlService({
    ownerId: OWNER_ID,
    actorId: "user:mem043-tests",
    records,
    journal: ledger,
    lifecycle: new MemoryLifecycleService({ journal: ledger, now }),
    now,
  });
  return { root, ledger, records, control };
}

function createPipeline(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  extractor: MemoryEpisodeExtractor,
): MemoryBackgroundPipeline {
  const pipeline = new MemoryBackgroundPipeline({
    root: join(fixture.root, "memory-v2", "background"),
    ownerId: OWNER_ID,
    ledger: fixture.ledger,
    control: fixture.control,
    extractor,
  });
  pipelines.push(pipeline);
  return pipeline;
}

async function appendSettledRun(
  ledger: JsonlEventLedger,
  runId: string,
  evidenceSummary: string,
): Promise<{ runId: string; terminal: SessionEvent }> {
  await ledger.append({
    type: "run.created",
    project_id: PROJECT_ID,
    run_id: runId,
    attempt: 0,
    artifact_refs: [],
    summary: "A settled Memory extraction fixture Run.",
    data: {},
  });
  await ledger.append({
    type: "tool.completed",
    project_id: PROJECT_ID,
    run_id: runId,
    attempt: 0,
    artifact_refs: [],
    summary: evidenceSummary,
    data: {
      receipt: {
        tool_name: "read_file",
        status: "success",
        business_status: "success",
        summary: evidenceSummary,
      },
    },
  });
  const terminal = await ledger.append({
    type: "run.completed",
    project_id: PROJECT_ID,
    run_id: runId,
    attempt: 0,
    artifact_refs: [],
    summary: "Run completed",
    data: { code: "completed" },
  });
  return { runId: terminal.run_id, terminal };
}

function extractionResult(
  input: MemoryEpisodeExtractionInput,
  claim: string,
  normalizedKey?: string,
) {
  const rows = JSON.parse(input.sourceText) as Array<{ sequence: number; summary: string }>;
  const supportingRow = normalizedKey === undefined
    ? rows.at(-1)
    : rows.find(({ summary }) => summary.toLocaleLowerCase().includes(normalizedKey));
  if (supportingRow === undefined) throw new Error("Test extractor received no supporting evidence row");
  return {
    summary: "The Run has one test-fixture outcome.",
    candidates: [{
      kind: "fact" as const,
      claim,
      ...(normalizedKey === undefined ? {} : { normalizedKey }),
      evidenceSequences: [supportingRow.sequence],
    }],
  };
}

async function waitForJob(
  root: string,
  runId: string,
  predicate: (state: { status: string; attempts?: number; candidateCount?: number; lastErrorCode?: string }) => boolean,
): Promise<{ status: string; attempts?: number; candidateCount?: number; lastErrorCode?: string }> {
  const ownerRoot = join(root, "memory-v2", "background", sha256(OWNER_ID).slice("sha256:".length));
  const statePath = join(ownerRoot, sha256(runId).slice("sha256:".length) + ".job.json");
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await readFile(statePath, "utf8")) as {
        status: string;
        attempts?: number;
        candidateCount?: number;
        lastErrorCode?: string;
      };
      if (predicate(state)) return state;
    } catch {
      // State appears only after the terminal Run is claimed by the worker.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for Memory job state for " + runId);
}
