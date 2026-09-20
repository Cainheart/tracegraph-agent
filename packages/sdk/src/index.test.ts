import { describe, expect, it } from "vitest";
import { PROJECTOR_VERSION, SCHEMA_VERSION, type ReplayDiff, type ReplaySessionResponse } from "@tracegraph/contracts";
import { TraceGraphClient, TraceGraphHttpError, parseSseData } from "./index.js";

const streamFrom = (chunks: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

const replayHash = `sha256:${"b".repeat(64)}` as const;
const replayEvent = {
  schema_version: SCHEMA_VERSION,
  event_id: "event-replay-created",
  project_id: "project-one",
  session_id: "session-one",
  run_id: "run-one",
  sequence: 1,
  occurred_at: "2026-09-19T00:00:00.000Z",
  type: "run.created" as const,
  summary: "Run created",
  artifact_refs: [],
  data: { task: "Replay the run", mode: "plan", workspace_kind: "readonly_local" },
};
const replayProjection = {
  schema_version: SCHEMA_VERSION,
  projector_version: PROJECTOR_VERSION,
  project_id: "project-one",
  session_id: "session-one",
  run_id: "run-one",
  task: "Replay the run",
  mode: "plan" as const,
  workspace_kind: "readonly_local" as const,
  status: "created" as const,
  last_sequence: 1,
  timeline: [replayEvent],
  todos: { items: [], last_sequence: 1 },
  input_queue: { pending: [] },
  attachments: { items: [], last_sequence: 1 },
  artifact_refs: [],
};

function replaySessionResponse(replayToken: string): ReplaySessionResponse {
  return {
    replay_id: "replay-one",
    replay_token: replayToken,
    expires_at: "2026-09-19T00:10:00.000Z",
    snapshot: {
      schema_version: "tracegraph.replay-snapshot.v1",
      session_id: "session-one",
      project_id: "project-one",
      run_id: "run-one",
      until_sequence: 1,
      head_sequence: 1,
      anchor_event_id: replayEvent.event_id,
      anchor_event_hash: replayHash,
      projection: replayProjection,
      snapshot_hash: replayHash,
    },
  };
}

const replaySameDiff: ReplayDiff = {
  schema_version: "tracegraph.replay-diff.v1",
  session_id: "session-one",
  project_id: "project-one",
  run_id: "run-one",
  head_sequence: 1,
  from_sequence: 1,
  to_sequence: 1,
  direction: "same",
  from_snapshot_hash: replayHash,
  to_snapshot_hash: replayHash,
  events: { added: [], removed: [] },
  evidence: { added: [], removed: [], changed: [] },
  tool_results: { added: [], removed: [] },
  todos: { added: [], removed: [], changed: [] },
  approval: { changed: false },
  pending_plan: { changed: false },
};

describe("parseSseData", () => {
  it("uses typed Todo, steering input, and exact plan-approval routes", async () => {
    const requests: Array<{ url: string; method: string; commandId: string | null; body?: unknown }> = [];
    const todo = {
      todo_id: "todo-one",
      title: "Inspect the plan",
      state: "pending" as const,
      depends_on: [],
      evidence_event_ids: [],
      created_by: "model" as const,
    };
    const projection = {
      schema_version: "tracegraph.session-event.v1" as const,
      projector_version: PROJECTOR_VERSION,
      project_id: "project-one",
      run_id: "run-one",
      task: "Plan then execute",
      mode: "execute" as const,
      workspace_kind: "disposable_fixture" as const,
      status: "running" as const,
      last_sequence: 4,
      timeline: [],
      todos: { items: [todo], last_sequence: 3 },
      artifact_refs: [],
    };
    const client = new TraceGraphClient({
      token: "test-token",
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({
          url,
          method: init?.method ?? "GET",
          commandId: new Headers(init?.headers).get("x-tracegraph-command-id"),
          ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
        });
        if (url.endsWith("/todos") && (init?.method ?? "GET") === "GET") {
          return Response.json(projection.todos);
        }
        if (url.endsWith("/todos")) {
          return Response.json({ todo, event_type: "todo.updated", event_id: "event-todo", last_sequence: 4 });
        }
        if (url.endsWith("/input")) {
          const body = JSON.parse(String(init?.body)) as { input_id: string; kind: "message"; body: string };
          return Response.json({
            disposition: "queued",
            input: {
              input_id: body.input_id,
              run_id: "run-one",
              kind: body.kind,
              body: body.body,
              actor: "user",
              submitted_at: "2026-09-19T00:00:00.000Z",
            },
          });
        }
        return Response.json(projection);
      },
    });

    await expect(client.getTodos("run-one")).resolves.toEqual(projection.todos);
    await expect(client.writeTodo("run-one", {
      command_id: "command-todo",
      input: { operation: "update", todo_id: "todo-one", state: "in_progress" },
    })).resolves.toMatchObject({ event_type: "todo.updated" });
    await expect(client.approvePlan("run-one", {
      command_id: "command-plan",
      plan_event_id: "event-plan-ready",
    })).resolves.toMatchObject({ run_id: "run-one", mode: "execute" });
    await expect(client.submitUserInput("run-one", {
      command_id: "command-steer",
      input_id: "input-steer",
      kind: "message",
      body: "Check the retry path next",
    })).resolves.toMatchObject({
      disposition: "queued",
      input: { input_id: "input-steer", run_id: "run-one", actor: "user" },
    });

    expect(requests).toEqual([
      { url: "http://127.0.0.1:4311/api/runs/run-one/todos", method: "GET", commandId: null },
      {
        url: "http://127.0.0.1:4311/api/runs/run-one/todos",
        method: "POST",
        commandId: "command-todo",
        body: { command_id: "command-todo", input: { operation: "update", todo_id: "todo-one", state: "in_progress" } },
      },
      {
        url: "http://127.0.0.1:4311/api/runs/run-one/plan/approve",
        method: "POST",
        commandId: "command-plan",
        body: { command_id: "command-plan", plan_event_id: "event-plan-ready" },
      },
      {
        url: "http://127.0.0.1:4311/api/runs/run-one/input",
        method: "POST",
        commandId: "command-steer",
        body: {
          command_id: "command-steer",
          input_id: "input-steer",
          kind: "message",
          body: "Check the retry path next",
        },
      },
    ]);
  });

  it("parses events split across network chunks", async () => {
    const values: string[] = [];
    for await (const value of parseSseData(
      streamFrom(["id: 1\ndata: {\"sequence\":", "1}\n\nid: 2\ndata: two\n\n"]),
    )) {
      values.push(value);
    }
    expect(values).toEqual(['{"sequence":1}', "two"]);
  });

  it("reads the volatile public-process SSE endpoint without treating it as ledger replay", async () => {
    let requestedUrl = "";
    const client = new TraceGraphClient({
      token: "test-token",
      fetch: async (input) => {
        requestedUrl = String(input);
        return new Response(streamFrom([
          "id: live:event-1\ndata: {\"schema_version\":\"tracegraph.session-event.v1\",\"activity_id\":\"live:event-1\",\"source_event_id\":\"event-1\",\"source_event_type\":\"model.request_started\",\"project_id\":\"project-1\",\"run_id\":\"run-1\",\"sequence\":4,\"occurred_at\":\"2026-09-17T00:00:00.000Z\",\"kind\":\"model\",\"status\":\"started\",\"summary\":\"Requesting a public decision\"}\n\n",
        ]), { headers: { "content-type": "text/event-stream" } });
      },
    });

    const activities = [];
    for await (const activity of client.streamLiveActivities("run-1", { reconnect: false })) {
      activities.push(activity);
    }

    expect(requestedUrl).toBe("http://127.0.0.1:4311/api/runs/run-1/live/stream?after_sequence=0");
    expect(activities).toEqual([expect.objectContaining({
      kind: "model",
      status: "started",
      source_event_type: "model.request_started",
    })]);
  });

  it("reads the separate model-surface SSE endpoint with its own cursor", async () => {
    let requestedUrl = "";
    const client = new TraceGraphClient({
      token: "test-token",
      fetch: async (input) => {
        requestedUrl = String(input);
        return new Response(streamFrom([
          "id: surface:run-1:4\ndata: {\"schema_version\":\"tracegraph.session-event.v1\",\"surface_event_id\":\"surface:run-1:4\",\"project_id\":\"project-1\",\"run_id\":\"run-1\",\"model_call_id\":\"call-1\",\"cursor\":4,\"occurred_at\":\"2026-09-17T00:00:00.000Z\",\"type\":\"public_plan_snapshot\",\"status\":\"streaming\",\"text\":\"I will inspect the README first.\"}\n\n",
        ]), { headers: { "content-type": "text/event-stream" } });
      },
    });

    const events = [];
    for await (const event of client.streamModelSurface("run-1", { afterCursor: 3, reconnect: false })) {
      events.push(event);
    }

    expect(requestedUrl).toBe("http://127.0.0.1:4311/api/runs/run-1/model-surface/stream?after_cursor=3");
    expect(events).toEqual([expect.objectContaining({
      cursor: 4,
      type: "public_plan_snapshot",
      text: "I will inspect the README first.",
    })]);
  });

  it("stops reconnecting after the real terminal Run activity", async () => {
    let requests = 0;
    const client = new TraceGraphClient({
      token: "test-token",
      fetch: async () => {
        requests += 1;
        return new Response(streamFrom([
          "id: live:event-terminal\ndata: {\"schema_version\":\"tracegraph.session-event.v1\",\"activity_id\":\"live:event-terminal\",\"source_event_id\":\"event-terminal\",\"source_event_type\":\"run.completed\",\"project_id\":\"project-1\",\"run_id\":\"run-1\",\"sequence\":9,\"occurred_at\":\"2026-09-17T00:00:00.000Z\",\"kind\":\"run\",\"status\":\"completed\",\"summary\":\"Run completed\"}\n\n",
        ]), { headers: { "content-type": "text/event-stream" } });
      },
    });

    const activities = [];
    for await (const activity of client.streamLiveActivities("run-1")) activities.push(activity);

    expect(activities).toEqual([expect.objectContaining({ source_event_type: "run.completed" })]);
    expect(requests).toBe(1);
  });

  it("stops reconnecting when a plan is ready for explicit approval", async () => {
    let requests = 0;
    const client = new TraceGraphClient({
      token: "test-token",
      fetch: async (input) => {
        requests += 1;
        if (!String(input).includes("/live/stream")) {
          return Response.json({
            schema_version: "tracegraph.session-event.v1",
            projector_version: PROJECTOR_VERSION,
            project_id: "project-1",
            run_id: "run-1",
            task: "Plan the work",
            mode: "plan",
            workspace_kind: "disposable_fixture",
            status: "awaiting_plan_approval",
            last_sequence: 8,
            timeline: [],
            todos: {
              items: [{
                todo_id: "todo-1",
                title: "Inspect the workspace",
                state: "pending",
                depends_on: [],
                evidence_event_ids: [],
                created_by: "model",
              }],
              last_sequence: 7,
            },
            pending_plan: { plan_event_id: "event-plan-ready", todo_ids: ["todo-1"] },
            artifact_refs: [],
          });
        }
        return new Response(streamFrom([
          "id: live:event-plan-ready\ndata: {\"schema_version\":\"tracegraph.session-event.v1\",\"activity_id\":\"live:event-plan-ready\",\"source_event_id\":\"event-plan-ready\",\"source_event_type\":\"plan.ready\",\"project_id\":\"project-1\",\"run_id\":\"run-1\",\"sequence\":8,\"occurred_at\":\"2026-09-17T00:00:00.000Z\",\"kind\":\"run\",\"status\":\"info\",\"summary\":\"Plan ready for approval\"}\n\n",
        ]), { headers: { "content-type": "text/event-stream" } });
      },
    });

    const activities = [];
    for await (const activity of client.streamLiveActivities("run-1")) activities.push(activity);

    expect(activities).toEqual([expect.objectContaining({ source_event_type: "plan.ready" })]);
    expect(requests).toBe(2);
  });

  it("reconnects when a network EOF follows a historical plan.ready replay", async () => {
    const urls: string[] = [];
    let liveRequests = 0;
    const client = new TraceGraphClient({
      token: "test-token",
      fetch: async (input) => {
        const url = String(input);
        urls.push(url);
        if (!url.includes("/live/stream")) {
          return Response.json({
            schema_version: "tracegraph.session-event.v1",
            projector_version: PROJECTOR_VERSION,
            project_id: "project-1",
            run_id: "run-1",
            task: "Execute the approved plan",
            mode: "execute",
            workspace_kind: "disposable_fixture",
            status: "running",
            last_sequence: 9,
            timeline: [],
            todos: { items: [], last_sequence: 0 },
            artifact_refs: [],
          });
        }
        liveRequests += 1;
        if (liveRequests === 1) {
          return new Response(streamFrom([
            "id: live:event-plan-ready\ndata: {\"schema_version\":\"tracegraph.session-event.v1\",\"activity_id\":\"live:event-plan-ready\",\"source_event_id\":\"event-plan-ready\",\"source_event_type\":\"plan.ready\",\"project_id\":\"project-1\",\"run_id\":\"run-1\",\"sequence\":8,\"occurred_at\":\"2026-09-17T00:00:00.000Z\",\"kind\":\"run\",\"status\":\"info\",\"summary\":\"Historical plan ready\"}\n\n",
          ]), { headers: { "content-type": "text/event-stream" } });
        }
        return new Response(streamFrom([
          "id: live:event-plan-approved\ndata: {\"schema_version\":\"tracegraph.session-event.v1\",\"activity_id\":\"live:event-plan-approved\",\"source_event_id\":\"event-plan-approved\",\"source_event_type\":\"plan.approved\",\"project_id\":\"project-1\",\"run_id\":\"run-1\",\"sequence\":9,\"occurred_at\":\"2026-09-17T00:00:01.000Z\",\"kind\":\"run\",\"status\":\"started\",\"summary\":\"Plan approved\"}\n\n",
          "id: live:event-terminal\ndata: {\"schema_version\":\"tracegraph.session-event.v1\",\"activity_id\":\"live:event-terminal\",\"source_event_id\":\"event-terminal\",\"source_event_type\":\"run.completed\",\"project_id\":\"project-1\",\"run_id\":\"run-1\",\"sequence\":10,\"occurred_at\":\"2026-09-17T00:00:02.000Z\",\"kind\":\"run\",\"status\":\"completed\",\"summary\":\"Run completed\"}\n\n",
        ]), { headers: { "content-type": "text/event-stream" } });
      },
    });

    const activities = [];
    for await (const activity of client.streamLiveActivities("run-1")) activities.push(activity);

    expect(activities.map(({ source_event_type: type }) => type)).toEqual([
      "plan.ready",
      "plan.approved",
      "run.completed",
    ]);
    expect(liveRequests).toBe(2);
    expect(urls).toContain("http://127.0.0.1:4311/api/runs/run-1/live/stream?after_sequence=8");
  });

  it("continues past historical plan.ready activity to execute-stage activity and terminal completion", async () => {
    let requests = 0;
    const client = new TraceGraphClient({
      token: "test-token",
      fetch: async () => {
        requests += 1;
        return new Response(streamFrom([
          "id: live:event-plan-ready\ndata: {\"schema_version\":\"tracegraph.session-event.v1\",\"activity_id\":\"live:event-plan-ready\",\"source_event_id\":\"event-plan-ready\",\"source_event_type\":\"plan.ready\",\"project_id\":\"project-1\",\"run_id\":\"run-1\",\"sequence\":8,\"occurred_at\":\"2026-09-17T00:00:00.000Z\",\"kind\":\"run\",\"status\":\"info\",\"summary\":\"Historical plan ready\"}\n\n",
          "id: live:event-plan-approved\ndata: {\"schema_version\":\"tracegraph.session-event.v1\",\"activity_id\":\"live:event-plan-approved\",\"source_event_id\":\"event-plan-approved\",\"source_event_type\":\"plan.approved\",\"project_id\":\"project-1\",\"run_id\":\"run-1\",\"sequence\":9,\"occurred_at\":\"2026-09-17T00:00:01.000Z\",\"kind\":\"run\",\"status\":\"started\",\"summary\":\"Plan approved\"}\n\n",
          "id: live:event-tool\ndata: {\"schema_version\":\"tracegraph.session-event.v1\",\"activity_id\":\"live:event-tool\",\"source_event_id\":\"event-tool\",\"source_event_type\":\"tool.started\",\"project_id\":\"project-1\",\"run_id\":\"run-1\",\"sequence\":10,\"occurred_at\":\"2026-09-17T00:00:02.000Z\",\"kind\":\"tool\",\"status\":\"started\",\"summary\":\"Execute-stage tool started\"}\n\n",
          "id: live:event-terminal\ndata: {\"schema_version\":\"tracegraph.session-event.v1\",\"activity_id\":\"live:event-terminal\",\"source_event_id\":\"event-terminal\",\"source_event_type\":\"run.completed\",\"project_id\":\"project-1\",\"run_id\":\"run-1\",\"sequence\":11,\"occurred_at\":\"2026-09-17T00:00:03.000Z\",\"kind\":\"run\",\"status\":\"completed\",\"summary\":\"Run completed\"}\n\n",
        ]), { headers: { "content-type": "text/event-stream" } });
      },
    });

    const activities = [];
    for await (const activity of client.streamLiveActivities("run-1")) activities.push(activity);

    expect(activities.map(({ source_event_type: type }) => type)).toEqual([
      "plan.ready",
      "plan.approved",
      "tool.started",
      "run.completed",
    ]);
    expect(requests).toBe(1);
  });

  it("stops reconnecting when Action reconciliation requires manual review", async () => {
    let requests = 0;
    const client = new TraceGraphClient({
      token: "test-token",
      fetch: async () => {
        requests += 1;
        return new Response(streamFrom([
          "id: live:event-diverged\ndata: {\"schema_version\":\"tracegraph.session-event.v1\",\"activity_id\":\"live:event-diverged\",\"source_event_id\":\"event-diverged\",\"source_event_type\":\"action.diverged\",\"project_id\":\"project-1\",\"run_id\":\"run-1\",\"sequence\":10,\"occurred_at\":\"2026-09-17T00:00:00.000Z\",\"kind\":\"run\",\"status\":\"failed\",\"summary\":\"Workspace hash diverged\"}\n\n",
        ]), { headers: { "content-type": "text/event-stream" } });
      },
    });

    const activities = [];
    for await (const activity of client.streamLiveActivities("run-1")) activities.push(activity);

    expect(activities).toEqual([expect.objectContaining({ source_event_type: "action.diverged" })]);
    expect(requests).toBe(1);
  });

  it("joins multiple data lines", async () => {
    const values: string[] = [];
    for await (const value of parseSseData(
      streamFrom(["data: first\ndata: second\n\n"]),
    )) {
      values.push(value);
    }
    expect(values).toEqual(["first\nsecond"]);
  });

  it("preserves a non-JSON HTTP error body", async () => {
    const client = new TraceGraphClient({
      token: "test-token",
      fetch: async () => new Response("proxy unavailable", { status: 502 }),
    });

    await expect(client.listProjects()).rejects.toEqual(
      expect.objectContaining<Partial<TraceGraphHttpError>>({
        status: 502,
        body: "proxy unavailable",
      }),
    );
  });

  it("parses safe credential metadata from the canonical model-config response", async () => {
    const client = new TraceGraphClient({
      token: "test-token",
      fetch: async () => Response.json({
        provider: "openai",
        protocol: "openai-chat-completions",
        configured: true,
        base_url: "https://api.openai.com/v1",
        model: "gpt-4.1-mini",
        has_key: true,
        credential: {
          name: "OPENAI_API_KEY",
          backend: "macos_keychain",
          writable: true,
          last_updated_at: "2026-09-18T00:00:00.000Z",
        },
      }),
    });

    await expect(client.getModelConfig()).resolves.toMatchObject({
      has_key: true,
      credential: {
        name: "OPENAI_API_KEY",
        backend: "macos_keychain",
        writable: true,
      },
    });
  });

  it("rejects a model-config response that contains a plaintext API key", async () => {
    const client = new TraceGraphClient({
      token: "test-token",
      fetch: async () => Response.json({
        provider: "openai",
        protocol: "openai-chat-completions",
        configured: true,
        base_url: "https://api.openai.com/v1",
        model: "gpt-4.1-mini",
        has_key: true,
        credential: {
          name: "OPENAI_API_KEY",
          backend: "private_file",
          writable: true,
        },
        api_key: "must-never-be-accepted",
      }),
    });

    await expect(client.getModelConfig()).rejects.toThrow();
  });

  it("reads only the strict telemetry status and rejects Host-only configuration fields", async () => {
    const requests: string[] = [];
    const client = new TraceGraphClient({
      token: "test-token",
      fetch: async (input, init) => {
        requests.push(`${init?.method ?? "GET"} ${String(input)}`);
        return Response.json({
          schema_version: "tracegraph.telemetry-status.v1",
          sink: "otlp_http",
          state: "degraded",
          error_count: 4,
          last_error_at: "2026-09-19T06:00:00.000Z",
        });
      },
    });

    await expect(client.getTelemetryStatus()).resolves.toEqual({
      schema_version: "tracegraph.telemetry-status.v1",
      sink: "otlp_http",
      state: "degraded",
      error_count: 4,
      last_error_at: "2026-09-19T06:00:00.000Z",
    });
    expect(requests).toEqual(["GET http://127.0.0.1:4311/api/telemetry-status"]);

    const leakingClient = new TraceGraphClient({
      token: "test-token",
      fetch: async () => Response.json({
        schema_version: "tracegraph.telemetry-status.v1",
        sink: "otlp_http",
        state: "active",
        error_count: 0,
        endpoint: "https://collector.example.test/v1/traces",
        headers: { authorization: "Bearer secret" },
      }),
    });
    await expect(leakingClient.getTelemetryStatus()).rejects.toThrow();
  });

  it("lists, reloads, and invokes extensions with strict parsing and stable command ids", async () => {
    const calls: Array<{ url: string; body?: unknown; commandId: string | null }> = [];
    const status = {
      name: "@tracegraph/builtin-artifact-tools",
      api_version: "tracegraph.extension.v1",
      state: "active",
      registration_count: 2,
      generation: 1,
      updated_at: "2026-09-19T06:00:00.000Z",
    } as const;
    let rejectedOnce = false;
    const client = new TraceGraphClient({
      token: "expired-token",
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/bootstrap")) {
          return Response.json({ token: "fresh-token", expiresAt: "2026-09-19T12:00:00.000Z" });
        }
        const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
        calls.push({
          url,
          ...(body === undefined ? {} : { body }),
          commandId: new Headers(init?.headers).get("x-tracegraph-command-id"),
        });
        if (url.endsWith("/api/extensions/reload") && !rejectedOnce) {
          rejectedOnce = true;
          return Response.json({ error: "capability_invalid" }, { status: 401 });
        }
        if (url.includes("/api/extensions/commands/")) {
          return Response.json({
            command_id: body.command_id,
            name: body.name,
            status: "success",
            summary: "2 artifacts available",
          });
        }
        return Response.json(url.endsWith("/api/extensions") ? [status] : status);
      },
    });

    await expect(client.listExtensions()).resolves.toEqual([status]);
    await expect(client.reloadExtension(status.name, {
      command_id: "command:extension:reload",
    })).resolves.toEqual(status);
    await expect(client.runExtensionCommand("artifacts.list", {
      command_id: "command:extension:run",
      args: ["--limit", "2"],
    })).resolves.toMatchObject({ status: "success", summary: "2 artifacts available" });
    const reloadCalls = calls.filter(({ url }) => url.endsWith("/api/extensions/reload"));
    expect(reloadCalls).toHaveLength(2);
    expect(reloadCalls[0]?.commandId).toBe("command:extension:reload");
    expect(reloadCalls[1]?.commandId).toBe("command:extension:reload");
    expect(calls.at(-1)).toMatchObject({
      url: "http://127.0.0.1:4311/api/extensions/commands/artifacts.list",
      commandId: "command:extension:run",
      body: { command_id: "command:extension:run", name: "artifacts.list", args: ["--limit", "2"] },
    });

    const leakingClient = new TraceGraphClient({
      token: "test-token",
      fetch: async () => Response.json([{ ...status, module: "/tmp/untrusted.mjs" }]),
    });
    await expect(leakingClient.listExtensions()).rejects.toThrow();
  });

  it("reads MCP server status and sends an idempotent restart command", async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    const status = {
      name: "filesystem",
      required: false,
      transport: "stdio",
      state: "degraded",
      tool_count: 0,
      tools: [],
      updated_at: "2026-09-19T06:00:00.000Z",
      error_code: "mcp_spawn_failed",
      error_message: "not found",
    };
    const client = new TraceGraphClient({
      token: "test-token",
      fetch: async (input, init) => {
        const url = String(input);
        const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
        requests.push({ url, ...(body === undefined ? {} : { body }) });
        return Response.json(url.endsWith("/api/mcp")
          ? { config_version: "tracegraph.mcp.v1", servers: [status], updated_at: status.updated_at }
          : { ...status, state: "ready", error_code: undefined, error_message: undefined });
      },
    });
    await expect(client.getMcpStatus()).resolves.toMatchObject({
      servers: [{ name: "filesystem", state: "degraded" }],
    });
    await expect(client.restartMcpServer("filesystem", { command_id: "command:mcp:restart" })).resolves.toMatchObject({
      name: "filesystem",
      state: "ready",
    });
    expect(requests).toEqual([
      { url: "http://127.0.0.1:4311/api/mcp" },
      {
        url: "http://127.0.0.1:4311/api/mcp/restart/filesystem",
        body: { command_id: "command:mcp:restart" },
      },
    ]);
  });

  it("validates model updates before sending the write-only key", async () => {
    let body: unknown;
    const client = new TraceGraphClient({
      token: "test-token",
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json({
          provider: "openai",
          protocol: "openai-chat-completions",
          configured: true,
          base_url: "https://api.openai.com/v1",
          model: "gpt-4.1-mini",
          has_key: true,
          credential: {
            name: "OPENAI_API_KEY",
            backend: "private_file",
            writable: true,
          },
        });
      },
    });

    const result = await client.configureModel({
      provider: "openai",
      protocol: "openai-chat-completions",
      base_url: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      api_key: "secret-value",
    });

    expect(body).toMatchObject({ api_key: "secret-value" });
    expect(result).not.toHaveProperty("api_key");
    await expect(client.configureModel({
      provider: "openai",
      protocol: "openai-chat-completions",
      base_url: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      api_key: "short",
    })).rejects.toThrow();
  });

  it("gets and configures a permission preset through the canonical bounded contract", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown; commandId: string | null }> = [];
    const response = {
      active_preset: "read-only",
      sandbox_mode: "read-only",
      approval_policy: "never",
      policy_digest: `sha256:${"a".repeat(64)}`,
      ceiling: "workspace-write",
      available_presets: [
        {
          key: "read-only",
          label: "Read only",
          sandbox_mode: "read-only",
          approval_policy: "never",
        },
        {
          key: "workspace-write",
          label: "Workspace write",
          sandbox_mode: "workspace-write",
          approval_policy: "on-write",
        },
      ],
      source: "user-config",
      locked: false,
    } as const;
    const client = new TraceGraphClient({
      token: "test-token",
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
          ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
          commandId: new Headers(init?.headers).get("x-tracegraph-command-id"),
        });
        return Response.json(response);
      },
    });

    await expect(client.getPermissionConfig()).resolves.toEqual(response);
    await expect(client.configurePermissionPreset({
      command_id: "command:permission:read-only",
      preset_key: "read-only",
    })).resolves.toEqual(response);
    expect(requests).toEqual([
      expect.objectContaining({ url: "http://127.0.0.1:4311/api/permission-config", method: "GET" }),
      expect.objectContaining({
        url: "http://127.0.0.1:4311/api/permission-config",
        method: "POST",
        commandId: "command:permission:read-only",
        body: { command_id: "command:permission:read-only", preset_key: "read-only" },
      }),
    ]);
  });

  it("rejects custom/expanded permission updates and leaking settings responses", async () => {
    const client = new TraceGraphClient({
      token: "test-token",
      fetch: async () => Response.json({
        active_preset: "workspace-write",
        sandbox_mode: "workspace-write",
        approval_policy: "on-write",
        policy_digest: `sha256:${"b".repeat(64)}`,
        ceiling: "workspace-write",
        available_presets: [{
          key: "workspace-write",
          label: "Workspace write",
          sandbox_mode: "workspace-write",
          approval_policy: "on-write",
        }],
        source: "default",
        locked: false,
        path_scope: ["**"],
      }),
    });

    await expect(client.getPermissionConfig()).rejects.toThrow();
    await expect(client.configurePermissionPreset({
      preset_key: "custom",
    } as never)).rejects.toThrow();
    await expect(client.configurePermissionPreset({
      preset_key: "read-only",
      sandbox_mode: "danger-full-access",
    } as never)).rejects.toThrow();
  });

  it("uses canonical contracts for session browsing, rename, soft delete, and resume", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const header = {
      kind: "header" as const,
      session_version: 1 as const,
      session_id: "session-one",
      project_id: "project-one",
      created_at: "2026-09-18T00:00:00.000Z",
      title: "Investigate checkout",
      run_ids: ["run-one"],
    };
    const client = new TraceGraphClient({
      token: "test-token",
      fetch: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
        requests.push({ url, method, ...(body === undefined ? {} : { body }) });
        if (method === "DELETE") return Response.json({ session_id: "session-one", deleted: true });
        if (url.endsWith("/resume")) return Response.json({
          session_id: "session-one",
          project_id: "project-one",
          run_id: "run-one",
          status: "resumed",
          resumed_at: "2026-09-18T00:05:00.000Z",
        });
        if (method === "PATCH") return Response.json({ header: { ...header, title: "Renamed" }, entries: [], truncated: false });
        if (url.includes("/api/sessions/session-one")) return Response.json({ header, entries: [], truncated: false });
        return Response.json({
          sessions: [{
            session_id: "session-one",
            project_id: "project-one",
            created_at: header.created_at,
            updated_at: "2026-09-18T00:04:00.000Z",
            title: header.title,
            run_ids: header.run_ids,
            entry_count: 2,
          }],
        });
      },
    });

    await expect(client.listSessions({ project_id: "project-one", q: "checkout", limit: 20 })).resolves.toMatchObject({ sessions: [{ session_id: "session-one" }] });
    await expect(client.getSession("session-one")).resolves.toMatchObject({ header: { session_id: "session-one" } });
    await expect(client.renameSession("session-one", { title: "Renamed" })).resolves.toMatchObject({ header: { title: "Renamed" } });
    await expect(client.deleteSession("session-one")).resolves.toEqual({ session_id: "session-one", deleted: true });
    await expect(client.resumeSession("session-one", { command_id: "command-resume" })).resolves.toMatchObject({ status: "resumed", run_id: "run-one" });

    expect(requests.map(({ method }) => method)).toEqual(["GET", "GET", "PATCH", "DELETE", "POST"]);
    const listUrl = new URL(requests[0]?.url ?? "http://invalid");
    expect(Object.fromEntries(listUrl.searchParams)).toEqual({ limit: "20", view: "roots", project_id: "project-one", q: "checkout" });
    expect(requests[2]?.body).toEqual({ title: "Renamed" });
    expect(requests[4]?.body).toEqual({ command_id: "command-resume" });
  });

  it("calls the canonical Action rollback route without client-selected project authority", async () => {
    let request: { url: string; method: string; commandId: string | null; body: unknown } | undefined;
    const client = new TraceGraphClient({
      token: "test-token",
      fetch: async (input, init) => {
        request = {
          url: String(input),
          method: init?.method ?? "GET",
          commandId: new Headers(init?.headers).get("x-tracegraph-command-id"),
          body: JSON.parse(String(init?.body)),
        };
        return Response.json({
          schema_version: "tracegraph.session-event.v1",
          projector_version: PROJECTOR_VERSION,
          project_id: "project-one",
          run_id: "run:one",
          task: "Apply a safe patch",
          mode: "execute",
          workspace_kind: "disposable_fixture",
          status: "completed",
          last_sequence: 3,
          timeline: [],
          artifact_refs: [],
        });
      },
    });

    await expect(client.rollbackAction("run:one", "action/patch", {
      command_id: "command-rollback",
      force: true,
    })).resolves.toMatchObject({ run_id: "run:one" });

    expect(request).toEqual({
      url: "http://127.0.0.1:4311/api/runs/run%3Aone/actions/action%2Fpatch/rollback",
      method: "POST",
      commandId: "command-rollback",
      body: { command_id: "command-rollback", force: true },
    });
  });

  it("parses the canonical startup recovery report", async () => {
    const client = new TraceGraphClient({
      fetch: async () => Response.json({
        token: "node-token",
        expiresAt: "2026-09-18T01:00:00.000Z",
        recovery: {
          scanned_sessions: 3,
          truncated_session_ids: ["session-truncated"],
          interrupted_run_ids: ["run-interrupted"],
          recovered_at: "2026-09-18T00:00:00.000Z",
        },
      }),
    });

    await expect(client.bootstrap()).resolves.toMatchObject({
      recovery: { scanned_sessions: 3, interrupted_run_ids: ["run-interrupted"] },
    });
  });

  it("sends the selected reasoning effort as part of the canonical start request", async () => {
    let requestBody: unknown;
    const client = new TraceGraphClient({
      token: "test-token",
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return Response.json({
          schema_version: "tracegraph.session-event.v1",
          projector_version: PROJECTOR_VERSION,
          project_id: "project:reasoning",
          run_id: "run:reasoning",
          task: "Inspect",
          mode: "plan",
          reasoning_effort: "xhigh",
          workspace_kind: "readonly_local",
          status: "running",
          last_sequence: 0,
          timeline: [],
          artifact_refs: [],
        });
      },
    });

    await client.startRun({
      command_id: "command:reasoning",
      project_id: "project:reasoning",
      task: "Inspect",
      mode: "plan",
      reasoning_effort: "xhigh",
    });

    expect(requestBody).toMatchObject({ reasoning_effort: "xhigh" });
  });

  it("adds the Host-approved loopback Origin for Node bootstrap by default", async () => {
    let receivedOrigin: string | null = null;
    const client = new TraceGraphClient({
      fetch: async (_input, init) => {
        receivedOrigin = new Headers(init?.headers).get("origin");
        return Response.json({
          token: "node-token",
          expiresAt: "2026-09-17T12:00:00.000Z",
        });
      },
    });

    await expect(client.bootstrap()).resolves.toMatchObject({ token: "node-token" });
    expect(receivedOrigin).toBe("http://127.0.0.1:4310");
  });

  it("allows an explicit Node origin without accepting paths or credentials", async () => {
    let receivedOrigin: string | null = null;
    const client = new TraceGraphClient({
      nodeOrigin: "http://localhost:4310/",
      fetch: async (_input, init) => {
        receivedOrigin = new Headers(init?.headers).get("origin");
        return Response.json({
          token: "node-token",
          expiresAt: "2026-09-17T12:00:00.000Z",
        });
      },
    });

    await client.bootstrap();
    expect(receivedOrigin).toBe("http://localhost:4310");
    expect(() => new TraceGraphClient({ nodeOrigin: "http://user:pass@localhost:4310" })).toThrow(
      /without credentials/u,
    );
    expect(() => new TraceGraphClient({ nodeOrigin: "http://localhost:4310/path" })).toThrow(
      /without credentials/u,
    );
  });

  it("refreshes an invalid capability token once and retries the rejected request", async () => {
    const authorizations: Array<string | null> = [];
    let bootstrapCalls = 0;
    const client = new TraceGraphClient({
      token: "expired-token",
      fetch: async (input, init) => {
        const url = String(input);
        authorizations.push(new Headers(init?.headers).get("authorization"));
        if (url.endsWith("/api/bootstrap")) {
          bootstrapCalls += 1;
          return Response.json({ token: "fresh-token", expiresAt: "2026-09-17T12:00:00.000Z" });
        }
        if (new Headers(init?.headers).get("authorization") === "Bearer expired-token") {
          return Response.json({ message: "Capability token is invalid" }, { status: 401 });
        }
        return Response.json([]);
      },
    });

    await expect(client.listProjects()).resolves.toEqual([]);
    expect(bootstrapCalls).toBe(1);
    expect(authorizations).toEqual(["Bearer expired-token", null, "Bearer fresh-token"]);
  });

  it("keeps a command id stable when retrying after capability refresh", async () => {
    const commandIds: string[] = [];
    const client = new TraceGraphClient({
      token: "expired-token",
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/bootstrap")) {
          return Response.json({ token: "fresh-token", expiresAt: "2026-09-17T12:00:00.000Z" });
        }
        commandIds.push(new Headers(init?.headers).get("x-tracegraph-command-id") ?? "");
        if (commandIds.length === 1) {
          return Response.json({ message: "Capability token is invalid" }, { status: 401 });
        }
        return Response.json({
          project_id: "project:retry",
          label: "retry",
          workspace_kind: "managed_local",
          capabilities: { index: true, read: true, search: true, run_command: true, preview_patch: true, commit_patch: true, test: true },
        });
      },
    });

    await expect(client.createProject({ name: "retry" })).resolves.toMatchObject({ project_id: "project:retry" });
    expect(commandIds).toHaveLength(2);
    expect(commandIds[0]).toBeTruthy();
    expect(commandIds[1]).toBe(commandIds[0]);
  });

  it("opens and reveals Host-owned project locations without sending a filesystem path", async () => {
    const requests: Array<{ url: string; body: unknown; commandId: string | null }> = [];
    const client = new TraceGraphClient({
      token: "test-token",
      fetch: async (input, init) => {
        const url = String(input);
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        requests.push({
          url,
          body,
          commandId: new Headers(init?.headers).get("x-tracegraph-command-id"),
        });
        if (url.endsWith("/reveal") || url.endsWith("/remove")) return new Response(null, { status: 204 });
        return Response.json({
          project_id: "project:linked",
          label: "linked",
          workspace_kind: "managed_local",
          capabilities: {
            index: true,
            read: true,
            search: true,
            run_command: true,
            preview_patch: true,
            commit_patch: true,
            test: true,
          },
          location: {
            kind: "linked_directory",
            display_path: "/Users/example/linked",
            can_reveal: true,
            access: "read_write",
          },
        });
      },
    });

    await expect(client.openLocalProject({
      access: "read_write",
      command_id: "command-open",
    })).resolves.toMatchObject({ project_id: "project:linked" });
    await expect(client.revealProject("project:linked", "command-reveal")).resolves.toBeUndefined();
    await expect(client.removeProject("project:linked", "command-remove")).resolves.toBeUndefined();
    expect(requests[0]).toMatchObject({
      body: { command_id: "command-open", access: "read_write" },
      commandId: "command-open",
    });
    expect(JSON.stringify(requests[0]?.body)).not.toContain("/Users/example");
    expect(requests[1]).toMatchObject({
      body: { command_id: "command-reveal" },
      commandId: "command-reveal",
    });
    expect(requests[2]).toMatchObject({
      url: expect.stringContaining("/projects/project%3Alinked/remove"),
      body: { command_id: "command-remove" },
      commandId: "command-remove",
    });
  });

  it("starts a project-free chat through the dedicated Host endpoint", async () => {
    let request: { url: string; body: unknown } | undefined;
    const client = new TraceGraphClient({
      token: "test-token",
      fetch: async (input, init) => {
        request = {
          url: String(input),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        };
        return Response.json({
          schema_version: "tracegraph.session-event.v1",
          projector_version: PROJECTOR_VERSION,
          project_id: "chat:local",
          run_id: "run-chat",
          task: "Explain memory",
          mode: "plan",
          workspace_kind: "readonly_local",
          status: "running",
          last_sequence: 0,
          timeline: [],
          artifact_refs: [],
        });
      },
    });

    await expect(client.startChat({
      command_id: "command-chat",
      task: "Explain memory",
      reasoning_effort: "medium",
    })).resolves.toMatchObject({ project_id: "chat:local", run_id: "run-chat" });
    expect(request).toEqual({
      url: "http://127.0.0.1:4311/api/chat/runs",
      body: {
        command_id: "command-chat",
        task: "Explain memory",
        reasoning_effort: "medium",
      },
    });
  });

  it("stages reusable raw attachment bytes with a scope-bound command", async () => {
    let request: { url: string; headers: Headers; bytes: Uint8Array } | undefined;
    const client = new TraceGraphClient({
      token: "test-token",
      fetch: async (input, init) => {
        request = {
          url: String(input),
          headers: new Headers(init?.headers),
          bytes: new Uint8Array(init?.body as ArrayBuffer),
        };
        return Response.json({
          status: "accepted",
          upload_id: "upload:image-one",
          source: "user_upload",
          delivery: "inline",
          bytes: 4,
          expires_at: "2026-09-17T12:00:00.000Z",
          media_type: "image/png",
          sha256: `sha256:${"a".repeat(64)}`,
        }, { status: 201 });
      },
    });

    await expect(client.uploadAttachment({
      command_id: "command:upload-one",
      target: "project",
      project_id: "project:one",
      declared_media_type: "image/png",
      delivery: "inline",
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    })).resolves.toMatchObject({ status: "accepted", upload_id: "upload:image-one" });

    expect(request?.url).toContain("/api/attachments?");
    expect(request?.url).toContain("target=project");
    expect(request?.url).toContain("project_id=project%3Aone");
    expect(request?.headers.get("authorization")).toBe("Bearer test-token");
    expect(request?.headers.get("content-type")).toBe("application/octet-stream");
    expect(request?.headers.get("x-tracegraph-command-id")).toBe("command:upload-one");
    expect([...request!.bytes]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("reuses attachment bytes and command identity after one capability refresh", async () => {
    const attempts: Array<{ commandId: string | null; bytes: number[] }> = [];
    const client = new TraceGraphClient({
      token: "expired-token",
      fetch: async (input, init) => {
        if (String(input).endsWith("/api/bootstrap")) {
          return Response.json({ token: "fresh-token", expiresAt: "2026-09-17T12:00:00.000Z" });
        }
        attempts.push({
          commandId: new Headers(init?.headers).get("x-tracegraph-command-id"),
          bytes: [...new Uint8Array(init?.body as ArrayBuffer)],
        });
        if (attempts.length === 1) {
          return Response.json({ error: "capability_invalid", message: "expired" }, { status: 401 });
        }
        return Response.json({
          status: "accepted",
          upload_id: "upload:retry",
          source: "user_upload",
          delivery: "offload",
          bytes: 3,
          expires_at: "2026-09-17T12:00:00.000Z",
          media_type: "image/jpeg",
          sha256: `sha256:${"c".repeat(64)}`,
        }, { status: 201 });
      },
    });

    await client.uploadAttachment({
      command_id: "command:upload-retry",
      target: "project",
      project_id: "project:retry",
      declared_media_type: "image/jpeg",
      bytes: new Uint8Array([0xff, 0xd8, 0xff]),
    });

    expect(attempts).toEqual([
      { commandId: "command:upload-retry", bytes: [0xff, 0xd8, 0xff] },
      { commandId: "command:upload-retry", bytes: [0xff, 0xd8, 0xff] },
    ]);
  });

  it("fetches attachment content with bearer auth and validates binary metadata", async () => {
    let request: { url: string; authorization: string | null; accept: string | null } | undefined;
    const sha256 = `sha256:${"b".repeat(64)}`;
    const client = new TraceGraphClient({
      token: "test-token",
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        request = {
          url: String(input),
          authorization: headers.get("authorization"),
          accept: headers.get("accept"),
        };
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: {
            "content-type": "image/png",
            "x-tracegraph-content-sha256": sha256,
          },
        });
      },
    });

    await expect(client.getAttachmentContent("run:one", "attachment:one")).resolves.toEqual({
      attachmentId: "attachment:one",
      mediaType: "image/png",
      sha256,
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(request).toEqual({
      url: "http://127.0.0.1:4311/api/runs/run%3Aone/attachments/attachment%3Aone/content",
      authorization: "Bearer test-token",
      accept: "image/png,image/jpeg,application/pdf",
    });
  });

  it("switches the single client to replay authority and restores live authority only on exit", async () => {
    const requests: Array<{ url: string; method: string; authorization: string | null }> = [];
    const client = new TraceGraphClient({
      token: "live-token",
      fetch: async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        const authorization = headers.get("authorization");
        requests.push({ url, method: init?.method ?? "GET", authorization });
        if (url.endsWith("/api/replay")) {
          return Response.json(replaySessionResponse("replay-token-with-at-least-32-bytes"));
        }
        if (url.includes("/api/replay/diff")) return Response.json(replaySameDiff);
        if (authorization?.includes("replay-token")) {
          return Response.json(
            { error: "replay_read_only", message: "Replay capability is read-only" },
            { status: 403 },
          );
        }
        return Response.json(replayProjection);
      },
    });

    const replay = await client.createReplay({
      session_id: "session-one",
      run_id: "run-one",
      until_sequence: 1,
    });
    expect(replay.snapshot.until_sequence).toBe(1);
    expect(client.replayActive).toBe(true);
    expect(client.token).toBe("replay-token-with-at-least-32-bytes");

    await expect(client.getReplayDiff({ from: 1, to: 1 })).resolves.toEqual(replaySameDiff);
    await expect(client.startRun({
      command_id: "command-replay-write",
      project_id: "project-one",
      task: "This must remain blocked",
      mode: "plan",
    })).rejects.toMatchObject({ status: 403 });

    client.exitReplay();
    expect(client.replayActive).toBe(false);
    expect(client.token).toBe("live-token");
    await expect(client.startRun({
      command_id: "command-live-write",
      project_id: "project-one",
      task: "Live work may continue",
      mode: "plan",
    })).resolves.toMatchObject({ run_id: "run-one" });

    expect(requests[0]).toMatchObject({
      url: "http://127.0.0.1:4311/api/replay",
      method: "POST",
      authorization: "Bearer live-token",
    });
    expect(requests[1]?.url).toBe(
      "http://127.0.0.1:4311/api/replay/diff?session_id=session-one&run_id=run-one&from=1&to=1",
    );
    expect(requests[1]?.authorization).toBe("Bearer replay-token-with-at-least-32-bytes");
    expect(requests.at(-1)?.authorization).toBe("Bearer live-token");
  });

  it("does not let a late replay response reverse an explicit exit", async () => {
    let markRequested = (): void => undefined;
    const requested = new Promise<void>((resolve) => {
      markRequested = resolve;
    });
    let resolveReplay = (_response: Response): void => undefined;
    const replayResponse = new Promise<Response>((resolve) => {
      resolveReplay = resolve;
    });
    const client = new TraceGraphClient({
      token: "live-token",
      fetch: async (input) => {
        if (!String(input).endsWith("/api/replay")) throw new Error("Unexpected request");
        markRequested();
        return replayResponse;
      },
    });

    const entering = client.createReplay({
      session_id: "session-one",
      run_id: "run-one",
      until_sequence: 1,
    });
    await requested;
    client.exitReplay();
    resolveReplay(Response.json(replaySessionResponse("late-replay-token-with-at-least-32-bytes")));

    await expect(entering).rejects.toThrow("Replay request was superseded");
    expect(client.replayActive).toBe(false);
    expect(client.token).toBe("live-token");
  });

  it("does not bootstrap-upgrade a replay step whose 401 arrives after exit", async () => {
    let replayRequests = 0;
    let bootstrapRequests = 0;
    let markStepRequested = (): void => undefined;
    const stepRequested = new Promise<void>((resolve) => {
      markStepRequested = resolve;
    });
    let resolveStep = (_response: Response): void => undefined;
    const stepResponse = new Promise<Response>((resolve) => {
      resolveStep = resolve;
    });
    const client = new TraceGraphClient({
      token: "live-token",
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/api/replay")) {
          replayRequests += 1;
          if (replayRequests === 1) {
            return Response.json(replaySessionResponse("active-replay-token-with-at-least-32-bytes"));
          }
          markStepRequested();
          return stepResponse;
        }
        if (url.endsWith("/api/bootstrap")) {
          bootstrapRequests += 1;
          return Response.json({
            token: "unexpected-live-token",
            expiresAt: "2026-09-19T08:00:00.000Z",
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });
    await client.createReplay({
      session_id: "session-one",
      run_id: "run-one",
      until_sequence: 1,
    });

    const stepping = client.createReplay({
      session_id: "session-one",
      run_id: "run-one",
      until_sequence: 1,
    });
    await stepRequested;
    client.exitReplay();
    resolveStep(Response.json(
      { error: "capability_expired", message: "Capability token expired" },
      { status: 401 },
    ));

    await expect(stepping).rejects.toMatchObject({ status: 401 });
    expect(bootstrapRequests).toBe(0);
    expect(client.replayActive).toBe(false);
    expect(client.token).toBe("live-token");
  });

  it("does not bootstrap-upgrade a replay read whose 401 arrives after exit", async () => {
    let bootstrapRequests = 0;
    let markDiffRequested = (): void => undefined;
    const diffRequested = new Promise<void>((resolve) => {
      markDiffRequested = resolve;
    });
    let resolveDiff = (_response: Response): void => undefined;
    const diffResponse = new Promise<Response>((resolve) => {
      resolveDiff = resolve;
    });
    const client = new TraceGraphClient({
      token: "live-token",
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/api/replay")) {
          return Response.json(replaySessionResponse("active-replay-token-with-at-least-32-bytes"));
        }
        if (url.includes("/api/replay/diff")) {
          markDiffRequested();
          return diffResponse;
        }
        if (url.endsWith("/api/bootstrap")) {
          bootstrapRequests += 1;
          return Response.json({
            token: "unexpected-live-token",
            expiresAt: "2026-09-19T08:00:00.000Z",
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });
    await client.createReplay({
      session_id: "session-one",
      run_id: "run-one",
      until_sequence: 1,
    });

    const reading = client.getReplayDiff({ from: 1, to: 1 });
    await diffRequested;
    client.exitReplay();
    resolveDiff(Response.json(
      { error: "capability_expired", message: "Capability token expired" },
      { status: 401 },
    ));

    await expect(reading).rejects.toMatchObject({ status: 401 });
    expect(bootstrapRequests).toBe(0);
    expect(client.replayActive).toBe(false);
    expect(client.token).toBe("live-token");
  });

  it("never refreshes an expired replay bearer through the live bootstrap endpoint", async () => {
    let bootstrapRequests = 0;
    let diffRequests = 0;
    const client = new TraceGraphClient({
      token: "live-token",
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/api/replay")) {
          return Response.json(replaySessionResponse("expired-replay-token-with-32-bytes"));
        }
        if (url.includes("/api/replay/diff")) {
          diffRequests += 1;
          return Response.json(
            { error: "capability_expired", message: "Capability token expired" },
            { status: 401 },
          );
        }
        if (url.endsWith("/api/bootstrap")) {
          bootstrapRequests += 1;
          return Response.json({
            token: "unexpected-live-token",
            expiresAt: "2026-09-19T08:00:00.000Z",
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    await client.createReplay({
      session_id: "session-one",
      run_id: "run-one",
      until_sequence: 1,
    });
    await expect(client.getReplayDiff({ from: 1, to: 1 })).rejects.toMatchObject({ status: 401 });
    await expect(client.bootstrap()).rejects.toThrow("Exit replay");
    expect(diffRequests).toBe(1);
    expect(bootstrapRequests).toBe(0);
    expect(client.token).toBe("expired-replay-token-with-32-bytes");
  });
});

describe("G07 subagent reads", () => {
  it("requests the relation-scoped child Run and validates its projection", async () => {
    const requests: string[] = [];
    const childProjection = {
      ...replayProjection,
      session_id: "session-child",
      run_id: "run-child",
      task: "Inspect the delegated files",
    };
    const client = new TraceGraphClient({
      token: "live-token",
      fetch: async (input) => {
        requests.push(String(input));
        return Response.json(childProjection);
      },
    });

    await expect(client.getSubagent("parent/run", "child id")).resolves.toMatchObject({
      session_id: "session-child",
      run_id: "run-child",
    });
    expect(requests).toEqual([
      "http://127.0.0.1:4311/api/runs/parent%2Frun/subagents/child%20id",
    ]);
  });

  it("rejects an invalid child projection at the SDK boundary", async () => {
    const client = new TraceGraphClient({
      token: "live-token",
      fetch: async () => Response.json({ run_id: "run-child" }),
    });

    await expect(client.getSubagent("run-parent", "subagent-child")).rejects.toThrow();
  });
});

describe("G08 team control plane", () => {
  const team = {
    team_id: "team-one",
    coordinator_run_id: "run-root",
    limits: {
      max_parallel_workers: 4,
      heartbeat_timeout_ms: 30_000,
      max_members: 500,
      max_mailbox_messages: 500,
      max_tasks: 500,
    },
    created_event_id: "event-team-created",
    created_at: "2026-09-20T00:00:00.000Z",
    roster: { members: [], last_sequence: 1 },
    mailbox: { messages: [], last_sequence: 1 },
    task_board: { items: [], last_sequence: 1 },
    last_sequence: 1,
  } as const;

  const mutation = (commandId: string) => ({
    command_id: commandId,
    disposition: "applied" as const,
    event_ids: ["event-team-mutation"],
    team,
  });

  it("uses encoded actor paths, strict wire envelopes, and stable command headers", async () => {
    const requests: Array<{
      url: string;
      method: string;
      commandId: string | null;
      body?: unknown;
    }> = [];
    const client = new TraceGraphClient({
      token: "live-token",
      fetch: async (input, init) => {
        const body = init?.body === undefined
          ? undefined
          : JSON.parse(String(init.body)) as { command_id?: string };
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
          commandId: new Headers(init?.headers).get("x-tracegraph-command-id"),
          ...(body === undefined ? {} : { body }),
        });
        return Response.json(body === undefined ? { team } : mutation(body.command_id!));
      },
    });

    await expect(client.getTeam("root/run")).resolves.toEqual({ team });
    await expect(client.createTeam("root/run", { command_id: "command-create" }))
      .resolves.toMatchObject({ command_id: "command-create", team });
    await expect(client.sendTeamMailbox("child/run", {
      command_id: "command-send",
      input: { to: "member-one", kind: "steer", payload: "Check the failing test" },
    })).resolves.toMatchObject({ command_id: "command-send" });
    await expect(client.claimTeamMailbox("child/run", {
      command_id: "command-claim-message",
      input: { message_id: "message-one" },
    })).resolves.toMatchObject({ command_id: "command-claim-message" });
    await expect(client.writeTeamTask("child/run", {
      command_id: "command-claim-task",
      input: { operation: "claim", task_id: "task-one", expected_version: 1 },
    })).resolves.toMatchObject({ command_id: "command-claim-task" });
    await expect(client.heartbeatTeam("child/run", { command_id: "command-heartbeat" }))
      .resolves.toMatchObject({ command_id: "command-heartbeat" });
    await expect(client.sweepLostTeamMembers("root/run", { command_id: "command-sweep" }))
      .resolves.toMatchObject({ command_id: "command-sweep" });

    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:4311/api/runs/root%2Frun/team",
        method: "GET",
        commandId: null,
      },
      {
        url: "http://127.0.0.1:4311/api/runs/root%2Frun/team",
        method: "POST",
        commandId: "command-create",
        body: { command_id: "command-create" },
      },
      {
        url: "http://127.0.0.1:4311/api/runs/child%2Frun/team/mailbox/send",
        method: "POST",
        commandId: "command-send",
        body: {
          command_id: "command-send",
          input: { to: "member-one", kind: "steer", payload: "Check the failing test" },
        },
      },
      {
        url: "http://127.0.0.1:4311/api/runs/child%2Frun/team/mailbox/claim",
        method: "POST",
        commandId: "command-claim-message",
        body: { command_id: "command-claim-message", input: { message_id: "message-one" } },
      },
      {
        url: "http://127.0.0.1:4311/api/runs/child%2Frun/team/tasks/write",
        method: "POST",
        commandId: "command-claim-task",
        body: {
          command_id: "command-claim-task",
          input: { operation: "claim", task_id: "task-one", expected_version: 1 },
        },
      },
      {
        url: "http://127.0.0.1:4311/api/runs/child%2Frun/team/heartbeat",
        method: "POST",
        commandId: "command-heartbeat",
        body: { command_id: "command-heartbeat", input: {} },
      },
      {
        url: "http://127.0.0.1:4311/api/runs/root%2Frun/team/sweep",
        method: "POST",
        commandId: "command-sweep",
        body: { command_id: "command-sweep" },
      },
    ]);
  });

  it("rejects authority injection before transport and invalid responses at the SDK boundary", async () => {
    let requests = 0;
    const client = new TraceGraphClient({
      token: "live-token",
      fetch: async () => {
        requests += 1;
        return Response.json({ team_id: "not-a-read-response" });
      },
    });

    await expect(client.sendTeamMailbox("run-root", {
      input: {
        to: "member-one",
        kind: "steer",
        payload: "Inspect this",
        from: "forged-member",
      },
    } as never)).rejects.toThrow();
    expect(requests).toBe(0);
    await expect(client.getTeam("run-root")).rejects.toThrow();
    expect(requests).toBe(1);
  });

  it("retries a live mutation once with the exact same command id and body", async () => {
    const attempts: Array<{ commandId: string | null; body: string }> = [];
    let rejected = false;
    const client = new TraceGraphClient({
      token: "expired-live-token",
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/bootstrap")) {
          return Response.json({
            token: "fresh-live-token",
            expiresAt: "2026-09-20T08:00:00.000Z",
          });
        }
        attempts.push({
          commandId: new Headers(init?.headers).get("x-tracegraph-command-id"),
          body: String(init?.body),
        });
        if (!rejected) {
          rejected = true;
          return Response.json({ error: "capability_expired" }, { status: 401 });
        }
        return Response.json(mutation("command-retry"));
      },
    });

    await expect(client.writeTeamTask("run-root", {
      command_id: "command-retry",
      input: {
        operation: "create",
        task_id: "task-one",
        title: "Inspect the race",
        acceptance: ["One owner only"],
      },
    })).resolves.toMatchObject({ command_id: "command-retry" });
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
    expect(attempts[0]?.commandId).toBe("command-retry");
  });
});
