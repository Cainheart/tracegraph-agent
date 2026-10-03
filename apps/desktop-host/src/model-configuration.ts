import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ModelConfigUpdateRequestSchema,
  ModelProtocolSchema,
  ModelProviderSchema,
  NonEmptyStringSchema,
  PublicModelConfigResponseSchema,
  SafeCredentialMetadataSchema,
  SecretReferenceSchema,
  type ModelConfigUpdateRequest,
  type PublicModelConfigResponse,
} from "@tracegraph/contracts";
import {
  ConfigurableModelAdapter,
  credentialNameForProvider,
  credentialNameFromReference,
  createSecretReference,
  resolveSecretReference,
  validateModelProviderConfig,
  type CredentialStore,
  type ModelProviderConfig,
} from "@tracegraph/core";
import { z } from "zod";

const PersistedDesktopModelConfigSchema = z.object({
  provider: ModelProviderSchema,
  protocol: ModelProtocolSchema,
  base_url: z.string().url().max(500),
  model: NonEmptyStringSchema.max(200),
  credential_ref: SecretReferenceSchema,
}).strict();
type PersistedDesktopModelConfig = z.infer<typeof PersistedDesktopModelConfigSchema>;

const EmptyModelConfig = Object.freeze({
  provider: "openai" as const,
  protocol: "openai-chat-completions" as const,
  configured: false,
  base_url: "https://api.openai.com/v1",
  model: "gpt-4.1-mini",
  has_key: false,
});

export class DesktopModelConfiguration {
  readonly adapter: ConfigurableModelAdapter;
  readonly #path: string;
  readonly #credentialStore: CredentialStore;
  #config: ModelProviderConfig | undefined;
  #queue: Promise<void> = Promise.resolve();

