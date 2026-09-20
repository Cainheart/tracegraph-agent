import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISPOSABLE_FIXTURE_CAPABILITIES,
  BoundPendingApprovalSchema,
  WorkspaceHandleSchema,
  type RunProjection,
  type SessionEventReference,
  type SessionHeader,
  type ToolName,
  type WorkspaceHandle,
} from "@tracegraph/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlEventLedger } from "./event-ledger.js";
import { createAgentRuntime, type AgentRuntime } from "./runtime.js";
import { JsonlSessionStore, type SessionStore } from "./session-store.js";
import { SubagentRegistry } from "./subagent.js";
import type { ModelAdapter, ModelInput } from "./types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 20,
  })));
});

describe("G07 Runtime subagent orchestration", () => {
  it("runs two isolated children concurrently with scoped roles, tools, sessions, and ledgers", async () => {
    const harness = await createHarness("parallel");
    const bothChildrenEntered = deferred<void>();
    const childInputs: ModelInput[] = [];
    let activeChildren = 0;
    let peakChildren = 0;
    const childModel: ModelAdapter = {
      name: "parallel-child-provider",
      async decide(input) {
        childInputs.push(input);
        input.onUsage?.({
          provider: "custom",
          model: "parallel-child-provider",
          input_tokens: 5,
          output_tokens: 2,
          total_tokens: 7,
          request_kind: "initial",
          request_sequence: 1,
          provider_reported_cost: { amount: 0.001, currency: "USD" },
        });
        activeChildren += 1;
        peakChildren = Math.max(peakChildren, activeChildren);
        if (activeChildren === 2) bothChildrenEntered.resolve();
        await bothChildrenEntered.promise;
        activeChildren -= 1;
        return finishDecision(`decision:child:${input.runId}`, `Child ${input.task} completed.`);
      },
    };
    let rootCalls = 0;
    const rootModel: ModelAdapter = {
      name: "root-provider",
      async decide() {
        rootCalls += 1;
        if (rootCalls === 1) {
          return batchDecision("decision:spawn-two", [
            spawnCall("action:spawn:a", "Inspect A in isolation"),
            spawnCall("action:spawn:b", "Inspect B in isolation"),
          ]);
        }
        return finishDecision("decision:root:done", "Both delegated tasks completed.");
      },
    };
    const sessionStore = new JsonlSessionStore(harness.sessionsRoot);
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      sessionStore,
      model: rootModel,
      subagentRegistry: registry(childModel),
      maxParallelSubagents: 2,
      maxSubagentDepth: 1,
      idFactory: sequentialIdFactory(),
    });

    const started = await runtime.startRun(startInput(harness.workspace, {
      conversation_history: [{ role: "user", content: "ROOT_HISTORY_SENTINEL" }],
    }));
    const completed = await waitForStatus(runtime, started.run_id, "completed");
    const subagentEvents = completed.timeline.filter((event) => event.type.startsWith("subagent."));

    expect(peakChildren).toBe(2);
    expect(subagentEvents).toHaveLength(6);
    expect(subagentEvents.filter((event) => event.type === "subagent.started")).toHaveLength(2);
    expect(subagentEvents.filter((event) => event.type === "subagent.message_sent")).toHaveLength(2);
    expect(subagentEvents.filter((event) => event.type === "subagent.completed")).toHaveLength(2);
    expect(completed.subagents).toMatchObject({ active_count: 0 });
    expect(completed.subagents.items).toHaveLength(2);
    for (const child of completed.subagents.items) {
      expect(child.result?.usage).toMatchObject({
        input_tokens: 5,
        output_tokens: 2,
        total_tokens: 7,
        confidence: "provider_reported",
        costs: [{ amount: 0.001, currency: "USD" }],
      });
    }
    expect(childInputs).toHaveLength(2);
    for (const input of childInputs) {
      expect(input.rolePrompt).toBe("Trusted worker role");
      expect(input.toolSchemas.map(({ name }) => name)).toEqual(["read_file"]);
      expect(input.context).not.toContain("ROOT_HISTORY_SENTINEL");
      expect(input.observations).toEqual([]);
      expect(input.maxOutputTokens).toBeGreaterThan(0);
    }

    const ledger = new JsonlEventLedger(join(harness.dataDir, "events"));
    await ledger.initialize();
    for (const child of completed.subagents.items) {
      const replayed = await runtime.replay(child.link.child_run_id);
      expect(replayed.run_id).toBe(child.link.child_run_id);
      expect(replayed.project_id).toBe(completed.project_id);
      expect(replayed.status).toBe("completed");
      const childTerminal = (await ledger.list(child.link.child_run_id)).at(-1)!;
      const receipt = subagentEvents.find((event) => (
        event.type === "subagent.completed"
        && event.data.link !== undefined
        && (event.data.link as { child_run_id?: string }).child_run_id === child.link.child_run_id
      ));
      expect(receipt?.data.child_terminal_event_hash).toBe(childTerminal.event_hash);
    }

    const rootsOnly = await sessionStore.list({ limit: 10 });
    const all = await sessionStore.list({ view: "all", limit: 10 });
    expect(rootsOnly.sessions).toHaveLength(1);
    expect(all.sessions).toHaveLength(3);
    expect(all.sessions.filter((session) => session.parent_session_id === completed.session_id)).toHaveLength(2);
  }, 15_000);

  it("forks a bounded snapshot of parent conversation and observations", async () => {
    const harness = await createHarness("fork");
    let captured: ModelInput | undefined;
    const childModel: ModelAdapter = {
      name: "fork-child-provider",
      async decide(input) {
        captured = input;
        return finishDecision("decision:fork-child", "Fork context inspected.");
      },
    };
    let rootCalls = 0;
    const rootModel: ModelAdapter = {
      name: "fork-root-provider",
      async decide() {
        rootCalls += 1;
        if (rootCalls === 1) {
          return toolDecision("decision:parent-read", "action:parent-read", "read_file", {
            path: "src/value.ts",
          });
        }
        if (rootCalls === 2) {
          return toolDecision(
            "decision:fork-spawn",
            "action:fork-spawn",
            "spawn_subagent",
            spawnCall("action:ignored", "Inspect inherited evidence", "fork").arguments,
          );
        }
        return finishDecision("decision:fork-root", "Forked child completed.");
      },
    };
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      model: rootModel,
      subagentRegistry: registry(childModel),
      idFactory: sequentialIdFactory(),
    });

    const started = await runtime.startRun(startInput(harness.workspace, {
      conversation_history: [{ role: "user", content: "FORK_HISTORY_SENTINEL" }],
    }));
    const completed = await waitForStatus(runtime, started.run_id, "completed");

    expect(captured).toBeDefined();
    expect(captured!.context).toContain("FORK_HISTORY_SENTINEL");
    expect(captured!.observations).toHaveLength(1);
    expect(JSON.stringify(captured!.observations)).toContain("src/value.ts");
    const childStarted = completed.timeline.find((event) => event.type === "subagent.started");
    expect(childStarted?.data.spec).toMatchObject({
      context_scope: "fork",
      fork_context_manifest_ref: expect.any(String),
    });
  });

  it("hard-stops child Runs at both step and token budgets", async () => {
    for (const scenario of ["steps", "tokens"] as const) {
      const harness = await createHarness(`budget-${scenario}`);
      let childCalls = 0;
      const childModel: ModelAdapter = {
        name: `budget-child-${scenario}`,
        async decide(input) {
          childCalls += 1;
          expect(input.maxOutputTokens).toBeGreaterThan(0);
          return toolDecision(
            `decision:${scenario}:read`,
            `action:${scenario}:read`,
            "read_file",
            { path: "src/value.ts" },
          );
        },
      };
      let rootCalls = 0;
      const rootModel: ModelAdapter = {
        name: `budget-root-${scenario}`,
        async decide() {
          rootCalls += 1;
          if (rootCalls === 1) {
            const call = spawnCall(`action:spawn:${scenario}`, `Exercise ${scenario} budget`);
            return toolDecision(
              `decision:spawn:${scenario}`,
              call.action_id,
              call.tool_name,
              {
                ...call.arguments,
                budget: scenario === "steps"
                  ? { max_steps: 1, max_tokens: 10_000 }
                  : { max_steps: 4, max_tokens: 1 },
              },
            );
          }
          return finishDecision(`decision:budget-root:${scenario}`, "Budget receipt recorded.");
        },
      };
      const runtime = await createAgentRuntime({
        dataDir: harness.dataDir,
        model: rootModel,
        subagentRegistry: registry(childModel),
        idFactory: sequentialIdFactory(),
      });

      const started = await runtime.startRun(startInput(harness.workspace));
      const completed = await waitForStatus(runtime, started.run_id, "completed");
      expect(completed.subagents.items).toHaveLength(1);
      expect(completed.subagents.items[0]?.result).toMatchObject({ status: "budget_exceeded" });
      const failedReceipt = completed.timeline.find((event) => event.type === "subagent.failed");
      expect(failedReceipt?.data).toMatchObject({ reason: "budget_exceeded", failure_stage: "execution" });
      const childRunId = completed.subagents.items[0]!.link.child_run_id;
      const child = await runtime.replay(childRunId);
      expect(child.status).toBe("failed");
      expect(child.timeline.at(-1)?.data.code).toBe(
        scenario === "steps" ? "subagent_step_budget_exceeded" : "subagent_token_budget_exceeded",
      );
      expect(childCalls).toBe(scenario === "steps" ? 1 : 0);
    }
  });

  it("hard-denies a forged child tool outside its frozen allowlist", async () => {
    const harness = await createHarness("allowlist");
    const childModel: ModelAdapter = {
      name: "forging-child",
      async decide(input) {
        expect(input.toolSchemas.map(({ name }) => name)).toEqual(["read_file"]);
        return toolDecision("decision:forged", "action:forged", "run_test", { suite: "fixture" });
      },
    };
    let rootCalls = 0;
    const rootModel: ModelAdapter = {
      name: "allowlist-root",
      async decide() {
        rootCalls += 1;
        if (rootCalls === 1) {
          const call = spawnCall("action:spawn:allowlist", "Attempt a forged tool call");
          return toolDecision("decision:spawn:allowlist", call.action_id, call.tool_name, call.arguments);
        }
        return finishDecision("decision:allowlist-root", "Denial receipt recorded.");
      },
    };
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      model: rootModel,
      subagentRegistry: registry(childModel),
      idFactory: sequentialIdFactory(),
    });

    const started = await runtime.startRun(startInput(harness.workspace));
    const completed = await waitForStatus(runtime, started.run_id, "completed");
    const child = await runtime.replay(completed.subagents.items[0]!.link.child_run_id);

    expect(child.status).toBe("failed");
    expect(child.timeline.some((event) => event.type === "tool.started")).toBe(false);
    expect(child.timeline.find((event) => event.type === "policy.denied")?.data)
      .toMatchObject({ reason: "subagent_tool_allowlist" });
    expect(child.timeline.at(-1)?.data.code).toBe("subagent_tool_denied");
    expect(completed.subagents.items[0]?.result).toMatchObject({ status: "failed" });
  });

  it("controls an active blocking spawn through trusted message and interrupt APIs", async () => {
    const messageHarness = await createHarness("active-message");
    const childEntered = deferred<void>();
    const releaseChild = deferred<void>();
    const childContexts: string[] = [];
    let childCalls = 0;
    const messageChild: ModelAdapter = {
      name: "message-child",
      async decide(input) {
        childCalls += 1;
        childContexts.push(input.context);
        if (childCalls === 1) {
          childEntered.resolve();
          await releaseChild.promise;
          return toolDecision("decision:message-read", "action:message-read", "read_file", {
            path: "src/value.ts",
          });
        }
        return finishDecision("decision:message-finish", "Parent steering consumed.");
      },
    };
    let messageRootCalls = 0;
    const messageRoot: ModelAdapter = {
      name: "message-root",
      async decide() {
        messageRootCalls += 1;
        if (messageRootCalls === 1) {
          const call = spawnCall("action:spawn:message", "Wait for parent steering");
          return toolDecision("decision:spawn:message", call.action_id, call.tool_name, call.arguments);
        }
        return finishDecision("decision:message-root", "Message-controlled child completed.");
      },
    };
    const messageRuntime = await createAgentRuntime({
      dataDir: messageHarness.dataDir,
      model: messageRoot,
      subagentRegistry: registry(messageChild),
      idFactory: sequentialIdFactory(),
    });
    const messageStarted = await messageRuntime.startRun(startInput(messageHarness.workspace));
    await childEntered.promise;
    const active = await waitForActiveSubagent(messageRuntime, messageStarted.run_id, messageStarted.project_id);
    await messageRuntime.sendSubagentMessage(messageStarted.run_id, messageStarted.project_id, {
      subagent_id: active.link.subagent_id,
      message: "PARENT_STEERING_SENTINEL",
    });
    releaseChild.resolve();
    const messageCompleted = await waitForStatus(messageRuntime, messageStarted.run_id, "completed");

    expect(childContexts[1]).toContain("PARENT_STEERING_SENTINEL");
    expect(messageCompleted.timeline.filter((event) => event.type === "subagent.message_sent"))
      .toHaveLength(2);
    await expect(messageRuntime.sendSubagentMessage(
      messageStarted.run_id,
      messageStarted.project_id,
      { subagent_id: active.link.subagent_id, message: "too late" },
    )).rejects.toMatchObject({ code: "subagent_terminal" });

    const interruptHarness = await createHarness("active-interrupt");
    const interruptEntered = deferred<void>();
    const interruptChild: ModelAdapter = {
      name: "interrupt-child",
      async decide() {
        interruptEntered.resolve();
        return new Promise(() => undefined);
      },
    };
    let interruptRootCalls = 0;
    const interruptRoot: ModelAdapter = {
      name: "interrupt-root",
      async decide() {
        interruptRootCalls += 1;
        if (interruptRootCalls === 1) {
          const call = spawnCall("action:spawn:interrupt", "Wait until interrupted");
          return toolDecision("decision:spawn:interrupt", call.action_id, call.tool_name, call.arguments);
        }
        return finishDecision("decision:interrupt-root", "Interrupt receipt recorded.");
      },
    };
    const interruptRuntime = await createAgentRuntime({
      dataDir: interruptHarness.dataDir,
      model: interruptRoot,
      subagentRegistry: registry(interruptChild),
      idFactory: sequentialIdFactory(),
    });
    const interruptStarted = await interruptRuntime.startRun(startInput(interruptHarness.workspace));
    await interruptEntered.promise;
    const interruptActive = await waitForActiveSubagent(
      interruptRuntime,
      interruptStarted.run_id,
      interruptStarted.project_id,
    );
    const result = await interruptRuntime.interruptSubagent(
      interruptStarted.run_id,
      interruptStarted.project_id,
      { subagent_id: interruptActive.link.subagent_id, reason: "bounded test interrupt" },
    );
    const interruptCompleted = await waitForStatus(interruptRuntime, interruptStarted.run_id, "completed");

    expect(result.status).toBe("interrupted");
    expect(interruptCompleted.subagents.items[0]?.result).toMatchObject({ status: "interrupted" });
    expect(interruptCompleted.timeline.filter((event) => event.type === "subagent.interrupted"))
      .toHaveLength(1);
  });

  it("cascades a parent abort and closes the child before the parent terminal", async () => {
    const harness = await createHarness("parent-abort");
    const childEntered = deferred<void>();
    const childModel: ModelAdapter = {
      name: "abort-child",
      async decide() {
        childEntered.resolve();
        return new Promise(() => undefined);
      },
    };
    const rootModel: ModelAdapter = {
      name: "abort-root",
      async decide() {
        const call = spawnCall("action:spawn:abort", "Stay active until parent abort");
        return toolDecision("decision:spawn:abort", call.action_id, call.tool_name, call.arguments);
      },
    };
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      model: rootModel,
      subagentRegistry: registry(childModel),
      idFactory: sequentialIdFactory(),
    });
    const started = await runtime.startRun(startInput(harness.workspace));
    await childEntered.promise;
    await waitForActiveSubagent(runtime, started.run_id, started.project_id);

    const cancelled = await runtime.stop({
      type: "stop",
      command_id: "command:stop-parent",
      project_id: started.project_id,
      run_id: started.run_id,
      reason: "Abort parent during delegated work",
    });
    const eventTypes = cancelled.timeline.map((event) => event.type);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.subagents.active_count).toBe(0);
    expect(cancelled.subagents.items[0]?.result).toMatchObject({ status: "interrupted" });
    expect(eventTypes.indexOf("subagent.interrupted")).toBeGreaterThan(-1);
    expect(eventTypes.indexOf("subagent.interrupted")).toBeLessThan(eventTypes.indexOf("run.cancelled"));
  });

  it("reconciles a running child after restart before marking the parent interrupted", async () => {
    const harness = await createHarness("restart-reconcile");
    const sessionStore = memorySessionStore();
    const childEntered = deferred<void>();
    const childModel: ModelAdapter = {
      name: "restart-child",
      async decide() {
        childEntered.resolve();
        return new Promise(() => undefined);
      },
    };
    const rootModel: ModelAdapter = {
      name: "restart-root",
      async decide() {
        const call = spawnCall("action:spawn:restart", "Remain active across simulated restart");
        return toolDecision("decision:spawn:restart", call.action_id, call.tool_name, call.arguments);
      },
    };
    const first = await createAgentRuntime({
      dataDir: harness.dataDir,
      sessionStore,
      model: rootModel,
      subagentRegistry: registry(childModel),
      idFactory: sequentialIdFactory("first"),
    });
    const started = await first.startRun(startInput(harness.workspace));
    await childEntered.promise;
    const active = await waitForActiveSubagent(first, started.run_id, started.project_id);

    const restarted = await createAgentRuntime({
      dataDir: harness.dataDir,
      sessionStore,
      model: rootModel,
      subagentRegistry: registry(childModel),
      idFactory: sequentialIdFactory("restarted"),
    });
    const reconciled = await restarted.markRunInterrupted({
      sessionId: started.session_id!,
      runId: started.run_id,
      projectId: started.project_id,
      reason: "simulated_host_restart",
    });
    const child = await restarted.replay(active.link.child_run_id);
    const eventTypes = reconciled.timeline.map((event) => event.type);

    expect(child.status).toBe("cancelled");
    expect(child.timeline.at(-1)?.data).toMatchObject({ reason: "parent_agent_cancel", recovery: true });
    expect(reconciled.status).toBe("interrupted");
    expect(reconciled.subagents.active_count).toBe(0);
    expect(reconciled.subagents.items[0]?.result).toMatchObject({ status: "interrupted" });
    expect(eventTypes.indexOf("subagent.interrupted")).toBeLessThan(eventTypes.indexOf("run.interrupted"));

    const retried = await restarted.markRunInterrupted({
      sessionId: started.session_id!,
      runId: started.run_id,
      projectId: started.project_id,
      reason: "simulated_host_restart",
    });
    expect(retried.timeline.filter((event) => event.type === "subagent.interrupted")).toHaveLength(1);
    expect(retried.timeline.filter((event) => event.type === "run.interrupted")).toHaveLength(1);
  });

  it("turns a partial durable child launch into a proved execution failure", async () => {
    const harness = await createHarness("partial-launch");
    const failing = partialChildLaunchFailingStore(harness.dataDir, harness.sessionsRoot);
    let childCalls = 0;
    const childModel: ModelAdapter = {
      name: "partial-launch-child",
      async decide() {
        childCalls += 1;
        return finishDecision("decision:unexpected-child", "should not run");
      },
    };
    let rootCalls = 0;
    const rootModel: ModelAdapter = {
      name: "partial-launch-root",
      async decide() {
        rootCalls += 1;
        if (rootCalls === 1) {
          const call = spawnCall("action:spawn:partial", "Fail during durable child launch");
          return toolDecision("decision:spawn:partial", call.action_id, call.tool_name, call.arguments);
        }
        return finishDecision("decision:partial-root", "Partial launch reconciled.");
      },
    };
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      sessionStore: failing.store,
      model: rootModel,
      subagentRegistry: registry(childModel),
      idFactory: sequentialIdFactory(),
    });

    const started = await runtime.startRun(startInput(harness.workspace));
    const completed = await waitForStatus(runtime, started.run_id, "completed");
    const child = await runtime.replay(completed.subagents.items[0]!.link.child_run_id);
    const parentFailure = completed.timeline.find((event) => event.type === "subagent.failed");

    expect(failing.failureCount()).toBe(1);
    expect(childCalls).toBe(0);
    expect(child.status).toBe("failed");
    expect(child.timeline.at(-1)?.data.code).toBe("subagent_launch_failed");
    expect(parentFailure?.data).toMatchObject({
      failure_stage: "execution",
      child_terminal_event_id: child.timeline.at(-1)?.event_id,
      child_terminal_event_hash: expect.any(String),
    });
    expect(completed.subagents.active_count).toBe(0);
  });

  it("cleans process state and the empty child Session when the first child event cannot commit", async () => {
    const harness = await createHarness("first-child-event-failure");
    const failing = firstChildEventFailingStore(harness.dataDir);
    const childModel: ModelAdapter = {
      name: "never-started-child",
      async decide() {
        return finishDecision("decision:never-started", "should not execute");
      },
    };
    let rootCalls = 0;
    const rootModel: ModelAdapter = {
      name: "first-event-failure-root",
      async decide() {
        rootCalls += 1;
        if (rootCalls === 1) {
          const call = spawnCall("action:spawn:first-event", "Fail before child run.created");
          return toolDecision("decision:spawn:first-event", call.action_id, call.tool_name, call.arguments);
        }
        return finishDecision("decision:first-event-root", "Pre-launch cleanup completed.");
      },
    };
    let completed: RunProjection;
    try {
      const runtime = await createAgentRuntime({
        dataDir: harness.dataDir,
        sessionStore: failing.store,
        model: rootModel,
        subagentRegistry: registry(childModel),
        idFactory: sequentialIdFactory("first-event"),
      });
      const started = await runtime.startRun(startInput(harness.workspace));
      completed = await waitForStatus(runtime, started.run_id, "completed");
      const childRunId = completed.subagents.items[0]!.link.child_run_id;

      expect(failing.deletedChildSessions()).toBe(1);
      expect(completed.subagents.items[0]?.result).toMatchObject({ status: "failed" });
      expect(completed.timeline.find((event) => event.type === "subagent.failed")?.data)
        .toMatchObject({ failure_stage: "launch" });
      await expect(runtime.submitUserInput({
        type: "submit_user_input",
        command_id: "command:stale-child-check",
        input_id: "input:stale-child-check",
        project_id: started.project_id,
        run_id: childRunId,
        kind: "message",
        body: "must not reach an unregistered child",
        actor: "parent_agent",
      })).rejects.toMatchObject({ code: "run_not_found" });
    } finally {
      await failing.restore();
    }
  });

  it("keeps the child allowlist hard after preview approval", async () => {
    const harness = await createHarness("approval-allowlist");
    const childModel: ModelAdapter = {
      name: "preview-only-child",
      async decide() {
        return toolDecision("decision:child-preview", "action:child-preview", "preview_patch", {
          path: "src/value.ts",
          expected: "export const value = 1;",
          replacement: "export const value = 2;",
        });
      },
    };
    let rootCalls = 0;
    const rootModel: ModelAdapter = {
      name: "preview-parent",
      async decide() {
        rootCalls += 1;
        if (rootCalls === 1) {
          const call = spawnCall("action:spawn:preview", "Preview a bounded edit");
          return toolDecision("decision:spawn:preview", call.action_id, call.tool_name, call.arguments);
        }
        return finishDecision("decision:preview-parent", "Approval denial receipt recorded.");
      },
    };
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      model: rootModel,
      subagentRegistry: registry(childModel, ["preview_patch"]),
      idFactory: sequentialIdFactory(),
    });
    const started = await runtime.startRun(startInput(harness.workspace));
    const active = await waitForActiveSubagent(runtime, started.run_id, started.project_id);
    const waiting = await waitForStatus(runtime, active.link.child_run_id, "awaiting_approval");
    const pending = BoundPendingApprovalSchema.parse(waiting.pending_approval);

    const failedChild = await runtime.approve({
      type: "approve",
      command_id: "command:approve:child-preview",
      project_id: started.project_id,
      run_id: active.link.child_run_id,
      approval_id: pending.approval_id,
      action_id: pending.action_id,
    });
    const completed = await waitForStatus(runtime, started.run_id, "completed");

    expect(failedChild.status).toBe("failed");
    expect(failedChild.failure_code).toBe("subagent_tool_denied");
    expect(failedChild.timeline.find((event) => event.type === "policy.denied")?.data)
      .toMatchObject({ reason: "subagent_tool_allowlist" });
    expect(failedChild.timeline.some((event) => (
      event.type === "tool.started" && event.data.tool_name === "commit_patch"
    ))).toBe(false);
    expect(failedChild.timeline.some((event) => event.type === "patch.applied")).toBe(false);
    expect(await readFile(join(harness.workspace.real_root, "src", "value.ts"), "utf8"))
      .toBe("export const value = 1;\n");
    expect(completed.subagents.items[0]?.result).toMatchObject({ status: "failed" });
  });

  it("leaves a durable partial child recoverable when terminal persistence is unavailable", async () => {
    const harness = await createHarness("persistent-launch-failure");
    const sabotaged = persistentChildLedgerFailureStore(harness.dataDir);
    const childModel: ModelAdapter = {
      name: "unreachable-partial-child",
      async decide() {
        return finishDecision("decision:unreachable-partial", "should not execute");
      },
    };
    const rootModel: ModelAdapter = {
      name: "partial-recovery-parent",
      async decide() {
        const call = spawnCall("action:spawn:persistent-partial", "Persist before injected failure");
        return toolDecision("decision:spawn:persistent-partial", call.action_id, call.tool_name, call.arguments);
      },
    };
    const first = await createAgentRuntime({
      dataDir: harness.dataDir,
      sessionStore: sabotaged.store,
      model: rootModel,
      subagentRegistry: registry(childModel),
      idFactory: sequentialIdFactory("partial-first"),
    });
    const started = await first.startRun(startInput(harness.workspace));
    let stranded: RunProjection;
    try {
      await waitUntil(() => sabotaged.wasTriggered());
      await new Promise((resolve) => setTimeout(resolve, 50));
      stranded = await first.getProjection(started.run_id);
    } finally {
      await sabotaged.restore();
    }

    expect(stranded.status).toBe("running");
    expect(stranded.subagents.active_count).toBe(1);
    expect(stranded.timeline.some((event) => event.type === "subagent.failed")).toBe(false);

    const restarted = await createAgentRuntime({
      dataDir: harness.dataDir,
      sessionStore: sabotaged.store,
      model: rootModel,
      subagentRegistry: registry(childModel),
      idFactory: sequentialIdFactory("partial-restarted"),
    });
    const reconciled = await restarted.markRunInterrupted({
      sessionId: started.session_id!,
      runId: started.run_id,
      projectId: started.project_id,
      reason: "recover_partial_child",
    });
    const childRunId = reconciled.subagents.items[0]!.link.child_run_id;
    const child = await restarted.replay(childRunId);

    expect(child.status).toBe("cancelled");
    expect(reconciled.status).toBe("interrupted");
    expect(reconciled.subagents.active_count).toBe(0);
    expect(reconciled.timeline.filter((event) => event.type === "subagent.interrupted")).toHaveLength(1);
    expect(reconciled.timeline.find((event) => event.type === "subagent.interrupted")?.data)
      .toMatchObject({ child_terminal_event_hash: expect.any(String) });
  });
});

