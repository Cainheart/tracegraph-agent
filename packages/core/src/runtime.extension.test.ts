import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISPOSABLE_FIXTURE_CAPABILITIES,
  EXTENSION_API_VERSION,
  WorkspaceHandleSchema,
  type WorkspaceHandle,
} from "@tracegraph/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ExtensionManager, type TraceGraphExtension } from "./extension.js";
import { createAgentRuntime, type AgentRuntime } from "./runtime.js";
import { JsonlSessionStore } from "./session-store.js";
import {
  RawToolResultSchema,
  createArtifactToolsExtension,
  createCoreToolRegistry,
  createRunStateToolsExtension,
} from "./tool-registry.js";
import type { ModelAdapter, ToolDefinition } from "./types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("G17 Runtime extension integration", () => {
  it("executes an extension Tool through the normal path and isolates a terminal hook exactly once", async () => {
    const harness = await createHarness("tool-hook");
    const manager = new ExtensionManager({ toolRegistry: createCoreToolRegistry() });
    let errorHookCalls = 0;
    await manager.activate(extension("acme.runtime", (context) => {
      context.registerTool(fixtureTool("acme.lookup"));
      context.on("run.completed", async () => { throw new Error("terminal hook failed"); });
      context.on("extension.error", async () => { errorHookCalls += 1; });
    }));
    const schemas: string[][] = [];
    let turn = 0;
    const model: ModelAdapter = {
      name: "extension-tool-model",
      async decide(input) {
        schemas.push(input.toolSchemas.map(({ name }) => name));
        turn += 1;
        if (turn === 1) {
          return toolDecision("decision:extension-tool", "action:extension-tool", "acme.lookup");
        }
        return finishDecision("decision:extension-finish");
      },
    };
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      extensionManager: manager,
      model,
    });

    const started = await runtime.startRun(startInput(harness.workspace, "tool-hook", "execute"));
    const completed = await waitFor(runtime, started.run_id, (projection) => (
      projection.status === "completed"
      && projection.timeline.at(-1)?.type === "extension.error"
      && manager.activeLeaseCount === 0
    ));

    expect(schemas[0]).toContain("acme.lookup");
    expect(completed.timeline.some((event) => (
      event.type === "tool.completed"
      && (event.data.receipt as { tool_name?: string } | undefined)?.tool_name === "acme.lookup"
    ))).toBe(true);
    const terminal = completed.timeline.find((event) => event.type === "run.completed")!;
    const errors = completed.timeline.filter((event) => event.type === "extension.error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.data).toMatchObject({
      extension_name: "acme.runtime",
      phase: "event_hook",
      source_event_id: terminal.event_id,
      source_event_type: "run.completed",
    });
    expect(errors[0]?.sequence).toBeGreaterThan(terminal.sequence);
    expect(errorHookCalls).toBe(0);
  });

  it("turns a failing Context strategy into one durable error without failing the Run", async () => {
    const harness = await createHarness("context-error");
    const manager = new ExtensionManager({ toolRegistry: createCoreToolRegistry() });
    await manager.activate(extension("acme.context-error", (context) => {
      context.registerContextStrategy({
        name: "acme.failing-context",
        async contribute() {
          throw new Error("context source unavailable");
        },
      });
    }));
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      extensionManager: manager,
      model: finishModel("context-error-model"),
    });

    const started = await runtime.startRun(startInput(harness.workspace, "context-error", "execute"));
    const completed = await waitFor(runtime, started.run_id, (projection) => (
      projection.status === "completed" && manager.activeLeaseCount === 0
    ));
    const errors = completed.timeline.filter((event) => event.type === "extension.error");

    expect(errors).toHaveLength(1);
    expect(errors[0]?.data).toMatchObject({
      extension_name: "acme.context-error",
      phase: "context_strategy",
      source_event_type: "run.started",
    });
    expect(completed.timeline.at(-1)?.type).toBe("run.completed");
  });

  it("keeps Host-owned extension Context provenance authoritative", async () => {
    const harness = await createHarness("context-provenance");
    const manager = new ExtensionManager({ toolRegistry: createCoreToolRegistry() });
    await manager.activate(extension("acme.context-owner", (context) => {
      context.registerContextStrategy({
        name: "acme.context-strategy",
        async contribute() {
          return {
            summary: "Trusted extension Context",
            facts: {
              extension_name: "spoofed.extension",
              strategy_name: "spoofed.strategy",
              source: "fixture",
            },
          };
        },
      });
    }));
    let observedFacts: Readonly<Record<string, unknown>> | undefined;
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      extensionManager: manager,
      model: {
        name: "context-provenance-model",
        async decide(input) {
          observedFacts = input.observations.find(({ summary }) => summary === "Trusted extension Context")?.facts;
          return finishDecision("decision:context-provenance");
        },
      },
    });

    const started = await runtime.startRun(startInput(harness.workspace, "context-provenance", "execute"));
    await waitFor(runtime, started.run_id, (projection) => projection.status === "completed");

    expect(observedFacts).toEqual({
      extension_name: "acme.context-owner",
      strategy_name: "acme.context-strategy",
      source: "fixture",
    });
  });

  it("removes only Artifact schemas from the next Run after idle deactivation", async () => {
    const harness = await createHarness("builtin-unload");
    const manager = new ExtensionManager({ toolRegistry: createCoreToolRegistry() });
    await manager.activateAll([
      createArtifactToolsExtension(),
      createRunStateToolsExtension(),
    ]);
    const schemas: string[][] = [];
    const model: ModelAdapter = {
      name: "schema-capture-model",
      async decide(input) {
        schemas.push(input.toolSchemas.map(({ name }) => name));
        return finishDecision(`decision:finish:${schemas.length}`);
      },
    };
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      extensionManager: manager,
      model,
    });

    const first = await runtime.startRun(startInput(harness.workspace, "first", "execute"));
    await waitFor(runtime, first.run_id, (projection) => (
      projection.status === "completed" && manager.activeLeaseCount === 0
    ));
    await manager.deactivate("@tracegraph/builtin-artifact-tools");
    const second = await runtime.startRun(startInput(harness.workspace, "second", "execute"));
    await waitFor(runtime, second.run_id, (projection) => projection.status === "completed");

    expect(schemas[0]).toEqual(expect.arrayContaining(["read_artifact", "list_artifacts", "todo_read"]));
    expect(schemas[1]).not.toEqual(expect.arrayContaining(["read_artifact", "list_artifacts"]));
    expect(schemas[1]).toContain("todo_read");
  });

  it("fails closed when a v5 recovery snapshot no longer matches the trusted surface", async () => {
    const harness = await createHarness("recovery-drift");
    let now = new Date("2026-09-19T00:00:00.000Z");
    const firstStore = new JsonlSessionStore(join(harness.dataDir, "sessions"), {
      now: () => now,
      pid: 2_147_483_646,
    });
    const firstManager = new ExtensionManager({ toolRegistry: createCoreToolRegistry() });
    await firstManager.activate(createRunStateToolsExtension());
    let turn = 0;
    const planModel: ModelAdapter = {
      name: "extension-recovery-plan",
      async decide() {
        turn += 1;
        if (turn === 1) {
          return {
            decision_id: "decision:plan-todo",
            kind: "tool_call",
            public_reason: "Create the recovery Todo.",
            evidence_refs: [],
            risk: "low",
            tool_call: {
              action_id: "action:plan-todo",
              tool_name: "todo_write",
              arguments: {
                operation: "create",
                todo_id: "todo:recovery",
                title: "Resume only with the frozen extension surface",
              },
            },
          };
        }
        return finishDecision("decision:plan-ready");
      },
    };
    const firstRuntime = await createAgentRuntime({
      dataDir: harness.dataDir,
      extensionManager: firstManager,
      sessionStore: firstStore,
      model: planModel,
      now: () => now,
    });
    const started = await firstRuntime.startRun(startInput(harness.workspace, "recovery", "plan"));
    const waiting = await waitFor(
      firstRuntime,
      started.run_id,
      (projection) => projection.status === "awaiting_plan_approval",
    );
    await waitForSessionIndex(firstStore, waiting.session_id!, waiting.timeline.length);

    const restartedManager = new ExtensionManager({ toolRegistry: createCoreToolRegistry() });
    await restartedManager.activateAll([
      createRunStateToolsExtension(),
      createArtifactToolsExtension(),
    ]);
    now = new Date("2026-09-19T00:02:00.000Z");
    const restarted = await createAgentRuntime({
      dataDir: harness.dataDir,
      extensionManager: restartedManager,
      sessionStore: new JsonlSessionStore(join(harness.dataDir, "sessions"), { now: () => now }),
      model: planModel,
      now: () => now,
    });
    const locator = {
      sessionId: waiting.session_id!,
      runId: waiting.run_id,
      projectId: waiting.project_id,
    };
    await expect(restarted.markRunInterrupted(locator)).resolves.toMatchObject({ status: "interrupted" });
    await expect(restarted.resumeRun({
      ...locator,
      commandId: "command:resume:drift",
      workspace: harness.workspace,
    })).rejects.toMatchObject({ code: "extension_configuration_drift" });
    expect(restartedManager.activeLeaseCount).toBe(0);
  });
});

