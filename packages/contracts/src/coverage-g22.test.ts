import { describe, expect, it } from "vitest";
import {
  ActionWalPrepareSchema,
  ActionWalRecordSchema,
  ActionWalTargetSchema,
  RecoveryAttemptFinishSchema,
  RecoveryAttemptRecordSchema,
} from "./action-wal.js";
import {
  GraphEdgeDeltaSchema,
  GraphNodeDeltaSchema,
  GraphSnapshotSchema,
} from "./graph.js";
import {
  BoundedJsonSchemaSchema,
  ToolBatchCompletedDataSchema,
  ToolBatchStartedDataSchema,
  ToolDescriptorSchema,
} from "./tool.js";

const hashA = `sha256:${"a".repeat(64)}`;
const hashB = `sha256:${"b".repeat(64)}`;
const timestamp = "2026-09-19T00:00:00.000Z";

function target(overrides: Record<string, unknown> = {}) {
  return {
    target_path: "src/a.ts",
    existed: true,
    before_hash: hashA,
    after_hash: hashA,
    backup_ref: "backup:one",
    ...overrides,
  };
}

function walIdentity(overrides: Record<string, unknown> = {}) {
  return {
    project_id: "project:g22",
    run_id: "run:g22",
    action_id: "action:g22",
    workspace_handle_id: "workspace:g22",
    workspace_root_hash: hashA,
    workspace_kind: "managed_local",
    patch_hash: hashA,
    targets: [target()],
    ...overrides,
  };
}

function walRecord(overrides: Record<string, unknown> = {}) {
  return {
    wal_version: 1,
    wal_id: "wal:g22",
    sequence: 1,
    ...walIdentity(),
    phase: "prepare",
    recorded_at: timestamp,
    record_hash: hashA,
    ...overrides,
  };
}

function recoveryRecord(overrides: Record<string, unknown> = {}) {
  return {
    recovery_version: 1,
    record_id: "recovery-record:g22",
    recovery_id: "recovery:g22",
    sequence: 1,
    project_id: "project:g22",
    run_id: "run:g22",
    action_id: "action:g22",
    recipe_id: "restore_from_backup",
    attempt: 1,
    automatic: true,
    state: "started",
    started_at: timestamp,
    recorded_at: timestamp,
    record_hash: hashA,
    ...overrides,
  };
}

function nestedArraySchema(depth: number): Record<string, unknown> {
  let schema: Record<string, unknown> = { type: "string" };
  for (let index = 0; index < depth; index += 1) schema = { type: "array", items: schema };
  return schema;
}

function broadSchema(depth: number): Record<string, unknown> {
  if (depth === 0) return { type: "string" };
  return { type: "object", anyOf: Array.from({ length: 8 }, () => broadSchema(depth - 1)) };
}

function invalidSchemaValues(): unknown[] {
  const cyclic: Record<string, unknown> = { type: "object" };
  cyclic.default = cyclic;
  const nonPlain = Object.create({ inherited: true }) as Record<string, unknown>;
  nonPlain.type = "object";

  return [
    undefined,
    cyclic,
    { type: "object", description: "x".repeat(66_000) },
    broadSchema(3),
    nestedArraySchema(10),
    nonPlain,
    { type: "object", unsupported: true },
    { type: "unsupported" },
    { type: "object", title: 42 },
    { type: "string", pattern: "[" },
    { type: "string", minLength: -1 },
    { type: "number", minimum: Number.POSITIVE_INFINITY },
    { type: "number", multipleOf: 0 },
    { type: "array", uniqueItems: "yes" },
    { type: "string", properties: {} },
    { type: "object", properties: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`p${index}`, { type: "string" }])) },
    { type: "object", properties: { " ": { type: "string" } } },
    { type: "string", required: ["value"] },
    { type: "object", required: [""] },
    { type: "object", required: ["value", "value"] },
    { type: "object", properties: {}, required: ["missing"] },
    { type: "string", additionalProperties: false },
    { type: "object", additionalProperties: [] },
    { type: "object", items: { type: "string" } },
    { type: "object", anyOf: [] },
    { type: "object", enum: [] },
    { type: "object", enum: [Number.NaN] },
    { type: "object", const: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`p${index}`, true])) },
    { type: "object", default: nestedArraySchema(10) },
  ];
}

