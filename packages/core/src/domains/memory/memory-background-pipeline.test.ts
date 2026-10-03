import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryEpisodeExtractionInput, SessionEvent } from "@tracegraph/contracts";
import { sha256, stableStringify } from "../../kernel/crypto.js";
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
  it("never extracts a trusted media Run during live settlement or recovery, while ordinary Runs still extract", async () => {
    const fixture = await createFixture();
    const calls:string[]=[];
    const pipeline=createPipeline(fixture,{id:"extractor:no-media-billing",canExtract:()=>true,
      async extract(input){calls.push(input.runId);return extractionResult(input,"Ordinary Run evidence.");}});
    const media=await appendSettledRun(fixture.ledger,"run:local-media","Verified SVG created.",{background_model_derivation:false});
    pipeline.scheduleSettledRun(media.terminal);
    const ordinary=await appendSettledRun(fixture.ledger,"run:ordinary-after-media","Ordinary Run evidence.");
    pipeline.scheduleSettledRun(ordinary.terminal);
    await waitForIndexedJob(pipeline,ordinary.runId,"complete");
    expect(calls).toEqual([ordinary.runId]);
    await pipeline.shutdown();
    const recovered=createPipeline(fixture,{id:"extractor:no-media-recovery",canExtract:()=>true,
      async extract(input){calls.push(input.runId);return extractionResult(input,"Unexpected extraction.");}});
    await recovered.recoverSettledRuns();
    expect(calls).toEqual([ordinary.runId]);
    expect((await recovered.listJobs(SCOPE)).some(job=>job.runId===media.runId)).toBe(false);
  });

  it("uses authenticated user correction ancestry for cross-Run exact and changed-key consolidation", async () => {
    const fixture = await createFixture();
    const pipeline = createPipeline(fixture, { id: "extractor:correction-chain", canExtract: () => true,
      async extract(input) {
        const claim = input.runId.endsWith("origin") ? "Deployment mode is canary."
          : input.runId.endsWith("changed") ? "Deployment mode is blue-green." : "Deployment mode is stable.";
        return extractionResult(input, claim, "deployment mode");
      } });
    const originalRun = await appendSettledRun(fixture.ledger, "run:correction:origin", "Deployment mode is canary.");
    pipeline.scheduleSettledRun(originalRun.terminal);
    const source = await waitForIndexedJob(pipeline, originalRun.runId, "complete");
    const sourceId = source.consolidationResults[0]!.memoryId;
    await fixture.control.review(sourceId, { command_id: "activate:origin", expected_sequence: 0, action: "review_activate" }, SCOPE);
    const corrected = await fixture.control.correct(sourceId, { command_id: "correct:origin", expected_sequence: 1, claim: "Deployment mode is stable." }, SCOPE);
    await fixture.control.review(corrected.record.memoryId, { command_id: "activate:correction", expected_sequence: 0, action: "review_activate" }, SCOPE);
    for (const suffix of ["exact", "changed"]) {
      const run = await appendSettledRun(fixture.ledger, `run:correction:${suffix}`, "Deployment mode was observed.");
      pipeline.scheduleSettledRun(run.terminal);
      const job = await waitForIndexedJob(pipeline, run.runId, "complete");
      expect(job.consolidationResults[0]).toMatchObject({ action: suffix === "exact" ? "unchanged" : "candidate",
        comparedMemoryIds: [corrected.record.memoryId], sourceRunIds: [run.runId, originalRun.runId] });
    }
    expect((await fixture.control.list(SCOPE)).items.find(({ record }) => record.memoryId === corrected.record.memoryId)?.record.status).toBe("active");
  });

  it.each(["missing_parent", "forged_user_ref", "deleted_run"])("does not trust corrected model Memory with %s ancestry", async (failure) => {
    const fixture = await createFixture();
    const pipeline = createPipeline(fixture, { id: "extractor:correction-negative", canExtract: () => true,
      async extract(input) { return extractionResult(input, input.runId.endsWith("origin") ? "Deployment mode is old." : "Deployment mode is corrected.", "deployment mode"); } });
    const run = await appendSettledRun(fixture.ledger, "run:negative:origin", "Deployment mode is old.");
    pipeline.scheduleSettledRun(run.terminal);
    const sourceId = (await waitForIndexedJob(pipeline, run.runId, "complete")).consolidationResults[0]!.memoryId;
    const corrected = await fixture.control.correct(sourceId, { command_id: "correct:negative", expected_sequence: 0, claim: "Deployment mode is corrected." }, SCOPE);
    await fixture.control.review(corrected.record.memoryId, { command_id: "activate:negative", expected_sequence: 0, action: "review_activate" }, SCOPE);
    if (failure === "missing_parent") await fixture.records.delete(OWNER_ID, [sourceId]);
    if (failure === "deleted_run") await rm(join(fixture.root, "events", run.runId.replaceAll(":", "_") + ".jsonl"));
    if (failure === "forged_user_ref") {
      const path = join(fixture.root, "memory-v2", sha256(OWNER_ID).slice(7), "records.jsonl");
      const rows = (await fixture.records.list(OWNER_ID)).map((record) => record.memoryId !== corrected.record.memoryId ? record : {
        ...record, provenance: { ...record.provenance, evidenceRefs: [...record.provenance.evidenceRefs.slice(0, -1), {
          source_id: "source:forged", source_type: "user", trust: "trusted", description: "User-authored correction",
        }] },
      });
      await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    }
    const next = await appendSettledRun(fixture.ledger, "run:negative:next", "Deployment mode is corrected.");
    pipeline.scheduleSettledRun(next.terminal);
    expect((await waitForIndexedJob(pipeline, next.runId, "complete")).consolidationResults[0])
      .toMatchObject({ action: "candidate", comparedMemoryIds: [], sourceRunIds: [next.runId] });
  });

  it("serves a bounded scoped index without ledger reads across large project histories", async () => {
    const fixture = await createFixture();
    const template = await appendSettledRun(fixture.ledger, "run:template", "Synthetic historical evidence.");
    const source = await fixture.ledger.list(template.runId);
    const history = new Map<string, SessionEvent[]>();
    const states: Promise<void>[] = [];
    await mkdir(join(fixture.root, "memory-v2", "background", sha256(OWNER_ID).slice(7)), { recursive: true });
    for (let index = 0; index < 350; index += 1) {
      const projectId = index < 175 ? PROJECT_ID : "project:other";
      const runId = `run:history:${index}`;
      let previous: string | undefined;
      history.set(runId, source.map(({ event_hash: _hash, previous_event_hash: _previous, ...value }) => {
        const body = { ...value, run_id: runId, project_id: projectId, ...(previous === undefined ? {} : { previous_event_hash: previous }) };
        const event = { ...body, event_hash: sha256(stableStringify(body)) };
        previous = event.event_hash;
        return event;
      }));
      states.push(writeFile(memoryJobStatePath(fixture.root, runId), JSON.stringify({ schemaVersion: "tracegraph.memory-background-job.v1",
        runId, status: "complete", attempts: 1, candidateCount: 1, updatedAt: new Date(Date.UTC(2026, 9, 3, 0, 0, index)).toISOString() })));
    }
    await Promise.all(states);
    let reads = 0;
    const pipeline = new MemoryBackgroundPipeline({ root: join(fixture.root, "memory-v2", "background"), ownerId: OWNER_ID,
      control: fixture.control, ledger: { list: async (id) => { reads += 1; return history.get(id) ?? []; },
        listRunIds: async () => [...history.keys()], subscribe: () => () => undefined } });
    pipelines.push(pipeline);
    expect(pipeline.historyLoaded).toBe(false);
    expect(await pipeline.listJobs({ allowedScopeIds: [] })).toEqual([]);
    expect(reads).toBe(0);
    await pipeline.recoverSettledRuns();
    expect(pipeline.historyLoaded).toBe(true);
    expect(reads).toBe(350);
    reads = 0;
    for (let repeat = 0; repeat < 4; repeat += 1) {
      expect(await pipeline.listJobs({ allowedScopeIds: [] })).toEqual([]);
      const selected = await pipeline.listJobs(SCOPE);
      expect(selected).toHaveLength(100);
      expect(selected.every((job) => job.projectId === PROJECT_ID)).toBe(true);
      expect(selected[0]?.runId).toBe("run:history:174");
      const all = await pipeline.listJobs({ allowedScopeIds: [PROJECT_ID, "project:other"] });
      expect(all).toHaveLength(100);
      expect(all[0]?.runId).toBe("run:history:349");
    }
    expect(reads).toBe(0);
  });

  it("consolidates across settled Runs into inspectable unchanged/diff results without rewriting active Memory", async () => {
    const fixture = await createFixture();
    const extractor: MemoryEpisodeExtractor = {
      id: "extractor:cross-run-v1", canExtract: () => true,
      async extract(input) {
        return extractionResult(input, input.runId.endsWith("changed") ? "Deployment mode is stable." : "Deployment mode is canary.", "deployment mode");
      },
    };
    const pipeline = createPipeline(fixture, extractor);
    const first = await appendSettledRun(fixture.ledger, "run:cross:first", "Deployment mode is canary.");
    pipeline.scheduleSettledRun(first.terminal);
    await waitForIndexedJob(pipeline, first.runId, "complete");
    const original = (await fixture.control.list(SCOPE)).items[0]!;
    await fixture.control.review(original.record.memoryId, { command_id: "review:cross-first", expected_sequence: 0, action: "review_activate" }, SCOPE);
    const duplicate = await appendSettledRun(fixture.ledger, "run:cross:duplicate", "Deployment mode is canary.");
    pipeline.scheduleSettledRun(duplicate.terminal);
    await waitForIndexedJob(pipeline, duplicate.runId, "complete");
    const changed = await appendSettledRun(fixture.ledger, "run:cross:changed", "Deployment mode is stable.");
    pipeline.scheduleSettledRun(changed.terminal);
    await waitForIndexedJob(pipeline, changed.runId, "complete");

    const jobs = await pipeline.listJobs(SCOPE);
    expect(jobs.find((job) => job.runId === duplicate.runId)).toMatchObject({
      candidateCount: 0, consolidationResults: [{ action: "unchanged", memoryId: original.record.memoryId,
        comparedMemoryIds: [original.record.memoryId], sourceRunIds: [duplicate.runId, first.runId] }],
    });
    expect(jobs.find((job) => job.runId === changed.runId)).toMatchObject({
      candidateCount: 1, consolidationResults: [{ action: "candidate", comparedMemoryIds: [original.record.memoryId],
        sourceRunIds: [changed.runId, first.runId] }],
    });
    const records = (await fixture.control.list(SCOPE)).items;
    expect(records).toHaveLength(2);
    expect(records.find(({ record }) => record.memoryId === original.record.memoryId)?.record).toMatchObject({ status: "active", claim: "Deployment mode is canary." });
    expect(records.find(({ record }) => record.memoryId !== original.record.memoryId)?.record).toMatchObject({
      status: "candidate", claim: "Deployment mode is stable.", governance: { allowModelUse: false, allowExport: false },
      lineage: { derivedFrom: [original.record.memoryId], supersedes: [] },
    });
    expect(JSON.stringify(jobs)).not.toContain("Deployment mode");
    expect(await pipeline.listJobs({ allowedScopeIds: [] })).toEqual([]);
    await pipeline.shutdown();
    const restarted = createPipeline(fixture, { ...extractor, extract: async () => { throw new Error("completed jobs must not extract again"); } });
    await restarted.recoverSettledRuns();
    expect(await restarted.listJobs(SCOPE)).toEqual(jobs);
  });

  it("does not consolidate from another project, an uncommitted seed, revoked Memory or deleted Run evidence", async () => {
    const fixture = await createFixture();
    const claim = "Deployment mode is stable.";
    const foreign = await fixture.control.createCandidate({ command_id: "foreign:seed", kind: "fact", claim,
      normalized_key: "deployment mode", project_id: "project:foreign" }, { allowedScopeIds: ["project:foreign"] });
    await fixture.records.writeCandidate({ ...foreign.record, memoryId: "memory:uncommitted", scope: { ...foreign.record.scope, projectId: PROJECT_ID } });
    const revoked = await fixture.control.createCandidate({ command_id: "revoked:seed", kind: "fact", claim,
      normalized_key: "deployment mode", project_id: PROJECT_ID }, SCOPE);
    await fixture.control.revoke(revoked.record.memoryId, { command_id: "revoke:seed", expected_sequence: 0 }, SCOPE);
    const extractor: MemoryEpisodeExtractor = { id: "extractor:negative-v1", canExtract: () => true,
      async extract(input) { return extractionResult(input, claim, "deployment mode"); } };
    const pipeline = createPipeline(fixture, extractor);
    const first = await appendSettledRun(fixture.ledger, "run-negative-first", claim);
    pipeline.scheduleSettledRun(first.terminal);
    await waitForIndexedJob(pipeline, first.runId, "complete");
    const firstJob = (await pipeline.listJobs(SCOPE))[0]!;
    expect(firstJob.consolidationResults).toMatchObject([{ action: "candidate", comparedMemoryIds: [], sourceRunIds: [first.runId] }]);
    expect(JSON.stringify(firstJob)).not.toContain(foreign.record.memoryId);
    await rm(join(fixture.root, "events", first.runId + ".jsonl"));
    const second = await appendSettledRun(fixture.ledger, "run-negative-second", claim);
    pipeline.scheduleSettledRun(second.terminal);
    await waitForJob(fixture.root, second.runId, (job) => job.status === "complete");
    await pipeline.recoverSettledRuns();
    const jobs = await pipeline.listJobs(SCOPE);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.consolidationResults).toMatchObject([{ action: "candidate", comparedMemoryIds: [], sourceRunIds: [second.runId] }]);
  });

  it("rejects changed extractor output after an unchanged cross-Run slot was persisted", async () => {
    const fixture = await createFixture();
    const original = await fixture.control.createCandidate({ command_id: "unchanged:seed", kind: "fact",
      claim: "Deployment mode is stable.", normalized_key: "deployment mode", project_id: PROJECT_ID }, SCOPE);
    const run = await appendSettledRun(fixture.ledger, "run:changed:slot", "Deployment mode is stable.");
    let calls = 0;
    let enabled = true;
    const extractor: MemoryEpisodeExtractor = { id: "extractor:changed-slot", canExtract: () => enabled,
      async extract(input) {
        calls += 1;
        if (calls === 1) enabled = false;
        const value = extractionResult(input, calls === 1 ? original.record.claim : "Deployment mode is altered.", "deployment mode");
        return calls === 1 ? { ...value, candidates: [...value.candidates, { kind: "fact", claim: "Uncited", evidenceSequences: [999] }] } : value;
      } };
    const pipeline = createPipeline(fixture, extractor);
    pipeline.scheduleSettledRun(run.terminal);
    await waitForJob(fixture.root, run.runId, (job) => job.status === "retry");
    await pipeline.shutdown();
    // Restart with no available adapter and explicitly schedule the durable Run,
    // avoiding a wall-clock backoff dependency while checking preserved results.
    const restarted = createPipeline(fixture, extractor);
    restarted.scheduleSettledRun(run.terminal);
    await waitForIndexedJob(restarted, run.runId, "waiting");
    expect((await restarted.listJobs(SCOPE))[0]?.consolidationResults).toMatchObject([{ action: "unchanged", memoryId: original.record.memoryId }]);
    enabled = true;
    await restarted.resumeWaiting();
    const job = await waitForIndexedJob(restarted, run.runId, "retry", 2);
    expect(job).toMatchObject({ status: "retry", attempts: 2, candidateCount: 0,
      lastErrorCode: "memory_background_result_changed", consolidationResults: [{ action: "unchanged", memoryId: original.record.memoryId }] });
    expect((await fixture.control.list(SCOPE)).items).toHaveLength(1);
  });

  it("exposes waiting and legacy retry/exhausted jobs while sanitizing adapter error codes", async () => {
    const fixture = await createFixture();
    const run = await appendSettledRun(fixture.ledger, "run-job-state", "Do not store extracted text in job metadata.");
    const pipeline = createPipeline(fixture, { id: "extractor:waiting", canExtract: () => false, async extract() { throw new Error("disabled"); } });
    pipeline.scheduleSettledRun(run.terminal);
    await waitForIndexedJob(pipeline, run.runId, "waiting");
    expect((await pipeline.listJobs(SCOPE))[0]).toMatchObject({ status: "waiting", attempts: 0, consolidationResults: [] });
    await pipeline.shutdown();
    const statePath = memoryJobStatePath(fixture.root, run.runId);
    await writeFile(statePath, JSON.stringify({ schemaVersion: "tracegraph.memory-background-job.v1", runId: run.runId,
      status: "retry", attempts: 4, candidateCount: 4, nextAttemptAt: "2099-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z" }));
    const restarted = createPipeline(fixture, { id: "extractor:failure", canExtract: () => true,
      async extract() { throw Object.assign(new Error("private error text"), { code: "private_token_contents" }); } });
    expect(restarted.historyLoaded).toBe(false);
    expect(await restarted.listJobs(SCOPE)).toEqual([]);
    await restarted.recoverSettledRuns();
    expect((await restarted.listJobs(SCOPE))[0]).toMatchObject({ status: "retry", nextAttemptAt: "2099-09-30T00:00:00.000Z", candidateCount: 4, resultDetailsAvailable: false, consolidationResults: [] });
    restarted.scheduleSettledRun(run.terminal);
    await waitForIndexedJob(restarted, run.runId, "exhausted");
    const jobs = await restarted.listJobs(SCOPE);
    expect(jobs[0]).toMatchObject({ status: "exhausted", attempts: 5, candidateCount: 0, resultDetailsAvailable: true, lastErrorCode: "memory_background_extraction_failed" });
    expect(jobs[0]?.nextAttemptAt).toBeUndefined();
    expect(JSON.stringify(jobs)).not.toContain("private");
  });

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

    const retry = await waitForIndexedJob(pipeline, run.runId, "retry", 1);
    expect(retry).toMatchObject({ attempts: 1, candidateCount: 1 });
    expect((await pipeline.listJobs(SCOPE))[0]?.consolidationResults).toHaveLength(1);
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

  it("refreshes a competing worker's indexed running state after the same Run completes", async () => {
    const fixture = await createFixture();
    const run = await appendSettledRun(fixture.ledger, "run-mem043-shared-job", "Shared worker recovery fact.");
    let entered!: () => void;
    const extractionEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const extractor: MemoryEpisodeExtractor = { id: "extractor:shared-job", canExtract: () => true,
      async extract(input) { calls += 1; entered(); await gate; return extractionResult(input, "Shared worker recovery fact."); } };
    const first = createPipeline(fixture, extractor);
    const second = createPipeline(fixture, extractor);
    first.scheduleSettledRun(run.terminal);
    await extractionEntered;
    try {
      await second.recoverSettledRuns();
      expect(second.historyLoaded).toBe(true);
      expect((await second.listJobs(SCOPE))[0]).toMatchObject({ status: "running" });
    } finally { release(); }
    await waitForIndexedJob(first, run.runId, "complete");
    const completed = await waitForIndexedJob(second, run.runId, "complete");
    expect(completed.candidateCount).toBe(1);
    expect(calls).toBe(1);
    expect((await fixture.control.list(SCOPE)).items).toHaveLength(1);
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
    expect(await waitForJob(fixture.root, run.runId, (job) => job.status === "running"))
      .toMatchObject({ status: "running", attempts: 0 });
    await pipeline.shutdown();

    const state = await waitForJob(fixture.root, run.runId, (job) => job.status === "retry");
    expect(state).toMatchObject({ status: "retry", attempts: 0, candidateCount: 0 });
    expect((await fixture.control.list(SCOPE)).items).toEqual([]);
  });

  it("recovers an interrupted background job after restart and completes only after candidate persistence", async () => {
    const fixture = await createFixture();
    const run = await appendSettledRun(
      fixture.ledger,
      "run-mem043-restart-in-flight",
      "Recover the extraction without duplicating its candidate.",
    );
    let firstExtractionEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { firstExtractionEntered = resolve; });
    let firstCalls = 0;
    const interruptedExtractor: MemoryEpisodeExtractor = {
      id: "extractor:mem043-interrupted-v1",
      canExtract: () => true,
      async extract(_input, { signal }) {
        firstCalls += 1;
        firstExtractionEntered();
        return await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(signal.reason ?? new Error("extraction interrupted"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      },
    };
    const first = createPipeline(fixture, interruptedExtractor);
    first.scheduleSettledRun(run.terminal);
    await firstEntered;
    expect(await waitForJob(fixture.root, run.runId, (job) => job.status === "running"))
      .toMatchObject({ status: "running", attempts: 0 });
    expect((await fixture.control.list(SCOPE)).items).toEqual([]);
    await first.shutdown();

    // Simulate process death after the durable in-flight marker but before a
    // candidate commit. Recovery must enqueue this state, never skip it as
    // completed.
    const jobPath = memoryJobStatePath(fixture.root, run.runId);
    const shutdownState = JSON.parse(await readFile(jobPath, "utf8")) as Record<string, unknown>;
    await writeFile(jobPath, JSON.stringify({
      ...shutdownState,
      status: "running",
      updatedAt: new Date().toISOString(),
    }), "utf8");

    let resumedCalls = 0;
    const resumedExtractor: MemoryEpisodeExtractor = {
      id: "extractor:mem043-restart-v1",
      canExtract: () => true,
      async extract(input) {
        resumedCalls += 1;
        return extractionResult(input, "Recovered candidate after restart.");
      },
    };
    const restarted = createPipeline(fixture, resumedExtractor);
    await restarted.recoverSettledRuns();

    const state = await waitForJob(fixture.root, run.runId, (job) => job.status === "complete");
    const listed = await fixture.control.list(SCOPE);
    expect(state).toMatchObject({ status: "complete", attempts: 1, candidateCount: 1 });
    expect(firstCalls).toBe(1);
    expect(resumedCalls).toBe(1);
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.record).toMatchObject({
      status: "candidate",
      claim: "Recovered candidate after restart.",
      provenance: { origin: "model_inference", evidenceRefs: [{ runId: run.runId }] },
    });
    await restarted.shutdown();
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
  creationData:Record<string,unknown> = {},
): Promise<{ runId: string; terminal: SessionEvent }> {
  await ledger.append({
    type: "run.created",
    project_id: PROJECT_ID,
    run_id: runId,
    attempt: 0,
    artifact_refs: [],
    summary: "A settled Memory extraction fixture Run.",
    data: creationData,
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
  const statePath = memoryJobStatePath(root, runId);
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

function memoryJobStatePath(root: string, runId: string): string {
  const ownerRoot = join(root, "memory-v2", "background", sha256(OWNER_ID).slice("sha256:".length));
  return join(ownerRoot, sha256(runId).slice("sha256:".length) + ".job.json");
}

async function waitForIndexedJob(pipeline: MemoryBackgroundPipeline, runId: string, status: string, attempts?: number) {
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    const job = (await pipeline.listJobs(SCOPE)).find((item) => item.runId === runId && item.status === status && (attempts === undefined || item.attempts === attempts));
    if (job !== undefined) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Indexed Memory job ${runId} did not reach ${status}`);
}
