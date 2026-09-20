import { describe, expect, it } from "vitest";
import {
  BoundedJsonSchemaSchema,
  DecisionSchema,
  EventTypeSchema,
  HOST_ONLY_TOOL_DESCRIPTOR_KEYS,
  MAX_TOOL_CALLS_PER_DECISION,
  MODEL_TOOL_SCHEMA_KEYS,
  ModelToolSchema,
  ToolBatchCompletedDataSchema,
  ToolBatchStartedDataSchema,
  ToolDescriptorSchema,
  ToolFailureCodeSchema,
  ToolNameSchema,
  toModelToolSchema,
  type ToolDescriptor,
} from "./index.js";

const inputSchema = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1, maxLength: 1_000 },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  properties: {
    content: { type: "string", maxLength: 64_000 },
    truncated: { type: "boolean" },
  },
  required: ["content", "truncated"],
  additionalProperties: false,
} as const;

function descriptor(): ToolDescriptor {
  return ToolDescriptorSchema.parse({
    name: "read_file",
    description: "Read a bounded workspace file",
    input_schema: inputSchema,
    output_schema: outputSchema,
    timeout_ms: 5_000,
    concurrency_safe: true,
    side_effect: "read",
    max_result_bytes: 64 * 1024,
  });
}

function call(actionId: string, toolName: "read_file" | "search" = "read_file") {
  return {
    action_id: actionId,
    tool_name: toolName,
    arguments: toolName === "read_file" ? { path: "README.md" } : { pattern: "Runtime" },
  } as const;
}

