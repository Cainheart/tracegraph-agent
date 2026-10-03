import { describe, expect, it } from "vitest";
import { MemoryBackgroundJobSchema, MemoryControlListResponseSchema } from "./memory-control.js";
import { MemoryExperienceControlReplySchema } from "./memory-experience-control.js";

const job = {
  runId: "run:one", projectId: "project:one", status: "complete", attempts: 1, candidateCount: 0,
  updatedAt: "2026-10-03T00:00:00.000Z", resultDetailsAvailable: true, consolidationResults: [{ action: "unchanged", requestDigest: `sha256:${"a".repeat(64)}`, memoryId: "memory:one",
    comparedMemoryIds: ["memory:one"], sourceRunIds: ["run:one", "run:prior"] }],
};

describe("Memory background job contract", () => {
  it("preserves old lists and transports typed job projections in shared replies", () => {
    expect(MemoryControlListResponseSchema.parse({ items: [], conflicts: [] })).toEqual({ items: [], conflicts: [] });
    expect(MemoryExperienceControlReplySchema.parse({ resource: "memory_control", value: { items: [], conflicts: [], backgroundJobs: [job], backgroundJobsLoading: true } }))
      .toMatchObject({ value: { backgroundJobs: [job], backgroundJobsLoading: true } });
  });
  it("rejects claim-bearing metadata, freeform error text and unbounded history", () => {
    expect(MemoryBackgroundJobSchema.safeParse({ ...job, claim: "do not persist text" }).success).toBe(false);
    expect(MemoryBackgroundJobSchema.safeParse({ ...job, lastErrorCode: "private error text" }).success).toBe(false);
    expect(MemoryBackgroundJobSchema.safeParse({ ...job, attempts: 6 }).success).toBe(false);
    expect(MemoryControlListResponseSchema.safeParse({ items: [], conflicts: [], backgroundJobs: Array(101).fill(job) }).success).toBe(false);
  });
});
