import { renameSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApprovalBoundGrantSchema,
  BoundPendingApprovalSchema,
  DISPOSABLE_FIXTURE_CAPABILITIES,
  RunRecoveryStateSchema,
  WorkspaceHandleSchema,
  type WorkspaceHandle,
} from "@tracegraph/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalTokenStore } from "./approval-token-store.js";
import { ActionWal } from "./action-wal.js";
import { JsonlEventLedger } from "./event-ledger.js";
import {
  CORE_BUILTIN_PERMISSION_PRESETS,
  createEffectivePermissionPolicy,
} from "./policy-engine.js";
import { createAgentRuntime, type AgentRuntime } from "./runtime.js";
import { JsonlSessionStore } from "./session-store.js";
import { createDefaultToolRegistry } from "./tool-registry.js";
import { removeControlledTemporaryDirectory } from "./workspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeControlledTemporaryDirectory));
});

describe("G06 Runtime permission integration", () => {
  it("durably applies the highest-priority deny before a lower-priority allow", async () => {
    const harness = await createHarness("priority");
    const permissionPolicy = createEffectivePermissionPolicy({
      preset: CORE_BUILTIN_PERMISSION_PRESETS["workspace-write"],
      rules: [{
        rule_id: "rule:allow-search",
        priority: 10,
        when: { tool: "search" },
        then: "allow",
        explanation: "Lower-priority search allowance",
      }, {
        rule_id: "rule:deny-search",
        priority: 100,
        when: { tool: "search" },
        then: "deny",
        explanation: "Higher-priority search denial",
      }],
    });
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      idFactory: harness.idFactory,
      now: harness.clock.now,
      permissionPolicy,
    });

    const started = await runtime.startRun(startInput(harness.workspace, "priority"));
    const failed = await waitForStatus(runtime, started.run_id, "failed");
    const events = await new JsonlEventLedger(join(harness.dataDir, "events")).list(started.run_id);
    const evaluated = events.find((event) => event.type === "policy.evaluated");
    const denied = events.find((event) => event.type === "policy.denied");

    expect(failed.failure_code).toBe("policy_denied");
    expect(evaluated?.data).toMatchObject({
      decision: {
        kind: "deny",
        matched_rule_id: "rule:deny-search",
        priority: 100,
        explanation: "Higher-priority search denial",
        policy_digest: permissionPolicy.policy_digest,
      },
    });
    expect(denied?.data).toMatchObject({
      code: "policy_denied",
      decision: { matched_rule_id: "rule:deny-search", kind: "deny" },
    });
    expect(events.some((event) => event.type === "tool.started")).toBe(false);
  });

  it("denies a read-only commit immediately after preview without approval or disk mutation", async () => {
    const harness = await createHarness("read-only");
    const permissionPolicy = createEffectivePermissionPolicy({
      preset: CORE_BUILTIN_PERMISSION_PRESETS["read-only"],
    });
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      idFactory: harness.idFactory,
      now: harness.clock.now,
      permissionPolicy,
    });

    const started = await runtime.startRun(startInput(harness.workspace, "read-only"));
    const failed = await waitForStatus(runtime, started.run_id, "failed");
    const events = await new JsonlEventLedger(join(harness.dataDir, "events")).list(started.run_id);
    const previewCompleted = events.find((event) => (
      event.type === "tool.completed"
      && (event.data.receipt as { tool_name?: string } | undefined)?.tool_name === "preview_patch"
    ));
    const commitDenial = events.find((event) => (
      event.type === "policy.denied"
      && (event.data.decision as { tool_name?: string } | undefined)?.tool_name === "commit_patch"
    ));

    expect(previewCompleted).toBeDefined();
    expect(commitDenial?.data).toMatchObject({
      decision: {
        kind: "deny",
        source: "hard-constraint",
        preset_key: "read-only",
      },
    });
    expect(failed.failure_code).toBe("sandbox_denied");
    expect(events.some((event) => event.type === "approval.requested")).toBe(false);
    expect(events.some((event) => (
      event.type === "tool.started" && event.data.tool_name === "commit_patch"
    ))).toBe(false);
    expect(events.some((event) => event.type === "patch.applied")).toBe(false);
    expect(await source(harness.workspace.real_root)).toContain("return left - right;");
  });

  it("lets the explicit full-write preset commit without manufacturing approval evidence", async () => {
    const harness = await createHarness("full-write");
    const permissionPolicy = createEffectivePermissionPolicy({
      preset: CORE_BUILTIN_PERMISSION_PRESETS["full-write"],
    });
    const tokenStore = new ApprovalTokenStore({ now: harness.clock.now });
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      idFactory: harness.idFactory,
      now: harness.clock.now,
      permissionPolicy,
      approvalTokenStore: tokenStore,
    });

    const started = await runtime.startRun(startInput(harness.workspace, "full-write"));
    const completed = await waitForStatus(runtime, started.run_id, "completed");
    const commitDecision = completed.timeline.find((event) => (
      event.type === "policy.evaluated"
      && (event.data.decision as { tool_name?: string } | undefined)?.tool_name === "commit_patch"
    ));

    expect(completed.permission).toMatchObject({
      preset_key: "full-write",
      sandbox_mode: "danger-full-access",
      approval_policy: "never",
    });
    expect(commitDecision?.data).toMatchObject({ decision: { kind: "allow" } });
    expect(completed.timeline.some((event) => event.type.startsWith("approval."))).toBe(false);
    expect(completed.timeline.filter((event) => event.type === "patch.applied")).toHaveLength(1);
    expect(tokenStore.stats()).toEqual({ issued: 0, consumed: 0 });
    expect(await source(harness.workspace.real_root)).toContain("return left + right;");
  });

  it.each([
    { label: "missing", answerer: undefined },
    { label: "throwing", answerer: async () => { throw new Error("answerer failed"); } },
    { label: "invalid", answerer: async () => "allow" as never },
  ])("fails closed with a durable denial when the $label approval answerer cannot answer", async ({
    label,
    answerer,
  }) => {
    const harness = await createHarness(`answerer-${label}`);
    const permissionPolicy = createEffectivePermissionPolicy({
      preset: CORE_BUILTIN_PERMISSION_PRESETS["workspace-write"],
      rules: [{
        rule_id: "rule:ask-search",
        priority: 100,
        when: { tool: "search" },
        then: "ask",
        explanation: "Search requires a trusted one-time answer",
      }],
    });
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      idFactory: harness.idFactory,
      now: harness.clock.now,
      permissionPolicy,
      ...(answerer === undefined ? {} : { approvalAnswerer: answerer }),
    });

    const started = await runtime.startRun(startInput(harness.workspace, `answerer-${label}`));
    const failed = await waitForStatus(runtime, started.run_id, "failed");
    const events = await new JsonlEventLedger(join(harness.dataDir, "events")).list(started.run_id);
    const requestedIndex = events.findIndex((event) => event.type === "approval.requested");
    const deniedIndex = events.findIndex((event) => event.type === "approval.denied");
    const failedIndex = events.findIndex((event) => event.type === "run.failed");
    const requested = events[requestedIndex];
    const denied = events[deniedIndex];

    expect(failed.failure_code).toBe("approval_unavailable");
    expect(requestedIndex).toBeGreaterThanOrEqual(0);
    expect(deniedIndex).toBeGreaterThan(requestedIndex);
    expect(failedIndex).toBeGreaterThan(deniedIndex);
    expect(denied?.data).toMatchObject({
      approval_id: requested?.data.approval_id,
      action_id: requested?.data.action_id,
      action_digest: requested?.data.action_digest,
      outcome: "unavailable",
      reason: "unavailable",
    });
    expect(events.some((event) => event.type === "tool.started")).toBe(false);
  });

  it("carries a non-Patch ask approval binding through the final execution gate", async () => {
    const harness = await createHarness("answerer-allowed");
    const tokenStore = new ApprovalTokenStore({ now: harness.clock.now });
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      idFactory: harness.idFactory,
      now: harness.clock.now,
      permissionPolicy: createEffectivePermissionPolicy({
        preset: CORE_BUILTIN_PERMISSION_PRESETS["full-write"],
        rules: [{
          rule_id: "rule:ask-search",
          priority: 100,
          when: { tool: "search" },
          then: "ask",
          explanation: "Search requires a trusted one-time answer",
        }],
      }),
      approvalAnswerer: async () => "allowed-once" as const,
      approvalTokenStore: tokenStore,
    });

    const started = await runtime.startRun(startInput(harness.workspace, "answerer-allowed"));
    const completed = await waitForStatus(runtime, started.run_id, "completed");
    const searchApprovals = completed.timeline.filter((event) => (
      (event.type === "approval.requested" || event.type === "approval.granted")
      && event.action_id === completed.timeline.find((candidate) => (
        candidate.type === "policy.evaluated"
        && (candidate.data.decision as { tool_name?: string } | undefined)?.tool_name === "search"
      ))?.action_id
    ));

    expect(searchApprovals.map(({ type }) => type)).toEqual([
      "approval.requested",
      "approval.granted",
    ]);
    expect(completed.timeline.some((event) => (
      event.type === "tool.started" && event.data.tool_name === "search"
    ))).toBe(true);
    expect(completed.timeline.filter((event) => event.type === "approval.requested")).toHaveLength(1);
    expect(tokenStore.stats()).toEqual({ issued: 1, consumed: 1 });
    expect(await source(harness.workspace.real_root)).toContain("return left + right;");
  });

  it("re-evaluates a non-Patch ask after approval and denies before tool start", async () => {
    const harness = await createHarness("answerer-final-deny");
    const workspace = WorkspaceHandleSchema.parse({
      ...harness.workspace,
      capabilities: { ...harness.workspace.capabilities, index: false },
    });
    const toolRegistry = createDefaultToolRegistry();
    const searchDefinition = toolRegistry.get("search")!;
    const tokenStore = new ApprovalTokenStore({ now: harness.clock.now });
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      idFactory: harness.idFactory,
      now: harness.clock.now,
      permissionPolicy: createEffectivePermissionPolicy({
        preset: CORE_BUILTIN_PERMISSION_PRESETS["workspace-write"],
        rules: [{
          rule_id: "rule:ask-search",
          priority: 100,
          when: { tool: "search" },
          then: "ask",
          explanation: "Search requires a trusted one-time answer",
        }],
      }),
      approvalAnswerer: async () => {
        Object.defineProperty(searchDefinition, "capability", {
          configurable: true,
          enumerable: true,
          value: "index",
        });
        return "allowed-once" as const;
      },
      approvalTokenStore: tokenStore,
      toolRegistry,
    });

    const started = await runtime.startRun(startInput(workspace, "answerer-final-deny"));
    const failed = await waitForStatus(runtime, started.run_id, "failed");
    const searchDecisions = failed.timeline.filter((event) => (
      event.type === "policy.evaluated"
      && (event.data.decision as { tool_name?: string } | undefined)?.tool_name === "search"
    ));

    expect(failed.failure_code).toBe("capability_denied");
    expect(searchDecisions.map((event) => (
      event.data.decision as { kind?: string }
    ).kind)).toEqual(["ask", "deny"]);
    expect(failed.timeline.some((event) => event.type === "policy.denied")).toBe(true);
    expect(failed.timeline.some((event) => event.type === "tool.started")).toBe(false);
    expect(tokenStore.stats()).toEqual({ issued: 1, consumed: 1 });
    expect(await new ActionWal(join(harness.dataDir, "wal")).list(started.run_id)).toEqual([]);
    expect(await source(workspace.real_root)).toContain("return left - right;");
  });

  it("binds manual approval to action, token, policy, and a single commit execution", async () => {
    const harness = await createHarness("manual-approval");
    const permissionPolicy = createEffectivePermissionPolicy({
      preset: CORE_BUILTIN_PERMISSION_PRESETS["workspace-write"],
    });
    const tokenStore = new ApprovalTokenStore({
      now: harness.clock.now,
      idFactory: () => "approval-token:manual",
    });
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      idFactory: harness.idFactory,
      now: harness.clock.now,
      permissionPolicy,
      approvalTokenStore: tokenStore,
    });
    const started = await runtime.startRun(startInput(harness.workspace, "manual-approval"));
    const waiting = await waitForStatus(runtime, started.run_id, "awaiting_approval");
    const pending = BoundPendingApprovalSchema.parse(waiting.pending_approval);
    const command = {
      type: "approve" as const,
      command_id: "command:approve:manual",
      project_id: waiting.project_id,
      run_id: waiting.run_id,
      approval_id: pending.approval_id,
      action_id: pending.action_id,
    };

    const completed = await runtime.approve(command);
    const replayed = await runtime.approve(command);
    const events = await new JsonlEventLedger(join(harness.dataDir, "events")).list(started.run_id);
    const grantedEvent = events.find((event) => event.type === "approval.granted");
    const grant = ApprovalBoundGrantSchema.parse(grantedEvent?.data.approval);
    const commitStarts = events.filter((event) => (
      event.type === "tool.started" && event.data.tool_name === "commit_patch"
    ));

    expect(completed.status).toBe("completed");
    expect(replayed.last_sequence).toBe(completed.last_sequence);
    expect(grant).toMatchObject({
      approval_id: pending.approval_id,
      action_id: pending.action_id,
      action_digest: pending.action_digest,
      policy_digest: permissionPolicy.policy_digest,
      token_id: expect.stringContaining("[REDACTED]"),
      outcome: "allowed-once",
      single_use: true,
    });
    expect(grant.consumed_at).toBeDefined();
    expect(tokenStore.stats()).toEqual({ issued: 1, consumed: 1 });
    expect(commitStarts).toHaveLength(1);
    expect(events.filter((event) => event.type === "patch.applied")).toHaveLength(1);
    expect(await source(harness.workspace.real_root)).toContain("return left + right;");
  });

  it("rejects a canonical-target digest mismatch before token issue, WAL, or mutation", async () => {
    const harness = await createHarness("digest-mismatch");
    const sourcePath = join(harness.workspace.real_root, "src", "add.ts");
    const firstTarget = join(harness.workspace.real_root, "src", "target-a.ts");
    const secondTarget = join(harness.workspace.real_root, "src", "target-b.ts");
    const tokenStore = new ApprovalTokenStore({ now: harness.clock.now });
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      idFactory: harness.idFactory,
      now: harness.clock.now,
      permissionPolicy: createEffectivePermissionPolicy({
        preset: CORE_BUILTIN_PERMISSION_PRESETS["workspace-write"],
      }),
      approvalTokenStore: tokenStore,
    });
    const started = await runtime.startRun(startInput(harness.workspace, "digest-mismatch"));
    const waiting = await waitForStatus(runtime, started.run_id, "awaiting_approval");
    const pending = BoundPendingApprovalSchema.parse(waiting.pending_approval);

    await rename(sourcePath, firstTarget);
    await writeFile(secondTarget, await readFile(firstTarget));
    await symlink("target-b.ts", sourcePath);
    const failed = await runtime.approve({
      type: "approve",
      command_id: "command:approve:digest-mismatch",
      project_id: waiting.project_id,
      run_id: waiting.run_id,
      approval_id: pending.approval_id,
      action_id: pending.action_id,
    });

    expect(failed.status).toBe("failed");
    expect(failed.failure_code).toBe("approval_digest_mismatch");
    expect(failed.timeline.find((event) => event.type === "approval.denied")?.data).toMatchObject({
      action_digest: pending.action_digest,
      outcome: "unavailable",
      reason: "digest_mismatch",
    });
    expect(tokenStore.stats()).toEqual({ issued: 0, consumed: 0 });
    expect(failed.timeline.filter((event) => (
      event.type === "tool.started" && event.data.tool_name === "commit_patch"
    ))).toEqual([]);
    expect(failed.timeline.some((event) => event.type === "patch.applied")).toBe(false);
    expect(await readFile(firstTarget, "utf8")).toContain("return left - right;");
    expect(await readFile(secondTarget, "utf8")).toContain("return left - right;");
  });

  it("rechecks the canonical target at the mutation boundary after approval is consumed", async () => {
    const harness = await createHarness("digest-race");
    const sourcePath = join(harness.workspace.real_root, "src", "add.ts");
    const firstTarget = join(harness.workspace.real_root, "src", "target-a.ts");
    const secondTarget = join(harness.workspace.real_root, "src", "target-b.ts");
    const original = await readFile(sourcePath);
    const tokenStore = new ApprovalTokenStore({ now: harness.clock.now });
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      idFactory: harness.idFactory,
      now: harness.clock.now,
      permissionPolicy: createEffectivePermissionPolicy({
        preset: CORE_BUILTIN_PERMISSION_PRESETS["workspace-write"],
      }),
      approvalTokenStore: tokenStore,
    });
    const started = await runtime.startRun(startInput(harness.workspace, "digest-race"));
    const waiting = await waitForStatus(runtime, started.run_id, "awaiting_approval");
    const pending = BoundPendingApprovalSchema.parse(waiting.pending_approval);
    let switched = false;
    const unsubscribe = runtime.subscribe(started.run_id, (event) => {
      if (event.type !== "approval.granted" || switched) return;
      switched = true;
      renameSync(sourcePath, firstTarget);
      writeFileSync(secondTarget, original);
      symlinkSync("target-b.ts", sourcePath);
    });
    const failed = await runtime.approve({
      type: "approve",
      command_id: "command:approve:digest-race",
      project_id: waiting.project_id,
      run_id: waiting.run_id,
      approval_id: pending.approval_id,
      action_id: pending.action_id,
    });
    unsubscribe();
    const commitFailure = failed.timeline.find((event) => (
      event.type === "tool.failed"
      && (event.data.receipt as { tool_name?: string } | undefined)?.tool_name === "commit_patch"
    ));
    expect(failed.status).toBe("failed");
    expect(failed.failure_code).toBe("action_digest_mismatch");
    expect(commitFailure?.data).toMatchObject({
      receipt: { code: "action_digest_mismatch", business_status: "failure" },
    });
    expect(tokenStore.stats()).toEqual({ issued: 1, consumed: 1 });
    expect(await new ActionWal(join(harness.dataDir, "wal")).list(started.run_id)).toEqual([]);
    expect(failed.timeline.some((event) => event.type === "patch.applied")).toBe(false);
    expect(await readFile(firstTarget, "utf8")).toContain("return left - right;");
    expect(await readFile(secondTarget, "utf8")).toContain("return left - right;");
  });

  it("enforces a final deny re-evaluation before tool start, WAL, or mutation", async () => {
    const harness = await createHarness("final-policy-deny");
    const workspace = WorkspaceHandleSchema.parse({
      ...harness.workspace,
      capabilities: { ...harness.workspace.capabilities, index: false },
    });
    const toolRegistry = createDefaultToolRegistry();
    const commitDefinition = toolRegistry.get("commit_patch")!;
    const tokenStore = new ApprovalTokenStore({ now: harness.clock.now });
    const runtime = await createAgentRuntime({
      dataDir: harness.dataDir,
      idFactory: harness.idFactory,
      now: harness.clock.now,
      permissionPolicy: createEffectivePermissionPolicy({
        preset: CORE_BUILTIN_PERMISSION_PRESETS["workspace-write"],
      }),
      approvalTokenStore: tokenStore,
      toolRegistry,
    });
    const started = await runtime.startRun(startInput(workspace, "final-policy-deny"));
    const waiting = await waitForStatus(runtime, started.run_id, "awaiting_approval");
    const pending = BoundPendingApprovalSchema.parse(waiting.pending_approval);
    const unsubscribe = runtime.subscribe(started.run_id, (event) => {
      if (event.type !== "approval.granted") return;
      Object.defineProperty(commitDefinition, "capability", {
        configurable: true,
        enumerable: true,
        value: "index",
      });
    });
    const failed = await runtime.approve({
      type: "approve",
      command_id: "command:approve:final-policy-deny",
      project_id: waiting.project_id,
      run_id: waiting.run_id,
      approval_id: pending.approval_id,
      action_id: pending.action_id,
    });
    unsubscribe();
    const commitDecisions = failed.timeline.filter((event) => (
      event.type === "policy.evaluated"
      && (event.data.decision as { tool_name?: string } | undefined)?.tool_name === "commit_patch"
    ));

    expect(failed.status).toBe("failed");
    expect(failed.failure_code).toBe("capability_denied");
    expect(commitDecisions.at(-1)?.data).toMatchObject({
      decision: { kind: "deny", source: "hard-constraint" },
    });
    expect(failed.timeline.some((event) => (
      event.type === "policy.denied"
      && (event.data.decision as { tool_name?: string } | undefined)?.tool_name === "commit_patch"
    ))).toBe(true);
    expect(failed.timeline.some((event) => (
      event.type === "tool.started" && event.data.tool_name === "commit_patch"
    ))).toBe(false);
    expect(tokenStore.stats()).toEqual({ issued: 1, consumed: 1 });
    expect(await new ActionWal(join(harness.dataDir, "wal")).list(started.run_id)).toEqual([]);
    expect(await source(workspace.real_root)).toContain("return left - right;");
  });

  it("persists the v5 recovery state and restores its effective policy", async () => {
    const harness = await createHarness("recovery-policy");
    const originalPolicy = createEffectivePermissionPolicy({
      preset: CORE_BUILTIN_PERMISSION_PRESETS["workspace-write"],
    });
    const firstStore = new JsonlSessionStore(harness.sessionsRoot, {
      now: harness.clock.now,
      pid: 2_147_483_646,
    });
    const firstRuntime = await createAgentRuntime({
      dataDir: harness.dataDir,
      sessionStore: firstStore,
      idFactory: harness.idFactory,
      now: harness.clock.now,
      permissionPolicy: originalPolicy,
    });
    const started = await firstRuntime.startRun(startInput(harness.workspace, "recovery-policy"));
    const waiting = await waitForStatus(firstRuntime, started.run_id, "awaiting_approval");
    await waitForSessionIndex(firstStore, waiting.session_id!, waiting.timeline.length);

    const ledger = new JsonlEventLedger(join(harness.dataDir, "events"));
    const beforeRestart = await ledger.list(waiting.run_id);
    const recoveryRef = beforeRestart[0]?.data._internal_recovery_artifact as {
      artifact_id?: string;
    } | undefined;
    const recovery = RunRecoveryStateSchema.parse(JSON.parse(await readFile(
      join(harness.dataDir, "artifacts", `${safeArtifactId(recoveryRef!.artifact_id!)}.data`),
      "utf8",
    )));
    expect(recovery).toMatchObject({
      version: 5,
      kind: "run_recovery_state",
      effective_policy: {
        preset: { key: "workspace-write" },
        policy_digest: originalPolicy.policy_digest,
      },
      orchestration: { depth: 0, limits: { max_parallel_subagents: 2, max_depth: 1 } },
    });

    harness.clock.value = new Date("2026-09-19T00:02:00.000Z");
    const restartedRuntime = await createAgentRuntime({
      dataDir: harness.dataDir,
      sessionStore: new JsonlSessionStore(harness.sessionsRoot, { now: harness.clock.now }),
      idFactory: harness.idFactory,
      now: harness.clock.now,
      permissionPolicy: createEffectivePermissionPolicy({
        preset: CORE_BUILTIN_PERMISSION_PRESETS["read-only"],
      }),
    });
    await restartedRuntime.markRunInterrupted(locator(waiting));
    const resumed = await restartedRuntime.resumeRun({
      ...locator(waiting),
      commandId: "command:resume:permission-policy",
      workspace: harness.workspace,
    });
    const renewed = BoundPendingApprovalSchema.parse(resumed.pending_approval);

    expect(resumed.permission).toMatchObject({
      preset_key: "workspace-write",
      policy_digest: originalPolicy.policy_digest,
    });
    expect(renewed.policy_digest).toBe(originalPolicy.policy_digest);
    expect(resumed.timeline.filter((event) => event.type === "permission.configured")).toHaveLength(1);
    const completed = await restartedRuntime.approve({
      type: "approve",
      command_id: "command:approve:recovered-policy",
      project_id: resumed.project_id,
      run_id: resumed.run_id,
      approval_id: renewed.approval_id,
      action_id: renewed.action_id,
    });
    expect(completed.status).toBe("completed");
    expect(await source(harness.workspace.real_root)).toContain("return left + right;");
  });
});

