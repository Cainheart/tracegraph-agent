import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISPOSABLE_FIXTURE_CAPABILITIES,
  WorkspaceHandleSchema,
  type ArtifactRef,
  type WorkspaceHandle,
} from "@tracegraph/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlEventLedger } from "./event-ledger.js";
import { DeterministicFakeModel } from "./fake-model.js";
import {
  RuntimeCommandError,
  createAgentRuntime as createAgentRuntimeWithNativeSandbox,
  type AgentRuntime,
} from "./runtime.js";
import { createFixtureSandboxRunner } from "./sandbox/fixture-runner.js";
import { DurableSessionController } from "./session-controller.js";
import { sha256, stableStringify } from "./crypto.js";
import {
  JsonlSessionStore,
  SessionLeaseConflictError,
} from "./session-store.js";
import type { ModelAdapter } from "./types.js";

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

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("durable Session runtime recovery", { timeout: 15_000 }, () => {
  it("indexes only event references and resumes a pending patch with a fresh approval", async () => {
    const harness = await createHarness();
    const idFactory = sequentialIdFactory();
    const observedContexts: string[] = [];
    const fake = new DeterministicFakeModel({ idFactory });
    const model: ModelAdapter = {
      name: "recovery-context-model",
      async decide(input) {
        if (input.observations.at(-1)?.facts.tool_name === "commit_patch") {
          observedContexts.push(input.context);
        }
        return fake.decide(input);
      },
    };
    const firstStore = deadWriterStore(harness.sessionsRoot, () => harness.now);
    const firstRuntime = await createAgentRuntime({
      dataDir: harness.dataDir,
      sessionStore: firstStore,
      idFactory,
      now: () => harness.now,
      model,
    });

    const started = await firstRuntime.startRun(startInput(harness.workspace));
    const waiting = await waitForStatus(firstRuntime, started.run_id, "awaiting_approval");
    const oldApproval = waiting.pending_approval!;
    const stored = await waitForSessionIndex(firstStore, waiting.session_id!, waiting.timeline.length);

    expect(stored.header.run_ids).toEqual([waiting.run_id]);
    expect(stored.entries).toHaveLength(waiting.timeline.length);
    expect(stored.entries.every((entry) => (
      Object.keys(entry).sort().join(",")
      === ["created_at", "entry_id", "event_ref", "kind", "parent_entry_id", "session_version"]
        .filter((key) => key !== "parent_entry_id" || entry.parent_entry_id !== undefined)
        .sort()
        .join(",")
    ))).toBe(true);
    expect(JSON.stringify(stored)).not.toContain("conversation_history");
    expect(waiting.timeline.every((event) => event.session_id === waiting.session_id)).toBe(true);
    expect(JSON.stringify(waiting)).not.toContain("_internal_recovery_artifact");
    expect(JSON.stringify(waiting)).not.toContain("run_recovery_state");
    expect(JSON.stringify(waiting)).not.toContain("pending_patch_recovery_state");

    harness.now = new Date("2026-09-18T00:02:00.000Z");
    const restartedStore = new JsonlSessionStore(harness.sessionsRoot, { now: () => harness.now });
    const restartedRuntime = await createAgentRuntime({
      dataDir: harness.dataDir,
      sessionStore: restartedStore,
      idFactory,
      now: () => harness.now,
      model,
    });
    const interrupted = await restartedRuntime.markRunInterrupted(locator(waiting));
    const interruptedAgain = await restartedRuntime.markRunInterrupted(locator(waiting));

    expect(interrupted.status).toBe("interrupted");
    expect(interruptedAgain.timeline.filter((event) => event.type === "run.interrupted")).toHaveLength(1);
    expect(interruptedAgain.timeline.map((event) => event.sequence)).toEqual(
      interruptedAgain.timeline.map((_, index) => index + 1),
    );

    const toolEventCount = interruptedAgain.timeline.filter((event) => event.type.startsWith("tool.")).length;
    const resumed = await restartedRuntime.resumeRun({
      ...locator(waiting),
      commandId: "command:resume",
      workspace: harness.workspace,
    });
    const renewedApproval = resumed.pending_approval!;

    expect(resumed.status).toBe("awaiting_approval");
    expect(renewedApproval.approval_id).not.toBe(oldApproval.approval_id);
    expect(Date.parse(renewedApproval.preview.expires_at)).toBeGreaterThan(
      Date.parse(oldApproval.preview.expires_at),
    );
    expect(resumed.timeline.filter((event) => event.type.startsWith("tool.")).length).toBe(toolEventCount);
    expect(JSON.stringify(resumed)).not.toContain("_internal_recovery_artifact");
    expect(await source(harness.workspace.real_root)).toContain("return left - right;");

    await expect(restartedRuntime.approve({
      type: "approve",
      command_id: "command:old-approval",
      project_id: waiting.project_id,
      run_id: waiting.run_id,
      approval_id: oldApproval.approval_id,
      action_id: oldApproval.action_id,
    })).rejects.toMatchObject({ code: "approval_binding_mismatch" });
    expect(await source(harness.workspace.real_root)).toContain("return left - right;");

    const completed = await restartedRuntime.approve({
      type: "approve",
      command_id: "command:new-approval",
      project_id: waiting.project_id,
      run_id: waiting.run_id,
      approval_id: renewedApproval.approval_id,
      action_id: renewedApproval.action_id,
    });

    expect(completed.status).toBe("completed");
    expect(await source(harness.workspace.real_root)).toContain("return left + right;");
    expect(observedContexts).toHaveLength(1);
    expect(observedContexts[0]).toContain("RESTORED_CONVERSATION_SENTINEL");
    expect(completed.timeline.every((event) => event.session_id === waiting.session_id)).toBe(true);
    expect(completed.timeline.map((event) => event.sequence)).toEqual(
      completed.timeline.map((_, index) => index + 1),
    );
  });

  it.each(["missing", "corrupt"] as const)(
    "fails closed when the %s recovery Artifact cannot be verified",
    async (failureMode) => {
      const setup = await createInterruptedRun();
      const ledger = new JsonlEventLedger(join(setup.harness.dataDir, "events"));
      const events = await ledger.list(setup.waiting.run_id);
      const sourceEvent = failureMode === "missing"
        ? [...events].reverse().find((event) => event.type === "approval.requested")
        : events[0];
      const artifact = sourceEvent?.data._internal_recovery_artifact as ArtifactRef | undefined;
      expect(artifact?.kind).toBe("recovery_state");
      const contentPath = join(
        setup.harness.dataDir,
        "artifacts",
        `${safeArtifactId(artifact!.artifact_id)}.data`,
      );
      if (failureMode === "missing") {
        await unlink(contentPath);
      } else {
        await writeFile(contentPath, "{\"kind\":\"run_recovery_state\",\"tampered\":true}\n");
      }

      await expect(setup.runtime.resumeRun({
        ...locator(setup.waiting),
        commandId: `command:resume-${failureMode}`,
        workspace: setup.harness.workspace,
      })).rejects.toMatchObject<Partial<RuntimeCommandError>>({
        code: "recovery_state_unavailable",
      });
      expect(await source(setup.harness.workspace.real_root)).toContain("return left - right;");
      expect((await setup.runtime.getProjection(setup.waiting.run_id)).status).toBe("interrupted");
    },
  );

  it("normalizes a malformed pending recovery reference to a fail-closed Runtime error", async () => {
    const setup = await createInterruptedRun();
    const eventPath = join(
      setup.harness.dataDir,
      "events",
      `${setup.waiting.run_id.replace(/[^A-Za-z0-9_.-]/gu, "_")}.jsonl`,
    );
    const ledger = new JsonlEventLedger(join(setup.harness.dataDir, "events"));
    const events = await ledger.list(setup.waiting.run_id);
    const approvalIndex = events.findIndex((event) => event.type === "approval.requested");
    expect(approvalIndex).toBeGreaterThanOrEqual(0);
    events[approvalIndex] = {
      ...events[approvalIndex]!,
      data: {
        ...events[approvalIndex]!.data,
        _internal_recovery_artifact: { artifact_id: "malformed-only-id" },
      },
    };
    for (let index = approvalIndex; index < events.length; index += 1) {
      const event = events[index]!;
      const previous = events[index - 1];
      const { event_hash: _discardedHash, previous_event_hash: _discardedPrevious, ...body } = event;
      const rebuilt = {
        ...body,
        ...(previous === undefined ? {} : { previous_event_hash: previous.event_hash }),
      };
      events[index] = { ...rebuilt, event_hash: sha256(stableStringify(rebuilt)) };
    }
    await writeFile(eventPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);

    await expect(setup.runtime.resumeRun({
      ...locator(setup.waiting),
      commandId: "command:resume-malformed-reference",
      workspace: setup.harness.workspace,
    })).rejects.toMatchObject<Partial<RuntimeCommandError>>({
      name: "RuntimeCommandError",
      code: "recovery_state_unavailable",
    });
    expect((await setup.runtime.getProjection(setup.waiting.run_id)).status).toBe("interrupted");
  });

  it("rejects restart recovery while the original writer still holds the Session lease", async () => {
    const harness = await createHarness();
    const idFactory = sequentialIdFactory();
    const firstStore = new JsonlSessionStore(harness.sessionsRoot, { now: () => harness.now });
    const firstRuntime = await createAgentRuntime({
      dataDir: harness.dataDir,
      sessionStore: firstStore,
      idFactory,
      now: () => harness.now,
    });
    const started = await firstRuntime.startRun(startInput(harness.workspace));
    const waiting = await waitForStatus(firstRuntime, started.run_id, "awaiting_approval");
    await waitForSessionIndex(firstStore, waiting.session_id!, waiting.timeline.length);
    const contender = await createAgentRuntime({
      dataDir: harness.dataDir,
      sessionStore: new JsonlSessionStore(harness.sessionsRoot, { now: () => harness.now }),
      idFactory,
      now: () => harness.now,
    });

    await expect(contender.markRunInterrupted(locator(waiting)))
      .rejects.toBeInstanceOf(SessionLeaseConflictError);
    expect((await contender.getProjection(waiting.run_id)).status).toBe("awaiting_approval");

    await firstRuntime.reject({
      type: "reject",
      command_id: "command:cleanup-reject",
      project_id: waiting.project_id,
      run_id: waiting.run_id,
      approval_id: waiting.pending_approval!.approval_id,
      action_id: waiting.pending_approval!.action_id,
      reason: "release test lease",
    });
  });

  it("repairs an incomplete Session tail under lease and records the recovery fact before interruption", async () => {
    const harness = await createHarness();
    const idFactory = sequentialIdFactory();
    const firstStore = deadWriterStore(harness.sessionsRoot, () => harness.now);
    const firstRuntime = await createAgentRuntime({
      dataDir: harness.dataDir,
      sessionStore: firstStore,
      idFactory,
      now: () => harness.now,
    });
    const started = await firstRuntime.startRun(startInput(harness.workspace));
    const waiting = await waitForStatus(firstRuntime, started.run_id, "awaiting_approval");
    await waitForSessionIndex(firstStore, waiting.session_id!, waiting.timeline.length);
    const sessionPath = await onlySessionFile(harness.sessionsRoot);
    await appendFile(sessionPath, '{"kind":"event_ref","session_version":1,"entry_id":');

    harness.now = new Date("2026-09-18T00:03:00.000Z");
    const restartedStore = new JsonlSessionStore(harness.sessionsRoot, { now: () => harness.now });
    const restartedRuntime = await createAgentRuntime({
      dataDir: harness.dataDir,
      sessionStore: restartedStore,
      idFactory,
      now: () => harness.now,
    });
    const controller = new DurableSessionController({
      store: restartedStore,
      runtime: restartedRuntime,
      idFactory,
      now: () => harness.now,
    });
    const report = await controller.recover();

    expect(report).toMatchObject({
      scanned_sessions: 1,
      truncated_session_ids: [waiting.session_id],
      interrupted_run_ids: [waiting.run_id],
    });
    const recovered = await restartedRuntime.getProjection(waiting.run_id);
    expect(recovered.status).toBe("interrupted");
    expect(recovered.timeline.filter((event) => event.type === "session.tail_truncated")).toHaveLength(1);
    expect(recovered.timeline.filter((event) => event.type === "run.interrupted")).toHaveLength(1);
    expect(recovered.timeline.map((event) => event.sequence))
      .toEqual(recovered.timeline.map((_, index) => index + 1));
    await expect(restartedStore.readAll(waiting.session_id!)).resolves.toMatchObject({
      truncated: false,
      entries: { length: recovered.timeline.length },
    });
    const repairedText = await readFile(sessionPath, "utf8");
    expect(repairedText.endsWith("\n")).toBe(true);
    expect(() => repairedText.trimEnd().split("\n").map((line) => JSON.parse(line))).not.toThrow();
  });

  it("marks every nonterminal Run referenced by a recovered Session as interrupted", async () => {
    const harness = await createHarness();
    const idFactory = sequentialIdFactory();
    const firstStore = deadWriterStore(harness.sessionsRoot, () => harness.now);
    const firstRuntime = await createAgentRuntime({
      dataDir: harness.dataDir,
      sessionStore: firstStore,
      idFactory,
      now: () => harness.now,
    });
    const firstStarted = await firstRuntime.startRun(startInput(harness.workspace));
    const firstWaiting = await waitForStatus(firstRuntime, firstStarted.run_id, "awaiting_approval");
    await waitForSessionIndex(firstStore, firstWaiting.session_id!, firstWaiting.timeline.length);

    // Bypass Host recovery deliberately to construct the adversarial state:
    // two unfinished Runs referenced by one Session after successive process
    // deaths. Startup recovery must not inspect only run_ids.at(-1).
    const secondStore = deadWriterStore(harness.sessionsRoot, () => harness.now, 2_147_483_645);
    const secondRuntime = await createAgentRuntime({
      dataDir: harness.dataDir,
      sessionStore: secondStore,
      idFactory,
      now: () => harness.now,
    });
    const secondStarted = await secondRuntime.startRun({
      ...startInput(harness.workspace),
      command_id: "command:start-second-unfinished-run",
      session_id: firstWaiting.session_id,
    });
    const secondWaiting = await waitForStatus(secondRuntime, secondStarted.run_id, "awaiting_approval");
    await waitForSessionIndex(
      secondStore,
      firstWaiting.session_id!,
      firstWaiting.timeline.length + secondWaiting.timeline.length,
    );

    const restartedStore = new JsonlSessionStore(harness.sessionsRoot, { now: () => harness.now });
    const restartedRuntime = await createAgentRuntime({
      dataDir: harness.dataDir,
      sessionStore: restartedStore,
      idFactory,
      now: () => harness.now,
    });
    const report = await new DurableSessionController({
      store: restartedStore,
      runtime: restartedRuntime,
      idFactory,
      now: () => harness.now,
    }).recover();

    expect(report.interrupted_run_ids).toEqual([firstWaiting.run_id, secondWaiting.run_id]);
    await expect(restartedRuntime.getProjection(firstWaiting.run_id)).resolves.toMatchObject({
      status: "interrupted",
    });
    await expect(restartedRuntime.getProjection(secondWaiting.run_id)).resolves.toMatchObject({
      status: "interrupted",
    });
  });

  it("preserves ordered title facts when a Session is renamed A to B to A", async () => {
    const harness = await createHarness();
    const idFactory = sequentialIdFactory();
    const store = new JsonlSessionStore(harness.sessionsRoot, { now: () => harness.now });
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      sessionStore: store,
      idFactory,
      now: () => harness.now,
    });
    const started = await runtime.startRun(startInput(harness.workspace));
    const waiting = await waitForStatus(runtime, started.run_id, "awaiting_approval");
    await waitForSessionIndex(store, waiting.session_id!, waiting.timeline.length);
    await runtime.reject({
      type: "reject",
      command_id: "command:finish-before-renames",
      project_id: waiting.project_id,
      run_id: waiting.run_id,
      approval_id: waiting.pending_approval!.approval_id,
      action_id: waiting.pending_approval!.action_id,
      reason: "release the writer lease before metadata mutations",
    });
    const controller = new DurableSessionController({ store, runtime, idFactory, now: () => harness.now });

    await controller.rename(waiting.session_id!, { title: "Alpha" });
    await controller.rename(waiting.session_id!, { title: "Beta" });
    await controller.rename(waiting.session_id!, { title: "Alpha" });

    const titleEvents = (await runtime.getProjection(waiting.run_id)).timeline
      .filter((event) => event.type === "session.title_changed")
      .map((event) => event.data.title);
    expect(titleEvents).toEqual(["Alpha", "Beta", "Alpha"]);
    expect((await store.readAll(waiting.session_id!)).header.title).toBe("Alpha");
    await controller.recover();
    expect((await store.readAll(waiting.session_id!)).header.title).toBe("Alpha");

    const secret = "sk-session-title-abcdefghijklmnop";
    const redacted = await controller.rename(waiting.session_id!, { title: `Secret ${secret}` });
    expect(redacted.header.title).toContain("[REDACTED_API_KEY]");
    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(JSON.stringify(await runtime.getProjection(waiting.run_id))).not.toContain(secret);
  });
});

