import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISPOSABLE_FIXTURE_CAPABILITIES,
  WorkspaceHandleSchema,
  type WorkspaceHandle,
} from "@tracegraph/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ActionWal, RecoveryLedger } from "./action-wal.js";
import {
  createAgentRuntime as createAgentRuntimeWithNativeSandbox,
  type ActionCommitFaultPoint,
  type AgentRuntime,
} from "./runtime.js";
import { createFixtureSandboxRunner } from "./sandbox/fixture-runner.js";
import { DurableSessionController } from "./session-controller.js";
import { JsonlSessionStore } from "./session-store.js";
import { removeControlledTemporaryDirectory } from "./workspace.js";

/**
 * run_test fails closed unless the host proves full OS isolation, which Linux
 * (unlike macOS seatbelt) never does. These suites cover approval, WAL and
 * crash recovery semantics rather than isolation, so every Runtime they build
 * gets a fixture sandbox boundary -- see sandbox/fixture-runner.ts.
 */
const createAgentRuntime: typeof createAgentRuntimeWithNativeSandbox = (options) =>
  createAgentRuntimeWithNativeSandbox({
    ...options,
    sandboxRunner: createFixtureSandboxRunner(),
  });

const roots: string[] = [];
const DURABILITY_TEST_TIMEOUT_MS = 30_000;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeControlledTemporaryDirectory));
});

