import { describe, expect, it } from "vitest";
import {
  PROJECTOR_VERSION,
  REPLAY_DIFF_VERSION,
  REPLAY_SNAPSHOT_VERSION,
  ReplayDiffQuerySchema,
  ReplayDiffSchema,
  ReplaySessionResponseSchema,
  ReplaySnapshotRequestSchema,
  ReplaySnapshotSchema,
  SCHEMA_VERSION,
  type ReplaySnapshot,
  type RunProjection,
  type WireSessionEvent,
} from "./index.js";

const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;

describe("G23 replay contracts", () => {
  it("requires an unambiguous Run-scoped positive sequence", () => {
    expect(ReplaySnapshotRequestSchema.parse({
      session_id: "session:test",
      run_id: "run:test",
      until_sequence: 2,
    })).toEqual({
      session_id: "session:test",
      run_id: "run:test",
      until_sequence: 2,
    });
    expect(() => ReplaySnapshotRequestSchema.parse({
      session_id: "session:test",
      until_sequence: 2,
    })).toThrow();
    expect(() => ReplaySnapshotRequestSchema.parse({
      session_id: "session:test",
      run_id: "run:test",
      until_sequence: 0,
    })).toThrow();
    expect(() => ReplaySnapshotRequestSchema.parse({
      session_id: "session:test",
      run_id: "run:test",
      until_sequence: 1.5,
    })).toThrow();
  });

  it("binds the canonical snapshot envelope to one contiguous projection prefix", () => {
    const snapshot = replaySnapshot();
    expect(ReplaySnapshotSchema.parse(snapshot)).toEqual(snapshot);

    expect(() => ReplaySnapshotSchema.parse({
      ...snapshot,
      projection: { ...snapshot.projection, run_id: "run:other" },
    })).toThrow("projection run_id must match replay run_id");
    expect(() => ReplaySnapshotSchema.parse({
      ...snapshot,
      anchor_event_id: "event:other",
    })).toThrow("anchor_event_id must identify the replay prefix tail");
    expect(() => ReplaySnapshotSchema.parse({
      ...snapshot,
      projection: {
        ...snapshot.projection,
        timeline: [snapshot.projection.timeline[1]!, snapshot.projection.timeline[0]!],
      },
    })).toThrow("replay timeline sequence must be contiguous and one-based");
    expect(() => ReplaySnapshotSchema.parse({
      ...snapshot,
      head_sequence: 1,
    })).toThrow("until_sequence cannot exceed head_sequence");
  });

  it("rejects a projection that does not describe the claimed replay prefix", () => {
    const snapshot = replaySnapshot();
    const project = (overrides: Record<string, unknown>) => ({
      ...snapshot,
      projection: { ...snapshot.projection, ...overrides },
    });
    expect(() => ReplaySnapshotSchema.parse(project({ session_id: "session:other" })))
      .toThrow("projection session_id must match replay session_id");
    expect(() => ReplaySnapshotSchema.parse(project({ project_id: "project:other" })))
      .toThrow("projection project_id must match replay project_id");
    expect(() => ReplaySnapshotSchema.parse(project({ last_sequence: 1 })))
      .toThrow("projection last_sequence must equal until_sequence");
    expect(() => ReplaySnapshotSchema.parse(project({ todos: { items: [], last_sequence: 1 } })))
      .toThrow("Todo projection must cover the same replay prefix");
    expect(() => ReplaySnapshotSchema.parse(project({ timeline: [snapshot.projection.timeline[0]!] })))
      .toThrow("replay timeline must contain every sequence from one through until_sequence");
    expect(() => ReplaySnapshotSchema.parse(project({
      timeline: [
        { ...snapshot.projection.timeline[0]!, run_id: "run:other" },
        snapshot.projection.timeline[1]!,
      ],
    }))).toThrow("replay timeline event is outside the snapshot scope");
    expect(() => ReplaySnapshotSchema.parse(project({
      artifact_refs: [{
        artifact_id: "artifact:test",
        kind: "report",
        content_hash: HASH_A,
        mime_type: "text/markdown",
        byte_length: 1,
        project_id: "project:test",
        run_id: "run:other",
        created_at: "2026-09-19T12:00:00.000Z",
      }],
    }))).toThrow("replay Artifact is outside the snapshot scope");
  });

  it("keeps Host replay authority outside the canonical snapshot", () => {
    const snapshot = replaySnapshot();
    expect(() => ReplaySnapshotSchema.parse({
      ...snapshot,
      replay_token: "x".repeat(32),
    })).toThrow();
    expect(ReplaySessionResponseSchema.parse({
      replay_id: "replay:test",
      replay_token: "r".repeat(32),
      expires_at: "2026-09-19T12:30:00.000Z",
      snapshot,
    }).snapshot.snapshot_hash).toBe(HASH_B);
    expect(() => ReplaySessionResponseSchema.parse({
      replay_id: "replay:test",
      replay_token: "too-short",
      expires_at: "2026-09-19T12:30:00.000Z",
      snapshot,
    })).toThrow();
  });

  it("coerces HTTP diff query sequences and validates direction and head", () => {
    expect(ReplayDiffQuerySchema.parse({
      session_id: "session:test",
      run_id: "run:test",
      from: "1",
      to: "2",
    })).toEqual({ session_id: "session:test", run_id: "run:test", from: 1, to: 2 });

    const diff = {
      schema_version: REPLAY_DIFF_VERSION,
      session_id: "session:test",
      project_id: "project:test",
      run_id: "run:test",
      head_sequence: 2,
      from_sequence: 1,
      to_sequence: 2,
      direction: "forward",
      from_snapshot_hash: HASH_A,
      to_snapshot_hash: HASH_B,
      events: { added: [], removed: [] },
      evidence: { added: [], removed: [], changed: [] },
      tool_results: { added: [], removed: [] },
      todos: { added: [], removed: [], changed: [] },
      approval: { changed: false },
      pending_plan: { changed: false },
    } as const;
    expect(ReplayDiffSchema.parse(diff).direction).toBe("forward");
    expect(() => ReplayDiffSchema.parse({ ...diff, direction: "backward" })).toThrow(
      "diff direction must match from_sequence and to_sequence",
    );
    expect(() => ReplayDiffSchema.parse({ ...diff, head_sequence: 1 })).toThrow(
      "diff endpoints cannot exceed head_sequence",
    );
  });
});

