import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  JsonlEventLedger,
  createAgentRuntime,
  replaySnapshotFromEvents,
} from "../../packages/core/dist/index.js";
import type {
  ArtifactRef,
  EventType,
  SessionEventProposal,
} from "../../packages/contracts/dist/index.js";
import { createTemporaryDataDir } from "../../packages/test-support/dist/index.js";

const SESSION_ID = "session:eval:replay";
const RUN_ID = "run:eval:replay";
const PROJECT_ID = "project:eval:replay";

describe("G23 replay: deterministic time travel", () => {
  it("rebuilds every recorded sequence with the same canonical projection hash after restart", async () => {
    const data = await createTemporaryDataDir();
    try {
      let eventCounter = 0;
      const ledger = new JsonlEventLedger(join(data.path, "events"), {
        now: () => new Date("2026-09-19T12:00:00.000Z"),
        idFactory: (prefix) => `${prefix}:eval:replay:${++eventCounter}`,
      });
      const recorded = [];

      for (const proposal of replayScenario()) {
        await ledger.append(proposal);
        const events = await ledger.list(RUN_ID);
        recorded.push(replaySnapshotFromEvents(events, {
          session_id: SESSION_ID,
          run_id: RUN_ID,
          until_sequence: events.length,
        }));
      }
      const canonicalBeforeReplay = await ledger.list(RUN_ID);

      // A fresh Runtime proves replay is based on the durable Ledger rather
      // than the process that originally observed each live projection.
      const restarted = await createAgentRuntime({ dataDir: data.path });
      for (const expected of recorded) {
        const replayed = await restarted.replayAt({
          session_id: SESSION_ID,
          run_id: RUN_ID,
          until_sequence: expected.until_sequence,
        });
        expect(replayed.snapshot_hash).toBe(expected.snapshot_hash);
        expect(replayed.projection).toEqual(expected.projection);
        expect(replayed.anchor_event_hash).toBe(expected.anchor_event_hash);
      }

      const diff = await restarted.replayDiff({
        session_id: SESSION_ID,
        run_id: RUN_ID,
        from: 4,
        to: 6,
      });
      expect(diff.tool_results.added.map(({ type }) => type)).toEqual(["tool.completed"]);
      expect(diff.evidence.added.map(({ artifact_id: artifactId }) => artifactId)).toEqual([
        "artifact:eval:tool-result",
      ]);
      expect(diff.approval.after?.approval_id).toBe("approval:eval:replay");

      // Read-only replay must not append an event or invoke a model/tool path.
      expect(await ledger.list(RUN_ID)).toEqual(canonicalBeforeReplay);
    } finally {
      await data.cleanup();
    }
  });
});

function replayScenario(): SessionEventProposal[] {
  const todo = {
    todo_id: "todo:eval:replay",
    title: "Verify deterministic replay",
    state: "pending",
    depends_on: [],
    evidence_event_ids: [],
    created_by: "model",
  } as const;
  const artifact: ArtifactRef = {
    artifact_id: "artifact:eval:tool-result",
    kind: "tool_output",
    content_hash: `sha256:${"a".repeat(64)}`,
    mime_type: "application/json",
    byte_length: 24,
    project_id: PROJECT_ID,
    run_id: RUN_ID,
    created_at: "2026-09-19T12:00:00.000Z",
  };
  const pendingApproval = {
    approval_id: "approval:eval:replay",
    action_id: "action:eval:replay",
    risk: "high",
    preview: {
      preview_id: "preview:eval:replay",
      action_id: "action:eval:replay",
      path: "src/replay.ts",
      diff: "+ deterministic replay\n",
      base_hash: `sha256:${"b".repeat(64)}`,
      patch_hash: `sha256:${"c".repeat(64)}`,
      scope: ["src/replay.ts"],
      expires_at: "2026-09-19T12:10:00.000Z",
    },
  } as const;

  return [
    proposal("run.created", {
      task: "Replay every durable state",
      mode: "plan",
      workspace_kind: "managed_local",
    }),
    proposal("todo.created", { todo }),
    proposal("plan.ready", { todo_ids: [todo.todo_id], todo_count: 1 }),
    proposal("plan.approved", {
      plan_event_id: "event:eval:replay:3",
      todo_ids: [todo.todo_id],
      approved_by: "user",
    }),
    proposal("tool.completed", { tool_name: "read_file", status: "success" }, [artifact]),
    proposal("approval.requested", { pending_approval: pendingApproval }),
    proposal("approval.denied", {
      approval_id: pendingApproval.approval_id,
      action_id: pendingApproval.action_id,
    }),
    proposal("run.completed", { outcome: "Replay fixture completed" }),
  ];
}

function proposal(
  type: EventType,
  data: Record<string, unknown>,
  artifactRefs: ArtifactRef[] = [],
): SessionEventProposal {
  return {
    type,
    project_id: PROJECT_ID,
    session_id: SESSION_ID,
    run_id: RUN_ID,
    attempt: 0,
    summary: `${type} replay fixture`,
    artifact_refs: artifactRefs,
    data,
  };
}
