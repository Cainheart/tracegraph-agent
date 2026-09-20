import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CredentialBackendError,
  PrivateFileCredentialStore,
  removeControlledTemporaryDirectory,
  type CredentialStore,
} from "@tracegraph/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  acknowledgeCredentialMigration,
  modelConfigFromEnvironment,
  persistModelConfig,
  readPersistedModelConfig,
  saveModelConfig,
} from "./model-config.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeControlledTemporaryDirectory));
});

describe("local model configuration", () => {
  it("infers the official DeepSeek endpoint while retaining only an environment reference", () => {
    expect(modelConfigFromEnvironment({ DEEPSEEK_API_KEY: "deepseek-secret" })).toEqual({
      config: {
        provider: "deepseek",
        protocol: "openai-chat-completions",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        credentialRef: "${secret:DEEPSEEK_API_KEY}",
      },
      hasKey: true,
      credential: {
        name: "DEEPSEEK_API_KEY",
        backend: "environment",
        writable: false,
      },
    });
  });

  it("supports generic environment variables for custom compatible endpoints", () => {
    expect(modelConfigFromEnvironment({
      TRACEGRAPH_MODEL_PROVIDER: "custom",
      TRACEGRAPH_MODEL_PROTOCOL: "openai-chat-completions",
      TRACEGRAPH_MODEL_BASE_URL: "https://models.example/v1",
      TRACEGRAPH_MODEL: "coding-model",
      TRACEGRAPH_MODEL_API_KEY: "local-secret",
    })).toEqual({
      config: {
        provider: "custom",
        protocol: "openai-chat-completions",
        baseUrl: "https://models.example/v1",
        model: "coding-model",
        credentialRef: "${secret:TRACEGRAPH_MODEL_API_KEY}",
      },
      hasKey: true,
      credential: {
        name: "TRACEGRAPH_MODEL_API_KEY",
        backend: "environment",
        writable: false,
      },
    });
  });

  it("ignores whitespace-only preferred aliases and selects the populated fallback aliases", () => {
    expect(modelConfigFromEnvironment({
      GLM_API_KEY: "   ",
      ZHIPU_API_KEY: "  zhipu-secret  ",
    })).toMatchObject({
      config: {
        provider: "glm",
        credentialRef: "${secret:ZHIPU_API_KEY}",
      },
      credential: {
        name: "ZHIPU_API_KEY",
        backend: "environment",
        writable: false,
      },
    });

    expect(modelConfigFromEnvironment({
      QWEN_API_KEY: "\t",
      DASHSCOPE_API_KEY: "  dashscope-secret  ",
    })).toMatchObject({
      config: {
        provider: "qwen",
        credentialRef: "${secret:DASHSCOPE_API_KEY}",
      },
      credential: {
        name: "DASHSCOPE_API_KEY",
        backend: "environment",
        writable: false,
      },
    });
  });

  it("migrates the real legacy camelCase apiKey without leaving plaintext in model-config.json", async () => {
    const root = await temporaryRoot();
    const path = join(root, "model-config.json");
    const credentialPath = join(root, "credentials.json");
    const secret = "persisted-legacy-secret";
    await writeFile(path, `${JSON.stringify({
      provider: "deepseek",
      protocol: "openai-chat-completions",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      apiKey: secret,
    }, null, 2)}\n`, { mode: 0o600 });
    const store = new PrivateFileCredentialStore(credentialPath, {
      now: () => new Date("2026-09-18T00:00:00.000Z"),
    });

    const loaded = await readPersistedModelConfig(path, store, {
      now: () => new Date("2026-09-18T00:00:00.000Z"),
    });

    expect(loaded).toMatchObject({
      config: { credentialRef: "${secret:TRACEGRAPH_DEEPSEEK_KEY}" },
      hasKey: true,
      credential: {
        name: "TRACEGRAPH_DEEPSEEK_KEY",
        backend: "private_file",
        writable: true,
      },
      migration: {
        secret_reference: "${secret:TRACEGRAPH_DEEPSEEK_KEY}",
        migrated_at: "2026-09-18T00:00:00.000Z",
      },
    });
    const source = await readFile(path, "utf8");
    expect(source).not.toContain(secret);
    expect(source).toContain("${secret:TRACEGRAPH_DEEPSEEK_KEY}");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(store.get("TRACEGRAPH_DEEPSEEK_KEY")).resolves.toBe(secret);

    const pendingAgain = await readPersistedModelConfig(path, store);
    expect(pendingAgain?.migration?.migration_id).toBe(loaded?.migration?.migration_id);
    await acknowledgeCredentialMigration(
      path,
      loaded!.config,
      loaded!.migration!.migration_id,
    );
    const acknowledged = await readPersistedModelConfig(path, store);
    expect(acknowledged?.migration).toBeUndefined();
    expect(await readFile(path, "utf8")).not.toContain("credentialMigration");
  });

  it("does not echo malformed persisted content that may contain a legacy secret", async () => {
    const root = await temporaryRoot();
    const path = join(root, "model-config.json");
    const secret = "opaque-malformed-legacy-secret";
    await writeFile(path, `{ apiKey: ${secret}`, { mode: 0o600 });
    const store = new PrivateFileCredentialStore(join(root, "credentials.json"));

    let failure: unknown;
    try {
      await readPersistedModelConfig(path, store);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(TypeError);
    expect(String(failure)).toContain("invalid JSON");
    expect(String(failure)).not.toContain(secret);
  });

  it("does not rewrite a legacy source file when secure storage fails", async () => {
    const root = await temporaryRoot();
    const path = join(root, "model-config.json");
    const secret = "legacy-secret-that-must-remain-until-retry";
    const legacy = `${JSON.stringify({
      provider: "openai",
      protocol: "openai-chat-completions",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      apiKey: secret,
    }, null, 2)}\n`;
    await writeFile(path, legacy, { mode: 0o600 });
    const failingStore: CredentialStore = {
      get: async () => null,
      set: async () => { throw new CredentialBackendError("macos_keychain", "locked"); },
      delete: async () => undefined,
      list: async () => [],
    };

    await expect(readPersistedModelConfig(path, failingStore)).rejects.toBeInstanceOf(CredentialBackendError);
    await expect(readFile(path, "utf8")).resolves.toBe(legacy);
  });

  it("leaves the legacy source untouched when a credential backend acknowledges but corrupts a write", async () => {
    const root = await temporaryRoot();
    const path = join(root, "model-config.json");
    const secret = "legacy-secret-that-must-survive-corruption";
    const legacy = `${JSON.stringify({
      provider: "openai",
      protocol: "openai-chat-completions",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      apiKey: secret,
    }, null, 2)}\n`;
    await writeFile(path, legacy, { mode: 0o600 });
    let writeAttempted = false;
    let deleted = false;
    const corruptingStore: CredentialStore = {
      get: async () => writeAttempted ? "different-value-returned-by-backend" : null,
      set: async () => { writeAttempted = true; },
      delete: async () => { deleted = true; },
      list: async () => [],
    };

    await expect(readPersistedModelConfig(path, corruptingStore)).rejects.toThrow(
      "Credential backend failed to verify TRACEGRAPH_OPENAI_KEY after write",
    );
    expect(writeAttempted).toBe(true);
    expect(deleted).toBe(true);
    await expect(readFile(path, "utf8")).resolves.toBe(legacy);
  });

  it("persists only typed references and rejects a plaintext persistence attempt", async () => {
    const root = await temporaryRoot();
    const path = join(root, "model-config.json");
    const base = {
      provider: "openai" as const,
      protocol: "openai-chat-completions" as const,
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
    };

    await expect(persistModelConfig(path, { ...base, credentialRef: "plaintext-secret" })).rejects.toThrow();
    await persistModelConfig(path, { ...base, credentialRef: "${secret:TRACEGRAPH_OPENAI_KEY}" });

    const source = await readFile(path, "utf8");
    expect(source).not.toContain("plaintext-secret");
    expect(source).toContain("${secret:TRACEGRAPH_OPENAI_KEY}");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("never reuses one provider's key when switching providers", async () => {
    const root = await temporaryRoot();
    const path = join(root, "model-config.json");
    const store = new PrivateFileCredentialStore(join(root, "credentials.json"));
    const deepseek = await saveModelConfig({
      path,
      store,
      config: {
        provider: "deepseek",
        protocol: "openai-chat-completions",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
      },
      apiKey: "deepseek-only-secret",
    });

    await expect(saveModelConfig({
      path,
      store,
      config: {
        provider: "openai",
        protocol: "openai-chat-completions",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4.1-mini",
      },
      existing: deepseek.config,
    })).rejects.toMatchObject({ name: "CredentialNotFoundError" });

    const source = await readFile(path, "utf8");
    expect(source).toContain("${secret:TRACEGRAPH_DEEPSEEK_KEY_");
    expect(source).not.toContain("TRACEGRAPH_OPENAI_KEY");
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tracegraph-model-config-"));
  roots.push(root);
  return root;
}
