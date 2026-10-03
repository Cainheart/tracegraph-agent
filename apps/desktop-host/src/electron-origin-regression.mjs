/** Isolated regression worker; never uses user data or a configured provider. */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentRuntime, DeterministicFakeModel } from "@tracegraph/core";
import { FramedRpcClient } from "@tracegraph/sdk/client";
import { createFailingTypescriptFixture, createTemporaryDataDir } from "@tracegraph/test-support";
import { createDesktopHostRuntime, launchDesktopHostProcess } from "../dist/index.js";
import { curatedNodeEnvironment } from "../dist/node-executable.js";

if (process.versions.electron !== undefined) {
  const data = await createTemporaryDataDir();
  let host;
  let fixtureChild;
  try {
    host = await launchDesktopHostProcess({ dataDir: data.path });
    const empty = await host.client.query({ operation: "session.list", input: { view: "roots", limit: 20 } });
    assert.equal(empty.resource, "sessions");
    assert.equal(empty.value.sessions.length, 0);
    const nodeExecutable = host.childProcess.spawnfile;
    assert.notEqual(nodeExecutable, process.execPath, "the Host must not inherit Electron as its Node runtime");
    fixtureChild = fork(fileURLToPath(import.meta.url), ["--fixture"], {
      execPath: nodeExecutable, execArgv: [], env: curatedNodeEnvironment(process.env),
      stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "json",
    });
    let stderr = "";
    fixtureChild.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const receipt = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Fixture regression timed out")), 25_000);
      let result;
      fixtureChild.on("message", (message) => { result = message; });
      fixtureChild.once("error", reject);
      fixtureChild.once("exit", (code) => {
        clearTimeout(timer);
        if (code !== 0 || result === undefined) reject(new Error(`Fixture child failed (${String(code)}): ${stderr}`));
        else resolve(result);
      });
    });
    await host.close();
    host = undefined;
    process.send?.({ electron: process.versions.electron, parent_executable: process.execPath, selected_node: nodeExecutable, ...receipt });
  } finally {
    if (fixtureChild?.exitCode === null) fixtureChild.kill("SIGKILL");
    if (host !== undefined) await host.close();
    await data.cleanup();
  }
} else {
  assert.ok(process.argv.includes("--fixture"));
  const data = await createTemporaryDataDir();
  const fixture = await createFailingTypescriptFixture(`electron-origin-${crypto.randomUUID()}`);
  const host = await createDesktopHostRuntime({
    dataDir: data.path, projects: [{ workspace: fixture.handle }],
    createRuntime: (options) => createAgentRuntime({ ...options, model: new DeterministicFakeModel(), sandboxMode: "workspace-write" }),
  });
  const toHost = new TransformStream();
  const fromHost = new TransformStream();
  const serving = host.serve({ readable: toHost.readable, writable: fromHost.writable });
  const client = new FramedRpcClient({ readable: fromHost.readable, writable: toHost.writable });
  try {
    const started = await client.command({ type: "start_run", command_id: "command:node-regression", input: {
      command_id: "command:node-regression", project_id: fixture.handle.project_id, task: "Fix the fixture arithmetic", mode: "execute",
    } });
    assert.equal(started.resource, "run");
    const deadline = Date.now() + 20_000;
    const approved = new Set();
    let projection;
    while (Date.now() < deadline) {
      const reply = await client.query({ operation: "run.get", run_id: started.value.run_id });
      assert.equal(reply.resource, "run");
      projection = reply.value;
      if (projection.status === "completed") break;
      assert.notEqual(projection.status, "failed", projection.outcome);
      const pending = projection.pending_approval;
      if (pending !== undefined && !approved.has(pending.approval_id)) {
        approved.add(pending.approval_id);
        await client.command({ type: "approve", command_id: `command:${pending.approval_id}`, run_id: projection.run_id,
          project_id: projection.project_id, approval_id: pending.approval_id, action_id: pending.action_id });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(projection.status, "completed");
    assert.match(await readFile(join(fixture.handle.real_root, "src/add.ts"), "utf8"), /return left \+ right;/);
    const test = projection.timeline.findLast((event) => event.type === "test.completed");
    assert.ok(test, "the builtin run_test must produce its business receipt");
    const artifact = projection.artifact_refs.find((ref) => ref.kind === "test_log");
    assert.ok(artifact);
    const log = await client.query({ operation: "artifact.get", run_id: projection.run_id, artifact_id: artifact.artifact_id });
    assert.equal(log.resource, "artifact");
    assert.equal(log.value.status, "available");
    assert.match(log.value.content, /2\/2 fixture assertions passed/);
    if (process.platform === "darwin") assert.equal(projection.sandbox_report.enforcement, "full");
    process.send?.({ status: projection.status, builtin_node: process.execPath, node_version: process.versions.node,
      sandbox_report: projection.sandbox_report, test_event: test, test_log: log.value.content });
  } finally {
    await client.close(); await serving; await host.close(); await fixture.cleanup(); await data.cleanup();
  }
}
