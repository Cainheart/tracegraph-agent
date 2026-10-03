import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISPOSABLE_FIXTURE_CAPABILITIES,
  RawToolResultSchema,
  WorkspaceHandleSchema,
  type RawToolResult,
  type ExternalActionReconciliationRequest,
  type WorkspaceHandle,
} from "@tracegraph/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { sha256 } from "../../kernel/crypto.js";
import { createEffectivePermissionPolicy, CORE_BUILTIN_PERMISSION_PRESETS } from "../tools/policy-engine.js";
import { createDefaultToolRegistry } from "../tools/index.js";
import type { ModelAdapter } from "../../kernel/types.js";
import { createAgentRuntime, type AgentRuntime, type ExternalActionReconciler } from "./runtime.js";

const roots: string[] = [];
const runtimes: AgentRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdownBackgroundWork?.()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("external Action reconciliation contract", { timeout: 30_000 }, () => {
  it.each(["confirmed", "failed", "unknown", "diverged"] as const)(
    "records the provider's %s outcome without re-dispatching the Tool",
    async (outcome) => {
      const harness = await createHarness(`outcome-${outcome}`);
      let executionCount = 0;
      let operationId: string | undefined;
      let request: ExternalActionReconciliationRequest | undefined;
      const registry = createDefaultToolRegistry();
      registry.register({
        name: "acme.remote_write",
        description: "Test-only remote side effect",
        inputSchema: z.object({ value: z.string() }),
        outputSchema: RawToolResultSchema,
        capability: "commit_patch",
        requiresApproval: false,
        timeoutMs: 1_000,
        concurrencySafe: false,
        sideEffect: "write",
        maxResultBytes: 4_096,
        presentation: { callLabel: "Remote write", resultLabel: "Remote write result" },
        async execute(_input, context) {
          executionCount += 1;
          operationId = context.operationId;
          return {
            status: "unknown" as const,
            code: "transport_timeout",
            summary: "Remote response was lost after dispatch",
          };
        },
        render(_input, output) {
          return output;
        },
      });
      const reconciler: ExternalActionReconciler = {
        providerId: "acme.controlled-provider",
        supportedToolNames: new Set(["acme.remote_write"]),
        async reconcile(input) {
          request = input;
          return {
            operation_id: input.operation_id,
            outcome,
            reason_code: outcome === "unknown" ? "provider_unavailable" : `test_${outcome}`,
            summary: `Controlled provider classified ${outcome}`,
            ...(outcome === "unknown" ? {} : { evidence_digest: sha256(outcome) }),
          };
        },
      };
      const model = externalActionModel();
      const runtime = await createTrackedRuntime({
        dataDir: harness.dataDir,
        model,
        toolRegistry: registry,
        externalActionReconciler: reconciler,
        permissionPolicy: createEffectivePermissionPolicy({
          preset: {
            ...CORE_BUILTIN_PERMISSION_PRESETS["full-write"],
            allowed_tools: [...CORE_BUILTIN_PERMISSION_PRESETS["full-write"].allowed_tools, "acme.remote_write"],
          },
        }),
      });

      const started = await runtime.startRun({
        command_id: `command:start:${outcome}`,
        project_id: harness.workspace.project_id,
        task: "Run one controlled external action.",
        mode: "execute",
        workspace: harness.workspace,
      });
      const failed = await waitForStatus(runtime, started.run_id, "failed");
      const initialToolStart = failed.timeline.find((event) => event.type === "tool.started");
      expect(initialToolStart).toBeDefined();
      expect(operationId).toBe(initialToolStart?.operation_id);
      expect(operationId).toBeDefined();

      const result = await runtime.reconcileActions({
        sessionId: failed.session_id!,
        runId: failed.run_id,
        projectId: failed.project_id,
        workspace: harness.workspace,
      });
      expect(result.externalOutcomes).toEqual([{ actionId: initialToolStart!.action_id, outcome }]);
      expect(request).toMatchObject({
        project_id: failed.project_id,
        run_id: failed.run_id,
        action_id: initialToolStart!.action_id,
        operation_id: operationId,
        tool_name: "acme.remote_write",
        trigger: "unknown_result",
      });
      expect(executionCount).toBe(1);

      const after = await runtime.getProjection(failed.run_id);
      if (outcome === "diverged") {
        expect(after.status).toBe("needs_manual_review");
        expect(after.timeline).toContainEqual(expect.objectContaining({
          type: "action.diverged",
          action_id: initialToolStart!.action_id,
          operation_id: operationId,
          data: expect.objectContaining({ outcome: "diverged", provider_id: reconciler.providerId }),
        }));
      } else {
        expect(after.timeline).toContainEqual(expect.objectContaining({
          type: "action.reconciled",
          action_id: initialToolStart!.action_id,
          operation_id: operationId,
          data: expect.objectContaining({ outcome, provider_id: reconciler.providerId }),
        }));
      }
    },
  );

  it("keeps unknown retryable as a reconciliation query, not a Tool replay", async () => {
    const harness = await createHarness("unknown-retry");
    let executionCount = 0;
    let providerOutcome: "unknown" | "confirmed" = "unknown";
    const registry = externalToolRegistry(() => {
      executionCount += 1;
      return {
        status: "unknown",
        code: "transport_timeout",
        summary: "Remote response was lost after dispatch",
      };
    });
    const reconciler: ExternalActionReconciler = {
      providerId: "acme.retry-provider",
      supportedToolNames: new Set(["acme.remote_write"]),
      async reconcile(request) {
        return {
          operation_id: request.operation_id,
          outcome: providerOutcome,
          reason_code: providerOutcome === "unknown" ? "provider_unavailable" : "provider_state",
          summary: `Controlled provider classified ${providerOutcome}`,
          ...(providerOutcome === "unknown" ? {} : { evidence_digest: sha256("confirmed") }),
        };
      },
    };
    const runtimeOptions = {
      dataDir: harness.dataDir,
      model: externalActionModel(),
      toolRegistry: registry,
      externalActionReconciler: reconciler,
      permissionPolicy: fullWriteWithExternalTool(),
    };
    const runtime = await createTrackedRuntime(runtimeOptions);
    const failed = await waitForStatus(
      runtime,
      (await runtime.startRun(startInput(harness.workspace, "unknown-retry"))).run_id,
      "failed",
    );
    expect(failed.failure_code).toBe("unknown_side_effect");
    const locator = {
      sessionId: failed.session_id!,
      runId: failed.run_id,
      projectId: failed.project_id,
      workspace: harness.workspace,
    };

    await runtime.shutdownBackgroundWork?.();
    const recoveredRuntime = await createTrackedRuntime({
      ...runtimeOptions,
      model: externalActionModel(),
    });
    expect((await recoveredRuntime.reconcileActions(locator).then((value) => value.externalOutcomes))?.[0]?.outcome)
      .toBe("unknown");
    providerOutcome = "confirmed";
    expect((await recoveredRuntime.reconcileActions(locator).then((value) => value.externalOutcomes))?.[0]?.outcome)
      .toBe("confirmed");
    expect(executionCount).toBe(1);
    expect((await recoveredRuntime.getProjection(failed.run_id)).timeline
      .filter((event) => event.type === "action.reconciled")
      .map((event) => event.data.outcome)).toEqual(["unknown", "confirmed"]);
  });

  it("converts a provider query timeout to unknown", async () => {
    const harness = await createHarness("provider-timeout");
    let operationId: string | undefined;
    let reconcileCalls = 0;
    let reconciliationTrigger: string | undefined;
    const registry = externalToolRegistry((_input, context) => {
      operationId = context.operationId;
      return {
        status: "failure",
        code: "timeout",
        summary: "External Tool timed out after dispatch",
      };
    });
    const runtime = await createTrackedRuntime({
      dataDir: harness.dataDir,
      model: externalActionModel(),
      toolRegistry: registry,
      externalActionReconciliationTimeoutMs: 10,
      externalActionReconciler: {
        providerId: "acme.slow-provider",
        supportedToolNames: new Set(["acme.remote_write"]),
        async reconcile(request) {
          reconcileCalls += 1;
          reconciliationTrigger = request.trigger;
          return new Promise(() => undefined);
        },
      },
      permissionPolicy: fullWriteWithExternalTool(),
    });
    const failed = await waitForStatus(
      runtime,
      (await runtime.startRun(startInput(harness.workspace, "provider-timeout"))).run_id,
      "failed",
    );
    const locator = {
      sessionId: failed.session_id!,
      runId: failed.run_id,
      projectId: failed.project_id,
      workspace: harness.workspace,
    };

    const reconciled = await runtime.reconcileActions(locator);
    expect(reconciled.externalOutcomes).toEqual([{ actionId: failed.timeline.find(
      (event) => event.type === "tool.started",
    )!.action_id!, outcome: "unknown" }]);
    expect(reconcileCalls).toBe(1);
    expect(reconciliationTrigger).toBe("timeout");
    expect((await runtime.getProjection(failed.run_id)).timeline).toContainEqual(expect.objectContaining({
      type: "action.reconciled",
      operation_id: operationId,
      data: expect.objectContaining({ outcome: "unknown", reason_code: "reconciliation_timeout" }),
    }));
  });

  it("leaves unsupported external Tools untouched", async () => {
    const harness = await createHarness("unsupported-tool");
    let reconcileCalls = 0;
    const runtime = await createTrackedRuntime({
      dataDir: harness.dataDir,
      model: externalActionModel(),
      toolRegistry: externalToolRegistry(() => ({
        status: "unknown",
        code: "transport_timeout",
        summary: "Remote response was lost after dispatch",
      })),
      externalActionReconciler: {
        providerId: "acme.other-provider",
        supportedToolNames: new Set(),
        async reconcile() {
          reconcileCalls += 1;
          throw new Error("Unsupported tools must never reach this callback");
        },
      },
      permissionPolicy: fullWriteWithExternalTool(),
    });
    const failed = await waitForStatus(
      runtime,
      (await runtime.startRun(startInput(harness.workspace, "unsupported-tool"))).run_id,
      "failed",
    );

    const result = await runtime.reconcileActions({
      sessionId: failed.session_id!,
      runId: failed.run_id,
      projectId: failed.project_id,
      workspace: harness.workspace,
    });
    expect(result.externalOutcomes).toBeUndefined();
    expect(reconcileCalls).toBe(0);
    expect((await runtime.getProjection(failed.run_id)).timeline.some((event) => (
      event.type === "action.reconciled" || event.type === "action.diverged"
    ))).toBe(false);
  });

  it("turns provider evidence for a different operation into divergence", async () => {
    const harness = await createHarness("wrong-operation");
    const runtime = await createTrackedRuntime({
      dataDir: harness.dataDir,
      model: externalActionModel(),
      toolRegistry: externalToolRegistry(() => ({
        status: "unknown",
        code: "transport_timeout",
        summary: "Remote response was lost after dispatch",
      })),
      externalActionReconciler: {
        providerId: "acme.mismatched-provider",
        supportedToolNames: new Set(["acme.remote_write"]),
        async reconcile() {
          return {
            operation_id: "action:some-other-operation",
            outcome: "confirmed",
            reason_code: "provider_state",
            summary: "Provider found an operation",
            evidence_digest: sha256("wrong-operation"),
          };
        },
      },
      permissionPolicy: fullWriteWithExternalTool(),
    });
    const failed = await waitForStatus(
      runtime,
      (await runtime.startRun(startInput(harness.workspace, "wrong-operation"))).run_id,
      "failed",
    );

    const result = await runtime.reconcileActions({
      sessionId: failed.session_id!,
      runId: failed.run_id,
      projectId: failed.project_id,
      workspace: harness.workspace,
    });
    expect(result.externalOutcomes?.[0]?.outcome).toBe("diverged");
    expect((await runtime.getProjection(failed.run_id)).timeline).toContainEqual(expect.objectContaining({
      type: "action.diverged",
      data: expect.objectContaining({ reason_code: "operation_identity_mismatch" }),
    }));
  });
});