async function createInterruptedRun() {
  const harness = await createHarness();
  const idFactory = sequentialIdFactory();
  const firstStore = deadWriterStore(harness.sessionsRoot, () => harness.now);
  const firstRuntime = await createAgentRuntime({
    dataDir: harness.dataDir,
    sessionStore: firstStore,
    idFactory,
    now: () => harness.now,
  });
  const started = await firstRuntime.startRun(startInput(harness.workspace));
  const waiting = await waitForStatus(firstRuntime, started.run_id, "awaiting_approval");
  await waitForSessionIndex(firstStore, waiting.session_id!, waiting.timeline.length);
  harness.now = new Date("2026-09-18T00:02:00.000Z");
  const runtime = await createAgentRuntime({
    dataDir: harness.dataDir,
    sessionStore: new JsonlSessionStore(harness.sessionsRoot, { now: () => harness.now }),
    idFactory,
    now: () => harness.now,
  });
  await runtime.markRunInterrupted(locator(waiting));
  return { harness, runtime, waiting };
}

function deadWriterStore(
  root: string,
  now: () => Date,
  pid = 2_147_483_646,
): JsonlSessionStore {
  return new JsonlSessionStore(root, {
    now,
    // Simulate a Session left by a process which is gone when the next Host
    // starts. The fresh contender may take over immediately on the same host.
    pid,
  });
}

