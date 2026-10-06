import { describe, expect, it, vi } from "vitest";
import type { ConnectedLocalHost } from "@tracegraph/host";
import { SCHEMA_VERSION, PROJECTOR_VERSION, RunProjectionSchema, type RunProjection, type SessionRunOptionsUpdateRequest } from "@tracegraph/contracts";
import { maybeRunInteractiveChat, splitSlashArguments } from "./interactive-chat.js";
import type { maybeRunWorkbenchCommand } from "./workbench-command.js";

const run = (id = "run:1", status: RunProjection["status"] = "running") => RunProjectionSchema.parse({ schema_version: SCHEMA_VERSION, projector_version: PROJECTOR_VERSION, project_id: "project:1", session_id: "session:1", run_id: id, task: "test task", mode: "execute", workspace_kind: "managed_local", status, last_sequence: 1, timeline: [], artifact_refs: [] });
function fixture() {
  let count = 0;
  const current = new Map<string, RunProjection>();
  const savedOptions = new Map<string, { revision: number; overrides: Record<string, unknown> }>();
  const client = {
    listProjects: vi.fn(async () => [{ project_id: "project:1" }]),
    getSession: vi.fn(async () => ({ header: { session_id: "session:history", project_id: "project:1", run_ids: ["run:history"] }, entries: [] })),
    getSessionRunOptions: vi.fn(async (id: string) => { const stored = savedOptions.get(id) ?? { revision: 0, overrides: {} }; return { session_id: id, ...stored, options: { mode: id === "session:history" ? "plan" : "execute", reasoning_effort: "default", permission_preset: "workspace-write", ...stored.overrides } }; }),
    updateSessionRunOptions: vi.fn(async (id: string, input: SessionRunOptionsUpdateRequest) => { savedOptions.set(id, { revision: input.expected_revision + 1, overrides: input.overrides! }); return client.getSessionRunOptions(id); }),
    startChat: vi.fn(async (input: { task: string; mode: "plan" | "execute" }) => { const value = { ...run(`run:${++count}`), task: input.task, mode: input.mode }; current.set(value.run_id, value); return value; }),
    startRun: vi.fn(async (input: { task: string; mode: "plan" | "execute" }) => { const value = { ...run(`run:${++count}`), task: input.task, mode: input.mode }; current.set(value.run_id, value); return value; }),
    getRun: vi.fn(async (id: string) => current.get(id) ?? run(id, "completed")),
    submitUserInput: vi.fn(async (id: string, input: object) => ({ run_id: id, ...input, status: "pending" })),
    getModelConnections: vi.fn(async () => ({ connections: [{ connection_id: "connection:1", models: ["configured-model"] }] })),
    streamLiveActivities: vi.fn(async function* (_id: string, options: { signal?: AbortSignal }) { await new Promise<void>(resolve => { if (options.signal?.aborted) resolve(); else options.signal?.addEventListener("abort", () => resolve(), { once: true }); }); }),
    stop: vi.fn(), resumeSession: vi.fn(),
  };
  const close = vi.fn(async () => undefined), connect = vi.fn(async () => ({ client, close }) as unknown as ConnectedLocalHost);
  const chunks: string[] = [], commands: string[][] = [];
  const command = vi.fn(async (args: readonly string[], options?: { write?: (text: string) => void }) => { commands.push([...args]); options?.write?.('{"status":"succeeded"}\n'); return 0; }) as unknown as typeof maybeRunWorkbenchCommand;
  return { client, current, close, connect, command, commands, chunks, write: (text: string) => chunks.push(text) };
}
async function* lines(values: string[]) { yield* values; }

