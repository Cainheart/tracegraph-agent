import { z } from "zod";
import {
  IdentifierSchema,
  NonEmptyStringSchema,
  Sha256Schema,
} from "./common.js";

export const MAX_TODO_ITEMS = 500;
export const MAX_TODO_DEPENDENCIES = 128;
export const MAX_TODO_EVIDENCE_EVENTS = 256;
export const MAX_TODO_READ_PAGE_ITEMS = 100;
export const DEFAULT_TODO_READ_PAGE_ITEMS = 25;

export const TodoStateSchema = z.enum([
  "pending",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
]);
export type TodoState = z.infer<typeof TodoStateSchema>;

export const TodoActorSchema = z.enum(["model", "user"]);
export type TodoActor = z.infer<typeof TodoActorSchema>;

const UniqueTodoIdsSchema = z.array(IdentifierSchema)
  .max(MAX_TODO_DEPENDENCIES)
  .superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "todo id entries must be unique" });
    }
  });

const UniqueEvidenceEventIdsSchema = z.array(IdentifierSchema)
  .max(MAX_TODO_EVIDENCE_EVENTS)
  .superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "evidence_event_ids entries must be unique" });
    }
  });

/** Canonical Todo read model projected from the Run event ledger. */
export const TodoItemSchema = z.object({
  todo_id: IdentifierSchema,
  title: NonEmptyStringSchema.max(500),
  detail: NonEmptyStringSchema.max(4_000).optional(),
  state: TodoStateSchema,
  depends_on: UniqueTodoIdsSchema,
  evidence_event_ids: UniqueEvidenceEventIdsSchema,
  created_by: TodoActorSchema,
}).strict().superRefine((todo, context) => {
  if (todo.depends_on.includes(todo.todo_id)) {
    context.addIssue({
      code: "custom",
      path: ["depends_on"],
      message: `todo ${todo.todo_id} cannot depend on itself`,
    });
  }
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

export const TodoListSchema = z.object({
  items: z.array(TodoItemSchema).max(MAX_TODO_ITEMS),
  last_sequence: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  const ids = new Set(value.items.map(({ todo_id: todoId }) => todoId));
  if (ids.size !== value.items.length) {
    context.addIssue({ code: "custom", path: ["items"], message: "todo_id values must be unique" });
    return;
  }
  value.items.forEach((todo, todoIndex) => {
    todo.depends_on.forEach((dependencyId, dependencyIndex) => {
      if (!ids.has(dependencyId)) {
        context.addIssue({
          code: "custom",
          path: ["items", todoIndex, "depends_on", dependencyIndex],
          message: `dependency ${dependencyId} does not exist`,
        });
      }
    });
  });
  const cycle = todoCyclePath(value.items);
  if (cycle !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["items"],
      message: `todo dependency cycle: ${cycle.join(" -> ")}`,
    });
  }
});
export type TodoList = z.infer<typeof TodoListSchema>;

/**
 * Model-facing Todo reads are item-paged so a valid, fully populated Run does
 * not cross the bounded Tool-result envelope and silently lose its tail.
 */
export const TodoReadInputSchema = z.object({
  offset: z.number().int().nonnegative().max(MAX_TODO_ITEMS).default(0),
  limit: z.number().int().min(1).max(MAX_TODO_READ_PAGE_ITEMS)
    .default(DEFAULT_TODO_READ_PAGE_ITEMS),
}).strict();
export type TodoReadInput = z.infer<typeof TodoReadInputSchema>;

/**
 * Kept as a root object (rather than a JSON-Schema root union) so it remains
 * representable by TraceGraph's bounded Tool schema subset.
 */
export const TodoWriteInputSchema = z.object({
  operation: z.enum(["create", "update"]),
  todo_id: IdentifierSchema,
  title: NonEmptyStringSchema.max(500).optional(),
  detail: NonEmptyStringSchema.max(4_000).optional(),
  /** Explicit flag avoids an ambiguous empty string while staying in the bounded Tool schema subset. */
  clear_detail: z.boolean().optional(),
  state: TodoStateSchema.optional(),
  depends_on: UniqueTodoIdsSchema.optional(),
  evidence_event_ids: UniqueEvidenceEventIdsSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.operation === "create") {
    if (value.title === undefined) {
      context.addIssue({ code: "custom", path: ["title"], message: "create requires title" });
    }
    if (value.clear_detail === true) {
      context.addIssue({ code: "custom", path: ["clear_detail"], message: "create cannot clear detail" });
    }
    if (value.state !== undefined && value.state !== "pending") {
      context.addIssue({ code: "custom", path: ["state"], message: "new todos must start pending" });
    }
    if ((value.evidence_event_ids?.length ?? 0) > 0) {
      context.addIssue({
        code: "custom",
        path: ["evidence_event_ids"],
        message: "new pending todos cannot start with evidence events",
      });
    }
    return;
  }
  if (value.detail !== undefined && value.clear_detail === true) {
    context.addIssue({ code: "custom", path: ["clear_detail"], message: "detail and clear_detail cannot be combined" });
  }
  if (
    value.title === undefined
    && value.detail === undefined
    && value.clear_detail === undefined
    && value.state === undefined
    && value.depends_on === undefined
    && value.evidence_event_ids === undefined
  ) {
    context.addIssue({ code: "custom", message: "update requires at least one changed field" });
  }
});
export type TodoWriteInput = z.infer<typeof TodoWriteInputSchema>;

