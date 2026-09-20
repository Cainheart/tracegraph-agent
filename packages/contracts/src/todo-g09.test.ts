import { describe, expect, it } from "vitest";
import {
  ApprovePlanCommandSchema,
  ApprovePlanRequestSchema,
  BUILTIN_PERMISSION_PRESETS,
  CurrentRunRecoveryStateSchema,
  EventTypeSchema,
  DEFAULT_TODO_READ_PAGE_ITEMS,
  MAX_TODO_ITEMS,
  MAX_TODO_READ_PAGE_ITEMS,
  PendingPlanSchema,
  PlanApprovedDataSchema,
  PlanReadyDataSchema,
  RunModeSchema,
  RunRecoveryStateSchema,
  SessionResumeResponseSchema,
  TodoBlockedDataSchema,
  TodoCompletedDataSchema,
  TodoItemSchema,
  TodoListSchema,
  TodoReadInputSchema,
  TodoWriteInputSchema,
  TodoWriteRequestSchema,
  ToolNameSchema,
} from "./index.js";

const POLICY_HASH = `sha256:${"a".repeat(64)}` as const;

function todo(overrides: Record<string, unknown> = {}) {
  return {
    todo_id: "todo:a",
    title: "Implement the first step",
    state: "pending",
    depends_on: [],
    evidence_event_ids: [],
    created_by: "model",
    ...overrides,
  };
}

