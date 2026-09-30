import { access, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DecisionSchema,
  DISPOSABLE_FIXTURE_CAPABILITIES,
  WorkspaceHandleSchema,
  type MemoryCandidate,
  type ModelCapabilities,
  type WorkspaceHandle,
} from "@tracegraph/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { removeControlledTemporaryDirectory } from "../../kernel/workspace.js";
import type { ModelAdapter, ModelInput } from "../../kernel/types.js";
import { JsonlEventLedger } from "../evidence/event-ledger.js";
import {
  createAgentRuntime,
  type AgentRuntime,
} from "./runtime.js";
import {
  type RuntimeFeatureId,
} from "./runtime-feature-drivers.js";

const roots: string[] = [];

type TrackedRuntime = Awaited<ReturnType<typeof createAgentRuntime>>;

const trackedRuntimes: TrackedRuntime[] = [];

/** Registers a Runtime so teardown drains its nonblocking background work before its data directory goes away. */
async function createTrackedRuntime(
  options: Parameters<typeof createAgentRuntime>[0],
): Promise<TrackedRuntime> {
  const runtime = await createAgentRuntime(options);
  trackedRuntimes.push(runtime);
  return runtime;
}

afterEach(async () => {
  await Promise.all(trackedRuntimes.splice(0).map((runtime) => runtime.shutdownBackgroundWork?.()));
  await Promise.all(roots.splice(0).map(removeControlledTemporaryDirectory));
});

