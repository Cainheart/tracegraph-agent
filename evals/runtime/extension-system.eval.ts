import { describe, expect, it } from "vitest";
import {
  ExtensionManager,
  createAgentRuntime,
  createArtifactToolsExtension,
  createCoreToolRegistry,
  createRunStateToolsExtension,
  type ModelAdapter,
  type ModelInput,
  type TraceGraphExtension,
} from "../../packages/core/dist/index.js";
import {
  DecisionSchema,
  EXTENSION_API_VERSION,
} from "../../packages/contracts/dist/index.js";
import {
  createFailingTypescriptFixture,
  createTemporaryDataDir,
} from "../../packages/test-support/dist/index.js";
import { startEvalInput, waitForEvalStatus } from "./helpers.js";

describe("runtime behavior: extension system", () => {
  it("isolates a throwing event hook and records one non-recursive extension.error", async () => {
    const fixture = await createFailingTypescriptFixture("eval-extension-hook-isolation");
    const data = await createTemporaryDataDir();
    try {
      const manager = await managerWithBuiltinExtensions();
      await manager.activate({
        name: "eval.throwing-hook",
        api_version: EXTENSION_API_VERSION,
        activate(context) {
          context.on("model.request_started", () => {
            throw new Error("bounded hook failure");
          });
        },
      });
      const runtime = await createAgentRuntime({
        dataDir: data.path,
        model: new CapturingFinishModel(),
        extensionManager: manager,
      });

      const started = await runtime.startRun(startEvalInput(
        fixture.handle,
        "extension-hook-isolation",
        "Complete despite a failing read-only extension event hook.",
      ));
      const completed = await waitForEvalStatus(runtime, started.run_id, "completed");
      const errors = completed.timeline.filter(({ type }) => type === "extension.error");

      expect(completed.status).toBe("completed");
      expect(errors).toHaveLength(1);
      expect(errors[0]?.data).toMatchObject({
        extension_name: "eval.throwing-hook",
        api_version: EXTENSION_API_VERSION,
        phase: "event_hook",
        source_event_type: "model.request_started",
      });
      expect(manager.activeLeaseCount).toBe(0);
    } finally {
      await Promise.all([fixture.cleanup(), data.cleanup()]);
    }
  });

  it("removes one built-in capability group reversibly while later Runs still complete", async () => {
    const fixture = await createFailingTypescriptFixture("eval-extension-builtins");
    const data = await createTemporaryDataDir();
    try {
      const manager = await managerWithBuiltinExtensions();
      const model = new CapturingFinishModel();
      const runtime = await createAgentRuntime({
        dataDir: data.path,
        model,
        extensionManager: manager,
      });

      const first = await runtime.startRun(startEvalInput(
        fixture.handle,
        "extension-builtins-before",
        "Observe the complete built-in extension tool surface.",
      ));
      await waitForEvalStatus(runtime, first.run_id, "completed");
      expect(toolNames(model.inputs[0])).toEqual(expect.arrayContaining([
        "read_artifact",
        "list_artifacts",
        "todo_read",
        "spawn_subagent",
      ]));

      await manager.deactivate("@tracegraph/builtin-artifact-tools");
      expect(manager.toolRegistry.get("read_artifact")).toBeUndefined();
      expect(manager.toolRegistry.get("list_artifacts")).toBeUndefined();
      expect(manager.toolRegistry.get("todo_read")).toBeDefined();
      expect(manager.toolRegistry.get("spawn_subagent")).toBeDefined();

      const second = await runtime.startRun({
        ...startEvalInput(
          fixture.handle,
          "extension-builtins-after",
          "Complete after the Artifact capability extension is disabled.",
        ),
        command_id: "command:eval:extension-builtins-after",
      });
      const completed = await waitForEvalStatus(runtime, second.run_id, "completed");
      const secondTools = toolNames(model.inputs[1]);

      expect(completed.status).toBe("completed");
      expect(secondTools).not.toContain("read_artifact");
      expect(secondTools).not.toContain("list_artifacts");
      expect(secondTools).toEqual(expect.arrayContaining(["todo_read", "spawn_subagent"]));
      expect(manager.activeLeaseCount).toBe(0);
    } finally {
      await Promise.all([fixture.cleanup(), data.cleanup()]);
    }
  });

  it("rejects an incompatible API version before activation", async () => {
    const manager = new ExtensionManager({ toolRegistry: createCoreToolRegistry() });
    let activated = false;
    const incompatible = {
      name: "eval.incompatible",
      api_version: "tracegraph.extension.v999",
      activate() {
        activated = true;
      },
    } as unknown as TraceGraphExtension;

    await expect(manager.activate(incompatible)).rejects.toMatchObject({
      code: "extension_api_version_mismatch",
    });
    expect(activated).toBe(false);
    expect(manager.listStatuses()).toEqual([
      expect.objectContaining({
        name: "eval.incompatible",
        state: "rejected",
        error_code: "extension_api_version_mismatch",
      }),
    ]);
  });
});

async function managerWithBuiltinExtensions(): Promise<ExtensionManager> {
  const manager = new ExtensionManager({ toolRegistry: createCoreToolRegistry() });
  await manager.activateAll([
    createArtifactToolsExtension(),
    createRunStateToolsExtension(),
  ]);
  return manager;
}

function toolNames(input: ModelInput | undefined): readonly string[] {
  return input?.toolSchemas.map(({ name }) => name) ?? [];
}

class CapturingFinishModel implements ModelAdapter {
  readonly name = "g17-eval-capturing-model";
  readonly inputs: ModelInput[] = [];

  async decide(input: ModelInput): Promise<unknown> {
    this.inputs.push(input);
    return DecisionSchema.parse({
      decision_id: `decision:g17-eval:${this.inputs.length}`,
      kind: "finish",
      public_reason: "The bounded G17 evaluation observed the extension surface.",
      evidence_refs: [],
      risk: "none",
      final_answer: "done",
    });
  }
}
