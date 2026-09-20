import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SandboxMode, SandboxReport, WorkspaceHandle } from "@tracegraph/contracts";
import {
  createAgentRuntime,
  type AgentRuntime,
  type ModelAdapter,
  type SandboxExecutionResult,
  type SandboxRunRequest,
  type SandboxRunner,
} from "@tracegraph/core";
import { createFailingTypescriptFixture, createTemporaryDataDir } from "./index.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("G13 sandbox runtime integration", () => {
  it("keeps Host-owned model calls outside an unavailable child-process sandbox", async () => {
    const { fixture, data } = await setup();
    const sandboxReport = unavailableReport("workspace-write");
    const runner = new RecordingSandboxRunner(sandboxReport, () => {
      throw new Error("the model path must not invoke the child SandboxRunner");
    });
    let hostRequests = 0;
    const server = createServer((_request, response) => {
      hostRequests += 1;
      response.end("host-network-ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error);
      else resolve();
    })));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing Host test port");
    let modelCalls = 0;
    const model: ModelAdapter = {
      name: "host-network-model",
      async decide() {
        modelCalls += 1;
        const response = await fetch(`http://127.0.0.1:${address.port}/model`);
        if (await response.text() !== "host-network-ok") throw new Error("Host model endpoint failed");
        return {
          decision_id: "decision:host-network-finish",
          kind: "finish",
          public_reason: "The Host model path remains available.",
          evidence_refs: [],
          risk: "none",
          final_answer: "Host-side model request completed.",
        };
      },
    };
    const runtime = await createAgentRuntime({
      dataDir: data.path,
      model,
      sandboxMode: "workspace-write",
      sandboxRunner: runner,
    });

    const result = await runToTerminal(runtime, fixture.handle, "Inspect without a child process");

    expect(result.status).toBe("completed");
    expect(modelCalls).toBe(1);
    expect(hostRequests).toBe(1);
    expect(runner.runRequests).toHaveLength(0);
    expect(result.sandbox_report).toEqual(sandboxReport);
    expect(result.timeline.map(({ type }) => type)).toEqual(expect.arrayContaining([
      "sandbox.configured",
      "sandbox.disabled",
      "model.request_started",
      "run.completed",
    ]));
    expect(result.timeline.find(({ type }) => type === "sandbox.disabled")?.data).toMatchObject({
      reason: "enforcement_unavailable",
      sandbox_report: sandboxReport,
    });
  });

  it("fails run_test closed and persists the exact report in Tool, Receipt, Observation, and Projection", async () => {
    const { fixture, data } = await setup();
    const sandboxReport = unavailableReport("workspace-write");
    const runner = new RecordingSandboxRunner(sandboxReport, () => unavailableExecution(sandboxReport));
    const runtime = await createAgentRuntime({
      dataDir: data.path,
      model: runTestModel(),
      sandboxMode: "workspace-write",
      sandboxRunner: runner,
    });

    const result = await runToTerminal(runtime, fixture.handle, "Run tests inside the configured sandbox");
    const failed = result.timeline.find(({ type }) => type === "tool.failed");

    expect(result.status).toBe("failed");
    expect(result.failure_code).toBe("sandbox_unavailable");
    expect(runner.runRequests).toHaveLength(1);
    expect(failed?.data).toMatchObject({
      code: "denied",
      business_code: "sandbox_unavailable",
      sandbox_report: sandboxReport,
      receipt: {
        code: "sandbox_unavailable",
        metadata: {
          failure_code: "denied",
          business_code: "sandbox_unavailable",
          sandbox_report: sandboxReport,
        },
      },
      observation: {
        facts: { sandbox_report: sandboxReport },
      },
    });
    expect(result.sandbox_report).toEqual(sandboxReport);
  });

  it("rejects contradictory success from an injected restricted runner", async () => {
    const { fixture, data } = await setup();
    const sandboxReport = unavailableReport("workspace-write");
    const runner = new RecordingSandboxRunner(sandboxReport, () => ({
      started: true,
      sandboxReport,
      exitCode: 0,
      stdout: "untrusted success",
      stderr: "",
      timedOut: false,
      truncated: false,
      aborted: false,
    }));
    const runtime = await createAgentRuntime({
      dataDir: data.path,
      model: runTestModel(),
      sandboxMode: "workspace-write",
      sandboxRunner: runner,
    });

    const result = await runToTerminal(runtime, fixture.handle, "Reject contradictory sandbox evidence");

    expect(result.status).toBe("failed");
    expect(result.failure_code).toBe("sandbox_unavailable");
    expect(result.timeline.find(({ type }) => type === "tool.failed")?.data).toMatchObject({
      business_code: "sandbox_unavailable",
      sandbox_report: sandboxReport,
      observation: { facts: { started: false } },
    });
  });

  it("records explicit danger-full-access and lets the injected runner execute directly", async () => {
    const { fixture, data } = await setup();
    const sandboxReport = dangerReport();
    const runner = new RecordingSandboxRunner(sandboxReport, () => ({
      started: true,
      sandboxReport,
      exitCode: 0,
      stdout: "2/2 fixture assertions passed\n",
      stderr: "",
      timedOut: false,
      truncated: false,
      aborted: false,
    }));
    const runtime = await createAgentRuntime({
      dataDir: data.path,
      model: runTestModel(),
      sandboxMode: "danger-full-access",
      sandboxRunner: runner,
    });

    const result = await runToTerminal(runtime, fixture.handle, "Run tests with explicit danger mode");

    expect(result.status).toBe("completed");
    expect(runner.runRequests).toHaveLength(1);
    expect(runner.runRequests[0]?.mode).toBe("danger-full-access");
    expect(result.timeline.find(({ type }) => type === "sandbox.disabled")?.data).toMatchObject({
      reason: "explicit_danger_full_access",
      sandbox_report: sandboxReport,
    });
    expect(result.timeline.find(({ type }) => type === "tool.completed")?.data).toMatchObject({
      sandbox_report: sandboxReport,
    });
    expect(result.sandbox_report).toEqual(sandboxReport);
  });

  it("allows a preview but denies the mutation before approval under read-only policy", async () => {
    const { fixture, data } = await setup();
    const sandboxReport = fullReport("read-only");
    const runner = new RecordingSandboxRunner(sandboxReport, () => {
      throw new Error("read-only approval denial must happen before child execution");
    });
    const model: ModelAdapter = {
      name: "read-only-preview-model",
      async decide() {
        return {
          decision_id: "decision:read-only-preview",
          kind: "tool_call",
          public_reason: "Prepare a reviewable change.",
          evidence_refs: [],
          risk: "high",
          expected_effect: "Preview the addition fix.",
          tool_call: {
            action_id: "action:read-only-preview",
            tool_name: "preview_patch",
            arguments: {
              path: "src/add.ts",
              expected: "return left - right;",
              replacement: "return left + right;",
            },
          },
        };
      },
    };
    const runtime = await createAgentRuntime({
      dataDir: data.path,
      model,
      sandboxMode: "read-only",
      sandboxRunner: runner,
    });
    const started = await runtime.startRun(startInput(fixture.handle, "Preview without write authority"));
    const result = await waitForStatus(runtime, started.run_id, "failed");

    expect(result.status).toBe("failed");
    expect(result.failure_code).toBe("sandbox_denied");
    expect(result.timeline.find(({ type }) => type === "tool.completed")?.data).toMatchObject({
      receipt: { tool_name: "preview_patch", status: "success" },
    });
    expect(result.timeline.some(({ type }) => type === "approval.requested")).toBe(false);
    expect(result.timeline.some(({ type }) => type === "approval.granted")).toBe(false);
    expect(result.timeline.some(({ type }) => type === "patch.applied")).toBe(false);
    expect(result.timeline.some((event) => (
      event.type === "tool.started" && event.data.tool_name === "commit_patch"
    ))).toBe(false);
    expect(result.timeline.find(({ type }) => type === "policy.denied")?.data).toMatchObject({
      code: "sandbox_denied",
      decision: {
        kind: "deny",
        source: "hard-constraint",
        explanation: expect.stringContaining("Permission preset read-only"),
      },
    });
    expect(runner.runRequests).toHaveLength(0);
    expect(await readFile(join(fixture.handle.real_root, "src/add.ts"), "utf8")).toContain("return left - right;");
  });
});

