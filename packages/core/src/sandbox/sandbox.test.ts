import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultToolRegistry, executeToolDefinition } from "../tool-registry.js";
import { createManagedWorkspaceHandle } from "../workspace.js";
import { NativeSandboxRunner } from "./runner.js";
import {
  generateSeatbeltProfile,
  SEATBELT_WORKSPACE_PARAMETER,
  seatbeltArguments,
} from "./seatbelt.js";

describe("Seatbelt profile generation", () => {
  it("generates stable read-only, workspace-write, and danger profiles", () => {
    expect(generateSeatbeltProfile("read-only")).toMatchInlineSnapshot(`
      "(version 1)
      (import \"system.sb\")
      (deny default)
      (deny network*)
      (allow process*)
      (allow file-read-metadata file-test-existence)
      (allow file-read* file-test-existence file-map-executable
        (literal (param \"TRACEGRAPH_WORKSPACE\"))
        (subpath (param \"TRACEGRAPH_WORKSPACE\"))
        (subpath \"/System\")
        (subpath \"/usr\")
        (subpath \"/bin\")
        (subpath \"/sbin\")
        (subpath \"/Library/Apple\")
        (subpath \"/opt/homebrew\")
        (subpath \"/usr/local\")
        (subpath \"/Applications/Xcode.app\"))
      (deny file-write*)
      "
    `);
    expect(generateSeatbeltProfile("workspace-write")).toMatchInlineSnapshot(`
      "(version 1)
      (import \"system.sb\")
      (deny default)
      (deny network*)
      (allow process*)
      (allow file-read-metadata file-test-existence)
      (allow file-read* file-test-existence file-map-executable
        (literal (param \"TRACEGRAPH_WORKSPACE\"))
        (subpath (param \"TRACEGRAPH_WORKSPACE\"))
        (subpath \"/System\")
        (subpath \"/usr\")
        (subpath \"/bin\")
        (subpath \"/sbin\")
        (subpath \"/Library/Apple\")
        (subpath \"/opt/homebrew\")
        (subpath \"/usr/local\")
        (subpath \"/Applications/Xcode.app\"))
      (allow file-write*
        (literal (param \"TRACEGRAPH_WORKSPACE\"))
        (subpath (param \"TRACEGRAPH_WORKSPACE\")))
      "
    `);
    expect(generateSeatbeltProfile("danger-full-access")).toMatchInlineSnapshot(`
      "(version 1)
      (allow default)
      "
    `);
  });

  it("keeps a hostile workspace name out of profile source", () => {
    const hostile = '/tmp/workspace\") (allow network*) ("';
    const profile = generateSeatbeltProfile("workspace-write");
    const args = seatbeltArguments({
      profile,
      workspaceRoot: hostile,
      executable: "/usr/bin/true",
      args: [],
    });

    expect(profile).not.toContain(hostile);
    expect(args).toContain(`${SEATBELT_WORKSPACE_PARAMETER}=${hostile}`);
    expect(args).toContain("-p");
  });

  it("rejects control characters instead of passing ambiguous SBPL parameters", () => {
    expect(() => seatbeltArguments({
      profile: generateSeatbeltProfile("read-only"),
      workspaceRoot: "/tmp/unsafe\nworkspace",
      executable: "/usr/bin/true",
      args: [],
    })).toThrow(/control character/u);
  });
});

