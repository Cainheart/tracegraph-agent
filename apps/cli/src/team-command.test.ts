import { describe, expect, it, vi } from "vitest";
import { runTeamCommand } from "./team-command.js";

function createClient(calls: unknown[]) {
  return {
    async bootstrap() { calls.push("bootstrap"); return {}; },
    async getTeam(runId: string) {
      calls.push(["show", runId]);
      return { team: { coordinator_run_id: runId } };
    },
    async createTeam(runId: string, request?: unknown) {
      calls.push(request === undefined ? ["create", runId] : ["create", runId, request]);
      return { operation: "create", run_id: runId };
    },
    async sendTeamMailbox(runId: string, request: unknown) {
      calls.push(["mailbox_send", runId, request]);
      return { operation: "mailbox_send", run_id: runId };
    },
    async claimTeamMailbox(runId: string, request: unknown) {
      calls.push(["mailbox_claim", runId, request]);
      return { operation: "mailbox_claim", run_id: runId };
    },
    async writeTeamTask(runId: string, request: unknown) {
      calls.push(["task_write", runId, request]);
      return { operation: "task_write", run_id: runId };
    },
    async heartbeatTeam(runId: string, request?: unknown) {
      calls.push(request === undefined ? ["heartbeat", runId] : ["heartbeat", runId, request]);
      return { operation: "heartbeat", run_id: runId };
    },
    async sweepLostTeamMembers(runId: string, request?: unknown) {
      calls.push(request === undefined ? ["sweep", runId] : ["sweep", runId, request]);
      return { operation: "sweep", run_id: runId };
    },
  };
}