function extension(
  name: string,
  activate: TraceGraphExtension["activate"],
): TraceGraphExtension {
  return { name, api_version: EXTENSION_API_VERSION, activate };
}

function fixtureTool(name: string): ToolDefinition<Record<string, never>> {
  return {
    name,
    description: "Return a deterministic extension fixture",
    inputSchema: z.object({}).strict(),
    outputSchema: RawToolResultSchema,
    capability: "read",
    requiresApproval: false,
    timeoutMs: 1_000,
    concurrencySafe: true,
    sideEffect: "read",
    maxResultBytes: 4_096,
    presentation: { callLabel: "Extension fixture", resultLabel: "Extension fixture result" },
    async execute() {
      return { status: "success", code: "ok", summary: "Extension tool succeeded" };
    },
    render(_input, output) {
      return output;
    },
  };
}

function toolDecision(decisionId: string, actionId: string, toolName: string) {
  return {
    decision_id: decisionId,
    kind: "tool_call",
    public_reason: `Use ${toolName}.`,
    evidence_refs: [],
    risk: "low",
    tool_call: { action_id: actionId, tool_name: toolName, arguments: {} },
  };
}

function finishDecision(decisionId: string) {
  return {
    decision_id: decisionId,
    kind: "finish",
    public_reason: "The task is complete.",
    evidence_refs: [],
    risk: "none",
    final_answer: "Complete.",
  };
}

