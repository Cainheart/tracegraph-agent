import {
  SCHEMA_VERSION,
  SessionEventSchema,
  type ArtifactRef,
  type EventType,
  type SessionEvent,
} from "@tracegraph/contracts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256, stableStringify } from "./crypto.js";
import { JsonlEventLedger } from "./event-ledger.js";
import { projectRun } from "./projection.js";
import {
  ReplayError,
  computeReplaySnapshotHash,
  replayDiffFromEvents,
  replaySnapshotFromEvents,
} from "./replay.js";
import { createAgentRuntime } from "./runtime.js";

const SESSION_ID = "session:replay";
const RUN_ID = "run:replay";
const PROJECT_ID = "project:replay";

describe("G23 sequence-bounded replay", () => {
  it("replays every valid sequence and keeps historical hashes stable as the head advances", () => {
    const events = replayLedger();
    for (let sequence = 1; sequence <= events.length; sequence += 1) {
      const snapshot = replaySnapshotFromEvents(events, {
        session_id: SESSION_ID,
        run_id: RUN_ID,
        until_sequence: sequence,
      });
      expect(snapshot.projection).toEqual(projectRun(events.slice(0, sequence)));
      expect(snapshot.projection.last_sequence).toBe(sequence);
      expect(snapshot.snapshot_hash).toBe(computeReplaySnapshotHash(snapshot));
    }

    const beforeGrowth = replaySnapshotFromEvents(events.slice(0, 7), {
      session_id: SESSION_ID,
      run_id: RUN_ID,
      until_sequence: 4,
    });
    const afterGrowth = replaySnapshotFromEvents(events, {
      session_id: SESSION_ID,
      run_id: RUN_ID,
      until_sequence: 4,
    });
    expect(afterGrowth.head_sequence).toBeGreaterThan(beforeGrowth.head_sequence);
    expect(afterGrowth.snapshot_hash).toBe(beforeGrowth.snapshot_hash);
    expect(afterGrowth.projection).toEqual(beforeGrowth.projection);
  });

  it("rejects ambiguous scope, out-of-range sequences, and corruption after the requested prefix", () => {
    const events = replayLedger();
    expectReplayError(
      () => replaySnapshotFromEvents([], {
        session_id: SESSION_ID,
        run_id: RUN_ID,
        until_sequence: 1,
      }),
      "run_not_found",
    );
    expectReplayError(
      () => replaySnapshotFromEvents(events, {
        session_id: "session:other",
        run_id: RUN_ID,
        until_sequence: 1,
      }),
      "replay_scope_mismatch",
    );
    expectReplayError(
      () => replaySnapshotFromEvents(events, {
        session_id: SESSION_ID,
        run_id: RUN_ID,
        until_sequence: events.length + 1,
      }),
      "replay_sequence_out_of_range",
    );

    const corrupted = [...events];
    corrupted[7] = { ...corrupted[7]!, summary: "tampered after the requested prefix" };
    expectReplayError(
      () => replaySnapshotFromEvents(corrupted, {
        session_id: SESSION_ID,
        run_id: RUN_ID,
        until_sequence: 2,
      }),
      "replay_source_invalid",
    );

    const { event_hash: _rootHash, ...rootBody } = events[0]!;
    const rootWithUnexpectedParentBody = {
      ...rootBody,
      previous_event_hash: `sha256:${"f".repeat(64)}` as const,
    };
    const unexpectedRootParent = [
      SessionEventSchema.parse({
        ...rootWithUnexpectedParentBody,
        event_hash: sha256(stableStringify(rootWithUnexpectedParentBody)),
      }),
      ...events.slice(1),
    ];
    expectReplayError(
      () => replaySnapshotFromEvents(unexpectedRootParent, {
        session_id: SESSION_ID,
        run_id: RUN_ID,
        until_sequence: 1,
      }),
      "replay_source_invalid",
    );
  });

  it("diffs evidence, tool results, Todos, and approval state in both directions", () => {
    const events = replayLedger();
    const forward = replayDiffFromEvents(events, {
      session_id: SESSION_ID,
      run_id: RUN_ID,
      from: 3,
      to: 6,
    });
    expect(forward.direction).toBe("forward");
    expect(forward.events.added.map(({ sequence }) => sequence)).toEqual([4, 5, 6]);
    expect(forward.events.removed).toEqual([]);
    expect(forward.evidence.added.map(({ artifact_id: artifactId }) => artifactId)).toEqual([
      "artifact:tool-result",
    ]);
    expect(forward.tool_results.added.map(({ sequence }) => sequence)).toEqual([5]);
    expect(forward.todos.changed).toEqual([{
      todo_id: "todo:one",
      before: expect.objectContaining({ title: "Inspect replay" }),
      after: expect.objectContaining({ title: "Inspect deterministic replay" }),
    }]);
    expect(forward.approval.changed).toBe(true);
    expect(forward.approval.before).toBeUndefined();
    expect(forward.approval.after).toEqual(expect.objectContaining({ approval_id: "approval:one" }));

    const backward = replayDiffFromEvents(events, {
      session_id: SESSION_ID,
      run_id: RUN_ID,
      from: 6,
      to: 3,
    });
    expect(backward.direction).toBe("backward");
    expect(backward.events.added).toEqual([]);
    expect(backward.events.removed.map(({ sequence }) => sequence)).toEqual([4, 5, 6]);
    expect(backward.evidence.removed.map(({ artifact_id: artifactId }) => artifactId)).toEqual([
      "artifact:tool-result",
    ]);
    expect(backward.tool_results.removed.map(({ sequence }) => sequence)).toEqual([5]);
    expect(backward.todos.changed[0]).toEqual(expect.objectContaining({
      before: expect.objectContaining({ title: "Inspect deterministic replay" }),
      after: expect.objectContaining({ title: "Inspect replay" }),
    }));
    expect(backward.approval.changed).toBe(true);
    expect(backward.approval.before).toEqual(expect.objectContaining({ approval_id: "approval:one" }));
    expect(backward.approval.after).toBeUndefined();
  });

  it("returns an empty same-sequence diff with identical hashes", () => {
    const diff = replayDiffFromEvents(replayLedger(), {
      session_id: SESSION_ID,
      run_id: RUN_ID,
      from: 5,
      to: 5,
    });
    expect(diff.direction).toBe("same");
    expect(diff.from_snapshot_hash).toBe(diff.to_snapshot_hash);
    expect(diff.events).toEqual({ added: [], removed: [] });
    expect(diff.evidence).toEqual({ added: [], removed: [], changed: [] });
    expect(diff.todos).toEqual({ added: [], removed: [], changed: [] });
    expect(diff.approval.changed).toBe(false);
  });

  it("keeps identical Run-local sequences distinct across Runs in one Session", () => {
    const first = replayLedger();
    const second = buildLedger([
      eventProposal("run.created", { task: "Second Run", mode: "execute", workspace_kind: "managed_local" }),
      eventProposal("run.started", { phase: "conversation" }),
    ], "run:second");
    const firstSnapshot = replaySnapshotFromEvents(first, {
      session_id: SESSION_ID,
      run_id: RUN_ID,
      until_sequence: 2,
    });
    const secondSnapshot = replaySnapshotFromEvents(second, {
      session_id: SESSION_ID,
      run_id: "run:second",
      until_sequence: 2,
    });
    expect(firstSnapshot.until_sequence).toBe(secondSnapshot.until_sequence);
    expect(firstSnapshot.run_id).not.toBe(secondSnapshot.run_id);
    expect(firstSnapshot.snapshot_hash).not.toBe(secondSnapshot.snapshot_hash);
  });

  it("exposes bounded replay and same-read diff through AgentRuntime while preserving latest replay", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "tracegraph-g23-runtime-"));
    try {
      const runtime = await createAgentRuntime({ dataDir });
      const ledger = new JsonlEventLedger(join(dataDir, "events"), {
        now: () => new Date("2026-09-19T12:00:00.000Z"),
        idFactory: sequentialIdFactory(),
      });
      await ledger.append({
        type: "run.created",
        project_id: PROJECT_ID,
        run_id: RUN_ID,
        session_id: SESSION_ID,
        attempt: 0,
        summary: "Run created",
        artifact_refs: [],
        data: { task: "Runtime replay", mode: "execute", workspace_kind: "managed_local" },
      });
      await ledger.append({
        type: "run.started",
        project_id: PROJECT_ID,
        run_id: RUN_ID,
        session_id: SESSION_ID,
        attempt: 0,
        summary: "Run started",
        artifact_refs: [],
        data: { phase: "conversation" },
      });

      const bounded = await runtime.replayAt({
        session_id: SESSION_ID,
        run_id: RUN_ID,
        until_sequence: 1,
      });
      const diff = await runtime.replayDiff({
        session_id: SESSION_ID,
        run_id: RUN_ID,
        from: 1,
        to: 2,
      });
      const latest = await runtime.replay(RUN_ID);
      expect(bounded.projection.last_sequence).toBe(1);
      expect(diff.events.added.map(({ sequence }) => sequence)).toEqual([2]);
      expect(latest.last_sequence).toBe(2);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

function replayLedger(): SessionEvent[] {
  const artifact: ArtifactRef = {
    artifact_id: "artifact:tool-result",
    kind: "tool_output",
    content_hash: `sha256:${"c".repeat(64)}`,
    mime_type: "application/json",
    byte_length: 24,
    project_id: PROJECT_ID,
    run_id: RUN_ID,
    created_at: "2026-09-19T12:00:05.000Z",
  };
  const pendingApproval = {
    approval_id: "approval:one",
    action_id: "action:one",
    risk: "high",
    preview: {
      preview_id: "preview:one",
      action_id: "action:one",
      path: "src/replay.ts",
      diff: "+ replay\n",
      base_hash: `sha256:${"d".repeat(64)}`,
      patch_hash: `sha256:${"e".repeat(64)}`,
      scope: ["src/replay.ts"],
      expires_at: "2026-09-19T12:10:00.000Z",
    },
  };
  const todo = {
    todo_id: "todo:one",
    title: "Inspect replay",
    state: "pending",
    depends_on: [],
    evidence_event_ids: [],
    created_by: "user",
  } as const;
  return buildLedger([
    eventProposal("run.created", { task: "Replay the Run", mode: "execute", workspace_kind: "managed_local" }),
    eventProposal("run.started", { phase: "conversation" }),
    eventProposal("todo.created", { todo }),
    eventProposal("approval.requested", { pending_approval: pendingApproval }),
    eventProposal("tool.completed", { receipt: { status: "success" } }, [artifact]),
    eventProposal("todo.updated", {
      todo: { ...todo, title: "Inspect deterministic replay" },
      previous_state: "pending",
      updated_by: "user",
    }),
    eventProposal("approval.denied", { approval_id: "approval:one", action_id: "action:one" }),
    eventProposal("run.completed", { outcome: "Replay complete" }),
    eventProposal("session.title_changed", { title: "Replay history" }),
  ]);
}

function eventProposal(
  type: EventType,
  data: Record<string, unknown>,
  artifactRefs: readonly ArtifactRef[] = [],
): { type: EventType; data: Record<string, unknown>; artifactRefs: readonly ArtifactRef[] } {
  return { type, data, artifactRefs };
}

function buildLedger(
  proposals: readonly ReturnType<typeof eventProposal>[],
  runId = RUN_ID,
): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const [index, proposal] of proposals.entries()) {
    const previous = events.at(-1);
    const body = {
      schema_version: SCHEMA_VERSION,
      event_id: `${runId}:event:${index + 1}`,
      project_id: PROJECT_ID,
      run_id: runId,
      session_id: SESSION_ID,
      sequence: index + 1,
      occurred_at: `2026-09-19T12:00:${String(index + 1).padStart(2, "0")}.000Z`,
      attempt: 0,
      summary: `${proposal.type} at sequence ${index + 1}`,
      artifact_refs: proposal.artifactRefs,
      ...(previous === undefined ? {} : { previous_event_hash: previous.event_hash }),
      type: proposal.type,
      data: proposal.data,
    };
    events.push(SessionEventSchema.parse({
      ...body,
      event_hash: sha256(stableStringify(body)),
    }));
  }
  return events;
}

function expectReplayError(operation: () => unknown, code: ReplayError["code"]): void {
  try {
    operation();
    throw new Error("Expected replay operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ReplayError);
    expect((error as ReplayError).code).toBe(code);
  }
}

function sequentialIdFactory(): (prefix: string) => string {
  let sequence = 0;
  return (prefix) => `${prefix}:g23-${++sequence}`;
}
