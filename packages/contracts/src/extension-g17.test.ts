import { describe, expect, it } from "vitest";
import {
  BUILTIN_TOOL_NAMES,
  CurrentRunRecoveryStateV5Schema,
  EXTENSION_API_VERSION,
  EXTENSION_CONFIG_VERSION,
  EventTypeSchema,
  ExtensionCommandInvocationSchema,
  ExtensionCommandResultSchema,
  ExtensionConfigSchema,
  ExtensionErrorDataSchema,
  ExtensionReloadCommandSchema,
  ExtensionRunSnapshotSchema,
  ExtensionStatusSchema,
  PROJECTOR_VERSION,
  ToolNameSchema,
} from "./index.js";

const HASH = `sha256:${"1".repeat(64)}`;

describe("G17 extension contracts", () => {
  it("accepts bounded custom tool names while preserving the built-in catalog", () => {
    expect(ToolNameSchema.parse("acme.search:v2")).toBe("acme.search:v2");
    expect(BUILTIN_TOOL_NAMES).toHaveLength(20);
    expect(() => ToolNameSchema.parse("bad tool")).toThrow();
    expect(() => ToolNameSchema.parse(`x${"y".repeat(160)}`)).toThrow();
  });

  it("keeps config data-only, strict and uniquely named", () => {
    expect(ExtensionConfigSchema.parse({
      config_version: EXTENSION_CONFIG_VERSION,
      extensions: [{
        name: "@tracegraph/builtin-artifact-tools",
        module: "@tracegraph/builtin-artifact-tools",
      }],
    }).extensions[0]).toMatchObject({ enabled: true, required: false });
    expect(() => ExtensionConfigSchema.parse({
      config_version: EXTENSION_CONFIG_VERSION,
      extensions: [
        { name: "same", module: "first" },
        { name: "same", module: "second" },
      ],
    })).toThrow();
    expect(() => ExtensionConfigSchema.parse({
      config_version: EXTENSION_CONFIG_VERSION,
      extensions: [],
      execute: "repo-code",
    })).toThrow();
  });

  it("validates status, reload and command envelopes without executable values", () => {
    expect(ExtensionStatusSchema.parse({
      name: "acme.extension",
      api_version: EXTENSION_API_VERSION,
      state: "active",
      registration_count: 2,
      generation: 1,
      updated_at: "2026-09-19T00:00:00.000Z",
    }).state).toBe("active");
    expect(() => ExtensionStatusSchema.parse({
      name: "acme.extension",
      api_version: EXTENSION_API_VERSION,
      state: "failed",
      registration_count: 0,
      generation: 1,
      updated_at: "2026-09-19T00:00:00.000Z",
    })).toThrow();
    expect(ExtensionReloadCommandSchema.parse({
      command_id: "command:reload",
      extension_name: "acme.extension",
      expected_config_digest: HASH,
    }).extension_name).toBe("acme.extension");
    const invocation = ExtensionCommandInvocationSchema.parse({
      command_id: "command:invoke",
      name: "acme.inspect",
      args: ["--safe"],
    });
    expect(ExtensionCommandResultSchema.parse({
      command_id: invocation.command_id,
      name: invocation.name,
      status: "success",
      summary: "Inspected",
    }).status).toBe("success");
  });

  it("requires every durable extension error to point to a non-error source Event", () => {
    expect(ExtensionErrorDataSchema.parse({
      extension_name: "acme.extension",
      api_version: EXTENSION_API_VERSION,
      phase: "event_hook",
      code: "hook_failed",
      message: "Hook failed",
      source_event_id: "event:source",
      source_event_type: "run.started",
    }).source_event_type).toBe("run.started");
    expect(() => ExtensionErrorDataSchema.parse({
      extension_name: "acme.extension",
      api_version: EXTENSION_API_VERSION,
      phase: "event_hook",
      code: "hook_failed",
      message: "Hook failed",
    })).toThrow();
    expect(() => ExtensionErrorDataSchema.parse({
      extension_name: "acme.extension",
      api_version: EXTENSION_API_VERSION,
      phase: "event_hook",
      code: "hook_failed",
      message: "Hook failed",
      source_event_id: "event:error",
      source_event_type: "extension.error",
    })).toThrow();
  });

  it("freezes the extension surface in recovery v5", () => {
    const extensions = ExtensionRunSnapshotSchema.parse({
      api_version: EXTENSION_API_VERSION,
      config_digest: HASH,
      generation: 2,
      active_extensions: ["@tracegraph/builtin-artifact-tools"],
      active_tool_names: ["read_artifact"],
    });
    expect(CurrentRunRecoveryStateV5Schema.parse({
      version: 5,
      kind: "run_recovery_state",
      task: "Recover safely",
      conversation_history: [],
      mode: "execute",
      reasoning_effort: "default",
      effective_policy: {
        policy_version: 1,
        preset: {
          preset_version: 1,
          key: "read-only",
          label: "Read only",
          sandbox_mode: "read-only",
          approval_policy: "never",
          allowed_tools: ["read_artifact"],
          path_scope: ["**"],
        },
        host_rules: [],
        project_rules: [],
        policy_digest: HASH,
      },
      orchestration: { depth: 0, limits: { max_parallel_subagents: 2, max_depth: 1 } },
      extensions,
    }).extensions.config_digest).toBe(HASH);
    expect(() => ExtensionRunSnapshotSchema.parse({
      ...extensions,
      active_tool_names: ["read_artifact", "read_artifact"],
    })).toThrow();
  });

  it("preserves extension.error while later append-only facts advance the projector", () => {
    expect(EventTypeSchema.options).toHaveLength(102);
    expect(EventTypeSchema.options).toContain("extension.error");
    expect(PROJECTOR_VERSION).toBe("tracegraph.projector.v9");
  });
});
