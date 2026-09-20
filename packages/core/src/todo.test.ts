import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_TODO_ITEMS,
  SCHEMA_VERSION,
  type SessionEvent,
  type SessionEventProposal,
  type TodoMutationResult,
  type WorkspaceHandle,
} from "@tracegraph/contracts";
import { JsonlEventLedger } from "./event-ledger.js";
import { TodoDomainError, TodoDomainService, projectTodos } from "./todo.js";
import { createDefaultToolRegistry, executeToolDefinition } from "./tool-registry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("G-09 Todo domain", () => {
  it("rejects missing, self, and cyclic dependencies with a deterministic closed path", async () => {
    const { service, scope } = await harness("dependencies");

    await expect(service.write(scope, {
      operation: "create",
      todo_id: "todo:missing-dependency",
      title: "Missing dependency",
      depends_on: ["todo:absent"],
    })).rejects.toMatchObject({
      code: "dependency_not_found",
      dependencyId: "todo:absent",
    });

    await service.write(scope, {
      operation: "create",
      todo_id: "todo:a",
      title: "A",
    });
    await expect(service.write(scope, {
      operation: "update",
      todo_id: "todo:a",
      depends_on: ["todo:a"],
    })).rejects.toMatchObject({
      code: "self_dependency",
      cyclePath: ["todo:a", "todo:a"],
    });

    await service.write(scope, {
      operation: "create",
      todo_id: "todo:b",
      title: "B",
      depends_on: ["todo:a"],
    });
    await expect(service.write(scope, {
      operation: "update",
      todo_id: "todo:a",
      depends_on: ["todo:b"],
    })).rejects.toMatchObject({
      code: "dependency_cycle",
      cyclePath: ["todo:a", "todo:b", "todo:a"],
    });
  });

  it("enforces transitions, dependency completion, and current-Run evidence", async () => {
    const { ledger, service, scope } = await harness("evidence");
    const created = await service.write(scope, {
      operation: "create",
      todo_id: "todo:a",
      title: "Verify A",
    });

    await expect(service.write(scope, {
      operation: "update",
      todo_id: "todo:a",
      state: "done",
    })).rejects.toMatchObject({ code: "evidence_required" });
    await expect(service.write(scope, {
      operation: "update",
      todo_id: "todo:a",
      state: "done",
      evidence_event_ids: ["event:forged"],
    })).rejects.toMatchObject({
      code: "evidence_event_not_found",
      evidenceEventId: "event:forged",
    });

    const modelDecision = await ledger.append(proposal("model.decision", "Model claimed completion", {}));
    const todoToolCompleted = await ledger.append(proposal(
      "tool.completed",
      "Todo write completed",
      { receipt: successfulReceipt("todo_write", "self-certification") },
    ));
    const receiptlessTest = await ledger.append(proposal(
      "test.completed",
      "Receiptless test claim",
      { status: "passed" },
    ));
    const malformedTest = await ledger.append(proposal(
      "test.completed",
      "Malformed test claim",
      { receipt: { tool_name: "run_test", status: "success" } },
    ));
    for (const ineligibleEventId of [
      created.event_id,
      modelDecision.event_id,
      todoToolCompleted.event_id,
      receiptlessTest.event_id,
      malformedTest.event_id,
    ]) {
      await expect(service.write(scope, {
        operation: "update",
        todo_id: "todo:a",
        state: "done",
        evidence_event_ids: [ineligibleEventId],
      })).rejects.toMatchObject({
        code: "evidence_event_not_eligible",
        evidenceEventId: ineligibleEventId,
      });
    }

    const evidence = await ledger.append(proposal(
      "test.completed",
      "Test passed",
      { receipt: successfulReceipt("run_test", "todo-a-test") },
    ));
    const completed = await service.write(scope, {
      operation: "update",
      todo_id: "todo:a",
      state: "done",
      evidence_event_ids: [evidence.event_id],
    });
    expect(completed).toMatchObject({ event_type: "todo.completed", todo: { state: "done" } });
    await expect(service.write({ ...scope, updatedBy: "user" }, {
      operation: "update",
      todo_id: "todo:a",
      evidence_event_ids: [],
    })).rejects.toMatchObject({ code: "evidence_required", todoId: "todo:a" });
    expect((await service.read(scope.runId)).items.find(({ todo_id: todoId }) => todoId === "todo:a"))
      .toMatchObject({ evidence_event_ids: [evidence.event_id] });

    await service.write(scope, {
      operation: "create",
      todo_id: "todo:tool-evidence",
      title: "Accept substantive Tool evidence",
    });
    const toolEvidence = await ledger.append(proposal(
      "tool.completed",
      "Workspace file read",
      { receipt: successfulReceipt("read_file", "workspace-read") },
    ));
    await expect(service.write(scope, {
      operation: "update",
      todo_id: "todo:tool-evidence",
      state: "done",
      evidence_event_ids: [toolEvidence.event_id],
    })).resolves.toMatchObject({
      event_type: "todo.completed",
      todo: { evidence_event_ids: [toolEvidence.event_id] },
    });
    await expect(service.write(scope, {
      operation: "update",
      todo_id: "todo:a",
      state: "cancelled",
    })).rejects.toMatchObject({ code: "invalid_transition" });

    const userScope = { ...scope, updatedBy: "user" as const };
    await service.write(userScope, {
      operation: "create",
      todo_id: "todo:user-confirmed",
      title: "User confirms this Todo",
    });
    await expect(service.write(userScope, {
      operation: "update",
      todo_id: "todo:user-confirmed",
      state: "done",
    })).resolves.toMatchObject({
      event_type: "todo.completed",
      todo: { evidence_event_ids: [] },
    });
    await expect(service.write(userScope, {
      operation: "update",
      todo_id: "todo:user-confirmed",
      state: "pending",
    })).resolves.toMatchObject({
      event_type: "todo.updated",
      todo: { state: "pending" },
    });

    await service.write(userScope, {
      operation: "create",
      todo_id: "todo:dependent",
      title: "Depends on reopened user Todo",
      depends_on: ["todo:user-confirmed"],
    });
    await expect(service.write(userScope, {
      operation: "update",
      todo_id: "todo:dependent",
      state: "done",
    })).rejects.toMatchObject({
      code: "dependency_incomplete",
      dependencyId: "todo:user-confirmed",
    });
    await service.write(userScope, {
      operation: "update",
      todo_id: "todo:user-confirmed",
      state: "done",
    });
    await service.write(userScope, {
      operation: "update",
      todo_id: "todo:dependent",
      state: "done",
    });
    await expect(service.write(userScope, {
      operation: "update",
      todo_id: "todo:user-confirmed",
      state: "pending",
    })).rejects.toMatchObject({
      code: "dependency_incomplete",
      todoId: "todo:dependent",
      dependencyId: "todo:user-confirmed",
    });
  });

  it("replays one canonical ledger across service restarts and protects command ids", async () => {
    const { ledger, service, scope } = await harness("replay");
    const createInput = {
      operation: "create" as const,
      todo_id: "todo:replay",
      title: "Survive restart",
    };
    const commandScope = { ...scope, idempotencyKey: "command:create-replay" };
    const created = await service.write(commandScope, createInput);
    const duplicate = await service.write(commandScope, createInput);
    expect(duplicate.event_id).toBe(created.event_id);
    await expect(service.write(commandScope, {
      ...createInput,
      title: "Conflicting reuse",
    })).rejects.toMatchObject({ code: "idempotency_conflict" });

    await service.write(scope, {
      operation: "update",
      todo_id: "todo:replay",
      state: "in_progress",
      detail: "Work is underway",
    });
    await service.write(scope, {
      operation: "update",
      todo_id: "todo:replay",
      state: "blocked",
    });

    const beforeRestart = await service.read(scope.runId);
    const restarted = new TodoDomainService(ledger);
    const afterRestart = await restarted.read(scope.runId);
    expect(afterRestart).toEqual(beforeRestart);
    expect(afterRestart.items).toEqual([
      expect.objectContaining({ todo_id: "todo:replay", state: "blocked" }),
    ]);
    const events = await ledger.list(scope.runId);
    expect(events.filter(({ type }) => type.startsWith("todo.")).map(({ type }) => type))
      .toEqual(["todo.created", "todo.updated", "todo.blocked"]);
    expect(projectTodos(events)).toEqual(afterRestart);
  });

  it("rejects an over-limit create before append and keeps replay healthy", async () => {
    const ledger = new MemoryTodoLedger();
    await ledger.append(proposal("run.created", "Run created", {
      task: "Exercise the bounded Todo domain",
      mode: "plan",
      workspace_kind: "managed_local",
    }));
    const service = new TodoDomainService(ledger);
    const scope = {
      projectId: "project:g09",
      runId: "run:g09",
      sessionId: "session:g09",
      updatedBy: "model" as const,
    };
    for (let index = 0; index < MAX_TODO_ITEMS; index += 1) {
      await ledger.append(proposal("todo.created", "Todo created", {
        todo: {
          todo_id: `todo:${index}`,
          title: `Bounded Todo ${index}`,
          state: "pending",
          depends_on: [],
          evidence_event_ids: [],
          created_by: "model",
        },
      }));
    }
    const before = await ledger.list(scope.runId);

    await expect(service.write(scope, {
      operation: "create",
      todo_id: "todo:overflow",
      title: "Must not poison replay",
    })).rejects.toMatchObject({
      code: "todo_limit_exceeded",
      todoId: "todo:overflow",
    });

    const after = await ledger.list(scope.runId);
    expect(after).toEqual(before);
    expect(after.filter(({ type }) => type === "todo.created")).toHaveLength(MAX_TODO_ITEMS);
    const replayed = await service.read(scope.runId);
    expect(replayed.items).toHaveLength(MAX_TODO_ITEMS);
    expect(replayed.last_sequence).toBe(MAX_TODO_ITEMS + 1);
    expect(projectTodos(after).items).toHaveLength(MAX_TODO_ITEMS);
  }, 10_000);

  it("rejects a forged future/cross-ledger evidence id during replay", async () => {
    const { ledger, scope } = await harness("forged-replay");
    await ledger.append(proposal("todo.created", "Todo created", {
      todo: {
        todo_id: "todo:forged",
        title: "Forged evidence",
        state: "pending",
        depends_on: [],
        evidence_event_ids: [],
        created_by: "model",
      },
    }));
    await ledger.append(proposal("todo.completed", "Todo completed", {
      todo: {
        todo_id: "todo:forged",
        title: "Forged evidence",
        state: "done",
        depends_on: [],
        evidence_event_ids: ["event:future-or-other-run"],
        created_by: "model",
      },
      previous_state: "pending",
      updated_by: "model",
    }));
    await expect(new TodoDomainService(ledger).read(scope.runId)).rejects.toMatchObject({
      code: "evidence_event_not_found",
      evidenceEventId: "event:future-or-other-run",
    });
  });

  it("rejects existing but ineligible self-certification evidence during replay", async () => {
    const { ledger, scope } = await harness("ineligible-replay");
    const narration = await ledger.append(proposal(
      "model.decision",
      "Model narrated completion",
      {},
    ));
    await ledger.append(proposal("todo.created", "Todo created", {
      todo: {
        todo_id: "todo:self-certified",
        title: "Must have independent evidence",
        state: "pending",
        depends_on: [],
        evidence_event_ids: [],
        created_by: "model",
      },
    }));
    await ledger.append(proposal("todo.completed", "Todo self-certified", {
      todo: {
        todo_id: "todo:self-certified",
        title: "Must have independent evidence",
        state: "done",
        depends_on: [],
        evidence_event_ids: [narration.event_id],
        created_by: "model",
      },
      previous_state: "pending",
      updated_by: "model",
    }));

    await expect(new TodoDomainService(ledger).read(scope.runId)).rejects.toMatchObject({
      code: "evidence_event_not_eligible",
      evidenceEventId: narration.event_id,
    });
  });

  it("rejects replay that clears canonical evidence while a Todo remains done", async () => {
    const { ledger, scope } = await harness("evidence-clear-replay");
    const evidence = await ledger.append(proposal(
      "test.completed",
      "Test passed",
      { receipt: successfulReceipt("run_test", "todo-evidence-clear-test") },
    ));
    const baseTodo = {
      todo_id: "todo:evidence-clear",
      title: "Retain completion evidence",
      depends_on: [],
      created_by: "model" as const,
    };
    await ledger.append(proposal("todo.created", "Todo created", {
      todo: { ...baseTodo, state: "pending", evidence_event_ids: [] },
    }));
    await ledger.append(proposal("todo.completed", "Todo completed", {
      todo: { ...baseTodo, state: "done", evidence_event_ids: [evidence.event_id] },
      previous_state: "pending",
      updated_by: "model",
    }));
    await ledger.append(proposal("todo.updated", "Evidence removed", {
      todo: { ...baseTodo, state: "done", evidence_event_ids: [] },
      previous_state: "done",
      updated_by: "user",
    }));

    await expect(new TodoDomainService(ledger).read(scope.runId)).rejects.toMatchObject({
      code: "evidence_required",
      todoId: "todo:evidence-clear",
    });
  });

  it("returns a maximum-size contract-valid Todo as a complete one-item page", async () => {
    const registry = createDefaultToolRegistry();
    const read = registry.get("todo_read");
    if (read === undefined) throw new Error("todo_read tool missing");
    const dependencyIds = Array.from({ length: 128 }, (_, index) => (
      maximumEscapedIdentifier("dependency", index)
    ));
    const evidenceIds = Array.from({ length: 256 }, (_, index) => (
      maximumEscapedIdentifier("evidence", index)
    ));
    const dependencies = dependencyIds.map((todoId, index) => ({
      todo_id: todoId,
      title: `Dependency ${index}`,
      state: "pending" as const,
      depends_on: [],
      evidence_event_ids: [],
      created_by: "model" as const,
    }));
    const maximum = {
      todo_id: "todo:maximum-contract-item",
      title: "\0".repeat(500),
      detail: "\0".repeat(4_000),
      state: "done" as const,
      depends_on: dependencyIds,
      evidence_event_ids: evidenceIds,
      created_by: "model" as const,
    };
    const todos = { items: [...dependencies, maximum], last_sequence: 999 };

    const result = await executeToolDefinition(read, { offset: 128, limit: 1 }, {
      projectId: "project:g09",
      runId: "run:g09",
      workspace: workspace(),
      todos: {
        async read() { return todos; },
        async write() { throw new Error("not used"); },
      },
    });
    const page = JSON.parse(result.content ?? "null") as {
      items: Array<{ todo_id: string; depends_on: string[]; evidence_event_ids: string[] }>;
      returned_count: number;
      offset: number;
      truncated: boolean;
    };

    expect(registry.descriptors().find(({ name }) => name === "todo_read"))
      .toMatchObject({ max_result_bytes: 640 * 1024 });
    expect(result).toMatchObject({
      status: "success",
      code: "todos_read",
      facts: { returned_count: 1, offset: 128, truncated: false },
    });
    expect(result.facts?.output_truncated).not.toBe(true);
    expect(page).toMatchObject({ returned_count: 1, offset: 128, truncated: false });
    expect(page.items[0]).toMatchObject({
      todo_id: maximum.todo_id,
      depends_on: dependencyIds,
      evidence_event_ids: evidenceIds,
    });
  });

  it("registers bounded Todo Tools and returns domain failures explicitly", async () => {
    const registry = createDefaultToolRegistry();
    expect(registry.descriptors().find(({ name }) => name === "todo_read")).toMatchObject({
      side_effect: "read",
      concurrency_safe: true,
    });
    expect(registry.descriptors().find(({ name }) => name === "todo_write")).toMatchObject({
      side_effect: "none",
      concurrency_safe: false,
    });
    const write = registry.get("todo_write");
    if (write === undefined) throw new Error("todo_write tool missing");
    const expected: TodoMutationResult = {
      todo: {
        todo_id: "todo:tool",
        title: "Tool Todo",
        state: "pending",
        depends_on: [],
        evidence_event_ids: [],
        created_by: "model",
      },
      event_type: "todo.created",
      event_id: "event:todo-tool",
      last_sequence: 3,
    };
    const success = await executeToolDefinition(write, {
      operation: "create",
      todo_id: "todo:tool",
      title: "Tool Todo",
    }, {
      projectId: "project:g09",
      runId: "run:g09",
      workspace: workspace(),
      todos: {
        async read() { return { items: [], last_sequence: 1 }; },
        async write() { return expected; },
      },
    });
    expect(success).toMatchObject({
      status: "success",
      code: "todo.created",
      facts: { todo_id: "todo:tool", event_id: "event:todo-tool" },
    });

    const failure = await executeToolDefinition(write, {
      operation: "update",
      todo_id: "todo:tool",
      depends_on: ["todo:other"],
    }, {
      projectId: "project:g09",
      runId: "run:g09",
      workspace: workspace(),
      todos: {
        async read() { return { items: [], last_sequence: 1 }; },
        async write() {
          throw new TodoDomainError(
            "dependency_cycle",
            "Todo dependency cycle: todo:tool -> todo:other -> todo:tool",
            { cyclePath: ["todo:tool", "todo:other", "todo:tool"] },
          );
        },
      },
    });
    expect(failure).toMatchObject({
      status: "failure",
      code: "dependency_cycle",
      facts: { cycle_path: ["todo:tool", "todo:other", "todo:tool"] },
    });
  });
});

