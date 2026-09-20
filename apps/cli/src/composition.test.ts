import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { removeControlledTemporaryDirectory } from "@tracegraph/core";
import { describe, expect, it } from "vitest";
import { closeHostAndFlushTelemetry, createCodeGraphProvider } from "./composition.js";

const execFileAsync = promisify(execFile);

describe("CLI composition", () => {
  it("waits for telemetry flush after Host close, including close failures", async () => {
    const order: string[] = [];
    await closeHostAndFlushTelemetry(
      async () => { order.push("host.closed"); },
      async () => { await Promise.resolve(); order.push("telemetry.flushed"); },
    );
    expect(order).toEqual(["host.closed", "telemetry.flushed"]);

    const failedOrder: string[] = [];
    await expect(closeHostAndFlushTelemetry(
      async () => { failedOrder.push("host.failed"); throw new Error("close failed"); },
      async () => { await Promise.resolve(); failedOrder.push("telemetry.flushed"); },
    )).rejects.toThrow("close failed");
    expect(failedOrder).toEqual(["host.failed", "telemetry.flushed"]);
  });

  it("bounds a telemetry flush that never settles during shutdown", async () => {
    const never = new Promise<void>(() => undefined);
    await expect(closeHostAndFlushTelemetry(
      async () => undefined,
      () => never,
      1,
    )).resolves.toBeUndefined();
  });

  it("adapts CodeGraph to the Core provider seam", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracegraph-cli-graph-"));
    try {
      await writeFile(join(root, "a.ts"), 'import { b } from "./b.js";\nexport const a = b;\n');
      await writeFile(join(root, "b.ts"), "export const b = 1;\n");
      const provider = createCodeGraphProvider();
      const before = await provider.createSnapshot({
        projectId: "project-test",
        workspaceRoot: root,
      });
      await writeFile(join(root, "c.ts"), "export const c = 2;\n");
      const after = await provider.createSnapshot({
        projectId: "project-test",
        workspaceRoot: root,
      });
      const delta = await provider.createDelta({ base: before, result: after });
      const gitContext = await provider.captureGitContext({ workspaceRoot: root });
      expect(before.nodes.length).toBeGreaterThan(0);
      expect(delta.node_changes.some((change) => change.change === "added")).toBe(true);
      expect(gitContext).toMatchObject({ status: "unavailable", reason: "not_git_repository" });
    } finally {
      await removeControlledTemporaryDirectory(root);
    }
  });

  it("propagates cancellation through the CodeGraph provider seam", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracegraph-cli-graph-abort-"));
    try {
      await writeFile(join(root, "a.ts"), "export const a = 1;\n");
      const provider = createCodeGraphProvider();
      const controller = new AbortController();
      controller.abort(new Error("stop requested"));

      await expect(provider.createSnapshot({
        projectId: "project-test",
        workspaceRoot: root,
        signal: controller.signal,
      })).rejects.toMatchObject({ code: "analysis_aborted" });
      await expect(provider.captureGitContext({
        workspaceRoot: root,
        signal: controller.signal,
      })).rejects.toThrow("stop requested");
    } finally {
      await removeControlledTemporaryDirectory(root);
    }
  });

  it("includes an untracked source file in the bounded Git worktree fingerprint", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracegraph-cli-git-context-"));
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "tracegraph-test@example.invalid"]);
      await git(root, ["config", "user.name", "TraceGraph test"]);
      await writeFile(join(root, "tracked.ts"), "export const tracked = true;\n");
      await git(root, ["add", "tracked.ts"]);
      await git(root, ["commit", "-qm", "initial"]);

      const provider = createCodeGraphProvider();
      const clean = await requiredGitContext(provider, root);
      await writeFile(join(root, "untracked.ts"), "export const untracked = true;\n");
      const dirty = await requiredGitContext(provider, root);

      expect(clean).toMatchObject({ status: "available", dirty: false });
      expect(dirty).toMatchObject({ status: "available", dirty: true });
      expect(dirty.worktree_fingerprint).not.toBe(clean.worktree_fingerprint);
      expect(JSON.stringify(dirty)).not.toContain(root);
      expect(JSON.stringify(dirty)).not.toContain("untracked.ts");
    } finally {
      await removeControlledTemporaryDirectory(root);
    }
  });

  it("does not execute a repository-configured fsmonitor command while probing Git state", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracegraph-cli-git-fsmonitor-"));
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "tracegraph-test@example.invalid"]);
      await git(root, ["config", "user.name", "TraceGraph test"]);
      await writeFile(join(root, "tracked.ts"), "export const tracked = true;\n");
      await git(root, ["add", "tracked.ts"]);
      await git(root, ["commit", "-qm", "initial"]);
      const marker = join(root, "fsmonitor-ran");
      const monitor = join(root, "hostile-fsmonitor.sh");
      await writeFile(monitor, `#!/bin/sh\ntouch "${marker}"\nprintf '\\0'\n`);
      await chmod(monitor, 0o755);
      await git(root, ["config", "core.fsmonitor", monitor]);

      const context = await requiredGitContext(createCodeGraphProvider(), root);

      expect(context).toMatchObject({ status: "available" });
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await removeControlledTemporaryDirectory(root);
    }
  });
});

async function git(root: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  });
}

async function requiredGitContext(
  provider: ReturnType<typeof createCodeGraphProvider>,
  root: string,
) {
  if (provider.captureGitContext === undefined) throw new Error("Expected Git context provider");
  return provider.captureGitContext({ workspaceRoot: root });
}
