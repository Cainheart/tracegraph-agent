#!/usr/bin/env node
import { createTranslator, terminalLocale } from "@tracegraph/sdk/client";
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
  credentialNameFromReference,
  createPlatformCredentialStore,
  createManagedWorkspaceHandle,
  createReadonlyWorkspaceHandle,
  redactSensitiveText,
  recordCredentialMigration,
  resolveSecretReference,
  createMcpToolsExtension,
  createLspToolsExtension,
} from "@tracegraph/core";
import { McpManager, readMcpConfig } from "@tracegraph/mcp";
import { LspManager, readLspConfig } from "@tracegraph/lsp";
import { JsonlSessionStore } from "@tracegraph/session";
import { ModelUsageReportSchema, UsageSnapshotSchema, type UsageSnapshot } from "@tracegraph/contracts";
import { createHostComposition,ensureLocalHost,acquireRuntimeRootLease } from "@tracegraph/host";
import {maybeRunWorkbenchCommand} from "./workbench-command.js";
import {maybeRunInteractiveChat} from "./interactive-chat.js";
import { closeHostAndFlushTelemetry, createCodeGraphProvider } from "./composition.js";
import { resolveCliProfile } from "./boot/profile.js";
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
import { runMemoryCommand } from "./memory-command.js";
import { runRunSessionCommand, RunSessionCommandError } from "./run-session-command.js";
import { HostExtensionController } from "./extension-config.js";

const command = process.argv[2] ?? "serve";
const interactiveExitCode = await maybeRunInteractiveChat(process.argv.slice(2));
const unifiedExitCode = interactiveExitCode ?? await maybeRunWorkbenchCommand(process.argv.slice(2));

if(unifiedExitCode!==undefined){process.exitCode=unifiedExitCode;}else if (command === "serve") {
  await runServer(process.argv.slice(3));
} else if (command === "extensions") {
  await runExtensionsCommand(process.argv.slice(3));
} else if (command === "team") {
  await runTeamCommand(process.argv.slice(3));
} else if (command === "skills") {
  await runSkillsCommand(process.argv.slice(3));
} else if (command === "mcp") {
  await runMcpCommand(process.argv.slice(3));
} else if (command === "memory") {
  await runMemoryCommand(process.argv.slice(3));
} else if (command === "run" || command === "sessions") {
  await runRunSessionCommand(command, process.argv.slice(3)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "CLI command failed"}\n`);
    process.exitCode = error instanceof RunSessionCommandError ? error.exitCode : 1;
  });
} else {
  process.stderr.write(`Unknown command: ${command}\n`);
  process.stderr.write("Usage: outlive serve [...] | outlive run start|get|events [...] | outlive sessions list|get [...] | outlive extensions ... | outlive team ... | outlive skills list|validate [...] | outlive mcp list|restart <server> | outlive memory list|show|candidate|review|correct|revoke|delete [...]\n");
  process.exitCode = 2;
}

async function runServer(args: string[]): Promise<void> {
  if(args.length===0 || args.every((value,index)=>index%2===0 ? value==="--profile-root" || value==="--http-port" : Boolean(value))) {
    if(args.length%2!==0)throw new Error("Each startup option requires a value");
    const requestedPort=readFlag(args,"--http-port");
    const httpPort=requestedPort===undefined?undefined:Number(requestedPort);
    if(httpPort!==undefined && (!/^\d+$/u.test(requestedPort!) || !Number.isInteger(httpPort) || httpPort<0 || httpPort>65535))throw new Error("--http-port must be an integer from 0 to 65535");
    const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const assets=resolve(repositoryRoot,"apps/web/dist");
    const hasAssets=await readFile(join(assets,"index.html")).then(()=>true,()=>false);
    const connection=await ensureLocalHost({...(readFlag(args,"--profile-root")?{profileRoot:readFlag(args,"--profile-root")!}:{}),...(httpPort===undefined?{}:{httpPort}),...(hasAssets?{webAssetRoot:assets}:{})});
    process.stdout.write(`Outlive Agent: ${connection.status.http_address}\nWeb Workbench: ${connection.status.http_address}\nProfile: ${connection.status.profile_root}\n`);
    await connection.close();return;
  }
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
  const leases:Array<Awaited<ReturnType<typeof acquireRuntimeRootLease>>>=[];
  let composition:Awaited<ReturnType<typeof createHostComposition>>;
  let address:string;
  try {
    for(const root of [...new Set([dataDir,sessionDir])].sort())leases.push(await acquireRuntimeRootLease(root));
    composition = await createHostComposition({dataDir,sessionDir,repositoryRoot,args,environment:process.env,logger:true});
    try {address = await composition.host.listen();}
    catch(error){await composition.close();throw error;}
  } catch(error) {
    for(const lease of leases.reverse())await lease.release();
    throw error;
  }
  const {host,model,close: closeComposition} = composition;
  const shutdown=async()=>{await closeComposition();for(const lease of leases.reverse())await lease.release();};
  const localize = createTranslator(terminalLocale(process.env));
  process.stdout.write(`${localize("Outlive Agent runtime")}: ${address}\n`);
  process.stdout.write(`${localize("Web Workbench")}: http://127.0.0.1:4310\n`);
  process.stdout.write(`${localize("Model configuration")}: ${model.publicConfig().configured ? "configured" : "not configured"}\n`);
  process.stdout.write(`${localize("Model image input")}: ${model.capabilities().image_input ? "enabled" : "disabled"}\n`);
  process.stdout.write(`${localize("Capability expires")}: ${host.expiresAt}\n`);

  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
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