describe("Action WAL crash recovery", { timeout: DURABILITY_TEST_TIMEOUT_MS }, () => {
  it.each([
    {
      point: "after_prepare_before_apply" as const,
      durablePhase: "prepare",
      changedAtCrash: false,
      finalPhase: "aborted",
      resultKind: "aborted" as const,
    },
    {
      point: "after_apply_before_applied" as const,
      durablePhase: "prepare",
      changedAtCrash: true,
      finalPhase: "verified",
      resultKind: "reconciled" as const,
    },
    {
      point: "after_applied_before_event" as const,
      durablePhase: "applied",
      changedAtCrash: true,
      finalPhase: "verified",
      resultKind: "reconciled" as const,
    },
    {
      point: "after_patch_event_before_committed" as const,
      durablePhase: "applied",
      changedAtCrash: true,
      finalPhase: "verified",
      resultKind: "reconciled" as const,
    },
    {
      point: "after_verified_event_before_verified" as const,
      durablePhase: "committed",
      changedAtCrash: true,
      finalPhase: "verified",
      resultKind: "reconciled" as const,
    },
  ])(
    "reconciles $point without replaying the mutation",
    async ({ point, durablePhase, changedAtCrash, finalPhase, resultKind }) => {
      const crashed = await crashApprovedPatchAt(point);
      const wal = new ActionWal(join(crashed.dataDir, "wal"));

      expect((await wal.latestForAction(crashed.runId, crashed.actionId))?.phase)
        .toBe(durablePhase);
      expect((await source(crashed.workspace.real_root)).includes("return left + right;"))
        .toBe(changedAtCrash);

      const restarted = await restartAfterCrash(crashed);
      const recovery = await restarted.runtime.reconcileActions({
        ...crashed.locator,
        workspace: restarted.workspace,
      });
      const projection = await restarted.runtime.getProjection(crashed.runId);

      if (resultKind === "aborted") {
        expect(recovery.abortedActionIds).toEqual([crashed.actionId]);
        expect(recovery.reconciledActionIds).toEqual([]);
        expect(await source(crashed.workspace.real_root)).toContain("return left - right;");
        expect(projection.timeline.some((event) => event.type === "patch.applied")).toBe(false);
        expect(projection.timeline).toContainEqual(expect.objectContaining({
          type: "action.reconciled",
          action_id: crashed.actionId,
          data: expect.objectContaining({ outcome: "not_applied", recovered: true }),
        }));
      } else {
        expect(recovery.reconciledActionIds).toEqual([crashed.actionId]);
        expect(recovery.abortedActionIds).toEqual([]);
        expect(await source(crashed.workspace.real_root)).toContain("return left + right;");
        expect(projection.timeline).toContainEqual(expect.objectContaining({
          type: "patch.applied",
          action_id: crashed.actionId,
        }));
        expect(projection.timeline).toContainEqual(expect.objectContaining({
          type: "action.verified",
          action_id: crashed.actionId,
        }));
        expect(projection.timeline).toContainEqual(expect.objectContaining({
          type: "action.reconciled",
          action_id: crashed.actionId,
          data: expect.objectContaining({ recovered: true }),
        }));
        expect(projection.timeline.filter(
          (event) => event.type === "patch.applied" && event.action_id === crashed.actionId,
        )).toHaveLength(1);
        expect(projection.timeline.filter(
          (event) => event.type === "action.verified" && event.action_id === crashed.actionId,
        )).toHaveLength(1);
      }
      expect(recovery.divergedActionIds).toEqual([]);
      expect((await wal.latestForAction(crashed.runId, crashed.actionId))?.phase).toBe(finalPhase);
      expect(projection.timeline.map((event) => event.sequence)).toEqual(
        projection.timeline.map((_, index) => index + 1),
      );
      expect(projection.status).toBe("interrupted");

      const stored = await restarted.store.readAll(crashed.locator.sessionId);
      expect(stored.entries).toHaveLength(projection.timeline.length);
      expect(new Set(stored.entries.map((entry) => entry.event_ref.event_id)).size)
        .toBe(stored.entries.length);

      const eventCount = projection.timeline.length;
      const walCount = (await wal.list(crashed.runId)).length;
      const attemptCount = (await new RecoveryLedger(join(crashed.dataDir, "recovery"))
        .list(crashed.runId)).length;
      await restarted.runtime.reconcileActions({
        ...crashed.locator,
        workspace: restarted.workspace,
      });
      const repeated = await restarted.runtime.getProjection(crashed.runId);
      expect(repeated.timeline).toHaveLength(eventCount);
      expect(await wal.list(crashed.runId)).toHaveLength(walCount);
      expect(await new RecoveryLedger(join(crashed.dataDir, "recovery")).list(crashed.runId))
        .toHaveLength(attemptCount);
      expect((await restarted.store.readAll(crashed.locator.sessionId)).entries)
        .toHaveLength(eventCount);
    },
  );

  it.each([
    {
      label: "aborted",
      point: "after_prepare_before_apply" as const,
      mutate: false,
      reportField: "aborted_action_ids" as const,
      recoveryEvent: "action.reconciled" as const,
      finalStatus: "interrupted",
    },
    {
      label: "reconciled",
      point: "after_apply_before_applied" as const,
      mutate: false,
      reportField: "reconciled_action_ids" as const,
      recoveryEvent: "action.reconciled" as const,
      finalStatus: "interrupted",
    },
    {
      label: "diverged",
      point: "after_applied_before_event" as const,
      mutate: true,
      reportField: "diverged_action_ids" as const,
      recoveryEvent: "action.diverged" as const,
      finalStatus: "needs_manual_review",
    },
  ])(
    "Session recovery reports an automatically $label WAL action before interruption",
    async ({ point, mutate, reportField, recoveryEvent, finalStatus }) => {
      const crashed = await crashApprovedPatchAt(point);
      if (mutate) {
        await writeFile(
          join(crashed.workspace.real_root, "src/add.ts"),
          "// independently replaced after the crash\n",
        );
      }
      const restarted = await restartRuntimeOnly(crashed);
      const resolvedProjects: string[] = [];
      const report = await new DurableSessionController({
        store: restarted.store,
        runtime: restarted.runtime,
        idFactory: crashed.idFactory,
        now: () => crashed.now,
        workspaceResolver(projectId) {
          resolvedProjects.push(projectId);
          return restarted.workspace;
        },
      }).recover();

      expect(resolvedProjects).toEqual([crashed.workspace.project_id]);
      expect(report[reportField]).toEqual([crashed.actionId]);
      for (const field of [
        "reconciled_action_ids",
        "aborted_action_ids",
        "diverged_action_ids",
      ] as const) {
        if (field !== reportField) expect(report[field]).toEqual([]);
      }
      const projection = await restarted.runtime.getProjection(crashed.runId);
      expect(projection.status).toBe(finalStatus);
      const recoveryIndex = projection.timeline.findIndex((event) => event.type === recoveryEvent);
      const interruptedIndex = projection.timeline.findIndex((event) => event.type === "run.interrupted");
      expect(recoveryIndex).toBeGreaterThanOrEqual(0);
      if (finalStatus === "interrupted") {
        expect(report.interrupted_run_ids).toEqual([crashed.runId]);
        expect(interruptedIndex).toBeGreaterThan(recoveryIndex);
      } else {
        expect(report.interrupted_run_ids).toEqual([]);
        expect(interruptedIndex).toBe(-1);
      }
      const stored = await restarted.store.readAll(crashed.locator.sessionId);
      expect(stored.entries).toHaveLength(projection.timeline.length);
      expect(new Set(stored.entries.map((entry) => entry.event_ref.event_id)).size)
        .toBe(stored.entries.length);
    },
  );

  it("marks a third-party modification diverged and never rolls it back automatically", async () => {
    const crashed = await crashApprovedPatchAt("after_applied_before_event");
    const path = join(crashed.workspace.real_root, "src/add.ts");
    const thirdParty = `${await readFile(path, "utf8")}\n// third-party edit must survive recovery\n`;
    await writeFile(path, thirdParty);
    const restarted = await restartAfterCrash(crashed);

    const recovery = await restarted.runtime.reconcileActions({
      ...crashed.locator,
      workspace: restarted.workspace,
    });
    const projection = await restarted.runtime.getProjection(crashed.runId);

    expect(recovery.divergedActionIds).toEqual([crashed.actionId]);
    expect(recovery.reconciledActionIds).toEqual([]);
    expect(recovery.abortedActionIds).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(thirdParty);
    expect(projection.status).toBe("needs_manual_review");
    expect(projection.failure_code).toBe("action_diverged");
    expect(projection.timeline.filter((event) => event.type === "action.diverged"))
      .toHaveLength(1);
    expect(projection.timeline.some((event) => event.type === "patch.rolled_back")).toBe(false);
    expect(projection.timeline).toContainEqual(expect.objectContaining({
      type: "action.diverged",
      data: expect.objectContaining({
        reason: "filesystem_hash_mismatch",
        automatic_rollback: false,
      }),
    }));
    expect(restarted.runtime.listLiveActivities(crashed.runId)).toContainEqual(
      expect.objectContaining({
        source_event_type: "action.diverged",
        kind: "run",
        status: "failed",
      }),
    );
    expect((await new ActionWal(join(crashed.dataDir, "wal"))
      .latestForAction(crashed.runId, crashed.actionId))?.phase).toBe("applied");

    const eventCount = projection.timeline.length;
    const recoveryLedger = new RecoveryLedger(join(crashed.dataDir, "recovery"));
    const attemptCount = (await recoveryLedger.list(crashed.runId)).length;
    const repeated = await restarted.runtime.reconcileActions({
      ...crashed.locator,
      workspace: restarted.workspace,
    });
    expect(repeated.divergedActionIds).toEqual([crashed.actionId]);
    expect((await restarted.runtime.getProjection(crashed.runId)).timeline).toHaveLength(eventCount);
    expect(await recoveryLedger.list(crashed.runId)).toHaveLength(attemptCount);
    expect(await readFile(path, "utf8")).toBe(thirdParty);
  });
});