async function createHarness(): Promise<{
  dataDir: string;
  sessionsRoot: string;
  workspace: WorkspaceHandle;
  now: Date;
}> {
  const root = await mkdtemp(join(tmpdir(), "tracegraph-session-runtime-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, "workspace");
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await mkdir(join(workspaceRoot, "test"), { recursive: true });
  await writeFile(
    join(workspaceRoot, "src", "add.ts"),
    "export function add(left: number, right: number) {\n  return left - right;\n}\n",
  );
  await writeFile(
    join(workspaceRoot, "test", "run.mjs"),
    [
      'import { readFileSync } from "node:fs";',
      'const source = readFileSync(new URL("../src/add.ts", import.meta.url), "utf8");',
      'if (!source.includes("return left + right;")) process.exit(1);',
      'console.log("fixture passed");',
      "",
    ].join("\n"),
  );
  const dataDir = join(root, "data");
  return {
    dataDir,
    sessionsRoot: join(dataDir, "sessions"),
    workspace: WorkspaceHandleSchema.parse({
      handle_id: "workspace:session-recovery",
      project_id: "project:session-recovery",
      real_root: await realpath(workspaceRoot),
      workspace_kind: "disposable_fixture",
      capabilities: DISPOSABLE_FIXTURE_CAPABILITIES,
      created_at: "2026-09-18T00:00:00.000Z",
    }),
    now: new Date("2026-09-18T00:00:00.000Z"),
  };
}

function startInput(workspace: WorkspaceHandle) {
  return {
    command_id: "command:start-session-recovery",
    project_id: workspace.project_id,
    task: "Fix the deterministic arithmetic defect.",
    mode: "execute" as const,
    conversation_history: [
      { role: "user" as const, content: "RESTORED_CONVERSATION_SENTINEL" },
      { role: "assistant" as const, content: "I will preserve this context across restart." },
    ],
    workspace,
  };
}

function locator(projection: {
  session_id?: string | undefined;
  run_id: string;
  project_id: string;
}) {
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

async function source(root: string): Promise<string> {
  return readFile(join(root, "src", "add.ts"), "utf8");
}

async function waitForStatus(
  runtime: AgentRuntime,
  runId: string,
  status: "awaiting_approval",
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const projection = await runtime.getProjection(runId);
    if (projection.status === status) return projection;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const final = await runtime.getProjection(runId);
  throw new Error(`Timed out waiting for ${status}: ${JSON.stringify({
    status: final.status,
    failure_code: final.failure_code,
    events: final.timeline.map((event) => [event.type, event.summary]),
  })}`);
}

async function onlySessionFile(root: string): Promise<string> {
  const entries = await readdir(root, { recursive: true });
  const matches = entries.filter((entry) => entry.endsWith(".jsonl"));
  if (matches.length !== 1) throw new Error(`Expected one Session file, found ${matches.length}`);
  return join(root, matches[0]!);
}

async function waitForSessionIndex(
  store: JsonlSessionStore,
  sessionId: string,
  expectedEntries: number,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const stored = await store.readAll(sessionId);
      if (stored.entries.length === expectedEntries) return stored;
    } catch {
      // The ledger becomes visible just before the reference index's atomic
      // rename. Retry until the in-process writer is quiescent.
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${expectedEntries} indexed Session events`);
}

function safeArtifactId(artifactId: string): string {
  return artifactId.replace(/[^A-Za-z0-9_.-]/gu, "_");
}
