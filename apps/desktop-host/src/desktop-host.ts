import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  MemoryExperienceController,
  RunInteractionController,
  RunSessionController,
} from "@tracegraph/api";
import {
  createAgentRuntime,
  DurableSessionController,
  redactSensitiveText,
  createPlatformCredentialStore,
  createReadonlyWorkspaceHandle,
  type AgentRuntime,
  type AgentRuntimeOptions,
  type CredentialStore,
  RuntimeCommandError,
  TodoDomainError,
} from "@tracegraph/core";
import { WorkspaceHandleSchema, type WorkspaceHandle, type ModelConfigUpdateRequest, type ProjectSummary, type PublicModelConfigResponse } from "@tracegraph/contracts";
import { JsonlSessionStore } from "@tracegraph/session";
import {
  ClientRpcDispatchError,
  serveFramedRpc,
  type ClientProtocolDispatcher,
} from "@tracegraph/sdk/server";
import { CLIENT_PROTOCOL_VERSION, type ClientCommand, type ClientQuery } from "@tracegraph/sdk/protocol";
import { DESKTOP_HOST_PACKAGE_NAME, DESKTOP_HOST_PACKAGE_VERSION } from "./identity.js";
import { DesktopModelConfiguration } from "./model-configuration.js";
import { DesktopProjectRegistry, type DesktopProjectAccess } from "./project-registry.js";