describe("Action rollback policy", { timeout: DURABILITY_TEST_TIMEOUT_MS }, () => {
  it("is disabled by default and records a refusal without changing the workspace", async () => {
    const completed = await completeApprovedPatch();
    const beforeRollback = await source(completed.workspace.real_root);

    const projection = await completed.runtime.rollback(rollbackInput(completed, {
      command_id: "command:rollback:disabled",
    }));

    expect(await source(completed.workspace.real_root)).toBe(beforeRollback);
    expect(projection.timeline).toContainEqual(expect.objectContaining({
      type: "action.rollback_refused",
      action_id: completed.actionId,
      data: expect.objectContaining({ reason: "rollback_policy_disabled", force: false }),
    }));
    expect(projection.timeline.some((event) => event.type === "patch.rolled_back")).toBe(false);
  });

  it("rolls back a disposable workspace and keeps the durable command idempotent", async () => {
    const completed = await completeApprovedPatch({ rollbackPolicy: { enabled: true } });
    const input = rollbackInput(completed, { command_id: "command:rollback:disposable" });

    const first = await completed.runtime.rollback(input);
    expect(await source(completed.workspace.real_root)).toContain("return left - right;");
    expect(first.timeline.filter((event) => event.type === "patch.rolled_back"))
      .toHaveLength(1);

    const repeated = await completed.runtime.rollback(input);
    expect(repeated.timeline.filter((event) => event.type === "patch.rolled_back"))
      .toHaveLength(1);
    await expect(completed.runtime.rollback({ ...input, force: true })).rejects.toMatchObject({
      code: "command_id_conflict",
    });
  });

  it("recovers a rollback that crashed after restoring bytes but before its event", async () => {
    let injected = false;
    const completed = await completeApprovedPatch({
      rollbackPolicy: { enabled: true },
      actionCommitFaultInjector(point) {
        if (point === "after_rollback_before_event" && !injected) {
          injected = true;
          throw new Error("simulated rollback process crash before canonical event");
        }
      },
    });
    const command = rollbackInput(completed, {
      command_id: "command:rollback:crash-before-event",
    });

    await expect(completed.runtime.rollback(command)).rejects.toBeInstanceOf(Error);
    expect(injected).toBe(true);
    expect(await source(completed.workspace.real_root)).toContain("return left - right;");
    const beforeRestart = await completed.runtime.getProjection(completed.runId);
    expect(beforeRestart.timeline.some((event) => event.type === "patch.rolled_back")).toBe(false);
    const recoveryLedger = new RecoveryLedger(join(completed.dataDir, "recovery"));
    expect(await recoveryLedger.list(completed.runId)).toContainEqual(expect.objectContaining({
      action_id: completed.actionId,
      recipe_id: "restore_from_backup",
      state: "started",
    }));

    const firstRestart = await restartCompletedPatch(completed, "workspace:rollback-restart:1");
    await new DurableSessionController({
      store: firstRestart.store,
      runtime: firstRestart.runtime,
      idFactory: completed.idFactory,
      now: () => firstRestart.now,
      workspaceResolver: () => firstRestart.workspace,
    }).recover();
    const recovered = await firstRestart.runtime.getProjection(completed.runId);
    expect(recovered.timeline.filter((event) => event.type === "patch.rolled_back"))
      .toHaveLength(1);
    expect(recovered.timeline.filter(
      (event) => event.type === "action.reconciled"
        && event.data.outcome === "rollback_event_replayed",
    )).toHaveLength(1);
    expect(recovered.timeline).toContainEqual(expect.objectContaining({
      type: "patch.rolled_back",
      action_id: completed.actionId,
      data: expect.objectContaining({ recovered: true }),
    }));
    expect(await recoveryLedger.list(completed.runId)).toContainEqual(expect.objectContaining({
      action_id: completed.actionId,
      recipe_id: "restore_from_backup",
      state: "succeeded",
    }));
    expect(await source(completed.workspace.real_root)).toContain("return left - right;");
    const firstStored = await firstRestart.store.readAll(completed.sessionId);
    expect(firstStored.entries).toHaveLength(recovered.timeline.length);
    expect(new Set(firstStored.entries.map((entry) => entry.event_ref.event_id)).size)
      .toBe(firstStored.entries.length);

    const eventCount = recovered.timeline.length;
    const attemptCount = (await recoveryLedger.list(completed.runId)).length;
    const secondRestart = await restartCompletedPatch(completed, "workspace:rollback-restart:2");
    await new DurableSessionController({
      store: secondRestart.store,
      runtime: secondRestart.runtime,
      idFactory: completed.idFactory,
      now: () => secondRestart.now,
      workspaceResolver: () => secondRestart.workspace,
    }).recover();
    const repeated = await secondRestart.runtime.getProjection(completed.runId);
    expect(repeated.timeline).toHaveLength(eventCount);
    expect(repeated.timeline.filter((event) => event.type === "patch.rolled_back"))
      .toHaveLength(1);
    expect(repeated.timeline.filter(
      (event) => event.type === "action.reconciled"
        && event.data.outcome === "rollback_event_replayed",
    )).toHaveLength(1);
    expect(await recoveryLedger.list(completed.runId)).toHaveLength(attemptCount);
    expect((await secondRestart.store.readAll(completed.sessionId)).entries)
      .toHaveLength(eventCount);
    expect(await source(completed.workspace.real_root)).toContain("return left - right;");
  });

  it("requires both force and an enabled force policy for a managed workspace", async () => {
    const withoutForce = await completeApprovedPatch({
      workspaceKind: "managed_local",
      rollbackPolicy: { enabled: true, allowForce: true },
    });
    const refused = await withoutForce.runtime.rollback(rollbackInput(withoutForce, {
      command_id: "command:rollback:managed:no-force",
    }));
    expect(await source(withoutForce.workspace.real_root)).toContain("return left + right;");
    expect(refused.timeline).toContainEqual(expect.objectContaining({
      type: "action.rollback_refused",
      data: expect.objectContaining({ reason: "force_not_allowed", force: false }),
    }));

    const forced = await withoutForce.runtime.rollback(rollbackInput(withoutForce, {
      command_id: "command:rollback:managed:forced",
      force: true,
    }));
    expect(await source(withoutForce.workspace.real_root)).toContain("return left - right;");
    expect(forced.timeline).toContainEqual(expect.objectContaining({
      type: "patch.rolled_back",
      data: expect.objectContaining({ force: true }),
    }));

    const policyBlocked = await completeApprovedPatch({
      workspaceKind: "managed_local",
      rollbackPolicy: { enabled: true, allowForce: false },
    });
    const blocked = await policyBlocked.runtime.rollback(rollbackInput(policyBlocked, {
      command_id: "command:rollback:managed:policy-blocked",
      force: true,
    }));
    expect(await source(policyBlocked.workspace.real_root)).toContain("return left + right;");
    expect(blocked.timeline).toContainEqual(expect.objectContaining({
      type: "action.rollback_refused",
      data: expect.objectContaining({ reason: "force_not_allowed", force: true }),
    }));
  });

  it("refuses rollback after a third-party edit and preserves those bytes", async () => {
    const completed = await completeApprovedPatch({ rollbackPolicy: { enabled: true } });
    const path = join(completed.workspace.real_root, "src/add.ts");
    const thirdParty = `${await readFile(path, "utf8")}\n// third-party edit after commit\n`;
    await writeFile(path, thirdParty);

    const projection = await completed.runtime.rollback(rollbackInput(completed, {
      command_id: "command:rollback:third-party",
    }));

    expect(await readFile(path, "utf8")).toBe(thirdParty);
    expect(projection.timeline).toContainEqual(expect.objectContaining({
      type: "action.rollback_refused",
      action_id: completed.actionId,
      data: expect.objectContaining({ reason: "target_modified_after_apply" }),
    }));
    expect(projection.timeline.some((event) => event.type === "patch.rolled_back")).toBe(false);
  });
});

