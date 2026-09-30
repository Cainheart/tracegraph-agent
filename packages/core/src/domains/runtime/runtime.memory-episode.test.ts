import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISPOSABLE_FIXTURE_CAPABILITIES,
  WorkspaceHandleSchema,
  type MemoryEpisodeExtractionInput,
  type WorkspaceHandle,
} from "@tracegraph/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryEpisodeExtractor } from "../memory/memory-background-pipeline.js";
import { createAgentRuntime, type AgentRuntime } from "./runtime.js";
import type { ModelAdapter, ModelInput } from "../../kernel/types.js";

const roots: string[] = [];
const OWNER_ID = "owner:mem043-runtime";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MEM-043 Runtime behavior", () => {
  it("settles the main Run before extraction, exposes a review-gated candidate, and keeps V2 Recall off", async () => {
    const harness = await createHarness();
    const extractionEntered = deferred<MemoryEpisodeExtractionInput>();
    const extractionGate = deferred<void>();
    let modelInputs: ModelInput[] = [];
    let releaseExtraction = () => extractionGate.resolve();
    let extractionCalls = 0;
    const model: ModelAdapter = {
      name: "mem043-runtime-model",
      async decide(input) {
        modelInputs.push(input);
        return {
          decision_id: "decision:mem043:" + modelInputs.length,
          kind: "finish",
          public_reason: "The Runtime fixture is complete.",
          evidence_refs: [],
          risk: "none",
          final_answer: "Run completed.",
        };
      },
    };
    const extractor: MemoryEpisodeExtractor = {
      id: "extractor:mem043-runtime-v1",
      canExtract: () => true,
      async extract(input, { signal }) {
        extractionCalls += 1;
        if (extractionCalls === 1) {
          extractionEntered.resolve(input);
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              signal.removeEventListener("abort", onAbort);
              reject(signal.reason ?? new Error("extraction aborted"));
            };
            signal.addEventListener("abort", onAbort, { once: true });
            void extractionGate.promise.then(() => {
              signal.removeEventListener("abort", onAbort);
              resolve();
            });
            releaseExtraction = () => extractionGate.resolve();
          });
        }
        const terminalSequence = input.evidenceSequences.at(-1)!;
        return {
          summary: "A deterministic Runtime Episode fixture.",
          candidates: [{
            kind: "fact",
            claim: "Run completed.",
            evidenceSequences: [terminalSequence],
          }],
        };
      },
    };
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      model,
      memoryControlOwnerId: OWNER_ID,
      memoryEpisodeExtractor: extractor,
    });

    try {
      const started = await runtime.startRun(startInput(harness.workspace, "first"));
      const completed = await waitForStatus(runtime, started.run_id, "completed");
      const extractionInput = await extractionEntered.promise;

      expect(completed.timeline.at(-1)?.type).toBe("run.completed");
      expect(extractionInput.runId).toBe(started.run_id);
      expect(await runtime.listMemoryControl({ allowedScopeIds: [harness.workspace.project_id] }))
        .toMatchObject({ items: [] });

      // The extractor is intentionally still blocked here; the settled Run is already observable.
      releaseExtraction();
      const firstCandidate = await waitForCandidate(runtime, harness.workspace.project_id);
      expect(firstCandidate.record).toMatchObject({
        status: "candidate",
        claim: "Run completed.",
        provenance: {
          origin: "model_inference",
          createdFromEpisode: expect.any(String),
          evidenceRefs: [{ runId: started.run_id, eventType: "run.completed" }],
        },
        governance: { allowModelUse: false, allowExport: false },
      });

      const reviewed = await runtime.reviewMemory(firstCandidate.record.memoryId, {
        command_id: "command:mem043-runtime-review",
        expected_sequence: 0,
        action: "review_activate",
      }, { allowedScopeIds: [harness.workspace.project_id] });
      expect(reviewed.record.status).toBe("active");

      const second = await runtime.startRun(startInput(harness.workspace, "second"));
      const secondCompleted = await waitForStatus(runtime, second.run_id, "completed");
      expect(modelInputs).toHaveLength(2);
      expect(JSON.stringify(modelInputs[1])).not.toContain(firstCandidate.record.claim);
      expect(secondCompleted.timeline.some((event) => event.type === "memory.recalled")).toBe(false);
      expect((await runtime.listMemoryControl({ allowedScopeIds: [harness.workspace.project_id] })).items)
        .toHaveLength(1);
    } finally {
      releaseExtraction();
      await runtime.shutdownBackgroundWork?.();
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolve = resolveValue;
  });
  return { promise, resolve };
}

async function createHarness(): Promise<{ dataDir: string; workspace: WorkspaceHandle }> {
  const root = await mkdtemp(join(tmpdir(), "tracegraph-mem043-runtime-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  return {
    dataDir: join(root, "data"),
    workspace: WorkspaceHandleSchema.parse({
      handle_id: "workspace:mem043-runtime",
      project_id: "project:mem043-runtime",
      real_root: workspaceRoot,
      workspace_kind: "disposable_fixture",
      capabilities: DISPOSABLE_FIXTURE_CAPABILITIES,
      created_at: "2026-09-30T00:00:00.000Z",
    }),
  };
}

function startInput(workspace: WorkspaceHandle, suffix: string) {
  return {
    command_id: "command:mem043-start:" + suffix,
    project_id: workspace.project_id,
    task: "MEM-043 Runtime extraction fixture " + suffix,
    mode: "execute" as const,
    workspace,
  };
}

async function waitForStatus(
  runtime: AgentRuntime,
  runId: string,
  status: "completed",
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const projection = await runtime.getProjection(runId);
    if (projection.status === status) return projection;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const projection = await runtime.getProjection(runId);
  throw new Error("Timed out waiting for Run " + runId + " to reach " + status + ": "
    + JSON.stringify(projection.timeline.map(({ type }) => type)));
}

async function waitForCandidate(runtime: AgentRuntime, projectId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await runtime.listMemoryControl({ allowedScopeIds: [projectId] });
    const candidate = response.items.find(({ record }) => record.provenance.origin === "model_inference");
    if (candidate !== undefined) return candidate;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for a review-gated Episode-derived Memory candidate");
}