describe("Runtime feature-driver contributions", () => {
  it.each<RuntimeFeatureId>(["memory", "team", "todo", "attachment"])(
    "disables %s independently and keeps the other lifecycle contributions active",
    async (disabledFeature) => {
      const harness = await createHarness(disabledFeature);
      const model = new CapturingModel();
      const runtime = await createTrackedRuntime({
        dataDir: harness.dataDir,
        model,
        disabledRuntimeFeatures: [disabledFeature],
      });
      const started = await runtime.startRun(startInput(harness.workspace));
      const completed = await waitForTerminal(runtime, started.run_id);
      const schemas = model.toolSchemas[0] ?? [];

      expect(completed.status).toBe("completed");
      if (disabledFeature !== "todo") expect(schemas).toContain("todo_read");
      if (disabledFeature !== "team") expect(schemas).toContain("team_read");
      if (disabledFeature === "todo") {
        expect(schemas).not.toContain("todo_read");
        expect(schemas).not.toContain("todo_write");
        await expect(runtime.readTodos(started.run_id, started.project_id))
          .rejects.toMatchObject({ code: "feature_disabled" });
        await expect(runtime.startRun({
          ...startInput(harness.workspace),
          command_id: "command:start:plan-with-todo-disabled",
          mode: "plan",
        })).rejects.toMatchObject({ code: "feature_disabled" });
      } else if (disabledFeature === "team") {
        expect(schemas).not.toContain("team_read");
        expect(schemas).not.toContain("team_task_write");
        expect(schemas).not.toContain("team_mailbox_send");
        expect(schemas).not.toContain("team_mailbox_claim");
        expect(schemas).not.toContain("team_heartbeat");
        await expect(runtime.readTeam(started.run_id, started.project_id))
          .rejects.toMatchObject({ code: "feature_disabled" });
      } else if (disabledFeature === "memory") {
        const events = await new JsonlEventLedger(join(harness.dataDir, "events")).list(started.run_id);
        expect(events.some(({ type }) => type.startsWith("memory."))).toBe(false);
        await expect(access(join(harness.dataDir, "memory"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(runtime.remember(started.run_id, {} as MemoryCandidate))
          .rejects.toMatchObject({ code: "feature_disabled" });
        await expect(runtime.recall(started.run_id, "query"))
          .rejects.toMatchObject({ code: "feature_disabled" });
      } else {
        await expect(access(join(harness.dataDir, "attachments"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(runtime.stageAttachment({
          commandId: "command:attachment:disabled",
          projectId: started.project_id,
          declaredMediaType: "image/png",
          bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
        })).rejects.toMatchObject({ code: "feature_disabled" });
        await expect(runtime.getAttachmentContent({
          attachmentId: "attachment:disabled",
          runId: started.run_id,
          projectId: started.project_id,
        })).rejects.toMatchObject({ code: "feature_disabled" });
        await expect(runtime.startRun({
          ...startInput(harness.workspace),
          command_id: "command:start:attachment-disabled",
          attachment_upload_ids: ["upload:disabled"],
        })).rejects.toMatchObject({ code: "feature_disabled" });
      }

      if (disabledFeature === "todo") expect(schemas).toContain("team_read");
      if (disabledFeature === "team") expect(schemas).toContain("todo_read");
    },
  );

  it("keeps the extracted agent turn loop on generic contributions instead of feature branches", async () => {
    const runtimeSource = await readFile(new URL("./runtime.ts", import.meta.url), "utf8");
    const loopSource = await readFile(new URL("./agent-loop.ts", import.meta.url), "utf8");

    expect(runtimeSource).toContain("this.#agentLoop.continueRun(state)");
    expect(loopSource).toContain("this.#ports.featureDrivers.contributeTurn");
    expect(loopSource).not.toContain("this.#memory");
    expect(loopSource).not.toContain("this.#teams");
    expect(loopSource).not.toContain("this.#todos");
    expect(loopSource).not.toContain("this.#attachmentStore");
  });

  it("rejects a model-emitted Tool owned by a disabled driver before dispatch", async () => {
    const harness = await createHarness("disabled-tool-call");
    const runtime = await createTrackedRuntime({
      dataDir: harness.dataDir,
      disabledRuntimeFeatures: ["team"],
      model: {
        name: "core-027-disabled-team-tool",
        async decide(input) {
          if (!input.observations.some(({ facts }) => facts.tool_name === "team_read")) {
            return DecisionSchema.parse({
              decision_id: "decision:disabled-team-tool",
              kind: "tool_call",
              public_reason: "Attempt the unavailable Team Tool.",
              evidence_refs: [],
              risk: "low",
              tool_call: {
                action_id: "action:disabled-team-tool",
                tool_name: "team_read",
                arguments: { section: "roster", offset: 0, limit: 1 },
              },
            });
          }
          return DecisionSchema.parse({
            decision_id: "decision:disabled-team-tool-followup",
            kind: "finish",
            public_reason: "Unexpectedly reached the follow-up turn.",
            evidence_refs: [],
            risk: "none",
            final_answer: "unexpected",
          });
        },
      },
    });
    const started = await runtime.startRun(startInput(harness.workspace));
    const failed = await waitForTerminal(runtime, started.run_id);

    expect(failed.status).toBe("failed");
    expect(failed.timeline).toContainEqual(expect.objectContaining({
      type: "action.rejected",
      action_id: "action:disabled-team-tool",
      data: { code: "feature_disabled", feature: "team" },
    }));
    expect(failed.timeline.some(({ type }) => type === "tool.started")).toBe(false);
    expect(failed.timeline.some(({ type }) => type.startsWith("team."))).toBe(false);
  });

  it("rejects invalid disable configuration before constructing the Runtime", async () => {
    const harness = await createHarness("invalid-config");
    await expect(createTrackedRuntime({
      dataDir: harness.dataDir,
      disabledRuntimeFeatures: ["filesystem" as RuntimeFeatureId],
    })).rejects.toThrow("Unknown Runtime feature: filesystem");
  });
});

async function createHarness(name: string): Promise<{
  dataDir: string;
  workspace: WorkspaceHandle;
}> {
  const root = await mkdtemp(join(tmpdir(), `tracegraph-core-027-${name}-`));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const now = new Date("2026-09-30T00:00:00.000Z");
  const workspace = WorkspaceHandleSchema.parse({
    handle_id: `workspace:core-027:${name}`,
    project_id: `project:core-027:${name}`,
    real_root: await realpath(workspaceRoot),
    workspace_kind: "disposable_fixture",
    capabilities: { ...DISPOSABLE_FIXTURE_CAPABILITIES, index: false },
    created_at: now.toISOString(),
  });
  return { dataDir: join(root, "data"), workspace };
}

function startInput(workspace: WorkspaceHandle) {
  return {
    command_id: "command:start:feature-driver",
    project_id: workspace.project_id,
    task: "Confirm the Runtime feature contributions.",
    mode: "execute" as const,
    workspace,
  };
}

async function waitForTerminal(runtime: AgentRuntime, runId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const projection = await runtime.getProjection(runId);
    if (projection.status === "completed" || projection.status === "failed") return projection;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for terminal Run state");
}

class CapturingModel implements ModelAdapter {
  readonly name = "core-027-feature-driver-model";
  readonly toolSchemas: string[][] = [];
  readonly #capabilities: ModelCapabilities = { image_input: false };

  capabilities(): ModelCapabilities {
    return this.#capabilities;
  }

  async decide(input: ModelInput): Promise<unknown> {
    this.toolSchemas.push(input.toolSchemas.map(({ name }) => name));
    return DecisionSchema.parse({
      decision_id: `decision:feature-driver:${this.toolSchemas.length}`,
      kind: "finish",
      public_reason: "The enabled feature drivers remained available.",
      evidence_refs: [],
      risk: "none",
      final_answer: "done",
    });
  }
}