interface CrashedPatch {
  dataDir: string;
  sessionsRoot: string;
  workspace: WorkspaceHandle;
  runId: string;
  actionId: string;
  locator: { sessionId: string; runId: string; projectId: string };
  idFactory: (prefix: string) => string;
  now: Date;
}

interface CompletedPatch {
  runtime: AgentRuntime;
  workspace: WorkspaceHandle;
  dataDir: string;
  sessionsRoot: string;
  sessionId: string;
  projectId: string;
  runId: string;
  actionId: string;
  idFactory: (prefix: string) => string;
}

async function completeApprovedPatch(options: {
  workspaceKind?: "disposable_fixture" | "managed_local";
  rollbackPolicy?: { enabled?: boolean; allowForce?: boolean };
  actionCommitFaultInjector?: (point: ActionCommitFaultPoint) => void | Promise<void>;
} = {}): Promise<CompletedPatch> {
  const harness = await createHarness();
  const workspace = WorkspaceHandleSchema.parse({
    ...harness.workspace,
    workspace_kind: options.workspaceKind ?? "disposable_fixture",
  });
  const store = new JsonlSessionStore(harness.sessionsRoot, { now: () => harness.now });
  const runtime = await createAgentRuntime({
    dataDir: harness.dataDir,
    sessionStore: store,
    idFactory: harness.idFactory,
    now: () => harness.now,
    ...(options.rollbackPolicy === undefined ? {} : { rollbackPolicy: options.rollbackPolicy }),
    ...(options.actionCommitFaultInjector === undefined
      ? {}
      : { actionCommitFaultInjector: options.actionCommitFaultInjector }),
  });
  const started = await runtime.startRun(startInput(workspace));
  const waiting = await waitForApproval(runtime, started.run_id);
  const approval = waiting.pending_approval!;
  const completed = await runtime.approve({
    type: "approve",
    command_id: `command:approve:${approval.action_id}`,
    project_id: waiting.project_id,
    run_id: waiting.run_id,
    approval_id: approval.approval_id,
    action_id: approval.action_id,
  });
  if (completed.status !== "completed") {
    const diag = completed.timeline
      .map((event) => `${event.type} :: ${String(event.summary ?? "")}`)
      .join("\n");
    process.stderr.write(`\n[PROBE] status=${completed.status}\n${diag}\n`);
  }
  expect(completed.status).toBe("completed");
  expect(completed.timeline).toContainEqual(expect.objectContaining({
    type: "action.verified",
    action_id: approval.action_id,
  }));
  return {
    runtime,
    workspace,
    dataDir: harness.dataDir,
    sessionsRoot: harness.sessionsRoot,
    sessionId: completed.session_id!,
    projectId: completed.project_id,
    runId: completed.run_id,
    actionId: approval.action_id,
    idFactory: harness.idFactory,
  };
}

