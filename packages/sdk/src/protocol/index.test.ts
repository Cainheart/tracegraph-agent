import { describe, expect, it } from "vitest";
import {
  ClientCommandMessageSchema,
  ClientCancelMessageSchema,
  ClientCommandSchema,
  ClientEventMessageSchema,
  ClientProtocolMessageSchema,
  ClientQueryMessageSchema,
} from "./index.js";
import { CLIENT_PROTOCOL_CONFORMANCE_FIXTURES } from "./fixtures.js";
import { CLIENT_PROTOCOL_VERSION } from "./constants.js";

describe("internal client protocol v2", () => {
  it("parses the shared command, query, durable event, transient events, and reply fixtures", () => {
    expect(CLIENT_PROTOCOL_CONFORMANCE_FIXTURES).toHaveLength(30);
    for (const fixture of CLIENT_PROTOCOL_CONFORMANCE_FIXTURES) {
      expect(ClientProtocolMessageSchema.safeParse(fixture.message), fixture.name).toMatchObject({ success: true });
    }
  });

  it("strips additive envelope fields while rejecting unknown message and query discriminators", () => {
    const command = CLIENT_PROTOCOL_CONFORMANCE_FIXTURES[0]!.message;
    const parsed = ClientCommandMessageSchema.parse({ ...command, optional_future_field: "ignored" });
    expect("optional_future_field" in parsed).toBe(false);
    expect(ClientProtocolMessageSchema.safeParse({ ...command, kind: "future_message" }).success).toBe(false);
    expect(ClientQueryMessageSchema.safeParse({
      protocol_version: CLIENT_PROTOCOL_VERSION,
      kind: "query",
      request_id: "request-unknown-query",
      query: { operation: "future.read" },
    }).success).toBe(false);
    expect(ClientProtocolMessageSchema.safeParse({
      protocol_version: CLIENT_PROTOCOL_VERSION,
      kind: "error",
      request_id: "request-unknown-error",
      error: { code: "future_error", message: "unsupported", retryable: false },
    }).success).toBe(false);
  });

  it("keeps durable and transient event streams distinct", () => {
    const ledger = CLIENT_PROTOCOL_CONFORMANCE_FIXTURES[10]!.message;
    const activity = CLIENT_PROTOCOL_CONFORMANCE_FIXTURES[11]!.message;
    const modelSurface = CLIENT_PROTOCOL_CONFORMANCE_FIXTURES[12]!.message;
    expect(ClientEventMessageSchema.parse(ledger).event.stream).toBe("ledger");
    expect(ClientEventMessageSchema.parse(activity).event.stream).toBe("activity");
    expect(ClientEventMessageSchema.parse(modelSurface).event.stream).toBe("model_surface");
    expect(ClientEventMessageSchema.safeParse({
      ...ledger,
      event: { stream: "ledger", event: (activity as { event: unknown }).event },
    }).success).toBe(false);
  });

  it("accepts only a request-scoped transport cancel envelope", () => {
    const cancel = {
      protocol_version: CLIENT_PROTOCOL_VERSION,
      kind: "cancel",
      request_id: "request-cancel-target",
    };
    expect(ClientCancelMessageSchema.parse(cancel)).toEqual(cancel);
    expect(ClientProtocolMessageSchema.parse(cancel)).toEqual(cancel);
    const withIgnoredField = ClientCancelMessageSchema.parse({ ...cancel, command: { type: "stop" } });
    expect(withIgnoredField.kind).toBe("cancel");
    expect("command" in withIgnoredField).toBe(false);
  });

  it("rejects client authority fields, invalid lifecycle actions, and extra command fields", () => {
    expect(ClientCommandSchema.safeParse({
      type: "memory.create",
      input: { command_id: "command:memory", kind: "fact", claim: "x", owner_id: "owner:renderer" },
    }).success).toBe(false);
    expect(ClientCommandSchema.safeParse({
      type: "experience.review",
      case_id: "experience:one",
      input: { command_id: "command:experience", expected_sequence: 0, action: "delete" },
    }).success).toBe(false);
    expect(ClientCommandSchema.safeParse({
      type: "memory.delete",
      memory_id: "memory:one",
      input: { command_id: "command:delete" },
      owner_id: "owner:renderer",
    }).success).toBe(false);
    expect(ClientCommandSchema.safeParse({ type: "run.input", run_id: "run:one", input: { command_id: "command:input", input_id: "input:one", kind: "message", body: "Inspect", actor: "parent_agent" } }).success).toBe(false);
    expect(ClientCommandSchema.safeParse({ type: "todo.write", run_id: "run:one", input: { command_id: "command:todo", project_id: "project:other", input: { operation: "create", todo_id: "todo:one", title: "Inspect" } } }).success).toBe(false);
    expect(ClientCommandSchema.safeParse({ type: "chat.start", input: { command_id: "command:chat", task: "Hello", workspace: {} } }).success).toBe(false);
    expect(ClientQueryMessageSchema.safeParse({ protocol_version: CLIENT_PROTOCOL_VERSION, kind: "query", request_id: "request:artifact", query: { operation: "artifact.get", run_id: "run:one", artifact_id: "artifact:one", path: "/tmp" } }).success).toBe(false);
  });
});
