import { createHash } from "node:crypto";
import {
  MAX_ATTACHMENT_BYTES,
  PROJECTOR_VERSION,
  READONLY_LOCAL_CAPABILITIES,
  MANAGED_LOCAL_CAPABILITIES,
  SCHEMA_VERSION,
  type LivePublicActivity,
  type PublicModelConfigResponse,
  type ReplayDiff,
  type ReplaySnapshot,
  type RunProjection,
  type SessionReadResult,
  type StartRunInput,
  type TeamProjection,
} from "@tracegraph/contracts";
import { ReplayError, RuntimeCommandError, TodoDomainError, registerSecretForRedaction, type AgentRuntime } from "@tracegraph/core";
import { describe, expect, it, vi } from "vitest";
import { createTraceGraphHost, type HostSessionController } from "./index.js";

const origin = "http://127.0.0.1:4310";
const token = "test-capability-token";
const now = new Date("2026-09-16T00:00:00.000Z");

const startInput: StartRunInput = {
  command_id: "command-start-1",
  project_id: "project-demo",
  task: "Inspect the project without modifying it",
  mode: "plan",
  workspace: {
    handle_id: "workspace-demo",
    project_id: "project-demo",
    real_root: "/tmp/tracegraph-readonly-demo",
    workspace_kind: "readonly_local",
    capabilities: READONLY_LOCAL_CAPABILITIES,
    created_at: now.toISOString(),
  },
};
const startRequest = {
  command_id: startInput.command_id,
  project_id: startInput.project_id,
  task: startInput.task,
  mode: startInput.mode,
} as const;

const projection: RunProjection = {
  schema_version: SCHEMA_VERSION,
  projector_version: PROJECTOR_VERSION,
  project_id: "project-demo",
  session_id: "session-demo",
  run_id: "run-demo",
  task: startInput.task,
  mode: "plan",
  workspace_kind: "readonly_local",
  status: "running",
  last_sequence: 0,
  timeline: [],
  todos: { items: [], last_sequence: 0 },
  attachments: { items: [], last_sequence: 0 },
  artifact_refs: [],
};

const replayHash = `sha256:${"a".repeat(64)}` as const;
const replayArtifact = {
  artifact_id: "artifact-replay",
  kind: "tool_output" as const,
  content_hash: replayHash,
  mime_type: "text/plain",
  byte_length: 6,
  project_id: "project-demo",
  run_id: "run-demo",
  created_at: now.toISOString(),
};
const replayEvents: ReplaySnapshot["projection"]["timeline"] = [
  {
    schema_version: SCHEMA_VERSION,
    event_id: "event-created",
    project_id: "project-demo",
    session_id: "session-demo",
    run_id: "run-demo",
    sequence: 1,
    occurred_at: now.toISOString(),
    type: "run.created",
    summary: "Run created",
    artifact_refs: [],
    data: { task: startInput.task, mode: "plan", workspace_kind: "readonly_local" },
  },
  {
    schema_version: SCHEMA_VERSION,
    event_id: "event-started",
    project_id: "project-demo",
    session_id: "session-demo",
    run_id: "run-demo",
    sequence: 2,
    occurred_at: now.toISOString(),
    type: "run.started",
    summary: "Run started",
    artifact_refs: [replayArtifact],
    data: { phase: "running" },
  },
];

function replaySnapshot(untilSequence = 2, headSequence = 2): ReplaySnapshot {
  const timeline = replayEvents.slice(0, untilSequence);
  return {
    schema_version: "tracegraph.replay-snapshot.v1",
    session_id: "session-demo",
    project_id: "project-demo",
    run_id: "run-demo",
    until_sequence: untilSequence,
    head_sequence: headSequence,
    anchor_event_id: timeline.at(-1)!.event_id,
    anchor_event_hash: replayHash,
    projection: {
      ...projection,
      session_id: "session-demo",
      status: untilSequence === 1 ? "created" : "running",
      last_sequence: untilSequence,
      timeline,
      todos: { items: [], last_sequence: untilSequence },
      artifact_refs: untilSequence >= 2 ? [replayArtifact] : [],
    },
    snapshot_hash: replayHash,
  };
}

function replayDiff(from = 1, to = 2, headSequence = 2): ReplayDiff {
  const forward = from < to;
  const same = from === to;
  return {
    schema_version: "tracegraph.replay-diff.v1",
    session_id: "session-demo",
    project_id: "project-demo",
    run_id: "run-demo",
    head_sequence: headSequence,
    from_sequence: from,
    to_sequence: to,
    direction: same ? "same" : forward ? "forward" : "backward",
    from_snapshot_hash: replayHash,
    to_snapshot_hash: replayHash,
    events: {
      added: forward ? replayEvents.slice(from, to) : [],
      removed: forward || same ? [] : replayEvents.slice(to, from),
    },
    evidence: { added: [], removed: [], changed: [] },
    tool_results: { added: [], removed: [] },
    todos: { added: [], removed: [], changed: [] },
    approval: { changed: false },
    pending_plan: { changed: false },
    ...(same ? {} : { status: { before: from === 1 ? "created" : "running", after: to === 1 ? "created" : "running" } }),
  };
}

function fakeRuntime(telemetryStatus: unknown = {
  schema_version: "tracegraph.telemetry-status.v1",
  sink: "noop",
  state: "disabled",
  error_count: 0,
}): AgentRuntime {
  return {
    getTelemetryStatus: vi.fn(() => telemetryStatus as never),
    flushTelemetry: vi.fn(async () => undefined),
    inspectSkills: vi.fn(async (workspace) => ({
      project_id: workspace.project_id,
      label: "runtime-label",
      registry: {
        registry_digest: `sha256:${"a".repeat(64)}`,
        skills: [],
        conflicts: [],
        diagnostics: [],
      },
    })),
    startRun: vi.fn(async () => projection),
    approvePlan: vi.fn(async () => projection),
    readTodos: vi.fn(async () => projection.todos),
    readTeam: vi.fn(async () => ({})),
    createTeam: vi.fn(async () => { throw new Error("createTeam not configured by this test"); }),
    writeTeamTask: vi.fn(async () => { throw new Error("writeTeamTask not configured by this test"); }),
    writeTeamTaskAsMember: vi.fn(async () => {
      throw new Error("writeTeamTaskAsMember not configured by this test");
    }),
    sendTeamMailbox: vi.fn(async () => { throw new Error("sendTeamMailbox not configured by this test"); }),
    sendTeamMailboxAsMember: vi.fn(async () => {
      throw new Error("sendTeamMailboxAsMember not configured by this test");
    }),
    claimTeamMailbox: vi.fn(async () => { throw new Error("claimTeamMailbox not configured by this test"); }),
    claimTeamMailboxAsMember: vi.fn(async () => {
      throw new Error("claimTeamMailboxAsMember not configured by this test");
    }),
    heartbeatTeamMember: vi.fn(async () => {
      throw new Error("heartbeatTeamMember not configured by this test");
    }),
    expireTeamMembers: vi.fn(async () => {
      throw new Error("expireTeamMembers not configured by this test");
    }),
    writeTodo: vi.fn(async (input) => ({
      todo: {
        todo_id: input.input.todo_id,
        title: "User-updated Todo",
        state: input.input.state ?? "pending",
        depends_on: [],
        evidence_event_ids: input.input.state === "done" ? ["event-user-confirmed"] : [],
        created_by: "model" as const,
      },
      event_type: input.input.state === "done" ? "todo.completed" as const : "todo.updated" as const,
      event_id: "event-todo-updated",
      last_sequence: 3,
    })),
    submitUserInput: vi.fn(async (input) => ({
      disposition: "queued" as const,
      input: {
        input_id: input.input_id,
        run_id: input.run_id,
        kind: input.kind,
        body: input.body,
        actor: "user" as const,
        submitted_at: now.toISOString(),
      },
    })),
    approve: vi.fn(async () => projection),
    reject: vi.fn(async () => projection),
    stop: vi.fn(async () => projection),
    rollback: vi.fn(async () => projection),
    reconcileActions: vi.fn(async () => ({
      runId: projection.run_id,
      reconciledActionIds: [],
      abortedActionIds: [],
      divergedActionIds: [],
    })),
    getProjection: vi.fn(async () => projection),
    subscribe: vi.fn(() => () => undefined),
    subscribeLive: vi.fn(() => () => undefined),
    listLiveActivities: vi.fn(() => []),
    subscribeModelSurface: vi.fn(() => () => undefined),
    listModelSurface: vi.fn(() => []),
    replayAt: vi.fn(async () => { throw new Error("replayAt not configured by this test"); }),
    replayDiff: vi.fn(async () => { throw new Error("replayDiff not configured by this test"); }),
    replay: vi.fn(async () => projection),
    markRunInterrupted: vi.fn(async () => projection),
    resumeRun: vi.fn(async () => projection),
    recordSessionFact: vi.fn(async () => { throw new Error("not used by Host seam tests"); }),
    getArtifact: vi.fn(async ({ artifactId }) => ({
      status: "unavailable" as const,
      artifact_id: artifactId,
      reason: "not_found" as const,
    })),
    stageAttachment: vi.fn(async (input) => ({
      status: "accepted" as const,
      upload_id: "upload:host-test",
      source: input.source ?? "user_upload" as const,
      delivery: input.delivery ?? "offload" as const,
      bytes: input.bytes.byteLength,
      expires_at: "2026-09-16T00:10:00.000Z",
      media_type: "image/png" as const,
      sha256: `sha256:${createHash("sha256").update(input.bytes).digest("hex")}` as const,
    })),
    getAttachmentContent: vi.fn(async () => {
      throw new Error("getAttachmentContent not configured by this test");
    }),
  };
}

function fakeSessions(resumeStatus: "awaiting_approval" | "awaiting_plan_approval" = "awaiting_approval"): HostSessionController {
  let record: SessionReadResult = {
    header: {
      kind: "header",
      session_version: 1,
      session_id: "session-demo",
      project_id: "project-demo",
      created_at: now.toISOString(),
      title: "Demo session",
      run_ids: ["run-demo"],
    },
    entries: [],
    truncated: false,
  };
  return {
    recover: vi.fn(async () => ({
      scanned_sessions: 1,
      truncated_session_ids: [],
      interrupted_run_ids: ["run-demo"],
      recovered_at: now.toISOString(),
    })),
    list: vi.fn(async () => ({
      sessions: [{
        session_id: record.header.session_id,
        project_id: record.header.project_id,
        created_at: record.header.created_at,
        updated_at: now.toISOString(),
        ...(record.header.title === undefined ? {} : { title: record.header.title }),
        run_ids: record.header.run_ids,
        entry_count: record.entries.length,
      }],
    })),
    read: vi.fn(async () => record),
    rename: vi.fn(async (_sessionId, input) => {
      record = { ...record, header: { ...record.header, title: input.title } };
      return record;
    }),
    delete: vi.fn(async (sessionId) => ({ session_id: sessionId, deleted: true as const })),
    resume: vi.fn(async ({ sessionId }) => ({
      session_id: sessionId,
      project_id: record.header.project_id,
      run_id: record.header.run_ids.at(-1) ?? "run-demo",
      status: resumeStatus,
      resumed_at: now.toISOString(),
    })),
  };
}

