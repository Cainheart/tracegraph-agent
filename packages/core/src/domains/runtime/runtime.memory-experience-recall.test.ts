import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISPOSABLE_FIXTURE_CAPABILITIES,
  WorkspaceHandleSchema,
  type ExperienceCase,
  type WorkspaceHandle,
} from "@tracegraph/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "../../kernel/crypto.js";
import type { MemoryRetriever } from "../memory/memory.js";
import type { MemoryV2RecordStore } from "../memory/memory-control.js";
import { evaluateMemoryRecallEligibility } from "../memory/memory-governance.js";
import { rankEligibleV2Memory } from "../memory/memory-v2-recall.js";
import type { ModelAdapter, ModelInput } from "../../kernel/types.js";
import { createAgentRuntime, type AgentRuntime } from "./runtime.js";

const roots: string[] = [];
const runtimes: AgentRuntime[] = [];
const OWNER_ID = "owner:mem048-runtime";

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdownBackgroundWork?.()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MEM-049/050 Runtime recall handoff", () => {
  it("keeps Experience retrieval off by default even when a validated Case exists", async () => {
    const harness = await createHarness("experience-default-off");
    const inputs: ModelInput[] = [];
    const runtime = await createRuntime({
      dataDir: harness.dataDir,
      experienceFactsProvider: () => ({ language: "TypeScript" }),
      model: capturingModel(inputs),
    });
    const candidate = makeExperience(harness.workspace.project_id);
    const scope = { allowedScopeIds: [harness.workspace.project_id] };
    await runtime.createExperienceCandidate(candidate, scope);
    await runtime.reviewExperienceCase(candidate.caseId, {
      action: "validate",
      expectedSequence: 0,
      commandId: "experience:default-off:validate",
    }, scope);

    const completed = await completedRun(runtime, harness.workspace, "experience-default-off",
      "TypeScript memory consumer regression tests");

    expect(completed.status).toBe("completed");
    expect(inputs[0]?.contextManifest.items.some(({ section }) => section === "experience")).toBe(false);
  });

  it("sends only reviewed, applicable Experience with its own Context provenance", async () => {
    const harness = await createHarness("experience");
    const inputs: ModelInput[] = [];
    const runtime = await createRuntime({
      dataDir: harness.dataDir,
      experienceRecallEnabled: true,
      experienceFactsProvider: ({ task }) => ({
        language: task.includes("Python-only") ? "Python" : "TypeScript",
      }),
      model: capturingModel(inputs),
    });
    const candidate = makeExperience(harness.workspace.project_id);
    const scope = { allowedScopeIds: [harness.workspace.project_id] };

    await runtime.createExperienceCandidate(candidate, scope);
    const beforeReview = await completedRun(runtime, harness.workspace, "candidate-only",
      "TypeScript memory consumer regression tests");
    expect(beforeReview.status).toBe("completed");
    expect(inputs[0]?.context).not.toContain(candidate.title);
    expect(inputs[0]?.contextManifest.items.some(({ section }) => section === "experience")).toBe(false);

    await runtime.reviewExperienceCase(candidate.caseId, {
      action: "validate",
      expectedSequence: 0,
      commandId: "experience:runtime:validate",
    }, scope);
    const matching = await completedRun(runtime, harness.workspace, "validated-match",
      "TypeScript memory consumer regression tests");
    expect(matching.status).toBe("completed");
    expect(inputs[1]?.context).toContain("Advisory only");
    expect(inputs[1]?.contextManifest.items).toContainEqual(expect.objectContaining({
      section: "experience",
      source: expect.objectContaining({ source_type: "experience", trust: "untrusted" }),
      experience_retrieval: expect.objectContaining({
        caseId: candidate.caseId,
        caseVersion: 1,
        evidenceRefs: candidate.evidenceRefs,
      }),
    }));
    expect(inputs[1]?.contextManifest.nodes).toContainEqual(expect.objectContaining({
      section: "experience",
      kind: "retrieved",
      experience_retrieval: expect.objectContaining({ caseId: candidate.caseId }),
    }));

    const mismatched = await completedRun(runtime, harness.workspace, "wrong-facts",
      "Python-only runtime should implement memory consumer regression tests");
    expect(mismatched.status).toBe("completed");
    expect(inputs[2]?.contextManifest.items.some(({ section }) => section === "experience")).toBe(false);
  });

  it("passes exact eligible V2 Memory into the adapter and records MemoryUse dispatch/response", async () => {
    const harness = await createHarness("memory-v2");
    const inputs: ModelInput[] = [];
    const runtime = await createRuntime({
      dataDir: harness.dataDir,
      memoryControlOwnerId: OWNER_ID,
      v2MemoryRecallEnabled: true,
      model: capturingModel(inputs),
    });
    const scope = { allowedScopeIds: [harness.workspace.project_id] };
    const candidate = await runtime.createMemoryCandidate({
      command_id: "memory:runtime:create",
      kind: "fact",
      claim: "The synthetic TraceGraph fixture uses ledger-backed V2 Memory recall.",
      normalized_key: "synthetic tracegraph v2 recall",
      project_id: harness.workspace.project_id,
      allow_model_use: true,
    }, scope);
    await runtime.reviewMemory(candidate.record.memoryId, {
      command_id: "memory:runtime:activate",
      expected_sequence: 0,
      action: "review_activate",
    }, scope);
    const controlSnapshot = await runtime.listMemoryControl(scope);
    expect(controlSnapshot.items[0]?.record.status).toBe("active");
    const gate = evaluateMemoryRecallEligibility({
      records: controlSnapshot.items.map((item) => item.record),
      feedback: controlSnapshot.items.map((item) => item.feedback),
      request: {
        ownerId: OWNER_ID,
        projectId: harness.workspace.project_id,
        runId: "run:mem048-gate-probe",
        sessionId: "session:mem048-gate-probe",
      },
    });
    expect(gate.eligible).toEqual([{ memoryId: candidate.record.memoryId, version: candidate.record.version }]);
    expect(rankEligibleV2Memory({
      records: controlSnapshot.items.map((item) => item.record),
      gate,
      query: "Explain the TraceGraph ledger-backed V2 Memory recall fixture",
      maxHits: 8,
      maxTokens: 4_096,
    })).toHaveLength(1);

    const completed = await completedRun(runtime, harness.workspace, "memory-match",
      "Explain the TraceGraph ledger-backed V2 Memory recall fixture");
    expect(completed.status).toBe("completed");
    expect(inputs[0]?.context).toContain(candidate.record.claim);
    const memoryItem = inputs[0]?.contextManifest.items.find(({ section }) => section === "memory");
    expect(memoryItem?.retrieval?.memory_ref).toMatchObject({
      record_schema_version: "tracegraph.memory-record.v2",
      memory_id: candidate.record.memoryId,
      version: candidate.record.version,
    });
    const memoryUse = completed.timeline
      .filter(({ type }) => type === "memory.use_status")
      .map(({ data }) => data);
    expect(memoryUse.map((entry) => entry.stage)).toEqual(["dispatch_intent", "adapter_invoked", "response"]);
    expect(memoryUse[0]).toMatchObject({
      memory_items: [{ memory_ref: { memory_id: candidate.record.memoryId, version: candidate.record.version } }],
    });
  });

  it("does not fall back to the legacy retriever when the enabled V2 control snapshot fails", async () => {
    const harness = await createHarness("memory-fail-closed");
    const inputs: ModelInput[] = [];
    const sentinel = "LEGACY_RETRIEVER_SENTINEL_71f9b2";
    const search = vi.fn(async () => ({ results: [{ content: sentinel }] }));
    const retriever: MemoryRetriever = { search };
    const failedStore: MemoryV2RecordStore = {
      initialize: async () => undefined,
      list: async () => { throw new Error("synthetic V2 store failure"); },
      writeCandidate: async () => undefined,
      delete: async () => undefined,
    };
    const runtime = await createRuntime({
      dataDir: harness.dataDir,
      memoryControlOwnerId: OWNER_ID,
      v2MemoryRecallEnabled: true,
      memoryV2RecordStore: failedStore,
      retriever,
      model: capturingModel(inputs),
    });

    const completed = await completedRun(runtime, harness.workspace, "memory-fail-closed",
      "Ask an unrelated synthetic question");

    expect(completed.status).toBe("completed");
    expect(search).not.toHaveBeenCalled();
    expect(inputs[0]?.context).not.toContain(sentinel);
    expect(completed.timeline.some(({ type }) => type === "memory.use_status")).toBe(false);
  });
});