describe("G22 contracts coverage gate hardening", () => {
  it("exercises every bounded JSON Schema rejection class", () => {
    for (const schema of invalidSchemaValues()) {
      expect(BoundedJsonSchemaSchema.safeParse(schema).success).toBe(false);
    }

    expect(ToolDescriptorSchema.safeParse({
      name: "read_file",
      description: "must use object schemas",
      input_schema: { type: "string" },
      output_schema: { type: "object" },
      timeout_ms: 100,
      concurrency_safe: true,
      side_effect: "read",
      max_result_bytes: 1_024,
    }).success).toBe(false);
  });

  it("rejects every inconsistent Tool batch accounting shape", () => {
    expect(ToolBatchStartedDataSchema.safeParse({
      batch_id: "batch:g22",
      requested_count: 1,
      max_concurrency: 1,
      effective_concurrency: 2,
      action_ids: ["action:one", "action:two"],
      parallel_action_ids: ["action:one", "action:one", "action:unknown"],
      serialized_actions: [
        { action_id: "action:one", reason: "duplicate" },
        { action_id: "action:one", reason: "duplicate" },
      ],
    }).success).toBe(false);
    expect(ToolBatchStartedDataSchema.safeParse({
      batch_id: "batch:duplicate-actions",
      requested_count: 2,
      max_concurrency: 1,
      effective_concurrency: 1,
      action_ids: ["action:one", "action:one"],
      parallel_action_ids: ["action:one"],
      serialized_actions: [],
    }).success).toBe(false);

    const result = (overrides: Record<string, unknown>) => ({
      batch_id: "batch:completed-g22",
      requested_count: 2,
      completed_count: 1,
      failed_count: 0,
      max_concurrency: 1,
      effective_concurrency: 1,
      total_duration_ms: 10,
      action_ids: ["action:one", "action:two"],
      results: [{ action_id: "action:one", status: "failure", duration_ms: 10, code: "failed" }],
      ...overrides,
    });
    expect(ToolBatchCompletedDataSchema.safeParse(result({
      requested_count: 1,
      completed_count: 2,
      failed_count: 0,
      effective_concurrency: 3,
      results: [{
        action_id: "action:two",
        status: "success",
        duration_ms: 10,
        code: "impossible",
        failure_code: "internal",
      }],
    })).success).toBe(false);
    expect(ToolBatchCompletedDataSchema.safeParse(result({ effective_concurrency: 0 })).success).toBe(false);
  });

  it("rejects every contradictory Action WAL and recovery state", () => {
    expect(ActionWalTargetSchema.safeParse(target({ existed: false })).success).toBe(false);
    expect(ActionWalPrepareSchema.safeParse(walIdentity({
      workspace_kind: "readonly_local",
      patch_hash: hashB,
      targets: [target(), target()],
    })).success).toBe(false);
    expect(ActionWalRecordSchema.safeParse(walRecord({
      workspace_kind: "readonly_local",
      patch_hash: hashB,
      phase: "committed",
    })).success).toBe(false);
    expect(ActionWalRecordSchema.safeParse(walRecord({ phase: "verified" })).success).toBe(false);
    expect(ActionWalRecordSchema.safeParse(walRecord({ phase: "aborted" })).success).toBe(false);

    expect(RecoveryAttemptRecordSchema.safeParse(recoveryRecord({
      state: "started",
      finished_at: timestamp,
      last_failure: "not terminal",
      escalation_reason: "not escalated",
    })).success).toBe(false);
    expect(RecoveryAttemptRecordSchema.safeParse(recoveryRecord({ state: "failed" })).success).toBe(false);
    expect(RecoveryAttemptRecordSchema.safeParse(recoveryRecord({
      state: "failed",
      finished_at: "2026-09-18T00:00:00.000Z",
      last_failure: "failed",
    })).success).toBe(false);
    expect(RecoveryAttemptRecordSchema.safeParse(recoveryRecord({
      state: "escalated",
      finished_at: timestamp,
    })).success).toBe(false);

    for (const value of [
      { recovery_id: "recovery:g22", state: "failed" },
      { recovery_id: "recovery:g22", state: "escalated" },
      { recovery_id: "recovery:g22", state: "succeeded", last_failure: "impossible" },
      { recovery_id: "recovery:g22", state: "failed", last_failure: "failed", escalation_reason: "impossible" },
    ]) {
      expect(RecoveryAttemptFinishSchema.safeParse(value).success).toBe(false);
    }
  });

  it("rejects disconnected graphs and contradictory deltas", () => {
    const node = { id: "node:one", kind: "file", label: "one", file_path: "src/one.ts" };
    const edge = {
      id: "edge:one",
      kind: "static_import",
      source_node_id: "node:missing-source",
      target_node_id: "node:missing-target",
      file_path: "src/one.ts",
      confidence: "high",
      resolution: "resolved",
    };
    expect(GraphSnapshotSchema.safeParse({
      snapshot_id: "snapshot:g22",
      project_id: "project:g22",
      workspace_hash: hashA,
      created_at: timestamp,
      nodes: [node, node],
      edges: [edge, edge],
    }).success).toBe(false);

    const otherNode = { ...node, id: "node:other" };
    for (const delta of [
      { change: "added", before: node },
      { change: "removed", after: node },
      { change: "changed" },
      { change: "unknown" },
      { change: "partial", before: node, after: otherNode },
    ]) {
      expect(GraphNodeDeltaSchema.safeParse(delta).success).toBe(false);
    }
    expect(GraphEdgeDeltaSchema.safeParse({ change: "added" }).success).toBe(false);
  });
});
