#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentRuntime,
  ConfigurableModelAdapter,
  CredentialNotFoundError,
  DurableSessionController,
  EnvironmentCredentialStore,
  JsonlSessionStore,
  McpManager,
  credentialNameFromReference,
  createPlatformCredentialStore,
  createManagedWorkspaceHandle,
  createReadonlyWorkspaceHandle,
  recordCredentialMigration,
  resolveSecretReference,
  createMcpToolsExtension,
  readMcpConfig,
  createLspToolsExtension,
  LspManager,
  readLspConfig,
} from "@tracegraph/core";
import { ModelUsageReportSchema, UsageSnapshotSchema, type UsageSnapshot } from "@tracegraph/contracts";
import { createTraceGraphHost, type RegisteredProject } from "@tracegraph/host";
import { closeHostAndFlushTelemetry, createCodeGraphProvider } from "./composition.js";
import { runExtensionsCommand } from "./extension-command.js";
import {
  acknowledgeCredentialMigration,
  loadPrivateEnvFile,
  modelConfigFromEnvironment,
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
import { runTeamCommand } from "./team-command.js";
import { runSkillsCommand } from "./skill-command.js";
import { runMcpCommand } from "./mcp-command.js";
import { HostExtensionController } from "./extension-config.js";

const command = process.argv[2] ?? "serve";

if (command === "serve") {
  await runServer(process.argv.slice(3));
} else if (command === "extensions") {
  await runExtensionsCommand(process.argv.slice(3));
} else if (command === "team") {
  await runTeamCommand(process.argv.slice(3));
} else if (command === "skills") {
  await runSkillsCommand(process.argv.slice(3));
} else if (command === "mcp") {
  await runMcpCommand(process.argv.slice(3));
} else {
  process.stderr.write(`Unknown command: ${command}\n`);
  process.stderr.write("Usage: tracegraph serve [...] | tracegraph extensions ... | tracegraph team ... | tracegraph skills list|validate [...] | tracegraph mcp list|restart <server>\n");
  process.exitCode = 2;
}

async function runServer(args: string[]): Promise<void> {
  const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const dataDir = resolve(readFlag(args, "--data-dir") ?? process.env.TRACEGRAPH_DATA_DIR ?? resolve(repositoryRoot, ".tracegraph"));
  const extensionConfigPath = resolve(
    readFlag(args, "--extension-config")
      ?? process.env.TRACEGRAPH_EXTENSION_CONFIG
      ?? resolve(dataDir, "extensions.json"),
  );
  const mcpConfigPath = resolve(
    readFlag(args, "--mcp-config")
      ?? process.env.TRACEGRAPH_MCP_CONFIG
      ?? resolve(dataDir, "mcp.json"),
  );
  const lspConfigPath = resolve(
    readFlag(args, "--lsp-config")
      ?? process.env.TRACEGRAPH_LSP_CONFIG
      ?? resolve(dataDir, "lsp.json"),
  );
  const sessionDir = resolve(
    readFlag(args, "--session-dir")
      ?? process.env.TRACEGRAPH_SESSION_DIR
      ?? resolve(homedir(), ".tracegraph", "sessions"),
  );
  const envFile = resolve(readFlag(args, "--env-file") ?? process.env.TRACEGRAPH_ENV_FILE ?? resolve(repositoryRoot, ".env.local"));
  loadPrivateEnvFile(envFile);
  const subagents = createConfiguredSubagents({
    environment: process.env,
    profilesFlag: readFlag(args, "--subagent-profiles"),
    maxParallelFlag: readFlag(args, "--max-parallel-subagents"),
    maxDepthFlag: readFlag(args, "--max-subagent-depth"),
    maxStepsFlag: readFlag(args, "--subagent-max-steps"),
    maxTokensFlag: readFlag(args, "--subagent-max-tokens"),
  });
  const permissionPresetFlag = readFlag(args, "--permission-preset");
  const sandboxModeFlag = readFlag(args, "--sandbox-mode");
  const permissionConfig = await PermissionConfigController.open({
    userConfigPath: resolve(homedir(), ".tracegraph", "harness-config.json"),
    ...(permissionPresetFlag === undefined ? {} : { permissionPresetFlag }),
    ...(sandboxModeFlag === undefined ? {} : { sandboxModeFlag }),
    environment: process.env,
  });
  const initialPermission = permissionConfig.snapshot();
  const modelConfigPath = resolve(dataDir, "model-config.json");
  const credentialStore = createPlatformCredentialStore({
    fallbackFile: resolve(homedir(), ".tracegraph", "credentials.json"),
    environment: process.env,
  });
  const telemetrySink = await createConfiguredTelemetry({
    dataDir,
    credentialStore,
    environment: process.env,
  });
  const retrieval = createConfiguredRetrieval({ dataDir, environment: process.env });
  const extensions = await HostExtensionController.open(extensionConfigPath);
  const mcp = new McpManager({
    config: await readMcpConfig(mcpConfigPath),
    cwd: repositoryRoot,
    environment: process.env,
    resolveSecret: async (reference) => (await resolveSecretReference(reference, credentialStore)).value,
  });
  await mcp.start();
  await extensions.manager.activate(createMcpToolsExtension(mcp));
  const lsp = new LspManager({
    config: await readLspConfig(lspConfigPath),
    cwd: repositoryRoot,
    environment: process.env,
  });
  await extensions.manager.activate(createLspToolsExtension(lsp));
  const sessionStore = new JsonlSessionStore(sessionDir, {
    trashRoot: resolve(dirname(sessionDir), "sessions-trash"),
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

  const environmentConfig = modelConfigFromEnvironment(process.env);
  const environmentCredentialStore = new EnvironmentCredentialStore(process.env);
  if (environmentConfig !== undefined) {
    // Register the exact normalized environment value before Runtime can
    // persist any task/event text, even before the first provider request.
    const name = credentialNameFromReference(environmentConfig.config.credentialRef);
    if (await environmentCredentialStore.get(name) === null) {
      throw new CredentialNotFoundError(name);
    }
  }
  const model = new ConfigurableModelAdapter({
    capabilities: {
      image_input: parseOptInBoolean(
        process.env.TRACEGRAPH_MODEL_IMAGE_INPUT,
        "TRACEGRAPH_MODEL_IMAGE_INPUT",
      ),
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
  const runtime = await createAgentRuntime({
    dataDir,
    telemetrySink,
    sessionStore,
    codeGraph: createCodeGraphProvider(),
    retriever: retrieval.retriever,
    model,
    extensionManager: extensions.manager,
    mcpManager: mcp,
    lspManager: lsp,
    maxTurns: parsePositiveInteger(process.env.TRACEGRAPH_MAX_TURNS) ?? 12,
    subagentRegistry: subagents.registry,
    maxParallelSubagents: subagents.limits.max_parallel_subagents,
    maxSubagentDepth: subagents.limits.max_depth,
    sandboxMode: initialPermission.selected_preset.sandbox_mode,
    permissionPolicyResolver: (workspace) => permissionConfig.resolveProject(workspace.real_root),
    rollbackPolicy: {
      enabled: process.env.TRACEGRAPH_ROLLBACK_ENABLED === "true",
      allowForce: process.env.TRACEGRAPH_ROLLBACK_ALLOW_FORCE === "true",
    },
  });
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
  const host = await createTraceGraphHost({
    runtime,
    sessions,
    projects,
    logger: true,
    modelSettings: {
      get: () => ({
        ...model.publicConfig(),
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
              { statusCode: 409 },
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
            if (error instanceof CredentialNotFoundError) {
              throw Object.assign(
                new Error(`An API Key for ${input.provider} is required before these model settings can be saved`),
                { statusCode: 400 },
              );
            }
            throw error;
          });
          model.configure(nextConfig.config);
          activeModelConfig = nextConfig;

          const previousReference = previousConfig?.config.credentialRef;
          if (
            previousReference !== undefined
            && previousReference !== nextConfig.config.credentialRef
            && previousConfig?.credential?.writable === true
          ) {
            const previousName = credentialNameFromReference(previousReference);
            // A request that captured the old immutable config may still be
            // resolving its credential. Give it a bounded grace period before
            // removing the superseded value.
            const cleanup = setTimeout(() => {
              void credentialStore.delete(previousName).catch(() => {
                process.stderr.write(`The superseded credential ${previousName} could not be removed; no credential value was logged.\n`);
              });
            }, 60_000);
            cleanup.unref();
          }
        });
        modelSettingsQueue = update.catch(() => undefined);
        return update;
      },
    },
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
    projectFactory: (input) => createManagedProject(managedRoot, input.name),
    localProjectSelector: async ({ access }) => {
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
  const address = await host.listen();
  process.stdout.write(`TraceGraph Host: ${address}\n`);
  process.stdout.write("Web Workbench: http://127.0.0.1:4310\n");
  process.stdout.write(`Model configuration: ${environmentConfig ? "environment" : persistedConfig?.credential?.backend ?? (persistedConfig ? "reference missing" : "not configured")}\n`);
  process.stdout.write(`Model image input: ${model.capabilities().image_input ? "enabled" : "disabled"}\n`);
  process.stdout.write(`Capability expires: ${host.expiresAt}\n`);

  const shutdown = async (): Promise<void> => {
    await closeHostAndFlushTelemetry(
      () => host.close(),
      async () => {
        await mcp.stop();
        await lsp.stop();
        await runtime.flushTelemetry();
      },
    );
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

/** Build the settings usage view from the same durable event ledger consumed by
 * replay and recovery. Malformed/unknown lines are ignored so one damaged
 * historical file cannot make the settings page unavailable. */
async function readUsageSnapshot(dataDir: string): Promise<UsageSnapshot> {
  const eventsRoot = join(dataDir, "events");
  let entries: readonly import("node:fs").Dirent[] = [];
  try {
    entries = await readdir(eventsRoot, { withFileTypes: true });
  } catch {
    return UsageSnapshotSchema.parse({
      schema_version: "tracegraph.usage.v1",
      generated_at: new Date().toISOString(),
      source: "ledger",
      run_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0,
      costs: [],
    });
  }

  const runIds = new Set<string>();
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let reasoningOutputTokens = 0;
  let totalTokens = 0;
  const costs = new Map<string, number>();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    let content: string;
    try {
      content = await readFile(join(eventsRoot, entry.name), "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!event || typeof event !== "object") continue;
      const record = event as Record<string, unknown>;
      if (record.type === "run.created" && typeof record.run_id === "string") {
        runIds.add(record.run_id);
      }
      if (record.type !== "model.usage_reported" || !record.data || typeof record.data !== "object") continue;
      const data = record.data as Record<string, unknown>;
      const parsed = ModelUsageReportSchema.safeParse({
        provider: data.provider,
        model: data.model,
        input_tokens: data.input_tokens,
        output_tokens: data.output_tokens,
        ...(data.cached_input_tokens === undefined ? {} : { cached_input_tokens: data.cached_input_tokens }),
        ...(data.reasoning_output_tokens === undefined ? {} : { reasoning_output_tokens: data.reasoning_output_tokens }),
        total_tokens: data.total_tokens,
        request_kind: data.request_kind,
        request_sequence: data.request_sequence,
        ...(data.provider_reported_cost === undefined ? {} : { provider_reported_cost: data.provider_reported_cost }),
      });
      if (!parsed.success) continue;
      const usage = parsed.data;
      inputTokens += usage.input_tokens;
      outputTokens += usage.output_tokens;
      cachedInputTokens += usage.cached_input_tokens ?? 0;
      reasoningOutputTokens += usage.reasoning_output_tokens ?? 0;
      totalTokens += usage.total_tokens;
      if (usage.provider_reported_cost) {
        const currency = usage.provider_reported_cost.currency;
        costs.set(currency, (costs.get(currency) ?? 0) + usage.provider_reported_cost.amount);
      }
    }
  }

  return UsageSnapshotSchema.parse({
    schema_version: "tracegraph.usage.v1",
    generated_at: new Date().toISOString(),
    source: "ledger",
    run_count: runIds.size,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cached_input_tokens: cachedInputTokens,
    reasoning_output_tokens: reasoningOutputTokens,
    total_tokens: totalTokens,
    costs: [...costs.entries()].map(([currency, amount]) => ({ currency, amount })),
  });
}

/** Remove only a project created inside the Host's managed workspace root. */
async function removeManagedProject(managedRoot: string, project: RegisteredProject): Promise<void> {
  const managedRootCanonical = await realpath(managedRoot);
  const projectRoot = await realpath(project.workspace.real_root);
  const relativeRoot = relative(managedRootCanonical, projectRoot);
  if (!relativeRoot || relativeRoot.startsWith("..") || isAbsolute(relativeRoot)) {
    throw Object.assign(new Error("Refusing to remove a project outside the Host managed workspace"), { statusCode: 403 });
  }
  await rm(projectRoot, { recursive: true, force: true });
}

async function createManagedProject(managedRoot: string, name: string): Promise<RegisteredProject> {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 40) || "project";
  const projectId = `project:${slug}:${randomUUID().slice(0, 8)}`;
  const root = resolve(managedRoot, `${slug}-${projectId.slice(-8)}`);
  await mkdir(resolve(root, "src"), { recursive: true });
  await Promise.all([
    writeFile(resolve(root, ".tracegraph-project.json"), JSON.stringify({ project_id: projectId, label: name }, null, 2), { flag: "wx" }),
    writeFile(resolve(root, "README.md"), `# ${name}\n\nCreated and managed by TraceGraph.\n`, { flag: "wx" }),
    writeFile(resolve(root, "package.json"), `${JSON.stringify({ name: slug, version: "0.1.0", private: true, type: "module" }, null, 2)}\n`, { flag: "wx" }),
    writeFile(resolve(root, "src/index.ts"), `export function hello(): string {\n  return "Hello from ${name.replace(/["\\]/gu, "")}";\n}\n`, { flag: "wx" }),
  ]);
  return {
    label: name,
    workspace: await createManagedWorkspaceHandle({ projectId, root }),
    location: {
      kind: "managed_storage",
      display_path: root,
      can_reveal: true,
      access: "read_write",
    },
  };
}

async function loadManagedProjects(managedRoot: string): Promise<RegisteredProject[]> {
  const entries = await readdir(managedRoot, { withFileTypes: true });
  const loaded: RegisteredProject[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const root = resolve(managedRoot, entry.name);
    try {
      const metadata = JSON.parse(await readFile(resolve(root, ".tracegraph-project.json"), "utf8")) as { project_id?: unknown; label?: unknown };
      if (typeof metadata.project_id !== "string" || typeof metadata.label !== "string") continue;
      loaded.push({
        label: metadata.label,
        workspace: await createManagedWorkspaceHandle({ projectId: metadata.project_id, root }),
        location: {
          kind: "managed_storage",
          display_path: root,
          can_reveal: true,
          access: "read_write",
        },
      });
    } catch {
      process.stderr.write(`Skipped invalid managed project metadata in ${basename(root)}\n`);
    }
  }
  return loaded;
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
