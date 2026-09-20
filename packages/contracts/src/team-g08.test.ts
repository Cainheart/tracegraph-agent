import { describe, expect, it } from "vitest";
import {
  BUILTIN_PERMISSION_PRESETS,
  BUILTIN_TOOL_NAMES,
  CreateTeamRequestSchema,
  CurrentRunRecoveryStateV5Schema,
  DEFAULT_TEAM_READ_PAGE_ITEMS,
  DEFAULT_TEAM_LIMITS,
  EventTypeSchema,
  EXTENSION_API_VERSION,
  MailboxMessageSchema,
  MAX_TEAM_MAILBOX_MESSAGES,
  MAX_TEAM_READ_PAGE_ITEMS,
  PROJECTOR_VERSION,
  RunProjectionSchema,
  RunRecoveryStateSchema,
  SCHEMA_VERSION,
  SessionEventSchema,
  TaskBoardItemSchema,
  TeamCreatedDataSchema,
  TeamHeartbeatDataSchema,
  TeamHeartbeatInputSchema,
  TeamLimitsSchema,
  TeamMailboxClaimInputSchema,
  TeamMailboxClaimedDataSchema,
  TeamMailboxSendInputSchema,
  TeamMemberJoinedDataSchema,
  TeamMemberLostDataSchema,
  TeamMutationResultSchema,
  TeamProjectionSchema,
  TeamReadInputSchema,
  TeamSweepCompletedDataSchema,
  TeamSweepLostMembersRequestSchema,
  TeamTaskBlockedDataSchema,
  TeamTaskCancelledDataSchema,
  TeamTaskClaimedDataSchema,
  TeamTaskCompletedDataSchema,
  TeamTaskCreatedDataSchema,
  TeamTaskReopenedDataSchema,
  TeamTaskWriteInputSchema,
  TeamTaskWriteRequestSchema,
} from "./index.js";

const NOW = "2026-09-20T00:00:00.000Z";
const LATER = "2026-09-20T00:00:10.000Z";
const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;

