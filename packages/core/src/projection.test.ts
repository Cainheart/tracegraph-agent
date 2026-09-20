import {
  MAX_USER_INPUT_BODY_CHARS,
  SCHEMA_VERSION,
  SessionEventSchema,
  type EventType,
  type SessionEvent,
} from "@tracegraph/contracts";
import { describe, expect, it } from "vitest";
import { registerSecretForRedaction } from "./crypto.js";
import { projectRun } from "./projection.js";

const HASH = `sha256:${"0".repeat(64)}` as const;

describe("wire projection redaction", () => {
  it("redacts secrets and local paths from task, timeline data, approval diff, and outcome", () => {
    const events = [
      event("run.created", 1, "Created", {
        task: "Fix /Users/cain/private/repo with token=super-secret-value",
        mode: "manual",
        workspace_kind: "disposable_fixture",
      }),
      event("approval.requested", 2, "Review /Users/cain/private/repo", {
        pending_approval: {
          approval_id: "approval:test",
          action_id: "action:test",
          risk: "high",
          preview: {
            preview_id: "preview:test",
            action_id: "action:test",
            path: "src/add.ts",
            diff: "+ token=super-secret-value\n+ /Users/cain/private/repo",
            base_hash: HASH,
            patch_hash: HASH,
            scope: ["src/add.ts"],
            expires_at: "2026-09-16T01:00:00.000Z",
          },
        },
        authorization: "Bearer super-secret-value",
        nested: [{ githubToken: "ghp_should-never-reach-wire" }],
        apiKey: "vendor-secret-should-never-reach-wire",
        clientSecret: "client-secret-should-never-reach-wire",
        cwd: "/Users/cain/private/repo",
      }),
      event("run.cancelled", 3, "Stopped at /Users/cain/private/repo token=super-secret-value", {}),
    ];

    const projection = projectRun(events);
    const wire = JSON.stringify(projection);

    expect(projection.mode).toBe("execute");
    expect(wire).not.toContain("super-secret-value");
    expect(wire).not.toContain("/Users/cain/private/repo");
    expect(wire).not.toContain("ghp_should-never-reach-wire");
    expect(wire).not.toContain("vendor-secret-should-never-reach-wire");
    expect(wire).not.toContain("client-secret-should-never-reach-wire");
    expect(wire).toContain("[REDACTED]");
    expect(wire).toContain("[REDACTED_LOCAL_PATH]");
  });

  it("replays the latest valid sandbox report without trusting unrelated event data", () => {
    const enforced = {
      report_version: 1,
      mode: "workspace-write",
      enforcement: "full",
      platform: "darwin",
      mechanisms: ["seatbelt:/usr/bin/sandbox-exec", "network:deny"],
      unmet_constraints: [],
    } as const;
    const disabled = {
      report_version: 1,
      mode: "workspace-write",
      enforcement: "none",
      platform: "darwin",
      mechanisms: [],
      unmet_constraints: ["sandbox backend unavailable"],
    } as const;
    const projection = projectRun([
      event("run.created", 1, "Created", {
        task: "Inspect sandbox evidence",
        mode: "manual",
        workspace_kind: "disposable_fixture",
      }),
      event("sandbox.enforced", 2, "Sandbox enforced", { sandbox_report: enforced }),
      event("context.built", 3, "Ignore unrelated report-shaped data", {
        sandbox_report: disabled,
      }),
      event("tool.failed", 4, "Execution blocked", { sandbox_report: disabled }),
    ]);

    expect(projection.sandbox_report).toEqual(disabled);
    expect(projection.timeline[1]?.data.sandbox_report).toEqual(enforced);
    expect(projection.timeline[3]?.data.sandbox_report).toEqual(disabled);
  });

  it("projects only a valid durable permission snapshot", () => {
    const permission = {
      preset_key: "workspace-write",
      label: "Workspace write",
      sandbox_mode: "workspace-write",
      approval_policy: "on-write",
      policy_digest: HASH,
    } as const;
    const projection = projectRun([
      event("run.created", 1, "Created", {
        task: "Inspect permission evidence",
        mode: "manual",
        workspace_kind: "disposable_fixture",
      }),
      event("permission.configured", 2, "Permission configured", { permission }),
      event("context.built", 3, "Ignore unrelated permission-shaped data", {
        permission: { ...permission, preset_key: "full-write" },
      }),
    ]);

    expect(projection.permission).toEqual(permission);
    expect(projection.timeline[1]?.data.permission).toEqual(permission);
  });

  it("projects a pending Plan revision and flips the same legacy-compatible Run to execute", () => {
    const planned = projectRun([
      event("run.created", 1, "Created", {
        task: "Plan the work",
        mode: "plan",
        workspace_kind: "disposable_fixture",
      }),
      event("todo.created", 2, "Created Todo", {
        todo: {
          todo_id: "todo:one",
          title: "Inspect the implementation",
          state: "pending",
          depends_on: [],
          evidence_event_ids: [],
          created_by: "model",
        },
      }),
      event("plan.ready", 3, "Plan ready", {
        todo_ids: ["todo:one"],
        todo_count: 1,
      }),
    ]);

    expect(planned).toMatchObject({
      mode: "plan",
      status: "awaiting_plan_approval",
      pending_plan: { plan_event_id: "event:3", todo_ids: ["todo:one"] },
      todos: { items: [{ todo_id: "todo:one", state: "pending" }], last_sequence: 3 },
    });

    const executing = projectRun([
      ...planned.timeline.map((wireEvent) => SessionEventSchema.parse({
        ...wireEvent,
        attempt: 0,
        event_hash: HASH,
      })),
      event("plan.approved", 4, "Plan approved", {
        plan_event_id: "event:3",
        todo_ids: ["todo:one"],
        approved_by: "user",
      }),
    ]);
    expect(executing.mode).toBe("execute");
    expect(executing.status).toBe("running");
    expect(executing.pending_plan).toBeUndefined();
  });

  it("projects the durable input queue in order and exposes the latest consumption fact", () => {
    const events = [
      event("run.created", 1, "Created", {
        task: "Steer the work",
        mode: "execute",
        workspace_kind: "disposable_fixture",
      }),
      queuedInput(2, "input:one", "First message"),
      queuedInput(3, "input:two", "Second message"),
      event("user.input_consumed", 4, "Consumed first input", {
        input_id: "input:one",
        kind: "message",
        consumed_at: "2026-09-19T01:00:02.000Z",
        at_step: 1,
        queued_event_id: "event:2",
      }),
      queuedInput(5, "input:three", "token=super-secret-value in /Users/cain/private/repo"),
    ];

    const projection = projectRun(events);
    expect(projection.input_queue.pending.map((input) => input.input_id)).toEqual([
      "input:two",
      "input:three",
    ]);
    expect(projection.input_queue.pending[1]?.body).toContain("[REDACTED]");
    expect(projection.input_queue.pending[1]?.body).toContain("[REDACTED_LOCAL_PATH]");
    expect(projection.input_queue.last_consumed).toEqual({
      input_id: "input:one",
      kind: "message",
      consumed_at: "2026-09-19T01:00:02.000Z",
      at_step: 1,
      queued_event_id: "event:2",
    });
    expect(JSON.stringify(projection.timeline)).not.toContain("_internal_command_digest");
    expect(JSON.stringify(projection.timeline)).not.toContain("_internal_input_digest");
  });

  it("keeps dynamically expanded secret redaction inside the public body bound", () => {
    const secret = "g14s3crt";
    const originalBody = secret.repeat(MAX_USER_INPUT_BODY_CHARS / secret.length);
    const events = [
      event("run.created", 1, "Created", {
        task: "Steer the work",
        mode: "execute",
        workspace_kind: "disposable_fixture",
      }),
      queuedInput(2, "input:late-secret", originalBody),
    ];
    expect(projectRun(events).input_queue.pending[0]?.body).toBe(originalBody);

    registerSecretForRedaction(secret);
    const body = projectRun(events).input_queue.pending[0]?.body ?? "";
    expect(body.length).toBeLessThanOrEqual(MAX_USER_INPUT_BODY_CHARS);
    expect(body).not.toContain(secret);
    expect(body).toContain("[REDACTED_REGISTERED_SECRET]");
  });

  it("keeps an exact duplicate input idempotent even after it was consumed", () => {
    const duplicate = queuedInput(2, "input:one", "Only once");
    const projection = projectRun([
      event("run.created", 1, "Created", {
        task: "Steer the work",
        mode: "execute",
        workspace_kind: "disposable_fixture",
      }),
      duplicate,
      event("user.input_consumed", 3, "Consumed", {
        input_id: "input:one",
        kind: "message",
        consumed_at: "2026-09-19T01:00:02.000Z",
        at_step: 1,
        queued_event_id: "event:2",
      }),
      event("user.input_queued", 4, "Duplicate retry", duplicate.data),
    ]);

    expect(projection.input_queue.pending).toEqual([]);
    expect(projection.input_queue.last_consumed?.input_id).toBe("input:one");
  });

  it("allows emergency cancellation to preempt ordinary FIFO input", () => {
    const projection = projectRun([
      event("run.created", 1, "Created", {
        task: "Steer the work",
        mode: "execute",
        workspace_kind: "disposable_fixture",
      }),
      queuedInput(2, "input:message", "Keep investigating"),
      event("user.input_queued", 3, "Cancellation queued", {
        input: {
          input_id: "input:cancel",
          run_id: "run:test",
          kind: "cancel",
          body: "",
          actor: "user",
          submitted_at: "2026-09-19T01:00:02.000Z",
        },
        _internal_command_digest: HASH,
        _internal_input_digest: HASH,
      }),
      event("user.input_consumed", 4, "Cancellation consumed", {
        input_id: "input:cancel",
        kind: "cancel",
        consumed_at: "2026-09-19T01:00:03.000Z",
        at_step: 1,
        queued_event_id: "event:3",
      }),
    ]);

    expect(projection.input_queue.pending.map((input) => input.input_id)).toEqual(["input:message"]);
    expect(projection.input_queue.last_consumed?.input_id).toBe("input:cancel");
  });

  it("fails closed on malformed, conflicting, unknown, or double-consumed input events", () => {
    const created = event("run.created", 1, "Created", {
      task: "Steer the work",
      mode: "execute",
      workspace_kind: "disposable_fixture",
    });
    const queued = queuedInput(2, "input:one", "Original");
    const consumed = event("user.input_consumed", 3, "Consumed", {
      input_id: "input:one",
      kind: "message",
      consumed_at: "2026-09-19T01:00:02.000Z",
      at_step: 1,
      queued_event_id: "event:2",
    });

    expect(() => projectRun([
      created,
      event("user.input_queued", 2, "Malformed", { input: { ...queued.data.input as object, actor: "model" } }),
    ])).toThrow("invalid user.input_queued payload");
    expect(() => projectRun([
      created,
      event("user.input_queued", 2, "Legacy queued input", {
        input: queued.data.input,
        _internal_command_digest: HASH,
      }),
      event("user.input_queued", 3, "Legacy conflicting body", {
        input: { ...(queued.data.input as object), body: "Conflicting body" },
        _internal_command_digest: HASH,
      }),
    ])).toThrow("conflicting duplicate input_id");
    expect(() => projectRun([
      created,
      queued,
      event("user.input_queued", 3, "Redaction-colliding conflict", {
        ...queued.data,
        _internal_input_digest: `sha256:${"b".repeat(64)}`,
      }),
    ])).toThrow("conflicting duplicate input_id");
    expect(() => projectRun([created, consumed])).toThrow("unknown or consumed input_id");
    expect(() => projectRun([created, queued, consumed, event("user.input_consumed", 4, "Again", consumed.data)]))
      .toThrow("unknown or consumed input_id");
    expect(() => projectRun([
      created,
      queued,
      queuedInput(3, "input:two", "Second"),
      event("user.input_consumed", 4, "Consumed out of order", {
        input_id: "input:two",
        kind: "message",
        consumed_at: "2026-09-19T01:00:03.000Z",
        at_step: 1,
        queued_event_id: "event:3",
      }),
    ])).toThrow("violates FIFO order");
    expect(() => projectRun([
      created,
      { ...queued, run_id: "run:smuggled" },
    ])).toThrow("ledger scope mismatch");
    expect(() => projectRun([
      created,
      queued,
      queuedInput(3, "input:two", "Second"),
      consumed,
      event("user.input_consumed", 4, "Same step", {
        input_id: "input:two",
        kind: "message",
        consumed_at: "2026-09-19T01:00:03.000Z",
        at_step: 1,
        queued_event_id: "event:3",
      }),
    ])).toThrow("at_step must increase monotonically");
  });
});

function queuedInput(sequence: number, inputId: string, body: string): SessionEvent {
  return event("user.input_queued", sequence, "Queued input", {
    input: {
      input_id: inputId,
      run_id: "run:test",
      kind: "message",
      body,
      actor: "user",
      submitted_at: "2026-09-19T01:00:01.000Z",
    },
    _internal_command_digest: HASH,
    _internal_input_digest: HASH,
  });
}

function event(type: EventType, sequence: number, summary: string, data: Record<string, unknown>): SessionEvent {
  return SessionEventSchema.parse({
    schema_version: SCHEMA_VERSION,
    event_id: `event:${sequence}`,
    project_id: "project:test",
    run_id: "run:test",
    sequence,
    occurred_at: "2026-09-16T00:00:00.000Z",
    attempt: 0,
    type,
    summary,
    artifact_refs: [],
    event_hash: HASH,
    data,
  });
}
