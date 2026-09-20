import {
  IdentifierSchema,
  MAX_TODO_ITEMS,
  ReceiptSchema,
  TODO_EVENT_DATA_SCHEMAS,
  TodoActorSchema,
  TodoBlockedDataSchema,
  TodoCompletedDataSchema,
  TodoCreatedDataSchema,
  TodoItemSchema,
  TodoListSchema,
  TodoMutationResultSchema,
  TodoUpdatedDataSchema,
  TodoWriteInputSchema,
  type SessionEvent,
  type SessionEventProposal,
  type TodoActor,
  type TodoItem,
  type TodoList,
  type TodoMutationEventType,
  type TodoMutationResult,
  type TodoState,
  type TodoWriteInput,
} from "@tracegraph/contracts";
import { sha256, stableStringify } from "./crypto.js";

export type TodoDomainErrorCode =
  | "run_not_found"
  | "run_scope_mismatch"
  | "todo_already_exists"
  | "todo_limit_exceeded"
  | "todo_not_found"
  | "dependency_not_found"
  | "self_dependency"
  | "dependency_cycle"
  | "dependency_incomplete"
  | "invalid_transition"
  | "evidence_required"
  | "evidence_event_not_found"
  | "evidence_event_not_eligible"
  | "idempotency_conflict"
  | "invalid_todo_event";

export interface TodoDomainErrorDetails {
  readonly todoId?: string;
  readonly dependencyId?: string;
  readonly evidenceEventId?: string;
  readonly cyclePath?: readonly string[];
}

export class TodoDomainError extends Error {
  readonly code: TodoDomainErrorCode;
  readonly todoId?: string;
  readonly dependencyId?: string;
  readonly evidenceEventId?: string;
  readonly cyclePath?: readonly string[];

  constructor(code: TodoDomainErrorCode, message: string, details: TodoDomainErrorDetails = {}) {
    super(message);
    this.name = "TodoDomainError";
    this.code = code;
    if (details.todoId !== undefined) this.todoId = details.todoId;
    if (details.dependencyId !== undefined) this.dependencyId = details.dependencyId;
    if (details.evidenceEventId !== undefined) this.evidenceEventId = details.evidenceEventId;
    if (details.cyclePath !== undefined) this.cyclePath = Object.freeze([...details.cyclePath]);
  }
}

export interface TodoEventLedger {
  list(runId: string): Promise<SessionEvent[]>;
  append(proposal: SessionEventProposal): Promise<SessionEvent>;
}

export interface TodoWriteScope {
  projectId: string;
  runId: string;
  sessionId?: string;
  updatedBy: TodoActor;
  /** Caller-owned command/action identity; collisions are rejected, not replayed blindly. */
  idempotencyKey?: string;
}

const TODO_EVENT_TYPES = new Set<TodoMutationEventType>([
  "todo.created",
  "todo.updated",
  "todo.completed",
  "todo.blocked",
]);

const ALLOWED_TRANSITIONS: Readonly<Record<TodoState, ReadonlySet<TodoState>>> = Object.freeze({
  pending: new Set<TodoState>(["in_progress", "blocked", "done", "cancelled"]),
  in_progress: new Set<TodoState>(["pending", "blocked", "done", "cancelled"]),
  blocked: new Set<TodoState>(["pending", "in_progress", "done", "cancelled"]),
  // Reopening appends a new event; it does not erase the historical completion
  // or cancellation fact and keeps the Web checkbox reversible.
  done: new Set<TodoState>(["pending", "in_progress"]),
  cancelled: new Set<TodoState>(["pending"]),
});