describe("TraceGraph Host", () => {
  it("configures a model without returning the API Key and registers a created project", async () => {
    let configured: { provider: "openai" | "deepseek" | "glm" | "qwen" | "minimax" | "anthropic" | "custom"; protocol: "openai-chat-completions" | "anthropic-messages"; baseUrl: string; model: string; apiKey?: string } | undefined;
    const workspace = {
      ...startInput.workspace,
      handle_id: "workspace-managed",
      project_id: "project-managed",
      workspace_kind: "managed_local" as const,
      capabilities: MANAGED_LOCAL_CAPABILITIES,
    };
    const remover = vi.fn(async () => undefined);
    const host = await createTraceGraphHost({
      runtime: fakeRuntime(),
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
      projectFactory: async ({ name }) => ({
        label: name,
        workspace,
        location: {
          kind: "managed_storage" as const,
          display_path: "/tmp/tracegraph-managed",
          can_reveal: true,
          access: "read_write" as const,
        },
      }),
      projectRemover: remover,
      modelSettings: {
        get: async () => ({
          provider: "openai",
          protocol: "openai-chat-completions",
          configured: configured !== undefined,
          base_url: configured?.baseUrl ?? "https://api.openai.com/v1",
          model: configured?.model ?? "gpt-4.1-mini",
          has_key: configured !== undefined,
          ...(configured === undefined
            ? {}
            : {
                credential: {
                  name: "OPENAI_API_KEY",
                  backend: "private_file" as const,
                  writable: true,
                  last_updated_at: now.toISOString(),
                },
              }),
        }),
        configure: (input) => { configured = input; },
      },
    });
    const headers = { origin, authorization: `Bearer ${token}`, "x-tracegraph-command-id": "command-settings", "content-type": "application/json" };
    const model = await host.app.inject({ method: "POST", url: "/api/model-config", headers, payload: { provider: "openai", protocol: "openai-chat-completions", base_url: "https://example.test/v1", model: "example-model", api_key: "secret-value" } });
    expect(model.statusCode).toBe(200);
    expect(model.body).not.toContain("secret-value");
    expect(model.json()).toMatchObject({
      configured: true,
      has_key: true,
      credential: {
        name: "OPENAI_API_KEY",
        backend: "private_file",
        writable: true,
        last_updated_at: now.toISOString(),
      },
    });
    expect(model.json()).not.toHaveProperty("api_key");
    expect(configured?.apiKey).toBe("secret-value");
    const modelOnly = await host.app.inject({ method: "POST", url: "/api/model-config", headers: { ...headers, "x-tracegraph-command-id": "command-settings-model-only" }, payload: { provider: "openai", protocol: "openai-chat-completions", base_url: "https://example.test/v1", model: "new-model" } });
    expect(modelOnly.statusCode).toBe(200);
    expect(configured).toMatchObject({ model: "new-model" });
    expect(configured).not.toHaveProperty("apiKey");
    const created = await host.app.inject({ method: "POST", url: "/api/projects", headers, payload: { name: "My Agent", template: "typescript" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ project_id: "project-managed", workspace_kind: "managed_local" });
    const removed = await host.app.inject({
      method: "POST",
      url: "/api/projects/project-managed/remove",
      headers: { ...headers, "x-tracegraph-command-id": "command-remove-managed" },
      payload: { command_id: "command-remove-managed" },
    });
    expect(removed.statusCode).toBe(204);
    expect(remover).toHaveBeenCalledWith(expect.objectContaining({ label: "My Agent" }));
    const projects = await host.app.inject({ method: "GET", url: "/api/projects", headers: { authorization: `Bearer ${token}` } });
    expect(projects.json()).toHaveLength(1);
    await host.close();
  });

  it("rejects a model-settings response containing a plaintext API key", async () => {
    const host = await createTraceGraphHost({
      runtime: fakeRuntime(),
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
      modelSettings: {
        get: async () => ({
          provider: "openai",
          protocol: "openai-chat-completions",
          configured: false,
          base_url: "https://api.openai.com/v1",
          model: "gpt-4.1-mini",
          has_key: false,
          api_key: "must-never-reach-the-browser",
        } as unknown as PublicModelConfigResponse),
        configure: () => undefined,
      },
    });

    const response = await host.app.inject({
      method: "GET",
      url: "/api/model-config",
      headers: { origin, authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("must-never-reach-the-browser");
    expect(response.json()).toMatchObject({ error: "internal_error" });
    await host.close();
  });

  it("exposes read-only telemetry status with a noop default and no configuration route", async () => {
    const defaultHost = await createTraceGraphHost({
      runtime: fakeRuntime(),
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
    });
    const authenticated = { authorization: `Bearer ${token}` };

    const unauthenticated = await defaultHost.app.inject({
      method: "GET",
      url: "/api/telemetry-status",
    });
    expect(unauthenticated.statusCode).toBe(401);

    const defaultStatus = await defaultHost.app.inject({
      method: "GET",
      url: "/api/telemetry-status",
      headers: authenticated,
    });
    expect(defaultStatus.statusCode).toBe(200);
    expect(defaultStatus.headers["cache-control"]).toBe("no-store");
    expect(defaultStatus.json()).toEqual({
      schema_version: "tracegraph.telemetry-status.v1",
      sink: "noop",
      state: "disabled",
      error_count: 0,
    });

    const browserWrite = await defaultHost.app.inject({
      method: "POST",
      url: "/api/telemetry-status",
      headers: {
        ...authenticated,
        origin,
        "content-type": "application/json",
        "x-tracegraph-command-id": "command:telemetry",
      },
      payload: {
        endpoint: "https://collector.example.test/v1/traces",
        headers: { authorization: "Bearer browser-secret" },
      },
    });
    expect(browserWrite.statusCode).toBe(404);
    expect(browserWrite.body).not.toContain("browser-secret");
    await defaultHost.close();

    const configuredHost = await createTraceGraphHost({
      runtime: fakeRuntime({
        schema_version: "tracegraph.telemetry-status.v1",
        sink: "otlp_http",
        state: "degraded",
        error_count: 2,
        last_error_at: now.toISOString(),
      }),
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
    });
    const configuredStatus = await configuredHost.app.inject({
      method: "GET",
      url: "/api/telemetry-status",
      headers: authenticated,
    });
    expect(configuredStatus.statusCode).toBe(200);
    expect(configuredStatus.json()).toEqual({
      schema_version: "tracegraph.telemetry-status.v1",
      sink: "otlp_http",
      state: "degraded",
      error_count: 2,
      last_error_at: now.toISOString(),
    });
    await configuredHost.close();
  });

  it("rejects telemetry status adapters that expose Host-only configuration", async () => {
    const secret = "Bearer telemetry-secret-value";
    const host = await createTraceGraphHost({
      runtime: fakeRuntime({
        schema_version: "tracegraph.telemetry-status.v1",
        sink: "otlp_http",
        state: "active",
        error_count: 0,
        endpoint: "https://collector.example.test/v1/traces",
        headers: { authorization: secret },
      }),
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
    });

    const response = await host.app.inject({
      method: "GET",
      url: "/api/telemetry-status",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(secret);
    expect(response.body).not.toContain("collector.example.test");
    expect(response.json()).toMatchObject({ error: "internal_error" });
    await host.close();
  });

  it("authenticates and strictly bounds permission configuration without Run-level overrides", async () => {
    const runtime = fakeRuntime();
    let activePreset: "read-only" | "workspace-write" = "workspace-write";
    const configure = vi.fn(async (input: { preset_key: "read-only" | "workspace-write" | "full-write" }) => {
      if (input.preset_key === "full-write") {
        throw Object.assign(new Error("Permission preset exceeds the Host ceiling"), { statusCode: 409 });
      }
      activePreset = input.preset_key;
    });
    const settings = () => ({
      active_preset: activePreset,
      sandbox_mode: activePreset,
      approval_policy: activePreset === "read-only" ? "never" as const : "on-write" as const,
      policy_digest: `sha256:${"c".repeat(64)}` as const,
      ceiling: "workspace-write" as const,
      available_presets: [
        {
          key: "read-only" as const,
          label: "Read only",
          sandbox_mode: "read-only" as const,
          approval_policy: "never" as const,
        },
        {
          key: "workspace-write" as const,
          label: "Workspace write",
          sandbox_mode: "workspace-write" as const,
          approval_policy: "on-write" as const,
        },
      ],
      source: "user-config" as const,
      locked: false,
    });
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
      permissionSettings: { get: settings, configure },
    });
    const authenticated = { authorization: `Bearer ${token}` };
    const commandHeaders = {
      ...authenticated,
      origin,
      "content-type": "application/json",
      "x-tracegraph-command-id": "command:permission:read-only",
    };

    const unauthenticated = await host.app.inject({ method: "GET", url: "/api/permission-config" });
    expect(unauthenticated.statusCode).toBe(401);
    const current = await host.app.inject({
      method: "GET",
      url: "/api/permission-config",
      headers: authenticated,
    });
    expect(current.statusCode).toBe(200);
    expect(current.headers["cache-control"]).toBe("no-store");
    expect(current.json()).toEqual(settings());
    expect(current.json()).not.toHaveProperty("rules");
    expect(current.json()).not.toHaveProperty("path_scope");

    const expanded = await host.app.inject({
      method: "POST",
      url: "/api/permission-config",
      headers: commandHeaders,
      payload: {
        command_id: "command:permission:read-only",
        preset_key: "read-only",
        sandbox_mode: "danger-full-access",
      },
    });
    expect(expanded.statusCode).toBe(400);
    expect(configure).not.toHaveBeenCalled();

    const configured = await host.app.inject({
      method: "POST",
      url: "/api/permission-config",
      headers: commandHeaders,
      payload: { command_id: "command:permission:read-only", preset_key: "read-only" },
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.headers["cache-control"]).toBe("no-store");
    expect(configured.json()).toMatchObject({ active_preset: "read-only", ceiling: "workspace-write" });
    expect(configure).toHaveBeenCalledTimes(1);

    const retry = await host.app.inject({
      method: "POST",
      url: "/api/permission-config",
      headers: commandHeaders,
      payload: { command_id: "command:permission:read-only", preset_key: "read-only" },
    });
    expect(retry.statusCode).toBe(200);
    expect(configure).toHaveBeenCalledTimes(1);

    const ceilingRejected = await host.app.inject({
      method: "POST",
      url: "/api/permission-config",
      headers: {
        ...commandHeaders,
        "x-tracegraph-command-id": "command:permission:full-write",
      },
      payload: { command_id: "command:permission:full-write", preset_key: "full-write" },
    });
    expect(ceilingRejected.statusCode).toBe(409);

    const smuggledStart = await host.app.inject({
      method: "POST",
      url: "/api/runs",
      headers: {
        ...commandHeaders,
        "x-tracegraph-command-id": startRequest.command_id,
      },
      payload: {
        ...startRequest,
        permission_preset: "full-write",
        sandbox_mode: "danger-full-access",
      },
    });
    expect(smuggledStart.statusCode).toBe(400);
    expect(runtime.startRun).not.toHaveBeenCalled();
    await host.close();
  });

  it("rejects a permission-settings adapter that leaks Host-only policy details", async () => {
    const secretPath = "private/project/credentials/**";
    const host = await createTraceGraphHost({
      runtime: fakeRuntime(),
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
      permissionSettings: {
        get: async () => ({
          active_preset: "workspace-write",
          sandbox_mode: "workspace-write",
          approval_policy: "on-write",
          policy_digest: `sha256:${"d".repeat(64)}`,
          ceiling: "workspace-write",
          available_presets: [{
            key: "workspace-write",
            label: "Workspace write",
            sandbox_mode: "workspace-write",
            approval_policy: "on-write",
          }],
          source: "default",
          locked: false,
          path_scope: [secretPath],
        } as never),
        configure: async () => undefined,
      },
    });

    const response = await host.app.inject({
      method: "GET",
      url: "/api/permission-config",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(secretPath);
    expect(response.json()).toMatchObject({ error: "internal_error" });
    await host.close();
  });

  it("lists strict Skill inspections with the registered project label", async () => {
    const host = await createTraceGraphHost({
      runtime: fakeRuntime(),
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
    });
    const response = await host.app.inject({
      method: "GET",
      url: "/api/skills",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual([{
      project_id: "project-demo",
      label: "Read-only demo",
      registry: {
        registry_digest: `sha256:${"a".repeat(64)}`,
        skills: [],
        conflicts: [],
        diagnostics: [],
      },
    }]);
    await host.close();
  });

  it("authenticates extension control, validates commands, and deduplicates retries", async () => {
    const status = {
      name: "artifact-tools",
      api_version: "tracegraph.extension.v1" as const,
      state: "active" as const,
      registration_count: 2,
      generation: 3,
      updated_at: now.toISOString(),
    };
    const reload = vi.fn(async () => status);
    const runCommand = vi.fn(async (input: { command_id: string; name: string }) => ({
      command_id: input.command_id,
      name: input.name,
      status: "success" as const,
      summary: "2 artifacts available",
    }));
    const host = await createTraceGraphHost({
      runtime: fakeRuntime(),
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
      extensions: { list: async () => [status], reload, runCommand },
    });
    const authenticated = { authorization: `Bearer ${token}` };

    expect((await host.app.inject({ method: "GET", url: "/api/extensions" })).statusCode).toBe(401);
    const listed = await host.app.inject({ method: "GET", url: "/api/extensions", headers: authenticated });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers["cache-control"]).toBe("no-store");
    expect(listed.json()).toEqual([status]);

    const reloadHeaders = {
      ...authenticated,
      origin,
      "content-type": "application/json",
      "x-tracegraph-command-id": "command:extension:reload",
    };
    const reloadBody = {
      command_id: "command:extension:reload",
      extension_name: "artifact-tools",
    };
    const [firstReload, retriedReload] = await Promise.all([
      host.app.inject({ method: "POST", url: "/api/extensions/reload", headers: reloadHeaders, payload: reloadBody }),
      host.app.inject({ method: "POST", url: "/api/extensions/reload", headers: reloadHeaders, payload: reloadBody }),
    ]);
    expect(firstReload.statusCode).toBe(200);
    expect(retriedReload.statusCode).toBe(200);
    expect(reload).toHaveBeenCalledTimes(1);

    const commandHeaders = {
      ...authenticated,
      origin,
      "content-type": "application/json",
      "x-tracegraph-command-id": "command:extension:run",
    };
    const commandBody = {
      command_id: "command:extension:run",
      name: "artifacts.list",
      args: ["--limit", "5"],
    };
    const invoked = await host.app.inject({
      method: "POST",
      url: "/api/extensions/commands/artifacts.list",
      headers: commandHeaders,
      payload: commandBody,
    });
    expect(invoked.statusCode).toBe(200);
    expect(invoked.json()).toMatchObject({ status: "success", summary: "2 artifacts available" });
    expect((await host.app.inject({
      method: "POST",
      url: "/api/extensions/commands/artifacts.list",
      headers: commandHeaders,
      payload: commandBody,
    })).statusCode).toBe(200);
    expect(runCommand).toHaveBeenCalledTimes(1);

    const mismatched = await host.app.inject({
      method: "POST",
      url: "/api/extensions/commands/runs.status",
      headers: { ...commandHeaders, "x-tracegraph-command-id": "command:extension:mismatch" },
      payload: { ...commandBody, command_id: "command:extension:mismatch" },
    });
    expect(mismatched.statusCode).toBe(409);
    await host.close();
  });

  it("exposes bounded MCP status and idempotent server restart", async () => {
    const status = {
      name: "filesystem",
      required: false,
      transport: "stdio" as const,
      state: "degraded" as const,
      tool_count: 0,
      tools: [],
      updated_at: now.toISOString(),
      error_code: "mcp_spawn_failed",
      error_message: "optional server unavailable",
    };
    const snapshot = {
      config_version: "tracegraph.mcp.v1" as const,
      servers: [status],
      updated_at: now.toISOString(),
    };
    const restart = vi.fn(async () => ({ ...status, state: "ready" as const, error_code: undefined, error_message: undefined }));
    const host = await createTraceGraphHost({
      runtime: fakeRuntime(),
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
      mcp: { get: () => snapshot, restart: () => restart() },
    });
    const authenticated = { authorization: "Bearer " + token };
    const listed = await host.app.inject({ method: "GET", url: "/api/mcp", headers: authenticated });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers["cache-control"]).toBe("no-store");
    expect(listed.json().servers[0]).toMatchObject({ name: "filesystem", state: "degraded", tool_count: 0 });

    const headers = {
      ...authenticated,
      origin,
      "content-type": "application/json",
      "x-tracegraph-command-id": "command:mcp:restart",
    };
    const body = { command_id: "command:mcp:restart" };
    const [first, retry] = await Promise.all([
      host.app.inject({ method: "POST", url: "/api/mcp/restart/filesystem", headers, payload: body }),
      host.app.inject({ method: "POST", url: "/api/mcp/restart/filesystem", headers, payload: body }),
    ]);
    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(restart).toHaveBeenCalledTimes(1);
    await host.close();
  });

  it("exposes bounded native LSP status without exposing process configuration", async () => {
    const snapshot = {
      config_version: "tracegraph.lsp.v1" as const,
      servers: [{
        name: "typescript",
        state: "ready" as const,
        language_ids: ["typescript"],
        file_extensions: [".ts"],
        diagnostics_count: 2,
        updated_at: now.toISOString(),
      }],
      updated_at: now.toISOString(),
    };
    const host = await createTraceGraphHost({
      runtime: fakeRuntime(),
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
      lsp: { get: () => snapshot },
    });
    const response = await host.app.inject({
      method: "GET",
      url: "/api/lsp",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      config_version: "tracegraph.lsp.v1",
      servers: [{ name: "typescript", state: "ready", diagnostics_count: 2 }],
    });
    await host.close();
  });

  it("redacts registered opaque credentials at the final Host log boundary", async () => {
    const secret = "opaque-\"host\\log-secret-7f4d";
    const lines: string[] = [];
    registerSecretForRedaction(secret);
    const host = await createTraceGraphHost({
      runtime: fakeRuntime(),
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
      logger: true,
      loggerStream: { write: (line) => { lines.push(line); } },
    });

    host.app.log.info(`diagnostic accidentally included ${secret}`);
    await host.close();

    const output = lines.join("");
    expect(output).not.toContain(secret);
    expect(output).toContain("[REDACTED_REGISTERED_SECRET]");
  });

  it("opens a Host-selected local directory without accepting a browser path and can reveal it", async () => {
    const localWorkspace = {
      ...startInput.workspace,
      handle_id: "workspace-linked",
      project_id: "project:linked",
      real_root: "/Users/example/linked",
      workspace_kind: "managed_local" as const,
      capabilities: MANAGED_LOCAL_CAPABILITIES,
    };
    const selector = vi.fn(async () => ({
      label: "linked",
      workspace: localWorkspace,
      location: {
        kind: "linked_directory" as const,
        display_path: localWorkspace.real_root,
        can_reveal: true,
        access: "read_write" as const,
      },
    }));
    const revealer = vi.fn(async () => undefined);
    const remover = vi.fn(async () => undefined);
    const host = await createTraceGraphHost({
      runtime: fakeRuntime(),
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
      localProjectSelector: selector,
      localProjectRemover: remover,
      projectRevealer: revealer,
    });
    const headers = {
      origin,
      authorization: `Bearer ${token}`,
      "x-tracegraph-command-id": "command-open-local",
      "content-type": "application/json",
    };
    const smuggled = await host.app.inject({
      method: "POST",
      url: "/api/projects/open-local",
      headers,
      payload: {
        command_id: "command-open-local",
        access: "read_write",
        path: "/etc",
      },
    });
    expect(smuggled.statusCode).toBe(400);
    expect(selector).not.toHaveBeenCalled();

    const opened = await host.app.inject({
      method: "POST",
      url: "/api/projects/open-local",
      headers,
      payload: { command_id: "command-open-local", access: "read_write" },
    });
    expect(opened.statusCode).toBe(201);
    expect(opened.json()).toMatchObject({
      project_id: "project:linked",
      location: {
        kind: "linked_directory",
        display_path: "/Users/example/linked",
        access: "read_write",
      },
    });
    const repeated = await host.app.inject({
      method: "POST",
      url: "/api/projects/open-local",
      headers,
      payload: { command_id: "command-open-local", access: "read_write" },
    });
    expect(repeated.statusCode).toBe(200);
    expect(selector).toHaveBeenCalledOnce();

    const revealHeaders = {
      ...headers,
      "x-tracegraph-command-id": "command-reveal-local",
    };
    const revealed = await host.app.inject({
      method: "POST",
      url: "/api/projects/project%3Alinked/reveal",
      headers: revealHeaders,
      payload: { command_id: "command-reveal-local" },
    });
    expect(revealed.statusCode).toBe(204);
    expect(revealer).toHaveBeenCalledWith(expect.objectContaining({
      workspace: expect.objectContaining({ real_root: "/Users/example/linked" }),
    }));
    const removed = await host.app.inject({
      method: "POST",
      url: "/api/projects/project%3Alinked/remove",
      headers: { ...headers, "x-tracegraph-command-id": "command-remove-local" },
      payload: { command_id: "command-remove-local" },
    });
    expect(removed.statusCode).toBe(204);
    expect(remover).toHaveBeenCalledWith(expect.objectContaining({
      workspace: expect.objectContaining({ real_root: "/Users/example/linked" }),
    }));
    const listedAfterRemoval = await host.app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listedAfterRemoval.json()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ project_id: "project:linked" }),
    ]));
    await host.close();
  });

  it("starts a plain chat in a hidden no-capability workspace", async () => {
    const runtime = fakeRuntime();
    const chatWorkspace = {
      ...startInput.workspace,
      handle_id: "workspace-chat",
      project_id: "chat:local",
      capabilities: {
        index: false,
        read: false,
        search: false,
        run_command: false,
        preview_patch: false,
        commit_patch: false,
        test: false,
      },
    };
    vi.mocked(runtime.startRun).mockImplementation(async (input) => ({
      ...projection,
      project_id: input.project_id,
      task: input.task,
      workspace_kind: input.workspace.workspace_kind,
    }));
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      chatProject: { label: "Plain chat", workspace: chatWorkspace },
      capabilityToken: token,
      now: () => now,
    });
    const listed = await host.app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listed.json()).toHaveLength(1);

    const headers = {
      origin,
      authorization: `Bearer ${token}`,
      "x-tracegraph-command-id": "command-chat",
      "content-type": "application/json",
    };
    const started = await host.app.inject({
      method: "POST",
      url: "/api/chat/runs",
      headers,
      payload: {
        command_id: "command-chat",
        task: "Explain Agent memory",
        reasoning_effort: "high",
      },
    });
    expect(started.statusCode).toBe(200);
    expect(runtime.startRun).toHaveBeenCalledWith(expect.objectContaining({
      project_id: "chat:local",
      mode: "execute",
      reasoning_effort: "high",
      workspace: expect.objectContaining({
        project_id: "chat:local",
        capabilities: expect.objectContaining({ read: false, search: false }),
      }),
    }));

    const smuggled = await host.app.inject({
      method: "POST",
      url: "/api/chat/runs",
      headers: { ...headers, "x-tracegraph-command-id": "command-chat-path" },
      payload: {
        command_id: "command-chat-path",
        task: "Read a private project",
        project_id: "project-demo",
      },
    });
    expect(smuggled.statusCode).toBe(400);
    await host.close();
  });

  it("issues a short-lived token only to an allowed loopback origin", async () => {
    const host = await createTraceGraphHost({
      runtime: fakeRuntime(),
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
    });
    const denied = await host.app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(denied.statusCode).toBe(403);
    const crossOrigin = await host.app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { origin: "https://attacker.example" },
    });
    expect(crossOrigin.statusCode).toBe(403);

    const accepted = await host.app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { origin },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ token });
    await host.close();
  });

  it("binds replay reads to a rotating Host capability and rejects live or future state", async () => {
    const runtime = fakeRuntime();
    let replayCalls = 0;
    vi.mocked(runtime.replayAt).mockImplementation(async (input) => {
      replayCalls += 1;
      return replaySnapshot(input.until_sequence, replayCalls === 1 ? 2 : 3);
    });
    vi.mocked(runtime.replayDiff).mockImplementation(async (input) => (
      replayDiff(input.from, input.to, 3)
    ));
    vi.mocked(runtime.getArtifact).mockResolvedValue({
      status: "available",
      artifact: replayArtifact,
      content: "replay",
    });
    const lines: string[] = [];
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      sessions: fakeSessions(),
      capabilityToken: token,
      now: () => now,
      logger: true,
      loggerStream: { write: (line) => { lines.push(line); } },
    });
    const liveHeaders = {
      origin,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };

    const entered = await host.app.inject({
      method: "POST",
      url: "/api/replay",
      headers: liveHeaders,
      payload: { session_id: "session-demo", run_id: "run-demo", until_sequence: 2 },
    });
    expect(entered.statusCode).toBe(200);
    const firstReplay = entered.json() as {
      replay_id: string;
      replay_token: string;
      snapshot: ReplaySnapshot;
    };
    expect(firstReplay.replay_token).not.toBe(token);
    expect(firstReplay.snapshot).toMatchObject({
      session_id: "session-demo",
      run_id: "run-demo",
      until_sequence: 2,
      head_sequence: 2,
    });
    expect(runtime.replayAt).toHaveBeenCalledWith({
      session_id: "session-demo",
      run_id: "run-demo",
      until_sequence: 2,
    });
    const replayAuthorization = { authorization: `Bearer ${firstReplay.replay_token}` };

    const diff = await host.app.inject({
      method: "GET",
      url: "/api/replay/diff?session_id=session-demo&run_id=run-demo&from=1&to=2",
      headers: replayAuthorization,
    });
    expect(diff.statusCode).toBe(200);
    expect(diff.json()).toMatchObject({ head_sequence: 2, from_sequence: 1, to_sequence: 2 });

    const artifact = await host.app.inject({
      method: "GET",
      url: "/api/artifacts/artifact-replay?run_id=run-demo",
      headers: replayAuthorization,
    });
    expect(artifact.statusCode).toBe(200);
    expect(runtime.getArtifact).toHaveBeenCalledWith({
      artifactId: "artifact-replay",
      runId: "run-demo",
      projectId: "project-demo",
    });

    const replayAttachment = await host.app.inject({
      method: "GET",
      url: "/api/runs/run-demo/attachments/attachment-replay/content",
      headers: replayAuthorization,
    });
    expect(replayAttachment.statusCode).toBe(403);
    expect(replayAttachment.json()).toMatchObject({ error: "replay_read_only" });

    vi.mocked(runtime.getProjection).mockClear();
    vi.mocked(runtime.writeTodo).mockClear();
    const [latest, projects, extensions, extensionReload, stream, write] = await Promise.all([
      host.app.inject({ method: "GET", url: "/api/runs/run-demo", headers: replayAuthorization }),
      host.app.inject({ method: "GET", url: "/api/projects", headers: replayAuthorization }),
      host.app.inject({ method: "GET", url: "/api/extensions", headers: replayAuthorization }),
      host.app.inject({
        method: "POST",
        url: "/api/extensions/reload",
        headers: { ...replayAuthorization, origin },
        payload: {},
      }),
      host.app.inject({ method: "GET", url: "/api/runs/run-demo/events/stream", headers: replayAuthorization }),
      host.app.inject({
        method: "POST",
        url: "/api/runs/run-demo/todos",
        headers: { ...replayAuthorization, origin },
        payload: {},
      }),
    ]);
    for (const denied of [latest, projects, extensions, extensionReload, stream, write]) {
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ error: "replay_read_only" });
    }
    expect(runtime.getProjection).not.toHaveBeenCalled();
    expect(runtime.writeTodo).not.toHaveBeenCalled();

    const stepped = await host.app.inject({
      method: "POST",
      url: "/api/replay",
      headers: { ...replayAuthorization, origin, "content-type": "application/json" },
      payload: { session_id: "session-demo", run_id: "run-demo", until_sequence: 1 },
    });
    expect(stepped.statusCode).toBe(200);
    const secondReplay = stepped.json() as { replay_token: string; snapshot: ReplaySnapshot };
    expect(secondReplay.replay_token).not.toBe(firstReplay.replay_token);
    expect(secondReplay.snapshot).toMatchObject({ until_sequence: 1, head_sequence: 2 });

    const revoked = await host.app.inject({
      method: "GET",
      url: "/api/replay/diff?session_id=session-demo&run_id=run-demo&from=1&to=1",
      headers: replayAuthorization,
    });
    expect(revoked.statusCode).toBe(401);

    const futureArtifact = await host.app.inject({
      method: "GET",
      url: "/api/artifacts/artifact-replay?run_id=run-demo",
      headers: { authorization: `Bearer ${secondReplay.replay_token}` },
    });
    expect(futureArtifact.statusCode).toBe(403);
    expect(futureArtifact.json()).toMatchObject({ error: "replay_artifact_out_of_scope" });

    const crossScope = await host.app.inject({
      method: "POST",
      url: "/api/replay",
      headers: {
        origin,
        authorization: `Bearer ${secondReplay.replay_token}`,
        "content-type": "application/json",
      },
      payload: { session_id: "session-other", run_id: "run-demo", until_sequence: 1 },
    });
    expect(crossScope.statusCode).toBe(403);
    expect(crossScope.json()).toMatchObject({ error: "replay_scope_mismatch" });

    await host.close();
    expect(lines.join("\n")).not.toContain(firstReplay.replay_token);
    expect(lines.join("\n")).not.toContain(secondReplay.replay_token);
  });

  it("linearizes concurrent replay rotation so one old bearer cannot mint two successors", async () => {
    const runtime = fakeRuntime();
    let replayCalls = 0;
    let concurrentSteps = 0;
    let releaseSteps = (): void => undefined;
    const stepGate = new Promise<void>((resolve) => {
      releaseSteps = resolve;
    });
    let markBothStarted = (): void => undefined;
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    vi.mocked(runtime.replayAt).mockImplementation(async (input) => {
      replayCalls += 1;
      if (replayCalls === 1) return replaySnapshot(input.until_sequence);
      concurrentSteps += 1;
      if (concurrentSteps === 2) markBothStarted();
      await stepGate;
      return replaySnapshot(input.until_sequence);
    });
    vi.mocked(runtime.replayDiff).mockImplementation(async (input) => (
      replayDiff(input.from, input.to)
    ));
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      sessions: fakeSessions(),
      capabilityToken: token,
      now: () => now,
    });
    const entered = await host.app.inject({
      method: "POST",
      url: "/api/replay",
      headers: { origin, authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { session_id: "session-demo", run_id: "run-demo", until_sequence: 2 },
    });
    const originalReplayToken = (entered.json() as { replay_token: string }).replay_token;
    const rotate = (untilSequence: number) => host.app.inject({
      method: "POST",
      url: "/api/replay",
      headers: {
        origin,
        authorization: `Bearer ${originalReplayToken}`,
        "content-type": "application/json",
      },
      payload: {
        session_id: "session-demo",
        run_id: "run-demo",
        until_sequence: untilSequence,
      },
    });

    const first = rotate(1);
    const second = rotate(2);
    await bothStarted;
    releaseSteps();
    const responses = await Promise.all([first, second]);
    expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([200, 401]);
    const stale = responses.find(({ statusCode }) => statusCode === 401)!;
    expect(stale.json()).toMatchObject({ error: "replay_capability_stale" });

    const winner = responses.find(({ statusCode }) => statusCode === 200)!;
    const winnerToken = (winner.json() as { replay_token: string }).replay_token;
    const [oldBearer, winningBearer] = await Promise.all([
      host.app.inject({
        method: "GET",
        url: "/api/replay/diff?session_id=session-demo&run_id=run-demo&from=1&to=1",
        headers: { authorization: `Bearer ${originalReplayToken}` },
      }),
      host.app.inject({
        method: "GET",
        url: "/api/replay/diff?session_id=session-demo&run_id=run-demo&from=1&to=1",
        headers: { authorization: `Bearer ${winnerToken}` },
      }),
    ]);
    expect(oldBearer.statusCode).toBe(401);
    expect(winningBearer.statusCode).toBe(200);
    await host.close();
  });

  it("expires replay capabilities and enforces the process-local capacity bound", async () => {
    let clock = now;
    const runtime = fakeRuntime();
    vi.mocked(runtime.replayAt).mockImplementation(async (input) => replaySnapshot(input.until_sequence));
    vi.mocked(runtime.replayDiff).mockImplementation(async (input) => replayDiff(input.from, input.to));
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      sessions: fakeSessions(),
      capabilityToken: token,
      now: () => clock,
      replayTokenTtlMs: 1_000,
      maxReplayCapabilities: 1,
    });
    const create = () => host.app.inject({
      method: "POST",
      url: "/api/replay",
      headers: { origin, authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { session_id: "session-demo", run_id: "run-demo", until_sequence: 2 },
    });

    const first = await create();
    const firstToken = (first.json() as { replay_token: string }).replay_token;
    const atCapacity = await create();
    expect(atCapacity.statusCode).toBe(429);
    expect(atCapacity.json()).toMatchObject({ error: "replay_capability_capacity" });

    clock = new Date(now.getTime() + 1_001);
    vi.mocked(runtime.replayDiff).mockClear();
    const expired = await host.app.inject({
      method: "GET",
      url: "/api/replay/diff?session_id=session-demo&run_id=run-demo&from=1&to=2",
      headers: { authorization: `Bearer ${firstToken}` },
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toMatchObject({ error: "capability_expired" });
    expect(runtime.replayDiff).not.toHaveBeenCalled();
    await host.close();
  });

  it.each([
    ["run_not_found", 404, "run_not_found"],
    ["replay_sequence_out_of_range", 409, "replay_sequence_out_of_range"],
    ["replay_scope_mismatch", 409, "replay_scope_mismatch"],
    ["replay_source_invalid", 500, "internal_error"],
  ] as const)("maps core replay failure %s without exposing corrupt-source details", async (code, status, publicCode) => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.replayAt).mockRejectedValue(new ReplayError(code, "private replay detail"));
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      sessions: fakeSessions(),
      capabilityToken: token,
      now: () => now,
    });
    const response = await host.app.inject({
      method: "POST",
      url: "/api/replay",
      headers: { origin, authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { session_id: "session-demo", run_id: "run-demo", until_sequence: 2 },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: publicCode });
    if (status === 500) expect(response.body).not.toContain("private replay detail");
    await host.close();
  });

  it("recovers durable sessions before bootstrap and exposes scoped browse and mutation routes", async () => {
    const sessions = fakeSessions();
    const host = await createTraceGraphHost({
      runtime: fakeRuntime(),
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
      sessions,
    });
    expect(sessions.recover).toHaveBeenCalledOnce();

    const bootstrap = await host.app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { origin },
    });
    expect(bootstrap.json()).toMatchObject({
      recovery: {
        scanned_sessions: 1,
        interrupted_run_ids: ["run-demo"],
      },
    });

    const authorization = { authorization: `Bearer ${token}` };
    const listed = await host.app.inject({
      method: "GET",
      url: "/api/sessions?project_id=project-demo&q=Demo&limit=20",
      headers: authorization,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      sessions: [{ session_id: "session-demo", project_id: "project-demo" }],
    });
    expect(sessions.list).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: "project-demo", q: "Demo", view: "roots", limit: 20 }),
      { projectIds: ["project-demo"] },
    );

    const read = await host.app.inject({
      method: "GET",
      url: "/api/sessions/session-demo",
      headers: authorization,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ header: { title: "Demo session" } });

    const renamed = await host.app.inject({
      method: "PATCH",
      url: "/api/sessions/session-demo",
      headers: { ...authorization, origin },
      payload: { title: "Recovered work" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ header: { title: "Recovered work" } });

    const deleted = await host.app.inject({
      method: "DELETE",
      url: "/api/sessions/session-demo",
      headers: { ...authorization, origin },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ session_id: "session-demo", deleted: true });
    await host.close();
  });

  it("resumes a durable pending plan in its registered workspace and restores the active-run guard", async () => {
    const runtime = fakeRuntime();
    const sessions = fakeSessions("awaiting_plan_approval");
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
      sessions,
    });
    const commandId = "command-resume-session";
    const resumed = await host.app.inject({
      method: "POST",
      url: "/api/sessions/session-demo/resume",
      headers: {
        origin,
        authorization: `Bearer ${token}`,
        "x-tracegraph-command-id": commandId,
      },
      payload: { command_id: commandId },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({
      session_id: "session-demo",
      run_id: "run-demo",
      status: "awaiting_plan_approval",
    });
    expect(sessions.resume).toHaveBeenCalledWith({
      sessionId: "session-demo",
      commandId,
      workspace: startInput.workspace,
    });

    const blocked = await host.app.inject({
      method: "POST",
      url: "/api/runs",
      headers: {
        origin,
        authorization: `Bearer ${token}`,
        "x-tracegraph-command-id": "command-after-resume",
      },
      payload: { ...startRequest, command_id: "command-after-resume" },
    });
    expect(blocked.statusCode).toBe(409);
    expect(runtime.startRun).not.toHaveBeenCalled();
    await host.close();
  });

  it("maps a session writer lease conflict to HTTP 409 without leaking backend details", async () => {
    const lines: string[] = [];
    const sessions = fakeSessions();
    sessions.rename = vi.fn(async () => {
      throw Object.assign(new Error("lock path /private/sessions/session-demo.lock owner pid 998"), {
        code: "session_lease_conflict",
      });
    });
    const host = await createTraceGraphHost({
      runtime: fakeRuntime(),
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
      sessions,
      logger: true,
      loggerStream: { write: (line) => { lines.push(line); } },
    });
    const response = await host.app.inject({
      method: "PATCH",
      url: "/api/sessions/session-demo",
      headers: { origin, authorization: `Bearer ${token}` },
      payload: { title: "Conflicting rename" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "session_lease_conflict",
      message: "Session is being modified by another Host",
    });
    expect(response.body).not.toContain("/private/sessions");
    expect(response.body).not.toContain("998");
    await host.close();
    const audit = lines.join("");
    expect(audit).toContain("session.operation_rejected");
    expect(audit).toContain("session_lease_conflict");
    expect(audit).not.toContain("/private/sessions");
    expect(audit).not.toContain("owner pid 998");
  });

  it("fails closed when durable startup recovery cannot complete", async () => {
    const sessions = fakeSessions();
    sessions.recover = vi.fn(async () => {
      throw new Error("durable session scan failed");
    });
    await expect(createTraceGraphHost({
      runtime: fakeRuntime(),
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
      sessions,
    })).rejects.toThrow("durable session scan failed");
  });

  it("requires auth, origin, and a command id bound to the body", async () => {
    const runtime = fakeRuntime();
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
    });
    const unauthenticated = await host.app.inject({
      method: "POST",
      url: "/api/runs",
      headers: { origin },
      payload: startRequest,
    });
    expect(unauthenticated.statusCode).toBe(401);

    const mismatch = await host.app.inject({
      method: "POST",
      url: "/api/runs",
      headers: {
        origin,
        authorization: `Bearer ${token}`,
        "x-tracegraph-command-id": "different-command",
      },
      payload: startRequest,
    });
    expect(mismatch.statusCode).toBe(409);

    const accepted = await host.app.inject({
      method: "POST",
      url: "/api/runs",
      headers: {
        origin,
        authorization: `Bearer ${token}`,
        "x-tracegraph-command-id": startInput.command_id,
      },
      payload: { ...startRequest, attachment_upload_ids: ["upload:one"] },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ run_id: "run-demo" });
    expect(runtime.startRun).toHaveBeenCalledOnce();
    expect(runtime.startRun).toHaveBeenCalledWith(expect.objectContaining({
      attachment_upload_ids: ["upload:one"],
    }));
    await host.close();
  });

  it("accepts a contract-bounded run payload above the global 256 KiB ceiling", async () => {
    const runtime = fakeRuntime();
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
    });
    const commandId = "command-large-context";
    const conversationHistory = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: "上下文压缩".repeat(1_600),
    }));
    const payload = {
      ...startRequest,
      command_id: commandId,
      conversation_history: conversationHistory,
    };
    expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeGreaterThan(256 * 1024);

    const response = await host.app.inject({
      method: "POST",
      url: "/api/runs",
      headers: {
        origin,
        authorization: `Bearer ${token}`,
        "x-tracegraph-command-id": commandId,
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(runtime.startRun).toHaveBeenCalledWith(expect.objectContaining({
      conversation_history: expect.arrayContaining([
        expect.objectContaining({ content: conversationHistory[0]!.content }),
      ]),
    }));
    await host.close();
  });

  it("derives rollback authority from the Run and accepts only command_id and force", async () => {
    const runtime = fakeRuntime();
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
    });
    const headers = {
      origin,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-tracegraph-command-id": "command-rollback",
    };
    const accepted = await host.app.inject({
      method: "POST",
      url: "/api/runs/run-demo/actions/action-patch/rollback",
      headers,
      payload: { command_id: "command-rollback", force: true },
    });

    expect(accepted.statusCode).toBe(200);
    expect(runtime.getProjection).toHaveBeenCalledWith("run-demo");
    expect(runtime.rollback).toHaveBeenCalledWith({
      type: "rollback_action",
      command_id: "command-rollback",
      project_id: "project-demo",
      run_id: "run-demo",
      action_id: "action-patch",
      force: true,
      workspace: startInput.workspace,
    });

    const smuggledProject = await host.app.inject({
      method: "POST",
      url: "/api/runs/run-demo/actions/action-patch/rollback",
      headers: { ...headers, "x-tracegraph-command-id": "command-smuggled" },
      payload: {
        command_id: "command-smuggled",
        project_id: "project-attacker-selected",
      },
    });
    expect(smuggledProject.statusCode).toBe(400);
    expect(runtime.rollback).toHaveBeenCalledOnce();

    const mismatchedCommand = await host.app.inject({
      method: "POST",
      url: "/api/runs/run-demo/actions/action-patch/rollback",
      headers: { ...headers, "x-tracegraph-command-id": "different-command" },
      payload: { command_id: "command-rollback" },
    });
    expect(mismatchedCommand.statusCode).toBe(409);
    expect(runtime.rollback).toHaveBeenCalledOnce();
    await host.close();
  });

  it("scopes artifact lookup through the run projection", async () => {
    const runtime = fakeRuntime();
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
    });
    const response = await host.app.inject({
      method: "GET",
      url: "/api/artifacts/artifact-missing?run_id=run-demo",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "unavailable",
      artifact_id: "artifact-missing",
      reason: "not_found",
    });
    expect(runtime.getArtifact).toHaveBeenCalledWith({
      artifactId: "artifact-missing",
      runId: "run-demo",
      projectId: "project-demo",
    });
    await host.close();
  });

  it("stages raw project and hidden-chat attachments behind Host authority", async () => {
    const runtime = fakeRuntime();
    const chatWorkspace = {
      ...startInput.workspace,
      handle_id: "workspace-chat-attachment",
      project_id: "chat:hidden",
    };
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      chatProject: { label: "Plain chat", workspace: chatWorkspace },
      capabilityToken: token,
      now: () => now,
    });
    const upload = async (query: string, commandId: string, payload = Buffer.from([1, 2, 3])) => host.app.inject({
      method: "POST",
      url: `/api/attachments?${query}`,
      headers: {
        origin,
        authorization: `Bearer ${token}`,
        "content-type": "application/octet-stream",
        "x-tracegraph-command-id": commandId,
      },
      payload,
    });

    const project = await upload(
      "command_id=command%3Aupload-project&target=project&project_id=project-demo&declared_media_type=image%2Fpng&delivery=inline",
      "command:upload-project",
    );
    const chat = await upload(
      "command_id=command%3Aupload-chat&target=chat&declared_media_type=application%2Fpdf",
      "command:upload-chat",
    );
    const smuggledChatProject = await upload(
      "command_id=command%3Aupload-smuggled&target=chat&project_id=chat%3Ahidden&declared_media_type=image%2Fpng",
      "command:upload-smuggled",
    );
    const unauthenticated = await host.app.inject({
      method: "POST",
      url: "/api/attachments?command_id=command%3Aupload-no-auth&target=project&project_id=project-demo&declared_media_type=image%2Fpng",
      headers: {
        origin,
        "content-type": "application/octet-stream",
        "x-tracegraph-command-id": "command:upload-no-auth",
      },
      payload: Buffer.from([1]),
    });
    const missingOrigin = await host.app.inject({
      method: "POST",
      url: "/api/attachments?command_id=command%3Aupload-no-origin&target=project&project_id=project-demo&declared_media_type=image%2Fpng",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/octet-stream",
        "x-tracegraph-command-id": "command:upload-no-origin",
      },
      payload: Buffer.from([1]),
    });
    const commandMismatch = await upload(
      "command_id=command%3Aupload-body&target=project&project_id=project-demo&declared_media_type=image%2Fpng",
      "command:upload-header",
    );
    const jsonBody = await host.app.inject({
      method: "POST",
      url: "/api/attachments?command_id=command%3Aupload-json&target=project&project_id=project-demo&declared_media_type=image%2Fpng",
      headers: {
        origin,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-tracegraph-command-id": "command:upload-json",
      },
      payload: { bytes: "not-raw" },
    });

    expect(project.statusCode).toBe(201);
    expect(chat.statusCode).toBe(201);
    expect(smuggledChatProject.statusCode).toBe(400);
    expect(unauthenticated.statusCode).toBe(401);
    expect(missingOrigin.statusCode).toBe(403);
    expect(commandMismatch.statusCode).toBe(409);
    expect(jsonBody.statusCode).toBe(415);
    expect(runtime.stageAttachment).toHaveBeenNthCalledWith(1, expect.objectContaining({
      commandId: "command:upload-project",
      projectId: "project-demo",
      declaredMediaType: "image/png",
      delivery: "inline",
      source: "user_upload",
      bytes: Buffer.from([1, 2, 3]),
    }));
    expect(runtime.stageAttachment).toHaveBeenNthCalledWith(2, expect.objectContaining({
      commandId: "command:upload-chat",
      projectId: "chat:hidden",
      declaredMediaType: "application/pdf",
      delivery: "offload",
    }));
    await host.close();
  });

  it("keeps a business-level oversized rejection claimable below the transport hard cap", async () => {
    const runtime = fakeRuntime();
    const bytes = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x61);
    vi.mocked(runtime.stageAttachment).mockResolvedValue({
      status: "rejected",
      upload_id: "upload:too-large",
      source: "user_upload",
      delivery: "offload",
      bytes: bytes.byteLength,
      expires_at: "2026-09-16T00:10:00.000Z",
      declared_media_type: "application/pdf",
      code: "too_large",
      reason: "Attachment exceeds the 5 MiB product limit",
    });
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
    });
    const response = await host.app.inject({
      method: "POST",
      url: "/api/attachments?command_id=command%3Aupload-large&target=project&project_id=project-demo&declared_media_type=application%2Fpdf",
      headers: {
        origin,
        authorization: `Bearer ${token}`,
        "content-type": "application/octet-stream",
        "x-tracegraph-command-id": "command:upload-large",
      },
      payload: bytes,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      status: "rejected",
      upload_id: "upload:too-large",
      code: "too_large",
      bytes: MAX_ATTACHMENT_BYTES + 1,
    });
    const [stagedUpload] = vi.mocked(runtime.stageAttachment).mock.calls.at(-1) ?? [];
    // Vitest's asymmetric deep equality walks a multi-megabyte Buffer element by
    // element: this single assertion cost ~5.5s locally and blew the timeout on
    // slower CI runners. A native memcmp proves the same byte-exact guarantee.
    expect(Buffer.isBuffer(stagedUpload?.bytes)).toBe(true);
    expect(Buffer.compare(stagedUpload!.bytes as Buffer, bytes)).toBe(0);
    await host.close();
  }, 15_000);

  it("serves only hash-verified Attachment bytes related to the requested live Run", async () => {
    const runtime = fakeRuntime();
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
    const attachment = {
      attachment_id: "attachment:image-one",
      media_type: "image/png" as const,
      bytes: bytes.byteLength,
      sha256,
      source: "user_upload" as const,
    };
    const relatedProjection: RunProjection = {
      ...projection,
      attachments: {
        items: [{
          status: "offloaded",
          upload_id: "upload:image-one",
          attachment,
          delivery: "offload",
          deduplicated: false,
          pdf_extraction: { status: "not_applicable" },
          offload_reason: "default_policy",
        }],
        last_sequence: 2,
      },
    };
    vi.mocked(runtime.getProjection).mockImplementation(async (runId) => runId === "run-demo"
      ? relatedProjection
      : { ...projection, run_id: runId, attachments: { items: [], last_sequence: 0 } });
    vi.mocked(runtime.getAttachmentContent).mockResolvedValue({ attachment, bytes });
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
    });

    const available = await host.app.inject({
      method: "GET",
      url: "/api/runs/run-demo/attachments/attachment%3Aimage-one/content",
      headers: { authorization: `Bearer ${token}` },
    });
    const unrelated = await host.app.inject({
      method: "GET",
      url: "/api/runs/run-demo/attachments/attachment%3Aother/content",
      headers: { authorization: `Bearer ${token}` },
    });
    const crossRun = await host.app.inject({
      method: "GET",
      url: "/api/runs/run-other/attachments/attachment%3Aimage-one/content",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(available.statusCode).toBe(200);
    expect(available.rawPayload).toEqual(Buffer.from(bytes));
    expect(available.headers).toMatchObject({
      "cache-control": "private, no-store",
      "content-type": "image/png",
      "x-content-type-options": "nosniff",
      "x-tracegraph-content-sha256": sha256,
    });
    expect(unrelated.statusCode).toBe(404);
    expect(crossRun.statusCode).toBe(404);
    expect(runtime.getAttachmentContent).toHaveBeenCalledOnce();

    vi.mocked(runtime.getAttachmentContent).mockResolvedValue({
      attachment,
      bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x46]),
    });
    const tampered = await host.app.inject({
      method: "GET",
      url: "/api/runs/run-demo/attachments/attachment%3Aimage-one/content",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(tampered.statusCode).toBe(500);
    expect(tampered.json()).toEqual({
      error: "internal_error",
      message: "TraceGraph Host failed to process the request",
    });
    await host.close();
  });

  it("server-binds Todo updates and approves only the exact plan revision in the same Run", async () => {
    const planProjection: RunProjection = {
      ...projection,
      status: "awaiting_plan_approval",
      pending_plan: { plan_event_id: "event-plan-ready", todo_ids: ["todo-one"] },
      todos: {
        items: [{
          todo_id: "todo-one",
          title: "Inspect the plan",
          state: "pending",
          depends_on: [],
          evidence_event_ids: [],
          created_by: "model",
        }],
        last_sequence: 2,
      },
    };
    const runtime = fakeRuntime();
    vi.mocked(runtime.getProjection).mockResolvedValue(planProjection);
    vi.mocked(runtime.readTodos).mockResolvedValue(planProjection.todos);
    const { pending_plan: _pendingPlan, ...approvedProjection } = planProjection;
    vi.mocked(runtime.approvePlan).mockResolvedValue({
      ...approvedProjection,
      mode: "execute",
      status: "running",
    });
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
    });
    const authenticated = { origin, authorization: `Bearer ${token}` };

    const listed = await host.app.inject({
      method: "GET",
      url: "/api/runs/run-demo/todos",
      headers: authenticated,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers["cache-control"]).toBe("private, no-store");
    expect(listed.json()).toEqual(planProjection.todos);
    expect(runtime.readTodos).toHaveBeenCalledWith("run-demo", "project-demo");

    const todoHeaders = {
      ...authenticated,
      "content-type": "application/json",
      "x-tracegraph-command-id": "command-todo-user",
    };
    const updated = await host.app.inject({
      method: "POST",
      url: "/api/runs/run-demo/todos",
      headers: todoHeaders,
      payload: {
        command_id: "command-todo-user",
        input: { operation: "update", todo_id: "todo-one", state: "in_progress" },
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ event_type: "todo.updated", last_sequence: 3 });
    expect(runtime.writeTodo).toHaveBeenCalledWith({
      command_id: "command-todo-user",
      project_id: "project-demo",
      run_id: "run-demo",
      updated_by: "user",
      input: { operation: "update", todo_id: "todo-one", state: "in_progress" },
    });

    vi.mocked(runtime.writeTodo).mockRejectedValueOnce(new TodoDomainError("todo_not_found", "Todo is unavailable"));
    const missingTodo = await host.app.inject({
      method: "POST",
      url: "/api/runs/run-demo/todos",
      headers: { ...todoHeaders, "x-tracegraph-command-id": "command-todo-missing" },
      payload: {
        command_id: "command-todo-missing",
        input: { operation: "update", todo_id: "todo-missing", state: "pending" },
      },
    });
    expect(missingTodo.statusCode).toBe(404);
    expect(missingTodo.json()).toMatchObject({ error: "todo_not_found" });

    const injectedAuthority = await host.app.inject({
      method: "POST",
      url: "/api/runs/run-demo/todos",
      headers: { ...todoHeaders, "x-tracegraph-command-id": "command-todo-injected" },
      payload: {
        command_id: "command-todo-injected",
        project_id: "attacker-project",
        updated_by: "model",
        input: { operation: "update", todo_id: "todo-one", state: "done" },
      },
    });
    expect(injectedAuthority.statusCode).toBe(400);

    const approved = await host.app.inject({
      method: "POST",
      url: "/api/runs/run-demo/plan/approve",
      headers: {
        ...authenticated,
        "content-type": "application/json",
        "x-tracegraph-command-id": "command-plan-approve",
      },
      payload: { command_id: "command-plan-approve", plan_event_id: "event-plan-ready" },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ run_id: "run-demo", mode: "execute", status: "running" });
    expect(runtime.approvePlan).toHaveBeenCalledWith({
      type: "approve_plan",
      command_id: "command-plan-approve",
      project_id: "project-demo",
      run_id: "run-demo",
      plan_event_id: "event-plan-ready",
    });

    vi.mocked(runtime.approvePlan).mockRejectedValueOnce(new RuntimeCommandError(
      "plan_revision_mismatch",
      "Approval does not match the current plan revision",
    ));
    const stalePlan = await host.app.inject({
      method: "POST",
      url: "/api/runs/run-demo/plan/approve",
      headers: {
        ...authenticated,
        "content-type": "application/json",
        "x-tracegraph-command-id": "command-plan-stale",
      },
      payload: { command_id: "command-plan-stale", plan_event_id: "event-plan-stale" },
    });
    expect(stalePlan.statusCode).toBe(409);
    expect(stalePlan.json()).toMatchObject({ error: "plan_revision_mismatch" });

    await host.close();
  });

  it("strictly accepts steering input while binding Run scope and actor at the Host boundary", async () => {
    const runtime = fakeRuntime();
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
    });
    const headers = {
      origin,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-tracegraph-command-id": "command-steer",
    };

    const queued = await host.app.inject({
      method: "POST",
      url: "/api/runs/run-demo/input",
      headers,
      payload: {
        command_id: "command-steer",
        input_id: "input-steer",
        kind: "message",
        body: "Inspect the retry path next",
      },
    });

    expect(queued.statusCode).toBe(200);
    expect(queued.headers["cache-control"]).toBe("private, no-store");
    expect(queued.json()).toMatchObject({
      disposition: "queued",
      input: {
        input_id: "input-steer",
        run_id: "run-demo",
        actor: "user",
      },
    });
    expect(runtime.submitUserInput).toHaveBeenCalledWith({
      type: "submit_user_input",
      command_id: "command-steer",
      input_id: "input-steer",
      project_id: "project-demo",
      run_id: "run-demo",
      kind: "message",
      body: "Inspect the retry path next",
      actor: "user",
    });

    const injectedAuthority = await host.app.inject({
      method: "POST",
      url: "/api/runs/run-demo/input",
      headers: { ...headers, "x-tracegraph-command-id": "command-steer-injected" },
      payload: {
        command_id: "command-steer-injected",
        input_id: "input-steer-injected",
        kind: "cancel",
        body: "",
        actor: "system",
        project_id: "attacker-project",
        run_id: "attacker-run",
      },
    });
    expect(injectedAuthority.statusCode).toBe(400);
    expect(runtime.submitUserInput).toHaveBeenCalledTimes(1);

    const mismatchedCommand = await host.app.inject({
      method: "POST",
      url: "/api/runs/run-demo/input",
      headers: { ...headers, "x-tracegraph-command-id": "different-command" },
      payload: {
        command_id: "command-steer",
        input_id: "input-steer-2",
        kind: "approve_hint",
        body: "This is guidance, not an approval",
      },
    });
    expect(mismatchedCommand.statusCode).toBe(409);
    expect(runtime.submitUserInput).toHaveBeenCalledTimes(1);
    await host.close();
  });

  it.each([
    ["completed", "run_terminal", "A terminal Run Todo list cannot be changed"],
    ["interrupted", "run_not_mutable", "Todo changes are unavailable while the Run requires recovery or manual review"],
    ["needs_manual_review", "run_not_mutable", "Todo changes are unavailable while the Run requires recovery or manual review"],
  ] as const)("rejects user Todo updates while the Run is %s", async (status, code, message) => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.getProjection).mockResolvedValue({ ...projection, status });
    vi.mocked(runtime.writeTodo).mockRejectedValue(new RuntimeCommandError(code, message));
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
    });

    const response = await host.app.inject({
      method: "POST",
      url: "/api/runs/run-demo/todos",
      headers: {
        origin,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-tracegraph-command-id": `command-todo-${status}`,
      },
      payload: {
        command_id: `command-todo-${status}`,
        input: { operation: "update", todo_id: "todo-one", state: "done" },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: code, message });
    expect(runtime.writeTodo).toHaveBeenCalledOnce();
    await host.close();
  });

  it("preserves Runtime Todo idempotency after the Run becomes terminal", async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.getProjection).mockResolvedValue({ ...projection, mode: "execute", status: "completed" });
    const originalMutation = {
      todo: {
        todo_id: "todo-one",
        title: "Inspect the plan",
        state: "done" as const,
        depends_on: [],
        evidence_event_ids: ["event-user-confirmed"],
        created_by: "model" as const,
      },
      event_type: "todo.completed" as const,
      event_id: "event-todo-original",
      last_sequence: 7,
    };
    vi.mocked(runtime.writeTodo).mockImplementation(async (input) => {
      if (input.command_id === "command-todo-original") {
        if (input.input.state !== "done") {
          throw new RuntimeCommandError("idempotency_conflict", "Todo command id was already used with a different payload");
        }
        return originalMutation;
      }
      throw new RuntimeCommandError("run_terminal", "A terminal Run Todo list cannot be changed");
    });
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
    });
    const headers = {
      origin,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };

    const replay = await host.app.inject({
      method: "POST",
      url: "/api/runs/run-demo/todos",
      headers: { ...headers, "x-tracegraph-command-id": "command-todo-original" },
      payload: {
        command_id: "command-todo-original",
        input: { operation: "update", todo_id: "todo-one", state: "done" },
      },
    });
    const conflict = await host.app.inject({
      method: "POST",
      url: "/api/runs/run-demo/todos",
      headers: { ...headers, "x-tracegraph-command-id": "command-todo-original" },
      payload: {
        command_id: "command-todo-original",
        input: { operation: "update", todo_id: "todo-one", state: "pending" },
      },
    });
    const newCommand = await host.app.inject({
      method: "POST",
      url: "/api/runs/run-demo/todos",
      headers: { ...headers, "x-tracegraph-command-id": "command-todo-new" },
      payload: {
        command_id: "command-todo-new",
        input: { operation: "update", todo_id: "todo-one", state: "done" },
      },
    });

    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(originalMutation);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: "idempotency_conflict" });
    expect(newCommand.statusCode).toBe(409);
    expect(newCommand.json()).toMatchObject({ error: "run_terminal" });
    expect(runtime.writeTodo).toHaveBeenCalledTimes(3);
    await host.close();
  });

  it("rejects the legacy manual mode at the strict public request boundary", async () => {
    const runtime = fakeRuntime();
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
    });
    const response = await host.app.inject({
      method: "POST",
      url: "/api/runs",
      headers: {
        origin,
        authorization: `Bearer ${token}`,
        "x-tracegraph-command-id": startInput.command_id,
      },
      payload: { ...startRequest, mode: "manual" },
    });
    expect(response.statusCode).toBe(400);
    expect(runtime.startRun).not.toHaveBeenCalled();
    await host.close();
  });

  it("enforces the P0 single-active-run boundary", async () => {
    const runtime = fakeRuntime();
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
    });
    const first = await host.app.inject({
      method: "POST",
      url: "/api/runs",
      headers: {
        origin,
        authorization: `Bearer ${token}`,
        "x-tracegraph-command-id": startRequest.command_id,
      },
      payload: startRequest,
    });
    const conflicting = await host.app.inject({
      method: "POST",
      url: "/api/runs",
      headers: {
        origin,
        authorization: `Bearer ${token}`,
        "x-tracegraph-command-id": startRequest.command_id,
      },
      payload: { ...startRequest, task: "different payload" },
    });
    const secondRequest = { ...startRequest, command_id: "command-start-2" };
    const second = await host.app.inject({
      method: "POST",
      url: "/api/runs",
      headers: {
        origin,
        authorization: `Bearer ${token}`,
        "x-tracegraph-command-id": secondRequest.command_id,
      },
      payload: secondRequest,
    });
    const rollbackDuringActiveRun = await host.app.inject({
      method: "POST",
      url: "/api/runs/run-demo/actions/action-demo/rollback",
      headers: {
        origin,
        authorization: `Bearer ${token}`,
        "x-tracegraph-command-id": "command-rollback-active",
      },
      payload: { command_id: "command-rollback-active", force: true },
    });

    expect(first.statusCode).toBe(200);
    expect(conflicting.statusCode).toBe(409);
    expect(second.statusCode).toBe(409);
    expect(rollbackDuringActiveRun.statusCode).toBe(409);
    expect(runtime.startRun).toHaveBeenCalledOnce();
    expect(runtime.rollback).not.toHaveBeenCalled();
    await host.close();
  });

  it("keeps an awaiting plan approval as the active Run", async () => {
    const pendingPlan: RunProjection = {
      ...projection,
      status: "awaiting_plan_approval",
      pending_plan: { plan_event_id: "event-plan-ready", todo_ids: ["todo-plan"] },
      todos: {
        items: [{
          todo_id: "todo-plan",
          title: "Review the plan",
          state: "pending",
          depends_on: [],
          evidence_event_ids: [],
          created_by: "model",
        }],
        last_sequence: 2,
      },
    };
    const runtime = fakeRuntime();
    vi.mocked(runtime.startRun).mockResolvedValue(pendingPlan);
    vi.mocked(runtime.getProjection).mockResolvedValue(pendingPlan);
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
    });
    const headers = { origin, authorization: `Bearer ${token}`, "content-type": "application/json" };

    const first = await host.app.inject({
      method: "POST",
      url: "/api/runs",
      headers: { ...headers, "x-tracegraph-command-id": startRequest.command_id },
      payload: startRequest,
    });
    const second = await host.app.inject({
      method: "POST",
      url: "/api/runs",
      headers: { ...headers, "x-tracegraph-command-id": "command-plan-contender" },
      payload: { ...startRequest, command_id: "command-plan-contender" },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    expect(runtime.startRun).toHaveBeenCalledOnce();
    await host.close();
  });

  it("cannot query or mutate a Runtime run outside this Host's registered projects", async () => {
    const runtime = fakeRuntime();
    const host = await createTraceGraphHost({
      runtime,
      projects: [{
        label: "Allowed project",
        workspace: {
          ...startInput.workspace,
          handle_id: "workspace-allowed",
          project_id: "project-allowed",
        },
      }],
      capabilityToken: token,
      now: () => now,
    });
    const headers = { authorization: `Bearer ${token}` };

    const query = await host.app.inject({
      method: "GET",
      url: "/api/runs/run-demo",
      headers,
    });
    const artifact = await host.app.inject({
      method: "GET",
      url: "/api/artifacts/artifact-demo?run_id=run-demo",
      headers,
    });
    const stream = await host.app.inject({
      method: "GET",
      url: "/api/runs/run-demo/events/stream",
      headers,
    });
    const liveStream = await host.app.inject({
      method: "GET",
      url: "/api/runs/run-demo/live/stream",
      headers,
    });
    const stop = await host.app.inject({
      method: "POST",
      url: "/api/runs/run-demo/stop",
      headers: {
        ...headers,
        origin,
        "x-tracegraph-command-id": "command-out-of-scope",
      },
      payload: {
        type: "stop",
        command_id: "command-out-of-scope",
        project_id: "project-demo",
        run_id: "run-demo",
      },
    });
    const rollback = await host.app.inject({
      method: "POST",
      url: "/api/runs/run-demo/actions/action-demo/rollback",
      headers: {
        ...headers,
        origin,
        "x-tracegraph-command-id": "command-rollback-out-of-scope",
      },
      payload: { command_id: "command-rollback-out-of-scope" },
    });

    expect([query.statusCode, artifact.statusCode, stream.statusCode, liveStream.statusCode, stop.statusCode, rollback.statusCode]).toEqual([
      404,
      404,
      404,
      404,
      404,
      404,
    ]);
    expect(runtime.getArtifact).not.toHaveBeenCalled();
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.rollback).not.toHaveBeenCalled();
    await host.close();
  });

  it("closes a live SSE response after it sends a terminal Run activity", async () => {
    const runtime = fakeRuntime();
    const terminal: LivePublicActivity = {
      schema_version: SCHEMA_VERSION,
      activity_id: "live:event-terminal",
      source_event_id: "event-terminal",
      source_event_type: "run.completed",
      project_id: "project-demo",
      run_id: "run-demo",
      sequence: 7,
      occurred_at: now.toISOString(),
      kind: "run",
      status: "completed",
      summary: "Run completed",
    };
    runtime.listLiveActivities = vi.fn(() => [terminal]);
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Allowed project", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
    });

    const response = await host.app.inject({
      method: "GET",
      url: "/api/runs/run-demo/live/stream",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"source_event_type":"run.completed"');
    expect(response.body).not.toContain("heartbeat");
    await host.close();
  });

  it("closes the live activity wait at plan.ready without treating the Run as terminal", async () => {
    const runtime = fakeRuntime();
    const planReady: LivePublicActivity = {
      schema_version: SCHEMA_VERSION,
      activity_id: "live:event-plan-ready",
      source_event_id: "event-plan-ready",
      source_event_type: "plan.ready",
      project_id: "project-demo",
      run_id: "run-demo",
      sequence: 6,
      occurred_at: now.toISOString(),
      kind: "run",
      status: "info",
      summary: "Plan ready for approval",
    };
    runtime.listLiveActivities = vi.fn(() => [planReady]);
    vi.mocked(runtime.getProjection).mockResolvedValue({
      ...projection,
      status: "awaiting_plan_approval",
      pending_plan: { plan_event_id: planReady.source_event_id, todo_ids: ["todo-plan"] },
    });
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Allowed project", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
    });

    const response = await host.app.inject({
      method: "GET",
      url: "/api/runs/run-demo/live/stream",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"source_event_type":"plan.ready"');
    expect(response.body).not.toContain("heartbeat");
    await host.close();
  });

  it("does not close an execute-stage live stream on a historical plan.ready activity", async () => {
    const runtime = fakeRuntime();
    const planReady: LivePublicActivity = {
      schema_version: SCHEMA_VERSION,
      activity_id: "live:event-plan-ready-old",
      source_event_id: "event-plan-ready-old",
      source_event_type: "plan.ready",
      project_id: "project-demo",
      run_id: "run-demo",
      sequence: 6,
      occurred_at: now.toISOString(),
      kind: "run",
      status: "info",
      summary: "Old plan ready for approval",
    };
    const terminal: LivePublicActivity = {
      schema_version: SCHEMA_VERSION,
      activity_id: "live:event-terminal-after-plan",
      source_event_id: "event-terminal-after-plan",
      source_event_type: "run.completed",
      project_id: "project-demo",
      run_id: "run-demo",
      sequence: 9,
      occurred_at: now.toISOString(),
      kind: "run",
      status: "completed",
      summary: "Run completed after plan approval",
    };
    runtime.listLiveActivities = vi.fn(() => [planReady, terminal]);
    vi.mocked(runtime.getProjection).mockResolvedValue({ ...projection, mode: "execute", status: "running" });
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Allowed project", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
    });

    const response = await host.app.inject({
      method: "GET",
      url: "/api/runs/run-demo/live/stream",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"source_event_type":"plan.ready"');
    expect(response.body).toContain('"source_event_type":"run.completed"');
    await host.close();
  });

  it("closes a live SSE response when Action reconciliation requires manual review", async () => {
    const runtime = fakeRuntime();
    const diverged: LivePublicActivity = {
      schema_version: SCHEMA_VERSION,
      activity_id: "live:event-diverged",
      source_event_id: "event-diverged",
      source_event_type: "action.diverged",
      project_id: "project-demo",
      run_id: "run-demo",
      sequence: 8,
      occurred_at: now.toISOString(),
      kind: "run",
      status: "failed",
      summary: "Workspace hash diverged",
    };
    runtime.listLiveActivities = vi.fn(() => [diverged]);
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Allowed project", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
    });

    const response = await host.app.inject({
      method: "GET",
      url: "/api/runs/run-demo/live/stream",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"source_event_type":"action.diverged"');
    expect(response.body).not.toContain("heartbeat");
    await host.close();
  });
});

