import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExperienceCase } from "@tracegraph/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "../../kernel/crypto.js";
import { JsonlEventLedger } from "../evidence/runtime-service.js";
import {
  ExperienceCaseService,
  ExperienceLifecycleError,
  JsonlExperienceCaseStore,
} from "./experience-lifecycle.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Experience lifecycle and recall", () => {
  it("persists candidates, validates with CAS, recalls only scoped/applicable cases, and blocks disputes/retirement", async () => {
    const harness = await createService();
    const candidate = makeCase();
    await harness.service.createCandidate(candidate, { allowedScopeIds: [candidate.projectId] });

    expect((await harness.service.list({ allowedScopeIds: [candidate.projectId] }))[0]?.case.status).toBe("candidate");
    expect(await harness.service.recall({
      projectId: candidate.projectId,
      query: { task: "TypeScript memory consumer regression tests", facts: { language: "TypeScript" } },
      maxHits: 5,
      maxTokens: 10_000,
    })).toEqual([]);

    const validated = await harness.service.review(candidate.caseId, {
      action: "validate",
      expectedSequence: 0,
      commandId: "experience:review-one",
    }, { allowedScopeIds: [candidate.projectId] });
    expect(validated).toMatchObject({ case: { status: "validated" }, lifecycleSequence: 1, replayed: false });

    const request = {
      projectId: candidate.projectId,
      query: { task: "Write TypeScript memory consumer regression tests", facts: { language: "TypeScript" } },
      maxHits: 5,
      maxTokens: 10_000,
    };
    const hits = await harness.service.recall(request);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      attribution: {
        caseId: candidate.caseId,
        caseVersion: 1,
        sourcePath: `experience/${encodeURIComponent(candidate.caseId)}.md`,
        evidenceRefs: candidate.evidenceRefs,
      },
    });
    expect(hits[0]?.content).toContain("Advisory only");
    expect(await harness.service.recall({
      ...request,
      query: { task: request.query.task, facts: {} },
    })).toEqual([]);
    expect(await harness.service.recall({
      ...request,
      query: { task: request.query.task, facts: { language: "Python" } },
    })).toEqual([]);
    expect(await harness.service.recall({
      ...request,
      query: { task: "Python-only runtime should skip these TypeScript regression tests", facts: { language: "TypeScript" } },
    })).toEqual([]);
    expect(await harness.service.list({ allowedScopeIds: ["project:other"] })).toEqual([]);

    await expect(harness.service.review(candidate.caseId, {
      action: "dispute",
      expectedSequence: 0,
      commandId: "experience:review-stale",
    }, { allowedScopeIds: [candidate.projectId] })).rejects.toMatchObject<Partial<ExperienceLifecycleError>>({
      code: "experience_conflict",
    });
    const disputed = await harness.service.review(candidate.caseId, {
      action: "dispute",
      expectedSequence: 1,
      commandId: "experience:dispute-one",
    }, { allowedScopeIds: [candidate.projectId] });
    expect(disputed.case.status).toBe("disputed");
    expect(await harness.service.recall(request)).toEqual([]);
    const resolved = await harness.service.review(candidate.caseId, {
      action: "resolve",
      expectedSequence: 2,
      commandId: "experience:resolve-one",
    }, { allowedScopeIds: [candidate.projectId] });
    expect(resolved.case.status).toBe("validated");
    const retired = await harness.service.review(candidate.caseId, {
      action: "retire",
      expectedSequence: 3,
      commandId: "experience:retire-one",
    }, { allowedScopeIds: [candidate.projectId] });
    expect(retired.case.status).toBe("retired");
    expect(await harness.service.recall(request)).toEqual([]);
    expect((await harness.ledger.listExperienceLifecycle("owner:experience-test", candidate.caseId)).map(({ action }) => action))
      .toEqual(["validate", "dispute", "resolve", "retire"]);
  });

  it("replays validated state after restart and fails closed on malformed candidate storage", async () => {
    const harness = await createService();
    const candidate = makeCase({ projectId: "project:restart" });
    const scope = { allowedScopeIds: [candidate.projectId] };
    await harness.service.createCandidate(candidate, scope);
    await harness.service.review(candidate.caseId, {
      action: "validate",
      expectedSequence: 0,
      commandId: "experience:restart-review",
    }, scope);

    const restarted = new ExperienceCaseService({
      ownerId: "owner:experience-test",
      actorId: "user:experience-test",
      store: new JsonlExperienceCaseStore(join(harness.root, "cases")),
      journal: new JsonlEventLedger(join(harness.root, "events")),
    });
    expect((await restarted.list(scope))[0]).toMatchObject({ case: { caseId: candidate.caseId, status: "validated" }, lifecycleSequence: 1 });
    await expect(restarted.review(candidate.caseId, {
      action: "retire",
      expectedSequence: 1,
      commandId: "experience:outside-scope",
    }, { allowedScopeIds: ["project:other"] })).rejects.toMatchObject({ code: "experience_not_found" });

    const corruptStore = new JsonlExperienceCaseStore(join(harness.root, "corrupt"));
    await corruptStore.initialize();
    const seed = JSON.stringify(candidate);
    const ownerPath = sha256("owner:experience-test").slice(7);
    const { mkdir, writeFile } = await import("node:fs/promises");
    const path = join(harness.root, "corrupt", ownerPath, "cases.jsonl");
    await mkdir(join(harness.root, "corrupt", ownerPath), { recursive: true });
    await writeFile(path, `${seed.slice(0, -1)},"status":"validated"}\n`);
    const corruptService = new ExperienceCaseService({
      ownerId: "owner:experience-test",
      actorId: "user:experience-test",
      store: corruptStore,
      journal: harness.ledger,
    });
    await expect(corruptService.recall({
      projectId: candidate.projectId,
      query: { task: "TypeScript memory consumer tests", facts: { language: "TypeScript" } },
      maxHits: 5,
      maxTokens: 10_000,
    })).rejects.toMatchObject({ code: "experience_corrupt" });
  });
});

