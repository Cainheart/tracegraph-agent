import {ConversationControl} from "../conversation-control.js";
import {registerConversationRoutes} from "../conversation-routes.js";
import {ProjectFilesFeedbackController} from "../project-files-feedback.js";
import {registerProjectFilesFeedbackRoutes} from "../project-files-feedback-routes.js";
import {ImageConfigController} from "./image-config.js";
import {atomicPrivateJson} from "../local-profile.js";
import {z} from "zod";
import {ModelProviderSchema,ModelProtocolSchema} from "@tracegraph/contracts";
import {WorkbenchSettingsValuesSchema,type WorkbenchSettingsValues} from "@tracegraph/contracts";
import {createTelemetrySink} from "@tracegraph/telemetry";
import {createHash} from "node:crypto";
import {SkillRegistry} from "@tracegraph/core";
import {WorkspaceCoordinator} from "../workspace-coordinator.js";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentRuntime,
  ConfigurableModelAdapter,
  CredentialNotFoundError,
  CredentialBackendError,
  DurableSessionController,
  EnvironmentCredentialStore,
  credentialNameFromReference,
  createPlatformCredentialStore,
  createManagedWorkspaceHandle,
  createReadonlyWorkspaceHandle,
  redactSensitiveText,
  recordCredentialMigration,
  resolveSecretReference,
  createMcpToolsExtension,
  createLspToolsExtension,
  createMediaToolsExtension,
} from "@tracegraph/core";
import { McpManager, readMcpConfig } from "@tracegraph/mcp";
import { LspManager, readLspConfig } from "@tracegraph/lsp";
import { JsonlSessionStore } from "@tracegraph/session";
import { ModelUsageReportSchema, UsageSnapshotSchema, type UsageSnapshot } from "@tracegraph/contracts";
import { createTraceGraphHost, type RegisteredProject, type TraceGraphHostOptions } from "../webserver/index.js";
import { closeHostAndFlushTelemetry, createCodeGraphProvider } from "./composition.js";
import {
  acknowledgeCredentialMigration,
  loadPrivateEnvFile,
  modelConfigFromEnvironment,
  persistModelConfig,
  readPersistedModelConfig,
  saveModelConfig,
} from "./model-config.js";
import {
  LocalProjectRegistry,
  revealLocalDirectory,
  selectLocalDirectory,
} from "./project-registry.js";
import { PermissionConfigController } from "./permission-config.js";
import { createConfiguredRetrieval } from "./retrieval-config.js";
import { createConfiguredTelemetry } from "./telemetry-config.js";
import { createConfiguredSubagents } from "./subagent-config.js";
import { HostExtensionController } from "./extension-config.js";

