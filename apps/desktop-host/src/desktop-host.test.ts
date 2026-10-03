import { MemoryExperienceController, RunSessionController, type MemoryExperienceRuntimePort } from "@tracegraph/api";
import { describe, expect, it, vi } from "vitest";
import { ClientCommandSchema, ClientQuerySchema } from "@tracegraph/sdk/protocol";
import { createDesktopHostDispatcher } from "./desktop-host.js";

describe("Desktop Host API dispatcher", () => {
  it("routes the first Run/Session query slice to the existing controller", async () => {
    const controller = {
      startRun: vi.fn(async (input: unknown) => ({ run_id: "run:one", input })),
      getRun: vi.fn(async (runId: string) => ({ run_id: runId })),
      listSessions: vi.fn(async (query: unknown) => ({ query })),
      getSession: vi.fn(async (sessionId: string) => ({ session_id: sessionId })),
    } as unknown as RunSessionController;
    const dispatcher = createDesktopHostDispatcher(controller);
    const context = { signal: new AbortController().signal, async sendEvent() {} };
    const input = { command_id: "command:one", project_id: "project:one", task: "Inspect", mode: "plan" };

    await expect(dispatcher.handleCommand({ type: "start_run", command_id: "command:one", input } as never, context))
      .resolves.toEqual({ resource: "run", value: { run_id: "run:one", input } });
    await expect(dispatcher.handleQuery({ operation: "run.get", run_id: "run:one" }, context))
      .resolves.toEqual({ resource: "run", value: { run_id: "run:one" } });
    await expect(dispatcher.handleQuery({ operation: "session.list", input: { view: "roots", limit: 10 } }, context))
      .resolves.toMatchObject({ resource: "sessions" });
    await expect(dispatcher.handleQuery({ operation: "session.get", session_id: "session:one" }, context))
      .resolves.toEqual({ resource: "session", value: { session_id: "session:one" } });

    expect(controller.startRun).toHaveBeenCalledWith(input);
    expect(controller.getRun).toHaveBeenCalledWith("run:one");
    expect(controller.getSession).toHaveBeenCalledWith("session:one");
  });

  it("fails Run controls closed when the controller is absent", async () => {
    const controller = {
      startRun: vi.fn(),
      getRun: vi.fn(),
      listSessions: vi.fn(),
      getSession: vi.fn(),
    } as unknown as RunSessionController;
    const dispatcher = createDesktopHostDispatcher(controller);
    const context = { signal: new AbortController().signal, async sendEvent() {} };

    await expect(dispatcher.handleCommand({ type: "approve" } as never, context))
      .rejects.toMatchObject({ code: "unavailable" });
  });

  it("dispatches shared Experience commands with Host-derived scope and preserves CAS/idempotency fields", async () => {
    const runController = {
      startRun: vi.fn(),
      getRun: vi.fn(),
      listSessions: vi.fn(),
      getSession: vi.fn(),
    } as unknown as RunSessionController;
    const reviewExperienceCase = vi.fn(async () => { throw Object.assign(new Error("stale sequence"), { code: "experience_conflict" }); });
    const runtime = {
      listMemoryControl: vi.fn(async () => ({ items: [], conflicts: [] })),
      createMemoryCandidate: vi.fn(),
      reviewMemory: vi.fn(),
      correctMemory: vi.fn(),
      revokeMemory: vi.fn(),
      deleteMemory: vi.fn(),
      listExperienceCases: vi.fn(async () => []),
      reviewExperienceCase,
    } as unknown as MemoryExperienceRuntimePort;
    let visibleProjectIds = ["project:registered"];
    const controls = new MemoryExperienceController({ runtime, getProjectIds: () => visibleProjectIds });
    const dispatcher = createDesktopHostDispatcher(runController, controls);
    const context = { signal: new AbortController().signal, async sendEvent() {} };

    const query = ClientQuerySchema.parse({ operation: "experience.list" });
    await expect(dispatcher.handleQuery(query, context)).resolves.toEqual({ resource: "experience_cases", value: { items: [] } });
    expect(runtime.listExperienceCases).toHaveBeenCalledWith({ allowedScopeIds: ["project:registered"] });

    const command = ClientCommandSchema.parse({
      type: "experience.review",
      case_id: "experience:case",
      input: { command_id: "command:review", expected_sequence: 7, action: "resolve" },
    });
    await expect(dispatcher.handleCommand(command, context)).rejects.toMatchObject({ code: "conflict" });
    expect(reviewExperienceCase).toHaveBeenCalledWith("experience:case", {
      action: "resolve",
      expectedSequence: 7,
      commandId: "command:review",
    }, { allowedScopeIds: ["project:registered"] });

    visibleProjectIds = [];
    await expect(dispatcher.handleQuery(query, context)).resolves.toEqual({ resource: "experience_cases", value: { items: [] } });
    expect(runtime.listExperienceCases).toHaveBeenLastCalledWith({ allowedScopeIds: [] });
  });
});