function registry(model: ModelAdapter, tools: readonly ToolName[] = ["read_file"]): SubagentRegistry {
  return new SubagentRegistry([{
    name: "worker",
    providerKey: "provider:worker",
    rolePromptVersion: "worker.v1",
    rolePrompt: "Trusted worker role",
    toolAllowlist: tools,
    defaultBudget: { max_steps: 4, max_tokens: 10_000 },
    budgetCeiling: { max_steps: 8, max_tokens: 20_000 },
    model,
  }]);
}

async function createHarness(name: string): Promise<{
  dataDir: string;
  sessionsRoot: string;
  workspace: WorkspaceHandle;
}> {
  const root = await mkdtemp(join(tmpdir(), `tracegraph-subagent-${name}-`));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "src", "value.ts"), "export const value = 1;\n");
  return {
    dataDir: join(root, "data"),
    sessionsRoot: join(root, "data", "sessions"),
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

function startInput(
  workspace: WorkspaceHandle,
  overrides: { conversation_history?: Array<{ role: "user" | "assistant"; content: string }> } = {},
) {
  return {
    command_id: `command:start:${workspace.project_id}`,
    project_id: workspace.project_id,
    task: "Delegate bounded evidence work.",
    mode: "execute" as const,
    workspace,
    ...overrides,
  };
}

function spawnCall(actionId: string, task: string, contextScope: "isolated" | "fork" = "isolated") {
  return {
    action_id: actionId,
    tool_name: "spawn_subagent" as const,
    arguments: {
      profile_name: "worker",
      task_packet: { task },
      context_scope: contextScope,
    },
  };
}

function batchDecision(decisionId: string, toolCalls: ReturnType<typeof spawnCall>[]) {
  return {
    decision_id: decisionId,
    kind: "tool_call" as const,
    public_reason: "Delegate independent bounded tasks.",
    evidence_refs: [],
    risk: "low" as const,
    expected_effect: "Return child receipts.",
    tool_calls: toolCalls,
  };
}

function toolDecision(
  decisionId: string,
  actionId: string,
  toolName: ToolName,
  arguments_: Record<string, unknown>,
) {
  return {
    decision_id: decisionId,
    kind: "tool_call" as const,
    public_reason: `Use ${toolName}.`,
    evidence_refs: [],
    risk: "low" as const,
    expected_effect: "Produce a bounded observation.",
    tool_call: { action_id: actionId, tool_name: toolName, arguments: arguments_ },
  };
}

function finishDecision(decisionId: string, answer: string) {
  return {
    decision_id: decisionId,
    kind: "finish" as const,
    public_reason: answer,
    evidence_refs: [],
    risk: "none" as const,
    final_answer: answer,
  };
}

function sequentialIdFactory(namespace = "g07"): (prefix: string) => string {
  let sequence = 0;
  return (prefix) => `${prefix}:${namespace}:${String(++sequence).padStart(6, "0")}`;
}

function deferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise(value as T) };
}