/** Replay the canonical Run ledger into the current Todo list. */
export function projectTodos(events: readonly SessionEvent[]): TodoList {
  const items = new Map<string, TodoItem>();
  const evidenceEvents = new Map<string, boolean>();
  const runId = events[0]?.run_id;

  for (const event of events) {
    if (runId !== undefined && event.run_id !== runId) {
      throw new TodoDomainError(
        "run_scope_mismatch",
        "Todo replay cannot combine events from different runs",
      );
    }
    if (!isTodoEventType(event.type)) {
      evidenceEvents.set(event.event_id, isEligibleTodoCompletionEvidence(event));
      continue;
    }

    const data = parseTodoEventData(event);
    const todo = data.todo;
    if (event.type === "todo.created") {
      if (items.has(todo.todo_id)) {
        throw new TodoDomainError(
          "todo_already_exists",
          `Todo ${todo.todo_id} was created more than once`,
          { todoId: todo.todo_id },
        );
      }
      validateTodoCandidate(items, todo, evidenceEvents, false, false);
    } else {
      const existing = items.get(todo.todo_id);
      if (existing === undefined) {
        throw new TodoDomainError(
          "todo_not_found",
          `Todo ${todo.todo_id} was updated before it was created`,
          { todoId: todo.todo_id },
        );
      }
      if (data.previous_state === undefined || data.updated_by === undefined) {
        throw new TodoDomainError(
          "invalid_todo_event",
          `Event ${event.event_id} is missing Todo update metadata`,
          { todoId: todo.todo_id },
        );
      }
      if (data.previous_state !== existing.state) {
        throw new TodoDomainError(
          "invalid_todo_event",
          `Todo ${todo.todo_id} expected previous state ${existing.state}, got ${data.previous_state}`,
          { todoId: todo.todo_id },
        );
      }
      if (todo.created_by !== existing.created_by) {
        throw new TodoDomainError(
          "invalid_todo_event",
          `Todo ${todo.todo_id} changed its immutable creator`,
          { todoId: todo.todo_id },
        );
      }
      assertTodoTransition(todo.todo_id, existing.state, todo.state);
      validateTodoCandidate(
        items,
        todo,
        evidenceEvents,
        event.type === "todo.completed" && data.updated_by === "model",
        true,
      );
    }
    items.set(todo.todo_id, todo);
    // Todo mutations are durable state transitions, not independent evidence
    // that the work represented by another Todo actually happened.
    evidenceEvents.set(event.event_id, false);
  }

  return TodoListSchema.parse({
    items: [...items.values()],
    last_sequence: events.at(-1)?.sequence ?? 0,
  });
}

/**
 * Run-scoped Todo command service. It owns no files: every accepted mutation
 * is one canonical ledger event, and reads always replay that ledger.
 */
export class TodoDomainService {
  readonly #ledger: TodoEventLedger;
  readonly #queues = new Map<string, Promise<void>>();

  constructor(ledger: TodoEventLedger) {
    this.#ledger = ledger;
  }