function finishModel(name: string): ModelAdapter {
  return { name, async decide() { return finishDecision(`decision:${name}`); } };
}

async function createHarness(name: string): Promise<{ dataDir: string; workspace: WorkspaceHandle }> {
  const root = await mkdtemp(join(tmpdir(), `tracegraph-extension-${name}-`));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  return {
    dataDir: join(root, "data"),
    workspace: WorkspaceHandleSchema.parse({
      handle_id: `workspace:${name}`,
      project_id: `project:${name}`,
      real_root: workspaceRoot,
      workspace_kind: "disposable_fixture",
      capabilities: DISPOSABLE_FIXTURE_CAPABILITIES,
      created_at: "2026-09-19T00:00:00.000Z",
    }),
  };
}

function startInput(workspace: WorkspaceHandle, suffix: string, mode: "plan" | "execute") {
  return {
    command_id: `command:start:${suffix}`,
    project_id: workspace.project_id,
    task: `G17 extension integration ${suffix}`,
    mode,
    workspace,
  };
}

async function waitFor(
  runtime: AgentRuntime,
  runId: string,
  predicate: (projection: Awaited<ReturnType<AgentRuntime["getProjection"]>>) => boolean,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const projection = await runtime.getProjection(runId);
    if (predicate(projection)) return projection;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const projection = await runtime.getProjection(runId);
  throw new Error(`Timed out waiting for G17 Runtime state: ${JSON.stringify({
    status: projection.status,
    timeline: projection.timeline.map((event) => event.type),
  })}`);
}

async function waitForSessionIndex(
  store: JsonlSessionStore,
  sessionId: string,
  length: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await store.readAll(sessionId)).entries.length >= length) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for the G17 Session index");
}
