import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISPOSABLE_FIXTURE_CAPABILITIES,
  UserInputConsumedDataSchema,
  UserInputQueuedDataSchema,
  WorkspaceHandleSchema,
  type RunProjection,
  type WorkspaceHandle,
} from "@tracegraph/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { registerSecretForRedaction, sha256, stableStringify } from "../../kernel/crypto.js";
import { JsonlEventLedger } from "../evidence/event-ledger.js";
import { CORE_BUILTIN_PERMISSION_PRESETS, createEffectivePermissionPolicy } from "../tools/policy-engine.js";
import { createAgentRuntime, type AgentRuntime } from "./runtime.js";
import { JsonlSessionStore, SessionNotFoundError, SessionPathSafetyError } from "../session/session-store.js";
import { createDefaultToolRegistry } from "../tools/index.js";
import type { CodeGraphProvider, ModelAdapter } from "../../kernel/types.js";

const roots: string[] = [];

/**
 * These cases abandon a Runtime mid-Run next to a second writer on the same
 * tree, and the pending-queue capacity case queues 99 inputs through a Session
 * index that is rewritten for every entry. The default 5s is too tight for that
 * on a contended runner.
 */
const STEERING_TEST_TIMEOUT_MS = 30_000;

type TrackedRuntime = Awaited<ReturnType<typeof createAgentRuntime>>;

const trackedRuntimes: TrackedRuntime[] = [];

/** Drains nonblocking background work so temporary data directories can be removed safely. */
async function drainTrackedRuntimes(): Promise<void> {
  await Promise.all(trackedRuntimes.splice(0).map((runtime) => runtime.shutdownBackgroundWork?.()));
}

/** Registers a Runtime so teardown can drain its background work before its data directory goes away. */
async function createTrackedRuntime(
  options: Parameters<typeof createAgentRuntime>[0],
): Promise<TrackedRuntime> {
  const runtime = await createAgentRuntime(options);
  trackedRuntimes.push(runtime);
  return runtime;
}

afterEach(async () => {
  await drainTrackedRuntimes();
  // Several cases deliberately abandon a Runtime mid-Run next to a second
  // writer on the same tree, so a queued ledger/session write can still land
  // while the tree is being walked and surface as ENOTEMPTY on rmdir. force
  // only swallows ENOENT, so retry the whole removal instead.
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 20,
  })));
});