async function restartCompletedPatch(
  completed: CompletedPatch,
  handleId: string,
): Promise<{
  runtime: AgentRuntime;
  store: JsonlSessionStore;
  workspace: WorkspaceHandle;
  now: Date;
}> {
  const now = new Date("2026-09-18T00:02:00.000Z");
  const store = new JsonlSessionStore(completed.sessionsRoot, { now: () => now });
  const runtime = await createAgentRuntime({
    dataDir: completed.dataDir,
    sessionStore: store,
    idFactory: completed.idFactory,
    now: () => now,
  });
  const workspace = WorkspaceHandleSchema.parse({
    ...completed.workspace,
    handle_id: handleId,
    created_at: now.toISOString(),
  });
  return { runtime, store, workspace, now };
}

function rollbackInput(
  completed: CompletedPatch,
  input: { command_id: string; force?: boolean },
) {
  return {
    type: "rollback_action" as const,
    command_id: input.command_id,
    project_id: completed.workspace.project_id,
    run_id: completed.runId,
    action_id: completed.actionId,
    force: input.force ?? false,
    workspace: completed.workspace,
  };
}

async function crashApprovedPatchAt(point: ActionCommitFaultPoint): Promise<CrashedPatch> {
  const harness = await createHarness();
  let injected = false;
  const firstStore = new JsonlSessionStore(harness.sessionsRoot, {
    now: () => harness.now,
    // The restart sees this writer as dead even though the test process remains.
    pid: 2_147_483_646,
  });
  const runtime = await createAgentRuntime({
    dataDir: harness.dataDir,
    sessionStore: firstStore,
    idFactory: harness.idFactory,
    now: () => harness.now,
    actionCommitFaultInjector(candidate) {
      if (candidate === point && !injected) {
        injected = true;
        throw new Error(`simulated process crash at ${candidate}`);
      }
    },
  });
  const started = await runtime.startRun(startInput(harness.workspace));
  const waiting = await waitForApproval(runtime, started.run_id);
  const approval = waiting.pending_approval!;
  await expect(runtime.approve({
    type: "approve",
    command_id: `command:approve:${point}`,
    project_id: waiting.project_id,
    run_id: waiting.run_id,
    approval_id: approval.approval_id,
    action_id: approval.action_id,
  })).rejects.toBeInstanceOf(Error);
  expect(injected).toBe(true);

  return {
    ...harness,
    runId: waiting.run_id,
    actionId: approval.action_id,
    locator: {
      sessionId: waiting.session_id!,
      runId: waiting.run_id,
      projectId: waiting.project_id,
    },
  };
}