import {LeasedModelAdapter} from "./leased-model.js";
import {RecoveredRunPolicyGuard} from "./resume-policy.js";
import {RunSessionControllerError} from "@tracegraph/api";
import {createManagedProject,loadManagedProjects,removeManagedProject,readUsageSnapshot} from "./projects.js";
export interface HostCompositionOptions {
  readonly dataDir: string;
  readonly settings?:WorkbenchSettingsValues;
  readonly profileRoot?:string;
  readonly sessionDir: string;
  readonly repositoryRoot?: string;
  readonly args?: string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly permissionConfigPath?: string;
  readonly credentialFile?: string;
  readonly credentialStore?: import("@tracegraph/core").CredentialStore;
  readonly runtimeModel?: import("@tracegraph/core").ModelAdapter;
  readonly useEnvironmentModel?: boolean;
  readonly nativePicker?: boolean;
  readonly logger?: boolean;
  readonly admission?: "single" | "workspace";
  readonly isPrivateLocalRequest?: TraceGraphHostOptions["isPrivateLocalRequest"];
  readonly mutationLifecycle?: TraceGraphHostOptions["mutationLifecycle"];
}
export async function createHostComposition(options: HostCompositionOptions) {
  const dataDir = resolve(options.dataDir);
  const sessionDir = resolve(options.sessionDir);
  const repositoryRoot = resolve(options.repositoryRoot ?? dataDir);
  const args = options.args ?? [];
  const environment = options.environment ?? process.env;
  const settings=options.settings;
  let runSettings=settings;
  const extensionConfigPath = resolve(readFlag(args,"--extension-config") ?? environment.TRACEGRAPH_EXTENSION_CONFIG ?? resolve(dataDir,"extensions.json"));
  const mcpConfigPath = resolve(readFlag(args,"--mcp-config") ?? environment.TRACEGRAPH_MCP_CONFIG ?? resolve(dataDir,"mcp.json"));
  const lspConfigPath = resolve(readFlag(args,"--lsp-config") ?? environment.TRACEGRAPH_LSP_CONFIG ?? resolve(dataDir,"lsp.json"));
  await mkdir(dataDir,{recursive:true,mode:0o700});
  const setupCleanup:Array<()=>Promise<unknown>>=[];
  try {
  const subagents = createConfiguredSubagents({
    environment: environment,
    profilesFlag: readFlag(args, "--subagent-profiles"),
    maxParallelFlag: readFlag(args, "--max-parallel-subagents"),
    maxDepthFlag: readFlag(args, "--max-subagent-depth"),
    maxStepsFlag: readFlag(args, "--subagent-max-steps"),
    maxTokensFlag: readFlag(args, "--subagent-max-tokens"),
  });
  const permissionPresetFlag = readFlag(args, "--permission-preset");
  const sandboxModeFlag = readFlag(args, "--sandbox-mode");
  const permissionConfig = await PermissionConfigController.open({
    userConfigPath: options.permissionConfigPath ?? resolve(homedir(), ".tracegraph", "harness-config.json"),
    ...(permissionPresetFlag === undefined ? {} : { permissionPresetFlag }),
    ...(sandboxModeFlag === undefined ? {} : { sandboxModeFlag }),
    environment: environment,
  });
  const initialPermission = permissionConfig.snapshot();
  const modelConfigPath = resolve(dataDir, "model-config.json");
  const modelDraftPath=resolve(dataDir,"model-draft.json");
  const ModelDraftSchema=z.object({provider:ModelProviderSchema,protocol:ModelProtocolSchema,base_url:z.url(),model:z.string().min(1).max(200)}).strict();
  let modelDraft:z.infer<typeof ModelDraftSchema>|undefined;
  try{modelDraft=ModelDraftSchema.parse(JSON.parse(await readFile(modelDraftPath,"utf8")));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const credentialStore = options.credentialStore ?? createPlatformCredentialStore({
    fallbackFile: options.credentialFile ?? resolve(homedir(), ".tracegraph", "credentials.json"),
    environment: environment,
  });
  const imageSettings=await ImageConfigController.open(resolve(dataDir,"image-provider.json"),credentialStore);
  const telemetrySink = settings ? await createTelemetrySink(settings.telemetry.enabled ? {sink:"otlp_http"} : {sink:"noop"},{resolvedOtlp:{endpoint:settings.telemetry.endpoint,...(settings.telemetry.enabled && settings.telemetry.authorization_ref?{authorization:(await resolveSecretReference(settings.telemetry.authorization_ref,credentialStore)).value}:{})}}) : await createConfiguredTelemetry({
    dataDir,
    credentialStore,
    environment: environment,
  });
  const retrieval = createConfiguredRetrieval({ dataDir, environment: environment });
  const extensions = await HostExtensionController.open(extensionConfigPath,settings?.tools.disabled_extensions);
  await extensions.manager.activate(createMediaToolsExtension(imageSettings.provider));
  const mcpConfig = settings?.tools.mcp ?? await readMcpConfig(mcpConfigPath);
  const mcp = new McpManager({
    config: mcpConfig,
    cwd: repositoryRoot,
    environment: environment,
    resolveSecret: async (reference) => (await resolveSecretReference(reference, credentialStore)).value,
  });
  setupCleanup.push(()=>mcp.stop());
  await mcp.start();
  await extensions.manager.activate(createMcpToolsExtension(mcp));
  const lspConfig = settings?.tools.lsp ?? await readLspConfig(lspConfigPath);
  const lsp = new LspManager({
    config: lspConfig,
    cwd: repositoryRoot,
    environment: environment,
  });
  setupCleanup.push(()=>lsp.stop());
  await extensions.manager.activate(createLspToolsExtension(lsp));
  const sessionStore = new JsonlSessionStore(sessionDir, {
    trashRoot: resolve(dirname(sessionDir), "sessions-trash"),
    redactSensitiveText,
  });
  const managedRoot = resolve(dataDir, "projects");
  const chatRoot = resolve(dataDir, "chat-workspace");
  await Promise.all([
    mkdir(managedRoot, { recursive: true }),
    mkdir(chatRoot, { recursive: true }),
  ]);
  const localProjectRegistry = await LocalProjectRegistry.open({
    file: resolve(dataDir, "local-projects.json"),
    onWarning: (message) => process.stderr.write(`${message}\n`),
  });
  const projects: RegisteredProject[] = [
    ...(await loadManagedProjects(managedRoot)),
    ...localProjectRegistry.list(),
  ];
  const readonlyPath = readFlag(args, "--readonly");
  if (readonlyPath) {
    const workspace = await createReadonlyWorkspaceHandle({
      projectId: "local-readonly",
      root: resolve(readonlyPath),
    });
    projects.push({
      label: "Local repository (read-only)",
      workspace,
      location: {
        kind: "linked_directory",
        display_path: workspace.real_root,
        can_reveal: true,
        access: "read_only",
      },
    });
  }
  const chatWorkspaceBase = await createReadonlyWorkspaceHandle({
    projectId: "chat:local",
    root: chatRoot,
  });
  const chatWorkspace = {
    ...chatWorkspaceBase,
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

  const environmentConfig = options.useEnvironmentModel === false ? undefined : modelConfigFromEnvironment(environment);
  const environmentCredentialStore = new EnvironmentCredentialStore(environment);
  if (environmentConfig !== undefined) {
    // Register the exact normalized environment value before Runtime can
    // persist any task/event text, even before the first provider request.
    const name = credentialNameFromReference(environmentConfig.config.credentialRef);
    if (await environmentCredentialStore.get(name) === null) {
      throw new CredentialNotFoundError(name);
    }
  }
  const modelImageInput = parseOptInBoolean(
    environment.TRACEGRAPH_MODEL_IMAGE_INPUT,
    "TRACEGRAPH_MODEL_IMAGE_INPUT",
  );
  const model = new LeasedModelAdapter({
    capabilities: {
      image_input: modelImageInput,
    },
    resolveCredential: async (reference) => {
      if (environmentConfig?.config.credentialRef === reference) {
        const name = credentialNameFromReference(reference);
        const value = await environmentCredentialStore.get(name);
        if (value === null) throw new CredentialNotFoundError(name);
        return value;
      }
      return (await resolveSecretReference(reference, credentialStore)).value;
    },
  });
  // Inspect the persisted file even when the environment controls the active
  // model. Otherwise a legacy plaintext key could remain on disk forever.
  const persistedConfig = await readPersistedModelConfig(modelConfigPath, credentialStore, {
    verifyReferences: environmentConfig === undefined,
  });
  const initialConfig = environmentConfig ?? persistedConfig;
  let activeModelConfig = initialConfig;
  if (initialConfig) model.configure(initialConfig.config);
  const maxTurns = parsePositiveInteger(environment.TRACEGRAPH_MAX_TURNS) ?? 12;
  const rollbackPolicy = {
    enabled: environment.TRACEGRAPH_ROLLBACK_ENABLED === "true",
    allowForce: environment.TRACEGRAPH_ROLLBACK_ALLOW_FORCE === "true",
  };
  class ConfiguredSkillRegistry extends SkillRegistry {
    override async scan(root:string) {const snapshot=await super.scan(root);const disabled=new Set(settings?.tools.disabled_skills ?? []);const skills=snapshot.skills.filter(skill=>!disabled.has(skill.name));return {...snapshot,skills,registry_digest:`sha256:${createHash("sha256").update(JSON.stringify([snapshot.registry_digest,[...disabled].sort()])).digest("hex")}` as const};}
  }
  const runtime = await createAgentRuntime({
    dataDir,
    ...(settings?{v2MemoryRecallEnabled:settings.memory.memory_recall,experienceRecallEnabled:settings.memory.experience_recall,v2MemoryRecallProjectIds:settings.memory.project_ids,experienceRecallProjectIds:settings.memory.project_ids,skillRegistry:new ConfiguredSkillRegistry({userSkillsRoot:resolve(options.profileRoot ?? dataDir,"skills")})}:{}),
    telemetrySink,
    sessionStore,
    codeGraph: createCodeGraphProvider(),
    retriever: retrieval.retriever,
    model: options.runtimeModel ?? model,
    extensionManager: extensions.manager,
    mcpManager: mcp,
    lspManager: lsp,
    maxTurns: maxTurns,
    subagentRegistry: subagents.registry,
    maxParallelSubagents: subagents.limits.max_parallel_subagents,
    maxSubagentDepth: subagents.limits.max_depth,
    sandboxMode: initialPermission.selected_preset.sandbox_mode,
    permissionPolicyResolver: (workspace) => permissionConfig.resolveProject(workspace.real_root),
    rollbackPolicy,
  });
  setupCleanup.push(async()=>{await runtime.shutdownRuns?.();await runtime.shutdownBackgroundWork?.();});
  process.stderr.write(
    initialPermission.selected_preset.sandbox_mode === "danger-full-access"
      ? `Permission preset: ${initialPermission.selected_preset_key} (sandbox disabled)\n`
      : `Permission preset: ${initialPermission.selected_preset_key} (sandbox: ${initialPermission.selected_preset.sandbox_mode})\n`,
  );
  process.stderr.write(
    retrieval.mode === "local"
      ? "Retrieval: local JSONL/BM25\n"
      : `Retrieval: ${retrieval.remoteUrl} with local fallback\n`,
  );
  const mcpStatuses = mcp.listStatuses();
  process.stderr.write(
    `MCP: ${mcpStatuses.length === 0 ? "no configured servers" : mcpStatuses.map((status) => `${status.name}=${status.state}(${status.tool_count})`).join(", ")}\n`,
  );
  process.stderr.write(
    `LSP: ${lsp.snapshot().servers.length === 0 ? "no configured servers" : lsp.snapshot().servers.map((status) => `${status.name}=${status.state}`).join(", ")} (lazy)\n`,
  );
  process.stderr.write(
    `Subagents: ${subagents.profiles.map(({ name }) => name).join(", ")} (parallel ${subagents.limits.max_parallel_subagents}, depth ${subagents.limits.max_depth})\n`,
  );
  if (persistedConfig?.migration) {
    await recordCredentialMigration({
      dataDir,
      credential: persistedConfig.migration.credential,
      secretReference: persistedConfig.migration.secret_reference,
      migratedAt: persistedConfig.migration.migrated_at,
      migrationId: persistedConfig.migration.migration_id,
    });
    await acknowledgeCredentialMigration(
      modelConfigPath,
      persistedConfig.config,
      persistedConfig.migration.migration_id,
    );
    process.stderr.write(
      `Migrated legacy model credential ${persistedConfig.migration.credential.name} to ${persistedConfig.migration.credential.backend}.\n`,
    );
  }
  let modelSettingsQueue: Promise<void> = Promise.resolve();
  const recoveryWorkspaces = new Map(
    [...projects.map((project) => project.workspace), chatWorkspace]
      .map((workspace) => [workspace.project_id, workspace] as const),
  );
  const sessions = new DurableSessionController({
    store: sessionStore,
    runtime,
    workspaceResolver: (projectId) => recoveryWorkspaces.get(projectId),
  });
  let conversationControl:ConversationControl|undefined;
  let projectFiles:ProjectFilesFeedbackController|undefined;
  const modelSettings: NonNullable<TraceGraphHostOptions["modelSettings"]> = {
      get: () => ({
        ...model.publicConfig(),
        ...(!model.publicConfig().configured && modelDraft ? modelDraft : {}),
        has_key: activeModelConfig?.hasKey ?? false,
        ...(activeModelConfig?.credential === undefined ? {} : { credential: activeModelConfig.credential }),
      }),
      configure: (input) => {
        const update = modelSettingsQueue.then(async () => {
          const readOnlyCredential = environmentConfig?.credential
            ?? (activeModelConfig?.credential?.writable === false
              ? activeModelConfig.credential
              : undefined);
          if (readOnlyCredential !== undefined) {
            throw Object.assign(
              new Error(`Model settings are controlled by read-only credential ${readOnlyCredential.name}`),
              { statusCode: 409,code:"model_config_readonly" },
            );
          }
          const previousConfig = activeModelConfig;
          const nextConfig = await saveModelConfig({
            path: modelConfigPath,
            store: credentialStore,
            config: {
              provider: input.provider,
              protocol: input.protocol,
              baseUrl: input.baseUrl,
              model: input.model,
            },
            ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
            ...(activeModelConfig === undefined ? {} : { existing: activeModelConfig.config }),
          }).catch((error: unknown) => {
            if (error instanceof CredentialBackendError) throw Object.assign(new Error("The credential could not be saved in the private profile store"),{statusCode:503,code:"credential_storage_failed"});
            if (error instanceof CredentialNotFoundError) {
              throw Object.assign(
                new Error(`An API Key for ${input.provider} is required before these model settings can be saved`),
                { statusCode: 400,code:"credential_required" },
              );
            }
            throw error;
          });
          model.configure(nextConfig.config);
          activeModelConfig = nextConfig;
          await conversationControl?.syncDefault(nextConfig);
          modelDraft=undefined;
          await rm(modelDraftPath,{force:true});

          const previousReference = previousConfig?.config.credentialRef;
          if (
            previousReference !== undefined
            && previousReference !== nextConfig.config.credentialRef
            && previousConfig?.credential?.writable === true
          ) {
            const previousName = credentialNameFromReference(previousReference);
            model.retireCredential(previousReference, () => credentialStore.delete(previousName));
          }
        });
        modelSettingsQueue = update.catch(() => undefined);
        return update;
      },
    };
  const workspaceCoordinator=new WorkspaceCoordinator();
  workspaceCoordinator.setMaxParallelRuns(settings?.developer.max_parallel_runs ?? 4);
  const runLeases=new Map<string,{release():void}>();
  const recoveredPolicy=new RecoveredRunPolicyGuard(workspace=>permissionConfig.resolveProject(workspace.real_root),extensions.manager);
  const admissionTimer=setInterval(()=>{void Promise.all([...runLeases].map(async([runId,lease])=>{
    const projection=await runtime.getProjection(runId);
    if(["completed","failed","cancelled","interrupted","needs_manual_review"].includes(projection.status)){runLeases.delete(runId);lease.release();}
  })).catch(()=>undefined);},250);
  admissionTimer.unref();
  setupCleanup.push(async()=>{clearInterval(admissionTimer);});
  conversationControl=await ConversationControl.open({profileRoot:options.profileRoot??dataDir,store:credentialStore,model,defaultReasoningEffort:()=>runSettings?.model.reasoning_effort??"default",...(initialConfig?{initial:initialConfig}:{}),onDefaultChanged:async value=>{activeModelConfig=value;if(value){model.configure(value.config);await persistModelConfig(modelConfigPath,value.config);}else{model.clearConfiguration();await rm(modelConfigPath,{force:true});}},permission:permissionConfig,readSession:id=>sessions.read(id),resolveWorkspace:async id=>{const value=recoveryWorkspaces.get(id);if(!value)throw Object.assign(new Error("Project is not registered"),{statusCode:404});return value;},readFileContext:(projectId,path,policy)=>{if(!projectFiles)throw Object.assign(new Error("Project file context is not ready"),{statusCode:503,code:"file_context_unavailable"});return projectFiles.readContext(projectId,path,policy);},start:(input,trust)=>runtime.startRun(input,trust),...(options.runtimeModel?{fallbackModel:options.runtimeModel}:{})});
  const host = await createTraceGraphHost({
    prepareRunDispatch:(input,workspace)=>conversationControl!.prepare(input,workspace),
    runtime,
    sessions,
    projects,
    logger: options.logger ?? false,
    ...(options.isPrivateLocalRequest === undefined ? {} : { isPrivateLocalRequest: options.isPrivateLocalRequest }),
    ...(options.mutationLifecycle === undefined ? {} : { mutationLifecycle: options.mutationLifecycle }),
    admission: options.admission ?? "single",
    getDefaultReasoningEffort:()=>runSettings?.model.reasoning_effort ?? "default",
    ...(options.admission === "workspace" ? {withWorkspaceWrite:async<T>(workspace:import("@tracegraph/contracts").WorkspaceHandle,commandId:string,operation:()=>Promise<T>)=>{const lease=await workspaceCoordinator.acquireWorkspace(workspace,{holderId:commandId,kind:"git"});try{return await operation();}finally{lease.release();}}}:{}),
    ...(options.admission === "workspace" ? {
      beforeSessionResume:async({workspace,session})=>{const runId=session.header.run_ids.at(-1);if(!runId)throw new RunSessionControllerError(409,"session_run_unavailable","Session has no Run to resume");await recoveredPolicy.beforeResume(await runtime.getProjection(runId),workspace);},
      beforeRunApproval:async(projection)=>{const project=host.getRegisteredProject(projection.project_id);if(!project)throw new RunSessionControllerError(404,"run_project_unavailable","Run project is unavailable");await recoveredPolicy.beforeApproval(projection,project.workspace);},
      beforeRunStart: ({workspace,commandId,sessionId}:{workspace:import("@tracegraph/contracts").WorkspaceHandle;commandId:string;sessionId?:string}) => workspaceCoordinator.acquireWorkspace(workspace,{holderId:commandId,kind:"run",...(sessionId?{sessionId}:{}),readOnly:!(workspace.capabilities.commit_patch||workspace.capabilities.run_command||workspace.capabilities.test)}),
      onRunStarted: (projection:import("@tracegraph/contracts").RunProjection,lease:{release():void})=>{runLeases.set(projection.run_id,lease);},
    } : {}),
    modelSettings,
    imageSettings,
    permissionSettings: {
      get: () => permissionConfig.resolveSettings(),
      configure: async (input) => {
        await permissionConfig.setUserPreset(input.preset_key);
      },
    },
    extensions,
    mcp: {
      get: () => mcp.snapshot(),
      restart: (serverName) => mcp.restart(serverName),
    },
    lsp: {
      get: () => lsp.snapshot(),
    },
    usage: {
      get: () => readUsageSnapshot(dataDir),
    },
    projectFactory: async (input) => { const project = await createManagedProject(managedRoot, input.name); recoveryWorkspaces.set(project.workspace.project_id, project.workspace); return project; },
    localProjectSelector: async ({ access }) => {
      if (options.nativePicker === false) return undefined;
      const selectedRoot = await selectLocalDirectory(access);
      return selectedRoot === undefined
        ? undefined
        : localProjectRegistry.register(selectedRoot, access);
    },
    localProjectRemover: async (project) => {
      const removed = await localProjectRegistry.unregister(project.workspace.project_id);
      if (!removed) {
        throw Object.assign(new Error("The local project registration no longer exists"), { statusCode: 404 });
      }
    },
    projectRemover: async (project) => removeManagedProject(managedRoot, project),
    projectRevealer: async (project) => revealLocalDirectory(project.workspace.real_root),
    chatProject: {
      label: "Plain chat",
      workspace: chatWorkspace,
    },
  });
  projectFiles=await ProjectFilesFeedbackController.create({profileRoot:options.profileRoot??dataDir,runtime,permissionConfig,workspaceCoordinator,resolveWorkspace:async id=>{const project=host.getRegisteredProject(id);if(!project)throw Object.assign(new Error("Project is not registered"),{statusCode:404});return project.workspace;},resolvePolicy:(id,sessionId)=>conversationControl!.resolvePolicy(id,sessionId)});
  registerProjectFilesFeedbackRoutes(host.app,projectFiles);
  registerConversationRoutes(host.app,conversationControl);
  setupCleanup.length=0;
  return { host, runtime, model, workspaceCoordinator, imageSettings,conversationControl,projectFiles,fileContextAvailable:true,
    getImageConfig:()=>imageSettings.get(),
    capabilityOverrides:{"rollback.write":rollbackPolicy.enabled?{state:"available" as const,reason:rollbackPolicy.allowForce?"Linked workspace rollback requires explicit force confirmation":"Linked workspace rollback is denied; the Host force policy is disabled"}:{state:"policy-denied" as const,reason:"Rollback is disabled by the Host startup policy"}},
    updateRunSettings:(settings:WorkbenchSettingsValues)=>{runSettings=settings;workspaceCoordinator.setMaxParallelRuns(settings.developer.max_parallel_runs);},
    clearModelKey:async()=>{const update=modelSettingsQueue.then(async()=>{const previous=activeModelConfig;if(previous?.credential?.writable===false)throw Object.assign(new Error("Credential is read-only"),{statusCode:409,code:"model_config_readonly"});const publicConfig=modelSettings.get();const publicValue=await publicConfig;modelDraft=ModelDraftSchema.parse({provider:publicValue.provider,protocol:publicValue.protocol,base_url:publicValue.base_url,model:publicValue.model});await atomicPrivateJson(modelDraftPath,modelDraft);const savedConnections=conversationControl?.snapshot();const savedDefault=savedConnections?.connections.find(item=>item.connection_id===savedConnections.default_connection_id);if(savedDefault)await conversationControl!.save({command_id:"legacy-clear-"+randomUUID(),connection_id:savedDefault.connection_id,expected_revision:savedDefault.revision,label:savedDefault.label,provider:savedDefault.provider,protocol:savedDefault.protocol,base_url:savedDefault.base_url,model:savedDefault.model,models:savedDefault.models,clear_key:true});await rm(modelConfigPath,{force:true});model.clearConfiguration();activeModelConfig=undefined;await conversationControl?.syncDefault(undefined);if(previous?.credential?.writable)model.retireCredential(previous.config.credentialRef,()=>credentialStore.delete(credentialNameFromReference(previous.config.credentialRef)));});modelSettingsQueue=update.catch(()=>undefined);return update;}, modelSettings, permissionConfig, credentialStore, extensions, mcp, lsp,
    getModelConfig: modelSettings.get, configureModel: modelSettings.configure,
    listProjects: () => host.listRegisteredProjects(),
    resolveWorkspace: async (projectId: string) => { const project = host.getRegisteredProject(projectId); if (!project) throw Object.assign(new Error("Project is not registered"),{statusCode:404}); return project.workspace; },
    unregisterWorktree:async(root:string)=>{const canonical=await realpath(root).catch(error=>{if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;return resolve(root);});for(const project of host.listRegisteredProjects()){if(project.location?.kind!=="linked_directory" || project.workspace.real_root!==canonical)continue;await localProjectRegistry.unregister(project.workspace.project_id);host.unregisterProject(project.workspace.project_id);recoveryWorkspaces.delete(project.workspace.project_id);}},
    registerProject: async (selectedPath: string, access: "read_write" | "read_only") => { const project = await localProjectRegistry.register(selectedPath,access); host.registerProject(project); recoveryWorkspaces.set(project.workspace.project_id,project.workspace); return project; },
    close: async () => {
      clearInterval(admissionTimer);workspaceCoordinator.close();
      await runtime.shutdownRuns?.();
      return closeHostAndFlushTelemetry(() => host.close(),async()=>{await mcp.stop();await lsp.stop();await runtime.flushTelemetry();});
    },
  };
  }catch(error){for(const cleanup of setupCleanup.reverse())await cleanup().catch(()=>undefined);throw error;}
}
function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseOptInBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value.trim() === "" || value === "false" || value === "0") return false;
  if (value === "true" || value === "1") return true;
  throw new TypeError(`${name} must be true, false, 1, or 0`);
}