describe("G-08 Agent Team contracts", () => {
  it("keeps all five model Tool inputs strict and authority-free", () => {
    expect(TeamReadInputSchema.parse({})).toEqual({
      section: "task_board",
      offset: 0,
      limit: DEFAULT_TEAM_READ_PAGE_ITEMS,
    });
    expect(TeamReadInputSchema.parse({
      section: "mailbox",
      offset: MAX_TEAM_MAILBOX_MESSAGES,
      limit: MAX_TEAM_READ_PAGE_ITEMS,
      expected_last_sequence: 42,
    })).toEqual({
      section: "mailbox",
      offset: MAX_TEAM_MAILBOX_MESSAGES,
      limit: MAX_TEAM_READ_PAGE_ITEMS,
      expected_last_sequence: 42,
    });
    expect(TeamHeartbeatInputSchema.parse({})).toEqual({});
    expect(TeamMailboxSendInputSchema.parse({
      to: "subagent:worker",
      kind: "question",
      payload: "Which file owns the projector?",
    }).kind).toBe("question");
    expect(TeamMailboxClaimInputSchema.parse({ message_id: "message:1" }).message_id)
      .toBe("message:1");

    for (const smuggled of [
      { project_id: "project:other" },
      { run_id: "run:other" },
      { team_id: "team:other" },
      { actor: "user" },
      { from: "subagent:other" },
      { owner: "subagent:other" },
    ]) {
      expect(() => TeamMailboxSendInputSchema.parse({
        to: "subagent:worker",
        kind: "steer",
        payload: "Continue",
        ...smuggled,
      })).toThrow();
    }
    expect(() => TeamReadInputSchema.parse({ run_id: "run:smuggled" })).toThrow();
    expect(() => TeamReadInputSchema.parse({ section: "all" })).toThrow();
    expect(() => TeamReadInputSchema.parse({ offset: MAX_TEAM_MAILBOX_MESSAGES + 1 })).toThrow();
    expect(() => TeamReadInputSchema.parse({ limit: MAX_TEAM_READ_PAGE_ITEMS + 1 })).toThrow();
    expect(() => TeamReadInputSchema.parse({ expected_last_sequence: -1 })).toThrow();
    expect(() => TeamHeartbeatInputSchema.parse({ subagent_id: "subagent:smuggled" })).toThrow();
    expect(() => TeamMailboxClaimInputSchema.parse({
      message_id: "message:1",
      claimed_by: "subagent:smuggled",
    })).toThrow();
  });

  it("validates operation-specific task inputs without exposing owner authority", () => {
    expect(TeamTaskWriteInputSchema.parse({
      operation: "create",
      task_id: "task:1",
      title: "Implement the projector",
      acceptance: ["Replay reaches the same state"],
    }).operation).toBe("create");
    expect(TeamTaskWriteInputSchema.parse({
      operation: "claim",
      task_id: "task:1",
      expected_version: 1,
    }).operation).toBe("claim");
    expect(TeamTaskWriteInputSchema.parse({
      operation: "complete",
      task_id: "task:1",
      expected_version: 2,
      evidence_event_ids: ["event:test-completed"],
    }).operation).toBe("complete");
    expect(TeamTaskWriteInputSchema.parse({
      operation: "block",
      task_id: "task:1",
      expected_version: 2,
      reason: "Needs an API decision",
    }).operation).toBe("block");
    expect(TeamTaskWriteInputSchema.parse({
      operation: "reopen",
      task_id: "task:1",
      expected_version: 3,
      reason: "Decision supplied",
    }).operation).toBe("reopen");

    expect(() => TeamTaskWriteInputSchema.parse({
      operation: "create",
      task_id: "task:1",
      title: "Missing acceptance",
    })).toThrow("create requires acceptance");
    expect(() => TeamTaskWriteInputSchema.parse({
      operation: "claim",
      task_id: "task:1",
      expected_version: 1,
      owner: "subagent:smuggled",
    })).toThrow();
    expect(() => TeamTaskWriteInputSchema.parse({
      operation: "complete",
      task_id: "task:1",
      expected_version: 2,
    })).toThrow("requires durable evidence");
    expect(() => TeamTaskWriteInputSchema.parse({
      operation: "claim",
      task_id: "task:1",
    })).toThrow("requires expected_version");
    expect(() => TeamTaskWriteInputSchema.parse({
      operation: "block",
      task_id: "task:1",
      expected_version: 2,
      evidence_event_ids: ["event:not-allowed"],
      reason: "Needs an API decision",
    })).toThrow("cannot set evidence_event_ids");
  });

  it("bounds frozen team limits and binds every member to one G-07 child link", () => {
    expect(TeamLimitsSchema.parse({})).toEqual(DEFAULT_TEAM_LIMITS);
    expect(() => TeamLimitsSchema.parse({
      ...DEFAULT_TEAM_LIMITS,
      max_parallel_workers: 4,
      max_members: 2,
    })).toThrow("cannot exceed max_members");
    expect(TeamMemberJoinedDataSchema.parse({
      team_id: "team:1",
      member: member(),
    }).member.link.child_run_id).toBe("run:child");
    expect(() => TeamMemberJoinedDataSchema.parse({
      team_id: "team:1",
      member: { ...member(), status: "lost", lost_at: LATER },
    })).toThrow("new team members must be active");
    expect(() => TeamMemberJoinedDataSchema.parse({
      team_id: "team:1",
      member: {
        ...member(),
        link: { ...member().link, child_run_id: "run:root" },
      },
    })).toThrow("child Run must differ");
    expect(() => TeamMemberJoinedDataSchema.parse({
      team_id: "team:1",
      member: {
        ...member(),
        link: { ...member().link, subagent_id: "coordinator" },
      },
    })).toThrow("reserved coordinator address");
  });

  it("requires monotonic heartbeat and makes member loss plus task reopen atomic", () => {
    expect(TeamHeartbeatDataSchema.parse({
      team_id: "team:1",
      member: { ...member(), last_heartbeat_at: LATER },
      previous_heartbeat_at: NOW,
      _internal_command_digest: HASH_A,
    }).member.last_heartbeat_at).toBe(LATER);
    expect(() => TeamHeartbeatDataSchema.parse({
      team_id: "team:1",
      member: member(),
      previous_heartbeat_at: NOW,
    })).toThrow("must advance");

    const lost = {
      team_id: "team:1",
      member: { ...member(), status: "lost", lost_at: LATER },
      previous_status: "active",
      reason: "heartbeat_timeout",
      lost_at: LATER,
      last_heartbeat_at: NOW,
      reopened_task_ids: ["task:1", "task:2"],
      _internal_command_digest: HASH_B,
    } as const;
    expect(TeamMemberLostDataSchema.parse(lost).reopened_task_ids).toEqual(["task:1", "task:2"]);
    expect(() => TeamMemberLostDataSchema.parse({
      ...lost,
      reopened_task_ids: ["task:1", "task:1"],
    })).toThrow("must be unique");
    expect(() => TeamMemberLostDataSchema.parse({
      ...lost,
      last_heartbeat_at: LATER,
    })).toThrow("must match the member snapshot");

    expect(TeamSweepCompletedDataSchema.parse({
      team_id: "team:1",
      swept_at: LATER,
      member_lost_event_ids: ["event:member-lost"],
      _internal_command_digest: HASH_A,
    }).member_lost_event_ids).toEqual(["event:member-lost"]);
    expect(TeamSweepCompletedDataSchema.parse({
      team_id: "team:1",
      swept_at: LATER,
      member_lost_event_ids: [],
      _internal_command_digest: HASH_A,
    }).member_lost_event_ids).toEqual([]);
    expect(() => TeamSweepCompletedDataSchema.parse({
      team_id: "team:1",
      swept_at: LATER,
      member_lost_event_ids: ["event:member-lost", "event:member-lost"],
    })).toThrow("must be unique");
  });

  it("makes mailbox delivery durable and claims an atomic recipient-only transition", () => {
    const delivered = mailboxMessage();
    expect(MailboxMessageSchema.parse(delivered)).toEqual(delivered);
    expect(() => MailboxMessageSchema.parse({
      ...delivered,
      claimed_at: LATER,
    })).toThrow("present together");
    expect(() => MailboxMessageSchema.parse({
      ...delivered,
      claimed_at: LATER,
      claimed_by: "subagent:other",
    })).toThrow("addressed recipient");

    const claimed = { ...delivered, claimed_at: LATER, claimed_by: "subagent:worker" } as const;
    expect(TeamMailboxClaimedDataSchema.parse({
      team_id: "team:1",
      message: claimed,
      delivered_event_id: "event:delivered",
    }).message.claimed_at).toBe(LATER);
    expect(() => TeamMailboxClaimedDataSchema.parse({
      team_id: "team:1",
      message: delivered,
      delivered_event_id: "event:delivered",
    })).toThrow("requires claim facts");
  });

  it("enforces single-owner task states, exact revisions, and durable completion evidence", () => {
    const open = task("open", 1);
    const claimed = task("claimed", 2, "subagent:worker");
    const blocked = task("blocked", 3, "subagent:worker");
    const done = task("done", 3, "subagent:worker", ["event:test"]);
    const cancelled = task("cancelled", 3);

    expect(TeamTaskCreatedDataSchema.parse({ team_id: "team:1", task: open }).task.version).toBe(1);
    expect(TeamTaskClaimedDataSchema.parse({
      team_id: "team:1",
      task: claimed,
      previous_version: 1,
      previous_state: "open",
    }).task.owner).toBe("subagent:worker");
    expect(TeamTaskCompletedDataSchema.parse({
      team_id: "team:1",
      task: done,
      previous_version: 2,
      previous_state: "claimed",
      previous_owner: "subagent:worker",
    }).task.state).toBe("done");
    expect(TeamTaskBlockedDataSchema.parse({
      team_id: "team:1",
      task: blocked,
      previous_version: 2,
      previous_state: "claimed",
      previous_owner: "subagent:worker",
      reason: "Waiting for input",
    }).task.state).toBe("blocked");
    expect(TeamTaskCancelledDataSchema.parse({
      team_id: "team:1",
      task: cancelled,
      previous_version: 2,
      previous_state: "claimed",
      previous_owner: "subagent:worker",
      reason: "No longer required",
    }).task.state).toBe("cancelled");
    expect(TeamTaskReopenedDataSchema.parse({
      team_id: "team:1",
      task: task("open", 4),
      previous_version: 3,
      previous_state: "blocked",
      previous_owner: "subagent:worker",
      reason: "Dependency arrived",
    }).task.state).toBe("open");
    expect(() => TeamTaskReopenedDataSchema.parse({
      team_id: "team:1",
      task: task("open", 4),
      previous_version: 3,
      previous_state: "cancelled",
      previous_owner: "subagent:worker",
      reason: "Cancelled tasks have no owner",
    })).toThrow("cannot have a previous owner");

    expect(() => TaskBoardItemSchema.parse(task("claimed", 2, "subagent:second")))
      .not.toThrow();
    expect(() => TaskBoardItemSchema.parse(task("claimed", 2))).toThrow("owner consistency");
    expect(() => TeamTaskClaimedDataSchema.parse({
      team_id: "team:1",
      task: { ...claimed, version: 4 },
      previous_version: 1,
      previous_state: "open",
    })).toThrow("advance version exactly once");
    expect(() => TaskBoardItemSchema.parse(task("done", 3, "subagent:worker")))
      .toThrow("require durable evidence");
  });

  it("projects one optional team and rejects roster links outside canonical subagents", () => {
    expect(TeamProjectionSchema.parse(teamProjection()).roster.members).toHaveLength(1);
    expect(RunProjectionSchema.parse(baseProjection()).team).toBeUndefined();
    expect(RunProjectionSchema.parse({
      ...baseProjection(),
      subagents: subagentProjection(),
      team: teamProjection(),
    }).team?.team_id).toBe("team:1");
    expect(() => RunProjectionSchema.parse({
      ...baseProjection(),
      subagents: subagentProjection(),
      team: {
        ...teamProjection(),
        roster: {
          members: [{
            ...member(),
            link: { ...member().link, subagent_id: "subagent:unknown", child_run_id: "run:unknown" },
          }],
          last_sequence: 2,
        },
      },
    })).toThrow("canonical projected G-07 subagent link");
    expect(() => TeamProjectionSchema.parse({
      ...teamProjection(),
      mailbox: { messages: [], last_sequence: 5 },
    })).toThrow("cannot exceed the team projection");
    expect(() => TeamProjectionSchema.parse({
      ...teamProjection(),
      roster: {
        members: [{ ...member(), status: "lost", lost_at: LATER }],
        last_sequence: 4,
      },
      task_board: {
        items: [task("claimed", 2, "subagent:worker")],
        last_sequence: 4,
      },
    })).toThrow("cannot remain owned by a lost member");
  });

  it("adds 13 append-compatible events, advances only the projector, and keeps recovery v5", () => {
    const teamEvents = [
      "team.created",
      "team.member_joined",
      "team.heartbeat",
      "team.member_lost",
      "team.mailbox_delivered",
      "team.mailbox_claimed",
      "team.task_created",
      "team.task_claimed",
      "team.task_completed",
      "team.task_blocked",
      "team.task_cancelled",
      "team.task_reopened",
      "team.sweep_completed",
    ] as const;
    for (const eventType of teamEvents) expect(EventTypeSchema.parse(eventType)).toBe(eventType);
    expect(EventTypeSchema.options).toHaveLength(100);
    const teamStart = EventTypeSchema.options.indexOf(teamEvents[0]);
    expect(teamStart).toBeGreaterThanOrEqual(0);
    expect(EventTypeSchema.options.slice(teamStart, teamStart + teamEvents.length)).toEqual(teamEvents);
    expect(SCHEMA_VERSION).toBe("tracegraph.session-event.v1");
    expect(PROJECTOR_VERSION).toBe("tracegraph.projector.v8");
    expect(BUILTIN_TOOL_NAMES).toHaveLength(20);
    for (const toolName of [
      "team_read",
      "team_task_write",
      "team_mailbox_send",
      "team_mailbox_claim",
      "team_heartbeat",
    ]) expect(BUILTIN_TOOL_NAMES).toContain(toolName);

    expect(SessionEventSchema.parse({
      schema_version: SCHEMA_VERSION,
      event_id: "event:legacy",
      project_id: "project:g08",
      run_id: "run:root",
      sequence: 1,
      occurred_at: NOW,
      attempt: 0,
      type: "run.created",
      summary: "Legacy event remains readable",
      artifact_refs: [],
      event_hash: HASH_A,
      data: {},
    }).type).toBe("run.created");

    const recovery = recoveryV5();
    expect(CurrentRunRecoveryStateV5Schema.parse(recovery).version).toBe(5);
    expect(RunRecoveryStateSchema.parse(recovery).version).toBe(5);
    expect(() => RunRecoveryStateSchema.parse({ ...recovery, version: 6, team: teamProjection() }))
      .toThrow();
  });

  it("keeps browser wire requests command-idempotent without accepting authority", () => {
    expect(CreateTeamRequestSchema.parse({ command_id: "command:create" }).command_id)
      .toBe("command:create");
    expect(TeamTaskWriteRequestSchema.parse({
      command_id: "command:task",
      input: {
        operation: "claim",
        task_id: "task:1",
        expected_version: 1,
      },
    }).input.operation).toBe("claim");
    expect(TeamSweepLostMembersRequestSchema.parse({ command_id: "command:sweep" }).command_id)
      .toBe("command:sweep");
    expect(() => TeamSweepLostMembersRequestSchema.parse({
      command_id: "command:sweep",
      heartbeat_timeout_ms: 1,
    })).toThrow();

    expect(TeamMutationResultSchema.parse({
      command_id: "command:create",
      disposition: "applied",
      event_ids: ["event:team-created"],
      team: teamProjection(),
    }).disposition).toBe("applied");
    expect(() => TeamMutationResultSchema.parse({
      command_id: "command:create",
      disposition: "noop",
      event_ids: ["event:impossible"],
      team: teamProjection(),
    })).toThrow("noop must have no events");
  });

  it("keeps event payloads strict and binds team creation to the coordinator", () => {
    expect(TeamCreatedDataSchema.parse({
      team_id: "team:1",
      coordinator_run_id: "run:root",
      limits: DEFAULT_TEAM_LIMITS,
      created_at: NOW,
      _internal_command_digest: HASH_A,
    }).coordinator_run_id).toBe("run:root");
    expect(() => TeamCreatedDataSchema.parse({
      team_id: "team:1",
      coordinator_run_id: "run:root",
      limits: DEFAULT_TEAM_LIMITS,
      created_at: NOW,
      executable: "malicious",
    })).toThrow();
  });
});

