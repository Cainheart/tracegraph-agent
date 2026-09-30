import {
  CapabilityProfileSchema,
  WorkspaceHandleSchema,
  type RawToolResult,
} from "@tracegraph/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ActionRejectedError,
  ToolRegistry,
  executeToolDefinition,
  validateToolCall,
  type ToolDefinition,
} from "./index.js";

const workspace = WorkspaceHandleSchema.parse({
  handle_id: "workspace:tool-test",
  project_id: "project:tool-test",
  real_root: "/tmp/tracegraph-tool-test",
  workspace_kind: "managed_local",
  capabilities: CapabilityProfileSchema.parse({
    index: true,
    read: true,
    search: true,
    run_command: true,
    preview_patch: true,
    commit_patch: true,
    test: true,
  }),
  created_at: "2026-09-30T00:00:00.000Z",
});

function tool(overrides: Partial<ToolDefinition<{ value: string }, { value: string }>> = {}) {
  const definition: ToolDefinition<{ value: string }, { value: string }> = {
    name: "extension.echo",
    description: "Echo a bounded test value.",
    inputSchema: z.object({ value: z.string() }).strict(),
    outputSchema: z.object({ value: z.string() }).strict(),
    capability: "read",
    requiresApproval: false,
    timeoutMs: 1_000,
    concurrencySafe: true,
    sideEffect: "none",
    maxResultBytes: 512,
    presentation: { callLabel: "Echo", resultLabel: "Echo result" },
    async execute(input) { return input; },
    render(_input, output): RawToolResult {
      return {
        status: "success",
        code: "echoed",
        summary: "Echo complete",
        content: output.value,
      };
    },
    ...overrides,
  };
  return definition;
}

const context = { projectId: workspace.project_id, runId: "run:tool-test", workspace };

describe("@tracegraph/tool package-root contracts", () => {
  it("keeps Host-only fields out of model projection and supports an allowlist", () => {
    const registry = new ToolRegistry([tool()]);
    const projected = registry.modelSchemas();
    expect(projected).toHaveLength(1);
    expect(Object.keys(projected[0]!).sort()).toEqual(["description", "input_schema", "name"]);
    expect(registry.modelSchemas(new Set())).toEqual([]);
    expect(registry.descriptors()[0]).toMatchObject({
      name: "extension.echo",
      side_effect: "none",
      max_result_bytes: 512,
    });
  });

  it("restores the prior registration and ignores stale disposals", () => {
    const original = tool({ description: "original" });
    const replacement = tool({ description: "replacement" });
    const registry = new ToolRegistry([original]);
    const disposeOriginal = registry.register(original);
    const disposeReplacement = registry.register(replacement);

    disposeOriginal.dispose();
    expect(registry.get("extension.echo")?.description).toBe("replacement");
    disposeReplacement.dispose();
    expect(registry.get("extension.echo")?.description).toBe("original");
  });

  it("validates inputs and requires approval before returning an action", () => {
    const definition = tool({ requiresApproval: true });
    const registry = new ToolRegistry([definition]);
    const baseInput = {
      call: {
        action_id: "action:tool-test",
        tool_name: "extension.echo",
        arguments: { value: "ok" },
      },
      registry,
      projectId: workspace.project_id,
      runId: "run:tool-test",
      workspace,
      mode: "execute" as const,
      sandboxMode: "workspace-write" as const,
      now: new Date("2026-09-30T00:00:00.000Z"),
    };

    expect(() => validateToolCall({
      ...baseInput,
      call: { ...baseInput.call, arguments: { value: 1 } },
    })).toThrow(expect.objectContaining({ code: "schema_invalid" }));
    expect(() => validateToolCall(baseInput)).toThrow(expect.objectContaining({
      name: "ActionRejectedError",
      code: "approval_required",
    } satisfies Partial<ActionRejectedError>));

    expect(validateToolCall({ ...baseInput, approvalId: "approval:tool-test" }).action).toMatchObject({
      action_id: "action:tool-test",
      tool_name: "extension.echo",
      project_id: workspace.project_id,
      run_id: "run:tool-test",
    });
  });

  it("bounds rendered output and returns the timeout and cancellation contracts", async () => {
    const bounded = await executeToolDefinition(tool({
      maxResultBytes: 300,
      async execute() { return { value: "x".repeat(2_000) }; },
    }), { value: "ignored" }, context);
    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThanOrEqual(300);
    expect(bounded.facts?.output_truncated).toBe(true);

    const timedOut = await executeToolDefinition(tool({
      timeoutMs: 5,
      async execute() { return new Promise(() => undefined); },
    }), { value: "ignored" }, context);
    expect(timedOut).toMatchObject({ status: "failure", code: "timeout" });

    let executed = false;
    const cancelled = await executeToolDefinition(tool({
      async execute() { executed = true; return { value: "unexpected" }; },
    }), { value: "ignored" }, { ...context, signal: AbortSignal.abort() });
    expect(cancelled).toMatchObject({ status: "failure", code: "tool_aborted" });
    expect(executed).toBe(false);
  });
});
