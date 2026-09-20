import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionStatusSnapshot, ModelConfigSnapshot, PermissionConfigSnapshot, TelemetryStatusSnapshot } from "../client";
import {
  credentialIsReadOnly,
  credentialStatusForProvider,
  ExtensionSettingsSection,
  modelSettingsAreReadOnly,
  MODEL_PROVIDER_PRESETS,
  ModelCredentialStatus,
  PermissionSettingsSection,
  SettingsPanel,
  TelemetrySettingsSection,
} from "./SettingsPanel";

const permissionConfig: PermissionConfigSnapshot = {
  active_preset: "full-write",
  sandbox_mode: "danger-full-access",
  approval_policy: "never",
  policy_digest: `sha256:${"a".repeat(64)}`,
  ceiling: "full-write",
  available_presets: [
    { key: "read-only", label: "Read only", sandbox_mode: "read-only", approval_policy: "never" },
    { key: "workspace-write", label: "Workspace write", sandbox_mode: "workspace-write", approval_policy: "on-write" },
    { key: "full-write", label: "Full write", sandbox_mode: "danger-full-access", approval_policy: "never" },
  ],
  source: "user-config",
  locked: false,
};

describe("SettingsPanel", () => {
  it("groups language and appearance under one extensible settings entry", () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        onClose={vi.fn()}
        onThemeChange={vi.fn()}
        open
        theme="light"
      />,
    );

    expect(html).toContain("Settings");
    expect(html).toContain("Language");
    expect(html).toContain("Appearance");
    expect(html).toContain("English");
    expect(html).toContain("Light");
    expect(html).toContain("DeepSeek");
    expect(html).toContain("GLM (智谱)");
    expect(html).toContain("Qwen / Qwen Code");
    expect(html).toContain("MiniMax");
    expect(html).toContain("Claude (Anthropic)");
    expect(html).toContain("Custom / 自定义");
    expect(html).toContain("GPT-4.1 mini");
    expect(html).toContain("Custom model");
    expect(html).toContain('aria-pressed="true"');
  });

  it("uses current DeepSeek V4 model presets", () => {
    expect(MODEL_PROVIDER_PRESETS.deepseek.models).toEqual([
      { value: "deepseek-v4-flash", label: "DeepSeek V4 Flash（推荐）" },
      { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
    ]);
  });

  it("shows only Host-advertised permission presets and warns for full write", () => {
    const html = renderToStaticMarkup(
      <PermissionSettingsSection
        message=""
        onSelect={vi.fn()}
        saving={false}
        snapshot={permissionConfig}
        supported
      />,
    );

    expect(html).toContain("Permission preset");
    expect(html).toContain("Read only");
    expect(html).toContain("Workspace write");
    expect(html).toContain("Full write");
    expect(html).toContain("disables sandbox isolation");
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain("path_scope");
    expect(html).not.toContain("host_rules");
    expect(html).not.toContain("project_rules");
  });

  it("disables preset changes when the Host locks permission settings", () => {
    const html = renderToStaticMarkup(
      <PermissionSettingsSection
        message=""
        onSelect={vi.fn()}
        saving={false}
        snapshot={{ ...permissionConfig, locked: true, lock_reason: "Controlled by TRACEGRAPH_PERMISSION_PRESET" }}
        supported
      />,
    );

    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(html).toContain("Controlled by TRACEGRAPH_PERMISSION_PRESET");
  });

  it("renders telemetry status and error counts as a strictly read-only surface", () => {
    const snapshot: TelemetryStatusSnapshot = {
      schema_version: "tracegraph.telemetry-status.v1",
      sink: "otlp_http",
      state: "degraded",
      error_count: 3,
      last_error_at: "2026-09-19T06:00:00.000Z",
    };
    const html = renderToStaticMarkup(
      <TelemetrySettingsSection message="" snapshot={snapshot} supported />,
    );

    expect(html).toContain("Telemetry");
    expect(html).toContain("Degraded");
    expect(html).toContain("OTLP/HTTP");
    expect(html).toContain("Export errors");
    expect(html).toContain(">3<");
    expect(html).toContain("2026-09-19T06:00:00.000Z");
    expect(html).toContain("read-only");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("https://");
    expect(html).not.toContain("Bearer ");
    expect(html).not.toContain("api_key");
  });

  it("shows bounded extension state, generation, contributions, and errors", () => {
    const statuses: readonly ExtensionStatusSnapshot[] = [{
      name: "@tracegraph/builtin-artifact-tools",
      api_version: "tracegraph.extension.v1",
      state: "active",
      registration_count: 2,
      generation: 4,
      updated_at: "2026-09-19T06:00:00.000Z",
    }, {
      name: "@tracegraph/builtin-run-state-tools",
      api_version: "tracegraph.extension.v1",
      state: "failed",
      registration_count: 0,
      generation: 5,
      updated_at: "2026-09-19T06:01:00.000Z",
      error_code: "extension_activate_failed",
      error_message: "Activation failed safely",
    }];
    const html = renderToStaticMarkup(
      <ExtensionSettingsSection
        message=""
        onReload={vi.fn()}
        reloading={null}
        statuses={statuses}
        supported
      />,
    );

    expect(html).toContain("@tracegraph/builtin-artifact-tools");
    expect(html).toContain("Generation 4");
    expect(html).toContain("Contributions 2");
    expect(html).toContain("extension_activate_failed");
    expect(html).toContain("Activation failed safely");
    expect(html).toContain("Reload");
    expect(html).not.toContain("module");
  });

  it("shows safe credential source metadata and environment read-only state", () => {
    const status = {
      configured: true,
      hasKey: true,
      credential: {
        name: "OPENAI_API_KEY" as const,
        backend: "environment" as const,
        writable: false,
        last_updated_at: "2026-09-18T00:00:00.000Z",
      },
    };
    const html = renderToStaticMarkup(<ModelCredentialStatus status={status} />);

    expect(html).toContain("Credential status");
    expect(html).toContain("Environment");
    expect(html).toContain("OPENAI_API_KEY");
    expect(html).toContain("Read-only");
    expect(html).toContain("2026-09-18T00:00:00.000Z");
    expect(html).toContain("Change the environment variable and restart TraceGraph");
    expect(html).not.toContain("secret-value");
    expect(credentialIsReadOnly(status)).toBe(true);
  });

  it("does not reuse one provider's credential status after switching providers", () => {
    const snapshot: ModelConfigSnapshot = {
      provider: "openai",
      protocol: "openai-chat-completions",
      configured: true,
      base_url: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      has_key: true,
      credential: {
        name: "OPENAI_API_KEY",
        backend: "macos_keychain",
        writable: true,
      },
    };

    expect(credentialStatusForProvider(snapshot, "openai")).toMatchObject({
      configured: true,
      hasKey: true,
    });
    expect(credentialStatusForProvider(snapshot, "anthropic")).toEqual({
      configured: false,
      hasKey: false,
    });
    expect(modelSettingsAreReadOnly(snapshot)).toBe(false);
    expect(modelSettingsAreReadOnly({
      ...snapshot,
      credential: {
        name: "OPENAI_API_KEY",
        backend: "environment",
        writable: false,
      },
    })).toBe(true);
  });

  it("renders nothing while closed", () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        onClose={vi.fn()}
        onThemeChange={vi.fn()}
        open={false}
        theme="light"
      />,
    );

    expect(html).toBe("");
  });
});
