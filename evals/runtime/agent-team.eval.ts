import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  JsonlEventLedger,
  TeamDomainService,
} from "../../packages/core/dist/index.js";
import type {
  SessionEventProposal,
  SubagentRunLink,
} from "../../packages/contracts/dist/index.js";
import { createTemporaryDataDir } from "../../packages/test-support/dist/index.js";

const ROLE_HASH = `sha256:${"a".repeat(64)}` as const;
const PACKET_HASH = `sha256:${"b".repeat(64)}` as const;

describe("runtime behavior: durable agent team", () => {
  it("survives restart, gives a raced task one owner, and reopens it without reassignment on timeout", async () => {
    const data = await createTemporaryDataDir();
    try {
      let nowMs = Date.parse("2026-09-20T00:00:00.000Z");
      let sequence = 0;
      const projectId = "project:eval-agent-team";
      const runId = "run:eval-agent-team";
      const sessionId = "session:eval-agent-team";
      const eventsRoot = join(data.path, "team-events");
      const now = () => new Date(nowMs);
      const idFactory = (prefix: string) => `${prefix}:eval-team:${++sequence}`;
      const ledger = new JsonlEventLedger(eventsRoot, { now, idFactory });
      const proposal = (
        type: SessionEventProposal["type"],
        summary: string,
        eventData: Record<string, unknown>,
      ): SessionEventProposal => ({
        type,
        project_id: projectId,
        run_id: runId,
        session_id: sessionId,
        attempt: 0,
        summary,
        artifact_refs: [],
        data: eventData,
      });

      await ledger.append(proposal("run.created", "Agent Team evaluation Run created", {
        task: "Coordinate two durable workers",
        mode: "execute",
        workspace_kind: "managed_local",
        subagent_limits: { max_parallel_subagents: 2, max_depth: 1 },
      }));
      const options = {
        now,
        idFactory,
        defaultLimits: {
          max_parallel_workers: 2,
          heartbeat_timeout_ms: 1_000,
          max_members: 8,
          max_mailbox_messages: 32,
          max_tasks: 32,
        },
      };
      const coordinator = {
        projectId,
        runId,
        sessionId,
        actor: { kind: "lead" as const },
      };
      let teams = new TeamDomainService(ledger, options);
      await teams.execute(coordinator, {
        command_id: "command:eval-team:create",
        operation: "create_team",
      });

      const appendWorker = async (index: number): Promise<SubagentRunLink> => {
        const link: SubagentRunLink = {
          subagent_id: `subagent:eval-team:${index}`,
          parent_run_id: runId,
          parent_session_id: sessionId,
          child_run_id: `run:eval-team:child:${index}`,
          child_session_id: `session:eval-team:child:${index}`,
        };
        const role = `worker-${index}`;
        await ledger.append(proposal("subagent.started", `Worker ${index} started`, {
          link,
          spec: {
            subagent_id: link.subagent_id,
            parent_run_id: runId,
            name: role,
            provider_key: "eval",
            role_prompt_version: "agent-team-eval.v1",
            role_prompt_hash: ROLE_HASH,
            tool_allowlist: ["team_read", "team_task_write", "team_mailbox_send", "team_mailbox_claim", "team_heartbeat"],
            context_scope: "isolated",
            budget: { max_steps: 4, max_tokens: 4_000 },
            depth: 1,
          },
          limits: { max_parallel_subagents: 2, max_depth: 1 },
          task_packet_hash: PACKET_HASH,
        }));
        await teams.execute(coordinator, {
          command_id: `command:eval-team:join:${index}`,
          operation: "join_member",
          subagent_id: link.subagent_id,
          role,
        });
        return link;
      };
      const workers = [await appendWorker(1), await appendWorker(2)];
      const member = (index: number) => ({
        projectId,
        runId,
        sessionId,
        actor: { kind: "member" as const, subagent_id: workers[index]!.subagent_id },
      });

      await teams.execute(member(0), {
        command_id: "command:eval-team:mailbox",
        operation: "deliver_mailbox",
        message_id: "message:eval-team:durable",
        to: "coordinator",
        kind: "answer",
        payload: "Durable worker answer",
      });

      const reopenedLedger = new JsonlEventLedger(eventsRoot, { now, idFactory });
      teams = new TeamDomainService(reopenedLedger, options);
      expect((await teams.read(runId))?.mailbox.messages).toEqual([
        expect.objectContaining({
          message_id: "message:eval-team:durable",
          from: workers[0]?.subagent_id,
          to: "coordinator",
        }),
      ]);

      await teams.execute(coordinator, {
        command_id: "command:eval-team:task:create",
        operation: "create_task",
        task_id: "task:eval-team:race",
        title: "Exactly one worker owns this task",
        acceptance: ["A durable claim has one owner"],
      });
      const claims = await Promise.allSettled(workers.map((_, index) => teams.execute(member(index), {
        command_id: `command:eval-team:task:claim:${index + 1}`,
        operation: "claim_task",
        task_id: "task:eval-team:race",
        expected_version: 1,
      })));
      expect(claims.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(claims.filter(({ status }) => status === "rejected")).toHaveLength(1);

      const claimed = (await teams.read(runId))?.task_board.items[0];
      expect(claimed).toMatchObject({ state: "claimed", version: 2 });
      expect(workers.map(({ subagent_id: subagentId }) => subagentId)).toContain(claimed?.owner);

      nowMs += 1_001;
      const swept = await teams.expireMembers(coordinator, "command:eval-team:sweep");
      expect(swept.roster.members.every(({ status }) => status === "lost")).toBe(true);
      expect(swept.task_board.items[0]).toMatchObject({
        task_id: "task:eval-team:race",
        state: "open",
        version: 3,
        evidence_event_ids: [],
      });
      expect(swept.task_board.items[0]?.owner).toBeUndefined();
      expect((await reopenedLedger.list(runId)).filter(({ type }) => type === "team.task_claimed"))
        .toHaveLength(1);

      const secondRestart = new TeamDomainService(
        new JsonlEventLedger(eventsRoot, { now, idFactory }),
        options,
      );
      expect(await secondRestart.read(runId)).toEqual(swept);
    } finally {
      await data.cleanup();
    }
  });
});