describe("G07 subagent child Run reads", () => {
  const childProjection: RunProjection = {
    ...projection,
    session_id: "session-child",
    run_id: "run-child",
    task: "Inspect the delegated files",
    last_sequence: 1,
    timeline: [{
      schema_version: SCHEMA_VERSION,
      event_id: "event-child-created",
      project_id: "project-demo",
      session_id: "session-child",
      run_id: "run-child",
      sequence: 1,
      occurred_at: now.toISOString(),
      type: "run.created",
      summary: "Child Run created",
      artifact_refs: [],
      data: {
        task: "Inspect the delegated files",
        mode: "execute",
        workspace_kind: "readonly_local",
        parent_run_id: "run-demo",
        parent_session_id: "session-demo",
        subagent_id: "subagent-child",
        subagent_depth: 1,
      },
    }],
  };
  const parentProjection: RunProjection = {
    ...projection,
    last_sequence: 1,
    subagents: {
      items: [{
        link: {
          subagent_id: "subagent-child",
          parent_run_id: "run-demo",
          parent_session_id: "session-demo",
          child_run_id: "run-child",
          child_session_id: "session-child",
        },
        name: "readonly",
        provider_key: "parent",
        role_prompt_version: "tracegraph.subagent.readonly.v1",
        role_prompt_hash: `sha256:${"c".repeat(64)}`,
        tool_allowlist: ["search"],
        context_scope: "isolated",
        budget: { max_steps: 4, max_tokens: 4_000 },
        depth: 1,
        status: "running",
        started_event_id: "event-subagent-started",
        started_at: now.toISOString(),
        message_count: 1,
        initial_message_event_id: "event-subagent-message",
        last_message_at: now.toISOString(),
      }],
      active_count: 1,
      last_sequence: 1,
      limits: { max_parallel_subagents: 2, max_depth: 1 },
    },
  };

  it("loads only the child Run linked by the requested parent and project", async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.getProjection).mockImplementation(async (runId) => {
      if (runId === parentProjection.run_id) return parentProjection;
      if (runId === childProjection.run_id) return childProjection;
      throw new RuntimeCommandError("run_not_found", `Unknown Run ${runId}`);
    });
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
    });
    const authorization = { authorization: `Bearer ${token}` };

    const related = await host.app.inject({
      method: "GET",
      url: "/api/runs/run-demo/subagents/subagent-child",
      headers: authorization,
    });
    expect(related.statusCode).toBe(200);
    expect(related.headers["cache-control"]).toBe("private, no-store");
    expect(related.json()).toMatchObject({
      project_id: "project-demo",
      session_id: "session-child",
      run_id: "run-child",
    });

    const unrelated = await host.app.inject({
      method: "GET",
      url: "/api/runs/run-demo/subagents/subagent-unknown",
      headers: authorization,
    });
    expect(unrelated.statusCode).toBe(404);
    expect(unrelated.json()).toMatchObject({ error: "request_rejected" });
    await host.close();
  });

  it("rejects a mismatched child project and a replay bearer", async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.getProjection).mockImplementation(async (runId) => (
      runId === parentProjection.run_id
        ? parentProjection
        : { ...childProjection, project_id: "project-foreign" }
    ));
    vi.mocked(runtime.replayAt).mockResolvedValue(replaySnapshot());
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      sessions: fakeSessions(),
      capabilityToken: token,
      now: () => now,
    });
    const liveHeaders = {
      origin,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };

    const mismatched = await host.app.inject({
      method: "GET",
      url: "/api/runs/run-demo/subagents/subagent-child",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(mismatched.statusCode).toBe(500);
    expect(mismatched.json()).toEqual({
      error: "internal_error",
      message: "TraceGraph Host failed to process the request",
    });

    vi.mocked(runtime.getProjection).mockImplementation(async (runId) => (
      runId === parentProjection.run_id
        ? parentProjection
        : {
            ...childProjection,
            timeline: childProjection.timeline.map((event, index) => index === 0
              ? { ...event, data: { ...event.data, parent_run_id: "run-forged" } }
              : event),
          }
    ));
    const forgedProvenance = await host.app.inject({
      method: "GET",
      url: "/api/runs/run-demo/subagents/subagent-child",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(forgedProvenance.statusCode).toBe(500);
    expect(forgedProvenance.json()).toEqual({
      error: "internal_error",
      message: "TraceGraph Host failed to process the request",
    });

    const entered = await host.app.inject({
      method: "POST",
      url: "/api/replay",
      headers: liveHeaders,
      payload: { session_id: "session-demo", run_id: "run-demo", until_sequence: 2 },
    });
    expect(entered.statusCode).toBe(200);
    const replayToken = (entered.json() as { replay_token: string }).replay_token;
    const replayRead = await host.app.inject({
      method: "GET",
      url: "/api/runs/run-demo/subagents/subagent-child",
      headers: { authorization: `Bearer ${replayToken}` },
    });
    expect(replayRead.statusCode).toBe(403);
    expect(replayRead.json()).toMatchObject({ error: "replay_read_only" });
    await host.close();
  });
});