describe("G14 Runtime steering and cancellation", { timeout: STEERING_TEST_TIMEOUT_MS }, () => {
  it("consumes three queued messages FIFO at three distinct model safe points", async () => {
    const harness = await createHarness("fifo");
    const firstCall = deferred<void>();
    const releaseFirstCall = deferred<void>();
    const contexts: string[] = [];
    let calls = 0;
    const model: ModelAdapter = {
      name: "three-safe-points",
      async decide(input) {
        calls += 1;
        contexts.push(input.context);
        if (calls === 1) {
          firstCall.resolve();
          await releaseFirstCall.promise;
        }
        if (calls <= 3) {
          return toolDecision(`decision:${calls}`, `action:${calls}`, "read_file", {
            path: "src/value.ts",
          });
        }
        return finishDecision(`decision:${calls}`, "Steering was applied in order.");
      },
    };
    const runtime = await createTrackedRuntime({ dataDir: harness.dataDir, model, maxTurns: 8 });
    const started = await runtime.startRun(startInput(harness.workspace));
    await firstCall.promise;

    for (let index = 1; index <= 3; index += 1) {
      await runtime.submitUserInput(inputCommand(started, {
        commandId: `command:message:${index}`,
        inputId: `input:message:${index}`,
        body: `steer message ${index}`,
      }));
    }
    releaseFirstCall.resolve();

    const completed = await waitForStatus(runtime, started.run_id, "completed");
    const consumed = completed.timeline
      .filter((event) => event.type === "user.input_consumed")
      .map((event) => UserInputConsumedDataSchema.parse(event.data));

    expect(consumed.map((item) => item.input_id)).toEqual([
      "input:message:1",
      "input:message:2",
      "input:message:3",
    ]);
    expect(consumed.map((item) => item.at_step)).toEqual([2, 3, 4]);
    expect(contexts[1]).toContain("steer message 1");
    expect(contexts[1]).not.toContain("steer message 2");
    expect(contexts[2]).toContain("steer message 2");
    expect(contexts[2]).not.toContain("steer message 3");
    expect(contexts[3]).toContain("steer message 3");
    expect(completed.input_queue.pending).toEqual([]);
  });

  it("makes command and input ids idempotent while detecting redaction collisions", async () => {
    const harness = await createHarness("idempotency");
    const entered = deferred<void>();
    const model: ModelAdapter = {
      name: "blocked-for-idempotency",
      async decide(input) {
        entered.resolve();
        return waitForAbort(input.signal);
      },
    };
    const runtime = await createTrackedRuntime({ dataDir: harness.dataDir, model });
    const started = await runtime.startRun(startInput(harness.workspace));
    await entered.promise;
    const first = inputCommand(started, {
      commandId: "command:secret-one",
      inputId: "input:redacted",
      body: "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456",
    });

    await expect(runtime.submitUserInput(first)).resolves.toMatchObject({ disposition: "queued" });
    await expect(runtime.submitUserInput(first)).resolves.toMatchObject({ disposition: "duplicate" });
    await expect(runtime.submitUserInput({
      ...first,
      command_id: "command:same-input-retry",
    })).resolves.toMatchObject({ disposition: "duplicate" });
    await expect(runtime.submitUserInput({
      ...first,
      command_id: "command:input-conflict",
      body: "GITHUB_TOKEN=ghp_zyxwvutsrqponmlkjihgfedcba654321",
    })).rejects.toMatchObject({ code: "input_id_conflict" });
    await expect(runtime.submitUserInput({
      ...first,
      input_id: "input:command-conflict",
      body: "different",
    })).rejects.toMatchObject({ code: "command_id_conflict" });

    await runtime.submitUserInput(cancelCommand(started, "command:cleanup", "input:cleanup"));
    const cancelled = await waitForStatus(runtime, started.run_id, "cancelled");
    expect(cancelled.timeline.filter((event) => (
      event.type === "user.input_queued" && event.data.input !== undefined
    ))).toHaveLength(3);
  });

  it("keeps raw-digest retries idempotent when redaction state changes", async () => {
    const harness = await createHarness("redaction-drift");
    const entered = deferred<void>();
    const model: ModelAdapter = {
      name: "blocked-for-redaction-drift",
      async decide(input) {
        entered.resolve();
        return waitForAbort(input.signal);
      },
    };
    const runtime = await createTrackedRuntime({ dataDir: harness.dataDir, model });
    const started = await runtime.startRun(startInput(harness.workspace));
    await entered.promise;
    const body = "opaque-steering-value-9f3e4a72";
    const first = inputCommand(started, {
      commandId: "command:redaction-drift:first",
      inputId: "input:redaction-drift",
      body,
    });

    await expect(runtime.submitUserInput(first)).resolves.toMatchObject({
      disposition: "queued",
      input: { body },
    });
    registerSecretForRedaction(body);
    await expect(runtime.submitUserInput({
      ...first,
      command_id: "command:redaction-drift:retry",
    })).resolves.toMatchObject({
      disposition: "duplicate",
      input: {
        input_id: "input:redaction-drift",
        body: "[REDACTED_REGISTERED_SECRET]",
      },
    });

    const expandingSecret = "q7V9m2K4";
    const expandingBody = expandingSecret.repeat(1_000);
    const expanding = inputCommand(started, {
      commandId: "command:redaction-expansion:first",
      inputId: "input:redaction-expansion",
      body: expandingBody,
    });
    await runtime.submitUserInput(expanding);
    registerSecretForRedaction(expandingSecret);
    const expandedRetry = await runtime.submitUserInput({
      ...expanding,
      command_id: "command:redaction-expansion:retry",
    });
    expect(expandedRetry.disposition).toBe("duplicate");
    expect(expandedRetry.input.body).not.toContain(expandingSecret);
    expect(expandedRetry.input.body).toHaveLength(8_000);

    const events = await new JsonlEventLedger(join(harness.dataDir, "events")).list(started.run_id);
    expect(events.filter((event) => event.type === "user.input_queued")).toHaveLength(4);

    await runtime.submitUserInput(cancelCommand(started, "command:redaction-drift:cleanup", "input:redaction-drift:cleanup"));
    await waitForStatus(runtime, started.run_id, "cancelled");
  });

  it("replays durable message and cancel submissions after Runtime restart", async () => {
    const harness = await createHarness("restart-idempotency");
    const entered = deferred<void>();
    const model: ModelAdapter = {
      name: "blocked-for-restart-idempotency",
      async decide(input) {
        entered.resolve();
        return waitForAbort(input.signal);
      },
    };
    // This case restarts without a Session store, so the abandoned Runtime owns
    // no Session index write for the two restarts below to wait out.
    const first = await createTrackedRuntime({ dataDir: harness.dataDir, model });
    const started = await first.startRun(startInput(harness.workspace));
    await entered.promise;
    const message = inputCommand(started, {
      commandId: "command:restart-message",
      inputId: "input:restart-message",
      body: "replay this durable message",
    });
    await first.submitUserInput(message);
    const aliasedMessage = {
      ...message,
      command_id: "command:restart-message-alias",
    };
    await expect(first.submitUserInput(aliasedMessage)).resolves.toMatchObject({
      disposition: "duplicate",
      input: { input_id: "input:restart-message" },
    });

    const restarted = await createTrackedRuntime({ dataDir: harness.dataDir, model });
    await expect(restarted.submitUserInput(message)).resolves.toMatchObject({
      disposition: "duplicate",
      input: { input_id: "input:restart-message" },
    });
    await expect(restarted.submitUserInput({
      ...message,
      input_id: "input:restart-command-conflict",
      body: "different payload",
    })).rejects.toMatchObject({ code: "command_id_conflict" });
    await expect(restarted.submitUserInput({
      ...aliasedMessage,
      input_id: "input:restart-alias-conflict",
      body: "a command alias cannot be rebound after restart",
    })).rejects.toMatchObject({ code: "command_id_conflict" });

    const cancel = cancelCommand(started, "command:restart-cancel", "input:restart-cancel");
    await first.submitUserInput(cancel);
    await waitForStatus(first, started.run_id, "cancelled");
    const afterTerminalRestart = await createTrackedRuntime({ dataDir: harness.dataDir, model });
    await expect(afterTerminalRestart.submitUserInput(cancel)).resolves.toMatchObject({
      disposition: "duplicate",
      input: {
        input_id: "input:restart-cancel",
        consumed_at: expect.any(String),
        consumed_at_step: expect.any(Number),
      },
    });
    await expect(afterTerminalRestart.submitUserInput(inputCommand(started, {
      commandId: "command:new-after-terminal-restart",
      inputId: "input:new-after-terminal-restart",
      body: "terminal runs reject genuinely new steering after restart",
    }))).rejects.toMatchObject({ code: "run_terminal" });
  });

  it("durably binds a duplicate command while interrupted and reports precise restart status", async () => {
    const harness = await createHarness("interrupted-command-binding");
    let now = new Date("2026-09-19T00:00:00.000Z");
    const idFactory = sequentialIdFactory();
    const entered = deferred<void>();
    const model: ModelAdapter = {
      name: "interrupted-command-binding",
      async decide() {
        entered.resolve();
        return new Promise(() => undefined);
      },
    };
    const first = await createTrackedRuntime({
      dataDir: harness.dataDir,
      sessionStore: new JsonlSessionStore(harness.sessionsRoot, {
        now: () => now,
        pid: 2_147_483_646,
      }),
      model,
      now: () => now,
      idFactory,
    });
    const started = await first.startRun(startInput(harness.workspace));
    await entered.promise;
    const original = inputCommand(started, {
      commandId: "command:interrupted-original",
      inputId: "input:interrupted-original",
      body: "persist this steering command binding",
    });
    await first.submitUserInput(original);

    now = new Date("2026-09-19T00:02:00.000Z");
    await settleSessionIndexBeforeRestart(
      harness.sessionsRoot,
      await first.getProjection(started.run_id),
    );
    const restarted = await createTrackedRuntime({
      dataDir: harness.dataDir,
      sessionStore: new JsonlSessionStore(harness.sessionsRoot, { now: () => now }),
      model,
      now: () => now,
      idFactory,
    });
    const interrupted = await restarted.markRunInterrupted(locator(started));
    expect(interrupted.status).toBe("interrupted");
    const alias = { ...original, command_id: "command:interrupted-alias" };
    await expect(restarted.submitUserInput(alias)).resolves.toMatchObject({
      disposition: "duplicate",
      input: { input_id: original.input_id },
    });
    await expect(restarted.submitUserInput(inputCommand(started, {
      commandId: "command:new-while-interrupted",
      inputId: "input:new-while-interrupted",
      body: "a genuinely new input cannot mutate an interrupted run",
    }))).rejects.toMatchObject({ code: "run_not_mutable" });

    await settleSessionIndexBeforeRestart(
      harness.sessionsRoot,
      await restarted.getProjection(started.run_id),
    );
    const restartedAgain = await createTrackedRuntime({ dataDir: harness.dataDir, model });
    await expect(restartedAgain.submitUserInput({
      ...alias,
      input_id: "input:interrupted-alias-rebound",
      body: "the durable alias cannot be rebound",
    })).rejects.toMatchObject({ code: "command_id_conflict" });
  });

  it("namespaces hostile command ids away from consumed and terminal event keys", async () => {
    const consumeHarness = await createHarness("idempotency-namespace-consume");
    const entered = deferred<void>();
    const release = deferred<void>();
    let calls = 0;
    const consumeModel: ModelAdapter = {
      name: "idempotency-namespace-consume",
      async decide() {
        calls += 1;
        if (calls === 1) {
          entered.resolve();
          await release.promise;
          return toolDecision("decision:namespace", "action:namespace", "read_file", {
            path: "src/value.ts",
          });
        }
        return finishDecision("decision:namespace:finish", "Namespace remained isolated");
      },
    };
    const consumeRuntime = await createTrackedRuntime({ dataDir: consumeHarness.dataDir, model: consumeModel });
    const consumeStarted = await consumeRuntime.startRun(startInput(consumeHarness.workspace));
    await entered.promise;
    const inputId = "input:namespace-consumed";
    await consumeRuntime.submitUserInput(inputCommand(consumeStarted, {
      commandId: `${consumeStarted.run_id}:user.input_consumed:${sha256(inputId)}`,
      inputId,
      body: "must still be consumed exactly once",
    }));
    release.resolve();
    const completed = await waitForStatus(consumeRuntime, consumeStarted.run_id, "completed");
    expect(completed.timeline.filter((event) => (
      event.type === "user.input_consumed" && event.data.input_id === inputId
    ))).toHaveLength(1);
    expect(completed.input_queue.pending).toEqual([]);

    const terminalHarness = await createHarness("idempotency-namespace-terminal");
    const terminalEntered = deferred<void>();
    const terminalModel: ModelAdapter = {
      name: "idempotency-namespace-terminal",
      async decide(input) {
        terminalEntered.resolve();
        return waitForAbort(input.signal);
      },
    };
    const terminalRuntime = await createTrackedRuntime({ dataDir: terminalHarness.dataDir, model: terminalModel });
    const terminalStarted = await terminalRuntime.startRun(startInput(terminalHarness.workspace));
    await terminalEntered.promise;
    await terminalRuntime.submitUserInput(cancelCommand(
      terminalStarted,
      `${terminalStarted.run_id}:terminal`,
      "input:namespace-terminal",
    ));
    const cancelled = await waitForStatus(terminalRuntime, terminalStarted.run_id, "cancelled");
    assertCanonicalCancellation(cancelled);
  });

  it("reserves the final pending-queue slot for durable cancellation", async () => {
    const harness = await createHarness("cancel-capacity");
    const entered = deferred<void>();
    const release = deferred<void>();
    let calls = 0;
    const model: ModelAdapter = {
      name: "blocked-for-capacity",
      async decide(input) {
        calls += 1;
        if (calls === 1) {
          entered.resolve();
          await release.promise;
          return toolDecision("decision:capacity", "action:capacity", "read_file", {
            path: "src/value.ts",
          });
        }
        return waitForAbort(input.signal);
      },
    };
    const runtime = await createTrackedRuntime({ dataDir: harness.dataDir, model });
    const started = await runtime.startRun(startInput(harness.workspace));
    await entered.promise;

    for (let index = 0; index < 99; index += 1) {
      await runtime.submitUserInput(inputCommand(started, {
        commandId: `command:capacity:${index}`,
        inputId: `input:capacity:${index}`,
        body: `queued ${index}`,
      }));
    }
    const overflow = inputCommand(started, {
      commandId: "command:capacity:overflow",
      inputId: "input:capacity:overflow",
      body: "must preserve the cancel slot",
    });
    await expect(runtime.submitUserInput(overflow)).rejects.toMatchObject({ code: "input_queue_full" });

    // A rejected in-process binding is not cached forever. Once one safe point
    // frees capacity, the exact command retries against the canonical Ledger.
    release.resolve();
    await waitForPendingCount(runtime, started.run_id, 98);
    await expect(runtime.submitUserInput(overflow)).resolves.toMatchObject({ disposition: "queued" });

    await expect(runtime.submitUserInput(
      cancelCommand(started, "command:capacity:cancel", "input:capacity:cancel"),
    )).resolves.toMatchObject({ disposition: "queued" });
    const cancelled = await waitForStatus(runtime, started.run_id, "cancelled");
    expect(cancelled.input_queue.pending).toHaveLength(99);
    assertCanonicalCancellation(cancelled);
  });

  it("aborts an in-flight model only after the cancel input is durable", async () => {
    const harness = await createHarness("cancel-model");
    const entered = deferred<void>();
    const abortObserved = deferred<void>();
    const releaseAfterAbort = deferred<void>();
    let observedSignal: AbortSignal | undefined;
    const model: ModelAdapter = {
      name: "abortable-model",
      async decide(input) {
        observedSignal = input.signal;
        entered.resolve();
        return new Promise((resolve) => {
          input.signal?.addEventListener("abort", () => {
            abortObserved.resolve();
            void releaseAfterAbort.promise.then(() => resolve(
              toolDecision(
                "decision:cancel-model:late",
                "action:cancel-model:late",
                "read_file",
                { path: "src/value.ts" },
              ),
            ));
          }, { once: true });
        });
      },
    };
    const runtime = await createTrackedRuntime({ dataDir: harness.dataDir, model });
    const started = await runtime.startRun(startInput(harness.workspace));
    await entered.promise;

    const submitted = await runtime.submitUserInput(
      cancelCommand(started, "command:cancel-model", "input:cancel-model"),
    );
    expect(submitted.disposition).toBe("queued");
    expect(observedSignal?.aborted).toBe(true);
    await abortObserved.promise;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await runtime.getProjection(started.run_id)).status).not.toBe("cancelled");
    releaseAfterAbort.resolve();

    const cancelled = await waitForStatus(runtime, started.run_id, "cancelled");
    assertCanonicalCancellation(cancelled);
    const queued = cancelled.timeline.find((event) => event.type === "user.input_queued")!;
    const consumed = cancelled.timeline.find((event) => event.type === "user.input_consumed")!;
    const terminal = cancelled.timeline.find((event) => event.type === "run.cancelled")!;
    expect(cancelled.timeline.some((event) => (
      event.type === "tool.started" && event.sequence > queued.sequence
    ))).toBe(false);
    expect([queued.sequence, consumed.sequence, terminal.sequence]).toEqual(
      [queued.sequence, consumed.sequence, terminal.sequence].toSorted((left, right) => left - right),
    );
  });

  it("re-arms cancellation when retry discovers a Ledger commit missing its Session index", async () => {
    const harness = await createHarness("cancel-ledger-replay");
    const entered = deferred<void>();
    let observedSignal: AbortSignal | undefined;
    const model: ModelAdapter = {
      name: "cancel-ledger-replay",
      async decide(input) {
        observedSignal = input.signal;
        entered.resolve();
        return waitForAbort(input.signal);
      },
    };
    const runtime = await createTrackedRuntime({ dataDir: harness.dataDir, model });
    const started = await runtime.startRun(startInput(harness.workspace));
    await entered.promise;
    const command = cancelCommand(
      started,
      "command:cancel-ledger-replay",
      "input:cancel-ledger-replay",
    );
    const submittedAt = new Date().toISOString();
    const externalLedger = new JsonlEventLedger(join(harness.dataDir, "events"));
    await externalLedger.append({
      type: "user.input_queued",
      project_id: started.project_id,
      run_id: started.run_id,
      ...(started.session_id === undefined ? {} : { session_id: started.session_id }),
      attempt: 0,
      summary: "Simulated Event Ledger commit before Session indexing failed",
      artifact_refs: [],
      idempotency_key: `command:${sha256(command.command_id)}:user.input_queued`,
      data: UserInputQueuedDataSchema.parse({
        input: {
          input_id: command.input_id,
          run_id: command.run_id,
          kind: command.kind,
          body: command.body,
          actor: command.actor,
          submitted_at: submittedAt,
        },
        _internal_command_digest: sha256(stableStringify(command)),
        _internal_input_digest: sha256(stableStringify({
          kind: command.kind,
          body: command.body,
        })),
      }),
    });

    await expect(runtime.submitUserInput(command)).resolves.toMatchObject({
      disposition: "duplicate",
      input: { input_id: command.input_id },
    });
    expect(observedSignal?.aborted).toBe(true);
    const cancelled = await waitForStatus(runtime, started.run_id, "cancelled");
    assertCanonicalCancellation(cancelled);
  });

  it("keeps cancellation pending until an aborted Tool executor actually settles", async () => {
    const harness = await createHarness("cancel-tool-quiescence");
    const entered = deferred<void>();
    const releaseTool = deferred<void>();
    const registry = createDefaultToolRegistry();
    const base = registry.get("read_file");
    if (base === undefined) throw new Error("read_file tool is unavailable");
    registry.register({
      ...base,
      async execute(input, context) {
        entered.resolve();
        await releaseTool.promise;
        return base.execute(input, context);
      },
    });
    let modelCalls = 0;
    const model: ModelAdapter = {
      name: "cancel-tool-quiescence",
      async decide() {
        modelCalls += 1;
        return toolDecision("decision:cancel-tool", "action:cancel-tool", "read_file", {
          path: "src/value.ts",
        });
      },
    };
    const runtime = await createTrackedRuntime({
      dataDir: harness.dataDir,
      model,
      toolRegistry: registry,
    });
    const started = await runtime.startRun(startInput(harness.workspace));
    await entered.promise;

    await runtime.submitUserInput(cancelCommand(
      started,
      "command:cancel-tool-quiescence",
      "input:cancel-tool-quiescence",
    ));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await runtime.getProjection(started.run_id)).status).not.toBe("cancelled");
    expect(modelCalls).toBe(1);

    releaseTool.resolve();
    const cancelled = await waitForStatus(runtime, started.run_id, "cancelled");
    const toolSettled = cancelled.timeline.find((event) => (
      event.type === "tool.completed" || event.type === "tool.failed" || event.type === "tool.unknown"
    ))!;
    const inputConsumed = cancelled.timeline.find((event) => event.type === "user.input_consumed")!;
    const terminal = cancelled.timeline.find((event) => event.type === "run.cancelled")!;
    expect(toolSettled.sequence).toBeLessThan(inputConsumed.sequence);
    expect(inputConsumed.sequence).toBeLessThan(terminal.sequence);
    expect(modelCalls).toBe(1);
    assertCanonicalCancellation(cancelled);
  });

  it("aborts a pending policy answerer without granting or denying after durable cancel", async () => {
    const harness = await createHarness("cancel-policy-answerer");
    const answering = deferred<void>();
    const model: ModelAdapter = {
      name: "cancel-policy-answerer",
      async decide() {
        return toolDecision("decision:policy-answerer", "action:policy-answerer", "read_file", {
          path: "src/value.ts",
        });
      },
    };
    const runtime = await createTrackedRuntime({
      dataDir: harness.dataDir,
      model,
      permissionPolicy: createEffectivePermissionPolicy({
        preset: CORE_BUILTIN_PERMISSION_PRESETS["workspace-write"],
        rules: [{
          rule_id: "rule:ask-read-for-cancel",
          priority: 100,
          when: { tool: "read_file" },
          then: "ask",
          explanation: "Wait for a trusted answer",
        }],
      }),
      approvalAnswerer: async (request) => {
        answering.resolve();
        return waitForAbort(request.signal);
      },
    });
    const started = await runtime.startRun(startInput(harness.workspace));
    await answering.promise;

    await runtime.submitUserInput(cancelCommand(
      started,
      "command:cancel-policy-answerer",
      "input:cancel-policy-answerer",
    ));
    const cancelled = await waitForStatus(runtime, started.run_id, "cancelled");
    const cancelQueued = cancelled.timeline.find((event) => event.type === "user.input_queued")!;
    expect(cancelled.timeline.some((event) => (
      event.sequence > cancelQueued.sequence
      && (event.type === "approval.granted" || event.type === "approval.denied" || event.type === "tool.started")
    ))).toBe(false);
    assertCanonicalCancellation(cancelled);
  });

  it("serializes Todo mutations against durable cancel without post-cancel plan facts", async () => {
    const harness = await createHarness("cancel-todo-race");
    let calls = 0;
    const model: ModelAdapter = {
      name: "cancel-todo-race",
      async decide() {
        calls += 1;
        return calls === 1
          ? toolDecision("decision:todo-race", "action:todo-race", "todo_write", {
              operation: "create",
              todo_id: "todo:cancel-race",
              title: "Race a user Todo edit with cancellation",
            })
          : finishDecision("decision:todo-race:ready", "Plan ready for a race", "submit_plan");
      },
    };
    const runtime = await createTrackedRuntime({ dataDir: harness.dataDir, model });
    const started = await runtime.startRun({ ...startInput(harness.workspace), mode: "plan" });
    const waiting = await waitForStatus(runtime, started.run_id, "awaiting_plan_approval");

    const [cancelResult] = await Promise.allSettled([
      runtime.submitUserInput(cancelCommand(
        waiting,
        "command:cancel-todo-race",
        "input:cancel-todo-race",
      )),
      runtime.writeTodo({
        command_id: "command:todo-race",
        project_id: waiting.project_id,
        run_id: waiting.run_id,
        updated_by: "user",
        input: {
          operation: "update",
          todo_id: "todo:cancel-race",
          title: "This mutation must linearize before cancel or be rejected",
        },
      }),
    ]);
    expect(cancelResult.status).toBe("fulfilled");
    const cancelled = await waitForStatus(runtime, waiting.run_id, "cancelled");
    const queued = cancelled.timeline.find((event) => (
      event.type === "user.input_queued"
      && (event.data.input as { input_id?: string } | undefined)?.input_id === "input:cancel-todo-race"
    ))!;
    expect(cancelled.timeline.some((event) => (
      event.sequence > queued.sequence
      && (event.type.startsWith("todo.") || event.type === "plan.ready" || event.type === "plan.approved")
    ))).toBe(false);
    assertCanonicalCancellation(cancelled);
  });

  it("waits for an armed write cancellation shield and leaves a complete file", async () => {
    const harness = await createHarness("cancel-write");
    const armed = deferred<void>();
    const releaseWrite = deferred<void>();
    const registry = createDefaultToolRegistry();
    const base = registry.get("read_file");
    if (base === undefined) throw new Error("read_file tool is unavailable");
    registry.register({
      ...base,
      sideEffect: "write",
      concurrencySafe: false,
      requiresApproval: false,
      async execute(_input, context) {
        const target = join(context.workspace.real_root, "src/value.ts");
        const temporary = join(context.workspace.real_root, "src/value.next");
        await writeFile(temporary, "after\n");
        if (context.signal?.aborted) {
          return { status: "failure", code: "aborted", summary: "Cancelled before commit" };
        }
        context.cancellationShield?.arm();
        armed.resolve();
        await releaseWrite.promise;
        await rename(temporary, target);
        return { status: "success", code: "atomic_write", summary: "Atomic write committed" };
      },
    });
    let calls = 0;
    const model: ModelAdapter = {
      name: "shielded-write-model",
      async decide() {
        calls += 1;
        return calls === 1
          ? toolDecision("decision:write", "action:write", "read_file", { path: "src/value.ts" })
          : finishDecision("decision:unused", "unused");
      },
    };
    const runtime = await createTrackedRuntime({
      dataDir: harness.dataDir,
      model,
      toolRegistry: registry,
      permissionPolicy: createEffectivePermissionPolicy({
        preset: CORE_BUILTIN_PERMISSION_PRESETS["full-write"],
      }),
    });
    const started = await runtime.startRun(startInput(harness.workspace));
    await armed.promise;

    await runtime.submitUserInput(cancelCommand(started, "command:cancel-write", "input:cancel-write"));
    expect(await readFile(join(harness.workspace.real_root, "src/value.ts"), "utf8")).toBe("before\n");
    expect((await runtime.getProjection(started.run_id)).status).not.toBe("cancelled");
    releaseWrite.resolve();

    const cancelled = await waitForStatus(runtime, started.run_id, "cancelled");
    expect(await readFile(join(harness.workspace.real_root, "src/value.ts"), "utf8")).toBe("after\n");
    expect(cancelled.timeline.find((event) => event.type === "tool.completed")?.sequence)
      .toBeLessThan(cancelled.timeline.find((event) => event.type === "user.input_consumed")!.sequence);
    expect(cancelled.timeline.some((event) => event.type === "patch.rolled_back")).toBe(false);
    assertCanonicalCancellation(cancelled);
  });

  it("lets a queued input beat a concurrent finish and rejects input after terminal", async () => {
    const harness = await createHarness("terminal-race");
    const entered = deferred<void>();
    const release = deferred<void>();
    const contexts: string[] = [];
    let calls = 0;
    const model: ModelAdapter = {
      name: "finish-race-model",
      async decide(input) {
        calls += 1;
        contexts.push(input.context);
        if (calls === 1) {
          entered.resolve();
          await release.promise;
        }
        return finishDecision(`decision:finish:${calls}`, `finish ${calls}`);
      },
    };
    const runtime = await createTrackedRuntime({ dataDir: harness.dataDir, model });
    const started = await runtime.startRun(startInput(harness.workspace));
    await entered.promise;
    const queued = runtime.submitUserInput(inputCommand(started, {
      commandId: "command:finish-race",
      inputId: "input:finish-race",
      body: "consider this before finishing",
    }));
    release.resolve();
    await queued;

    const completed = await waitForStatus(runtime, started.run_id, "completed");
    expect(calls).toBe(2);
    expect(contexts[1]).toContain("consider this before finishing");
    const terminalSequence = completed.timeline.find((event) => event.type === "run.completed")!.sequence;
    expect(completed.timeline.find((event) => event.type === "user.input_consumed")!.sequence)
      .toBeLessThan(terminalSequence);
    await expect(runtime.submitUserInput(inputCommand(started, {
      commandId: "command:too-late",
      inputId: "input:too-late",
      body: "too late",
    }))).rejects.toMatchObject({ code: "run_terminal" });
    expect((await runtime.getProjection(started.run_id)).timeline.at(-1)?.type).toBe("run.completed");
  });

  it("stops repeated successful Tool calls after the no-progress window", async () => {
    const harness = await createHarness("no-progress-repeat");
    let calls = 0;
    const model: ModelAdapter = {
      name: "repeating-read-model",
      async decide() {
        calls += 1;
        return toolDecision(
          `decision:no-progress:${calls}`,
          `action:no-progress:${calls}`,
          "read_file",
          { path: "src/value.ts" },
        );
      },
    };
    const runtime = await createTrackedRuntime({ dataDir: harness.dataDir, model, maxTurns: 8 });
    const started = await runtime.startRun(startInput(harness.workspace));

    const failed = await waitForStatus(runtime, started.run_id, "failed");
    const terminal = failed.timeline.find((event) => event.type === "run.failed");

    expect(calls).toBe(4);
    expect(failed.failure_code).toBe("no_progress_detected");
    expect(terminal?.summary).toContain("3 consecutive Tool turns produced no new evidence");
    expect(terminal?.data).toMatchObject({
      code: "no_progress_detected",
      no_progress_guard: {
        policy: {
          window_turns: 4,
          minimum_no_progress_turns: 3,
          minimum_repeated_call_ratio: 0.5,
        },
        recent_turns: 4,
        no_progress_turns: 3,
        repeated_call_count: 3,
        total_call_count: 4,
        repeated_call_ratio: 0.75,
        fingerprint: {
          new_evidence_count: 0,
          unresolved_error_codes: [],
        },
      },
    });
    expect(JSON.stringify(terminal?.data.no_progress_guard)).not.toContain("src/value.ts");
  });

  it("continues repeated calls when their results change", async () => {
    const harness = await createHarness("no-progress-changing-result");
    const registry = createDefaultToolRegistry();
    const readFile = registry.get("read_file");
    if (readFile === undefined) throw new Error("read_file tool is unavailable");
    let resultRevision = 0;
    registry.register({
      ...readFile,
      async execute() {
        resultRevision += 1;
        const content = `revision ${resultRevision}`;
        return {
          status: "success",
          code: "file_read",
          summary: "Read src/value.ts",
          content,
          mimeType: "text/plain",
          facts: { path: "src/value.ts", content },
        };
      },
    });
    let modelCalls = 0;
    const model: ModelAdapter = {
      name: "changing-read-model",
      async decide() {
        modelCalls += 1;
        return modelCalls <= 4
          ? toolDecision(
            `decision:changing:${modelCalls}`,
            `action:changing:${modelCalls}`,
            "read_file",
            { path: "src/value.ts" },
          )
          : finishDecision(`decision:changing:${modelCalls}`, "The latest result is available.");
      },
    };
    const runtime = await createTrackedRuntime({
      dataDir: harness.dataDir,
      model,
      maxTurns: 8,
      toolRegistry: registry,
    });
    const started = await runtime.startRun(startInput(harness.workspace));

    const completed = await waitForStatus(runtime, started.run_id, "completed");

    expect(modelCalls).toBe(5);
    expect(resultRevision).toBe(4);
    expect(completed.failure_code).toBeUndefined();
    expect(completed.timeline.at(-1)?.type).toBe("run.completed");
  });

  it("resets no-progress history when it consumes a user message", async () => {
    const harness = await createHarness("no-progress-steering-reset");
    const entered = deferred<void>();
    const release = deferred<void>();
    let calls = 0;
    const model: ModelAdapter = {
      name: "steered-repeating-read-model",
      async decide() {
        calls += 1;
        if (calls === 4) {
          entered.resolve();
          await release.promise;
        }
        return toolDecision(
          `decision:steered-repeat:${calls}`,
          `action:steered-repeat:${calls}`,
          "read_file",
          { path: "src/value.ts" },
        );
      },
    };
    const runtime = await createTrackedRuntime({ dataDir: harness.dataDir, model, maxTurns: 8 });
    const started = await runtime.startRun(startInput(harness.workspace));
    await entered.promise;
    await runtime.submitUserInput(inputCommand(started, {
      commandId: "command:no-progress-reset",
      inputId: "input:no-progress-reset",
      body: "Use the latest repository state before continuing.",
    }));
    release.resolve();

    const failed = await waitForStatus(runtime, started.run_id, "failed");

    expect(calls).toBe(8);
    expect(failed.failure_code).toBe("no_progress_detected");
    expect(failed.timeline.some((event) => (
      event.type === "user.input_consumed" && event.data.input_id === "input:no-progress-reset"
    ))).toBe(true);
    expect(failed.timeline.find((event) => event.type === "run.failed")?.data.no_progress_guard)
      .toMatchObject({ no_progress_turns: 3, recent_turns: 4 });
  });

  it("leaves steering pending when no model turn remains instead of falsely consuming it", async () => {
    const harness = await createHarness("turn-budget-steering");
    const entered = deferred<void>();
    const release = deferred<void>();
    let calls = 0;
    const model: ModelAdapter = {
      name: "turn-budget-steering",
      async decide() {
        calls += 1;
        entered.resolve();
        await release.promise;
        return toolDecision("decision:budget", "action:budget", "read_file", {
          path: "src/value.ts",
        });
      },
    };
    const runtime = await createTrackedRuntime({ dataDir: harness.dataDir, model, maxTurns: 1 });
    const started = await runtime.startRun(startInput(harness.workspace));
    await entered.promise;
    await runtime.submitUserInput(inputCommand(started, {
      commandId: "command:budget-message",
      inputId: "input:budget-message",
      body: "there is no next model request for this message",
    }));
    release.resolve();

    const failed = await waitForStatus(runtime, started.run_id, "failed");
    expect(failed.failure_code).toBe("turn_budget_exhausted");
    expect(calls).toBe(1);
    expect(failed.input_queue.pending.map((input) => input.input_id)).toEqual(["input:budget-message"]);
    expect(failed.timeline.some((event) => (
      event.type === "user.input_consumed" && event.data.input_id === "input:budget-message"
    ))).toBe(false);
  });

  it.each([
    { label: "unconsumed", preconsume: false },
    { label: "consumed-before-memory-update", preconsume: true },
  ])("rebuilds $label steering from the Ledger after restart", async ({ label, preconsume }) => {
    const harness = await createHarness(`recovery-${label}`);
    let now = new Date("2026-09-19T00:00:00.000Z");
    const idFactory = sequentialIdFactory();
    let planCalls = 0;
    const planModel: ModelAdapter = {
      name: "steering-recovery-plan",
      async decide() {
        planCalls += 1;
        return planCalls === 1
          ? toolDecision("decision:todo", "action:todo", "todo_write", {
              operation: "create",
              todo_id: "todo:recovery",
              title: "Resume with queued steering",
            })
          : finishDecision("decision:plan", "Plan ready", "submit_plan");
      },
    };
    const firstStore = new JsonlSessionStore(harness.sessionsRoot, {
      now: () => now,
      pid: 2_147_483_646,
    });
    const first = await createTrackedRuntime({
      dataDir: harness.dataDir,
      sessionStore: firstStore,
      model: planModel,
      now: () => now,
      idFactory,
    });
    const started = await first.startRun({ ...startInput(harness.workspace), mode: "plan" });
    const waiting = await waitForStatus(first, started.run_id, "awaiting_plan_approval");
    const steeringBody = `durable steering ${label}`;
    await first.submitUserInput(inputCommand(waiting, {
      commandId: `command:recover:${label}`,
      inputId: `input:recover:${label}`,
      body: steeringBody,
    }));
    let beforeRestart = await first.getProjection(waiting.run_id);
    const queued = beforeRestart.timeline.find((event) => (
      event.type === "user.input_queued"
      && (event.data.input as { input_id?: string } | undefined)?.input_id === `input:recover:${label}`
    ));
    if (queued === undefined) throw new Error("queued steering event is unavailable");
    // Freeze the abandoned Runtime's Session writes before the simulated crash.
    await settleSessionIndexBeforeRestart(harness.sessionsRoot, beforeRestart);

    if (preconsume) {
      const externalLedger = new JsonlEventLedger(join(harness.dataDir, "events"), {
        now: () => now,
        idFactory,
      });
      await externalLedger.append({
        type: "user.input_consumed",
        project_id: waiting.project_id,
        run_id: waiting.run_id,
        session_id: waiting.session_id,
        attempt: 0,
        summary: "Simulated crash after durable consumption",
        artifact_refs: [],
        idempotency_key: `${waiting.run_id}:external-consume:${label}`,
        caused_by_event_id: queued.event_id,
        data: UserInputConsumedDataSchema.parse({
          input_id: `input:recover:${label}`,
          kind: "message",
          consumed_at: now.toISOString(),
          at_step: 3,
          queued_event_id: queued.event_id,
        }),
      });
      beforeRestart = await first.getProjection(waiting.run_id);
      expect(beforeRestart.input_queue.pending).toEqual([]);
      registerSecretForRedaction(steeringBody);
    } else {
      expect(beforeRestart.input_queue.pending.map((input) => input.input_id))
        .toEqual([`input:recover:${label}`]);
    }

    now = new Date("2026-09-19T00:02:00.000Z");
    const contexts: string[] = [];
    const executeModel: ModelAdapter = {
      name: "steering-recovery-execute",
      async decide(input) {
        contexts.push(input.context);
        return finishDecision("decision:execute", "Recovered steering was visible");
      },
    };
    const restartedStore = new JsonlSessionStore(harness.sessionsRoot, { now: () => now });
    const restarted = await createTrackedRuntime({
      dataDir: harness.dataDir,
      sessionStore: restartedStore,
      model: executeModel,
      now: () => now,
      idFactory,
    });
    await restarted.markRunInterrupted(locator(waiting));
    const resumed = await restarted.resumeRun({
      ...locator(waiting),
      commandId: `command:resume:${label}`,
      workspace: harness.workspace,
    });
    if (!preconsume) {
      expect(resumed.input_queue.pending.map((input) => input.input_id))
        .toEqual([`input:recover:${label}`]);
    }
    await restarted.approvePlan({
      type: "approve_plan",
      command_id: `command:approve:${label}`,
      project_id: resumed.project_id,
      run_id: resumed.run_id,
      plan_event_id: resumed.pending_plan!.plan_event_id,
    });
    const completed = await waitForStatus(restarted, resumed.run_id, "completed");

    if (preconsume) {
      expect(contexts[0]).not.toContain(steeringBody);
      expect(contexts[0]).toContain("[REDACTED_REGISTERED_SECRET]");
    } else {
      expect(contexts[0]).toContain(steeringBody);
    }
    expect(completed.timeline.filter((event) => (
      event.type === "user.input_consumed"
      && event.data.input_id === `input:recover:${label}`
    ))).toHaveLength(1);
    expect(completed.input_queue.pending).toEqual([]);
  });

  it.each(["running", "indexing"] as const)(
    "finishes a durable pre-crash cancel from prior %s state on explicit resume without restarting work",
    async (priorStatus) => {
      const harness = await createHarness(`recovery-cancel-${priorStatus}`);
      let now = new Date("2026-09-19T00:00:00.000Z");
      const idFactory = sequentialIdFactory();
      const entered = deferred<void>();
      let modelCalls = 0;
      let indexingCalls = 0;
      const model: ModelAdapter = {
        name: `recovery-cancel-${priorStatus}`,
        async decide() {
          modelCalls += 1;
          entered.resolve();
          return new Promise(() => undefined);
        },
      };
      const codeGraph: CodeGraphProvider | undefined = priorStatus === "indexing"
        ? {
            async createSnapshot() {
              indexingCalls += 1;
              entered.resolve();
              return new Promise(() => undefined);
            },
            async createDelta() {
              return new Promise(() => undefined);
            },
          }
        : undefined;
      const first = await createTrackedRuntime({
        dataDir: harness.dataDir,
        sessionStore: new JsonlSessionStore(harness.sessionsRoot, {
          now: () => now,
          pid: 2_147_483_646,
        }),
        model,
        now: () => now,
        idFactory,
        ...(codeGraph === undefined ? {} : { codeGraph }),
      });
      const started = await first.startRun(startInput(harness.workspace));
      await entered.promise;
      const beforeExternalCancel = await first.getProjection(started.run_id);
      expect(beforeExternalCancel.status).toBe(priorStatus);

      const ledger = new JsonlEventLedger(join(harness.dataDir, "events"), {
        now: () => now,
        idFactory,
      });
      await ledger.append({
        type: "user.input_queued",
        project_id: started.project_id,
        run_id: started.run_id,
        ...(started.session_id === undefined ? {} : { session_id: started.session_id }),
        attempt: 0,
        summary: `Cancel queued while prior process was ${priorStatus}`,
        artifact_refs: [],
        idempotency_key: `command:external-${priorStatus}-cancel`,
        data: UserInputQueuedDataSchema.parse({
          input: {
            input_id: `input:external-${priorStatus}-cancel`,
            run_id: started.run_id,
            kind: "cancel",
            body: "Cancel after the crashed process is fenced",
            actor: "user",
            submitted_at: now.toISOString(),
          },
        }),
      });

      await settleSessionIndexBeforeRestart(harness.sessionsRoot, beforeExternalCancel);
      now = new Date("2026-09-19T00:02:00.000Z");
      const restarted = await createTrackedRuntime({
        dataDir: harness.dataDir,
        sessionStore: new JsonlSessionStore(harness.sessionsRoot, { now: () => now }),
        model,
        now: () => now,
        idFactory,
        ...(codeGraph === undefined ? {} : { codeGraph }),
      });
      const interrupted = await restarted.markRunInterrupted(locator(started));
      expect(interrupted.status).toBe("interrupted");
      const resumed = await restarted.resumeRun({
        ...locator(started),
        commandId: `command:resume-cancel-${priorStatus}`,
        workspace: harness.workspace,
      });

      expect(resumed.status).toBe("cancelled");
      expect(modelCalls).toBe(priorStatus === "running" ? 1 : 0);
      expect(indexingCalls).toBe(priorStatus === "indexing" ? 1 : 0);
      expect(resumed.timeline.filter((event) => event.type === "run.resumed")).toHaveLength(1);
      expect(resumed.timeline.filter((event) => event.type === "user.input_consumed")).toHaveLength(1);
      assertCanonicalCancellation(resumed);
    },
  );

  it("finalizes a pre-restart pending cancel without reissuing patch approval", async () => {
    const harness = await createHarness("recovery-pending-cancel");
    let now = new Date("2026-09-19T00:00:00.000Z");
    const idFactory = sequentialIdFactory();
    let modelCalls = 0;
    const model: ModelAdapter = {
      name: "pending-patch-cancel-recovery",
      async decide() {
        modelCalls += 1;
        return toolDecision("decision:preview", "action:preview", "preview_patch", {
          path: "src/value.ts",
          expected: "before\n",
          replacement: "after\n",
        });
      },
    };
    const firstStore = new JsonlSessionStore(harness.sessionsRoot, {
      now: () => now,
      pid: 2_147_483_646,
    });
    const first = await createTrackedRuntime({
      dataDir: harness.dataDir,
      sessionStore: firstStore,
      model,
      now: () => now,
      idFactory,
    });
    const started = await first.startRun(startInput(harness.workspace));
    const waiting = await waitForStatus(first, started.run_id, "awaiting_approval");
    const approvalRequests = waiting.timeline.filter((event) => event.type === "approval.requested").length;
    const ledger = new JsonlEventLedger(join(harness.dataDir, "events"), {
      now: () => now,
      idFactory,
    });
    await ledger.append({
      type: "user.input_queued",
      project_id: waiting.project_id,
      run_id: waiting.run_id,
      session_id: waiting.session_id,
      attempt: 0,
      summary: "Simulated cancel queued before Host restart",
      artifact_refs: [],
      idempotency_key: "command:external-pending-cancel",
      data: UserInputQueuedDataSchema.parse({
        input: {
          input_id: "input:external-pending-cancel",
          run_id: waiting.run_id,
          kind: "cancel",
          body: "Cancel the pending patch after restart",
          actor: "user",
          submitted_at: now.toISOString(),
        },
      }),
    });

    now = new Date("2026-09-19T00:02:00.000Z");
    // `waiting` is the last Commit this Runtime made. The cancel queued above is
    // the restarted Host's to consume, and the abandoned Runtime never indexes
    // it, so waiting on the queued fact itself would wait forever.
    await settleSessionIndexBeforeRestart(harness.sessionsRoot, waiting);
    const restarted = await createTrackedRuntime({
      dataDir: harness.dataDir,
      sessionStore: new JsonlSessionStore(harness.sessionsRoot, { now: () => now }),
      model,
      now: () => now,
      idFactory,
    });
    await restarted.markRunInterrupted(locator(waiting));
    const resumed = await restarted.resumeRun({
      ...locator(waiting),
      commandId: "command:resume-pending-cancel",
      workspace: harness.workspace,
    });

    expect(resumed.status).toBe("cancelled");
    expect(modelCalls).toBe(1);
    expect(resumed.timeline.filter((event) => event.type === "approval.requested"))
      .toHaveLength(approvalRequests);
    expect(resumed.timeline.filter((event) => event.type === "run.resumed")).toHaveLength(1);
    expect(resumed.timeline.filter((event) => event.type === "user.input_consumed")).toHaveLength(1);
    expect(await readFile(join(harness.workspace.real_root, "src/value.ts"), "utf8")).toBe("before\n");
    assertCanonicalCancellation(resumed);
  });

  it("repairs a crash after cancel consumption as cancelled, not interrupted", async () => {
    const harness = await createHarness("cancel-recovery-window");
    let now = new Date("2026-09-19T00:00:00.000Z");
    const idFactory = sequentialIdFactory();
    let calls = 0;
    const model: ModelAdapter = {
      name: "cancel-recovery-plan",
      async decide() {
        calls += 1;
        return calls === 1
          ? toolDecision("decision:cancel-todo", "action:cancel-todo", "todo_write", {
              operation: "create",
              todo_id: "todo:cancel-recovery",
              title: "Wait for cancellation recovery",
            })
          : finishDecision("decision:cancel-plan", "Plan ready", "submit_plan");
      },
    };
    const firstStore = new JsonlSessionStore(harness.sessionsRoot, {
      now: () => now,
      pid: 2_147_483_646,
    });
    const first = await createTrackedRuntime({
      dataDir: harness.dataDir,
      sessionStore: firstStore,
      model,
      now: () => now,
      idFactory,
    });
    const started = await first.startRun({ ...startInput(harness.workspace), mode: "plan" });
    const waiting = await waitForStatus(first, started.run_id, "awaiting_plan_approval");
    const ledger = new JsonlEventLedger(join(harness.dataDir, "events"), {
      now: () => now,
      idFactory,
    });
    const queued = await ledger.append({
      type: "user.input_queued",
      project_id: waiting.project_id,
      run_id: waiting.run_id,
      session_id: waiting.session_id,
      attempt: 0,
      summary: "Simulated durable cancel request",
      artifact_refs: [],
      idempotency_key: "command:external-cancel",
      data: UserInputQueuedDataSchema.parse({
        input: {
          input_id: "input:external-cancel",
          run_id: waiting.run_id,
          kind: "cancel",
          body: "Cancel after restart",
          actor: "user",
          submitted_at: now.toISOString(),
        },
      }),
    });
    const consumed = await ledger.append({
      type: "user.input_consumed",
      project_id: waiting.project_id,
      run_id: waiting.run_id,
      session_id: waiting.session_id,
      attempt: 0,
      summary: "Simulated safe-boundary cancel consumption",
      artifact_refs: [],
      idempotency_key: "input:external-cancel:consumed",
      caused_by_event_id: queued.event_id,
      data: UserInputConsumedDataSchema.parse({
        input_id: "input:external-cancel",
        kind: "cancel",
        consumed_at: now.toISOString(),
        at_step: 3,
        queued_event_id: queued.event_id,
      }),
    });

    // `waiting` is the last Commit this Runtime made; the simulated cancel and
    // its consumption below are repair facts for the restarted Host.
    await settleSessionIndexBeforeRestart(harness.sessionsRoot, waiting);
    now = new Date("2026-09-19T00:02:00.000Z");
    const restartedStore = new JsonlSessionStore(harness.sessionsRoot, { now: () => now });
    const restarted = await createTrackedRuntime({
      dataDir: harness.dataDir,
      sessionStore: restartedStore,
      model,
      now: () => now,
      idFactory,
    });
    const repaired = await restarted.markRunInterrupted(locator(waiting));

    expect(repaired.status).toBe("cancelled");
    expect(repaired.timeline.some((event) => event.type === "run.interrupted")).toBe(false);
    expect(repaired.timeline.filter((event) => event.type === "run.cancelled")).toHaveLength(1);
    expect(repaired.timeline.find((event) => event.type === "run.cancelled")?.data).toEqual({
      reason: "user_cancel",
      last_sequence: consumed.sequence,
    });
  });
});