describe("G-09 Todo contracts", () => {
  it("defines strict bounded Todo items and mutation inputs", () => {
    expect(TodoItemSchema.parse(todo()).state).toBe("pending");
    expect(() => TodoItemSchema.parse(todo({ injected: true }))).toThrow();
    expect(() => TodoItemSchema.parse(todo({ depends_on: ["todo:a"] })))
      .toThrow(/cannot depend on itself/u);
    expect(() => TodoItemSchema.parse(todo({ depends_on: ["todo:b", "todo:b"] })))
      .toThrow(/must be unique/u);

    expect(TodoWriteInputSchema.parse({
      operation: "create",
      todo_id: "todo:a",
      title: "Implement the first step",
    }).operation).toBe("create");
    expect(() => TodoWriteInputSchema.parse({ operation: "create", todo_id: "todo:a" }))
      .toThrow(/requires title/u);
    expect(() => TodoWriteInputSchema.parse({ operation: "update", todo_id: "todo:a" }))
      .toThrow(/at least one changed field/u);
    expect(TodoWriteRequestSchema.parse({
      command_id: "command:todo",
      input: { operation: "update", todo_id: "todo:a", state: "in_progress" },
    }).command_id).toBe("command:todo");
    expect(() => TodoWriteRequestSchema.parse({
      command_id: "command:todo",
      project_id: "project:smuggled",
      input: { operation: "update", todo_id: "todo:a", state: "in_progress" },
    })).toThrow();
  });

  it("bounds and defaults model-facing Todo pagination", () => {
    expect(TodoReadInputSchema.parse({})).toEqual({
      offset: 0,
      limit: DEFAULT_TODO_READ_PAGE_ITEMS,
    });
    expect(TodoReadInputSchema.parse({
      offset: MAX_TODO_ITEMS,
      limit: MAX_TODO_READ_PAGE_ITEMS,
    })).toEqual({ offset: MAX_TODO_ITEMS, limit: MAX_TODO_READ_PAGE_ITEMS });
    expect(() => TodoReadInputSchema.parse({ offset: -1 })).toThrow();
    expect(() => TodoReadInputSchema.parse({ limit: MAX_TODO_READ_PAGE_ITEMS + 1 })).toThrow();
    expect(() => TodoReadInputSchema.parse({ offset: 0, limit: 1, project_id: "project:smuggled" }))
      .toThrow();
  });

  it("rejects missing dependencies and dependency cycles at the read-model boundary", () => {
    expect(() => TodoListSchema.parse({
      items: [todo({ depends_on: ["todo:missing"] })],
      last_sequence: 1,
    })).toThrow(/does not exist/u);
    expect(() => TodoListSchema.parse({
      items: [
        todo({ todo_id: "todo:a", depends_on: ["todo:b"] }),
        todo({ todo_id: "todo:b", depends_on: ["todo:c"] }),
        todo({ todo_id: "todo:c", depends_on: ["todo:a"] }),
      ],
      last_sequence: 3,
    })).toThrow(/todo:a -> todo:b -> todo:c -> todo:a/u);
  });

  it("requires independent evidence for model completion but treats user completion as evidence", () => {
    expect(() => TodoCompletedDataSchema.parse({
      todo: todo({ state: "done" }),
      previous_state: "in_progress",
      updated_by: "model",
    })).toThrow(/require at least one evidence event/u);
    expect(TodoCompletedDataSchema.parse({
      todo: todo({ state: "done" }),
      previous_state: "pending",
      updated_by: "user",
    }).updated_by).toBe("user");
    expect(TodoCompletedDataSchema.parse({
      todo: todo({ state: "done", evidence_event_ids: ["event:test"] }),
      previous_state: "in_progress",
      updated_by: "model",
    }).todo.evidence_event_ids).toEqual(["event:test"]);
    expect(TodoBlockedDataSchema.parse({
      todo: todo({ state: "blocked" }),
      previous_state: "in_progress",
      updated_by: "model",
    }).todo.state).toBe("blocked");
  });

  it("registers Todo/Plan events, Tool names, preset access, and strict Plan payloads", () => {
    for (const type of [
      "plan.ready",
      "plan.approved",
      "todo.created",
      "todo.updated",
      "todo.completed",
      "todo.blocked",
    ] as const) {
      expect(EventTypeSchema.parse(type)).toBe(type);
    }
    expect(ToolNameSchema.parse("todo_read")).toBe("todo_read");
    expect(ToolNameSchema.parse("todo_write")).toBe("todo_write");
    expect(BUILTIN_PERMISSION_PRESETS["read-only"].allowed_tools).toEqual(
      expect.arrayContaining(["todo_read", "todo_write"]),
    );
    expect(PlanReadyDataSchema.parse({
      todo_ids: ["todo:a", "todo:b"],
      todo_count: 2,
    }).todo_count).toBe(2);
    expect(() => PlanReadyDataSchema.parse({
      todo_ids: ["todo:a"],
      todo_count: 2,
    })).toThrow(/must match/u);
    expect(PlanApprovedDataSchema.parse({
      plan_event_id: "event:plan-ready",
      todo_ids: ["todo:a"],
      approved_by: "user",
    }).approved_by).toBe("user");
  });

  it("uses plan|execute publicly while preserving legacy manual recovery", () => {
    expect(RunModeSchema.parse("plan")).toBe("plan");
    expect(RunModeSchema.parse("execute")).toBe("execute");
    expect(() => RunModeSchema.parse("manual")).toThrow();

    const effectivePolicy = {
      policy_version: 1,
      preset: BUILTIN_PERMISSION_PRESETS["workspace-write"],
      host_rules: [],
      project_rules: [],
      policy_digest: POLICY_HASH,
    } as const;
    expect(CurrentRunRecoveryStateSchema.parse({
      version: 3,
      kind: "run_recovery_state",
      task: "Continue this run",
      conversation_history: [],
      mode: "execute",
      reasoning_effort: "default",
      effective_policy: effectivePolicy,
    }).mode).toBe("execute");
    expect(() => CurrentRunRecoveryStateSchema.parse({
      version: 3,
      kind: "run_recovery_state",
      task: "Continue this run",
      conversation_history: [],
      mode: "manual",
      reasoning_effort: "default",
      effective_policy: effectivePolicy,
    })).toThrow();
    expect(RunRecoveryStateSchema.parse({
      version: 2,
      kind: "run_recovery_state",
      task: "Replay a legacy run",
      conversation_history: [],
      mode: "manual",
      reasoning_effort: "default",
      effective_policy: effectivePolicy,
    }).mode).toBe("manual");
  });

  it("binds approval to an exact pending plan revision", () => {
    expect(ApprovePlanRequestSchema.parse({
      command_id: "command:approve-plan",
      plan_event_id: "event:plan-ready",
    }).plan_event_id).toBe("event:plan-ready");
    expect(() => ApprovePlanRequestSchema.parse({
      command_id: "command:approve-plan",
      plan_event_id: "event:plan-ready",
      project_id: "project:smuggled",
    })).toThrow();
    expect(ApprovePlanCommandSchema.parse({
      type: "approve_plan",
      command_id: "command:approve-plan",
      project_id: "project:g09",
      run_id: "run:g09",
      plan_event_id: "event:plan-ready",
    }).run_id).toBe("run:g09");
    expect(PendingPlanSchema.parse({
      plan_event_id: "event:plan-ready",
      todo_ids: ["todo:a"],
    }).todo_ids).toEqual(["todo:a"]);
    expect(SessionResumeResponseSchema.parse({
      session_id: "session:g09",
      project_id: "project:g09",
      run_id: "run:g09",
      status: "awaiting_plan_approval",
      resumed_at: "2026-09-19T10:00:00.000+08:00",
    }).status).toBe("awaiting_plan_approval");
  });
});