  async read(runIdValue: string): Promise<TodoList> {
    const runId = IdentifierSchema.parse(runIdValue);
    await this.#queues.get(runId);
    return projectTodos(await this.#ledger.list(runId));
  }

  async write(scopeValue: TodoWriteScope, inputValue: TodoWriteInput): Promise<TodoMutationResult> {
    const projectId = IdentifierSchema.parse(scopeValue.projectId);
    const runId = IdentifierSchema.parse(scopeValue.runId);
    const sessionId = scopeValue.sessionId === undefined
      ? undefined
      : IdentifierSchema.parse(scopeValue.sessionId);
    const updatedBy = TodoActorSchema.parse(scopeValue.updatedBy);
    const idempotencyKey = scopeValue.idempotencyKey === undefined
      ? undefined
      : IdentifierSchema.parse(scopeValue.idempotencyKey);
    const input = TodoWriteInputSchema.parse(inputValue);
    return this.#serialize(runId, async () => {
      const events = await this.#ledger.list(runId);
      const first = events[0];
      if (first === undefined || first.type !== "run.created") {
        throw new TodoDomainError("run_not_found", `Run ${runId} does not have a canonical ledger`);
      }
      if (first.project_id !== projectId || (sessionId !== undefined && first.session_id !== sessionId)) {
        throw new TodoDomainError("run_scope_mismatch", "Todo command does not match the Run scope");
      }

      const commandDigest = sha256(stableStringify({
        domain: "tracegraph.todo-command.v1",
        project_id: projectId,
        run_id: runId,
        updated_by: updatedBy,
        input,
      }));
      // Validate the complete canonical read model before either replaying an
      // idempotent response or proposing a new mutation. This applies the same
      // evidence eligibility rules to legacy/restarted ledgers and live writes.
      const current = projectTodos(events);
      if (idempotencyKey !== undefined) {
        const duplicate = events.find((event) => event.idempotency_key === idempotencyKey);
        if (duplicate !== undefined) {
          if (!isTodoEventType(duplicate.type)) {
            throw new TodoDomainError(
              "idempotency_conflict",
              "Todo command id was already used by another Run operation",
            );
          }
          const data = parseTodoEventData(duplicate);
          if (data._internal_command_digest !== commandDigest) {
            throw new TodoDomainError(
              "idempotency_conflict",
              "Todo command id was already used with a different payload",
              { todoId: data.todo.todo_id },
            );
          }
          return TodoMutationResultSchema.parse({
            todo: data.todo,
            event_type: duplicate.type,
            event_id: duplicate.event_id,
            last_sequence: events.at(-1)?.sequence ?? duplicate.sequence,
          });
        }
      }

      const items = new Map(current.items.map((todo) => [todo.todo_id, todo]));
      const evidenceEvents = new Map(events.map((event) => [
        event.event_id,
        isEligibleTodoCompletionEvidence(event),
      ]));
      const mutation = input.operation === "create"
        ? createTodoMutation(items, evidenceEvents, updatedBy, input)
        : updateTodoMutation(items, evidenceEvents, updatedBy, input);
      // The read model is bounded to MAX_TODO_ITEMS. Reject before the
      // canonical append so an over-limit command cannot poison all future
      // replay of this Run.
      if (mutation.type === "todo.created" && current.items.length >= MAX_TODO_ITEMS) {
        throw new TodoDomainError(
          "todo_limit_exceeded",
          `A Run cannot contain more than ${MAX_TODO_ITEMS} Todos`,
          { todoId: mutation.todo.todo_id },
        );
      }
      const data = mutationData(mutation, commandDigest, idempotencyKey !== undefined);
      const appended = await this.#ledger.append({
        type: mutation.type,
        project_id: projectId,
        run_id: runId,
        ...(sessionId === undefined ? {} : { session_id: sessionId }),
        attempt: 0,
        summary: mutationSummary(mutation.type),
        artifact_refs: [],
        ...(idempotencyKey === undefined ? {} : {
          idempotency_key: idempotencyKey,
          operation_id: idempotencyKey,
        }),
        data,
      });
      if (idempotencyKey !== undefined) {
        const appendedData = parseTodoEventData(appended);
        if (appendedData._internal_command_digest !== commandDigest) {
          throw new TodoDomainError(
            "idempotency_conflict",
            "Todo command id was concurrently used with a different payload",
            { todoId: appendedData.todo.todo_id },
          );
        }
      }

      // Exercise the same replay path used after restart before acknowledging
      // the mutation to a Tool or API caller.
      const replayed = projectTodos([...events, appended]);
      const todo = replayed.items.find(({ todo_id: todoId }) => todoId === mutation.todo.todo_id);
      if (todo === undefined) {
        throw new TodoDomainError("invalid_todo_event", "Appended Todo event did not replay");
      }
      return TodoMutationResultSchema.parse({
        todo,
        event_type: mutation.type,
        event_id: appended.event_id,
        last_sequence: appended.sequence,
      });
    });
  }

  #serialize<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(runId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.#queues.set(runId, settled);
    void settled.finally(() => {
      if (this.#queues.get(runId) === settled) this.#queues.delete(runId);
    });
    return result;
  }
}

interface TodoMutation {
  readonly type: TodoMutationEventType;
  readonly todo: TodoItem;
  readonly previousState?: TodoState;
  readonly updatedBy: TodoActor;
}