async function createHarness(name: string): Promise<{
  dataDir: string;
  sessionsRoot: string;
  workspace: WorkspaceHandle;
  idFactory: (prefix: string) => string;
  clock: { value: Date; now: () => Date };
}> {
  const root = await mkdtemp(join(tmpdir(), `tracegraph-g06-${name}-`));
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
  const clock = {
    value: new Date("2026-09-19T00:00:00.000Z"),
    now: (): Date => clock.value,
  };
  const dataDir = join(root, "data");
  return {
    dataDir,
    sessionsRoot: join(dataDir, "sessions"),
    workspace: WorkspaceHandleSchema.parse({
      handle_id: `workspace:g06:${name}`,
      project_id: `project:g06:${name}`,
      real_root: await realpath(workspaceRoot),
      workspace_kind: "disposable_fixture",
      capabilities: DISPOSABLE_FIXTURE_CAPABILITIES,
      created_at: clock.value.toISOString(),
    }),
    idFactory: (prefix) => `${prefix}:g06:${name}:${String(++sequence).padStart(6, "0")}`,
    clock,
  };
}

function startInput(workspace: WorkspaceHandle, name: string) {
  return {
    command_id: `command:start:g06:${name}`,
    project_id: workspace.project_id,
    task: "Fix the deterministic arithmetic defect under the configured permission policy.",
    mode: "execute" as const,
    workspace,
  };
}

async function source(root: string): Promise<string> {
  return readFile(join(root, "src", "add.ts"), "utf8");
}

async function waitForStatus(
  runtime: AgentRuntime,
  runId: string,
  status: "awaiting_approval" | "completed" | "failed",
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

async function waitForSessionIndex(
  store: JsonlSessionStore,
  sessionId: string,
  expectedEntries: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const stored = await store.readAll(sessionId);
      if (stored.entries.length === expectedEntries) return;
    } catch {
      // Event append becomes visible just before the Session index rename.
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${expectedEntries} Session index entries`);
}

function locator(projection: { session_id?: string | undefined; run_id: string; project_id: string }) {
  return {
    sessionId: projection.session_id!,
    runId: projection.run_id,
    projectId: projection.project_id,
  };
}

function safeArtifactId(artifactId: string): string {
  return artifactId.replace(/[^A-Za-z0-9_.-]/gu, "_");
}
