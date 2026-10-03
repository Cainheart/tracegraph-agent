import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DurableSessionController,
  JsonlSessionStore,
  createAgentRuntime,
  type CredentialStore,
} from "@tracegraph/core";
import { createTraceGraphHost } from "@tracegraph/host";
import { TraceGraphClient } from "@tracegraph/sdk";
import { ClientEventMessageSchema, ClientReplyMessageSchema } from "@tracegraph/sdk/protocol";
import {
  createFailingTypescriptFixture,
  createTemporaryDataDir,
} from "@tracegraph/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { createCodeGraphProvider } from "./composition.js";
import { createConfiguredTelemetry } from "./telemetry-config.js";
import { runRunSessionCommand } from "./run-session-command.js";

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

describe("TraceGraph vertical slice", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await drainTrackedRuntimes();
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("reads the Runtime-owned default noop telemetry status through Host and SDK", async () => {
    const data = await createTemporaryDataDir();
    cleanups.push(data.cleanup);
    const runtime = await createTrackedRuntime({
      dataDir: data.path,
      sandboxMode: "danger-full-access",
    });
    const host = await createTraceGraphHost({
      runtime,
      projects: [],
      capabilityToken: "telemetry-e2e-capability-token",
    });
    cleanups.unshift(host.close);
    const address = await host.listen({ port: 0 });
    const client = new TraceGraphClient({ baseUrl: address });

    await client.bootstrap();
    const status = await client.getTelemetryStatus();

    expect(status).toEqual(runtime.getTelemetryStatus());
    expect(status).toEqual({
      schema_version: "tracegraph.telemetry-status.v1",
      sink: "noop",
      state: "disabled",
      error_count: 0,
    });
    await expect(runtime.flushTelemetry()).resolves.toBeUndefined();
    expect(runtime.getTelemetryStatus()).toEqual(status);
  });

  it("composes telemetry.json through Runtime, Host, and SDK without a second status source", async () => {
    const data = await createTemporaryDataDir();
    cleanups.push(data.cleanup);
    await writeFile(join(data.path, "telemetry.json"), JSON.stringify({ sink: "memory", max_events: 8 }));
    const telemetrySink = await createConfiguredTelemetry({
      dataDir: data.path,
      credentialStore: emptyCredentialStore(),
    });
    const runtime = await createTrackedRuntime({
      dataDir: data.path,
      telemetrySink,
      sandboxMode: "danger-full-access",
    });
    const host = await createTraceGraphHost({
      runtime,
      projects: [],
      capabilityToken: "telemetry-configured-e2e-token",
    });
    cleanups.unshift(host.close);
    const client = new TraceGraphClient({ baseUrl: await host.listen({ port: 0 }) });

    await client.bootstrap();
    await expect(client.getTelemetryStatus()).resolves.toEqual({
      schema_version: "tracegraph.telemetry-status.v1",
      sink: "memory",
      state: "active",
      error_count: 0,
    });
    expect(runtime.getTelemetryStatus()).toEqual(await client.getTelemetryStatus());
  });

  it("runs SDK -> Host -> Runtime -> approval -> patch -> test -> graph delta", async () => {
    const data = await createTemporaryDataDir();
    const fixture = await createFailingTypescriptFixture("fixture-e2e");
    cleanups.push(data.cleanup, fixture.cleanup);
    const sessionStore = new JsonlSessionStore(join(data.path, "sessions"));

    const runtime = await createTrackedRuntime({
      dataDir: data.path,
      sessionStore,
      codeGraph: createCodeGraphProvider(),
      // Keep the transport/approval E2E portable; native sandbox behaviour is
      // exercised by the dedicated G13 Core and Runtime integration suites.
      sandboxMode: "danger-full-access",
    });
    const host = await createTraceGraphHost({
      runtime,
      sessions: new DurableSessionController({ store: sessionStore, runtime }),
      projects: [{ label: "Failing TypeScript fixture", workspace: fixture.handle }],
      capabilityToken: "e2e-capability-token",
    });
    cleanups.unshift(host.close);
    const address = await host.listen({ port: 0 });
    // This intentionally uses the default Node fetch adapter. The SDK must add
    // the Host-approved loopback Origin without weakening browser Origin checks.
    const client = new TraceGraphClient({ baseUrl: address });

    await client.bootstrap();
    const projects = await client.listProjects();
    expect(projects).toEqual([
      expect.objectContaining({
        project_id: "fixture-e2e",
        workspace_kind: "disposable_fixture",
      }),
    ]);
    expect(JSON.stringify(projects)).not.toContain(fixture.handle.real_root);

    const before = await readFile(join(fixture.handle.real_root, "src/add.ts"), "utf8");
    const cliStartOutput: string[] = [];
    await runRunSessionCommand("run", [
      "start",
      "--project-id", "fixture-e2e",
      "--task", "Fix the failing test and explain the architecture change",
      "--mode", "execute",
      "--command-id", "command:e2e-start",
    ], {
      createClient: () => client,
      write: (line) => cliStartOutput.push(line),
    });
    expect(cliStartOutput).toHaveLength(1);
    const cliStartReply = ClientReplyMessageSchema.parse(JSON.parse(cliStartOutput[0]!));
    if (cliStartReply.result.resource !== "run") throw new Error("CLI start must return a Run projection");
    const started = cliStartReply.result.value;
    // startRun returns the current Run projection; HTTP success is not a
    // completion receipt. The terminal status is read from a later projection.
    expect(["indexing", "running"]).toContain(started.status);
    const pending = await waitForClientStatus(client, started.run_id, "awaiting_approval");
    expect(pending.status).toBe("awaiting_approval");
    expect(pending.pending_approval).toBeDefined();
    // This disposable fixture is intentionally not a Git repository. The
    // SDK still transports a durable explicit unavailable state instead of
    // silently claiming a clean/stale-base guarantee.
    expect(pending.code_intel).toMatchObject({
      git_context: { status: "unavailable" },
      changed_files: [],
      changed_symbols: [],
    });
    expect(await readFile(join(fixture.handle.real_root, "src/add.ts"), "utf8")).toBe(before);

    const approval = pending.pending_approval;
    if (!approval) throw new Error("Expected the runtime to request approval");
    const completed = await client.approve(pending.run_id, {
      type: "approve",
      command_id: "command:e2e-approve",
      project_id: pending.project_id,
      run_id: pending.run_id,
      approval_id: approval.approval_id,
      action_id: approval.action_id,
      reason: "E2E validates the exact preview binding",
    });

    expect(completed.status).toBe("completed");
    expect(await readFile(join(fixture.handle.real_root, "src/add.ts"), "utf8")).toContain(
      "return left + right;",
    );
    expect(completed.timeline.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "approval.requested",
        "approval.granted",
        "patch.applied",
        "test.completed",
        "graph.delta_created",
        "code.intel_updated",
        "run.completed",
      ]),
    );
    const patchEvent = completed.timeline.find((event) => event.type === "patch.applied");
    const graphEvent = completed.timeline.find((event) => event.type === "graph.delta_created");
    const codeIntelEvent = completed.timeline.find((event) => (
      event.type === "code.intel_updated" && event.patch_event_id !== undefined
    ));
    const testEvent = completed.timeline.find((event) => event.type === "test.completed");
    expect(graphEvent?.patch_event_id).toBe(patchEvent?.event_id);
    expect(codeIntelEvent?.patch_event_id).toBe(patchEvent?.event_id);
    expect(codeIntelEvent?.data).toMatchObject({
      phase: "post_patch",
      changed_files: ["src/add.ts"],
      changed_symbols: [expect.objectContaining({
        name: "add",
        kind: "function",
        file_path: "src/add.ts",
        change: "changed",
      })],
    });
    expect(completed.code_intel).toMatchObject({
      changed_files: ["src/add.ts"],
      changed_symbols: [expect.objectContaining({ name: "add", change: "changed" })],
    });
    expect(testEvent?.patch_event_id).toBe(patchEvent?.event_id);
    expect(completed.timeline.filter((event) => event.type.startsWith("run.") && [
      "run.completed",
      "run.failed",
      "run.cancelled",
    ].includes(event.type))).toHaveLength(1);

    const testLog = completed.artifact_refs.find((artifact) => artifact.kind === "test_log");
    const graphDelta = completed.artifact_refs.find((artifact) => artifact.kind === "graph_delta");
    expect(testLog).toBeDefined();
    expect(graphDelta).toBeDefined();
    if (!testLog || !graphDelta) throw new Error("Expected linked verification artifacts");
    await expect(client.getArtifact(completed.run_id, testLog.artifact_id)).resolves.toMatchObject({
      status: "available",
      artifact: { content_hash: testLog.content_hash },
    });
    const graphDeltaResult = await client.getArtifact(completed.run_id, graphDelta.artifact_id);
    expect(graphDeltaResult).toMatchObject({
      status: "available",
      artifact: { content_hash: graphDelta.content_hash },
    });
    if (graphDeltaResult.status !== "available") {
      throw new Error("Expected an available Graph Delta artifact");
    }
    const graphDeltaBody = JSON.parse(graphDeltaResult.content) as {
      node_changes?: readonly { change?: string }[];
    };
    expect(graphDeltaBody.node_changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ change: "changed" })]),
    );

    const replayed = await client.getRun(completed.run_id);
    expect(replayed.timeline).toEqual(completed.timeline);

    const cliRunOutput: string[] = [];
    await runRunSessionCommand("run", ["get", completed.run_id], {
      createClient: () => client,
      write: (line) => cliRunOutput.push(line),
    });
    const cliRunReply = ClientReplyMessageSchema.parse(JSON.parse(cliRunOutput[0]!));
    if (cliRunReply.result.resource !== "run") throw new Error("CLI run get must return a Run projection");
    expect(cliRunReply.result.value).toEqual(replayed);

    if (completed.session_id === undefined) throw new Error("Expected the completed Run to have a Session");
    const cliSessionsOutput: string[] = [];
    await runRunSessionCommand("sessions", ["list", "--project-id", completed.project_id], {
      createClient: () => client,
      write: (line) => cliSessionsOutput.push(line),
    });
    const cliSessionsReply = ClientReplyMessageSchema.parse(JSON.parse(cliSessionsOutput[0]!));
    if (cliSessionsReply.result.resource !== "sessions") {
      throw new Error("CLI sessions list must return Session summaries");
    }
    expect(cliSessionsReply.result.value.sessions).toEqual(
      expect.arrayContaining([expect.objectContaining({
        session_id: completed.session_id,
        run_ids: expect.arrayContaining([completed.run_id]),
      })]),
    );

    const cliSessionOutput: string[] = [];
    await runRunSessionCommand("sessions", ["get", completed.session_id], {
      createClient: () => client,
      write: (line) => cliSessionOutput.push(line),
    });
    const cliSessionReply = ClientReplyMessageSchema.parse(JSON.parse(cliSessionOutput[0]!));
    if (cliSessionReply.result.resource !== "session") {
      throw new Error("CLI sessions get must return a Session read result");
    }
    expect(cliSessionReply.result.value.header.session_id).toBe(completed.session_id);
    expect(cliSessionReply.result.value.entries.length).toBeGreaterThan(0);

    const controller = new AbortController();
    const streamed: typeof replayed.timeline[number][] = [];
    for await (const event of client.streamEvents(completed.run_id, {
      reconnect: false,
      signal: controller.signal,
    })) {
      streamed.push(event);
      if (streamed.length === replayed.timeline.length) {
        controller.abort();
        break;
      }
    }
    expect(streamed).toEqual(replayed.timeline);

    const cliEventOutput: string[] = [];
    await runRunSessionCommand("run", ["events", completed.run_id], {
      createClient: () => client,
      write: (line) => cliEventOutput.push(line),
    });
    const cliEvents = cliEventOutput.map((line) => ClientEventMessageSchema.parse(JSON.parse(line)));
    expect(cliEvents.map((message) => message.event)).toEqual(
      streamed.map((event) => ({ stream: "ledger", event })),
    );
  }, 30_000);

  it("recovers a killed Host session and reissues its pending approval without rerunning tools", async () => {
    const data = await createTemporaryDataDir();
    const fixture = await createFailingTypescriptFixture("fixture-session-restart-e2e");
    cleanups.push(data.cleanup, fixture.cleanup);
    const sessionsRoot = join(data.path, "sessions");
    const token = "session-restart-capability-token";

    // The synthetic PID models a lease left by a Host process that no longer
    // exists.  This exercises same-host dead-writer takeover without relying
    // on timing out a real child process during the test.
    const firstStore = new JsonlSessionStore(sessionsRoot, {
      pid: 2_147_483_646,
      staleLeaseTimeoutMs: 30_000,
      heartbeatIntervalMs: 10_000,
    });
    const firstRuntime = await createTrackedRuntime({
      dataDir: data.path,
      sessionStore: firstStore,
      codeGraph: createCodeGraphProvider(),
      // Same portability reason as the slice above: this suite proves recovery
      // and approval reissue, not OS isolation. Without this the post-approval
      // run_test fails closed on any host that cannot prove isolation (Linux).
      sandboxMode: "danger-full-access",
    });
    const firstHost = await createTraceGraphHost({
      runtime: firstRuntime,
      sessions: new DurableSessionController({ store: firstStore, runtime: firstRuntime }),
      projects: [{ label: "Restart fixture", workspace: fixture.handle }],
      capabilityToken: token,
    });
    const firstAddress = await firstHost.listen({ port: 0 });
    const firstClient = new TraceGraphClient({ baseUrl: firstAddress });
    await firstClient.bootstrap();
    const started = await firstClient.startRun({
      command_id: "command:restart-e2e-start",
      project_id: fixture.handle.project_id,
      task: "Fix the failing test after a Host restart",
      mode: "execute",
    });
    const waiting = await waitForClientStatus(firstClient, started.run_id, "awaiting_approval");
    const oldApproval = waiting.pending_approval;
    if (oldApproval === undefined || waiting.session_id === undefined) {
      throw new Error("Expected a durable pending approval");
    }
    // GET /runs reads the canonical ledger, while the Session JSONL is a
    // secondary reference index. Wait until the last committed event has been
    // indexed before modelling a process death, so there is no live writer
    // racing the restarted Host inside this single test process.
    await waitForSessionEntryCount(firstStore, waiting.session_id, waiting.timeline.length);
    const sourceBeforeRestart = await readFile(join(fixture.handle.real_root, "src/add.ts"), "utf8");
    await firstHost.close();

    const restartedStore = new JsonlSessionStore(sessionsRoot);
    const restartedRuntime = await createTrackedRuntime({
      dataDir: data.path,
      sessionStore: restartedStore,
      codeGraph: createCodeGraphProvider(),
      // The resumed Run must keep the same permission preset as the Run it
      // recovers, so the restored sandbox report still matches its mode.
      sandboxMode: "danger-full-access",
    });
    const restartedHost = await createTraceGraphHost({
      runtime: restartedRuntime,
      sessions: new DurableSessionController({ store: restartedStore, runtime: restartedRuntime }),
      projects: [{ label: "Restart fixture", workspace: fixture.handle }],
      capabilityToken: token,
    });
    cleanups.unshift(restartedHost.close);
    const restartedAddress = await restartedHost.listen({ port: 0 });
    const restartedClient = new TraceGraphClient({ baseUrl: restartedAddress });
    const bootstrap = await restartedClient.bootstrap();

    expect(bootstrap.recovery).toMatchObject({
      scanned_sessions: 1,
      interrupted_run_ids: [waiting.run_id],
    });
    const sessions = await restartedClient.listSessions({
      project_id: fixture.handle.project_id,
      q: "Host restart",
    });
    expect(sessions.sessions).toEqual([
      expect.objectContaining({
        session_id: waiting.session_id,
        run_ids: [waiting.run_id],
      }),
    ]);

    const interrupted = await restartedClient.getRun(waiting.run_id);
    expect(interrupted.status).toBe("interrupted");
    const toolEventsBeforeResume = interrupted.timeline.filter((event) => event.type.startsWith("tool.")).length;
    expect(await readFile(join(fixture.handle.real_root, "src/add.ts"), "utf8")).toBe(sourceBeforeRestart);

    await restartedClient.resumeSession(waiting.session_id, {
      command_id: "command:restart-e2e-resume",
    });
    const resumed = await restartedClient.getRun(waiting.run_id);
    expect(resumed.status).toBe("awaiting_approval");
    expect(resumed.pending_approval?.approval_id).not.toBe(oldApproval.approval_id);
    expect(resumed.timeline.filter((event) => event.type.startsWith("tool.")).length)
      .toBe(toolEventsBeforeResume);
    expect(resumed.timeline.map((event) => event.sequence))
      .toEqual(resumed.timeline.map((_, index) => index + 1));
    expect(await readFile(join(fixture.handle.real_root, "src/add.ts"), "utf8")).toBe(sourceBeforeRestart);

    const approval = resumed.pending_approval;
    if (approval === undefined) throw new Error("Expected a reissued approval");
    const completed = await restartedClient.approve(resumed.run_id, {
      type: "approve",
      command_id: "command:restart-e2e-approve",
      project_id: resumed.project_id,
      run_id: resumed.run_id,
      approval_id: approval.approval_id,
      action_id: approval.action_id,
    });
    expect(completed.status).toBe("completed");
    expect(completed.timeline.map((event) => event.sequence))
      .toEqual(completed.timeline.map((_, index) => index + 1));
    expect(await readFile(join(fixture.handle.real_root, "src/add.ts"), "utf8"))
      .toContain("return left + right;");
  }, 30_000);
});

function emptyCredentialStore(): CredentialStore {
  return {
    async get() { return null; },
    async set() {},
    async delete() {},
    async list() { return []; },
  };
}

async function waitForClientStatus(
  client: TraceGraphClient,
  runId: string,
  status: "awaiting_approval" | "completed" | "failed" | "cancelled" | "interrupted",
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const projection = await client.getRun(runId);
    if (projection.status === status) return projection;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Timed out waiting for ${status}`);
}

async function waitForSessionEntryCount(
  store: JsonlSessionStore,
  sessionId: string,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if ((await store.readAll(sessionId)).entries.length >= expected) return;
    } catch {
      // An atomic index rewrite may fall between lstat/open. A real killed
      // process cannot keep doing this; retry until the in-process writer is
      // quiescent, then start the replacement Host.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(`Timed out waiting for Session ${sessionId} to index ${expected} events`);
}
