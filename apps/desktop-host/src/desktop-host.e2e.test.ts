import { fork, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  ExperienceControlListResponseSchema,
  MemoryControlListResponseSchema,
  RunProjectionSchema,
  SessionListResponseSchema,
} from "@tracegraph/contracts";
import { CLIENT_PROTOCOL_VERSION } from "@tracegraph/sdk/protocol";
import { createFailingTypescriptFixture, createTemporaryDataDir } from "@tracegraph/test-support";
import { afterEach, describe, expect, it } from "vitest";
import {
  DesktopHostStartupErrorSchema,
} from "./lifecycle-protocol.js";
import {
  DesktopHostStartupError,
  launchDesktopHostProcess,
  type LaunchedDesktopHost,
} from "./host-process.js";

const liveChildren = new Set<ChildProcess>();
const liveHosts = new Set<LaunchedDesktopHost>();
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const host of liveHosts) {
    host.childProcess.kill("SIGKILL");
  }
  for (const child of liveChildren) child.kill("SIGKILL");
  await Promise.all([
    ...[...liveHosts].map((host) => host.exit.catch(() => undefined)),
    ...[...liveChildren].map((child) => waitForProcessExit(child)),
  ]);
  liveHosts.clear();
  liveChildren.clear();
  await Promise.allSettled(cleanups.splice(0).reverse().map((cleanup) => cleanup()));
});

describe("Desktop Host process lifecycle", { timeout: 45_000 }, () => {
  it("launches without a GUI, serves a schema-valid Session query, and exits cleanly on EOF", async () => {
    const data = await createTemporaryDataDir();
    cleanups.push(data.cleanup);
    const host = await launchDesktopHostProcess({ dataDir: data.path });
    liveHosts.add(host);
    expect(host.identity).toEqual({
      package_name: "@tracegraph/desktop-host",
      package_version: "0.1.0-alpha.0",
      protocol_version: CLIENT_PROTOCOL_VERSION,
    });

    const reply = await host.client.query({ operation: "session.list", input: { view: "roots", limit: 20 } });
    expect(reply.resource).toBe("sessions");
    expect(SessionListResponseSchema.parse(reply.value).sessions).toEqual([]);
    const memory = await host.client.query({ operation: "memory.list" });
    expect(memory.resource).toBe("memory_control");
    expect(MemoryControlListResponseSchema.parse(memory.value)).toEqual({
      items: [], conflicts: [], backgroundJobs: [], backgroundJobsLoading: expect.any(Boolean),
    });
    await expect.poll(async () => {
      const refreshed = await host.client.query({ operation: "memory.list" });
      return MemoryControlListResponseSchema.parse(refreshed.value).backgroundJobsLoading;
    }).toBe(false);
    const experience = await host.client.query({ operation: "experience.list" });
    expect(experience.resource).toBe("experience_cases");
    expect(ExperienceControlListResponseSchema.parse(experience.value)).toEqual({ items: [] });
    await expect(host.close()).resolves.toEqual({ code: 0, signal: null });
    liveHosts.delete(host);
  });

  it("rejects an exact package version mismatch before opening framed RPC", async () => {
    const data = await createTemporaryDataDir();
    cleanups.push(data.cleanup);
    await expect(launchDesktopHostProcess({
      dataDir: data.path,
      expectedHostVersion: "0.0.0-incompatible",
    })).rejects.toMatchObject<Partial<DesktopHostStartupError>>({ code: "version_mismatch" });

    const worker = fork(fileURLToPath(new URL("../dist/worker.js", import.meta.url)), [], {
      execArgv: [],
      env: Object.fromEntries(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "LANG", "LC_ALL"]
        .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
      stdio: ["ignore", "pipe", "ignore", "ipc"],
      serialization: "json",
    });
    liveChildren.add(worker);
    let stdout = "";
    worker.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    const failure = await new Promise<unknown>((resolveFailure, rejectFailure) => {
      const timer = setTimeout(() => rejectFailure(new Error("Protocol mismatch startup timed out")), 10_000);
      worker.once("message", (message: unknown) => {
        clearTimeout(timer);
        resolveFailure(message);
      });
      worker.once("error", (error) => {
        clearTimeout(timer);
        rejectFailure(error);
      });
      worker.once("spawn", () => worker.send({
        kind: "start",
        expected_host_version: "0.1.0-alpha.0",
        protocol_version: "tracegraph.client-protocol.incompatible",
        data_dir: data.path,
        projects: [],
      }));
    });
    expect(DesktopHostStartupErrorSchema.parse(failure)).toMatchObject({
      kind: "startup_error",
      code: "version_mismatch",
      actual_protocol_version: CLIENT_PROTOCOL_VERSION,
    });
    await waitForProcessExit(worker);
    liveChildren.delete(worker);
    expect(worker.exitCode).toBe(1);
    expect(stdout).toBe("");
  });

  it("registers native folders through the private control channel and restores/removes grants across restart", async () => {
    const data = await createTemporaryDataDir();
    const fixture = await createFailingTypescriptFixture("fixture-desktop-native-project");
    cleanups.push(data.cleanup, fixture.cleanup);
    const first = await launchDesktopHostProcess({ dataDir: data.path });
    liveHosts.add(first);

    const registered = await first.native.registerProject({
      selectedPath: fixture.handle.real_root,
      access: "read_write",
    });
    await expect(first.native.listProjects()).resolves.toEqual([registered]);
    expect(JSON.stringify(registered)).not.toContain(fixture.handle.real_root);
    expect(JSON.stringify(registered)).not.toContain("handle_id");
    expect(await first.native.resolveProjectRoot(registered.project_id)).toBe(fixture.handle.real_root);
    await expect(first.close()).resolves.toEqual({ code: 0, signal: null });
    liveHosts.delete(first);

    const second = await launchDesktopHostProcess({ dataDir: data.path });
    liveHosts.add(second);
    await expect(second.native.listProjects()).resolves.toEqual([registered]);
    expect(await second.native.resolveProjectRoot(registered.project_id)).toBe(fixture.handle.real_root);
    await expect(second.native.removeProject(registered.project_id)).resolves.toBe(true);
    await expect(second.native.resolveProjectRoot(registered.project_id)).rejects.toThrow("Desktop project operation failed");
    await expect(second.native.listProjects()).resolves.toEqual([]);
    await expect(second.close()).resolves.toEqual({ code: 0, signal: null });
    liveHosts.delete(second);

    // Unregistering revokes authority without deleting the user's selected folder.
    expect((await stat(fixture.handle.real_root)).isDirectory()).toBe(true);
  });

  it("recovers a killed active Run once and preserves it across Host crash and relaunch", async () => {
    const data = await createTemporaryDataDir();
    const fixture = await createFailingTypescriptFixture("fixture-desktop-host-recovery");
    cleanups.push(data.cleanup, fixture.cleanup);
    const seeded = await seedActiveRun(data.path, fixture.handle);
    const projects = [{ workspace: fixture.handle }];
    const first = await launchDesktopHostProcess({ dataDir: data.path, projects });
    liveHosts.add(first);
    expect(first.identity.package_version).toBe("0.1.0-alpha.0");
    expect(first.sessionRecovery.interrupted_run_ids).toEqual([seeded.runId]);

    const firstReply = await first.client.query({ operation: "run.get", run_id: seeded.runId });
    if (firstReply.resource !== "run") throw new Error("run.get returned a non-Run resource");
    const interrupted = RunProjectionSchema.parse(firstReply.value);
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.timeline.filter((event) => event.type === "run.interrupted")).toHaveLength(1);
    expect(interrupted.session_id).toBe(seeded.sessionId);

    first.childProcess.kill("SIGKILL");
    await first.exit;
    liveHosts.delete(first);

    const second = await launchDesktopHostProcess({ dataDir: data.path, projects });
    liveHosts.add(second);
    expect(second.sessionRecovery.interrupted_run_ids).toEqual([]);
    const secondReply = await second.client.query({ operation: "run.get", run_id: seeded.runId });
    if (secondReply.resource !== "run") throw new Error("run.get returned a non-Run resource");
    const afterRestart = RunProjectionSchema.parse(secondReply.value);
    expect(afterRestart.status).toBe("interrupted");
    expect(afterRestart.timeline.filter((event) => event.type === "run.interrupted")).toHaveLength(1);
    expect(afterRestart.timeline).toEqual(interrupted.timeline);
    await expect(second.close()).resolves.toEqual({ code: 0, signal: null });
    liveHosts.delete(second);
  });
});

