import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SafeCredentialMetadata } from "@tracegraph/contracts";
import type { CredentialStore } from "@tracegraph/core";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopModelConfiguration } from "./model-configuration.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Desktop Host model credentials", () => {
  it("persists only a secret reference and returns safe metadata across restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracegraph-desktop-model-"));
    roots.push(root);
    const file = join(root, "host", "model-config.json");
    const credentials = new TestCredentialStore();
    const initial = await DesktopModelConfiguration.open({ path: file, credentialStore: credentials });

    await expect(initial.getModelConfig()).resolves.toEqual({
      provider: "openai",
      protocol: "openai-chat-completions",
      configured: false,
      base_url: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      has_key: false,
    });
    const configured = await initial.configureModel({
      provider: "openai",
      protocol: "openai-chat-completions",
      base_url: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      api_key: "test-desktop-secret-value",
    });
    expect(configured).toMatchObject({ configured: true, has_key: true });
    expect(configured.credential?.name).toMatch(/^TRACEGRAPH_DESKTOP_OPENAI_[A-F0-9]{32}$/u);
    expect(configured).not.toHaveProperty("api_key");

    const storedText = await readFile(file, "utf8");
    expect(storedText).toContain("${secret:" + configured.credential?.name + "}");
    expect(storedText).not.toContain("test-desktop-secret-value");
    expect((await stat(file)).mode & 0o077).toBe(0);

    const restarted = await DesktopModelConfiguration.open({ path: file, credentialStore: credentials });
    await expect(restarted.getModelConfig()).resolves.toMatchObject({ configured: true, has_key: true });
    expect(restarted.adapter.publicConfig().configured).toBe(true);
  });

  it("validates the model endpoint before storing a key and rolls back when credential storage fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracegraph-desktop-model-failure-"));
    roots.push(root);
    const file = join(root, "host", "model-config.json");
    const credentials = new TestCredentialStore();
    const model = await DesktopModelConfiguration.open({ path: file, credentialStore: credentials });

    await expect(model.configureModel({
      provider: "openai",
      protocol: "openai-chat-completions",
      base_url: "https://user:password@example.com/v1",
      model: "gpt-4.1-mini",
      api_key: "test-desktop-secret-value",
    })).rejects.toThrow("Credentials are not allowed in the model base URL");
    expect(credentials.values.size).toBe(0);

    credentials.failWrites = true;
    await expect(model.configureModel({
      provider: "openai",
      protocol: "openai-chat-completions",
      base_url: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      api_key: "test-desktop-secret-value",
    })).rejects.toThrow("Credential backend unavailable");
    expect(credentials.values.size).toBe(0);
    await expect(stat(file)).rejects.toThrow();
    await expect(model.getModelConfig()).resolves.toMatchObject({ configured: false, has_key: false });
  });
});

class TestCredentialStore implements CredentialStore {
  readonly values = new Map<string, string>();
  failWrites = false;

  async get(name: string): Promise<string | null> {
    return this.values.get(name) ?? null;
  }

  async set(name: string, value: string): Promise<void> {
    if (this.failWrites) throw new Error("Credential backend unavailable");
    this.values.set(name, value);
  }

  async delete(name: string): Promise<void> {
    this.values.delete(name);
  }

  async list(): Promise<SafeCredentialMetadata[]> {
    return [...this.values.keys()].map((name) => ({
      name: name as SafeCredentialMetadata["name"],
      backend: "private_file",
      writable: true,
      last_updated_at: "2026-10-02T00:00:00.000Z",
    }));
  }
}
