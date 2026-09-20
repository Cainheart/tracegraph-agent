import { describe, expect, it } from "vitest";
import { MemoryCandidateSchema, type MemoryRecord } from "@tracegraph/contracts";
import { evaluateMemoryCandidate, retrieveMemoryFixture } from "./memory.js";

describe("P0 memory contract", () => {
  it("rejects source-less candidates", () => {
    const candidate = MemoryCandidateSchema.parse({
      candidate_id: "candidate:1",
      content: "an unsupported generated claim",
      scope: { kind: "global" },
      origin: "tool",
      trust: "trusted",
      source_refs: [],
      proposed_at: "2026-09-16T00:00:00.000Z",
      supersedes: [],
    });
    expect(evaluateMemoryCandidate(candidate, { now: new Date("2026-09-16T00:00:01.000Z") }).decision).toBe("rejected");
  });

  it("blocks expired and cross-project fixture records", () => {
    const base = {
      content: "fixture memory",
      origin: "fixture" as const,
      trust: "trusted" as const,
      version: 1,
      status: "confirmed" as const,
      source_refs: [{ source_id: "fixture:1", source_type: "fixture" as const, trust: "trusted" as const }],
      created_at: "2026-09-01T00:00:00.000Z",
      supersedes: [],
    };
    const records: MemoryRecord[] = [
      { ...base, memory_id: "memory:expired", scope: { kind: "global" }, expires_at: "2026-09-10T00:00:00.000Z" },
      { ...base, memory_id: "memory:other", scope: { kind: "project", project_id: "other" } },
      { ...base, memory_id: "memory:old", scope: { kind: "project", project_id: "current" } },
      { ...base, memory_id: "memory:new", scope: { kind: "project", project_id: "current" }, supersedes: ["memory:old"] },
      { ...base, memory_id: "memory:current", scope: { kind: "project", project_id: "current" } },
    ];
    const result = retrieveMemoryFixture({
      records,
      projectId: "current",
      runId: "run:1",
      query: "fixture",
      now: new Date("2026-09-16T00:00:00.000Z"),
    });
    expect(result.records.map((record) => record.memory_id)).toEqual(["memory:new", "memory:current"]);
    expect(result.receipt.reasons).toMatchObject({
      "memory:expired": "expired",
      "memory:other": "cross_project_scope",
      "memory:old": "superseded",
    });
  });
});