function externalToolRegistry(
  execute: (input: { value: string }, context: { operationId?: string }) => RawToolResult,
) {
  const registry = createDefaultToolRegistry();
  registry.register({
    name: "acme.remote_write",
    description: "Test-only remote side effect",
    inputSchema: zObjectValueSchema(),
    outputSchema: RawToolResultSchema,
    capability: "commit_patch",
    requiresApproval: false,
    timeoutMs: 1_000,
    concurrencySafe: false,
    sideEffect: "write",
    maxResultBytes: 4_096,
    presentation: { callLabel: "Remote write", resultLabel: "Remote write result" },
    async execute(input, context) {
      return execute(input, context);
    },
    render(_input, output) {
      return output;
    },
  });
  return registry;
}

function zObjectValueSchema() {
  // Keeping the test Tool input deliberately small also proves the reconciliation
  // request does not need to persist its raw arguments.
  return z.object({ value: z.string() });
}

function fullWriteWithExternalTool() {
  return createEffectivePermissionPolicy({
    preset: {
      ...CORE_BUILTIN_PERMISSION_PRESETS["full-write"],
      allowed_tools: [...CORE_BUILTIN_PERMISSION_PRESETS["full-write"].allowed_tools, "acme.remote_write"],
    },
  });
}

function externalActionModel(): ModelAdapter {
  let decisionCount = 0;
  return {
    name: "external-action-test-model",
    async decide() {
      decisionCount += 1;
      if (decisionCount === 1) {
        return {
          decision_id: "decision:external-action",
          kind: "tool_call",
          public_reason: "Perform one test external action",
          evidence_refs: [],
          risk: "high",
          tool_call: {
            action_id: "action:external-action",
            tool_name: "acme.remote_write",
            arguments: { value: "payload" },
          },
        };
      }
      return {
        decision_id: `decision:external-finish:${decisionCount}`,
        kind: "finish",
        public_reason: "The controlled action reached its local end point",
        evidence_refs: [],
        risk: "none",
        final_answer: "The operation is ready for reconciliation.",
      };
    },
  };
}