function createTodoMutation(
  items: ReadonlyMap<string, TodoItem>,
  evidenceEvents: ReadonlyMap<string, boolean>,
  actor: TodoActor,
  input: TodoWriteInput,
): TodoMutation {
  if (items.has(input.todo_id)) {
    throw new TodoDomainError(
      "todo_already_exists",
      `Todo ${input.todo_id} already exists`,
      { todoId: input.todo_id },
    );
  }
  assertNoSelfDependency(input.todo_id, input.depends_on ?? []);
  const todo = TodoItemSchema.parse({
    todo_id: input.todo_id,
    title: input.title,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
    state: "pending",
    depends_on: input.depends_on ?? [],
    evidence_event_ids: [],
    created_by: actor,
  });
  validateTodoCandidate(items, todo, evidenceEvents, false, false);
  return { type: "todo.created", todo, updatedBy: actor };
}

function updateTodoMutation(
  items: ReadonlyMap<string, TodoItem>,
  evidenceEvents: ReadonlyMap<string, boolean>,
  actor: TodoActor,
  input: TodoWriteInput,
): TodoMutation {
  const existing = items.get(input.todo_id);
  if (existing === undefined) {
    throw new TodoDomainError(
      "todo_not_found",
      `Todo ${input.todo_id} does not exist`,
      { todoId: input.todo_id },
    );
  }
  const nextState = input.state ?? existing.state;
  assertTodoTransition(existing.todo_id, existing.state, nextState);
  const nextDependencies = input.depends_on ?? existing.depends_on;
  assertNoSelfDependency(existing.todo_id, nextDependencies);
  const entersDone = existing.state !== "done" && nextState === "done";
  if (entersDone && actor === "model" && (input.evidence_event_ids ?? existing.evidence_event_ids).length === 0) {
    throw new TodoDomainError(
      "evidence_required",
      `Model completion of Todo ${existing.todo_id} requires prior Run evidence`,
      { todoId: existing.todo_id },
    );
  }
  const todo = TodoItemSchema.parse({
    ...existing,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.clear_detail === true
      ? { detail: undefined }
      : input.detail === undefined
        ? {}
        : { detail: input.detail }),
    state: nextState,
    ...(input.depends_on === undefined ? {} : { depends_on: nextDependencies }),
    ...(input.evidence_event_ids === undefined ? {} : { evidence_event_ids: input.evidence_event_ids }),
  });
  validateTodoCandidate(items, todo, evidenceEvents, entersDone && actor === "model", true);
  const type: TodoMutationEventType = existing.state !== todo.state && todo.state === "done"
    ? "todo.completed"
    : existing.state !== todo.state && todo.state === "blocked"
      ? "todo.blocked"
      : "todo.updated";
  return { type, todo, previousState: existing.state, updatedBy: actor };
}

function mutationData(
  mutation: TodoMutation,
  commandDigest: string,
  includeDigest: boolean,
): Record<string, unknown> {
  const internal = includeDigest ? { _internal_command_digest: commandDigest } : {};
  if (mutation.type === "todo.created") {
    return TodoCreatedDataSchema.parse({ todo: mutation.todo, ...internal });
  }
  const common = {
    todo: mutation.todo,
    previous_state: mutation.previousState,
    updated_by: mutation.updatedBy,
    ...internal,
  };
  if (mutation.type === "todo.completed") return TodoCompletedDataSchema.parse(common);
  if (mutation.type === "todo.blocked") return TodoBlockedDataSchema.parse(common);
  return TodoUpdatedDataSchema.parse(common);
}

interface ParsedTodoEventData {
  readonly todo: TodoItem;
  readonly previous_state?: TodoState;
  readonly updated_by?: TodoActor;
  readonly _internal_command_digest?: string;
}

