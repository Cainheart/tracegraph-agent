import { describe, expect, it } from "vitest";
import { classifyPublicChatFailure, projectPublicChat, projectSessionPublicChat } from "./public-chat.js";
import type { SessionEvent } from "./event.js";

describe("Public chat projection", () => {
  it("orders by admission, pairs identities, excludes internal facts and never settles a child from Run completion", () => {
    const blocks = projectPublicChat([
      { event_id: "init", sequence: 1, type: "run.created" },
      { event_id: "plan", sequence: 2, type: "model.decision", public_plan: "Check the files" },
      { event_id: "start", sequence: 3, type: "tool.started", operation_id: "read", tool_name: "read_file", target: "a.ts" },
      { event_id: "plan2", sequence: 4, type: "model.decision", public_plan: "Check the result" },
      { event_id: "done", sequence: 5, type: "tool.completed", operation_id: "read", tool_name: "read_file" },
      { event_id: "unknown", sequence: 6, type: "tool.unknown", operation_id: "write", tool_name: "commit_patch" },
      { event_id: "run", sequence: 7, type: "run.completed" },
    ]);
    expect(blocks.map(block => block.kind)).toEqual(["statement", "operations", "statement", "operations"]);
    expect(blocks[1]).toMatchObject({ sequence: 3, operations: [{ target: "a.ts", status: "completed", source_event_ids: ["start", "done"] }] });
    expect(blocks[3]).toMatchObject({ operations: [{ status: "unknown" }] });
  });
  it("never promotes reasoning, tool bodies or generic summary at the canonical boundary", () => {
    const event = { event_id: "event", sequence: 1, type: "model.decision", summary: "PRIVATE_SUMMARY", data: { reasoning_content: "PRIVATE_REASONING", decision: { public_reason: "NOT_A_PUBLIC_PLAN" }, output: "PRIVATE_OUTPUT" } } as unknown as SessionEvent;
    expect(projectSessionPublicChat([event])).toEqual([]);
    expect(projectSessionPublicChat([{ ...event, data: { ...event.data, public_plan: "Explicit public statement" } }])).toEqual([{ kind: "statement", id: "event", sequence: 1, text: "Explicit public statement", source_event_ids: ["event"] }]);
  });
  it("projects only the recorded outcome of a successful terminal event as the public answer", () => {
    const base = { event_id: "event", sequence: 9, type: "run.completed", summary: "PRIVATE_SUMMARY", data: { outcome: "The exact completed answer", reasoning_content: "PRIVATE_REASONING" } } as unknown as SessionEvent;
    expect(projectSessionPublicChat([base])).toEqual([{ kind: "answer", id: "event", sequence: 9, text: "The exact completed answer", source_event_ids: ["event"] }]);
    expect(projectSessionPublicChat([{ ...base, type: "run.failed" }])).toEqual([]);
    expect(projectSessionPublicChat([{ ...base, data: { outcome: "  " } }])).toEqual([]);
    expect(projectSessionPublicChat([{ ...base, data: { reasoning_content: "PRIVATE_REASONING" } }])).toEqual([]);
  });
  it("does not pair unidentified calls and coalesces adjacent operations", () => {
    const facts = [{ event_id: "a", sequence: 1, type: "tool.started" }, { event_id: "b", sequence: 2, type: "tool.completed" }];
    expect(projectPublicChat([...facts, facts[0]!])).toMatchObject([{ kind: "operations", operations: [{ id: "a", status: "running" }, { id: "b", status: "completed" }] }]);
  });
  it.each([["UND_ERR_CONNECT_TIMEOUT", "connect_timeout"], ["model_http_401", "authentication"], ["model_http_404", "model"], ["UND_ERR_HEADERS_TIMEOUT", "response_timeout"], ["ENOTFOUND", "address"], ["ECONNRESET", "connection"]])("classifies %s without rewriting facts", (message, category) => expect(classifyPublicChatFailure(message!)).toBe(category));
});