function link() {
  return {
    subagent_id: "subagent:worker",
    parent_run_id: "run:root",
    parent_session_id: "session:root",
    child_run_id: "run:child",
    child_session_id: "session:child",
  } as const;
}

function member() {
  return {
    link: link(),
    role: "implementer",
    status: "active",
    joined_at: NOW,
    last_heartbeat_at: NOW,
  } as const;
}

function mailboxMessage() {
  return {
    message_id: "message:1",
    from: "coordinator",
    to: "subagent:worker",
    kind: "question",
    payload: "Which file owns the projector?",
    delivered_at: NOW,
  } as const;
}

function task(
  state: "open" | "claimed" | "done" | "blocked" | "cancelled",
  version: number,
  owner?: string,
  evidenceEventIds: string[] = [],
) {
  return {
    task_id: "task:1",
    title: "Implement the projector",
    state,
    ...(owner === undefined ? {} : { owner }),
    acceptance: ["Replay reaches the same state"],
    evidence_event_ids: evidenceEventIds,
    version,
    created_at: NOW,
    updated_at: state === "open" ? NOW : LATER,
  };
}

function teamProjection() {
  return {
    team_id: "team:1",
    coordinator_run_id: "run:root",
    limits: DEFAULT_TEAM_LIMITS,
    created_event_id: "event:team-created",
    created_at: NOW,
    roster: { members: [member()], last_sequence: 2 },
    mailbox: { messages: [mailboxMessage()], last_sequence: 3 },
    task_board: { items: [task("open", 1)], last_sequence: 4 },
    last_sequence: 4,
  } as const;
}