interface FramedRpcDuplex {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

export interface DesktopHostProject {
  readonly workspace: WorkspaceHandle;
}

export interface DesktopHostRuntimeOptions {
  readonly dataDir: string;
  readonly projects?: readonly DesktopHostProject[];
  readonly credentialStore?: CredentialStore;
  readonly runtimeOptions?: Partial<Omit<AgentRuntimeOptions, "dataDir" | "sessionStore">>;
  readonly createRuntime?: (options: AgentRuntimeOptions) => Promise<AgentRuntime>;
}

export interface DesktopHostIdentity {
  readonly package_name: typeof DESKTOP_HOST_PACKAGE_NAME;
  readonly package_version: typeof DESKTOP_HOST_PACKAGE_VERSION;
  readonly protocol_version: string;
}

export interface DesktopHostRuntime {
  readonly identity: DesktopHostIdentity;
  readonly sessionRecovery: Awaited<ReturnType<DurableSessionController["recover"]>>;
  readonly native: {
    listProjects(): ProjectSummary[];
    registerProject(input: { selectedPath: string; access: DesktopProjectAccess }): Promise<ProjectSummary>;
    removeProject(projectId: string): Promise<boolean>;
    resolveProjectRoot(projectId: string): Promise<string>;
    getModelConfig(): Promise<PublicModelConfigResponse>;
    configureModel(input: ModelConfigUpdateRequest): Promise<PublicModelConfigResponse>;
  };
  serve(duplex: FramedRpcDuplex): Promise<void>;
  close(): Promise<void>;
}

/** Composes one Desktop Host Runtime, persistent Session index, and first API controller slice. */
export async function createDesktopHostRuntime(options: DesktopHostRuntimeOptions): Promise<DesktopHostRuntime> {
  if (!isAbsolute(options.dataDir)) throw new TypeError("Desktop Host dataDir must be absolute");
  const dataDir = resolve(options.dataDir);
  await mkdir(dataDir, { recursive: true });
  const projectRegistry = await DesktopProjectRegistry.open({ file: join(dataDir, "projects.json") });
  const projects = new Map<string, WorkspaceHandle>();
  for (const workspace of projectRegistry.listWorkspaces()) projects.set(workspace.project_id, workspace);
  for (const project of options.projects ?? []) {
    const workspace = WorkspaceHandleSchema.parse(project.workspace);
    const previous = projects.get(workspace.project_id);
    if (previous !== undefined && previous.real_root !== workspace.real_root) {
      throw new TypeError("Desktop Host project ids must be unique");
    }
    projects.set(workspace.project_id, workspace);
  }
  const chatRoot = join(dataDir, "chat-workspace");
  await mkdir(chatRoot, { recursive: true });
  const chatWorkspace = WorkspaceHandleSchema.parse({
    ...await createReadonlyWorkspaceHandle({ projectId: "chat:desktop", root: chatRoot }),
    capabilities: { index: false, read: false, search: false, run_command: false, preview_patch: false, commit_patch: false, test: false },
  });
  if (projects.has(chatWorkspace.project_id)) throw new TypeError("The Desktop chat project identity is reserved");
  projects.set(chatWorkspace.project_id, chatWorkspace);

  const credentialStore = options.credentialStore ?? createPlatformCredentialStore({
    fallbackFile: join(dataDir, "credentials.json"),
    environment: {},
  });
  const modelConfiguration = await DesktopModelConfiguration.open({
    path: join(dataDir, "model-config.json"),
    credentialStore,
  });

  const sessionStore = new JsonlSessionStore(join(dataDir, "sessions"), {
    trashRoot: join(dataDir, "sessions-trash"),
    redactSensitiveText,
  });
  const runtimeOptions: AgentRuntimeOptions = {
    ...options.runtimeOptions,
    dataDir,
    sessionStore,
    model: modelConfiguration.adapter,
  };
  const runtime = await (options.createRuntime ?? createAgentRuntime)(runtimeOptions);
  const sessions = new DurableSessionController({
    store: sessionStore,
    runtime,
    workspaceResolver: (projectId) => projects.get(projectId),
  });

  try {
    const sessionRecovery = await sessions.recover();
    const controller = new RunSessionController({
      runtime,
      sessions,
      getWorkspace: (projectId) => projects.get(projectId),
      getProjectIds: () => [...projects.keys()],
      getChatWorkspace: () => chatWorkspace,
    });
    const memoryExperienceController = new MemoryExperienceController({
      runtime,
      getProjectIds: () => [...projects.keys()],
    });
    const interactions = new RunInteractionController(runtime, controller);
    const dispatcher = createDesktopHostDispatcher(controller, memoryExperienceController, interactions);
    let serving = false;
    let closePromise: Promise<void> | undefined;

    return {
      identity: {
        package_name: DESKTOP_HOST_PACKAGE_NAME,
        package_version: DESKTOP_HOST_PACKAGE_VERSION,
        protocol_version: CLIENT_PROTOCOL_VERSION,
      },
      sessionRecovery,
      native: {
        listProjects: () => projectRegistry.list(),
        async registerProject(input) {
          const summary = await projectRegistry.register(input.selectedPath, input.access);
          const workspace = projectRegistry.getWorkspace(summary.project_id);
          if (workspace === undefined) throw new Error("Registered Desktop project has no Workspace handle");
          const previous = projects.get(workspace.project_id);
          if (previous !== undefined && previous.real_root !== workspace.real_root) {
            throw new Error("Desktop project identity conflicts with an existing Host registration");
          }
          projects.set(workspace.project_id, workspace);
          return summary;
        },
        async removeProject(projectId) {
          const active = await controller.getActiveRunProjection();
          if (active?.project_id === projectId) {
            throw new Error("Stop the active Run before removing its project registration");
          }
          const removed = await projectRegistry.unregister(projectId);
          if (removed) projects.delete(projectId);
          return removed;
        },
        async resolveProjectRoot(projectId) {
          const workspace = projects.get(projectId);
          if (workspace === undefined) throw new Error("Project is not registered by this Desktop Host");
          const registered = projectRegistry.getWorkspace(projectId);
          if (registered !== undefined) return projectRegistry.resolveRoot(projectId);
          return resolve(workspace.real_root);
        },
        getModelConfig: () => modelConfiguration.getModelConfig(),
        configureModel: (input) => modelConfiguration.configureModel(input),
      },
      async serve(duplex) {
        if (serving) throw new Error("Desktop Host accepts one private RPC connection");
        if (closePromise !== undefined) throw new Error("Desktop Host is closed");
        serving = true;
        await serveFramedRpc(duplex, dispatcher);
      },
      close() {
        closePromise ??= (async () => {
          await runtime.shutdownBackgroundWork?.();
          await runtime.flushTelemetry();
        })();
        return closePromise;
      },
    };
  } catch (error) {
    await runtime.shutdownBackgroundWork?.();
    await runtime.flushTelemetry();
    throw error;
  }
}

export function createDesktopHostDispatcher(
  controller: RunSessionController,
  memoryExperience?: MemoryExperienceController,
  interactions?: RunInteractionController,
): ClientProtocolDispatcher {
  return {
    async handleCommand(command: ClientCommand) {
      if (command.type === "start_run") {
        return { resource: "run", value: await controller.startRun(command.input) };
      }
      try {
        switch (command.type) {
          case "chat.start": return { resource: "run", value: await controller.startChat(command.input) };
          case "session.resume": return { resource: "session_resume", value: await controller.resumeSession(command.session_id, command.input) };
          case "session.rename": return { resource: "session", value: await controller.renameSession(command.session_id, command.input) };
          case "session.delete": return { resource: "session_delete", value: await controller.deleteSession(command.session_id) };
          case "approve": case "reject": return { resource: "run", value: await requireInteractions(interactions).approval(command) };
          case "stop": return { resource: "run", value: await requireInteractions(interactions).stop(command) };
          case "run.approve_plan": return { resource: "run", value: await requireInteractions(interactions).approvePlan(command.run_id, command.input) };
          case "run.input": return { resource: "user_input", value: await requireInteractions(interactions).submitUserInput(command.run_id, command.input) };
          case "todo.write": return { resource: "todo_mutation", value: await requireInteractions(interactions).writeTodo(command.run_id, command.input) };
        }
      } catch (error) { throw mapControlDispatchError(error); }
      if (!command.type.startsWith("memory.") && !command.type.startsWith("experience.")) {
        throw new ClientRpcDispatchError("invalid_request", `Run command '${command.type}' is not supported by this Host slice`);
      }
      if (memoryExperience === undefined) {
        throw new ClientRpcDispatchError("unavailable", "Memory and Experience control is unavailable");
      }
      try {
        return await memoryExperience.dispatchCommand(command);
      } catch (error) {
        throw mapControlDispatchError(error);
      }
    },
    async handleQuery(query: ClientQuery) {
      switch (query.operation) {
        case "run.get":
          return { resource: "run", value: await controller.getRun(query.run_id) };
        case "session.list":
          return { resource: "sessions", value: await controller.listSessions(query.input) };
        case "session.get":
          return { resource: "session", value: await controller.getSession(query.session_id) };
        case "todo.list":
          try { return { resource: "todos", value: await requireInteractions(interactions).getTodos(query.run_id) }; }
          catch (error) { throw mapControlDispatchError(error); }
        case "artifact.get":
          try { return { resource: "artifact", value: await requireInteractions(interactions).getArtifact(query.run_id, query.artifact_id) }; }
          catch (error) { throw mapControlDispatchError(error); }
        case "memory.list":
          if (memoryExperience === undefined) throw new ClientRpcDispatchError("unavailable", "Memory control is unavailable");
          return memoryExperience.dispatchQuery(query);
        case "experience.list":
          if (memoryExperience === undefined) throw new ClientRpcDispatchError("unavailable", "Experience control is unavailable");
          return memoryExperience.dispatchQuery(query);
      }
    },
  };
}

function requireInteractions(controller: RunInteractionController | undefined): RunInteractionController {
  if (controller === undefined) throw new ClientRpcDispatchError("unavailable", "Run controls are unavailable");
  return controller;
}

function mapControlDispatchError(error: unknown): ClientRpcDispatchError {
  if (error instanceof ClientRpcDispatchError) return error;
  if (error instanceof RuntimeCommandError || error instanceof TodoDomainError) {
    const code = error.code === "run_not_found" || error.code === "todo_not_found" ? "not_found"
      : error.code.includes("capability") ? "forbidden" : "conflict";
    return new ClientRpcDispatchError(code, "Run control could not be processed");
  }
  if (error instanceof Error && error.name === "ZodError") return new ClientRpcDispatchError("invalid_request", "Control request did not match its contract");
  if (typeof error !== "object" || error === null) {
    return new ClientRpcDispatchError("internal", "Control operation could not be processed");
  }
  const record = error as { statusCode?: unknown; code?: unknown };
  if (record.code === "session_not_found") return new ClientRpcDispatchError("not_found", "Session was not found");
  if (["session_lease_conflict", "session_version_unsupported", "session_already_exists", "session_corrupt"].includes(String(record.code))) {
    return new ClientRpcDispatchError("conflict", "Session is being modified or failed integrity validation");
  }
  if (record.code === "session_path_unsafe" || record.code === "session_cursor_invalid") return new ClientRpcDispatchError("invalid_request", "Session identifier or cursor is invalid");
  const statusCode = typeof record.statusCode === "number" ? record.statusCode : undefined;
  const code = statusCode === 404 ? "not_found"
    : statusCode === 403 ? "forbidden"
      : statusCode === 409 || statusCode === 410 ? "conflict"
        : statusCode === 400 ? "invalid_request"
          : "internal";
  return new ClientRpcDispatchError(code, "Control operation could not be processed");
}