async function createHarness(name: string): Promise<{ dataDir: string; workspace: WorkspaceHandle }> {
  const root = await mkdtemp(join(tmpdir(), `tracegraph-run-052-${name}-`));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  return {
    dataDir: join(root, "data"),
    workspace: WorkspaceHandleSchema.parse({
      handle_id: `workspace:${name}`,
      project_id: `project:${name}`,
      real_root: await realpath(workspaceRoot),
      workspace_kind: "disposable_fixture",
      capabilities: DISPOSABLE_FIXTURE_CAPABILITIES,
      created_at: "2026-10-01T00:00:00.000Z",
    }),
  };
}

function startInput(workspace: WorkspaceHandle, name: string) {
  return {
    command_id: `command:start:${name}`,
    project_id: workspace.project_id,
    task: "Run one controlled external action.",
    mode: "execute" as const,
    workspace,
  };
}

async function createTrackedRuntime(options: Parameters<typeof createAgentRuntime>[0]): Promise<AgentRuntime> {
  const runtime = await createAgentRuntime(options);
  runtimes.push(runtime);
  return runtime;
}

async function waitForStatus(
  runtime: AgentRuntime,
  runId: string,
  status: "failed",
) {
  const deadline = Date.now() + 5_000;
  let latest: Awaited<ReturnType<AgentRuntime["getProjection"]>> | undefined;
  while (Date.now() < deadline) {
    latest = await runtime.getProjection(runId);
    if (latest.status === status) return latest;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `Run ${runId} did not reach ${status}; latest=${latest?.status ?? "missing"}; `
    + `failure=${latest?.failure_code ?? "none"}; events=${latest?.timeline.map((event) => event.type).join(",") ?? "none"}`,
  );
}