describe("G08 team control plane", () => {
  const link = {
    subagent_id: "member-one",
    parent_run_id: "run-team-root",
    parent_session_id: "session-team-root",
    child_run_id: "run-team-member",
    child_session_id: "session-team-member",
  } as const;
  const rootCreated = {
    schema_version: SCHEMA_VERSION,
    event_id: "event-team-root-created",
    project_id: "project-demo",
    session_id: "session-team-root",
    run_id: "run-team-root",
    sequence: 1,
    occurred_at: now.toISOString(),
    type: "run.created" as const,
    summary: "Team root created",
    artifact_refs: [],
    data: { task: "Coordinate the team", mode: "execute", workspace_kind: "readonly_local" },
  };
  const childCreated = {
    schema_version: SCHEMA_VERSION,
    event_id: "event-team-child-created",
    project_id: "project-demo",
    session_id: link.child_session_id,
    run_id: link.child_run_id,
    sequence: 1,
    occurred_at: now.toISOString(),
    type: "run.created" as const,
    summary: "Team member created",
    artifact_refs: [],
    data: {
      task: "Inspect the task",
      mode: "execute",
      workspace_kind: "readonly_local",
      parent_run_id: link.parent_run_id,
      parent_session_id: link.parent_session_id,
      subagent_id: link.subagent_id,
      subagent_depth: 1,
    },
  };
  const rootProjection: RunProjection = {
    ...projection,
    session_id: link.parent_session_id,
    run_id: link.parent_run_id,
    task: "Coordinate the team",
    mode: "execute",
    last_sequence: 3,
    timeline: [rootCreated],
    subagents: {
      items: [{
        link,
        name: "readonly",
        provider_key: "parent",
        role_prompt_version: "tracegraph.subagent.readonly.v1",
        role_prompt_hash: `sha256:${"c".repeat(64)}`,
        tool_allowlist: ["search"],
        context_scope: "isolated",
        budget: { max_steps: 4, max_tokens: 4_000 },
        depth: 1,
        status: "running",
        started_event_id: "event-subagent-started",
        started_at: now.toISOString(),
        message_count: 1,
        initial_message_event_id: "event-subagent-message",
        last_message_at: now.toISOString(),
      }],
      active_count: 1,
      last_sequence: 3,
      limits: { max_parallel_subagents: 2, max_depth: 1 },
    },
  };
  const childProjection: RunProjection = {
    ...projection,
    session_id: link.child_session_id,
    run_id: link.child_run_id,
    task: "Inspect the task",
    mode: "execute",
    last_sequence: 1,
    timeline: [childCreated],
  };
  const baseTeam: TeamProjection = {
    team_id: "team-one",
    coordinator_run_id: link.parent_run_id,
    limits: {
      max_parallel_workers: 4,
      heartbeat_timeout_ms: 30_000,
      max_members: 500,
      max_mailbox_messages: 500,
      max_tasks: 500,
    },
    created_event_id: "event-team-created",
    created_at: now.toISOString(),
    roster: {
      members: [{
        link,
        role: "readonly",
        status: "active",
        joined_at: now.toISOString(),
        last_heartbeat_at: now.toISOString(),
      }],
      last_sequence: 3,
    },
    mailbox: {
      messages: [{
        message_id: "message-one",
        from: "coordinator",
        to: link.subagent_id,
        kind: "steer",
        payload: "Inspect the claim race",
        delivered_at: now.toISOString(),
      }],
      last_sequence: 3,
    },
    task_board: {
      items: [{
        task_id: "task-one",
        title: "Inspect the claim race",
        state: "open",
        acceptance: ["Only one owner"],
        evidence_event_ids: [],
        version: 1,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      }],
      last_sequence: 3,
    },
    last_sequence: 3,
  };

  function createTeamRuntime() {
    const result = (commandId: string, team: TeamProjection = baseTeam) => ({
      command_id: commandId,
      disposition: "applied" as const,
      event_ids: ["event-team-mutation"],
      team,
    });
    const runtime = Object.assign(fakeRuntime(), {
      readTeam: vi.fn(async () => ({ team: baseTeam })),
      createTeam: vi.fn(async (
        _runId: string,
        _projectId: string,
        input: { command_id: string },
      ) => result(input.command_id)),
      sendTeamMailbox: vi.fn(async (
        _runId: string,
        _projectId: string,
        input: { command_id: string },
      ) => result(input.command_id)),
      sendTeamMailboxAsMember: vi.fn(async (
        _runId: string,
        _projectId: string,
        _subagentId: string,
        input: { command_id: string },
      ) => result(input.command_id)),
      claimTeamMailbox: vi.fn(async (
        _runId: string,
        _projectId: string,
        input: { command_id: string },
      ) => result(input.command_id)),
      claimTeamMailboxAsMember: vi.fn(async (
        _runId: string,
        _projectId: string,
        _subagentId: string,
        input: { command_id: string },
      ) => result(input.command_id)),
      writeTeamTask: vi.fn(async (
        _runId: string,
        _projectId: string,
        input: { command_id: string },
      ) => result(input.command_id)),
      writeTeamTaskAsMember: vi.fn(async (
        _runId: string,
        _projectId: string,
        _subagentId: string,
        input: { command_id: string },
      ) => result(input.command_id)),
      heartbeatTeamMember: vi.fn(async (
        _runId: string,
        _projectId: string,
        _subagentId: string,
        input: { command_id: string },
      ) => result(input.command_id)),
      expireTeamMembers: vi.fn(async (
        _runId: string,
        _projectId: string,
        input: { command_id: string },
      ) => result(input.command_id)),
    });
    vi.mocked(runtime.getProjection).mockImplementation(async (runId) => {
      if (runId === rootProjection.run_id) return rootProjection;
      if (runId === childProjection.run_id) return childProjection;
      throw new RuntimeCommandError("run_not_found", `Unknown Run ${runId}`);
    });
    return { runtime, result };
  }

  const liveHeaders = (commandId?: string) => ({
    origin,
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    ...(commandId === undefined ? {} : { "x-tracegraph-command-id": commandId }),
  });

  it("derives coordinator/member scope from canonical provenance and rejects wire authority injection", async () => {
    const { runtime } = createTeamRuntime();
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
    });

    const read = await host.app.inject({
      method: "GET",
      url: `/api/runs/${rootProjection.run_id}/team`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(read.statusCode).toBe(200);
    expect(read.headers["cache-control"]).toBe("private, no-store");
    expect(read.json()).toEqual({ team: baseTeam });
    expect(runtime.readTeam).toHaveBeenCalledWith(rootProjection.run_id, "project-demo");

    const created = await host.app.inject({
      method: "POST",
      url: `/api/runs/${rootProjection.run_id}/team`,
      headers: liveHeaders("command-team-create"),
      payload: { command_id: "command-team-create" },
    });
    expect(created.statusCode).toBe(200);
    expect(runtime.createTeam).toHaveBeenCalledWith(
      rootProjection.run_id,
      "project-demo",
      { command_id: "command-team-create" },
    );

    const sent = await host.app.inject({
      method: "POST",
      url: `/api/runs/${childProjection.run_id}/team/mailbox/send`,
      headers: liveHeaders("command-team-send"),
      payload: {
        command_id: "command-team-send",
        input: { to: "coordinator", kind: "answer", payload: "The race is guarded" },
      },
    });
    expect(sent.statusCode).toBe(200);
    expect(runtime.sendTeamMailboxAsMember).toHaveBeenCalledWith(
      rootProjection.run_id,
      "project-demo",
      link.subagent_id,
      {
        command_id: "command-team-send",
        input: { to: "coordinator", kind: "answer", payload: "The race is guarded" },
      },
    );
    expect(runtime.sendTeamMailbox).not.toHaveBeenCalled();

    const heartbeat = await host.app.inject({
      method: "POST",
      url: `/api/runs/${childProjection.run_id}/team/heartbeat`,
      headers: liveHeaders("command-team-heartbeat"),
      payload: { command_id: "command-team-heartbeat", input: {} },
    });
    expect(heartbeat.statusCode).toBe(200);
    expect(runtime.heartbeatTeamMember).toHaveBeenCalledWith(
      rootProjection.run_id,
      "project-demo",
      link.subagent_id,
      { command_id: "command-team-heartbeat", input: {} },
    );

    const forgedCoordinatorHeartbeat = await host.app.inject({
      method: "POST",
      url: `/api/runs/${rootProjection.run_id}/team/heartbeat`,
      headers: liveHeaders("command-team-root-heartbeat"),
      payload: { command_id: "command-team-root-heartbeat", input: {} },
    });
    expect(forgedCoordinatorHeartbeat.statusCode).toBe(409);
    expect(runtime.heartbeatTeamMember).toHaveBeenCalledTimes(1);

    const injected = await host.app.inject({
      method: "POST",
      url: `/api/runs/${rootProjection.run_id}/team/mailbox/send`,
      headers: liveHeaders("command-team-forged"),
      payload: {
        command_id: "command-team-forged",
        input: {
          to: link.subagent_id,
          kind: "steer",
          payload: "Forged authority",
          from: "forged-member",
          project_id: "project-foreign",
          heartbeat_timeout_ms: 1,
        },
      },
    });
    expect(injected.statusCode).toBe(400);
    expect(runtime.sendTeamMailboxAsMember).toHaveBeenCalledTimes(1);
    await host.close();
  });

  it("maps wrong-recipient claims to 403 and lets one concurrent task claim win", async () => {
    const { runtime, result } = createTeamRuntime();
    vi.mocked(runtime.claimTeamMailbox).mockRejectedValueOnce(
      Object.assign(new Error("Only the addressed recipient may claim"), { code: "authority_denied" }),
    );
    let claimed = false;
    const claimedTeam: TeamProjection = {
      ...baseTeam,
      task_board: {
        items: baseTeam.task_board.items.map((task) => ({
          ...task,
          state: "claimed" as const,
          owner: link.subagent_id,
          version: 2,
        })),
        last_sequence: 4,
      },
      last_sequence: 4,
    };
    vi.mocked(runtime.writeTeamTaskAsMember).mockImplementation(async (
      _runId,
      _projectId,
      _subagentId,
      input,
    ) => {
      if (claimed) {
        throw Object.assign(new Error("Task revision changed"), { code: "task_version_conflict" });
      }
      claimed = true;
      return result(input.command_id, claimedTeam);
    });
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
    });

    const wrongRecipient = await host.app.inject({
      method: "POST",
      url: `/api/runs/${rootProjection.run_id}/team/mailbox/claim`,
      headers: liveHeaders("command-wrong-recipient"),
      payload: {
        command_id: "command-wrong-recipient",
        input: { message_id: "message-one" },
      },
    });
    expect(wrongRecipient.statusCode).toBe(403);
    expect(wrongRecipient.json()).toMatchObject({ error: "authority_denied" });

    const claim = (commandId: string) => host.app.inject({
      method: "POST",
      url: `/api/runs/${childProjection.run_id}/team/tasks/write`,
      headers: liveHeaders(commandId),
      payload: {
        command_id: commandId,
        input: { operation: "claim", task_id: "task-one", expected_version: 1 },
      },
    });
    const claims = await Promise.all([claim("command-claim-one"), claim("command-claim-two")]);
    expect(claims.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
    expect(claims.find(({ statusCode }) => statusCode === 200)?.json()).toMatchObject({
      team: { task_board: { items: [{ task_id: "task-one", owner: link.subagent_id, version: 2 }] } },
    });
    expect(claims.find(({ statusCode }) => statusCode === 409)?.json()).toMatchObject({
      error: "task_version_conflict",
    });

    vi.mocked(runtime.writeTeamTask).mockRejectedValueOnce(
      Object.assign(new Error("Terminal Runs reject Team mutations"), { code: "run_terminal" }),
    );
    const terminalWrite = await host.app.inject({
      method: "POST",
      url: `/api/runs/${rootProjection.run_id}/team/tasks/write`,
      headers: liveHeaders("command-terminal-write"),
      payload: {
        command_id: "command-terminal-write",
        input: {
          operation: "create",
          task_id: "task-terminal",
          title: "Must not be written",
          acceptance: ["Rejected after Run terminal"],
        },
      },
    });
    expect(terminalWrite.statusCode).toBe(409);
    expect(terminalWrite.json()).toMatchObject({ error: "run_terminal" });
    await host.close();
  });

  it("sweeps with the frozen timeout contract and returns loss plus task reopen atomically", async () => {
    const { runtime, result } = createTeamRuntime();
    const lostAt = "2026-09-16T00:00:31.000Z";
    const sweptTeam: TeamProjection = {
      ...baseTeam,
      roster: {
        members: baseTeam.roster.members.map((member) => ({
          ...member,
          status: "lost" as const,
          lost_at: lostAt,
        })),
        last_sequence: 4,
      },
      task_board: {
        items: baseTeam.task_board.items.map((task) => ({
          ...task,
          state: "open" as const,
          version: 2,
          updated_at: lostAt,
        })),
        last_sequence: 4,
      },
      last_sequence: 4,
    };
    vi.mocked(runtime.expireTeamMembers).mockImplementation(async (
      _runId,
      _projectId,
      input,
    ) => (
      result(input.command_id, sweptTeam)
    ));
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      capabilityToken: token,
      now: () => now,
    });

    const injectedTimeout = await host.app.inject({
      method: "POST",
      url: `/api/runs/${rootProjection.run_id}/team/sweep`,
      headers: liveHeaders("command-sweep-forged"),
      payload: { command_id: "command-sweep-forged", heartbeat_timeout_ms: 1 },
    });
    expect(injectedTimeout.statusCode).toBe(400);
    expect(runtime.expireTeamMembers).not.toHaveBeenCalled();

    const swept = await host.app.inject({
      method: "POST",
      url: `/api/runs/${rootProjection.run_id}/team/sweep`,
      headers: liveHeaders("command-sweep"),
      payload: { command_id: "command-sweep" },
    });
    expect(swept.statusCode).toBe(200);
    expect(runtime.expireTeamMembers).toHaveBeenCalledWith(
      rootProjection.run_id,
      "project-demo",
      { command_id: "command-sweep" },
    );
    expect(swept.json()).toMatchObject({
      team: {
        limits: { heartbeat_timeout_ms: 30_000 },
        roster: { members: [{ status: "lost", lost_at: lostAt }] },
        task_board: { items: [{ state: "open", version: 2 }] },
      },
    });
    await host.close();
  });

  it("rejects Team reads and mutations under replay authority", async () => {
    const { runtime } = createTeamRuntime();
    vi.mocked(runtime.replayAt).mockResolvedValue(replaySnapshot());
    const host = await createTraceGraphHost({
      runtime,
      projects: [{ label: "Read-only demo", workspace: startInput.workspace }],
      sessions: fakeSessions(),
      capabilityToken: token,
      now: () => now,
    });
    const entered = await host.app.inject({
      method: "POST",
      url: "/api/replay",
      headers: liveHeaders(),
      payload: { session_id: "session-demo", run_id: "run-demo", until_sequence: 2 },
    });
    const replayToken = (entered.json() as { replay_token: string }).replay_token;

    const read = await host.app.inject({
      method: "GET",
      url: `/api/runs/${rootProjection.run_id}/team`,
      headers: { authorization: `Bearer ${replayToken}` },
    });
    const write = await host.app.inject({
      method: "POST",
      url: `/api/runs/${rootProjection.run_id}/team/sweep`,
      headers: {
        origin,
        authorization: `Bearer ${replayToken}`,
        "content-type": "application/json",
        "x-tracegraph-command-id": "command-replay-sweep",
      },
      payload: { command_id: "command-replay-sweep" },
    });
    expect(read.statusCode).toBe(403);
    expect(write.statusCode).toBe(403);
    expect(read.json()).toMatchObject({ error: "replay_read_only" });
    expect(write.json()).toMatchObject({ error: "replay_read_only" });
    expect(runtime.expireTeamMembers).not.toHaveBeenCalled();
    await host.close();
  });
});