async function waitForStatus(
  runtime: AgentRuntime,
  runId: string,
  status: RunProjection["status"],
): Promise<RunProjection> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    let projection: RunProjection;
    try {
      projection = await runtime.getProjection(runId);
    } catch (error) {
      if ((error as { code?: unknown }).code === "run_not_found") {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      throw error;
    }
    if (projection.status === status) return projection;
    if (["completed", "failed", "cancelled"].includes(projection.status)) {
      throw new Error(`Run reached ${projection.status} while waiting for ${status}: ${JSON.stringify(
        projection.timeline.map((event) => ({ type: event.type, data: event.data })),
      )}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const projection = await runtime.getProjection(runId);
  throw new Error(`Timed out waiting for ${status}: ${JSON.stringify({
    status: projection.status,
    events: projection.timeline.map((event) => event.type),
  })}`);
}

async function waitForActiveSubagent(
  runtime: AgentRuntime,
  runId: string,
  projectId: string,
) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const projection = await runtime.listSubagents(runId, projectId);
    const active = projection.items.find((item) => item.status === "running");
    if (active !== undefined) return active;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for an active subagent");
}

function memorySessionStore(): SessionStore {
  const sessions = new Map<string, { header: SessionHeader; entries: SessionEventReference[] }>();
  return {
    initialize: async () => undefined,
    async create(header) {
      if (sessions.has(header.session_id)) throw new Error("session already exists");
      sessions.set(header.session_id, { header, entries: [] });
      return header;
    },
    async append(sessionId, entry) {
      const session = sessions.get(sessionId);
      if (session === undefined) throw new Error("session missing");
      if (session.entries.some((candidate) => candidate.event_ref.event_id === entry.event_ref.event_id)) return;
      session.entries.push(entry);
      if (!session.header.run_ids.includes(entry.event_ref.run_id)) {
        session.header = { ...session.header, run_ids: [...session.header.run_ids, entry.event_ref.run_id] };
      }
    },
    async readAll(sessionId) {
      const session = sessions.get(sessionId);
      if (session === undefined) throw new Error("session missing");
      return { header: session.header, entries: [...session.entries], truncated: false };
    },
    async list() {
      return { sessions: [] };
    },
    async rename(sessionId, title) {
      const session = sessions.get(sessionId);
      if (session === undefined) throw new Error("session missing");
      session.header = { ...session.header, title };
      return {
        session_id: session.header.session_id,
        project_id: session.header.project_id,
        created_at: session.header.created_at,
        updated_at: session.header.created_at,
        title,
        run_ids: session.header.run_ids,
        entry_count: session.entries.length,
        ...(session.header.parent_session_id === undefined
          ? {}
          : { parent_session_id: session.header.parent_session_id }),
      };
    },
    async delete(sessionId) {
      sessions.delete(sessionId);
    },
    async acquireLease(sessionId) {
      if (!sessions.has(sessionId)) throw new Error("session missing");
      return {
        sessionId,
        pid: process.pid,
        hostname: "memory-test",
        heartbeat: async () => undefined,
        release: async () => undefined,
      };
    },
  };
}

function partialChildLaunchFailingStore(dataDir: string, sessionsRoot: string): {
  store: SessionStore;
  failureCount(): number;
} {
  const delegate = new JsonlSessionStore(sessionsRoot);
  const ledger = new JsonlEventLedger(join(dataDir, "events"));
  const childSessionIds = new Set<string>();
  let failures = 0;
  const store: SessionStore = {
    initialize: async () => {
      await Promise.all([delegate.initialize(), ledger.initialize()]);
    },
    async create(header) {
      if (header.parent_session_id !== undefined) childSessionIds.add(header.session_id);
      return delegate.create(header);
    },
    async append(sessionId, entry, lease) {
      if (failures === 0 && childSessionIds.has(sessionId)) {
        const event = (await ledger.list(entry.event_ref.run_id))
          .find((candidate) => candidate.event_id === entry.event_ref.event_id);
        if (event?.type === "permission.configured") {
          failures += 1;
          throw new Error("Injected child Session index failure after canonical append");
        }
      }
      await delegate.append(sessionId, entry, lease);
    },
    readAll: (sessionId, lease) => delegate.readAll(sessionId, lease),
    list: (query, allowedProjectIds) => delegate.list(query, allowedProjectIds),
    rename: (sessionId, title, lease) => delegate.rename(sessionId, title, lease),
    delete: (sessionId, lease) => delegate.delete(sessionId, lease),
    acquireLease: (sessionId) => delegate.acquireLease(sessionId),
  };
  return { store, failureCount: () => failures };
}

function persistentChildLedgerFailureStore(dataDir: string): {
  store: SessionStore;
  wasTriggered(): boolean;
  restore(): Promise<void>;
} {
  const delegate = memorySessionStore();
  const ledger = new JsonlEventLedger(join(dataDir, "events"));
  const eventsRoot = join(dataDir, "events");
  const childSessionIds = new Set<string>();
  let triggered = false;
  const store: SessionStore = {
    initialize: async () => {
      await Promise.all([delegate.initialize(), ledger.initialize()]);
    },
    async create(header) {
      if (header.parent_session_id !== undefined) childSessionIds.add(header.session_id);
      return delegate.create(header);
    },
    async append(sessionId, entry, lease) {
      if (!triggered && childSessionIds.has(sessionId)) {
        const event = (await ledger.list(entry.event_ref.run_id))
          .find((candidate) => candidate.event_id === entry.event_ref.event_id);
        if (event?.type === "permission.configured") {
          triggered = true;
          await chmod(eventsRoot, 0o500);
          throw new Error("Injected persistent canonical child terminal failure");
        }
      }
      await delegate.append(sessionId, entry, lease);
    },
    readAll: (sessionId, lease) => delegate.readAll(sessionId, lease),
    list: (query, allowedProjectIds) => delegate.list(query, allowedProjectIds),
    rename: (sessionId, title, lease) => delegate.rename(sessionId, title, lease),
    delete: (sessionId, lease) => delegate.delete(sessionId, lease),
    acquireLease: (sessionId) => delegate.acquireLease(sessionId),
  };
  return {
    store,
    wasTriggered: () => triggered,
    restore: async () => chmod(eventsRoot, 0o700),
  };
}

function firstChildEventFailingStore(dataDir: string): {
  store: SessionStore;
  deletedChildSessions(): number;
  restore(): Promise<void>;
} {
  const delegate = memorySessionStore();
  const ledger = new JsonlEventLedger(join(dataDir, "events"));
  const eventsRoot = join(dataDir, "events");
  const childSessionIds = new Set<string>();
  let sabotaged = false;
  let deletedChildren = 0;
  const restore = async () => {
    if (sabotaged) await chmod(eventsRoot, 0o700);
  };
  const store: SessionStore = {
    initialize: async () => {
      await Promise.all([delegate.initialize(), ledger.initialize()]);
    },
    async create(header) {
      if (header.parent_session_id !== undefined) childSessionIds.add(header.session_id);
      return delegate.create(header);
    },
    async append(sessionId, entry, lease) {
      await delegate.append(sessionId, entry, lease);
      if (!sabotaged && !childSessionIds.has(sessionId)) {
        const event = (await ledger.list(entry.event_ref.run_id))
          .find((candidate) => candidate.event_id === entry.event_ref.event_id);
        if (event?.type === "subagent.started") {
          sabotaged = true;
          await chmod(eventsRoot, 0o500);
        }
      }
    },
    readAll: (sessionId, lease) => delegate.readAll(sessionId, lease),
    list: (query, allowedProjectIds) => delegate.list(query, allowedProjectIds),
    rename: (sessionId, title, lease) => delegate.rename(sessionId, title, lease),
    async delete(sessionId, lease) {
      if (childSessionIds.has(sessionId)) {
        await restore();
        deletedChildren += 1;
      }
      await delegate.delete(sessionId, lease);
    },
    acquireLease: (sessionId) => delegate.acquireLease(sessionId),
  };
  return {
    store,
    deletedChildSessions: () => deletedChildren,
    restore,
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for test fault injection");
}