  private constructor(options: {
    path: string;
    credentialStore: CredentialStore;
    config?: ModelProviderConfig;
  }) {
    this.#path = options.path;
    this.#credentialStore = options.credentialStore;
    this.#config = options.config;
    this.adapter = new ConfigurableModelAdapter({
      resolveCredential: async (reference) => (await resolveSecretReference(reference, this.#credentialStore)).value,
    });
    if (this.#config !== undefined) this.adapter.configure(this.#config);
  }

  static async open(options: { path: string; credentialStore: CredentialStore }): Promise<DesktopModelConfiguration> {
    const persisted = await readConfig(options.path);
    const config = persisted === undefined ? undefined : fromPersisted(persisted);
    return new DesktopModelConfiguration({
      path: options.path,
      credentialStore: options.credentialStore,
      ...(config === undefined ? {} : { config }),
    });
  }

  getModelConfig(): Promise<PublicModelConfigResponse> {
    return this.#serialize(async () => {
      if (this.#config === undefined) return PublicModelConfigResponseSchema.parse(EmptyModelConfig);
      const name = credentialNameFromReference(this.#config.credentialRef);
      const value = await this.#credentialStore.get(name);
      if (value === null) {
        return PublicModelConfigResponseSchema.parse({
          provider: this.#config.provider,
          protocol: this.#config.protocol,
          configured: true,
          base_url: this.#config.baseUrl,
          model: this.#config.model,
          has_key: false,
        });
      }
      const metadata = (await this.#credentialStore.list()).find((entry) => entry.name === name);
      if (metadata === undefined) throw new Error("Desktop credential metadata is unavailable");
      return PublicModelConfigResponseSchema.parse({
        provider: this.#config.provider,
        protocol: this.#config.protocol,
        configured: true,
        base_url: this.#config.baseUrl,
        model: this.#config.model,
        has_key: true,
        credential: SafeCredentialMetadataSchema.parse(metadata),
      });
    });
  }

  configureModel(inputValue: ModelConfigUpdateRequest): Promise<PublicModelConfigResponse> {
    const input = ModelConfigUpdateRequestSchema.parse(inputValue);
    return this.#serialize(async () => this.#configure(input));
  }

  async #configure(input: ModelConfigUpdateRequest): Promise<PublicModelConfigResponse> {
    const stagedCredentialName = input.api_key === undefined
      ? undefined
      : desktopCredentialName(input.provider);
    const credentialRef = stagedCredentialName !== undefined
      ? createSecretReference(stagedCredentialName)
      : this.#config?.provider === input.provider
        ? this.#config.credentialRef
        : createSecretReference(credentialNameForProvider(input.provider));
    const config = validateModelProviderConfig({
      provider: input.provider,
      protocol: input.protocol,
      baseUrl: input.base_url,
      model: input.model,
      credentialRef,
    });
    let credentialWriteAttempted = false;
    try {
      if (input.api_key !== undefined) {
        credentialWriteAttempted = true;
        await this.#credentialStore.set(stagedCredentialName!, input.api_key);
      }
      const resolved = await resolveSecretReference(credentialRef, this.#credentialStore);
      const persisted = toPersisted(config);
      const response = PublicModelConfigResponseSchema.parse({
        provider: config.provider,
        protocol: config.protocol,
        configured: true,
        base_url: config.baseUrl,
        model: config.model,
        has_key: true,
        credential: SafeCredentialMetadataSchema.parse(resolved.metadata),
      });
      const previousCredentialRef = this.#config?.credentialRef;
      await writeConfig(this.#path, persisted);
      this.#config = config;
      this.adapter.configure(config);
      if (previousCredentialRef !== undefined && previousCredentialRef !== credentialRef) {
        const previousName = credentialNameFromReference(previousCredentialRef);
        if (previousName.startsWith("TRACEGRAPH_DESKTOP_")) {
          await this.#credentialStore.delete(previousName).catch(() => undefined);
        }
      }
      return response;
    } catch (error) {
      if (credentialWriteAttempted) {
        await this.#credentialStore.delete(stagedCredentialName!).catch(() => undefined);
      }
      throw error;
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function desktopCredentialName(provider: ModelConfigUpdateRequest["provider"]): string {
  return `TRACEGRAPH_DESKTOP_${provider.toUpperCase()}_${randomUUID().replaceAll("-", "").toUpperCase()}`;
}

function fromPersisted(value: PersistedDesktopModelConfig): ModelProviderConfig {
  return validateModelProviderConfig({
    provider: value.provider,
    protocol: value.protocol,
    baseUrl: value.base_url,
    model: value.model,
    credentialRef: value.credential_ref,
  });
}

function toPersisted(config: ModelProviderConfig): PersistedDesktopModelConfig {
  return PersistedDesktopModelConfigSchema.parse({
    provider: config.provider,
    protocol: config.protocol,
    base_url: config.baseUrl,
    model: config.model,
    credential_ref: config.credentialRef,
  });
}

async function readConfig(path: string): Promise<PersistedDesktopModelConfig | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw new Error("Desktop model configuration must be a private regular file");
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error("Desktop model configuration has an unexpected owner");
    }
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let content: string;
    try {
      const openedInfo = await handle.stat();
      if (openedInfo.dev !== info.dev || openedInfo.ino !== info.ino) {
        throw new Error("Desktop model configuration changed while opening");
      }
      content = await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
    return PersistedDesktopModelConfigSchema.parse(JSON.parse(content));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw new Error("Desktop model configuration is invalid or unavailable");
  }
}

async function writeConfig(path: string, value: PersistedDesktopModelConfig): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new Error("Desktop model configuration directory must be a real directory");
  }
  if (typeof process.getuid === "function" && parentInfo.uid !== process.getuid()) {
    throw new Error("Desktop model configuration directory has an unexpected owner");
  }
  if ((parentInfo.mode & 0o077) !== 0) await chmod(parent, 0o700);
  const payload = PersistedDesktopModelConfigSchema.parse(value);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    });
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
