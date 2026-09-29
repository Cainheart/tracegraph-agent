import {
  DISPOSABLE_FIXTURE_CAPABILITIES,
  WorkspaceHandleSchema,
} from "@tracegraph/contracts";
import { describe, expect, it } from "vitest";
import {
  RuntimeFeatureDriverRegistry,
  type RuntimeFeatureId,
  type RuntimeFeatureToolContext,
  type RuntimeFeatureTurnContext,
} from "./runtime-feature-drivers.js";

const featureIds: readonly RuntimeFeatureId[] = ["memory", "team", "todo", "attachment"];

describe("RuntimeFeatureDriverRegistry", () => {
  it.each(featureIds)("disables only the %s lifecycle contribution", async (disabled) => {
    const calls: string[] = [];
    const registry = new RuntimeFeatureDriverRegistry([disabled]);
    registry.register({
      id: "memory",
      contributeTurn: async () => {
        calls.push("memory.turn");
        return { retrievedMemory: [] };
      },
    });
    registry.register({
      id: "team",
      tools: ["team_read"],
      contributeToolContext: async () => {
        calls.push("team.tool");
        return { team: {
          read: async () => ({}),
          writeTask: async () => ({}),
          sendMailbox: async () => ({}),
          claimMailbox: async () => ({}),
          heartbeat: async () => ({}),
        } };
      },
    });
    registry.register({
      id: "todo",
      tools: ["todo_read"],
      contributeToolContext: async () => {
        calls.push("todo.tool");
        return { todos: { read: async () => ({} as never), write: async () => ({} as never) } };
      },
    });
    registry.register({
      id: "attachment",
      onRunCreated: async ({ claimAttachments }) => {
        calls.push("attachment.run_created");
        await claimAttachments();
      },
    });

    const runContext = {
      projectId: "project:runtime-features",
      runId: "run:runtime-features",
      sessionId: "session:runtime-features",
      uploadIds: ["upload:runtime-features"],
      claimAttachments: async () => { calls.push("attachment.claim"); },
    };
    const workspace = WorkspaceHandleSchema.parse({
      handle_id: "workspace:runtime-features",
      project_id: "project:runtime-features",
      real_root: "/tmp",
      workspace_kind: "disposable_fixture",
      capabilities: DISPOSABLE_FIXTURE_CAPABILITIES,
      created_at: "2026-09-30T00:00:00.000Z",
    });
    await registry.onRunCreated(runContext);
    const turn = await registry.contributeTurn({
      ...runContext,
      task: "test",
      turn: 1,
      signal: new AbortController().signal,
    } satisfies RuntimeFeatureTurnContext);
    const toolContext = await registry.contributeToolContext({
      ...runContext,
      workspace,
      actionId: "action:runtime-features",
    } satisfies RuntimeFeatureToolContext);

    expect(registry.isEnabled(disabled)).toBe(false);
    for (const feature of featureIds.filter((id) => id !== disabled)) {
      expect(registry.isEnabled(feature)).toBe(true);
    }
    expect(registry.isToolEnabled("todo_read")).toBe(disabled !== "todo");
    expect(registry.isToolEnabled("team_read")).toBe(disabled !== "team");
    expect(turn.retrievedMemory).toEqual([]);
    expect(toolContext.todos !== undefined).toBe(disabled !== "todo");
    expect(toolContext.team !== undefined).toBe(disabled !== "team");
    expect(calls.includes("attachment.claim")).toBe(disabled !== "attachment");
    expect(calls.includes("memory.turn")).toBe(disabled !== "memory");
    expect(calls.includes("team.tool")).toBe(disabled !== "team");
    expect(calls.includes("todo.tool")).toBe(disabled !== "todo");
    expect(calls.includes("attachment.run_created")).toBe(disabled !== "attachment");
  });

  it("rejects duplicate feature and Tool ownership registrations", () => {
    const registry = new RuntimeFeatureDriverRegistry(undefined);
    registry.register({ id: "todo", tools: ["todo_read"] });
    expect(() => registry.register({ id: "todo" })).toThrow("already registered");
    expect(() => registry.register({ id: "team", tools: ["todo_read"] })).toThrow("already owned");
  });

  it("does not partially claim Tools when a contribution has an ownership conflict", () => {
    const registry = new RuntimeFeatureDriverRegistry(undefined);
    registry.register({ id: "todo", tools: ["todo_read"] });

    expect(() => registry.register({ id: "team", tools: ["team_read", "todo_read"] }))
      .toThrow("already owned");
    expect(registry.isToolEnabled("team_read")).toBe(true);
    expect(() => registry.register({ id: "team", tools: ["team_read"] })).not.toThrow();
  });
});