async function seedActiveRun(dataDir: string, workspace: unknown): Promise<{ runId: string; sessionId: string }> {
  const helper = fileURLToPath(new URL("./recovery-seed-worker.mjs", import.meta.url));
  const seedEnvironment = Object.fromEntries(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "LANG", "LC_ALL"]
    .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
  const child = fork(helper, [], {
    cwd: resolve(process.cwd()),
    execArgv: ["--import", "tsx"],
    env: seedEnvironment,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    serialization: "json",
  });
  liveChildren.add(child);
  child.stderr?.resume();
  try {
    const ready = new Promise<{ runId: string; sessionId: string }>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error("Recovery seed worker timed out")), 20_000);
      child.on("message", (message: unknown) => {
        if (typeof message !== "object" || message === null) return;
        const record = message as Record<string, unknown>;
        if (record.kind === "seeded" && typeof record.run_id === "string" && typeof record.session_id === "string") {
          clearTimeout(timer);
          resolveReady({ runId: record.run_id, sessionId: record.session_id });
        } else if (record.kind === "seed_error") {
          clearTimeout(timer);
          reject(new Error(typeof record.message === "string" ? record.message : "Recovery seed failed"));
        }
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`Recovery seed worker exited before seeding (code=${String(code)}, signal=${String(signal)})`));
      });
    });
    child.once("spawn", () => child.send({ dataDir, workspace }));
    const result = await ready;
    child.kill("SIGKILL");
    await waitForProcessExit(child);
    liveChildren.delete(child);
    return result;
  } catch (error) {
    child.kill("SIGKILL");
    await waitForProcessExit(child);
    liveChildren.delete(child);
    throw error;
  }
}

function waitForProcessExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit) => child.once("exit", () => resolveExit()));
}