describe("interactive CLI shares existing business operations", () => {
  it("rejects malformed entry flags before opening a Profile", async () => {
    const f = fixture(); expect(await maybeRunInteractiveChat(["chat", "interactive", "--unknown"], { ...f, lines: lines([]) })).toBe(2);
    expect(f.connect).not.toHaveBeenCalled(); expect(f.client.startChat).not.toHaveBeenCalled();
  });
  it("preserves task text including flags, shell syntax and escaped leading slashes", async () => {
    const f = fixture();
    expect(await maybeRunInteractiveChat(["chat", "--jsonl"], { ...f, lines: lines(["--help", "/new", "$(touch /tmp/no-effect); `uname`", "/new", "--api-key", "/new", "//explain", "/quit"]) })).toBe(0);
    expect(f.client.startChat.mock.calls.map(([input]) => input.task)).toEqual(["--help", "$(touch /tmp/no-effect); `uname`", "--api-key", "/explain"]);
    expect(f.commands).toEqual([]); expect(f.client.stop).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledTimes(1);
  });
  it("keeps active messages and guidance in the same canonical mailbox; next mode does not mutate the current task", async () => {
    const f = fixture(); await maybeRunInteractiveChat(["chat"], { ...f, lines: lines(["first", "/mode plan", "queued follow-up", "/guide inspect the failing test", "/new", "next", "/quit"]) });
    expect(f.client.submitUserInput.mock.calls.map(([id, input]) => ({ id, ...input }))).toEqual([
      expect.objectContaining({ id: "run:1", body: "queued follow-up", kind: "message" }),
      expect.objectContaining({ id: "run:1", body: "inspect the failing test", kind: "message" }),
    ]);
    expect(f.client.startChat.mock.calls.map(([input]) => input.mode)).toEqual(["execute", "plan"]);
    expect(f.current.get("run:1")?.mode).toBe("execute");
  });
  it("scope selection only reads history; missing projects never submit work", async () => {
    const f = fixture(); await maybeRunInteractiveChat(["chat", "interactive"], { ...f, lines: lines(["/project project:missing", "/session session:history", "/quit"]) });
    expect(f.client.getSession).toHaveBeenCalledWith("session:history"); expect(f.client.resumeSession).not.toHaveBeenCalled();
    expect(f.client.startRun).not.toHaveBeenCalled(); expect(f.client.startChat).not.toHaveBeenCalled(); expect(f.client.stop).not.toHaveBeenCalled();
    expect(f.client.updateSessionRunOptions).not.toHaveBeenCalled();
  });
  it("inherits the reopened conversation mode and durably updates only future options", async () => {
    const f = fixture(); await maybeRunInteractiveChat(["chat"], { ...f, lines: lines(["/session session:history", "answer in saved plan mode", "/mode execute", "/new", "new task", "/quit"]) });
    expect(f.client.startRun.mock.calls[0]?.[0].mode).toBe("plan");
    expect(f.client.updateSessionRunOptions).toHaveBeenCalledWith("session:1", expect.objectContaining({ expected_revision: 0, overrides: { mode: "execute" } }));
    expect(f.current.get("run:1")?.mode).toBe("plan");
    expect(f.client.startRun.mock.calls[1]?.[0].mode).toBe("execute");
  });
  it("inherits a named command's selected conversation instead of retaining another project's options", async () => {
    const f = fixture();
    const command = vi.fn(async (_args: readonly string[], options?: { write?: (text: string) => void }) => {
      options?.write?.(JSON.stringify({ ...run("run:history", "completed"), session_id: "session:history", mode: "plan" }) + "\n");
      return 0;
    }) as unknown as typeof maybeRunWorkbenchCommand;
    await maybeRunInteractiveChat(["chat"], { ...f, command, lines: lines(["/sessions resume session:history", "follow the saved plan mode", "/quit"]) });
    expect(f.client.getSessionRunOptions).toHaveBeenCalledWith("session:history");
    expect(f.client.startRun).toHaveBeenCalledWith(expect.objectContaining({ project_id: "project:1", session_id: "session:history", mode: "plan" }));
    expect(f.client.resumeSession).not.toHaveBeenCalled();
  });
  it("does not invent a Session for a legacy Run or inherit another conversation's model", async () => {
    const f = fixture();
    const command = vi.fn(async (_args: readonly string[], options?: { write?: (text: string) => void }) => {
      const legacy = { ...run("run:legacy", "completed"), mode: "plan" };
      delete (legacy as { session_id?: string }).session_id;
      options?.write?.(JSON.stringify(legacy) + "\n"); return 0;
    }) as unknown as typeof maybeRunWorkbenchCommand;
    await maybeRunInteractiveChat(["chat"], { ...f, command, lines: lines(["/model connection:1 configured-model", "/run get run:legacy", "a new request", "/quit"]) });
    expect(f.client.getSessionRunOptions).not.toHaveBeenCalled();
    const request=f.client.startRun.mock.calls[0]?.[0];expect(request).toMatchObject({mode:"plan"});expect(request).not.toHaveProperty("session_id");expect(request).not.toHaveProperty("run_options");
  });
  it("forwards exact approval identifiers and literal quoted values without an evaluator", async () => {
    const f = fixture(); await maybeRunInteractiveChat(["chat"], { ...f, lines: lines(["task", "/approve-plan plan:exact", '/run approve run:1 --approval-id approval:exact --action-id "action:exact"', '/run input run:1 --body "$(whoami); `uname`"', "/quit"]) });
    expect(f.commands[0]).toEqual(expect.arrayContaining(["run", "approve-plan", "run:1", "--plan-event-id", "plan:exact"]));
    expect(f.commands[1]).toEqual(expect.arrayContaining(["--approval-id", "approval:exact", "--action-id", "action:exact"]));
    expect(f.commands[2]).toContain("$(whoami); `uname`");
    expect(splitSlashArguments("command 'a b' c\\ d")).toEqual(["command", "a b", "c d"]);
    expect(() => splitSlashArguments("'unterminated")).toThrow();
  });
  it("chooses only configured models for subsequent tasks and isolates noninteractive stdin", async () => {
    const f = fixture(); await maybeRunInteractiveChat(["chat"], { ...f, lines: lines(["/model connection:1 invented", "/model connection:1 configured-model", "/project project:1", "task", "/models save --key-stdin", "/config set --input-file -", "/terminal attach terminal:1", "/quit"]) });
    expect(f.client.startRun).toHaveBeenCalledWith(expect.objectContaining({ project_id: "project:1", run_options: { connection_id: "connection:1", model: "configured-model", mode: "execute" } }));
    expect(f.commands).toEqual([]);
  });
  it("emits typed public facts, suppresses duplicate sequences and does not promote a failed draft to an answer", async () => {
    const f = fixture();
    const fact = { schema_version: SCHEMA_VERSION, activity_id: "activity:1", source_event_id: "event:1", source_event_type: "run.failed", project_id: "project:1", run_id: "run:1", sequence: 1, occurred_at: "2026-10-05T00:00:00.000Z", kind: "run", status: "failed", summary: "Verification failed" };
    f.client.streamLiveActivities = vi.fn(async function* () { yield { ...fact, reasoning_content: "PRIVATE_UNVERIFIED_DRAFT" }; yield fact; }) as unknown as typeof f.client.streamLiveActivities;
    f.client.getRun.mockImplementation(async id => ({ ...run(id, "failed"), outcome: "DRAFT_NOT_DELIVERED" }));
    const input = async function* () { yield "task"; await new Promise(resolve => setTimeout(resolve, 10)); yield "/quit"; };
    await maybeRunInteractiveChat(["chat", "--jsonl"], { ...f, lines: input() });
    const output = f.chunks.join(""); expect(output).not.toContain("PRIVATE_UNVERIFIED_DRAFT"); expect(output).not.toContain("DRAFT_NOT_DELIVERED");
    expect(output.match(/"kind":"activity"/gu)).toHaveLength(1); expect(output).toContain('"status":"failed"'); expect(output).not.toContain('"kind":"answer"');
  });
  it("rejects another Run's activity before displaying it and EOF never cancels tasks", async () => {
    const f = fixture();
    f.client.streamLiveActivities = vi.fn(async function* () { yield { schema_version: SCHEMA_VERSION, activity_id: "activity:other", source_event_id: "event:other", source_event_type: "run.completed", project_id: "project:other", run_id: "run:other", sequence: 1, occurred_at: "2026-10-05T00:00:00.000Z", kind: "run", status: "completed", summary: "OTHER_TASK_CONTENT" }; }) as unknown as typeof f.client.streamLiveActivities;
    const input = async function* () { yield "task"; await new Promise(resolve => setTimeout(resolve, 10)); };
    await maybeRunInteractiveChat(["chat", "--jsonl"], { ...f, lines: input() });
    expect(f.chunks.join("")).not.toContain("OTHER_TASK_CONTENT"); expect(f.client.stop).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledTimes(1);
  });
  it("displays new canonical facts even after the volatile owner sequence restarts", async () => {
    const f = fixture();
    const fact = { schema_version: SCHEMA_VERSION, activity_id: "activity:1", source_event_id: "event:1", source_event_type: "run.completed", project_id: "project:1", run_id: "run:1", sequence: 50, occurred_at: "2026-10-05T00:00:00.000Z", kind: "run", status: "completed", summary: "Before owner replacement" };
    f.client.streamLiveActivities = vi.fn(async function* () { yield fact; yield { ...fact, activity_id: "activity:2", source_event_id: "event:2", sequence: 1, summary: "After owner replacement" }; yield fact; }) as unknown as typeof f.client.streamLiveActivities;
    const input = async function* () { yield "task"; await new Promise(resolve => setTimeout(resolve, 10)); yield "/quit"; };
    await maybeRunInteractiveChat(["chat", "--jsonl"], { ...f, lines: input() });
    expect(f.chunks.join("").match(/"kind":"activity"/gu)).toHaveLength(2);
    expect(f.chunks.join("")).toContain("After owner replacement");
  });
});
