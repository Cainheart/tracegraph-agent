import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import {
  EXTENSION_API_VERSION,
  EXTENSION_CONFIG_VERSION,
  ExtensionConfigSchema,
  ExtensionStatusSchema,
  type ExtensionCommandInvocation,
  type ExtensionCommandResult,
  type ExtensionConfig,
  type ExtensionReloadCommand,
  type ExtensionStatus,
} from "@tracegraph/contracts";
import {
  BUILTIN_ARTIFACT_TOOLS_EXTENSION,
  BUILTIN_RUN_STATE_TOOLS_EXTENSION,
  ExtensionManager,
  ExtensionManagerError,
  createArtifactToolsExtension,
  createCoreToolRegistry,
  createRunStateToolsExtension,
  type TraceGraphExtension,
} from "@tracegraph/core";

export const MAX_EXTENSION_CONFIG_BYTES = 256 * 1024;

type BuiltinExtensionName =
  | typeof BUILTIN_ARTIFACT_TOOLS_EXTENSION
  | typeof BUILTIN_RUN_STATE_TOOLS_EXTENSION;

const BUILTIN_EXTENSION_CATALOG = new Map<BuiltinExtensionName, () => TraceGraphExtension>([
  [BUILTIN_ARTIFACT_TOOLS_EXTENSION, createArtifactToolsExtension],
  [BUILTIN_RUN_STATE_TOOLS_EXTENSION, createRunStateToolsExtension],
]);

const DEFAULT_EXTENSION_CONFIG: ExtensionConfig = {
  config_version: EXTENSION_CONFIG_VERSION,
  extensions: [...BUILTIN_EXTENSION_CATALOG.keys()].map((name) => ({
    name,
    module: name,
    enabled: true,
    required: true,
  })),
};

export class HostExtensionController {
  readonly manager: ExtensionManager;
  readonly #configPath: string;
  #loadedAt = new Date(0).toISOString();

  private constructor(configPath: string, manager: ExtensionManager) {
    this.#configPath = configPath;
    this.manager = manager;
  }

  static async open(configPath: string): Promise<HostExtensionController> {
    const manager = new ExtensionManager({ toolRegistry: createCoreToolRegistry() });
    const controller = new HostExtensionController(configPath, manager);
    const loaded = await loadExtensionConfig(configPath);
    controller.#loadedAt = loaded.loadedAt;
    for (const entry of loaded.config.extensions) {
      if (!entry.enabled) continue;
      try {
        await manager.activate(createTrustedExtension(entry.name, entry.module));
      } catch (error) {
        if (entry.required) throw error;
      }
    }
    return controller;
  }

  list(): readonly ExtensionStatus[] {
    const byName = new Map(this.manager.listStatuses().map((status) => [status.name, status]));
    const generation = this.manager.snapshot().generation;
    return [...BUILTIN_EXTENSION_CATALOG.keys()]
      .map((name) => byName.get(name) ?? ExtensionStatusSchema.parse({
        name,
        api_version: EXTENSION_API_VERSION,
        state: "inactive",
        registration_count: 0,
        generation,
        updated_at: this.#loadedAt,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async reload(input: ExtensionReloadCommand): Promise<ExtensionStatus> {
    const factory = BUILTIN_EXTENSION_CATALOG.get(input.extension_name as BuiltinExtensionName);
    if (factory === undefined) {
      throw Object.assign(new Error(`Extension ${input.extension_name} is not in the trusted Host catalog`), {
        statusCode: 404,
      });
    }
    if (input.expected_config_digest !== undefined
      && input.expected_config_digest !== this.manager.snapshot().config_digest) {
      throw Object.assign(new Error("Extension configuration changed since it was read"), {
        statusCode: 409,
      });
    }
    const loaded = await loadExtensionConfig(this.#configPath);
    const entry = loaded.config.extensions.find(({ name }) => name === input.extension_name);
    const current = this.manager.listStatuses().find(({ name }) => name === input.extension_name);
    let status: ExtensionStatus;
    try {
      if (entry?.enabled === true) {
        const replacement = createTrustedExtension(entry.name, entry.module);
        status = current?.state === "active"
          ? await this.manager.reload(input.extension_name, replacement)
          : await this.manager.activate(replacement);
      } else if (current?.state === "active") {
        status = await this.manager.deactivate(input.extension_name);
      } else {
        status = ExtensionStatusSchema.parse({
          name: input.extension_name,
          api_version: EXTENSION_API_VERSION,
          state: "inactive",
          registration_count: 0,
          generation: this.manager.snapshot().generation,
          updated_at: loaded.loadedAt,
        });
      }
    } catch (error) {
      if (error instanceof ExtensionManagerError) {
        throw Object.assign(error, { statusCode: 409 });
      }
      throw error;
    }
    this.#loadedAt = loaded.loadedAt;
    return status;
  }

  runCommand(input: ExtensionCommandInvocation): Promise<ExtensionCommandResult> {
    return this.manager.invokeCommand(input);
  }
}

async function loadExtensionConfig(path: string): Promise<{ config: ExtensionConfig; loadedAt: string }> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (isMissingFile(error)) {
      return { config: DEFAULT_EXTENSION_CONFIG, loadedAt: new Date().toISOString() };
    }
    throw new Error(`Extension config must be a regular, non-symlink file: ${path}`, { cause: error });
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Extension config must be a regular file: ${path}`);
    if (stat.size > MAX_EXTENSION_CONFIG_BYTES) {
      throw new Error(`Extension config exceeds ${MAX_EXTENSION_CONFIG_BYTES} bytes`);
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_EXTENSION_CONFIG_BYTES) {
      throw new Error(`Extension config exceeds ${MAX_EXTENSION_CONFIG_BYTES} bytes`);
    }
    let json: unknown;
    try {
      json = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new Error(`Extension config is not valid JSON: ${path}`, { cause: error });
    }
    const config = ExtensionConfigSchema.parse(json);
    validateTrustedCatalog(config);
    return { config, loadedAt: new Date().toISOString() };
  } finally {
    await handle.close();
  }
}

function validateTrustedCatalog(config: ExtensionConfig): void {
  const modules = new Set<string>();
  for (const entry of config.extensions) {
    if (!BUILTIN_EXTENSION_CATALOG.has(entry.name as BuiltinExtensionName) || entry.module !== entry.name) {
      throw new Error(`Extension ${entry.name} is not in the trusted Host catalog`);
    }
    if (modules.has(entry.module)) throw new Error(`Extension module ${entry.module} is duplicated`);
    modules.add(entry.module);
  }
}

function createTrustedExtension(name: string, module: string): TraceGraphExtension {
  if (name !== module) throw new Error(`Extension ${name} must use its trusted catalog id as module`);
  const factory = BUILTIN_EXTENSION_CATALOG.get(name as BuiltinExtensionName);
  if (factory === undefined) throw new Error(`Extension ${name} is not in the trusted Host catalog`);
  return factory();
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
