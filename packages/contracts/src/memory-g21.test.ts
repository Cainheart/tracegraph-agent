import { describe, expect, it } from "vitest";
import {
  ContextManifestSchema,
  EventTypeSchema,
  MemoryAdmissionSchema,
  MemoryCandidateEvaluatedDataSchema,
  MemoryCandidateSchema,
  MemoryRecallResultSchema,
  MemoryRecalledDataSchema,
  MemoryRememberResultSchema,
  RetrievalAttributionSchema,
  RetrievalSearchResponseSchema,
} from "./index.js";

const hash = `sha256:${"a".repeat(64)}`;

describe("G-21 retrieval and memory contracts", () => {
  it("keeps MemoryCandidate strict and scope-safe while allowing attributable rejection evaluation", () => {
    const candidate = {
      candidate_id: "candidate:strict",
      content: "A durable fact",
      scope: { kind: "project", project_id: "project:one" },
      origin: "user",
      trust: "trusted",
      source_refs: [],
      proposed_at: "2026-09-19T00:00:00.000Z",
      supersedes: [],
    };
    expect(MemoryCandidateSchema.parse(candidate)).toEqual(candidate);
    expect(() => MemoryCandidateSchema.parse({ ...candidate, injected: true })).toThrow();
    expect(() => MemoryCandidateSchema.parse({
      ...candidate,
      scope: { kind: "global", project_id: "project:one" },
    })).toThrow();
    expect(() => MemoryCandidateSchema.parse({
      ...candidate,
      source_refs: [
        { source_id: "source:1", source_type: "user", trust: "trusted" },
        { source_id: "source:1", source_type: "user", trust: "trusted" },
      ],
    })).toThrow();
    expect(() => MemoryCandidateSchema.parse({
      ...candidate,
      scope: { kind: "project" },
    })).toThrow();
    expect(() => MemoryCandidateSchema.parse({
      ...candidate,
      scope: { kind: "project", project_id: "project:one", run_id: "run:one" },
    })).toThrow();
    expect(() => MemoryCandidateSchema.parse({
      ...candidate,
      scope: { kind: "run", project_id: "project:one" },
    })).toThrow();
    expect(() => MemoryCandidateSchema.parse({
      ...candidate,
      supersedes: ["memory:one", "memory:one"],
    })).toThrow();
  });

  it("keeps admissions and remember results mutually consistent", () => {
    const decidedAt = "2026-09-19T00:00:00.000Z";
    expect(() => MemoryAdmissionSchema.parse({
      admission_id: "admission:1",
      candidate_id: "candidate:1",
      decision: "confirmed",
      reason: "accepted",
      decided_at: decidedAt,
    })).toThrow();
    expect(() => MemoryAdmissionSchema.parse({
      admission_id: "admission:1",
      candidate_id: "candidate:1",
      decision: "rejected",
      reason: "rejected",
      decided_at: decidedAt,
      resulting_memory_id: "memory:1",
    })).toThrow();
    expect(() => MemoryRememberResultSchema.parse({
      admission: {
        admission_id: "admission:1",
        candidate_id: "candidate:1",
        decision: "confirmed",
        reason: "accepted",
        decided_at: decidedAt,
        resulting_memory_id: "memory:1",
      },
    })).toThrow();
  });

  it("requires recall evidence to be hash-only, budgeted, and internally consistent", () => {
    expect(MemoryCandidateEvaluatedDataSchema.parse({
      admission_id: "admission:1",
      candidate_id: "candidate:1",
      candidate_hash: hash,
      decided_at: "2026-09-19T00:00:00.000Z",
      accepted: false,
      decision: "rejected",
      reason: "missing source",
      source_count: 0,
    }).accepted).toBe(false);
    expect(() => MemoryCandidateEvaluatedDataSchema.parse({
      admission_id: "admission:1",
      candidate_id: "candidate:1",
      candidate_hash: hash,
      decided_at: "2026-09-19T00:00:00.000Z",
      accepted: true,
      decision: "rejected",
      reason: "contradiction",
      source_count: 0,
    })).toThrow();

    const data = {
      retrieval_id: "retrieval:1",
      query_hash: hash,
      status: "completed",
      budget: { max_tokens: 50, max_hits: 2 },
      hits: [{
        rank: 1,
        hit_id: "chunk:1",
        content_hash: hash,
        score: 2.75,
        source_path: "docs/guide.md",
        start_line: 10,
        end_line: 12,
        heading_path: ["Guide"],
        injected_tokens: 20,
      }],
      blocked_hits: [],
      injected_tokens: 20,
    };
    expect(MemoryRecalledDataSchema.parse(data)).toEqual(data);
    expect(() => MemoryRecalledDataSchema.parse({ ...data, injected_tokens: 19 })).toThrow();
    expect(() => MemoryRecalledDataSchema.parse({
      ...data,
      budget: { max_tokens: 10, max_hits: 2 },
    })).toThrow();
    expect(() => MemoryRecalledDataSchema.parse({
      ...data,
      status: "degraded",
    })).toThrow();
    expect(() => RetrievalAttributionSchema.parse({
      ...data.hits[0],
      start_line: 12,
      end_line: 10,
    })).toThrow();
    expect(() => MemoryRecallResultSchema.parse({
      data,
      hits: [{ content: "source", attribution: { ...data.hits[0], hit_id: "chunk:other" } }],
    })).toThrow();
    expect("query" in MemoryRecalledDataSchema.parse(data)).toBe(false);
  });

  it("accepts the exact retrieval service response and rejects drift", () => {
    const response = {
      schema_version: "tracegraph.retrieval.v1",
      project_id: "project:one",
      query_hash: hash,
      total_indexed_chunks: 1,
      hits: [{
        rank: 1,
        chunk_id: "chunk:1",
        content_hash: hash,
        score: 1.5,
        source_path: "README.md",
        start_line: 2,
        end_line: 4,
        heading_path: ["Overview"],
        content: "retrieved source",
      }],
    };
    expect(RetrievalSearchResponseSchema.parse(response)).toEqual(response);
    expect(() => RetrievalSearchResponseSchema.parse({ ...response, query: "leak" })).toThrow();
    expect(() => RetrievalSearchResponseSchema.parse({
      ...response,
      hits: [{ ...response.hits[0], end_line: 1 }],
    })).toThrow();
  });

  it("requires retrieved Context items and nodes to carry inspectable provenance", () => {
    const retrieval = {
      rank: 1,
      hit_id: "chunk:1",
      content_hash: hash,
      score: 1.5,
      source_path: "README.md",
      start_line: 2,
      end_line: 4,
      heading_path: ["Overview"],
      injected_tokens: 4,
    };
    const manifest = {
      manifest_id: "context:1",
      project_id: "project:one",
      run_id: "run:one",
      turn_id: "turn:one",
      model_call_id: "model:one",
      token_limit: 100,
      reserved_output_tokens: 10,
      input_tokens: 4,
      items: [{
        item_id: "item:1",
        section: "memory",
        label: "README.md:2-4",
        source: { source_id: "chunk:1", source_type: "memory", trust: "untrusted" },
        original_tokens: 4,
        included_tokens: 4,
        action: "retrieved",
        reason: "ranked retrieval",
        content: "source",
        retrieval,
      }],
      nodes: [{
        node_id: "node:1",
        section: "memory",
        kind: "retrieved",
        content_hash: hash,
        tokens: 4,
        volatile: false,
        retrieval,
      }],
      fixed_constraints_preserved: true,
      created_at: "2026-09-19T00:00:00.000Z",
    };
    expect(ContextManifestSchema.parse(manifest).items[0]?.action).toBe("retrieved");
    expect(() => ContextManifestSchema.parse({
      ...manifest,
      items: [{ ...manifest.items[0], retrieval: undefined }],
    })).toThrow();
    for (const type of ["memory.written", "memory.recalled", "retrieval.index_updated"] as const) {
      expect(EventTypeSchema.parse(type)).toBe(type);
    }
  });
});