async function restartAfterCrash(crashed: CrashedPatch): Promise<{
  runtime: AgentRuntime;
  store: JsonlSessionStore;
  workspace: WorkspaceHandle;
}> {
  const restarted = await restartRuntimeOnly(crashed);
  await new DurableSessionController({
    store: restarted.store,
    runtime: restarted.runtime,
    idFactory: crashed.idFactory,
    now: () => crashed.now,
  }).recover();
  return restarted;
}

async function restartRuntimeOnly(crashed: CrashedPatch): Promise<{
  runtime: AgentRuntime;
  store: JsonlSessionStore;
  workspace: WorkspaceHandle;
}> {
  crashed.now = new Date("2026-09-18T00:02:00.000Z");
  const store = new JsonlSessionStore(crashed.sessionsRoot, { now: () => crashed.now });
  const runtime = await createAgentRuntime({
    dataDir: crashed.dataDir,
    sessionStore: store,
    idFactory: crashed.idFactory,
    now: () => crashed.now,
  });
  // Workspace handles are deliberately process-local. Recovery is bound to
  // the stable canonical-root digest, not this newly issued handle id.
  const workspace = WorkspaceHandleSchema.parse({
    ...crashed.workspace,
    handle_id: "workspace:after-restart",
    created_at: crashed.now.toISOString(),
  });
  return { runtime, store, workspace };
}