function replaySnapshot(): ReplaySnapshot {
  const timeline = [
    wireEvent(1, "run.created", { task: "Inspect replay", mode: "execute", workspace_kind: "managed_local" }),
    wireEvent(2, "run.started", { phase: "conversation" }),
  ];
  const projection: RunProjection = {
    schema_version: SCHEMA_VERSION,
    projector_version: PROJECTOR_VERSION,
    project_id: "project:test",
    session_id: "session:test",
    run_id: "run:test",
    task: "Inspect replay",
    mode: "execute",
    reasoning_effort: "default",
    workspace_kind: "managed_local",
    status: "running",
    last_sequence: 2,
    timeline,
    todos: { items: [], last_sequence: 2 },
    input_queue: { pending: [] },
    subagents: {
      items: [],
      active_count: 0,
      last_sequence: 2,
      limits: { max_parallel_subagents: 2, max_depth: 1 },
    },
    attachments: { items: [], last_sequence: 0 },
    artifact_refs: [],
  };
  return {
    schema_version: REPLAY_SNAPSHOT_VERSION,
    session_id: "session:test",
    project_id: "project:test",
    run_id: "run:test",
    until_sequence: 2,
    head_sequence: 2,
    anchor_event_id: "event:2",
    anchor_event_hash: HASH_A,
    projection,
    snapshot_hash: HASH_B,
  };
}

function wireEvent(
  sequence: number,
  type: WireSessionEvent["type"],
  data: Record<string, unknown>,
): WireSessionEvent {
  return {
    schema_version: SCHEMA_VERSION,
    event_id: `event:${sequence}`,
    project_id: "project:test",
    session_id: "session:test",
    run_id: "run:test",
    sequence,
    occurred_at: `2026-09-19T12:00:0${sequence}.000Z`,
    type,
    summary: `Event ${sequence}`,
    artifact_refs: [],
    data,
  };
}