function parseTodoEventData(event: SessionEvent): ParsedTodoEventData {
  if (!isTodoEventType(event.type)) {
    throw new TodoDomainError("invalid_todo_event", `Event ${event.event_id} is not a Todo event`);
  }
  const parsed = TODO_EVENT_DATA_SCHEMAS[event.type].safeParse(event.data);
  if (!parsed.success) {
    throw new TodoDomainError(
      "invalid_todo_event",
      `Event ${event.event_id} has an invalid ${event.type} payload`,
    );
  }
  return parsed.data as ParsedTodoEventData;
}

function validateTodoCandidate(
  currentItems: ReadonlyMap<string, TodoItem>,
  candidate: TodoItem,
  evidenceEvents: ReadonlyMap<string, boolean>,
  requireCompletionEvidence: boolean,
  replacing: boolean,
): void {
  for (const dependencyId of candidate.depends_on) {
    if (dependencyId === candidate.todo_id) {
      throw new TodoDomainError(
        "self_dependency",
        `Todo dependency cycle: ${candidate.todo_id} -> ${candidate.todo_id}`,
        { todoId: candidate.todo_id, cyclePath: [candidate.todo_id, candidate.todo_id] },
      );
    }
    const dependency = currentItems.get(dependencyId);
    if (dependency === undefined) {
      throw new TodoDomainError(
        "dependency_not_found",
        `Todo ${candidate.todo_id} depends on missing Todo ${dependencyId}`,
        { todoId: candidate.todo_id, dependencyId },
      );
    }
    if (candidate.state === "done" && dependency.state !== "done") {
      throw new TodoDomainError(
        "dependency_incomplete",
        `Todo ${candidate.todo_id} cannot complete before dependency ${dependencyId}`,
        { todoId: candidate.todo_id, dependencyId },
      );
    }
  }
  for (const evidenceEventId of candidate.evidence_event_ids) {
    const eligible = evidenceEvents.get(evidenceEventId);
    if (eligible === undefined) {
      throw new TodoDomainError(
        "evidence_event_not_found",
        `Todo ${candidate.todo_id} references an unavailable Run evidence event`,
        { todoId: candidate.todo_id, evidenceEventId },
      );
    }
    if (!eligible) {
      throw new TodoDomainError(
        "evidence_event_not_eligible",
        `Todo ${candidate.todo_id} references an event that is not independent completion evidence`,
        { todoId: candidate.todo_id, evidenceEventId },
      );
    }
  }
  if (candidate.state === "done" && requireCompletionEvidence && candidate.evidence_event_ids.length === 0) {
    throw new TodoDomainError(
      "evidence_required",
      `Model completion of Todo ${candidate.todo_id} requires prior Run evidence`,
      { todoId: candidate.todo_id },
    );
  }
  const existingCandidate = replacing ? currentItems.get(candidate.todo_id) : undefined;
  if (
    existingCandidate?.state === "done"
    && existingCandidate.evidence_event_ids.length > 0
    && candidate.state === "done"
    && candidate.evidence_event_ids.length === 0
  ) {
    throw new TodoDomainError(
      "evidence_required",
      `Completed Todo ${candidate.todo_id} cannot discard its canonical evidence while remaining done`,
      { todoId: candidate.todo_id },
    );
  }

  const candidateItems = new Map(currentItems);
  if (!replacing && candidateItems.has(candidate.todo_id)) {
    throw new TodoDomainError("todo_already_exists", `Todo ${candidate.todo_id} already exists`);
  }
  candidateItems.set(candidate.todo_id, candidate);
  for (const todo of [...candidateItems.values()].sort((left, right) => left.todo_id.localeCompare(right.todo_id))) {
    if (todo.state !== "done") continue;
    for (const dependencyId of todo.depends_on) {
      if (candidateItems.get(dependencyId)?.state === "done") continue;
      throw new TodoDomainError(
        "dependency_incomplete",
        `Todo ${todo.todo_id} cannot remain completed while dependency ${dependencyId} is incomplete`,
        { todoId: todo.todo_id, dependencyId },
      );
    }
  }
  const cyclePath = findTodoDependencyCycle(candidateItems.values());
  if (cyclePath !== undefined) {
    throw new TodoDomainError(
      "dependency_cycle",
      `Todo dependency cycle: ${cyclePath.join(" -> ")}`,
      { todoId: candidate.todo_id, cyclePath },
    );
  }
}

