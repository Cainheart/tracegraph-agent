import { ExperienceCaseSchema } from "@tracegraph/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  MemoryExperienceController,
  type MemoryExperienceRuntimePort,
} from "./memory-experience-controller.js";

describe("MemoryExperienceController", () => {
  it("preserves scoped content-free background jobs through the shared query reply", async () => {
    const job = { runId: "run:job", projectId: "project:visible", status: "retry", attempts: 1, candidateCount: 0,
      nextAttemptAt: "2026-10-03T01:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z",
      lastErrorCode: "memory_background_extraction_failed", resultDetailsAvailable: true, consolidationResults: [] };
    const listMemoryControl = vi.fn(async () => ({ items: [], conflicts: [], backgroundJobs: [job] }));
    const controller = new MemoryExperienceController({ runtime: { listMemoryControl } as unknown as MemoryExperienceRuntimePort,
      getProjectIds: () => ["project:visible"] });
    await expect(controller.dispatchQuery({ operation: "memory.list" })).resolves.toEqual({ resource: "memory_control",
      value: { items: [], conflicts: [], backgroundJobs: [job] } });
    expect(listMemoryControl).toHaveBeenCalledWith({ allowedScopeIds: ["project:visible"] });
  });

  it("derives visible scope per request and preserves the Experience CAS command", async () => {
    const candidate = makeExperienceCase();
    let visibleProjects = [candidate.projectId];
    const reviewExperienceCase = vi.fn(async (
      _caseId: string,
      _input: unknown,
      scope: { allowedScopeIds: readonly string[] },
    ) => {
      if (!scope.allowedScopeIds.includes(candidate.projectId)) throw Object.assign(new Error("not found"), { code: "experience_not_found" });
      return { case: { ...candidate, status: "validated" as const }, lifecycleSequence: 1, replayed: false };
    });
    const runtime = {
      listMemoryControl: vi.fn(async () => ({ items: [], conflicts: [] })),
      createMemoryCandidate: vi.fn(),
      reviewMemory: vi.fn(),
      correctMemory: vi.fn(),
      revokeMemory: vi.fn(),
      deleteMemory: vi.fn(),
      listExperienceCases: vi.fn(async (scope: { allowedScopeIds: readonly string[] }) => scope.allowedScopeIds.includes(candidate.projectId)
        ? [{ case: candidate, lifecycleSequence: 0 }]
        : []),
      reviewExperienceCase,
    } as unknown as MemoryExperienceRuntimePort;
    const controller = new MemoryExperienceController({ runtime, getProjectIds: () => visibleProjects });

    await expect(controller.dispatchQuery({ operation: "experience.list" })).resolves.toEqual({
      resource: "experience_cases",
      value: { items: [{ case: candidate, lifecycleSequence: 0 }] },
    });
    const command = { command_id: "command:experience-review", expected_sequence: 0, action: "validate" as const };
    await expect(controller.dispatchCommand({ type: "experience.review", case_id: candidate.caseId, input: command })).resolves.toMatchObject({
      resource: "experience_case",
      value: {
        case: { caseId: candidate.caseId, status: "validated" },
        lifecycleSequence: 1,
        replayed: false,
      },
    });
    expect(reviewExperienceCase).toHaveBeenCalledWith(candidate.caseId, {
      action: "validate",
      expectedSequence: 0,
      commandId: "command:experience-review",
    }, { allowedScopeIds: [candidate.projectId] });

    visibleProjects = [];
    await expect(controller.dispatchQuery({ operation: "experience.list" })).resolves.toEqual({
      resource: "experience_cases",
      value: { items: [] },
    });
    await expect(controller.dispatchCommand({ type: "experience.review", case_id: candidate.caseId, input: command })).rejects.toMatchObject({
      name: "MemoryExperienceControllerError",
      statusCode: 404,
      code: "experience_not_found",
    });
  });

  it("rejects renderer authority and unsupported lifecycle commands at the shared application boundary", async () => {
    const controller = new MemoryExperienceController({
      runtime: {
        listMemoryControl: vi.fn(async () => ({ items: [], conflicts: [] })),
        createMemoryCandidate: vi.fn(),
        reviewMemory: vi.fn(),
        correctMemory: vi.fn(),
        revokeMemory: vi.fn(),
        deleteMemory: vi.fn(),
        listExperienceCases: vi.fn(async () => []),
        reviewExperienceCase: vi.fn(),
      } as unknown as MemoryExperienceRuntimePort,
      getProjectIds: () => ["project:experience"],
    });

    expect(() => controller.reviewExperienceCase("experience:one", {
      command_id: "command:one",
      expected_sequence: 0,
      action: "delete",
    })).toThrow();
    expect(() => controller.createMemoryCandidate({
      command_id: "command:memory",
      kind: "fact",
      claim: "renderer cannot choose owner",
      owner_id: "owner:renderer",
    })).toThrow();
  });
});

function makeExperienceCase() {
  const projectId = "project:experience";
  const evidence = {
    kind: "run_event" as const,
    projectId,
    runId: "run:experience",
    sessionId: "session:experience",
    eventId: "event:experience",
    sequence: 1,
    eventType: "run.completed",
    eventHash: `sha256:${"a".repeat(64)}`,
  };
  return ExperienceCaseSchema.parse({
    schemaVersion: "tracegraph.experience-case.v1",
    caseId: "experience:one",
    version: 1,
    projectId,
    episodeId: "episode:experience",
    sourceDigest: `sha256:${"b".repeat(64)}`,
    extractorId: "experience-extractor:test",
    title: "A verified task",
    situation: { conditions: [{ dimension: "language", operator: "equals", value: "TypeScript", evidenceRefs: [evidence] }] },
    objective: "Verify the controller seam.",
    actions: [{ intent: "Run focused tests", preconditions: [], steps: [{ text: "Execute the test", evidenceRefs: [evidence] }] }],
    outcome: { kind: "success", summary: "Tests passed", evidenceRefs: [evidence] },
    verification: [{ kind: "test", summary: "Focused suite passed", evidenceRefs: [evidence] }],
    counterexamples: [],
    applicability: [{ dimension: "language", operator: "equals", value: "TypeScript", evidenceRefs: [evidence] }],
    evidenceRefs: [evidence],
    status: "candidate",
  });
}
