import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BoundPendingApprovalSchema,
  DISPOSABLE_FIXTURE_CAPABILITIES,
  GitBaseContextSchema,
  GraphDeltaSchema,
  GraphSnapshotSchema,
  WorkspaceHandleSchema,
  type GitBaseContext,
  type GraphNode,
  type WorkspaceHandle,
} from "@tracegraph/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "./crypto.js";
import {
  createAgentRuntime as createAgentRuntimeWithNativeSandbox,
  type AgentRuntime,
} from "./runtime.js";
import { createFixtureSandboxRunner } from "./sandbox/fixture-runner.js";
import type { CodeGraphProvider } from "./types.js";
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeControlledTemporaryDirectory));
});

describe("G20 CodeGraph approval fence", { timeout: 15_000 }, () => {
  it("invalidates an old patch approval on Git base drift and emits semantic code intel only after reapproval", async () => {
    const harness = await createHarness();
    const git = {
      current: gitContext("a".repeat(40), "sha256:1111111111111111111111111111111111111111111111111111111111111111"),
    };
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      idFactory: harness.idFactory,
      now: harness.clock.now,
      codeGraph: codeGraphProvider(harness.workspace, git),
    });

    const started = await runtime.startRun(startInput(harness.workspace));
    const waiting = await waitForStatus(runtime, started.run_id, "awaiting_approval");
    const original = BoundPendingApprovalSchema.parse(waiting.pending_approval);

    expect(waiting.code_intel).toMatchObject({
      git_context: { status: "available", base_commit: "a".repeat(40) },
      changed_files: [],
      changed_symbols: [],
    });
    expect(waiting.timeline.filter((event) => event.type === "code.intel_updated")).toHaveLength(1);

    // The target file is unchanged: this specifically exercises the Git-base
    // fence, rather than the existing patch base-hash validation.
    git.current = gitContext("b".repeat(40), "sha256:2222222222222222222222222222222222222222222222222222222222222222");
    const requeued = await runtime.approve(approveCommand(waiting, original, "command:approve:stale-base"));
    const renewed = BoundPendingApprovalSchema.parse(requeued.pending_approval);

    expect(requeued.status).toBe("awaiting_approval");
    expect(renewed.approval_id).not.toBe(original.approval_id);
    expect(requeued.timeline).toContainEqual(expect.objectContaining({
      type: "code.stale_base_detected",
      action_id: original.action_id,
      data: expect.objectContaining({
        stale_base: expect.objectContaining({
          expected: expect.objectContaining({ base_commit: "a".repeat(40) }),
          actual: expect.objectContaining({ base_commit: "b".repeat(40) }),
          reason: "base_commit_changed",
          requires_reapproval: true,
        }),
      }),
    }));
    expect(requeued.timeline).toContainEqual(expect.objectContaining({
      type: "approval.denied",
      action_id: original.action_id,
      data: expect.objectContaining({
        approval_id: original.approval_id,
        reason: "stale_base",
      }),
    }));
    expect(requeued.timeline.filter((event) => (
      event.type === "approval.granted"
      && (event.data.approval as { approval_id?: string } | undefined)?.approval_id === original.approval_id
    ))).toEqual([]);
    expect(requeued.timeline.filter((event) => (
      event.type === "tool.started" && event.data.tool_name === "commit_patch"
    ))).toEqual([]);
    expect(requeued.timeline.some((event) => event.type === "patch.applied")).toBe(false);
    expect(await source(harness.workspace.real_root)).toContain("return left - right;");

    // A later replay of the superseded id is rejected against the replacement
    // binding and cannot create a second mutation opportunity.
    await expect(runtime.approve(approveCommand(waiting, original, "command:approve:superseded")))
      .rejects.toMatchObject({ code: "approval_binding_mismatch" });
    expect(await source(harness.workspace.real_root)).toContain("return left - right;");

    const completed = await runtime.approve(approveCommand(requeued, renewed, "command:approve:renewed"));
    const patch = completed.timeline.find((event) => event.type === "patch.applied");
    const codeIntel = completed.timeline.find((event) => (
      event.type === "code.intel_updated" && event.patch_event_id === patch?.event_id
    ));

    expect(completed.status).toBe("completed");
    expect(await source(harness.workspace.real_root)).toContain("return left + right;");
    expect(patch).toBeDefined();
    expect(codeIntel?.data).toMatchObject({
      phase: "post_patch",
      git_context: { status: "available", base_commit: "b".repeat(40) },
      changed_files: ["src/add.ts"],
      changed_symbols: [{
        symbol_id: "symbol:src:add:add",
        name: "add",
        kind: "function",
        file_path: "src/add.ts",
        line: 1,
        end_line: 3,
        change: "changed",
      }],
    });
    expect(completed.code_intel).toMatchObject({
      result_snapshot_id: expect.any(String),
      changed_files: ["src/add.ts"],
      changed_symbols: [expect.objectContaining({ name: "add", change: "changed" })],
    });
  });

  it.each([
    {
      name: "the branch changes",
      current: gitContext(
        "a".repeat(40),
        fingerprint("1"),
        { branch: "release" },
      ),
      reason: "branch_changed",
    },
    {
      name: "the worktree fingerprint changes",
      current: gitContext(
        "a".repeat(40),
        fingerprint("2"),
      ),
      reason: "worktree_changed",
    },
    {
      name: "a previously available Git probe becomes unavailable",
      current: unavailableGitContext(),
      reason: "git_context_unavailable",
    },
  ] as const)("reissues approval when $name", async ({ current, reason }) => {
    const harness = await createHarness();
    const git = {
      current: gitContext(
        "a".repeat(40),
        fingerprint("1"),
      ),
    };
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      idFactory: harness.idFactory,
      now: harness.clock.now,
      codeGraph: codeGraphProvider(harness.workspace, git),
    });

    const started = await runtime.startRun(startInput(harness.workspace));
    const waiting = await waitForStatus(runtime, started.run_id, "awaiting_approval");
    const original = BoundPendingApprovalSchema.parse(waiting.pending_approval);

    git.current = current;
    const requeued = await runtime.approve(approveCommand(waiting, original, `command:approve:${reason}`));
    const replacement = BoundPendingApprovalSchema.parse(requeued.pending_approval);
    const stale = requeued.timeline.find((event) => event.type === "code.stale_base_detected");

    expect(requeued.status).toBe("awaiting_approval");
    expect(replacement.approval_id).not.toBe(original.approval_id);
    expect(stale?.action_id).toBe(original.action_id);
    expect(stale?.data).toMatchObject({
      stale_base: {
        expected: {
          status: "available",
          base_commit: "a".repeat(40),
          branch: "main",
        },
        actual: current,
        reason,
        requires_reapproval: true,
      },
    });
    expect(requeued.timeline).toContainEqual(expect.objectContaining({
      type: "approval.denied",
      action_id: original.action_id,
      data: expect.objectContaining({
        approval_id: original.approval_id,
        reason: "stale_base",
      }),
    }));
    expect(requeued.timeline).toContainEqual(expect.objectContaining({
      type: "approval.requested",
      action_id: replacement.action_id,
      data: expect.objectContaining({ approval_id: replacement.approval_id }),
    }));
    expect(requeued.timeline.some((event) => event.type === "approval.granted")).toBe(false);
    expect(requeued.timeline.some((event) => (
      event.type === "tool.started" && event.data.tool_name === "commit_patch"
    ))).toBe(false);
    expect(requeued.timeline.some((event) => event.type === "patch.applied")).toBe(false);
    expect(await source(harness.workspace.real_root)).toContain("return left - right;");
  });
});

