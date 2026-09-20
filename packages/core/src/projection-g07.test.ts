import {
  SCHEMA_VERSION,
  SessionEventSchema,
  type EventType,
  type SessionEvent,
  type SubagentResultStatus,
} from "@tracegraph/contracts";
import { describe, expect, it } from "vitest";
import { projectRun } from "./projection.js";

const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;

describe("G-07 parent subagent projection", () => {
  it("replays exactly started + initial message + terminal for each of two children", () => {
    const events = [
      created(),
      event("subagent.started", 2, startedData(1)),
      event("subagent.message_sent", 3, messageData(1, "initial_task")),
      event("subagent.started", 4, startedData(2)),
      event("subagent.message_sent", 5, messageData(2, "initial_task")),
      event("subagent.completed", 6, terminalData(2, "completed")),
      event("subagent.completed", 7, terminalData(1, "completed")),
    ];

    expect(events.filter(({ type }) => type.startsWith("subagent."))).toHaveLength(6);
    expect(projectRun(events.slice(0, 5)).subagents).toMatchObject({
      active_count: 2,
      last_sequence: 5,
      items: [
        { status: "running", message_count: 1 },
        { status: "running", message_count: 1 },
      ],
    });

    const projection = projectRun(events);
    expect(projection.subagents).toMatchObject({
      active_count: 0,
      last_sequence: 7,
      limits: { max_parallel_subagents: 2, max_depth: 1 },
      items: [
        {
          link: { subagent_id: "subagent:1", child_run_id: "run:child:1" },
          status: "completed",
          initial_message_event_id: "event:3",
          terminal_event_id: "event:7",
          child_terminal_event_id: "event:child:1:terminal",
        },
        {
          link: { subagent_id: "subagent:2", child_run_id: "run:child:2" },
          status: "completed",
          initial_message_event_id: "event:5",
          terminal_event_id: "event:6",
          child_terminal_event_id: "event:child:2:terminal",
        },
      ],
    });
    expect(projection.timeline.map(({ type }) => type)).toEqual([
      "run.created",
      "subagent.started",
      "subagent.message_sent",
      "subagent.started",
      "subagent.message_sent",
      "subagent.completed",
      "subagent.completed",
    ]);
    expect(JSON.stringify(projection.timeline)).not.toContain("_internal_message_digest");
  });

  it("projects budget exhaustion and redacts the bounded terminal result", () => {
    const failure = terminalData(1, "budget_exceeded");
    const projection = projectRun([
      created(),
      event("subagent.started", 2, startedData(1)),
      event("subagent.message_sent", 3, messageData(1, "initial_task")),
      event("subagent.failed", 4, {
        ...failure,
        result: {
          ...failure.result,
          summary: "Stopped in /Users/cain/private/repo with token=child-secret",
        },
        reason: "budget_exceeded",
        failure_stage: "execution",
      }),
    ]);

    expect(projection.subagents.items[0]).toMatchObject({
      status: "budget_exceeded",
      failure_reason: "budget_exceeded",
      result: { status: "budget_exceeded" },
    });
    expect(projection.subagents.items[0]?.result?.summary).not.toContain("/Users/cain/private/repo");
    expect(projection.subagents.items[0]?.result?.summary).not.toContain("child-secret");
  });

  it("keeps a pre-delivery launch failure replayable without weakening execution terminals", () => {
    const launchFailure = terminalData(1, "failed");
    const projection = projectRun([
      created(),
      event("subagent.started", 2, startedData(1)),
      event("subagent.failed", 3, {
        link: launchFailure.link,
        result: launchFailure.result,
        reason: "launch_failed",
        failure_stage: "launch",
      }),
    ]);

    expect(projection.subagents.items[0]).toMatchObject({
      status: "failed",
      message_count: 0,
      failure_reason: "launch_failed",
    });
    expect(projection.subagents.items[0]?.initial_message_event_id).toBeUndefined();

    expect(() => projectRun([
      created(),
      event("subagent.started", 2, startedData(1)),
      event("subagent.failed", 3, {
        ...terminalData(1, "failed"),
        reason: "provider_failed",
        failure_stage: "execution",
      }),
    ])).toThrow("missing its initial task");
  });

  it("defaults old ledgers to an empty child list", () => {
    const projection = projectRun([
      event("run.created", 1, {
        task: "Replay a pre-G07 Run",
        mode: "execute",
        workspace_kind: "managed_local",
      }),
      event("run.started", 2, { phase: "reasoning" }),
    ]);

    expect(projection.subagents).toEqual({
      items: [],
      active_count: 0,
      last_sequence: 2,
      limits: { max_parallel_subagents: 2, max_depth: 1 },
    });
  });

  it("fails closed on malformed, unbound, duplicated, or out-of-order lifecycle facts", () => {
    const start = event("subagent.started", 2, startedData(1));
    const initial = event("subagent.message_sent", 3, messageData(1, "initial_task"));
    const completed = event("subagent.completed", 4, terminalData(1, "completed"));

    expect(() => projectRun([
      created(),
      event("subagent.started", 2, { ...startedData(1), provider_key: "smuggled" }),
    ])).toThrow("invalid subagent.started payload");
    expect(() => projectRun([created(), initial])).toThrow("unknown subagent_id");
    expect(() => projectRun([created(), start, completed])).toThrow("missing its initial task");
    expect(() => projectRun([
      created(),
      start,
      event("subagent.message_sent", 3, messageData(1, "message")),
    ])).toThrow("first subagent message must be initial_task");
    expect(() => projectRun([
      created(),
      start,
      initial,
      event("subagent.message_sent", 4, {
        ...messageData(1, "initial_task"),
        message: {
          ...messageData(1, "initial_task").message,
          message_id: "message:1:initial_task:again",
        },
      }),
    ])).toThrow("initial task was sent more than once");
    expect(() => projectRun([
      created(),
      start,
      initial,
      completed,
      event("subagent.message_sent", 5, messageData(1, "message")),
    ])).toThrow("follows subagent terminal state");
    expect(() => projectRun([
      created(),
      start,
      initial,
      completed,
      event("subagent.completed", 5, terminalData(1, "completed")),
    ])).toThrow("follows subagent terminal state");
  });

  it("fails closed on linkage, identity, concurrency, limit, and parent-terminal violations", () => {
    const start1 = event("subagent.started", 2, startedData(1));
    const start2 = event("subagent.started", 3, startedData(2));

    expect(() => projectRun([
      created(),
      { ...start1, run_id: "run:other" },
    ])).toThrow("parent scope mismatch");
    expect(() => projectRun([
      created(),
      start1,
      event("subagent.started", 3, {
        ...startedData(2),
        link: { ...link(2), child_run_id: "run:child:1" },
      }),
    ])).toThrow("duplicate child_run_id");
    expect(() => projectRun([
      created(),
      start1,
      start2,
      event("subagent.started", 4, startedData(3)),
    ])).toThrow("concurrency exceeds 2");
    expect(() => projectRun([
      created(),
      event("subagent.started", 2, {
        ...startedData(1),
        limits: { max_parallel_subagents: 1, max_depth: 1 },
      }),
    ])).toThrow("effective limits mismatch");
    expect(() => projectRun([
      created(),
      start1,
      event("run.completed", 3, { outcome: "Parent stopped too early" }),
    ])).toThrow("terminated with 1 active subagent");
    expect(() => projectRun([
      created(),
      event("run.completed", 2, { outcome: "Parent completed" }),
      event("subagent.started", 3, startedData(1)),
    ])).toThrow("follows parent terminal event");
  });
});