class RecordingSandboxRunner implements SandboxRunner {
  readonly runRequests: SandboxRunRequest[] = [];

  constructor(
    readonly report: SandboxReport,
    readonly execute: (request: SandboxRunRequest) => SandboxExecutionResult,
  ) {}

  async probe(input: { mode: SandboxMode; workspaceRoot: string }): Promise<SandboxReport> {
    if (input.mode !== this.report.mode) throw new Error("test runner received an unexpected mode");
    return this.report;
  }

  async run(request: SandboxRunRequest): Promise<SandboxExecutionResult> {
    this.runRequests.push(request);
    return this.execute(request);
  }
}

function runTestModel(): ModelAdapter {
  return {
    name: "sandbox-run-test-model",
    async decide(input) {
      if (input.observations.length === 0) {
        return {
          decision_id: "decision:sandbox-run-test",
          kind: "tool_call",
          public_reason: "Run the fixture suite.",
          evidence_refs: [],
          risk: "medium",
          expected_effect: "Verify the current workspace.",
          tool_call: {
            action_id: "action:sandbox-run-test",
            tool_name: "run_test",
            arguments: { suite: "fixture" },
          },
        };
      }
      return {
        decision_id: "decision:sandbox-finish",
        kind: "finish",
        public_reason: "The sandboxed test finished.",
        evidence_refs: [],
        risk: "none",
        final_answer: "Sandboxed execution completed.",
      };
    },
  };
}