async function createHarness(): Promise<{
  dataDir: string;
  workspace: WorkspaceHandle;
  idFactory: (prefix: string) => string;
  clock: { now: () => Date };
}> {
  const root = await mkdtemp(join(tmpdir(), "tracegraph-g20-runtime-"));
  roots.push(root);
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
  let sequence = 0;
  const now = new Date("2026-09-21T00:00:00.000Z");
  return {
    dataDir: join(root, "data"),
    workspace: WorkspaceHandleSchema.parse({
      handle_id: "workspace:g20:runtime",
      project_id: "project:g20:runtime",
      real_root: await realpath(workspaceRoot),
      workspace_kind: "disposable_fixture",
      capabilities: DISPOSABLE_FIXTURE_CAPABILITIES,
      created_at: now.toISOString(),
    }),
    idFactory: (prefix) => `${prefix}:g20:${String(++sequence).padStart(6, "0")}`,
    clock: { now: () => now },
  };
}

function codeGraphProvider(
  workspace: WorkspaceHandle,
  git: { current: GitBaseContext },
): CodeGraphProvider {
  let snapshotSequence = 0;
  return {
    async captureGitContext() {
      return git.current;
    },
    async createSnapshot({ projectId }) {
      const sourceText = await source(workspace.real_root);
      const ordinal = ++snapshotSequence;
      return GraphSnapshotSchema.parse({
        snapshot_id: `graph:snapshot:${ordinal}`,
        project_id: projectId,
        workspace_hash: sha256(workspace.real_root),
        created_at: "2026-09-21T00:00:00.000Z",
        nodes: graphNodes(sourceText),
        edges: [{
          id: "edge:contains:add",
          kind: "contains",
          source_node_id: "file:src:add.ts",
          target_node_id: "symbol:src:add:add",
          file_path: "src/add.ts",
          confidence: "high",
          resolution: "resolved",
        }],
        diagnostics: [],
      });
    },
    async createDelta({ base, result, patchEventId }) {
      const before = base.nodes.find((node) => node.id === "symbol:src:add:add")!;
      const after = result.nodes.find((node) => node.id === "symbol:src:add:add")!;
      return GraphDeltaSchema.parse({
        graph_delta_id: "graph_delta:g20:add",
        project_id: workspace.project_id,
        base_snapshot_id: base.snapshot_id,
        result_snapshot_id: result.snapshot_id,
        patch_event_id: patchEventId,
        created_at: "2026-09-21T00:00:00.000Z",
        node_changes: [{ change: "changed", before, after }],
        edge_changes: [],
      });
    },
  };
}

