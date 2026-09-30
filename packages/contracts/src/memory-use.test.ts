import { describe, expect, it } from "vitest";
import {
  EventTypeSchema,
  MemoryUseEventDataSchema,
  RetrievalAttributionSchema,
  SessionEventSchema,
} from "./index.js";

const memoryRef = {
  record_schema_version: "tracegraph.memory-record.v1",
  memory_id: "memory:one",
  version: 3,
  content_hash: `sha256:${"a".repeat(64)}`,
  evidence_refs: [{
    source_id: "source:origin",
    source_type: "user",
    trust: "trusted",
  }],
} as const;

const retrieval = {
  rank: 1,
  hit_id: "chunk:one",
  content_hash: `sha256:${"b".repeat(64)}`,
  score: 2.5,
  source_path: `memory/${encodeURIComponent(memoryRef.memory_id)}.md`,
  start_line: 1,
  end_line: 1,
  heading_path: [],
  injected_tokens: 2,
  memory_ref: memoryRef,
} as const;

const estimate = {
  estimator_id: "heuristic_v2",
  confidence: "estimated",
  input_tokens: 2,
  output_tokens: 0,
  per_section: { system: 0, goal: 0, history: 0, tool: 0, repo: 0, memory: 2 },
} as const;

describe("MemoryUse and Context provenance contracts", () => {
  it("requires canonical identity and exact version for indexed Memory paths", () => {
    expect(RetrievalAttributionSchema.parse(retrieval).memory_ref).toEqual(memoryRef);
    expect(RetrievalAttributionSchema.safeParse({ ...retrieval, memory_ref: undefined }).success).toBe(false);
    expect(RetrievalAttributionSchema.safeParse({
      ...retrieval,
      source_path: "docs/guide.md",
    }).success).toBe(false);
  });

  it("records a content-free dispatch intent bound to manifest, digest, tokens, and evidence", () => {
    const intent = MemoryUseEventDataSchema.parse({
      memory_use_id: "memory-use:one",
      stage: "dispatch_intent",
      manifest_id: "context:one",
      rendered_context_digest: `sha256:${"c".repeat(64)}`,
      token_estimate: estimate,
      memory_items: [{
        context_item_id: "context-item:one",
        memory_ref: memoryRef,
        retrieval,
        content_digest: `sha256:${"d".repeat(64)}`,
        included_tokens: 2,
      }],
    });
    expect(intent.stage).toBe("dispatch_intent");
    if (intent.stage !== "dispatch_intent") throw new Error("Expected a dispatch intent");
    expect(EventTypeSchema.parse("memory.use_status")).toBe("memory.use_status");
    expect(SessionEventSchema.parse({
      schema_version: "tracegraph.session-event.v1",
      event_id: "event:memory-use-intent",
      project_id: "project:memory-use",
      run_id: "run:memory-use",
      sequence: 1,
      occurred_at: "2026-09-30T00:00:00.000Z",
      attempt: 0,
      summary: "MemoryUse dispatch intent",
      artifact_refs: [],
      turn_id: "turn:memory-use",
      model_call_id: "model-call:memory-use",
      context_manifest_ref: "context:one",
      event_hash: `sha256:${"e".repeat(64)}`,
      type: "memory.use_status",
      data: intent,
    }).type).toBe("memory.use_status");
    expect(SessionEventSchema.safeParse({
      schema_version: "tracegraph.session-event.v1",
      event_id: "event:memory-use-invalid",
      project_id: "project:memory-use",
      run_id: "run:memory-use",
      sequence: 1,
      occurred_at: "2026-09-30T00:00:00.000Z",
      attempt: 0,
      summary: "MemoryUse dispatch intent",
      artifact_refs: [],
      event_hash: `sha256:${"f".repeat(64)}`,
      type: "memory.use_status",
      data: { memory_use_id: "memory-use:one", stage: "response", response_body: "claim text" },
    }).success).toBe(false);
    expect(JSON.stringify(intent)).not.toContain("claim text");
    expect(() => MemoryUseEventDataSchema.parse({
      ...intent,
      memory_items: [{ ...intent.memory_items[0]!, included_tokens: 1 }],
    })).toThrow();
  });

  it("keeps terminal status events small and rejects response bodies", () => {
    expect(MemoryUseEventDataSchema.parse({
      memory_use_id: "memory-use:one",
      stage: "response",
    })).toEqual({ memory_use_id: "memory-use:one", stage: "response" });
    expect(MemoryUseEventDataSchema.safeParse({
      memory_use_id: "memory-use:one",
      stage: "response",
      response_body: "claim text",
    }).success).toBe(false);
  });
});