async function createHarness(): Promise<{
  dataDir: string;
  sessionsRoot: string;
  workspace: WorkspaceHandle;
  idFactory: (prefix: string) => string;
  now: Date;
}> {
  const root = await mkdtemp(join(tmpdir(), "tracegraph-action-recovery-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await mkdir(join(workspaceRoot, "test"), { recursive: true });
  await writeFile(
    join(workspaceRoot, "src/add.ts"),
    "export function add(left: number, right: number) {\n  return left - right;\n}\n",
  );
  await writeFile(
    join(workspaceRoot, "test/run.mjs"),
    [
      'import { readFileSync } from "node:fs";',
      'const source = readFileSync(new URL("../src/add.ts", import.meta.url), "utf8");',
      'if (!source.includes("return left + right;")) process.exit(1);',
      'console.log("fixture passed");',
      "",
    ].join("\n"),
  );
  let id = 0;
  const now = new Date("2026-09-18T00:00:00.000Z");
  return {
    dataDir: join(root, "data"),
    sessionsRoot: join(root, "data", "sessions"),
    workspace: WorkspaceHandleSchema.parse({
      handle_id: "workspace:before-crash",
      project_id: "project:action-recovery",
      real_root: await realpath(workspaceRoot),
      workspace_kind: "disposable_fixture",
      capabilities: DISPOSABLE_FIXTURE_CAPABILITIES,
      created_at: now.toISOString(),
    }),
    idFactory: (prefix) => `${prefix}:${String(++id).padStart(6, "0")}`,
    now,
  };
}

function startInput(workspace: WorkspaceHandle) {
  return {
    command_id: "command:start-action-recovery",
    project_id: workspace.project_id,
    task: "Fix the deterministic arithmetic defect.",
    mode: "execute" as const,
    workspace,
  };
}

async function source(root: string): Promise<string> {
  return readFile(join(root, "src/add.ts"), "utf8");
}

async function waitForApproval(runtime: AgentRuntime, runId: string) {
  const deadline = Date.now() + DURABILITY_TEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const projection = await runtime.getProjection(runId);
    if (projection.status === "awaiting_approval") return projection;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for patch approval");
}