function inputCommand(
  run: { project_id: string; run_id: string },
  input: { commandId: string; inputId: string; body: string },
) {
  return {
    type: "submit_user_input" as const,
    command_id: input.commandId,
    input_id: input.inputId,
    project_id: run.project_id,
    run_id: run.run_id,
    kind: "message" as const,
    body: input.body,
    actor: "user" as const,
  };
}

function cancelCommand(
  run: { project_id: string; run_id: string },
  commandId: string,
  inputId: string,
) {
  return {
    type: "submit_user_input" as const,
    command_id: commandId,
    input_id: inputId,
    project_id: run.project_id,
    run_id: run.run_id,
    kind: "cancel" as const,
    body: "Cancel this run",
    actor: "user" as const,
  };
}

function toolDecision(
  decisionId: string,
  actionId: string,
  toolName: "read_file" | "todo_write" | "preview_patch",
  arguments_: Record<string, unknown>,
) {
  return {
    decision_id: decisionId,
    kind: "tool_call",
    public_reason: `Use ${toolName}`,
    evidence_refs: [],
    risk: "low",
    expected_effect: "Produce a bounded observation",
    tool_call: { action_id: actionId, tool_name: toolName, arguments: arguments_ },
  };
}

function finishDecision(decisionId: string, answer: string, intent: "answer" | "submit_plan" = "answer") {
  return {
    decision_id: decisionId,
    kind: "finish",
    public_reason: answer,
    evidence_refs: [],
    risk: "none",
    final_answer: answer,
    finish_intent: intent,
  };
}