/** Browser -> Host envelope. Project, Run, actor, and ledger scope are route/Host bound. */
export const TodoWriteRequestSchema = z.object({
  command_id: IdentifierSchema,
  input: TodoWriteInputSchema,
}).strict();
export type TodoWriteRequest = z.infer<typeof TodoWriteRequestSchema>;

export const TodoMutationEventTypeSchema = z.enum([
  "todo.created",
  "todo.updated",
  "todo.completed",
  "todo.blocked",
]);
export type TodoMutationEventType = z.infer<typeof TodoMutationEventTypeSchema>;

const InternalCommandDigestShape = {
  // Projectors keep this durable field for command-id collision detection;
  // the public wire projector removes every `_internal_` key.
  _internal_command_digest: Sha256Schema.optional(),
};

export const TodoCreatedDataSchema = z.object({
  todo: TodoItemSchema,
  ...InternalCommandDigestShape,
}).strict().superRefine((value, context) => {
  if (value.todo.state !== "pending") {
    context.addIssue({ code: "custom", path: ["todo", "state"], message: "todo.created must be pending" });
  }
  if (value.todo.evidence_event_ids.length !== 0) {
    context.addIssue({
      code: "custom",
      path: ["todo", "evidence_event_ids"],
      message: "todo.created cannot claim completion evidence",
    });
  }
});
export type TodoCreatedData = z.infer<typeof TodoCreatedDataSchema>;

const TodoChangedDataSchema = z.object({
  todo: TodoItemSchema,
  previous_state: TodoStateSchema,
  updated_by: TodoActorSchema,
  ...InternalCommandDigestShape,
}).strict();

export const TodoUpdatedDataSchema = TodoChangedDataSchema.superRefine((value, context) => {
  if (
    value.previous_state !== value.todo.state
    && (value.todo.state === "done" || value.todo.state === "blocked")
  ) {
    context.addIssue({
      code: "custom",
      path: ["todo", "state"],
      message: `entering ${value.todo.state} requires its dedicated todo event`,
    });
  }
});
export type TodoUpdatedData = z.infer<typeof TodoUpdatedDataSchema>;

export const TodoCompletedDataSchema = TodoChangedDataSchema.superRefine((value, context) => {
  if (value.todo.state !== "done") {
    context.addIssue({ code: "custom", path: ["todo", "state"], message: "todo.completed requires state=done" });
  }
  if (value.previous_state === "done") {
    context.addIssue({ code: "custom", path: ["previous_state"], message: "todo.completed must enter done" });
  }
  // A user-authored todo.completed event is itself the durable confirmation
  // behind a checkbox. Model-authored completion needs independent, prior Run
  // evidence so the model cannot certify its own work by assertion alone.
  if (value.updated_by === "model" && value.todo.evidence_event_ids.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["todo", "evidence_event_ids"],
      message: "model-completed todos require at least one evidence event",
    });
  }
});
export type TodoCompletedData = z.infer<typeof TodoCompletedDataSchema>;

export const TodoBlockedDataSchema = TodoChangedDataSchema.superRefine((value, context) => {
  if (value.todo.state !== "blocked") {
    context.addIssue({ code: "custom", path: ["todo", "state"], message: "todo.blocked requires state=blocked" });
  }
  if (value.previous_state === "blocked") {
    context.addIssue({ code: "custom", path: ["previous_state"], message: "todo.blocked must enter blocked" });
  }
});
export type TodoBlockedData = z.infer<typeof TodoBlockedDataSchema>;

export const TODO_EVENT_DATA_SCHEMAS = Object.freeze({
  "todo.created": TodoCreatedDataSchema,
  "todo.updated": TodoUpdatedDataSchema,
  "todo.completed": TodoCompletedDataSchema,
  "todo.blocked": TodoBlockedDataSchema,
});

const UniquePlanTodoIdsSchema = z.array(IdentifierSchema)
  .min(1)
  .max(MAX_TODO_ITEMS)
  .superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "plan todo_ids must be unique" });
    }
  });

export const PlanReadyDataSchema = z.object({
  todo_ids: UniquePlanTodoIdsSchema,
  todo_count: z.number().int().positive().max(MAX_TODO_ITEMS),
}).strict().superRefine((value, context) => {
  if (value.todo_count !== value.todo_ids.length) {
    context.addIssue({ code: "custom", path: ["todo_count"], message: "todo_count must match todo_ids length" });
  }
});
export type PlanReadyData = z.infer<typeof PlanReadyDataSchema>;

export const PlanApprovedDataSchema = z.object({
  plan_event_id: IdentifierSchema,
  todo_ids: UniquePlanTodoIdsSchema,
  approved_by: z.literal("user"),
}).strict();
export type PlanApprovedData = z.infer<typeof PlanApprovedDataSchema>;

export const TodoMutationResultSchema = z.object({
  todo: TodoItemSchema,
  event_type: TodoMutationEventTypeSchema,
  event_id: IdentifierSchema,
  last_sequence: z.number().int().positive(),
}).strict();
export type TodoMutationResult = z.infer<typeof TodoMutationResultSchema>;

function todoCyclePath(items: readonly TodoItem[]): string[] | undefined {
  const graph = new Map(items.map((item) => [item.todo_id, [...item.depends_on].sort()]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const stack: string[] = [];
  const stackIndexes = new Map<string, number>();

  const visit = (todoId: string): string[] | undefined => {
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