async function createService() {
  const root = await mkdtemp(join(tmpdir(), "tracegraph-experience-lifecycle-"));
  roots.push(root);
  const ledger = new JsonlEventLedger(join(root, "events"));
  const store = new JsonlExperienceCaseStore(join(root, "cases"));
  const service = new ExperienceCaseService({
    ownerId: "owner:experience-test",
    actorId: "user:experience-test",
    store,
    journal: ledger,
    now: () => new Date("2026-10-01T00:00:00.000Z"),
  });
  return { root, ledger, store, service };
}

function makeCase(overrides: Partial<Pick<ExperienceCase, "projectId">> = {}): ExperienceCase {
  const projectId = overrides.projectId ?? "project:experience";
  const evidence = {
    kind: "run_event" as const,
    projectId,
    runId: "run:experience-source",
    sessionId: "session:experience-source",
    eventId: "event:experience-source",
    sequence: 2,
    eventType: "run.completed",
    eventHash: sha256("synthetic experience evidence"),
  };
  return {
    schemaVersion: "tracegraph.experience-case.v1",
    caseId: "experience:typescript-memory-tests",
    version: 1,
    projectId,
    episodeId: "episode:experience-source",
    sourceDigest: sha256("synthetic experience episode"),
    extractorId: "experience-extractor:synthetic-test",
    title: "TypeScript memory consumer regression tests",
    situation: {
      conditions: [{ dimension: "language", operator: "equals", value: "TypeScript", evidenceRefs: [evidence] }],
    },
    objective: "Verify the V2 memory consumer against a focused regression fixture.",
    actions: [{
      intent: "Run a focused TypeScript memory consumer check.",
      preconditions: [],
      steps: [{ text: "Run the focused regression tests.", evidenceRefs: [evidence] }],
    }],
    outcome: { kind: "success", summary: "The focused regression fixture completed.", evidenceRefs: [evidence] },
    verification: [{ kind: "test", summary: "The test result was verified.", evidenceRefs: [evidence] }],
    counterexamples: [{ condition: "python-only runtime", reason: "The TypeScript test setup does not apply there.", evidenceRefs: [evidence] }],
    applicability: [{ dimension: "language", operator: "equals", value: "TypeScript", evidenceRefs: [evidence] }],
    evidenceRefs: [evidence],
    status: "candidate",
  };
}
