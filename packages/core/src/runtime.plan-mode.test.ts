import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISPOSABLE_FIXTURE_CAPABILITIES,
  WorkspaceHandleSchema,
  type WorkspaceHandle,
} from "@tracegraph/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ActionWal } from "./action-wal.js";
import { JsonlEventLedger } from "./event-ledger.js";
import { createAgentRuntime, type AgentRuntime } from "./runtime.js";
import { JsonlSessionStore } from "./session-store.js";
import { createDefaultToolRegistry } from "./tool-registry.js";
import type { ModelAdapter } from "./types.js";

const roots: string[] = [];
const HASH = `sha256:${"0".repeat(64)}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("G09 Runtime Plan Mode", () => {
  it("denies direct commit_patch before tool.started, WAL prepare, or mutation", async () => {
    const harness = await createHarness("commit-denied");
    const model: ModelAdapter = {
      name: "plan-direct-commit",
      async decide() {
        return toolDecision("decision:commit", "action:commit", "commit_patch", {
          path: "src/value.ts",
          expected: "before\n",
          replacement: "after\n",
          base_hash: HASH,
          patch_hash: HASH,
        });
      },
    };
    const runtime = await createAgentRuntime({ dataDir: harness.dataDir, model });

    const started = await runtime.startRun(startInput(harness.workspace));
    const failed = await waitForStatus(runtime, started.run_id, "failed");
    const denied = failed.timeline.find((event) => event.type === "policy.denied");

    expect(failed.failure_code).toBe("plan_mode_denied");
    expect(denied?.data).toMatchObject({
      reason: "plan_mode",
      code: "plan_mode_denied",
      decision: { kind: "deny", source: "hard-constraint", tool_name: "commit_patch" },
    });
    expect(failed.timeline.some((event) => event.type === "tool.started")).toBe(false);
    expect(failed.timeline.some((event) => event.type === "patch.applied")).toBe(false);
    expect(await new ActionWal(join(harness.dataDir, "wal")).latest(started.run_id)).toEqual([]);
    expect(await readFile(join(harness.workspace.real_root, "src/value.ts"), "utf8")).toBe("before\n");
  });

  it("denies malformed write/execute calls as plan_mode before argument parsing", async () => {
    for (const [toolName, arguments_] of [
      ["commit_patch", {}],
      ["run_test", { suite: "not-the-registered-suite" }],
    ] as const) {
      const harness = await createHarness(`malformed-${toolName}`);
      let executorRan = false;
      const registry = createDefaultToolRegistry();
      const original = registry.get(toolName)!;
      registry.register({
        ...original,
        async execute(input, context) {
          executorRan = true;
          return original.execute(input, context);
        },
      });
      const model: ModelAdapter = {
        name: `malformed-${toolName}-model`,
        async decide() {
          return toolDecision(
            `decision:malformed:${toolName}`,
            `action:malformed:${toolName}`,
            toolName,
            arguments_,
          );
        },
      };
      const runtime = await createAgentRuntime({
        dataDir: harness.dataDir,
        model,
        toolRegistry: registry,
      });

      const started = await runtime.startRun(startInput(harness.workspace));
      const failed = await waitForStatus(runtime, started.run_id, "failed");

      expect(failed.failure_code).toBe("plan_mode_denied");
      expect(executorRan).toBe(false);
      expect(failed.timeline.find((event) => event.type === "policy.denied")?.data)
        .toMatchObject({ reason: "plan_mode", code: "plan_mode_denied" });
      expect(failed.timeline.some((event) => event.type === "action.rejected")).toBe(false);
      expect(failed.timeline.some((event) => event.type === "tool.started")).toBe(false);
      expect(await new ActionWal(join(harness.dataDir, "wal")).latest(started.run_id)).toEqual([]);
    }
  });

  it("atomically rejects a batch when todo_write metadata is forged as a workspace write", async () => {
    const harness = await createHarness("forged-metadata");
    const registry = createDefaultToolRegistry();
    const original = registry.get("todo_write")!;
    let maliciousExecutorRan = false;
    registry.register({
      ...original,
      sideEffect: "write",
      async execute(input, context) {
        maliciousExecutorRan = true;
        return original.execute(input, context);
      },
    });
    const model: ModelAdapter = {
      name: "plan-forged-batch",
      async decide() {
        return {
          decision_id: "decision:forged-batch",
          kind: "tool_call",
          public_reason: "Attempt a mixed Plan batch.",
          evidence_refs: [],
          risk: "high",
          tool_calls: [{
            action_id: "action:read-first",
            tool_name: "read_file",
            arguments: { path: "src/value.ts" },
          }, {
            action_id: "action:forged-todo",
            tool_name: "todo_write",
            arguments: {
              operation: "create",
              todo_id: "todo:forged",
              title: "Must never be created",
            },
          }],
        };
      },
    };
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      model,
      toolRegistry: registry,
    });

    const started = await runtime.startRun(startInput(harness.workspace));
    const failed = await waitForStatus(runtime, started.run_id, "failed");

    expect(failed.failure_code).toBe("plan_mode_denied");
    expect(maliciousExecutorRan).toBe(false);
    expect(failed.timeline.some((event) => event.type === "tool.started")).toBe(false);
    expect(failed.timeline.some((event) => event.type === "tool.batch_started")).toBe(false);
    expect(failed.timeline.some((event) => event.type.startsWith("todo."))).toBe(false);
    expect(failed.timeline.find((event) => event.type === "policy.denied")?.data)
      .toMatchObject({ reason: "plan_mode" });
  });

  it("keeps one run_id across plan, revision-bound approval, execution, and Todo completion", async () => {
    const harness = await createHarness("approve-execute");
    const model = planThenExecuteModel();
    const runtime = await createAgentRuntime({ dataDir: harness.dataDir, model });

    const started = await runtime.startRun(startInput(harness.workspace));
    const waiting = await waitForStatus(runtime, started.run_id, "awaiting_plan_approval");
    const originalPlanEventId = waiting.pending_plan!.plan_event_id;

    expect(waiting.mode).toBe("plan");
    expect(waiting.todos.items).toMatchObject([{
      todo_id: "todo:inspect",
      state: "pending",
      created_by: "model",
    }]);
    const todoEdit = {
      command_id: "command:edit-plan-todo",
      project_id: waiting.project_id,
      run_id: waiting.run_id,
      updated_by: "user" as const,
      input: {
        operation: "update" as const,
        todo_id: "todo:inspect",
        title: "Inspect the workspace and retain canonical evidence",
      },
    };
    const edited = await runtime.writeTodo(todoEdit);
    const revised = await runtime.getProjection(waiting.run_id);
    const planEventId = revised.pending_plan!.plan_event_id;
    expect(planEventId).not.toBe(originalPlanEventId);
    expect(revised.todos.items[0]?.title).toContain("canonical evidence");

    await expect(runtime.approvePlan({
      type: "approve_plan",
      command_id: "command:stale-plan",
      project_id: waiting.project_id,
      run_id: waiting.run_id,
      plan_event_id: originalPlanEventId,
    })).rejects.toMatchObject({ code: "plan_revision_mismatch" });

    const approving = {
      type: "approve_plan" as const,
      command_id: "command:approve-plan",
      project_id: waiting.project_id,
      run_id: waiting.run_id,
      plan_event_id: planEventId,
    };
    const approved = await runtime.approvePlan(approving);
    const duplicate = await runtime.approvePlan(approving);
    const completed = await waitForStatus(runtime, waiting.run_id, "completed");

    expect(approved.run_id).toBe(started.run_id);
    expect(approved.mode).toBe("execute");
    expect(duplicate.run_id).toBe(started.run_id);
    expect(completed.mode).toBe("execute");
    expect(completed.todos.items).toMatchObject([{
      todo_id: "todo:inspect",
      state: "done",
      created_by: "model",
    }]);
    expect(completed.todos.items[0]?.evidence_event_ids).toHaveLength(1);
    expect(completed.timeline.filter((event) => event.type === "plan.approved")).toHaveLength(1);
    expect(completed.timeline.find((event) => event.type === "plan.approved")?.caused_by_event_id)
      .toBe(planEventId);
    expect(completed.timeline.every((event) => event.run_id === started.run_id)).toBe(true);
    expect(runtime.listLiveActivities(waiting.run_id).map(({ source_event_type: type }) => type))
      .toEqual(expect.arrayContaining([
        "todo.created",
        "plan.ready",
        "plan.approved",
        "todo.completed",
      ]));

    const replayedEdit = await runtime.writeTodo(todoEdit);
    expect(replayedEdit.event_id).toBe(edited.event_id);
    await expect(runtime.writeTodo({
      ...todoEdit,
      input: { ...todoEdit.input, title: "Conflicting lost-response retry" },
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(runtime.writeTodo({
      ...todoEdit,
      command_id: "command:new-terminal-edit",
    })).rejects.toMatchObject({ code: "run_terminal" });
  });

  it("repairs a Todo-after-plan crash gap before rejecting the stale approval", async () => {
    const harness = await createHarness("stale-crash-gap");
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      model: planThenExecuteModel(),
    });
    const started = await runtime.startRun(startInput(harness.workspace));
    const waiting = await waitForStatus(runtime, started.run_id, "awaiting_plan_approval");
    const stalePlanEventId = waiting.pending_plan!.plan_event_id;
    const currentTodo = waiting.todos.items[0]!;

    // Simulate a crash after todo.* became durable but before writeTodo could
    // append its replacement plan.ready revision.
    const externalLedger = new JsonlEventLedger(join(harness.dataDir, "events"));
    const mutation = await externalLedger.append({
      type: "todo.updated",
      project_id: waiting.project_id,
      run_id: waiting.run_id,
      session_id: waiting.session_id,
      attempt: 0,
      summary: "Updated Todo",
      artifact_refs: [],
      data: {
        todo: { ...currentTodo, title: "Plan changed immediately before a crash" },
        previous_state: currentTodo.state,
        updated_by: "user",
      },
    });

    await expect(runtime.approvePlan({
      type: "approve_plan",
      command_id: "command:approve-stale-crash-gap",
      project_id: waiting.project_id,
      run_id: waiting.run_id,
      plan_event_id: stalePlanEventId,
    })).rejects.toMatchObject({ code: "plan_revision_mismatch" });

    const repaired = await runtime.getProjection(waiting.run_id);
    expect(repaired.pending_plan?.plan_event_id).not.toBe(stalePlanEventId);
    expect(repaired.timeline.at(-1)).toMatchObject({
      type: "plan.ready",
      caused_by_event_id: mutation.event_id,
    });
    expect(repaired.timeline.some((event) => event.type === "plan.approved")).toBe(false);

    await runtime.approvePlan({
      type: "approve_plan",
      command_id: "command:approve-repaired-crash-gap",
      project_id: repaired.project_id,
      run_id: repaired.run_id,
      plan_event_id: repaired.pending_plan!.plan_event_id,
    });
    await waitForStatus(runtime, repaired.run_id, "completed");
  });

  it("rejects new user Todo mutations while recovery or manual review is required", async () => {
    for (const eventType of ["run.interrupted", "action.diverged"] as const) {
      const harness = await createHarness(`todo-state-${eventType.replace(".", "-")}`);
      const runtime = await createAgentRuntime({
        dataDir: harness.dataDir,
        model: planThenExecuteModel(),
      });
      const started = await runtime.startRun(startInput(harness.workspace));
      const waiting = await waitForStatus(runtime, started.run_id, "awaiting_plan_approval");
      const externalLedger = new JsonlEventLedger(join(harness.dataDir, "events"));
      await externalLedger.append({
        type: eventType,
        project_id: waiting.project_id,
        run_id: waiting.run_id,
        session_id: waiting.session_id,
        attempt: 0,
        summary: eventType === "run.interrupted" ? "Run interrupted" : "Action requires manual review",
        artifact_refs: [],
        data: eventType === "run.interrupted" ? { reason: "simulated_restart" } : { code: "simulated_divergence" },
      });

      await expect(runtime.writeTodo({
        command_id: `command:blocked:${eventType}`,
        project_id: waiting.project_id,
        run_id: waiting.run_id,
        updated_by: "user",
        input: {
          operation: "update",
          todo_id: "todo:inspect",
          title: "Must not be accepted in this Run state",
        },
      })).rejects.toMatchObject({ code: "run_not_mutable" });
    }
  });

  it("makes bounded todo_read content visible to the next model turn", async () => {
    const harness = await createHarness("todo-read-visible");
    let step = 0;
    let observedTodoExcerpt: unknown;
    let todoWriteEvidenceEventId: unknown;
    const model: ModelAdapter = {
      name: "todo-read-visible-model",
      async decide(input) {
        step += 1;
        if (step === 1) {
          return toolDecision("decision:create-visible", "action:create-visible", "todo_write", {
            operation: "create",
            todo_id: "todo:visible",
            title: "Inspect the visible Todo contract",
          });
        }
        if (step === 2) {
          todoWriteEvidenceEventId = [...input.observations].reverse()
            .find(({ facts }) => facts.tool_name === "todo_write")
            ?.facts.evidence_event_id;
          return toolDecision("decision:read-visible", "action:read-visible", "todo_read", {});
        }
        observedTodoExcerpt = input.observations
          .find(({ facts }) => facts.tool_name === "todo_read")
          ?.facts.content_excerpt;
        return finishDecision("decision:visible-finish", "The structured plan is visible.");
      },
    };
    const runtime = await createAgentRuntime({ dataDir: harness.dataDir, model });

    const started = await runtime.startRun(startInput(harness.workspace));
    await waitForStatus(runtime, started.run_id, "awaiting_plan_approval");

    expect(todoWriteEvidenceEventId).toBeUndefined();
    expect(observedTodoExcerpt).toEqual(expect.stringContaining("Inspect the visible Todo contract"));
    expect(observedTodoExcerpt).toEqual(expect.stringContaining('"state": "pending"'));
    expect(observedTodoExcerpt).toEqual(expect.stringContaining('"depends_on": []'));
  });

  it("gives an oversized todo_read observation an Artifact refetch locator", async () => {
    const harness = await createHarness("todo-read-refetch");
    let step = 0;
    let todoReadFacts: Readonly<Record<string, unknown>> | undefined;
    let firstArtifactFacts: Readonly<Record<string, unknown>> | undefined;
    let finalArtifactFacts: Readonly<Record<string, unknown>> | undefined;
    let firstRefetchedExcerpt: unknown;
    let finalRefetchedExcerpt: unknown;
    let todoLocator: string | undefined;
    const model: ModelAdapter = {
      name: "todo-read-refetch-model",
      async decide(input) {
        step += 1;
        if (step === 1) {
          return toolDecision("decision:create-large", "action:create-large", "todo_write", {
            operation: "create",
            todo_id: "todo:large",
            title: "Inspect the oversized Todo contract",
            // The complete page is under 4K UTF-16 code units but over 4K
            // UTF-8 bytes, exercising the byte-based excerpt marker.
            detail: `Large bounded detail: ${"界".repeat(1_350)}`,
          });
        }
        if (step === 2) {
          return toolDecision("decision:read-large", "action:read-large", "todo_read", {});
        }
        if (step === 3) {
          todoReadFacts = input.observations
            .find(({ facts }) => facts.tool_name === "todo_read")
            ?.facts;
          const locator = todoReadFacts?.locator;
          if (typeof locator !== "string") throw new Error("todo_read did not expose an Artifact locator");
          todoLocator = locator;
          return toolDecision("decision:refetch-large", "action:refetch-large", "read_artifact", {
            locator,
            offset: 0,
            limit: 4_000,
          });
        }
        if (step === 4) {
          firstArtifactFacts = [...input.observations].reverse()
            .find(({ facts }) => facts.tool_name === "read_artifact")
            ?.facts;
          firstRefetchedExcerpt = firstArtifactFacts?.content_excerpt;
          const nextOffset = firstArtifactFacts?.next_offset;
          if (todoLocator === undefined || typeof nextOffset !== "number") {
            throw new Error("First Artifact page did not expose its continuation");
          }
          return toolDecision("decision:refetch-large-tail", "action:refetch-large-tail", "read_artifact", {
            locator: todoLocator,
            offset: nextOffset,
            limit: 4_000,
          });
        }
        finalArtifactFacts = [...input.observations].reverse()
          .find(({ facts }) => facts.tool_name === "read_artifact")
          ?.facts;
        finalRefetchedExcerpt = finalArtifactFacts?.content_excerpt;
        return finishDecision("decision:large-visible-finish", "The oversized plan remains refetchable.");
      },
    };
    const runtime = await createAgentRuntime({ dataDir: harness.dataDir, model });

    const started = await runtime.startRun(startInput(harness.workspace));
    await waitForStatus(runtime, started.run_id, "awaiting_plan_approval");

    expect(todoReadFacts).toMatchObject({
      content_truncated: true,
      locator: expect.stringMatching(/^artifact:/u),
      artifact_id: expect.any(String),
    });
    expect(String(todoReadFacts?.content_excerpt).length).toBeLessThanOrEqual(4_000);
    expect(firstArtifactFacts).toMatchObject({
      truncated: true,
      next_offset: expect.any(Number),
      bytes_read: expect.any(Number),
    });
    expect(Number(firstArtifactFacts?.bytes_read)).toBeGreaterThanOrEqual(3_997);
    expect(Number(firstArtifactFacts?.bytes_read)).toBeLessThanOrEqual(4_000);
    expect(finalArtifactFacts).toMatchObject({
      truncated: false,
      offset: firstArtifactFacts?.next_offset,
      total_bytes: firstArtifactFacts?.total_bytes,
    });
    expect(Number(firstArtifactFacts?.bytes_read) + Number(finalArtifactFacts?.bytes_read))
      .toBe(finalArtifactFacts?.total_bytes);
    expect(firstRefetchedExcerpt).toEqual(expect.stringContaining("Inspect the oversized Todo contract"));
    expect(finalRefetchedExcerpt).toEqual(expect.stringContaining('"state": "pending"'));
  }, 10_000);

  it("pages a Todo list larger than the Tool envelope and makes its final item reachable", async () => {
    const harness = await createHarness("todo-read-pagination");
    // Control characters exercise JSON's maximum escaping expansion while
    // remaining within the 4K detail contract. This exceeds even the enlarged
    // one-item-safe Todo page with only a small number of durable events.
    const largeDetail = `Bounded detail: ${"\0".repeat(3_880)}`;
    const seededItems = Array.from({ length: 30 }, (_, index) => ({
      todo_id: `todo:large:${String(index).padStart(2, "0")}`,
      title: index === 29 ? "Final reachable Todo" : `Large Todo ${index}`,
      detail: largeDetail,
      state: "pending" as const,
      depends_on: [],
      evidence_event_ids: [],
      created_by: "model" as const,
    }));
    expect(Buffer.byteLength(JSON.stringify(seededItems), "utf8")).toBeGreaterThan(180 * 1024);

    let releaseSecondDecision = (): void => undefined;
    const mayReadSeededTodos = new Promise<void>((resolve) => {
      releaseSecondDecision = resolve;
    });
    let notifySecondDecision = (): void => undefined;
    const secondDecisionStarted = new Promise<void>((resolve) => {
      notifySecondDecision = resolve;
    });
    let step = 0;
    let firstPageFacts: Readonly<Record<string, unknown>> | undefined;
    let finalPageFacts: Readonly<Record<string, unknown>> | undefined;
    let finalPageExcerpt: unknown;
    const model: ModelAdapter = {
      name: "todo-read-pagination-model",
      async decide(input) {
        step += 1;
        if (step === 1) {
          return toolDecision("decision:create-page-seed", "action:create-page-seed", "todo_write", {
            operation: "create",
            todo_id: seededItems[0]!.todo_id,
            title: seededItems[0]!.title,
            detail: seededItems[0]!.detail,
          });
        }
        if (step === 2) {
          notifySecondDecision();
          await mayReadSeededTodos;
          return toolDecision("decision:read-first-page", "action:read-first-page", "todo_read", {
            offset: 0,
            limit: 100,
          });
        }
        if (step === 3) {
          firstPageFacts = [...input.observations].reverse()
            .find(({ facts }) => facts.tool_name === "todo_read")
            ?.facts;
          if (typeof firstPageFacts?.next_offset !== "number") {
            throw new Error("Oversized Todo page did not expose next_offset");
          }
          return toolDecision("decision:read-final-page", "action:read-final-page", "todo_read", {
            offset: 29,
            limit: 1,
          });
        }
        const finalObservation = [...input.observations].reverse()
          .find(({ facts }) => facts.tool_name === "todo_read");
        finalPageFacts = finalObservation?.facts;
        finalPageExcerpt = finalObservation?.facts.content_excerpt;
        return finishDecision("decision:paged-plan-finish", "Every Todo page remains reachable.");
      },
    };
    const runtime = await createAgentRuntime({ dataDir: harness.dataDir, model });
    const started = await runtime.startRun(startInput(harness.workspace));
    await secondDecisionStarted;

    const externalLedger = new JsonlEventLedger(join(harness.dataDir, "events"));
    try {
      for (const todo of seededItems.slice(1)) {
        await externalLedger.append({
          type: "todo.created",
          project_id: started.project_id,
          run_id: started.run_id,
          ...(started.session_id === undefined ? {} : { session_id: started.session_id }),
          attempt: 0,
          summary: `Created ${todo.todo_id}`,
          artifact_refs: [],
          data: { todo },
        });
      }
    } finally {
      releaseSecondDecision();
    }
    const waiting = await waitForStatus(runtime, started.run_id, "awaiting_plan_approval");

    expect(waiting.todos.items).toHaveLength(seededItems.length);
    expect(firstPageFacts).toMatchObject({
      todo_count: seededItems.length,
      offset: 0,
      limit: 100,
      truncated: true,
      next_offset: expect.any(Number),
      content_truncated: true,
    });
    expect(firstPageFacts?.output_truncated).not.toBe(true);
    expect(Number(firstPageFacts?.next_offset)).toBeGreaterThan(0);
    expect(Number(firstPageFacts?.next_offset)).toBeLessThan(seededItems.length);
    expect(finalPageFacts).toMatchObject({
      todo_count: seededItems.length,
      returned_count: 1,
      offset: 29,
      truncated: false,
    });
    expect(finalPageExcerpt).toEqual(expect.stringContaining("Final reachable Todo"));
  }, 20_000);

  it("restores a pending plan and its Todos after restart, then approves the same Run", async () => {
    const harness = await createHarness("recovery");
    let now = new Date("2026-09-19T00:00:00.000Z");
    const idFactory = sequentialIdFactory();
    const model = planThenExecuteModel();
    const firstStore = new JsonlSessionStore(harness.sessionsRoot, {
      now: () => now,
      pid: 2_147_483_646,
    });
    const firstRuntime = await createAgentRuntime({
      dataDir: harness.dataDir,
      sessionStore: firstStore,
      model,
      idFactory,
      now: () => now,
    });
    const started = await firstRuntime.startRun(startInput(harness.workspace));
    const waiting = await waitForStatus(firstRuntime, started.run_id, "awaiting_plan_approval");
    const expectedTodo = waiting.todos.items[0];
    await waitForSessionIndex(firstStore, waiting.session_id!, waiting.timeline.length);

    now = new Date("2026-09-19T00:02:00.000Z");
    const restartedStore = new JsonlSessionStore(harness.sessionsRoot, { now: () => now });
    const restarted = await createAgentRuntime({
      dataDir: harness.dataDir,
      sessionStore: restartedStore,
      model,
      idFactory,
      now: () => now,
    });
    const interrupted = await restarted.markRunInterrupted(locator(waiting));
    const resumed = await restarted.resumeRun({
      ...locator(waiting),
      commandId: "command:resume-plan",
      workspace: harness.workspace,
    });

    expect(interrupted.status).toBe("interrupted");
    expect(resumed.status).toBe("awaiting_plan_approval");
    expect(resumed.mode).toBe("plan");
    expect(resumed.pending_plan).toEqual(waiting.pending_plan);
    expect(resumed.todos.items[0]).toEqual(expectedTodo);

    await restarted.approvePlan({
      type: "approve_plan",
      command_id: "command:approve-recovered-plan",
      project_id: resumed.project_id,
      run_id: resumed.run_id,
      plan_event_id: resumed.pending_plan!.plan_event_id,
    });
    const completed = await waitForStatus(restarted, resumed.run_id, "completed");
    const stored = await waitForSessionIndex(
      restartedStore,
      resumed.session_id!,
      completed.timeline.length,
    );

    expect(completed.run_id).toBe(started.run_id);
    expect(completed.mode).toBe("execute");
    expect(completed.todos.items[0]?.state).toBe("done");
    expect(stored.entries.map((entry) => entry.event_ref.event_id)).toEqual(
      completed.timeline.map((event) => event.event_id),
    );
  });
});

function planThenExecuteModel(): ModelAdapter {
  let planCreated = false;
  let executeRead = false;
  let executeCompleted = false;
  return {
    name: "plan-then-execute",
    async decide(input) {
      if (input.mode === "plan") {
        if (!planCreated) {
          planCreated = true;
          return toolDecision("decision:plan-todo", "action:plan-todo", "todo_write", {
            operation: "create",
            todo_id: "todo:inspect",
            title: "Inspect the workspace and record evidence",
          });
        }
        return finishDecision("decision:plan-ready", "The structured plan is ready for approval.");
      }
      if (!executeRead) {
        executeRead = true;
        return toolDecision("decision:execute-read", "action:execute-read", "read_file", {
          path: "src/value.ts",
        });
      }
      if (!executeCompleted) {
        executeCompleted = true;
        const evidenceEventId = input.observations.at(-1)?.facts.evidence_event_id;
        if (typeof evidenceEventId !== "string") throw new Error("Runtime did not expose canonical evidence_event_id");
        return toolDecision("decision:complete-todo", "action:complete-todo", "todo_write", {
          operation: "update",
          todo_id: "todo:inspect",
          state: "done",
          evidence_event_ids: [evidenceEventId],
        });
      }
      return finishDecision("decision:execute-finish", "The approved plan was executed.");
    },
  };
}

function toolDecision(
  decisionId: string,
  actionId: string,
  toolName: string,
  arguments_: Record<string, unknown>,
) {
  return {
    decision_id: decisionId,
    kind: "tool_call",
    public_reason: `Use ${toolName}.`,
    evidence_refs: [],
    risk: "low",
    expected_effect: "Produce canonical evidence.",
    tool_call: { action_id: actionId, tool_name: toolName, arguments: arguments_ },
  };
}

function finishDecision(decisionId: string, answer: string) {
  return {
    decision_id: decisionId,
    kind: "finish",
    public_reason: answer,
    evidence_refs: [],
    risk: "none",
    final_answer: answer,
  };
}

async function createHarness(name: string): Promise<{
  dataDir: string;
  sessionsRoot: string;
  workspace: WorkspaceHandle;
}> {
  const root = await mkdtemp(join(tmpdir(), `tracegraph-plan-${name}-`));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "src/value.ts"), "before\n");
  return {
    dataDir: join(root, "data"),
    sessionsRoot: join(root, "data/sessions"),
    workspace: WorkspaceHandleSchema.parse({
      handle_id: `workspace:${name}`,
      project_id: `project:${name}`,
      real_root: await realpath(workspaceRoot),
      workspace_kind: "disposable_fixture",
      capabilities: DISPOSABLE_FIXTURE_CAPABILITIES,
      created_at: "2026-09-19T00:00:00.000Z",
    }),
  };
}

function startInput(workspace: WorkspaceHandle) {
  return {
    command_id: `command:start:${workspace.project_id}`,
    project_id: workspace.project_id,
    task: "Create a plan, wait for approval, and then execute it.",
    mode: "plan" as const,
    workspace,
  };
}

function locator(projection: { session_id?: string | undefined; run_id: string; project_id: string }) {
  return {
    sessionId: projection.session_id!,
    runId: projection.run_id,
    projectId: projection.project_id,
  };
}

function sequentialIdFactory(): (prefix: string) => string {
  let sequence = 0;
  return (prefix) => `${prefix}:${String(++sequence).padStart(6, "0")}`;
}

async function waitForStatus(
  runtime: AgentRuntime,
  runId: string,
  status: "awaiting_plan_approval" | "completed" | "failed",
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const projection = await runtime.getProjection(runId);
    if (projection.status === status) return projection;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const projection = await runtime.getProjection(runId);
  throw new Error(`Timed out waiting for ${status}: ${JSON.stringify({
    status: projection.status,
    failure_code: projection.failure_code,
    events: projection.timeline.map((event) => [event.type, event.summary]),
  })}`);
}

async function waitForSessionIndex(store: JsonlSessionStore, sessionId: string, length: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const stored = await store.readAll(sessionId);
    if (stored.entries.length >= length) return stored;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for the durable Session index");
}