async function createHarness(name: string): Promise<{
  dataDir: string;
  sessionsRoot: string;
  workspace: WorkspaceHandle;
}> {
  const root = await mkdtemp(join(tmpdir(), `tracegraph-steering-${name}-`));
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
    task: "Exercise durable steering and safe cancellation.",
    mode: "execute" as const,
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value?: T): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise(value as T),
  };
}

function waitForAbort(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const rejectAbort = () => reject(
      signal?.reason instanceof Error ? signal.reason : new Error("Run cancelled"),
    );
    if (signal?.aborted) {
      rejectAbort();
      return;
    }
    signal?.addEventListener("abort", rejectAbort, { once: true });
  });
}

async function waitForStatus(
  runtime: AgentRuntime,
  runId: string,
  status: RunProjection["status"],
): Promise<RunProjection> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const projection = await runtime.getProjection(runId);
    if (projection.status === status) return projection;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const projection = await runtime.getProjection(runId);
  throw new Error(`Timed out waiting for ${status}: ${JSON.stringify({
    status: projection.status,
    events: projection.timeline.map((event) => event.type),
  })}`);
}

async function waitForPendingCount(
  runtime: AgentRuntime,
  runId: string,
  count: number,
): Promise<RunProjection> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const projection = await runtime.getProjection(runId);
    if (projection.input_queue.pending.length === count) return projection;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${count} pending user inputs`);
}

/**
 * A crash in these cases is simulated by abandoning a Runtime mid-Run: it stays
 * alive in-process, so it can still be draining Session index writes when the
 * next Runtime takes the Session Lease over. `SessionStore` publishes an append
 * by replacing the whole file, and a Runtime indexes every committed batch
 * *after* the Ledger commit that made the batch visible, so a projection can
 * already report a new Run state while that Session write is still in flight.
 * Taking the next Lease over in that window makes the new owner scan a file
 * whose identity changes between its `stat` and its `open`, which the store
 * fails closed on as `SessionPathSafetyError` ("session file changed while
 * opening").
 *
 * Wait until `before` reports indexed, so the abandoned Runtime owns no Session
 * write when the next one starts. Only call this where the abandoned Runtime was
 * composed with a Session store: without one it indexes nothing at all, which is
 * why the restart case that composes none needs no wait. `before` must be a
 * projection captured before any Ledger append the abandoned Runtime did not
 * make itself, because it only ever indexes its own commits, so waiting on an
 * externally appended fact would wait forever.
 */
async function settleSessionIndexBeforeRestart(
  sessionsRoot: string,
  before: RunProjection,
): Promise<void> {
  const sessionId = before.session_id;
  const lastEventId = before.timeline.at(-1)?.event_id;
  if (sessionId === undefined || lastEventId === undefined) return;
  // A read takes no Lease, so a second reader cannot fence the abandoned Runtime.
  const store = new JsonlSessionStore(sessionsRoot);
  await store.initialize();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const { entries } = await store.readAll(sessionId);
      // Entries are chained in Commit order, so the newest Commit landing means
      // every earlier one has landed too.
      if (entries.some((entry) => entry.event_ref.event_id === lastEventId)) return;
    } catch (error) {
      // The replace this wait exists for is in progress, or the Session has not
      // been published yet. Keep waiting; the deadline still fails loudly.
      if (!(error instanceof SessionPathSafetyError) && !(error instanceof SessionNotFoundError)) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for the Session index to reach ${lastEventId}`);
}

function assertCanonicalCancellation(projection: RunProjection): void {
  const terminals = projection.timeline.filter((event) => event.type === "run.cancelled");
  expect(terminals).toHaveLength(1);
  const consumed = projection.timeline.find((event) => (
    event.type === "user.input_consumed" && event.data.kind === "cancel"
  ))!;
  expect(terminals[0]?.data).toEqual({
    reason: "user_cancel",
    last_sequence: consumed.sequence,
  });
}