function created(): SessionEvent {
  return event("run.created", 1, {
    task: "Delegate bounded inspection",
    mode: "execute",
    workspace_kind: "managed_local",
    subagent_limits: { max_parallel_subagents: 2, max_depth: 1 },
  });
}

function link(index: number) {
  return {
    subagent_id: `subagent:${index}`,
    parent_run_id: "run:parent",
    parent_session_id: "session:parent",
    child_run_id: `run:child:${index}`,
    child_session_id: `session:child:${index}`,
  };
}

function startedData(index: number) {
  return {
    link: link(index),
    spec: {
      subagent_id: `subagent:${index}`,
      parent_run_id: "run:parent",
      name: `code-explorer-${index}`,
      provider_key: "primary",
      role_prompt_version: "explorer.v1",
      role_prompt_hash: HASH_A,
      tool_allowlist: ["read_file", "search"],
      context_scope: "isolated",
      budget: { max_steps: 8, max_tokens: 20_000 },
      depth: 1,
    },
    limits: { max_parallel_subagents: 2, max_depth: 1 },
    task_packet_hash: HASH_B,
  };
}

function messageData(index: number, kind: "initial_task" | "message") {
  return {
    link: link(index),
    message: {
      message_id: `message:${index}:${kind}`,
      kind,
      actor: "parent_agent",
      body: kind === "initial_task" ? "Inspect the projection" : "Continue",
      body_hash: HASH_B,
      sent_at: iso(9),
    },
    _internal_message_digest: HASH_A,
  };
}

function terminalData(index: number, status: SubagentResultStatus) {
  return {
    link: link(index),
    result: {
      subagent_id: `subagent:${index}`,
      child_run_id: `run:child:${index}`,
      status,
      summary: `Child ${index} result`,
      artifact_refs: [],
      usage: {
        steps: 3,
        input_tokens: 900,
        output_tokens: 100,
        total_tokens: 1_000,
        confidence: "provider_reported",
        costs: [],
      },
    },
    child_terminal_event_id: `event:child:${index}:terminal`,
    child_terminal_event_hash: HASH_A,
  };
}

function event(
  type: EventType,
  sequence: number,
  data: Record<string, unknown>,
): SessionEvent {
  return SessionEventSchema.parse({
    schema_version: SCHEMA_VERSION,
    event_id: `event:${sequence}`,
    project_id: "project:g07",
    run_id: "run:parent",
    session_id: "session:parent",
    sequence,
    occurred_at: iso(sequence),
    attempt: 0,
    type,
    summary: type,
    artifact_refs: [],
    event_hash: HASH_A,
    data,
  });
}

function iso(sequence: number): string {
  return `2026-09-19T12:00:${String(sequence).padStart(2, "0")}.000Z`;
}
