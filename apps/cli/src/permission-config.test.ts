import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { removeControlledTemporaryDirectory } from "@tracegraph/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  HARNESS_PERMISSION_CONFIG_VERSION,
  MAX_PERMISSION_CONFIG_BYTES,
  PermissionConfigController,
  readProjectPolicy,
  resolvePermissionCeiling,
} from "./permission-config.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeControlledTemporaryDirectory));
});

describe("G06 permission configuration", () => {
  it("uses workspace-write by default and treats CLI/environment as a ceiling", async () => {
    const root = await temporaryRoot();
    const controller = await PermissionConfigController.open({
      userConfigPath: join(root, "harness-config.json"),
      environment: {},
    });

    expect(resolvePermissionCeiling({ environment: {} })).toEqual({
      key: "workspace-write",
      source: "default",
    });
    expect(controller.snapshot()).toMatchObject({
      ceiling_preset_key: "workspace-write",
      selected_preset_key: "workspace-write",
      selectable_preset_keys: ["read-only", "workspace-write"],
      selected_preset: {
        key: "workspace-write",
        sandbox_mode: "workspace-write",
      },
    });
    expect(resolvePermissionCeiling({
      permissionPresetFlag: "read-only",
      environment: { TRACEGRAPH_PERMISSION_PRESET: "full-write" },
    })).toEqual({ key: "read-only", source: "cli" });
  });

  it("maps the legacy sandbox mode and rejects conflicting dual configuration", () => {
    expect(resolvePermissionCeiling({
      sandboxModeFlag: "danger-full-access",
      environment: {},
    })).toEqual({ key: "full-write", source: "legacy_cli" });
    expect(resolvePermissionCeiling({
      environment: { TRACEGRAPH_SANDBOX_MODE: "read-only" },
    })).toEqual({ key: "read-only", source: "legacy_environment" });
    expect(resolvePermissionCeiling({
      permissionPresetFlag: "workspace-write",
      sandboxModeFlag: "workspace-write",
      environment: {},
    })).toEqual({ key: "workspace-write", source: "cli" });
    expect(() => resolvePermissionCeiling({
      permissionPresetFlag: "read-only",
      sandboxModeFlag: "danger-full-access",
      environment: {},
    })).toThrow(/conflicts/u);
    expect(() => resolvePermissionCeiling({
      permissionPresetFlag: "custom",
      environment: {},
    })).toThrow(/custom requires Host-local/u);
    expect(() => resolvePermissionCeiling({
      environment: { TRACEGRAPH_PERMISSION_PRESET: "unrestricted" },
    })).toThrow(/must be read-only/u);
  });

  it("loads only a strict private user selection below the Host ceiling", async () => {
    const root = await temporaryRoot();
    const configPath = join(root, "harness-config.json");
    await writePrivateJson(configPath, {
      config_version: HARNESS_PERMISSION_CONFIG_VERSION,
      permission_preset: "read-only",
    });
    const controller = await PermissionConfigController.open({
      userConfigPath: configPath,
      permissionPresetFlag: "workspace-write",
      environment: {},
    });
    expect(controller.snapshot()).toMatchObject({
      ceiling_preset_key: "workspace-write",
      selected_preset_key: "read-only",
      selection_source: "user",
    });

    await writePrivateJson(configPath, {
      config_version: HARNESS_PERMISSION_CONFIG_VERSION,
      permission_preset: "full-write",
    });
    await expect(PermissionConfigController.open({
      userConfigPath: configPath,
      permissionPresetFlag: "workspace-write",
      environment: {},
    })).rejects.toThrow(/exceeds the Host ceiling/u);

    await writePrivateJson(configPath, {
      config_version: HARNESS_PERMISSION_CONFIG_VERSION,
      permission_preset: "read-only",
      injected: true,
    });
    await expect(PermissionConfigController.open({
      userConfigPath: configPath,
      environment: {},
    })).rejects.toThrow(/contain only/u);
  });

  it("atomically persists bounded user choices and publishes state only after success", async () => {
    const root = await temporaryRoot();
    const configPath = join(root, "private", "harness-config.json");
    const controller = await PermissionConfigController.open({
      userConfigPath: configPath,
      permissionPresetFlag: "workspace-write",
      environment: {},
    });
    await expect(controller.setUserPreset("read-only")).resolves.toMatchObject({
      selected_preset_key: "read-only",
      selection_source: "user",
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      config_version: HARNESS_PERMISSION_CONFIG_VERSION,
      permission_preset: "read-only",
    });
    if (process.platform !== "win32") {
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    }
    await expect(controller.setUserPreset("full-write")).rejects.toThrow(/exceeds the Host ceiling/u);
    expect(controller.snapshot().selected_preset_key).toBe("read-only");

    const blockedPath = join(root, "blocked-parent");
    const blocked = await PermissionConfigController.open({
      userConfigPath: join(blockedPath, "harness-config.json"),
      environment: {},
    });
    await writeFile(blockedPath, "not a directory", { mode: 0o600 });
    await expect(blocked.setUserPreset("read-only")).rejects.toThrow();
    expect(blocked.snapshot().selected_preset_key).toBe("workspace-write");
  });

  it("rejects oversized, over-permissive, malformed, and symlinked user configuration", async () => {
    const root = await temporaryRoot();
    const configPath = join(root, "harness-config.json");
    await writeFile(configPath, "x".repeat(MAX_PERMISSION_CONFIG_BYTES + 1), { mode: 0o600 });
    await expect(PermissionConfigController.open({
      userConfigPath: configPath,
      environment: {},
    })).rejects.toThrow(/exceeds/u);

    await writeFile(configPath, "{broken", { mode: 0o600 });
    await expect(PermissionConfigController.open({
      userConfigPath: configPath,
      environment: {},
    })).rejects.toThrow(/invalid JSON/u);

    if (process.platform !== "win32") {
      await writePrivateJson(configPath, {
        config_version: HARNESS_PERMISSION_CONFIG_VERSION,
        permission_preset: "read-only",
      });
      await chmod(configPath, 0o644);
      await expect(PermissionConfigController.open({
        userConfigPath: configPath,
        environment: {},
      })).rejects.toThrow(/0600/u);

      const target = join(root, "target.json");
      const link = join(root, "linked-config.json");
      await writePrivateJson(target, {
        config_version: HARNESS_PERMISSION_CONFIG_VERSION,
        permission_preset: "read-only",
      });
      await symlink(target, link);
      await expect(PermissionConfigController.open({
        userConfigPath: link,
        environment: {},
      })).rejects.toThrow(/symlink|could not be opened/u);
    }
  });

  it("loads only restriction rules from the canonical project policy path", async () => {
    const root = await temporaryRoot();
    const policyPath = join(root, ".tracegraph", "policy.json");
    await writeProjectPolicy(policyPath, {
      policy_version: 1,
      rules: [{
        rule_id: "deny-secrets",
        priority: 100,
        when: { path_glob: "**/.env*" },
        then: "deny",
        explanation: "Credential files stay outside Agent access",
      }, {
        rule_id: "ask-tests",
        priority: 50,
        when: { tool: "run_test" },
        then: "ask",
        explanation: "Project tests require explicit confirmation",
      }],
    });

    const parsed = await readProjectPolicy(root);
    expect(parsed.rules.map((rule) => rule.then)).toEqual(["deny", "ask"]);
    const controller = await PermissionConfigController.open({
      userConfigPath: join(root, "user", "harness-config.json"),
      environment: {},
    });
    const first = await controller.resolveProject(root);
    const second = await controller.resolveProject(root);
    expect(first).toMatchObject({
      preset: { key: "workspace-write" },
      host_rules: [],
      project_rules: parsed.rules,
      policy_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(second.policy_digest).toBe(first.policy_digest);
  });

  it("exposes a browser-safe settings adapter bounded by the Host ceiling", async () => {
    const root = await temporaryRoot();
    const controller = await PermissionConfigController.open({
      userConfigPath: join(root, "user", "harness-config.json"),
      permissionPresetFlag: "workspace-write",
      environment: {},
    });
    const settings = await controller.resolveSettings(root);
    expect(settings).toMatchObject({
      active_preset: "workspace-write",
      sandbox_mode: "workspace-write",
      approval_policy: "on-write",
      ceiling: "workspace-write",
      available_presets: [
        { key: "read-only", sandbox_mode: "read-only" },
        { key: "workspace-write", sandbox_mode: "workspace-write" },
      ],
      source: "cli",
      locked: false,
    });
    expect(settings).not.toHaveProperty("rules");
    expect(settings).not.toHaveProperty("path_scope");
    expect(settings).not.toHaveProperty("allowed_tools");

    const readOnly = await PermissionConfigController.open({
      userConfigPath: join(root, "read-only", "harness-config.json"),
      sandboxModeFlag: "read-only",
      environment: {},
    });
    await expect(readOnly.resolveSettings(root)).resolves.toMatchObject({
      active_preset: "read-only",
      ceiling: "read-only",
      source: "cli",
      locked: true,
      lock_reason: expect.stringContaining("read-only"),
    });
  });

  it("rejects project allow rules, unknown fields, oversized files, and policy directory symlinks", async () => {
    const root = await temporaryRoot();
    const policyPath = join(root, ".tracegraph", "policy.json");
    await writeProjectPolicy(policyPath, {
      policy_version: 1,
      rules: [{
        rule_id: "unsafe-allow",
        priority: 1,
        when: { side_effect: "write" },
        then: "allow",
        explanation: "Must be rejected at the project boundary",
      }],
    });
    await expect(readProjectPolicy(root)).rejects.toThrow(/only tighten/u);

    await writeProjectPolicy(policyPath, {
      policy_version: 1,
      rules: [],
      injected: true,
    });
    await expect(readProjectPolicy(root)).rejects.toThrow(/strict bounded contract/u);

    await writeFile(policyPath, "x".repeat(MAX_PERMISSION_CONFIG_BYTES + 1));
    await expect(readProjectPolicy(root)).rejects.toThrow(/exceeds/u);

    if (process.platform !== "win32") {
      const symlinkRoot = await temporaryRoot();
      const external = await temporaryRoot();
      await mkdir(join(external, ".tracegraph"), { recursive: true });
      await writeProjectPolicy(join(external, ".tracegraph", "policy.json"), {
        policy_version: 1,
        rules: [],
      });
      await symlink(join(external, ".tracegraph"), join(symlinkRoot, ".tracegraph"));
      await expect(readProjectPolicy(symlinkRoot)).rejects.toThrow(/must not be a symlink/u);
    }
  });

  it("returns an empty bounded project policy when no file exists", async () => {
    const root = await temporaryRoot();
    await expect(readProjectPolicy(root)).resolves.toEqual({ policy_version: 1, rules: [] });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tracegraph-permission-config-"));
  roots.push(root);
  return root;
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(path, 0o600);
}

async function writeProjectPolicy(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