describe("native SandboxRunner", () => {
  it("reports missing enforcement honestly and refuses to start a restricted child", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracegraph-sandbox-missing-"));
    const marker = join(root, "must-not-exist");
    const runner = new NativeSandboxRunner({
      platform: "darwin",
      seatbeltExecutable: "/tracegraph/missing/sandbox-exec",
    });

    const report = await runner.probe({ mode: "workspace-write", workspaceRoot: root });
    expect(report).toMatchObject({
      report_version: 1,
      mode: "workspace-write",
      enforcement: "none",
      platform: "darwin",
      mechanisms: [],
    });
    expect(report.unmet_constraints).toContain("seatbelt_backend_unavailable");

    const result = await runner.run({
      mode: "workspace-write",
      workspaceRoot: root,
      cwd: root,
      executable: process.execPath,
      args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'started')", marker],
      timeoutMs: 2_000,
      maxOutputBytes: 4_096,
    });
    expect(result).toMatchObject({
      started: false,
      failureCode: "sandbox_unavailable",
      exitCode: null,
    });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("makes run_test fail closed with the exact unavailable report", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracegraph-sandbox-tool-"));
    await mkdir(join(root, "test"));
    await writeFile(join(root, "test", "run.mjs"), "throw new Error('must not execute');\n");
    const workspace = await createManagedWorkspaceHandle({
      projectId: "project:sandbox-tool",
      root,
    });
    const runner = new NativeSandboxRunner({
      platform: "darwin",
      seatbeltExecutable: "/tracegraph/missing/sandbox-exec",
    });
    const definition = createDefaultToolRegistry().get("run_test");
    if (definition === undefined) throw new Error("run_test tool is missing");

    const result = await executeToolDefinition(definition, { suite: "fixture" }, {
      projectId: workspace.project_id,
      runId: "run:sandbox-tool",
      workspace,
      sandboxMode: "workspace-write",
      sandboxRunner: runner,
    });

    expect(result).toMatchObject({
      status: "failure",
      code: "sandbox_unavailable",
      facts: {
        exit_code: null,
        started: false,
        sandbox_report: {
          report_version: 1,
          mode: "workspace-write",
          enforcement: "none",
          platform: "darwin",
          mechanisms: [],
        },
      },
    });
    expect(result.facts?.sandbox_report).toMatchObject({
      unmet_constraints: expect.arrayContaining(["seatbelt_backend_unavailable"]),
    });
  });

  it("runs the built-in Node fixture through active Seatbelt", async () => {
    const setup = await activeDarwinSandbox("workspace-write");
    if (setup === undefined) return;
    await mkdir(join(setup.root, "test"));
    await writeFile(join(setup.root, "test", "run.mjs"), [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync('fixture-ran.txt', 'sandboxed');",
      "console.log('fixture passed');",
    ].join("\n"));
    const workspace = await createManagedWorkspaceHandle({
      projectId: "project:sandbox-node-tool",
      root: setup.root,
    });
    const definition = createDefaultToolRegistry().get("run_test");
    if (definition === undefined) throw new Error("run_test tool is missing");

    const result = await executeToolDefinition(definition, { suite: "fixture" }, {
      projectId: workspace.project_id,
      runId: "run:sandbox-node-tool",
      workspace,
      sandboxMode: "workspace-write",
      sandboxRunner: setup.runner,
    });

    expect(result).toMatchObject({
      status: "success",
      code: "tests_passed",
      facts: { sandbox_report: { enforcement: "full", mode: "workspace-write" } },
    });
    await expect(readFile(join(setup.root, "fixture-ran.txt"), "utf8")).resolves.toBe("sandboxed");
  });

  it("executes danger-full-access directly while reporting enforcement none", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracegraph-sandbox-danger-"));
    const marker = join(root, "danger-marker");
    const runner = new NativeSandboxRunner({
      platform: "darwin",
      seatbeltExecutable: "/tracegraph/missing/sandbox-exec",
    });
    const result = await runner.run({
      mode: "danger-full-access",
      workspaceRoot: root,
      cwd: root,
      executable: process.execPath,
      args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'danger')", marker],
      timeoutMs: 2_000,
      maxOutputBytes: 4_096,
    });

    expect(result).toMatchObject({
      started: true,
      exitCode: 0,
      sandboxReport: {
        mode: "danger-full-access",
        enforcement: "none",
        mechanisms: [],
        unmet_constraints: [],
      },
    });
    await expect(access(marker)).resolves.toBeUndefined();
  });

  it("reports Linux and Windows gaps without pretending a backend is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracegraph-sandbox-platforms-"));
    for (const platform of ["linux", "win32"] as const) {
      const report = await new NativeSandboxRunner({ platform }).probe({
        mode: "read-only",
        workspaceRoot: root,
      });
      expect(report).toMatchObject({
        mode: "read-only",
        enforcement: "none",
        platform,
        mechanisms: [],
      });
      expect(report.unmet_constraints).toEqual(expect.arrayContaining([
        "filesystem_scope_unenforced",
        "network_denial_unenforced",
      ]));
    }
  });

  it("rejects read-only writes with an OS error when Seatbelt is active", async () => {
    const setup = await activeDarwinSandbox("read-only");
    if (setup === undefined) return;
    const target = join(setup.root, "denied.txt");

    const result = await setup.runner.run({
      mode: "read-only",
      workspaceRoot: setup.root,
      cwd: setup.root,
      executable: "/usr/bin/touch",
      args: [target],
      timeoutMs: 2_000,
      maxOutputBytes: 4_096,
    });

    expect(result.started).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Operation not permitted|permission denied/iu);
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows workspace writes and denies network when Seatbelt is active", async () => {
    const setup = await activeDarwinSandbox("workspace-write");
    if (setup === undefined) return;
    const target = join(setup.root, "allowed.txt");
    const writeResult = await setup.runner.run({
      mode: "workspace-write",
      workspaceRoot: setup.root,
      cwd: setup.root,
      executable: "/usr/bin/touch",
      args: [target],
      timeoutMs: 2_000,
      maxOutputBytes: 4_096,
    });
    expect(writeResult).toMatchObject({ started: true, exitCode: 0 });
    await expect(access(target)).resolves.toBeUndefined();

    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.end("unexpected");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test server port");
      const networkResult = await setup.runner.run({
        mode: "workspace-write",
        workspaceRoot: setup.root,
        cwd: setup.root,
        executable: "/usr/bin/curl",
        args: ["--max-time", "1", `http://127.0.0.1:${address.port}/`],
        timeoutMs: 2_000,
        maxOutputBytes: 8_192,
      });
      expect(networkResult.started).toBe(true);
      expect(networkResult.exitCode).not.toBe(0);
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error) reject(error);
        else resolve();
      }));
    }
  });

  it("blocks a workspace symlink that targets an outside directory", async () => {
    const setup = await activeDarwinSandbox("workspace-write");
    if (setup === undefined) return;
    const outside = await mkdtemp(join(tmpdir(), "tracegraph-sandbox-outside-"));
    await symlink(await realpath(outside), join(setup.root, "escape"));
    const escapedTarget = join(outside, "escaped.txt");

    const result = await setup.runner.run({
      mode: "workspace-write",
      workspaceRoot: setup.root,
      cwd: setup.root,
      executable: "/usr/bin/touch",
      args: [join(setup.root, "escape", "escaped.txt")],
      timeoutMs: 2_000,
      maxOutputBytes: 4_096,
    });

    expect(result.exitCode).not.toBe(0);
    await expect(access(escapedTarget)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats quotes and SBPL punctuation in a workspace path as data", async () => {
    if (process.platform !== "darwin") return;
    const parent = await mkdtemp(join(tmpdir(), "tracegraph-sandbox-path-"));
    const root = join(parent, 'workspace\") (allow network*) ("');
    await mkdir(root);
    const runner = new NativeSandboxRunner();
    const report = await runner.probe({ mode: "workspace-write", workspaceRoot: root });
    if (report.enforcement !== "full") return;
    const target = join(root, "allowed.txt");

    const result = await runner.run({
      mode: "workspace-write",
      workspaceRoot: root,
      cwd: root,
      executable: "/usr/bin/touch",
      args: [target],
      timeoutMs: 2_000,
      maxOutputBytes: 4_096,
    });
    expect(result.exitCode).toBe(0);
    await expect(access(target)).resolves.toBeUndefined();
  });

  it("rejects a cwd symlink that resolves outside the workspace before spawn", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracegraph-sandbox-root-"));
    const outside = await mkdtemp(join(tmpdir(), "tracegraph-sandbox-cwd-outside-"));
    await symlink(outside, join(root, "escaped-cwd"), process.platform === "win32" ? "junction" : "dir");
    const runner = new NativeSandboxRunner();

    await expect(runner.run({
      mode: "danger-full-access",
      workspaceRoot: root,
      cwd: join(root, "escaped-cwd"),
      executable: "/usr/bin/true",
      args: [],
      timeoutMs: 2_000,
      maxOutputBytes: 4_096,
    })).rejects.toThrow(/cwd escapes/u);
  });
});

async function activeDarwinSandbox(
  mode: "read-only" | "workspace-write",
): Promise<{ root: string; runner: NativeSandboxRunner } | undefined> {
  const root = await mkdtemp(join(tmpdir(), `tracegraph-sandbox-${mode}-`));
  const runner = new NativeSandboxRunner();
  const report = await runner.probe({ mode, workspaceRoot: root });
  if (process.platform !== "darwin" || report.enforcement !== "full") {
    expect(report.enforcement).toBe("none");
    expect(report.unmet_constraints.length).toBeGreaterThan(0);
    return undefined;
  }
  expect(report.unmet_constraints).toEqual([]);
  return { root, runner };
}
