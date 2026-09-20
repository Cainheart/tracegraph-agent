import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSandboxRunner } from "./sandbox/runner.js";
import { createDefaultToolRegistry, executeToolDefinition, runProcess } from "./tool-registry.js";
import type { ToolDefinition } from "./types.js";
import { createManagedWorkspaceHandle, removeControlledTemporaryDirectory } from "./workspace.js";

describe("bounded child process execution", () => {
  it("escalates from SIGTERM to SIGKILL when a timed-out child refuses to exit", async () => {
    const startedAt = Date.now();
    const result = await runProcess(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      { cwd: tmpdir(), timeoutMs: 40, maxOutputBytes: 1_024 },
    );

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("caps output and terminates a child that ignores SIGTERM", async () => {
    const result = await runProcess(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => process.stdout.write('x'.repeat(1024)), 1);",
      ],
      { cwd: tmpdir(), timeoutMs: 5_000, maxOutputBytes: 2_048 },
    );

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(2_048);
    expect(result.exitCode).toBeNull();
  });

  it("escalates an AbortSignal and reports the stop reason", async () => {
    const controller = new AbortController();
    const running = runProcess(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      { cwd: tmpdir(), timeoutMs: 5_000, maxOutputBytes: 1_024, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 40);

    await expect(running).resolves.toMatchObject({ aborted: true, exitCode: null });
  });

  it.skipIf(process.platform === "win32")("terminates the spawned process group, including grandchildren", async () => {
    const script = [
      "const { spawn } = require('node:child_process');",
      "process.on('SIGTERM', () => {});",
      "const grandchild = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' });",
      "console.log(grandchild.pid);",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const result = await runProcess(process.execPath, ["-e", script], {
      cwd: tmpdir(),
      timeoutMs: 80,
      maxOutputBytes: 1_024,
    });
    const grandchildPid = Number.parseInt(result.stdout.trim(), 10);

    expect(result.timedOut).toBe(true);
    expect(Number.isInteger(grandchildPid)).toBe(true);
    await expectProcessToExit(grandchildPid);
  });

  it.skipIf(process.platform === "win32")("still kills descendants after the process-group leader exits on SIGTERM", async () => {
    const script = [
      "const { spawn } = require('node:child_process');",
      "const grandchild = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' });",
      "console.log(grandchild.pid);",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const result = await runProcess(process.execPath, ["-e", script], {
      cwd: tmpdir(),
      timeoutMs: 80,
      maxOutputBytes: 1_024,
    });
    const grandchildPid = Number.parseInt(result.stdout.trim(), 10);

    expect(result.timedOut).toBe(true);
    expect(Number.isInteger(grandchildPid)).toBe(true);
    await expectProcessToExit(grandchildPid);
  });

  it.skipIf(process.platform === "win32")("reuses process-group cleanup when the Tool execution boundary times out", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracegraph-tool-timeout-process-"));
    try {
      await mkdir(join(root, "test"));
      await writeFile(join(root, "test", "run.mjs"), [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        "const grandchild = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' });",
        "writeFileSync('grandchild.pid', String(grandchild.pid));",
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
      ].join("\n"));
      const workspace = await createManagedWorkspaceHandle({ projectId: "project:tool-process-timeout", root });
      const base = createDefaultToolRegistry().get("run_test");
      if (!base) throw new Error("run_test tool is missing");
      const definition = { ...base, timeoutMs: 100 } as ToolDefinition;

      await expect(executeToolDefinition(definition, { suite: "fixture" }, {
        projectId: workspace.project_id,
        runId: "run:tool-process-timeout",
        workspace,
        sandboxMode: "danger-full-access",
        sandboxRunner: createSandboxRunner(),
      })).resolves.toMatchObject({ status: "failure", code: "timeout" });

      const grandchildPid = Number.parseInt(await readFile(join(root, "grandchild.pid"), "utf8"), 10);
      expect(Number.isInteger(grandchildPid)).toBe(true);
      await expectProcessToExit(grandchildPid);
    } finally {
      await removeControlledTemporaryDirectory(root);
    }
  });
});

async function expectProcessToExit(pid: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`grandchild process ${pid} survived process-group termination`);
}