describe("team CLI command", () => {
  it("bootstraps and dispatches snapshots, creation, and mailbox operations through the SDK", async () => {
    const calls: unknown[] = [];
    const selectedUrls: string[] = [];
    const write = vi.fn();
    const client = createClient(calls);
    const dependencies = {
      environment: { TRACEGRAPH_HOST_URL: "http://127.0.0.1:4888" },
      createClient(baseUrl: string) {
        selectedUrls.push(baseUrl);
        return client;
      },
      write,
    };

    await runTeamCommand(["show", "run-root"], dependencies);
    await runTeamCommand(["create", "run-root", "--host-url", "http://127.0.0.1:4999"], dependencies);
    await runTeamCommand([
      "mailbox",
      "send",
      "run-member",
      "--to",
      "coordinator",
      "--kind",
      "answer",
      "--payload",
      "The failing test is isolated",
    ], dependencies);
    await runTeamCommand([
      "mailbox",
      "claim",
      "run-member",
      "--message-id",
      "message-one",
    ], dependencies);

    expect(selectedUrls).toEqual([
      "http://127.0.0.1:4888",
      "http://127.0.0.1:4999",
      "http://127.0.0.1:4888",
      "http://127.0.0.1:4888",
    ]);
    expect(calls).toEqual([
      "bootstrap",
      ["show", "run-root"],
      "bootstrap",
      ["create", "run-root"],
      "bootstrap",
      ["mailbox_send", "run-member", {
        input: {
          to: "coordinator",
          kind: "answer",
          payload: "The failing test is isolated",
        },
      }],
      "bootstrap",
      ["mailbox_claim", "run-member", { input: { message_id: "message-one" } }],
    ]);
    expect(write).toHaveBeenCalledTimes(4);
    expect(write.mock.calls.every(([value]) => String(value).endsWith("\n"))).toBe(true);
    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toEqual({
      team: { coordinator_run_id: "run-root" },
    });
  });

  it("maps every task transition plus heartbeat and sweep without accepting identity fields", async () => {
    const calls: unknown[] = [];
    const client = createClient(calls);
    const dependencies = {
      environment: {},
      createClient: () => client,
      write: () => undefined,
    };

    await runTeamCommand([
      "task", "create", "run-root", "--task-id", "task-one", "--title", "Inspect race",
      "--detail", "Reproduce before fixing", "--acceptance", "One owner", "--acceptance", "Durable proof",
    ], dependencies);
    await runTeamCommand([
      "task", "claim", "run-member", "--task-id", "task-one", "--expected-version", "1",
    ], dependencies);
    await runTeamCommand([
      "task", "complete", "run-member", "--task-id", "task-one", "--expected-version", "2",
      "--evidence-event-id", "event-test", "--evidence-event-id", "event-review",
    ], dependencies);
    await runTeamCommand([
      "task", "block", "run-member", "--task-id", "task-two", "--expected-version", "3",
      "--reason", "Waiting for fixture",
    ], dependencies);
    await runTeamCommand([
      "task", "cancel", "run-root", "--task-id", "task-three", "--expected-version", "4",
      "--reason", "No longer needed",
    ], dependencies);
    await runTeamCommand([
      "task", "reopen", "run-root", "--task-id", "task-three", "--expected-version", "5",
      "--reason", "Requirement restored",
    ], dependencies);
    await runTeamCommand(["heartbeat", "run-member"], dependencies);
    await runTeamCommand(["sweep", "run-root"], dependencies);

    expect(calls.filter((call) => call === "bootstrap")).toHaveLength(8);
    expect(calls.filter((call) => Array.isArray(call))).toEqual([
      ["task_write", "run-root", { input: {
        operation: "create",
        task_id: "task-one",
        title: "Inspect race",
        detail: "Reproduce before fixing",
        acceptance: ["One owner", "Durable proof"],
      } }],
      ["task_write", "run-member", { input: {
        operation: "claim", task_id: "task-one", expected_version: 1,
      } }],
      ["task_write", "run-member", { input: {
        operation: "complete",
        task_id: "task-one",
        expected_version: 2,
        evidence_event_ids: ["event-test", "event-review"],
      } }],
      ["task_write", "run-member", { input: {
        operation: "block", task_id: "task-two", expected_version: 3, reason: "Waiting for fixture",
      } }],
      ["task_write", "run-root", { input: {
        operation: "cancel", task_id: "task-three", expected_version: 4, reason: "No longer needed",
      } }],
      ["task_write", "run-root", { input: {
        operation: "reopen", task_id: "task-three", expected_version: 5, reason: "Requirement restored",
      } }],
      ["heartbeat", "run-member"],
      ["sweep", "run-root"],
    ]);
  });

  it("passes an explicit command id through every mutation family for safe manual retries", async () => {
    const calls: unknown[] = [];
    const client = createClient(calls);
    const dependencies = {
      environment: {},
      createClient: () => client,
      write: () => undefined,
    };
    const commands: readonly (readonly string[])[] = [
      ["create", "run-root", "--command-id", "command-create"],
      [
        "mailbox", "send", "run-root", "--to", "subagent:worker", "--kind", "steer",
        "--payload", "Inspect the retry", "--command-id", "command-mailbox-send",
      ],
      [
        "mailbox", "claim", "run-member", "--message-id", "message-one",
        "--command-id", "command-mailbox-claim",
      ],
      [
        "task", "create", "run-root", "--task-id", "task-one", "--title", "Inspect retry",
        "--acceptance", "Durable result", "--command-id", "command-task-create",
      ],
      [
        "task", "claim", "run-member", "--task-id", "task-one", "--expected-version", "1",
        "--command-id", "command-task-claim",
      ],
      [
        "task", "complete", "run-member", "--task-id", "task-one", "--expected-version", "2",
        "--evidence-event-id", "event-proof", "--command-id", "command-task-complete",
      ],
      [
        "task", "block", "run-member", "--task-id", "task-two", "--expected-version", "3",
        "--reason", "Waiting", "--command-id", "command-task-block",
      ],
      [
        "task", "cancel", "run-root", "--task-id", "task-three", "--expected-version", "4",
        "--reason", "Obsolete", "--command-id", "command-task-cancel",
      ],
      [
        "task", "reopen", "run-root", "--task-id", "task-three", "--expected-version", "5",
        "--reason", "Restored", "--command-id", "command-task-reopen",
      ],
      ["heartbeat", "run-member", "--command-id", "command-heartbeat"],
      ["sweep", "run-root", "--command-id", "command-sweep"],
    ];

    for (const args of commands) await runTeamCommand(args, dependencies);

    expect(calls.filter(Array.isArray).map((call) => call[2])).toEqual([
      { command_id: "command-create" },
      expect.objectContaining({ command_id: "command-mailbox-send" }),
      expect.objectContaining({ command_id: "command-mailbox-claim" }),
      expect.objectContaining({ command_id: "command-task-create" }),
      expect.objectContaining({ command_id: "command-task-claim" }),
      expect.objectContaining({ command_id: "command-task-complete" }),
      expect.objectContaining({ command_id: "command-task-block" }),
      expect.objectContaining({ command_id: "command-task-cancel" }),
      expect.objectContaining({ command_id: "command-task-reopen" }),
      { command_id: "command-heartbeat" },
      { command_id: "command-sweep" },
    ]);
  });

  it("rejects authority, ownership, project, clock, and timeout injection before bootstrap", async () => {
    const bootstrap = vi.fn(async () => ({}));
    const client = { ...createClient([]), bootstrap };
    const dependencies = {
      createClient: () => client,
      write: () => undefined,
    };
    const invalidCommands: readonly (readonly string[])[] = [
      ["show", "run-root", "--project", "project-forged"],
      ["show", "run-root", "--command-id", "command-not-allowed"],
      ["create", "run-root", "--command-id", "command-one", "--command-id", "command-two"],
      ["mailbox", "send", "run-root", "--to", "member-one", "--kind", "steer", "--payload", "x", "--from", "forged"],
      ["mailbox", "claim", "run-member", "--message-id", "message-one", "--actor", "forged"],
      ["task", "claim", "run-member", "--task-id", "task-one", "--expected-version", "1", "--owner", "forged"],
      ["heartbeat", "run-member", "--time", "2026-09-20T00:00:00.000Z"],
      ["sweep", "run-root", "--timeout", "1"],
      ["task", "claim", "run-member", "--task-id", "task-one", "--expected-version", "0"],
      ["task", "complete", "run-member", "--task-id", "task-one", "--expected-version", "2"],
    ];

    for (const args of invalidCommands) {
      await expect(runTeamCommand(args, dependencies)).rejects.toThrow(/Usage:/u);
    }
    expect(bootstrap).not.toHaveBeenCalled();
  });
});