function subagentProjection() {
  return {
    items: [{
      link: link(),
      name: "team-worker",
      provider_key: "primary",
      role_prompt_version: "team-worker.v1",
      role_prompt_hash: HASH_A,
      tool_allowlist: ["read_file"],
      context_scope: "isolated",
      budget: { max_steps: 8, max_tokens: 20_000 },
      depth: 1,
      status: "running",
      started_event_id: "event:subagent-started",
      started_at: NOW,
      message_count: 0,
    }],
    active_count: 1,
    last_sequence: 1,
    limits: { max_parallel_subagents: 4, max_depth: 1 },
  } as const;
}

function baseProjection() {
  return {
    schema_version: SCHEMA_VERSION,
    projector_version: PROJECTOR_VERSION,
    project_id: "project:g08",
    session_id: "session:root",
    run_id: "run:root",
    task: "Coordinate a team",
    mode: "execute",
    workspace_kind: "managed_local",
    status: "running",
    last_sequence: 0,
    timeline: [],
    artifact_refs: [],
  } as const;
}

function recoveryV5() {
  return {
    version: 5,
    kind: "run_recovery_state",
    task: "Coordinate a team",
    conversation_history: [],
    mode: "execute",
    reasoning_effort: "default",
    effective_policy: {
      policy_version: 1,
      preset: BUILTIN_PERMISSION_PRESETS["workspace-write"],
      host_rules: [],
      project_rules: [],
      policy_digest: HASH_A,
    },
    orchestration: {
      depth: 0,
      limits: { max_parallel_subagents: 4, max_depth: 1 },
    },
    extensions: {
      api_version: EXTENSION_API_VERSION,
      config_digest: HASH_B,
      generation: 1,
      active_extensions: [],
      active_tool_names: [],
    },
  } as const;
}