async function harness(name: string) {
  const root = await mkdtemp(join(tmpdir(), `tracegraph-g09-${name}-`));
  roots.push(root);
  let sequence = 0;
  const ledger = new JsonlEventLedger(join(root, "events"), {
    now: () => new Date("2026-09-19T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}:${++sequence}`,
  });
  await ledger.append(proposal("run.created", "Run created", {
    task: "Exercise Todo domain",
    mode: "plan",
    workspace_kind: "managed_local",
  }));
  const service = new TodoDomainService(ledger);
  return {
    ledger,
    service,
    scope: {
      projectId: "project:g09",
      runId: "run:g09",
      sessionId: "session:g09",
      updatedBy: "model" as const,
    },
  };
}

function proposal(
  type: SessionEventProposal["type"],
  summary: string,
  data: Record<string, unknown>,
): SessionEventProposal {
  return {
    type,
    project_id: "project:g09",
    run_id: "run:g09",
    session_id: "session:g09",
    attempt: 0,
    summary,
    artifact_refs: [],
    data,
  };
}

function workspace(): WorkspaceHandle {
  return {
    handle_id: "workspace:g09",
    project_id: "project:g09",
    real_root: "/tmp/tracegraph-g09",
    workspace_kind: "readonly_local",
    capabilities: {
      index: true,
      read: true,
      search: true,
      run_command: false,
      preview_patch: false,
      commit_patch: false,
      test: false,
    },
    created_at: "2026-09-19T00:00:00.000Z",
  };
}

function successfulReceipt(toolName: "todo_write" | "read_file" | "run_test", suffix: string) {
  return {
    receipt_id: `receipt:${suffix}`,
    action_id: `action:${suffix}`,
    tool_name: toolName,
    status: "success",
    transport_status: "success",
    business_status: "success",
    code: "ok",
    summary: `${toolName} succeeded`,
    started_at: "2026-09-19T00:00:00.000Z",
    completed_at: "2026-09-19T00:00:00.000Z",
    duration_ms: 0,
    artifact_refs: [],
    metadata: {},
  };
}

function maximumEscapedIdentifier(prefix: string, index: number): string {
  const visible = `${prefix}:${index}:`;
  return `${visible}${"\0".repeat(160 - visible.length)}`;
}

class MemoryTodoLedger {
  readonly #events: SessionEvent[] = [];
  #sequence = 0;

  async list(runId: string): Promise<SessionEvent[]> {
    return this.#events.filter((event) => event.run_id === runId);
  }

  async append(input: SessionEventProposal): Promise<SessionEvent> {
    const previous = this.#events.at(-1);
    this.#sequence += 1;
    const event: SessionEvent = {
      schema_version: SCHEMA_VERSION,
      event_id: `event:memory:${this.#sequence}`,
      project_id: input.project_id,
      run_id: input.run_id,
      ...(input.session_id === undefined ? {} : { session_id: input.session_id }),
      sequence: this.#sequence,
      occurred_at: "2026-09-19T00:00:00.000Z",
      attempt: input.attempt,
      summary: input.summary,
      artifact_refs: input.artifact_refs,
      ...(input.idempotency_key === undefined ? {} : { idempotency_key: input.idempotency_key }),
      ...(previous === undefined ? {} : { previous_event_hash: previous.event_hash }),
      type: input.type,
      data: input.data,
      event_hash: `sha256:${"0".repeat(64)}`,
    };
    this.#events.push(event);
    return event;
  }
}
