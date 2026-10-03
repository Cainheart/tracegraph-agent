import { SCHEMA_VERSION } from "@tracegraph/contracts";
import { CLIENT_PROTOCOL_VERSION } from "./constants.js";
import type { ClientProtocolMessage } from "./index.js";

/**
 * Deterministic, content-free messages shared by all local client surfaces.
 * CLI, Web, and Desktop consume the same
 * package subpath without copying protocol examples.
 */
export const CLIENT_PROTOCOL_CONFORMANCE_FIXTURES = [
  {
    name: "command.start_run",
    message: {
      protocol_version: CLIENT_PROTOCOL_VERSION,
      kind: "command",
      request_id: "request-run-start",
      command: {
        type: "start_run",
        command_id: "command-run-start",
        input: {
          command_id: "command-run-start",
          project_id: "project-fixture",
          task: "Inspect the selected workspace",
          mode: "plan",
        },
      },
    },
  },
  {
    name: "command.memory_create",
    message: { protocol_version: CLIENT_PROTOCOL_VERSION, kind: "command", request_id: "request-memory-create", command: {
      type: "memory.create", input: { command_id: "command-memory-create", kind: "fact", claim: "A bounded test fact", project_id: "project-fixture" },
    } },
  },
  {
    name: "command.memory_review",
    message: { protocol_version: CLIENT_PROTOCOL_VERSION, kind: "command", request_id: "request-memory-review", command: {
      type: "memory.review", memory_id: "memory-fixture", input: { command_id: "command-memory-review", expected_sequence: 0, action: "review_activate" },
    } },
  },
  {
    name: "command.memory_correct",
    message: { protocol_version: CLIENT_PROTOCOL_VERSION, kind: "command", request_id: "request-memory-correct", command: {
      type: "memory.correct", memory_id: "memory-fixture", input: { command_id: "command-memory-correct", expected_sequence: 1, claim: "Corrected test fact" },
    } },
  },
  {
    name: "command.memory_revoke",
    message: { protocol_version: CLIENT_PROTOCOL_VERSION, kind: "command", request_id: "request-memory-revoke", command: {
      type: "memory.revoke", memory_id: "memory-fixture", input: { command_id: "command-memory-revoke", expected_sequence: 1 },
    } },
  },
  {
    name: "command.memory_delete",
    message: { protocol_version: CLIENT_PROTOCOL_VERSION, kind: "command", request_id: "request-memory-delete", command: {
      type: "memory.delete", memory_id: "memory-fixture", input: { command_id: "command-memory-delete" },
    } },
  },
  {
    name: "command.experience_review",
    message: { protocol_version: CLIENT_PROTOCOL_VERSION, kind: "command", request_id: "request-experience-review", command: {
      type: "experience.review", case_id: "experience-fixture", input: { command_id: "command-experience-review", expected_sequence: 0, action: "validate" },
    } },
  },
  {
    name: "query.session_list",
    message: {
      protocol_version: CLIENT_PROTOCOL_VERSION,
      kind: "query",
      request_id: "request-session-list",
      query: {
        operation: "session.list",
        input: { project_id: "project-fixture", view: "roots", limit: 25 },
      },
    },
  },
  {
    name: "query.memory_list",
    message: { protocol_version: CLIENT_PROTOCOL_VERSION, kind: "query", request_id: "request-memory-list", query: { operation: "memory.list" } },
  },
  {
    name: "query.experience_list",
    message: { protocol_version: CLIENT_PROTOCOL_VERSION, kind: "query", request_id: "request-experience-list", query: { operation: "experience.list" } },
  },
  {
    name: "event.ledger",
    message: {
      protocol_version: CLIENT_PROTOCOL_VERSION,
      kind: "event",
      event: {
        stream: "ledger",
        event: {
          schema_version: SCHEMA_VERSION,
          event_id: "event-run-started",
          project_id: "project-fixture",
          run_id: "run-fixture",
          session_id: "session-fixture",
          sequence: 1,
          occurred_at: "2026-10-02T00:00:00.000Z",
          type: "run.started",
          summary: "Run started",
          artifact_refs: [],
          data: {},
        },
      },
    },
  },
  {
    name: "event.activity",
    message: {
      protocol_version: CLIENT_PROTOCOL_VERSION,
      kind: "event",
      event: {
        stream: "activity",
        event: {
          schema_version: SCHEMA_VERSION,
          activity_id: "activity-run-started",
          source_event_id: "event-run-started",
          source_event_type: "run.started",
          project_id: "project-fixture",
          run_id: "run-fixture",
          sequence: 1,
          occurred_at: "2026-10-02T00:00:00.000Z",
          kind: "run",
          status: "started",
          summary: "Run started",
        },
      },
    },
  },
  {
    name: "event.model_surface",
    message: {
      protocol_version: CLIENT_PROTOCOL_VERSION,
      kind: "event",
      event: {
        stream: "model_surface",
        event: {
          schema_version: SCHEMA_VERSION,
          surface_event_id: "surface-plan-ready",
          project_id: "project-fixture",
          run_id: "run-fixture",
          model_call_id: "model-call-fixture",
          cursor: 1,
          occurred_at: "2026-10-02T00:00:00.000Z",
          type: "public_plan_snapshot",
          status: "completed",
          text: "Inspect the selected workspace",
        },
      },
    },
  },
  {
    name: "reply.session_list",
    message: {
      protocol_version: CLIENT_PROTOCOL_VERSION,
      kind: "reply",
      request_id: "request-session-list",
      result: { resource: "sessions", value: { sessions: [] } },
    },
  },
  {
    name: "reply.memory_list",
    message: { protocol_version: CLIENT_PROTOCOL_VERSION, kind: "reply", request_id: "request-memory-list", result: { resource: "memory_control", value: { items: [], conflicts: [] } } },
  },
  {
    name: "reply.experience_list",
    message: { protocol_version: CLIENT_PROTOCOL_VERSION, kind: "reply", request_id: "request-experience-list", result: { resource: "experience_cases", value: { items: [] } } },
  },
  {
    name: "command.chat_start",
    message: { protocol_version: CLIENT_PROTOCOL_VERSION, kind: "command", request_id: "request-chat-start", command: { type: "chat.start", input: { command_id: "command-chat-start", task: "Hello" } } },
  },
  {
    name: "command.session_resume",
    message: { protocol_version: CLIENT_PROTOCOL_VERSION, kind: "command", request_id: "request-session-resume", command: { type: "session.resume", session_id: "session-fixture", input: { command_id: "command-session-resume" } } },
  },
  {
    name: "command.session_rename",
    message: { protocol_version: CLIENT_PROTOCOL_VERSION, kind: "command", request_id: "request-session-rename", command: { type: "session.rename", session_id: "session-fixture", input: { title: "Fixture conversation" } } },
  },
  {
    name: "command.session_delete",
    message: { protocol_version: CLIENT_PROTOCOL_VERSION, kind: "command", request_id: "request-session-delete", command: { type: "session.delete", session_id: "session-fixture" } },
  },
  {
    name: "command.todo_write",
    message: { protocol_version: CLIENT_PROTOCOL_VERSION, kind: "command", request_id: "request-todo-write", command: { type: "todo.write", run_id: "run-fixture", input: { command_id: "command-todo-write", input: { operation: "create", todo_id: "todo-fixture", title: "Inspect evidence" } } } },
  },
  {
    name: "command.run_input",
    message: { protocol_version: CLIENT_PROTOCOL_VERSION, kind: "command", request_id: "request-run-input", command: { type: "run.input", run_id: "run-fixture", input: { command_id: "command-run-input", input_id: "input-fixture", kind: "message", body: "Check tests first" } } },
  },
  {
    name: "command.run_approve_plan",
    message: { protocol_version: CLIENT_PROTOCOL_VERSION, kind: "command", request_id: "request-plan-approve", command: { type: "run.approve_plan", run_id: "run-fixture", input: { command_id: "command-plan-approve", plan_event_id: "event-plan" } } },
  },
  {
    name: "query.todo_list",
    message: { protocol_version: CLIENT_PROTOCOL_VERSION, kind: "query", request_id: "request-todo-list", query: { operation: "todo.list", run_id: "run-fixture" } },
  },
  {
    name: "query.artifact_get",
    message: { protocol_version: CLIENT_PROTOCOL_VERSION, kind: "query", request_id: "request-artifact-get", query: { operation: "artifact.get", run_id: "run-fixture", artifact_id: "artifact-fixture" } },
  },
  {
    name: "reply.artifact",
    message: { protocol_version: CLIENT_PROTOCOL_VERSION, kind: "reply", request_id: "request-artifact-get", result: { resource: "artifact", value: { status: "unavailable", artifact_id: "artifact-fixture", reason: "not_found" } } },
  },
  {
    name: "reply.todos",
    message: { protocol_version: CLIENT_PROTOCOL_VERSION, kind: "reply", request_id: "request-todo-list", result: { resource: "todos", value: { items: [], last_sequence: 0 } } },
  },
  {
    name: "reply.todo_mutation",
    message: { protocol_version: CLIENT_PROTOCOL_VERSION, kind: "reply", request_id: "request-todo-write", result: { resource: "todo_mutation", value: { todo: { todo_id: "todo-fixture", title: "Inspect evidence", state: "pending", depends_on: [], evidence_event_ids: [], created_by: "user" }, event_type: "todo.created", event_id: "event-todo", last_sequence: 1 } } },
  },
  {
    name: "reply.session_resume",
    message: { protocol_version: CLIENT_PROTOCOL_VERSION, kind: "reply", request_id: "request-session-resume", result: { resource: "session_resume", value: { session_id: "session-fixture", project_id: "project-fixture", run_id: "run-fixture", status: "resumed", resumed_at: "2026-10-03T00:00:00.000Z" } } },
  },
  {
    name: "reply.session_delete",
    message: { protocol_version: CLIENT_PROTOCOL_VERSION, kind: "reply", request_id: "request-session-delete", result: { resource: "session_delete", value: { session_id: "session-fixture", deleted: true } } },
  },
] as const satisfies readonly { name: string; message: ClientProtocolMessage }[];