const DIRECT_TODO_COMPLETION_EVIDENCE_TYPES = new Set<SessionEvent["type"]>([
  "action.verified",
  "action.reconciled",
  "patch.preview_created",
  "patch.applied",
  "graph.snapshot_created",
  "graph.delta_created",
]);

/**
 * One fail-closed evidence predicate shared by live writes and ledger replay.
 * Planning, policy, lifecycle, model narration, and Todo bookkeeping cannot
 * certify completion. Successful non-Todo tool work and its canonical derived
 * test/patch/graph facts can.
 */
export function isEligibleTodoCompletionEvidence(event: SessionEvent): boolean {
  if (event.type === "tool.completed") {
    const receipt = ReceiptSchema.safeParse(event.data.receipt);
    return receipt.success
      && receipt.data.status === "success"
      && receipt.data.transport_status === "success"
      && receipt.data.business_status === "success"
      && receipt.data.tool_name !== "todo_read"
      && receipt.data.tool_name !== "todo_write";
  }
  if (event.type === "test.completed") {
    const receipt = ReceiptSchema.safeParse(event.data.receipt);
    return receipt.success
      && receipt.data.tool_name === "run_test"
      && receipt.data.status === "success"
      && receipt.data.transport_status === "success"
      && receipt.data.business_status === "success";
  }
  return DIRECT_TODO_COMPLETION_EVIDENCE_TYPES.has(event.type);
}

export function findTodoDependencyCycle(items: Iterable<TodoItem>): readonly string[] | undefined {
  const graph = new Map([...items].map((item) => [item.todo_id, [...item.depends_on].sort()]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const stack: string[] = [];
  const stackIndexes = new Map<string, number>();

  const visit = (todoId: string): readonly string[] | undefined => {
    if (visited.has(todoId)) return undefined;
    visiting.add(todoId);
    stackIndexes.set(todoId, stack.length);
    stack.push(todoId);
    for (const dependencyId of graph.get(todoId) ?? []) {
      if (!graph.has(dependencyId)) continue;
      const cycleStart = stackIndexes.get(dependencyId);
      if (visiting.has(dependencyId) && cycleStart !== undefined) {
        return [...stack.slice(cycleStart), dependencyId];
      }
      const nested = visit(dependencyId);
      if (nested !== undefined) return nested;
    }
    stack.pop();
    stackIndexes.delete(todoId);
    visiting.delete(todoId);
    visited.add(todoId);
    return undefined;
  };

  for (const todoId of [...graph.keys()].sort()) {
    const cycle = visit(todoId);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

function assertTodoTransition(todoId: string, from: TodoState, to: TodoState): void {
  if (from === to) return;
  if (!ALLOWED_TRANSITIONS[from].has(to)) {
    throw new TodoDomainError(
      "invalid_transition",
      `Todo ${todoId} cannot transition from ${from} to ${to}`,
      { todoId },
    );
  }
}

function assertNoSelfDependency(todoId: string, dependencies: readonly string[]): void {
  if (!dependencies.includes(todoId)) return;
  throw new TodoDomainError(
    "self_dependency",
    `Todo dependency cycle: ${todoId} -> ${todoId}`,
    { todoId, cyclePath: [todoId, todoId] },
  );
}

function isTodoEventType(type: SessionEvent["type"]): type is TodoMutationEventType {
  return TODO_EVENT_TYPES.has(type as TodoMutationEventType);
}

function mutationSummary(type: TodoMutationEventType): string {
  switch (type) {
    case "todo.created": return "Todo created";
    case "todo.completed": return "Todo completed";
    case "todo.blocked": return "Todo blocked";
    case "todo.updated": return "Todo updated";
  }
}
