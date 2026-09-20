import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SubagentStartedDataSchema,
  type SessionEventProposal,
  type SubagentRunLink,
} from "@tracegraph/contracts";
import { sha256 } from "./crypto.js";
import { JsonlEventLedger } from "./event-ledger.js";
import { TeamDomainService, projectTeam } from "./team.js";

const roots: string[] = [];
const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("G-08 durable Agent Team domain", () => {
  it("replays mailbox delivery and claim across service restart without trusting a caller-supplied actor", async () => {
    const harness = await createHarness("mailbox");
    await harness.createTeam();
    await harness.join(1);

    await harness.service.execute(harness.memberScope(1), {
      command_id: "command:mailbox:deliver",
      operation: "deliver_mailbox",
      message_id: "message:worker-question",
      to: "coordinator",
      kind: "question",
      payload: "Which acceptance check should I run?",
    });

    const restarted = harness.restartService();
    expect((await restarted.read(harness.runId))?.mailbox.messages).toEqual([
      expect.objectContaining({
        message_id: "message:worker-question",
        from: "subagent:1",
        to: "coordinator",
      }),
    ]);

    const claimed = await restarted.execute(harness.coordinatorScope, {
      command_id: "command:mailbox:claim",
      operation: "claim_mailbox",
      message_id: "message:worker-question",
    });
    expect(claimed.mailbox.messages[0]).toMatchObject({
      claimed_by: "coordinator",
      claimed_at: expect.any(String),
    });
    await expect(restarted.execute(harness.memberScope(1), {
      command_id: "command:mailbox:wrong-recipient",
      operation: "claim_mailbox",
      message_id: "message:worker-question",
    })).rejects.toMatchObject({ code: "mailbox_message_already_claimed" });
  });

  it("serializes concurrent claims so one durable sequence owns a task", async () => {
    const harness = await createHarness("claim-race");
    await harness.createTeam();
    await harness.join(1);
    await harness.join(2);
    await harness.service.execute(harness.coordinatorScope, {
      command_id: "command:task:create",
      operation: "create_task",
      task_id: "task:race",
      title: "Claim exactly once",
      acceptance: ["One owner is durable"],
    });

    const results = await Promise.allSettled([
      harness.service.execute(harness.memberScope(1), {
        command_id: "command:task:claim:1",
        operation: "claim_task",
        task_id: "task:race",
        expected_version: 1,
      }),
      harness.service.execute(harness.memberScope(2), {
        command_id: "command:task:claim:2",
        operation: "claim_task",
        task_id: "task:race",
        expected_version: 1,
      }),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const task = (await harness.service.read(harness.runId))?.task_board.items[0];
    expect(task).toMatchObject({
      state: "claimed",
      version: 2,
      owner: expect.stringMatching(/^subagent:[12]$/u),
    });
    expect((await harness.ledger.list(harness.runId)).filter(({ type }) => type === "team.task_claimed"))
      .toHaveLength(1);
  });

  it("atomically marks an expired member lost and reopens every claimed task without reassignment", async () => {
    const harness = await createHarness("heartbeat-loss");
    await harness.createTeam();
    await harness.join(1);
    await harness.join(2);
    await harness.service.execute(harness.coordinatorScope, {
      command_id: "command:task:create:loss",
      operation: "create_task",
      task_id: "task:loss",
      title: "Return to the board on loss",
      acceptance: ["Owner is cleared"],
    });
    await harness.service.execute(harness.memberScope(1), {
      command_id: "command:task:claim:loss",
      operation: "claim_task",
      task_id: "task:loss",
      expected_version: 1,
    });

    harness.advance(1_001);
    const swept = await harness.service.expireMembers(harness.coordinatorScope, "sweep:one");
    expect(swept.roster.members.find(({ link }) => link.subagent_id === "subagent:1"))
      .toMatchObject({ status: "lost" });
    expect(swept.task_board.items[0]).toMatchObject({
      state: "open",
      owner: undefined,
      evidence_event_ids: [],
      version: 3,
    });
    expect(swept.task_board.items[0]?.owner).toBeUndefined();
    expect(swept.task_board.items[0]?.owner).not.toBe("subagent:2");

    const events = await harness.ledger.list(harness.runId);
    const lost = events.filter(({ type }) => type === "team.member_lost");
    expect(lost).toHaveLength(2);
    expect(lost.find(({ data }) => (
      (data.member as { link?: { subagent_id?: string } }).link?.subagent_id === "subagent:1"
    ))?.data).toMatchObject({
      reason: "heartbeat_timeout",
      reopened_task_ids: ["task:loss"],
    });
    expect(events.some(({ type }) => type === "team.task_reopened")).toBe(false);
    expect((await harness.restartService().read(harness.runId))?.task_board.items[0])
      .toMatchObject({ state: "open", version: 3 });
  });

  it("repairs a legacy partially committed heartbeat sweep before writing its canonical receipt", async () => {
    const harness = await createHarness("partial-sweep");
    await harness.createTeam();
    await harness.join(1);
    await harness.join(2);
    harness.advance(1_001);
    let injected = false;
    const flaky = new TeamDomainService({
      list: (runId) => harness.ledger.list(runId),
      append: (proposal) => harness.ledger.append(proposal),
      appendAtomic: async (_scope, proposals) => {
        // Simulate the pre-appendAtomic implementation crashing after its
        // first derived loss. The current implementation itself never uses
        // this non-atomic path.
        if (!injected) {
          injected = true;
          await harness.ledger.append(proposals[0]!);
          throw new Error("injected legacy sweep crash");
        }
        throw new Error("unexpected second flaky append");
      },
    }, { now: () => new Date(harness.iso()) });
    await expect(flaky.expireMembers(harness.coordinatorScope, "sweep:partial"))
      .rejects.toThrow("injected legacy sweep crash");
    let events = await harness.ledger.list(harness.runId);
    expect(events.filter(({ type }) => type === "team.member_lost")).toHaveLength(1);
    expect(events.some(({ type }) => type === "team.sweep_completed")).toBe(false);
    await expect(harness.ledger.append(harness.proposal(
      "run.completed",
      "Terminal must wait for sweep repair",
      { outcome: "blocked" },
    ))).rejects.toThrow("incomplete heartbeat sweep");

    const restarted = harness.restartService();
    await expect(restarted.execute(harness.coordinatorScope, {
      command_id: "command:unrelated-during-partial-sweep",
      operation: "create_task",
      task_id: "task:must-wait-for-sweep-repair",
      title: "No mutation may interleave with a partial sweep",
      acceptance: ["Rejected before append"],
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(restarted.execute(harness.coordinatorScope, {
      command_id: "sweep:partial",
      operation: "create_task",
      task_id: "task:must-not-steal-sweep-id",
      title: "Do not steal a partial sweep command id",
      acceptance: ["Rejected before append"],
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
    const repaired = await restarted.expireMembers(harness.coordinatorScope, "sweep:partial");
    expect(repaired.roster.members.every(({ status }) => status === "lost")).toBe(true);
    events = await harness.ledger.list(harness.runId);
    const receipt = events.find(({ type }) => type === "team.sweep_completed");
    expect(receipt?.data.member_lost_event_ids).toHaveLength(2);
    const beforeRetry = events.length;
    await harness.restartService().expireMembers(harness.coordinatorScope, "sweep:partial");
    expect(await harness.ledger.list(harness.runId)).toHaveLength(beforeRetry);
  });

  it("preflights every derived sweep key and rejects reserved external command namespaces", async () => {
    const harness = await createHarness("sweep-preflight");
    await harness.createTeam();
    await harness.join(1);
    await harness.join(2);
    const beforeReserved = await harness.ledger.list(harness.runId);
    await expect(Promise.resolve().then(() => harness.service.execute({
      ...harness.coordinatorScope,
      actor: { kind: "user" },
    }, {
      command_id: "team-expire:caller-controlled",
      operation: "create_task",
      task_id: "task:reserved-command",
      title: "Must not occupy an internal namespace",
      acceptance: ["Rejected before append"],
    }))).rejects.toMatchObject({ code: "command_id_reserved" });
    expect(await harness.ledger.list(harness.runId)).toHaveLength(beforeReserved.length);

    const sweepCommandId = "sweep:preflight-all";
    const secondDerivedCommandId = `team-expire:${sha256(`${sweepCommandId}:subagent:2`)}`;
    await harness.ledger.append({
      ...harness.proposal("action.verified", "Legacy derived-key occupant", { action_id: "action:occupied" }),
      idempotency_key: `team-command:${sha256(secondDerivedCommandId)}`,
    });
    harness.advance(1_001);
    const beforeSweep = await harness.ledger.list(harness.runId);
    await expect(harness.service.expireMembers(harness.coordinatorScope, sweepCommandId))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    const afterSweep = await harness.ledger.list(harness.runId);
    expect(afterSweep).toHaveLength(beforeSweep.length);
    expect(afterSweep.some(({ type }) => type === "team.member_lost")).toBe(false);
    expect(afterSweep.some(({ type }) => type === "team.sweep_completed")).toBe(false);
  });

  it("atomically creates the Team with its running roster and keeps lost-response retries frozen", async () => {
    const harness = await createHarness("atomic-create-roster");
    const first = await harness.appendStarted(1);
    const firstData = SubagentStartedDataSchema.parse(
      (await harness.ledger.list(harness.runId)).find(({ type }) => type === "subagent.started")!.data,
    );
    const created = await harness.service.createWithRunningMembers(
      harness.coordinatorScope,
      "command:atomic-create-roster",
      [firstData],
    );
    expect(created.roster.members.map(({ link }) => link.subagent_id)).toEqual([first.link.subagent_id]);
    const teamEvents = (await harness.ledger.list(harness.runId)).filter(({ type }) => type.startsWith("team."));
    expect(teamEvents.map(({ type }) => type)).toEqual(["team.created", "team.member_joined"]);

    await harness.appendStarted(2);
    const runningAfterCreate = (await harness.ledger.list(harness.runId))
      .filter(({ type }) => type === "subagent.started")
      .map(({ data }) => SubagentStartedDataSchema.parse(data));
    const beforeRetry = (await harness.ledger.list(harness.runId)).length;
    const retried = await harness.service.createWithRunningMembers(
      harness.coordinatorScope,
      "command:atomic-create-roster",
      runningAfterCreate,
    );
    expect(retried.roster.members.map(({ link }) => link.subagent_id)).toEqual([first.link.subagent_id]);
    expect(await harness.ledger.list(harness.runId)).toHaveLength(beforeRetry);

    await harness.ledger.append(harness.proposal("run.completed", "Run completed", { outcome: "done" }));
    await expect(harness.service.createWithRunningMembers(
      harness.coordinatorScope,
      "command:atomic-create-roster",
      runningAfterCreate,
    )).resolves.toEqual(retried);
  });

  it("leaves neither team.created nor roster rows when the atomic create boundary fails", async () => {
    const harness = await createHarness("atomic-create-failure");
    await harness.appendStarted(1);
    const started = SubagentStartedDataSchema.parse(
      (await harness.ledger.list(harness.runId)).find(({ type }) => type === "subagent.started")!.data,
    );
    const before = await harness.ledger.list(harness.runId);
    const failing = new TeamDomainService({
      list: (runId) => harness.ledger.list(runId),
      append: (proposal) => harness.ledger.append(proposal),
      appendAtomic: async () => { throw new Error("injected atomic create failure"); },
    });
    await expect(failing.createWithRunningMembers(
      harness.coordinatorScope,
      "command:atomic-create-failure",
      [started],
    )).rejects.toThrow("injected atomic create failure");
    const after = await harness.ledger.list(harness.runId);
    expect(after).toHaveLength(before.length);
    expect(after.some(({ type }) => type === "team.created" || type === "team.member_joined")).toBe(false);
  });

  it("replays an exact atomic started-plus-join retry even after root terminal", async () => {
    const harness = await createHarness("atomic-start-join-retry");
    await harness.createTeam();
    const started = await harness.appendStarted(1);
    const startedData = SubagentStartedDataSchema.parse(
      (await harness.ledger.list(harness.runId)).find(({ type }) => type === "subagent.started")!.data,
    );
    const startedProposal: SessionEventProposal = {
      ...harness.proposal("subagent.started", "Atomic worker started", startedData),
      idempotency_key: "subagent:atomic-start:receipt",
      operation_id: started.link.subagent_id,
    };
    const joined = await harness.service.appendStartedAndJoin(harness.coordinatorScope, startedProposal);
    expect(joined.roster.members).toHaveLength(1);
    const beforeRetry = (await harness.ledger.list(harness.runId)).length;
    await expect(harness.service.appendStartedAndJoin(harness.coordinatorScope, startedProposal))
      .resolves.toEqual(joined);
    expect(await harness.ledger.list(harness.runId)).toHaveLength(beforeRetry);

    await harness.ledger.append(harness.proposal("run.completed", "Run completed", { outcome: "done" }));
    await expect(harness.service.appendStartedAndJoin(harness.coordinatorScope, startedProposal))
      .resolves.toEqual(joined);
  });

  it("requires prior independent root-ledger evidence to complete an owned task", async () => {
    const harness = await createHarness("evidence");
    await harness.createTeam();
    await harness.join(1);
    const created = await harness.service.execute(harness.coordinatorScope, {
      command_id: "command:task:create:evidence",
      operation: "create_task",
      task_id: "task:evidence",
      title: "Prove completion",
      acceptance: ["A prior durable action exists"],
    });
    await harness.service.execute(harness.memberScope(1), {
      command_id: "command:task:claim:evidence",
      operation: "claim_task",
      task_id: "task:evidence",
      expected_version: 1,
    });

    for (const evidenceEventId of ["event:forged", created.created_event_id]) {
      await expect(harness.service.execute(harness.memberScope(1), {
        command_id: `command:task:complete:${evidenceEventId}`,
        operation: "complete_task",
        task_id: "task:evidence",
        expected_version: 2,
        evidence_event_ids: [evidenceEventId],
      })).rejects.toMatchObject({ code: "task_evidence_invalid" });
    }

    const evidence = await harness.ledger.append(harness.proposal(
      "action.verified",
      "Independent action verified",
      { action_id: "action:evidence" },
    ));
    const completed = await harness.service.execute(harness.memberScope(1), {
      command_id: "command:task:complete:valid",
      operation: "complete_task",
      task_id: "task:evidence",
      expected_version: 2,
      evidence_event_ids: [evidence.event_id],
    });
    expect(completed.task_board.items[0]).toMatchObject({
      state: "done",
      owner: "subagent:1",
      evidence_event_ids: [evidence.event_id],
    });
  });

  it("uses a trusted member-bound resolver to reject forged and another child's evidence", async () => {
    const harness = await createHarness("child-evidence", ({ member, evidenceEventIds }) => (
      member.link.subagent_id === "subagent:1"
      && evidenceEventIds.length === 1
      && evidenceEventIds[0] === "event:child:1:proof"
    ));
    await harness.createTeam();
    await harness.join(1);
    await harness.join(2);
    await harness.service.execute(harness.coordinatorScope, {
      command_id: "command:child-proof:create",
      operation: "create_task",
      task_id: "task:child-proof",
      title: "Bind proof to the owning child ledger",
      acceptance: ["Only child one proof is accepted"],
    });
    await harness.service.execute(harness.memberScope(1), {
      command_id: "command:child-proof:claim",
      operation: "claim_task",
      task_id: "task:child-proof",
      expected_version: 1,
    });

    for (const evidenceEventId of ["event:forged", "event:child:2:proof"]) {
      await expect(harness.service.execute(harness.memberScope(1), {
        command_id: `command:child-proof:reject:${evidenceEventId}`,
        operation: "complete_task",
        task_id: "task:child-proof",
        expected_version: 2,
        evidence_event_ids: [evidenceEventId],
      })).rejects.toMatchObject({ code: "task_evidence_invalid" });
    }
    await expect(harness.service.execute(harness.memberScope(1), {
      command_id: "command:child-proof:complete",
      operation: "complete_task",
      task_id: "task:child-proof",
      expected_version: 2,
      evidence_event_ids: ["event:child:1:proof"],
    })).resolves.toMatchObject({
      task_board: { items: [expect.objectContaining({ state: "done" })] },
    });
  });

  it("retires a terminal worker immediately, reopens claims, and replays the idempotent retry", async () => {
    const harness = await createHarness("terminal-retire");
    await harness.createTeam();
    const started = await harness.join(1);
    await harness.service.execute(harness.coordinatorScope, {
      command_id: "command:terminal-task:create",
      operation: "create_task",
      task_id: "task:terminal",
      title: "Release terminal owner",
      acceptance: ["Task is open"],
    });
    await harness.service.execute(harness.memberScope(1), {
      command_id: "command:terminal-task:claim",
      operation: "claim_task",
      task_id: "task:terminal",
      expected_version: 1,
    });
    await harness.ledger.append(harness.proposal("subagent.completed", "Worker completed", {
      link: started.link,
      result: {
        subagent_id: started.link.subagent_id,
        child_run_id: started.link.child_run_id,
        status: "completed",
        summary: "Finished",
        artifact_refs: [],
      },
      child_terminal_event_id: "event:child:terminal",
      child_terminal_event_hash: HASH_A,
    }));

    const retired = await harness.service.retireTerminalMember(
      harness.coordinatorScope,
      "subagent:1",
      "command:terminal-retire",
    );
    expect(retired.roster.members[0]).toMatchObject({ status: "lost" });
    expect(retired.task_board.items[0]).toMatchObject({ state: "open", owner: undefined });
    await expect(harness.service.retireTerminalMember(
      harness.coordinatorScope,
      "subagent:1",
      "command:terminal-retire",
    )).resolves.toEqual(retired);
    expect((await harness.ledger.list(harness.runId)).filter(({ type }) => type === "team.member_lost"))
      .toHaveLength(1);
  });

  it("rejects new mutations after terminal while replaying a lost-response duplicate", async () => {
    const harness = await createHarness("terminal-mutation");
    const created = await harness.createTeam();
    await harness.ledger.append(harness.proposal("run.completed", "Run completed", { outcome: "done" }));

    await expect(harness.service.execute(harness.coordinatorScope, {
      command_id: "command:create-team",
      operation: "create_team",
    })).resolves.toEqual(created);
    await expect(harness.service.execute(harness.coordinatorScope, {
      command_id: "command:late-task",
      operation: "create_task",
      task_id: "task:late",
      title: "Must not append",
      acceptance: ["Rejected"],
    })).rejects.toMatchObject({ code: "run_terminal" });
    expect((await harness.ledger.list(harness.runId)).some(({ type }) => type === "team.task_created"))
      .toBe(false);
  });

  it("fails closed when a terminal child tries to join the roster", async () => {
    const harness = await createHarness("join-terminal");
    await harness.createTeam();
    const started = await harness.appendStarted(1);
    await harness.ledger.append(harness.proposal("subagent.failed", "Launch failed", {
      link: started.link,
      result: {
        subagent_id: started.link.subagent_id,
        child_run_id: started.link.child_run_id,
        status: "failed",
        summary: "Failed before launch",
        artifact_refs: [],
      },
      reason: "launch_failed",
      failure_stage: "launch",
    }));
    await expect(harness.service.execute(harness.coordinatorScope, {
      command_id: "command:join-terminal",
      operation: "join_member",
      subagent_id: started.link.subagent_id,
      role: started.spec.name,
    })).rejects.toMatchObject({ code: "member_join_proof_invalid" });
    await harness.ledger.append(harness.proposal("team.member_joined", "Corrupt terminal worker join", {
      team_id: (await harness.service.read(harness.runId))!.team_id,
      member: {
        link: started.link,
        role: started.spec.name,
        status: "active",
        joined_at: harness.iso(),
        last_heartbeat_at: harness.iso(),
      },
    }));
    await expect(harness.service.read(harness.runId)).rejects.toMatchObject({ code: "invalid_team_event" });
  });

  it("validates the exact redacted payload and monotonic task time before append", async () => {
    const harness = await createHarness("preappend-validation");
    await harness.createTeam();
    const before = await harness.ledger.list(harness.runId);
    await expect(harness.service.execute(harness.coordinatorScope, {
      command_id: "command:redacted-duplicate",
      operation: "create_task",
      task_id: "task:redacted-duplicate",
      title: "Reject duplicate redacted acceptance",
      acceptance: ["sk-aaaaaaaaaaaa", "sk-bbbbbbbbbbbb"],
    })).rejects.toMatchObject({ code: "invalid_team_event" });
    expect(await harness.ledger.list(harness.runId)).toHaveLength(before.length);
    for (const [index, taskId] of ["sk-AAAAAAAAAAAA", "sk-BBBBBBBBBBBB"].entries()) {
      await expect(Promise.resolve().then(() => harness.service.execute(harness.coordinatorScope, {
        command_id: `command:secret-task:${index}`,
        operation: "create_task",
        task_id: taskId,
        title: "Secret-shaped identity is invalid",
        acceptance: ["Identity remains stable"],
      }))).rejects.toMatchObject({ code: "invalid_team_event" });
    }
    expect(await harness.ledger.list(harness.runId)).toHaveLength(before.length);

    harness.advance(100);
    await harness.service.execute(harness.coordinatorScope, {
      command_id: "command:clock:create",
      operation: "create_task",
      task_id: "task:clock",
      title: "Keep task time monotonic",
      acceptance: ["A rollback is rejected"],
    });
    harness.advance(-50);
    await expect(harness.service.execute(harness.memberScope(1), {
      command_id: "command:clock:claim",
      operation: "claim_task",
      task_id: "task:clock",
      expected_version: 1,
    })).rejects.toMatchObject({ code: "member_not_found" });
    await harness.join(1);
    await expect(harness.service.execute(harness.memberScope(1), {
      command_id: "command:clock:claim-after-join",
      operation: "claim_task",
      task_id: "task:clock",
      expected_version: 1,
    })).rejects.toMatchObject({ code: "invalid_team_event" });
    expect((await harness.ledger.list(harness.runId)).some(({ type }) => type === "team.task_claimed"))
      .toBe(false);
  });

  it("projects no team for a legacy Run and rejects a team event without team.created", async () => {
    const harness = await createHarness("legacy");
    expect(projectTeam(await harness.ledger.list(harness.runId))).toBeUndefined();
    const started = await harness.appendStarted(1);
    await harness.ledger.append(harness.proposal("team.member_joined", "Invalid orphan member", {
      team_id: "team:missing",
      member: {
        link: started.link,
        role: started.spec.name,
        status: "active",
        joined_at: harness.iso(),
        last_heartbeat_at: harness.iso(),
      },
    }));
    expect(() => projectTeam([])).toThrow("run.created");
    await expect(harness.service.read(harness.runId)).rejects.toMatchObject({ code: "team_not_found" });
  });
});

async function createHarness(
  name: string,
  evidenceResolver?: NonNullable<ConstructorParameters<typeof TeamDomainService>[1]>["evidenceResolver"],
) {
  const root = await mkdtemp(join(tmpdir(), `tracegraph-g08-${name}-`));
  roots.push(root);
  let id = 0;
  let nowMs = Date.parse("2026-09-20T00:00:00.000Z");
  const runId = `run:g08:${name}`;
  const sessionId = `session:g08:${name}`;
  const projectId = "project:g08";
  const ledger = new JsonlEventLedger(join(root, "events"), {
    now: () => new Date(nowMs),
    idFactory: (prefix) => `${prefix}:${++id}`,
  });
  const proposal = (
    type: SessionEventProposal["type"],
    summary: string,
    data: Record<string, unknown>,
  ): SessionEventProposal => ({
    type,
    project_id: projectId,
    run_id: runId,
    session_id: sessionId,
    attempt: 0,
    summary,
    artifact_refs: [],
    data,
  });
  await ledger.append(proposal("run.created", "Run created", {
    task: "Coordinate a durable team",
    mode: "execute",
    workspace_kind: "managed_local",
    subagent_limits: { max_parallel_subagents: 2, max_depth: 1 },
  }));
  const options = {
    now: () => new Date(nowMs),
    idFactory: (prefix: string) => `${prefix}:domain:${++id}`,
    defaultLimits: {
      max_parallel_workers: 2,
      heartbeat_timeout_ms: 1_000,
      max_members: 8,
      max_mailbox_messages: 32,
      max_tasks: 32,
    },
    ...(evidenceResolver === undefined ? {} : { evidenceResolver }),
  };
  let service = new TeamDomainService(ledger, options);
  const coordinatorScope = { projectId, runId, sessionId, actor: { kind: "lead" as const } };

  const appendStarted = async (index: number) => {
    const link: SubagentRunLink = {
      subagent_id: `subagent:${index}`,
      parent_run_id: runId,
      parent_session_id: sessionId,
      child_run_id: `run:child:${index}`,
      child_session_id: `session:child:${index}`,
    };
    const spec = {
      subagent_id: link.subagent_id,
      parent_run_id: runId,
      name: `worker-${index}`,
      provider_key: "test",
      role_prompt_version: "worker.v1",
      role_prompt_hash: HASH_A,
      tool_allowlist: ["read_file", "team_read", "team_task_write"],
      context_scope: "isolated" as const,
      budget: { max_steps: 4, max_tokens: 4_000 },
      depth: 1,
    };
    await ledger.append(proposal("subagent.started", `Worker ${index} started`, {
      link,
      spec,
      limits: { max_parallel_subagents: 2, max_depth: 1 },
      task_packet_hash: HASH_B,
    }));
    return { link, spec };
  };

  return {
    root,
    ledger,
    get service() { return service; },
    runId,
    sessionId,
    projectId,
    coordinatorScope,
    memberScope(index: number) {
      return { projectId, runId, sessionId, actor: { kind: "member" as const, subagent_id: `subagent:${index}` } };
    },
    proposal,
    iso: () => new Date(nowMs).toISOString(),
    advance(ms: number) { nowMs += ms; },
    restartService() {
      service = new TeamDomainService(ledger, options);
      return service;
    },
    async createTeam() {
      return service.execute(coordinatorScope, { command_id: "command:create-team", operation: "create_team" });
    },
    appendStarted,
    async join(index: number) {
      const started = await appendStarted(index);
      await service.execute(coordinatorScope, {
        command_id: `command:join:${index}`,
        operation: "join_member",
        subagent_id: started.link.subagent_id,
        role: started.spec.name,
      });
      return started;
    },
  };
}