function unavailableReport(mode: "read-only" | "workspace-write"): SandboxReport {
  return {
    report_version: 1,
    mode,
    enforcement: "none",
    platform: "darwin",
    mechanisms: [],
    unmet_constraints: ["seatbelt_backend_unavailable", "network_denial_unenforced"],
  };
}

function fullReport(mode: "read-only" | "workspace-write"): SandboxReport {
  return {
    report_version: 1,
    mode,
    enforcement: "full",
    platform: "darwin",
    mechanisms: [
      "seatbelt:/usr/bin/sandbox-exec",
      mode === "read-only" ? "filesystem:read-only" : "filesystem:workspace-write",
      "network:denied",
    ],
    unmet_constraints: [],
  };
}

function dangerReport(): SandboxReport {
  return {
    report_version: 1,
    mode: "danger-full-access",
    enforcement: "none",
    platform: "darwin",
    mechanisms: [],
    unmet_constraints: [],
  };
}

function unavailableExecution(sandboxReport: SandboxReport): SandboxExecutionResult {
  return {
    started: false,
    failureCode: "sandbox_unavailable",
    sandboxReport,
    exitCode: null,
    stdout: "",
    stderr: "sandbox enforcement unavailable",
    timedOut: false,
    truncated: false,
    aborted: false,
  };
}

async function setup() {
  const fixture = await createFailingTypescriptFixture(`fixture-sandbox-${Date.now()}`);
  const data = await createTemporaryDataDir();
  cleanups.push(fixture.cleanup, data.cleanup);
  return { fixture, data };
}

function startInput(workspace: WorkspaceHandle, task: string) {
  return {
    command_id: `command:${task.replace(/\s+/gu, "-").toLowerCase()}`,
    project_id: workspace.project_id,
    task,
    mode: "execute" as const,
    workspace,
  };
}

async function runToTerminal(runtime: AgentRuntime, workspace: WorkspaceHandle, task: string) {
  const started = await runtime.startRun(startInput(workspace, task));
  return waitForStatus(runtime, started.run_id, "completed", "failed", "cancelled");
}

async function waitForStatus(
  runtime: AgentRuntime,
  runId: string,
  ...statuses: Array<"awaiting_approval" | "completed" | "failed" | "cancelled">
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const projection = await runtime.getProjection(runId);
    if (statuses.includes(projection.status as (typeof statuses)[number])) return projection;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${statuses.join("/")} on ${runId}`);
}