async function createHarness(name: string): Promise<{ dataDir: string; workspace: WorkspaceHandle }> {
  const root = await mkdtemp(join(tmpdir(), "tracegraph-mem048-runtime-" + name + "-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  return {
    dataDir: join(root, "data"),
    workspace: WorkspaceHandleSchema.parse({
      handle_id: "workspace:mem048:" + name,
      project_id: "project:mem048:" + name,
      real_root: workspaceRoot,
      workspace_kind: "disposable_fixture",
      capabilities: DISPOSABLE_FIXTURE_CAPABILITIES,
      created_at: "2026-10-01T00:00:00.000Z",
    }),
  };
}

async function createRuntime(options: Parameters<typeof createAgentRuntime>[0]): Promise<AgentRuntime> {
  const runtime = await createAgentRuntime(options);
  runtimes.push(runtime);
  return runtime;
}

function capturingModel(inputs: ModelInput[]): ModelAdapter {
  return {
    name: "mem048-synthetic-runtime-model",
    async decide(input) {
      inputs.push(input);
      return {
        decision_id: "decision:mem048:" + inputs.length,
        kind: "finish",
        public_reason: "The synthetic Runtime fixture completed.",
        evidence_refs: [],
        risk: "none",
        final_answer: "Synthetic Runtime fixture completed.",
      };
    },
  };
}

async function completedRun(
  runtime: AgentRuntime,
  workspace: WorkspaceHandle,
  suffix: string,
  task: string,
) {
  const started = await runtime.startRun({
    command_id: "command:mem048:" + suffix,
    project_id: workspace.project_id,
    task,
    mode: "execute",
    workspace,
  });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const projection = await runtime.getProjection(started.run_id);
    if (projection.status === "completed") return projection;
    if (projection.status === "failed") throw new Error("Synthetic Run failed: " + JSON.stringify(projection.timeline.map(({ type }) => type)));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for synthetic Run to complete");
}

function makeExperience(projectId: string): ExperienceCase {
  const evidence = {
    kind: "run_event" as const,
    projectId,
    runId: "run:mem048-synthetic-source",
    sessionId: "session:mem048-synthetic-source",
    eventId: "event:mem048-synthetic-source",
    sequence: 2,
    eventType: "run.completed",
    eventHash: sha256("approved synthetic Experience evidence"),
  };
  return {
    schemaVersion: "tracegraph.experience-case.v1",
    caseId: "experience:mem048-typescript-fixture",
    version: 1,
    projectId,
    episodeId: "episode:mem048-synthetic-source",
    sourceDigest: sha256("approved synthetic Experience episode"),
    extractorId: "experience-extractor:mem048-synthetic",
    title: "TypeScript memory consumer regression fixture",
    situation: {
      conditions: [{ dimension: "language", operator: "equals", value: "TypeScript", evidenceRefs: [evidence] }],
    },
    objective: "Verify a synthetic consumer change with a focused regression.",
    actions: [{
      intent: "Run the focused TypeScript regression before accepting the change.",
      preconditions: [],
      steps: [{ text: "Run the focused regression suite.", evidenceRefs: [evidence] }],
    }],
    outcome: { kind: "success", summary: "The synthetic focused regression passed.", evidenceRefs: [evidence] },
    verification: [{ kind: "test", summary: "The synthetic test result was reviewed.", evidenceRefs: [evidence] }],
    counterexamples: [{ condition: "Python-only runtime", reason: "The TypeScript fixture does not apply there.", evidenceRefs: [evidence] }],
    applicability: [{ dimension: "language", operator: "equals", value: "TypeScript", evidenceRefs: [evidence] }],
    evidenceRefs: [evidence],
    status: "candidate",
  };
}