describe("G05 Tool contracts", () => {
  it("projects only the explicit model-visible descriptor whitelist", () => {
    const hostDescriptor = {
      ...descriptor(),
      execute: async () => ({ status: "success" }),
      render: () => "host-rendered",
    };
    const modelSchema = toModelToolSchema(hostDescriptor);

    expect(Object.keys(modelSchema)).toEqual(MODEL_TOOL_SCHEMA_KEYS);
    for (const key of [...HOST_ONLY_TOOL_DESCRIPTOR_KEYS, "execute", "render"] as const) {
      expect(modelSchema).not.toHaveProperty(key);
    }
    expect(() => ModelToolSchema.parse({ ...modelSchema, output_schema: outputSchema })).toThrow();
    expect(() => ToolDescriptorSchema.parse(hostDescriptor)).toThrow();
  });

  it("keeps JSON Schema local, strict, and bounded", () => {
    expect(BoundedJsonSchemaSchema.parse(inputSchema)).toEqual(inputSchema);
    expect(() => BoundedJsonSchemaSchema.parse({
      ...inputSchema,
      $ref: "https://example.invalid/schema.json",
    })).toThrow(/Unsupported JSON Schema keyword/u);
    expect(() => BoundedJsonSchemaSchema.parse({
      type: "object",
      properties: { unsafe: { type: "string", provider_extension: true } },
    })).toThrow(/Unsupported JSON Schema keyword/u);
    expect(() => ToolDescriptorSchema.parse({
      ...descriptor(),
      timeout_ms: 0,
    })).toThrow();
    expect(() => ToolDescriptorSchema.parse({
      ...descriptor(),
      max_result_bytes: 9 * 1024 * 1024,
    })).toThrow();
  });

  it("retains the legacy single-call Decision shape", () => {
    const decision = DecisionSchema.parse({
      decision_id: "decision:legacy",
      kind: "tool_call",
      public_reason: "Inspect the file",
      evidence_refs: [],
      risk: "none",
      tool_call: call("action:legacy"),
    });

    expect(decision.tool_call?.action_id).toBe("action:legacy");
    expect(decision.tool_calls).toBeUndefined();
  });

  it("accepts a bounded batch with unique action ids", () => {
    const decision = DecisionSchema.parse({
      decision_id: "decision:batch",
      kind: "tool_call",
      public_reason: "Inspect independent evidence",
      evidence_refs: [],
      risk: "none",
      tool_calls: [call("action:one"), call("action:two", "search")],
    });

    expect(decision.tool_calls).toHaveLength(2);
  });

  it("enforces Decision call/finish exclusivity and batch invariants", () => {
    const base = {
      decision_id: "decision:invalid",
      kind: "tool_call",
      public_reason: "Invalid envelope",
      evidence_refs: [],
      risk: "none",
    } as const;

    expect(() => DecisionSchema.parse(base)).toThrow(/exactly one/u);
    expect(() => DecisionSchema.parse({
      ...base,
      tool_call: call("action:one"),
      tool_calls: [call("action:two")],
    })).toThrow(/exactly one/u);
    expect(() => DecisionSchema.parse({
      ...base,
      tool_calls: [call("action:duplicate"), call("action:duplicate", "search")],
    })).toThrow(/unique/u);
    expect(() => DecisionSchema.parse({
      ...base,
      tool_calls: Array.from({ length: MAX_TOOL_CALLS_PER_DECISION + 1 }, (_, index) => call(`action:${index}`)),
    })).toThrow();
    expect(() => DecisionSchema.parse({
      ...base,
      kind: "finish",
      final_answer: "Done",
      tool_call: call("action:smuggled"),
    })).toThrow(/finish decisions cannot include/u);
    expect(() => DecisionSchema.parse({
      ...base,
      final_answer: "Tool decisions cannot finish at the same time",
      tool_call: call("action:one"),
    })).toThrow(/cannot include final_answer/u);
  });

  it("contracts batch audit payload counts, order, and standardized failures", () => {
    expect(ToolBatchStartedDataSchema.parse({
      batch_id: "batch:one",
      requested_count: 2,
      max_concurrency: 4,
      effective_concurrency: 1,
      action_ids: ["action:read", "action:write"],
      parallel_action_ids: ["action:read"],
      serialized_actions: [{ action_id: "action:write", reason: "write side effects are serialized" }],
    }).requested_count).toBe(2);

    expect(() => ToolBatchStartedDataSchema.parse({
      batch_id: "batch:incomplete-classification",
      requested_count: 2,
      max_concurrency: 4,
      effective_concurrency: 1,
      action_ids: ["action:read", "action:omitted"],
      parallel_action_ids: ["action:read"],
      serialized_actions: [],
    })).toThrow(/classify every batch action/u);

    expect(ToolBatchCompletedDataSchema.parse({
      batch_id: "batch:one",
      requested_count: 2,
      completed_count: 2,
      failed_count: 1,
      max_concurrency: 4,
      effective_concurrency: 2,
      total_duration_ms: 40,
      action_ids: ["action:read", "action:write"],
      results: [{
        action_id: "action:read",
        status: "success",
        duration_ms: 30,
        code: "file_read",
      }, {
        action_id: "action:write",
        status: "failure",
        duration_ms: 10,
        code: "deadline_exceeded",
        failure_code: "timeout",
      }],
    }).failed_count).toBe(1);

    expect(() => ToolBatchCompletedDataSchema.parse({
      batch_id: "batch:wrong-order",
      requested_count: 2,
      completed_count: 2,
      failed_count: 0,
      max_concurrency: 4,
      effective_concurrency: 2,
      total_duration_ms: 1,
      action_ids: ["action:one", "action:two"],
      results: [
        { action_id: "action:two", status: "success", duration_ms: 1, code: "ok" },
        { action_id: "action:one", status: "success", duration_ms: 1, code: "ok" },
      ],
    })).toThrow(/preserve action_ids order/u);

    expect(ToolBatchCompletedDataSchema.parse({
      batch_id: "batch:stopped-before-first-call",
      requested_count: 2,
      completed_count: 0,
      failed_count: 0,
      max_concurrency: 4,
      effective_concurrency: 0,
      total_duration_ms: 1,
      action_ids: ["action:one", "action:two"],
      results: [],
    })).toMatchObject({ completed_count: 0, effective_concurrency: 0, results: [] });

    expect(() => ToolBatchCompletedDataSchema.parse({
      batch_id: "batch:impossible-zero-concurrency",
      requested_count: 1,
      completed_count: 1,
      failed_count: 0,
      max_concurrency: 4,
      effective_concurrency: 0,
      total_duration_ms: 1,
      action_ids: ["action:one"],
      results: [{ action_id: "action:one", status: "success", duration_ms: 1, code: "ok" }],
    })).toThrow(/must observe positive concurrency/u);
  });

  it("publishes the new Tool, Event, and failure-code enums", () => {
    expect(ToolNameSchema.parse("list_artifacts")).toBe("list_artifacts");
    expect(EventTypeSchema.parse("tool.batch_started")).toBe("tool.batch_started");
    expect(EventTypeSchema.parse("tool.batch_completed")).toBe("tool.batch_completed");
    expect(ToolFailureCodeSchema.options).toEqual([
      "invalid_arguments",
      "timeout",
      "output_contract_violation",
      "denied",
      "internal",
    ]);
  });
});