function graphNodes(sourceText: string): GraphNode[] {
  return [{
    id: "file:src:add.ts",
    kind: "file",
    label: "src/add.ts",
    file_path: "src/add.ts",
    content_hash: sha256(sourceText),
  }, {
    id: "symbol:src:add:add",
    kind: "symbol",
    label: "add",
    file_path: "src/add.ts",
    line: 1,
    end_line: 3,
    symbol_name: "add",
    declaration_kind: "function",
    content_hash: sha256(sourceText),
  }];
}

function gitContext(
  baseCommit: string,
  fingerprint: string,
  options: { branch?: string } = {},
): GitBaseContext {
  return GitBaseContextSchema.parse({
    status: "available",
    base_commit: baseCommit,
    branch: options.branch ?? "main",
    dirty: false,
    worktree_fingerprint: fingerprint,
    captured_at: "2026-09-21T00:00:00.000Z",
  });
}

function unavailableGitContext(): GitBaseContext {
  return GitBaseContextSchema.parse({
    status: "unavailable",
    captured_at: "2026-09-21T00:00:01.000Z",
    reason: "git_probe_failed",
  });
}

function fingerprint(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function startInput(workspace: WorkspaceHandle) {
  return {
    command_id: "command:start:g20:runtime",
    project_id: workspace.project_id,
    task: "Fix the deterministic arithmetic defect and validate the semantic CodeGraph result.",
    mode: "execute" as const,
    workspace,
  };
}

function approveCommand(
  projection: { project_id: string; run_id: string },
  pending: { approval_id: string; action_id: string },
  commandId: string,
) {
  return {
    type: "approve" as const,
    command_id: commandId,
    project_id: projection.project_id,
    run_id: projection.run_id,
    approval_id: pending.approval_id,
    action_id: pending.action_id,
  };
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
  const projection = await runtime.getProjection(runId);
  throw new Error(`Timed out waiting for ${status}; current status is ${projection.status}`);
}
