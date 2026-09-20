import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { loadEnvFile } from "node:process";
import {
  CredentialMigrationMarkerSchema,
  ModelProtocolSchema,
  ModelProviderSchema,
  SecretReferenceSchema,
  type CredentialMigrationMarker,
  type ModelProtocol,
  type ModelProvider,
  type SafeCredentialMetadata,
  type SecretReference,
} from "@tracegraph/contracts";
import {
  CredentialNotFoundError,
  createSecretReference,
  credentialNameForProvider,
  credentialNameFromReference,
  type CredentialStore,
  type ModelProviderConfig,
  validateModelProviderConfig,
} from "@tracegraph/core";

const PROVIDER_DEFAULTS: Record<Exclude<ModelProvider, "custom">, Omit<ModelProviderConfig, "credentialRef">> = {
  openai: { provider: "openai", protocol: "openai-chat-completions", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
  deepseek: { provider: "deepseek", protocol: "openai-chat-completions", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" },
  glm: { provider: "glm", protocol: "openai-chat-completions", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.5" },
  qwen: { provider: "qwen", protocol: "openai-chat-completions", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  minimax: { provider: "minimax", protocol: "openai-chat-completions", baseUrl: "https://api.minimax.io/v1", model: "MiniMax-M2.1" },
  anthropic: { provider: "anthropic", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-6" },
};

type Environment = Record<string, string | undefined>;

export type CredentialMigration = CredentialMigrationMarker;

export interface LoadedModelConfig {
  config: ModelProviderConfig;
  hasKey: boolean;
  credential?: SafeCredentialMetadata;
  migration?: CredentialMigration;
}

interface ParsedPersistedModelConfig {
  provider: ModelProvider;
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
  credentialMigration?: CredentialMigration;
}

export function loadPrivateEnvFile(path: string): boolean {
  try {
    loadEnvFile(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Build a reference-only model configuration. The environment value remains
 * in `process.env` and is resolved by EnvironmentCredentialStore immediately
 * before each provider request.
 */
export function modelConfigFromEnvironment(environment: Environment): LoadedModelConfig | undefined {
  const explicitKey = clean(environment.TRACEGRAPH_MODEL_API_KEY);
  const explicitProvider = parseProvider(environment.TRACEGRAPH_MODEL_PROVIDER);

  if (explicitKey) {
    if (explicitKey.length < 8) throw new TypeError("TRACEGRAPH_MODEL_API_KEY must contain at least 8 characters");
    const provider = explicitProvider ?? "custom";
    const defaults = provider === "custom" ? undefined : PROVIDER_DEFAULTS[provider];
    const protocol = parseProtocol(environment.TRACEGRAPH_MODEL_PROTOCOL) ?? defaults?.protocol ?? "openai-chat-completions";
    const baseUrl = clean(environment.TRACEGRAPH_MODEL_BASE_URL) ?? defaults?.baseUrl;
    const model = clean(environment.TRACEGRAPH_MODEL) ?? defaults?.model;
    if (!baseUrl || !model) {
      throw new Error("TRACEGRAPH_MODEL_BASE_URL and TRACEGRAPH_MODEL are required when TRACEGRAPH_MODEL_PROVIDER is custom");
    }
    const name = "TRACEGRAPH_MODEL_API_KEY";
    return {
      config: validateModelProviderConfig({ provider, protocol, baseUrl, model, credentialRef: createSecretReference(name) }),
      hasKey: true,
      credential: { name, backend: "environment", writable: false },
    };
  }

  const inferred = [
    ["deepseek", "DEEPSEEK_API_KEY", environment.DEEPSEEK_API_KEY],
    ["openai", "OPENAI_API_KEY", environment.OPENAI_API_KEY],
    ["anthropic", "ANTHROPIC_API_KEY", environment.ANTHROPIC_API_KEY],
    ["glm", clean(environment.GLM_API_KEY) ? "GLM_API_KEY" : "ZHIPU_API_KEY", clean(environment.GLM_API_KEY) ?? environment.ZHIPU_API_KEY],
    ["qwen", clean(environment.QWEN_API_KEY) ? "QWEN_API_KEY" : "DASHSCOPE_API_KEY", clean(environment.QWEN_API_KEY) ?? environment.DASHSCOPE_API_KEY],
    ["minimax", "MINIMAX_API_KEY", environment.MINIMAX_API_KEY],
  ] as const;
  const match = inferred.find(([, , value]) => clean(value));
  if (!match) return undefined;
  const [provider, name, matchedValue] = match;
  if ((clean(matchedValue)?.length ?? 0) < 8) {
    throw new TypeError(`${name} must contain at least 8 characters`);
  }
  return {
    config: validateModelProviderConfig({ ...PROVIDER_DEFAULTS[provider], credentialRef: createSecretReference(name) }),
    hasKey: true,
    credential: { name, backend: "environment", writable: false },
  };
}

export async function readPersistedModelConfig(
  path: string,
  store: CredentialStore,
  options: { now?: () => Date; verifyReferences?: boolean } = {},
): Promise<LoadedModelConfig | undefined> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw new Error("Persisted model configuration could not be read");
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    // JSON.parse diagnostics may echo the malformed input, which can include
    // a legacy plaintext key that has not yet entered the redaction registry.
    throw new TypeError("Persisted model configuration is invalid JSON");
  }
  const parsed = parsePersistedConfig(value);
  if (SecretReferenceSchema.safeParse(parsed.apiKey).success) {
    const reference = SecretReferenceSchema.parse(parsed.apiKey);
    if (
      parsed.credentialMigration !== undefined
      && (
        parsed.credentialMigration.secret_reference !== reference
        || parsed.credentialMigration.credential.name !== credentialNameFromReference(reference)
      )
    ) {
      throw new TypeError("Persisted credential migration marker does not match the model credential reference");
    }
    const credential = options.verifyReferences === false
      ? undefined
      : await metadataForReference(reference, store, path);
    return {
      config: validateModelProviderConfig({
        provider: parsed.provider,
        protocol: parsed.protocol,
        baseUrl: parsed.baseUrl,
        model: parsed.model,
        credentialRef: reference,
      }),
      hasKey: credential !== undefined,
      ...(credential === undefined ? {} : { credential }),
      ...(parsed.credentialMigration === undefined ? {} : { migration: parsed.credentialMigration }),
    };
  }

  const now = options.now ?? (() => new Date());
  const baseName = credentialNameForProvider(parsed.provider);
  const existing = await store.get(baseName);
  const credentialName = existing === null || secretsEqual(existing, parsed.apiKey)
    ? baseName
    : versionedCredentialName(parsed.provider);
  const secretReference = createSecretReference(credentialName);
  const config = validateModelProviderConfig({
    provider: parsed.provider,
    protocol: parsed.protocol,
    baseUrl: parsed.baseUrl,
    model: parsed.model,
    credentialRef: secretReference,
  });
  const migratedAt = now().toISOString();
  let credential: SafeCredentialMetadata;
  let migration: CredentialMigration;
  try {
    await store.set(credentialName, parsed.apiKey);
    await verifyStoredCredential(store, credentialName, parsed.apiKey);
    const storedCredential = await metadataForReference(secretReference, store, path, migratedAt);
    if (storedCredential === undefined) throw new Error("Credential disappeared immediately after migration");
    credential = storedCredential;
    migration = CredentialMigrationMarkerSchema.parse({
      migration_id: randomUUID(),
      credential,
      secret_reference: secretReference,
      migrated_at: migratedAt,
    });
    await persistModelConfig(path, config, { migration });
  } catch (error) {
    if (existing === null || credentialName !== baseName) {
      await store.delete(credentialName).catch(() => undefined);
    }
    throw error;
  }
  return {
    config,
    hasKey: true,
    credential,
    migration,
  };
}

/** Persist only a reference. Passing a plaintext apiKey is rejected. */
export async function persistModelConfig(
  path: string,
  config: ModelProviderConfig,
  options: { migration?: CredentialMigration } = {},
): Promise<void> {
  const valid = validateModelProviderConfig(config);
  const migration = options.migration === undefined
    ? undefined
    : CredentialMigrationMarkerSchema.parse(options.migration);
  if (
    migration !== undefined
    && (
      migration.secret_reference !== valid.credentialRef
      || migration.credential.name !== credentialNameFromReference(valid.credentialRef)
    )
  ) {
    throw new TypeError("Credential migration marker does not match the model credential reference");
  }
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const payload = `${JSON.stringify({
    provider: valid.provider,
    protocol: valid.protocol,
    baseUrl: valid.baseUrl,
    model: valid.model,
    apiKey: valid.credentialRef,
    ...(migration === undefined ? {} : { credentialMigration: migration }),
  }, null, 2)}\n`;
  try {
    await writeFile(temporaryPath, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Clear a durable, non-secret migration outbox only after its audit Run commits. */
export async function acknowledgeCredentialMigration(
  path: string,
  config: ModelProviderConfig,
  migrationId: string,
): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("Persisted credential migration marker could not be acknowledged");
  }
  const parsed = parsePersistedConfig(value);
  if (
    parsed.apiKey !== config.credentialRef
    || parsed.provider !== config.provider
    || parsed.protocol !== config.protocol
    || parsed.baseUrl.replace(/\/+$/u, "") !== config.baseUrl
    || parsed.model.trim() !== config.model
  ) {
    throw new Error("Persisted model configuration changed before migration acknowledgement");
  }
  if (parsed.credentialMigration === undefined) return;
  if (parsed.credentialMigration.migration_id !== migrationId) {
    throw new Error("Persisted credential migration marker changed before acknowledgement");
  }
  await persistModelConfig(path, config);
}

/**
 * Store or reuse a provider-scoped key, then atomically persist only its
 * reference. A key belonging to another provider is never reused.
 */
export async function saveModelConfig(options: {
  path: string;
  store: CredentialStore;
  config: Omit<ModelProviderConfig, "credentialRef">;
  apiKey?: string;
  existing?: ModelProviderConfig;
}): Promise<LoadedModelConfig> {
  let name: string;
  let reference: SecretReference;
  if (options.apiKey !== undefined) {
    name = versionedCredentialName(options.config.provider);
    reference = createSecretReference(name);
    const config = validateModelProviderConfig({ ...options.config, credentialRef: reference });
    let credential: SafeCredentialMetadata;
    try {
      await options.store.set(name, options.apiKey);
      await verifyStoredCredential(options.store, name, options.apiKey);
      const storedCredential = await metadataForReference(
        reference,
        options.store,
        options.path,
        new Date().toISOString(),
      );
      if (storedCredential === undefined) throw new Error("Credential disappeared immediately after save");
      credential = storedCredential;
      await persistModelConfig(options.path, config);
    } catch (error) {
      await options.store.delete(name).catch(() => undefined);
      throw error;
    }
    return { config, hasKey: true, credential };
  }

  if (options.existing?.provider !== options.config.provider) {
    throw new CredentialNotFoundError(credentialNameForProvider(options.config.provider));
  }
  reference = options.existing.credentialRef;
  name = credentialNameFromReference(reference);
  const credential = await metadataForReference(reference, options.store, options.path);
  if (credential === undefined) throw new CredentialNotFoundError(name);
  const config = validateModelProviderConfig({ ...options.config, credentialRef: reference });
  await persistModelConfig(options.path, config);
  return { config, hasKey: true, credential };
}

async function metadataForReference(
  reference: string,
  store: CredentialStore,
  configPath: string,
  updatedAt?: string,
): Promise<SafeCredentialMetadata | undefined> {
  const name = credentialNameFromReference(reference);
  if (await store.get(name) === null) return undefined;
  const metadata = (await store.list()).find((item) => item.name === name);
  if (metadata === undefined) throw new Error(`Credential store did not report metadata for ${name}`);
  const timestamp = updatedAt ?? metadata.last_updated_at ?? (await stat(configPath)).mtime.toISOString();
  return { ...metadata, last_updated_at: timestamp };
}

function parsePersistedConfig(value: unknown): ParsedPersistedModelConfig {
  if (!isRecord(value)) throw new TypeError("Persisted model configuration must be an object");
  const provider = parseProvider(value.provider);
  const protocol = parseProtocol(value.protocol);
  const baseUrl = clean(value.baseUrl);
  const model = clean(value.model);
  const camelKey = clean(value.apiKey);
  const snakeKey = clean(value.api_key);
  if (camelKey && snakeKey && camelKey !== snakeKey) {
    throw new TypeError("Persisted model configuration contains conflicting API Key fields");
  }
  const apiKey = camelKey ?? snakeKey;
  if (!provider || !protocol || !baseUrl || !model || !apiKey) {
    throw new TypeError("Persisted model configuration is incomplete or invalid");
  }
  if (!SecretReferenceSchema.safeParse(apiKey).success && apiKey.length < 8) {
    throw new TypeError("Persisted model credential is invalid");
  }
  let credentialMigration: CredentialMigration | undefined;
  if (value.credentialMigration !== undefined) {
    const parsedMigration = CredentialMigrationMarkerSchema.safeParse(value.credentialMigration);
    if (!parsedMigration.success) {
      throw new TypeError("Persisted credential migration marker is invalid");
    }
    credentialMigration = parsedMigration.data;
  }
  return {
    provider,
    protocol,
    baseUrl,
    model,
    apiKey,
    ...(credentialMigration === undefined ? {} : { credentialMigration }),
  };
}

async function verifyStoredCredential(store: CredentialStore, name: string, expected: string): Promise<void> {
  const actual = await store.get(name);
  if (actual === null || !secretsEqual(actual, expected)) {
    throw new Error(`Credential backend failed to verify ${name} after write`);
  }
}

function secretsEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function versionedCredentialName(provider: ModelProvider): string {
  const suffix = randomUUID().replace(/-/gu, "").slice(0, 12).toUpperCase();
  return `${credentialNameForProvider(provider)}_${suffix}`;
}

function parseProvider(value: unknown): ModelProvider | undefined {
  const result = ModelProviderSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

function parseProtocol(value: unknown): ModelProtocol | undefined {
  const result = ModelProtocolSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
