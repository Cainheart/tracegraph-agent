import { useEffect, useState } from "react";
import type {
  BuiltinPermissionPresetKey,
  ConfigureModelInput,
  ConfigurePermissionPresetInput,
  ExtensionStatusSnapshot,
  LspStatusSnapshotView,
  McpStatusSnapshotView,
  SkillProjectInspectionSnapshot,
  ModelConfigSnapshot,
  ModelProtocol,
  ModelProvider,
  PermissionConfigSnapshot,
  SafeCredentialMetadata,
  TelemetryStatusSnapshot,
  UsageSnapshotSnapshot,
} from "../client";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";
import { IconButton } from "./Primitives";

export type Theme = "light" | "dark";

type SettingsSection = "general" | "models" | "appearance" | "tools" | "usage";

const SETTINGS_SECTIONS: readonly { id: SettingsSection; label: string; description: string; icon: "settings" | "layers" | "moon" | "spark" | "activity" | "terminal" | "code" }[] = [
  { id: "general", label: "General", description: "Language, permissions, and telemetry", icon: "settings" },
  { id: "models", label: "Models", description: "Providers and credentials", icon: "layers" },
  { id: "appearance", label: "Appearance", description: "Theme and visual preferences", icon: "moon" },
  { id: "tools", label: "Agent & tools", description: "Skills, MCP, LSP, and extensions", icon: "spark" },
  { id: "usage", label: "Usage and costs", description: "Token and cost visibility", icon: "activity" },
];

type ModelOption = { value: string; label: string };
type ProviderPreset = { label: string; protocol: ModelProtocol; baseUrl: string; models: readonly ModelOption[] };

const CUSTOM_MODEL = "__custom_model__";

export const MODEL_PROVIDER_PRESETS: Readonly<Record<ModelProvider, ProviderPreset>> = {
  openai: { label: "OpenAI", protocol: "openai-chat-completions", baseUrl: "https://api.openai.com/v1", models: [{ value: "gpt-4.1-mini", label: "GPT-4.1 mini" }] },
  deepseek: {
    label: "DeepSeek",
    protocol: "openai-chat-completions",
    baseUrl: "https://api.deepseek.com",
    models: [
      { value: "deepseek-v4-flash", label: "DeepSeek V4 Flash（推荐）" },
      { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
    ],
  },
  glm: { label: "GLM (智谱)", protocol: "openai-chat-completions", baseUrl: "https://open.bigmodel.cn/api/paas/v4", models: [{ value: "glm-5.2", label: "GLM-5.2" }] },
  qwen: { label: "Qwen / Qwen Code", protocol: "openai-chat-completions", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", models: [{ value: "qwen-plus", label: "Qwen Plus" }] },
  minimax: { label: "MiniMax", protocol: "openai-chat-completions", baseUrl: "https://api.minimax.io/v1", models: [{ value: "MiniMax-M2.7", label: "MiniMax M2.7" }] },
  anthropic: { label: "Claude (Anthropic)", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1", models: [{ value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }] },
  custom: { label: "Custom / 自定义", protocol: "openai-chat-completions", baseUrl: "", models: [] },
};

export interface ProviderCredentialStatus {
  configured: boolean;
  hasKey: boolean;
  credential?: SafeCredentialMetadata;
}

/** Credential state belongs to the provider returned by the Host. */
export function credentialStatusForProvider(
  snapshot: ModelConfigSnapshot | null,
  provider: ModelProvider,
): ProviderCredentialStatus {
  if (!snapshot || snapshot.provider !== provider) {
    return { configured: false, hasKey: false };
  }
  return snapshot.credential
    ? {
        configured: snapshot.configured,
        hasKey: snapshot.has_key,
        credential: snapshot.credential,
      }
    : { configured: snapshot.configured, hasKey: snapshot.has_key };
}

export function credentialIsReadOnly(status: ProviderCredentialStatus): boolean {
  return status.credential?.writable === false;
}

/** Environment configuration controls the process, not only one selector row. */
export function modelSettingsAreReadOnly(snapshot: ModelConfigSnapshot | null): boolean {
  return snapshot?.credential?.writable === false;
}

function backendLabel(backend: SafeCredentialMetadata["backend"]): string {
  switch (backend) {
    case "macos_keychain": return "macOS Keychain";
    case "private_file": return "Private local file";
    case "environment": return "Environment";
  }
}

export function ModelCredentialStatus({ status }: { status: ProviderCredentialStatus }) {
  const { t } = useI18n();
  return (
    <div aria-label={t("Credential status")} className="settings-credential-status">
      <strong>{t("Credential status")}</strong>
      <span>{t(status.hasKey ? "Credential available" : "No credential configured")}</span>
      {status.credential && (
        <>
          <dl>
            <div><dt>{t("Backend")}</dt><dd>{t(backendLabel(status.credential.backend))}</dd></div>
            <div><dt>{t("Source")}</dt><dd><code>{status.credential.name}</code></dd></div>
            <div><dt>{t("Writable state")}</dt><dd>{t(status.credential.writable ? "Writable" : "Read-only")}</dd></div>
            <div>
              <dt>{t("Last updated")}</dt>
              <dd>{status.credential.last_updated_at
                ? <time dateTime={status.credential.last_updated_at}>{status.credential.last_updated_at}</time>
                : t("Not recorded")}</dd>
            </div>
          </dl>
          {status.credential.backend === "environment" && (
            <small className="settings-readonly-message">{t("This credential comes from the environment and is read-only. Change the environment variable and restart TraceGraph to update it.")}</small>
          )}
        </>
      )}
    </div>
  );
}

function approvalPolicyLabel(policy: PermissionConfigSnapshot["approval_policy"]): string {
  if (policy === "on-write") return "Ask before writes";
  if (policy === "always") return "Always ask";
  return "No approval prompts";
}

function sandboxModeLabel(mode: PermissionConfigSnapshot["sandbox_mode"]): string {
  if (mode === "read-only") return "Read-only sandbox";
  if (mode === "workspace-write") return "Workspace sandbox";
  return "No sandbox isolation";
}

/** Renders only the bounded public response; Host rules and path scopes never enter this component. */
export function PermissionSettingsSection({
  snapshot,
  supported,
  saving,
  message,
  onSelect,
}: {
  snapshot: PermissionConfigSnapshot | null;
  supported: boolean;
  saving: boolean;
  message: string;
  onSelect: (presetKey: BuiltinPermissionPresetKey) => void;
}) {
  const { t } = useI18n();
  return (
    <section className="settings-section settings-permission-section">
      <div className="settings-section-copy">
        <strong>{t("Permission preset")}</strong>
        <span>{t("The Host resolves sandbox and approval policy from one bounded preset.")}</span>
      </div>
      {snapshot ? (
        <>
          <div className={`settings-permission-current ${snapshot.sandbox_mode === "danger-full-access" ? "is-dangerous" : ""}`}>
            <span>{t("Current permission")}</span>
            <strong>{t(snapshot.active_preset)}</strong>
            <small>{t(sandboxModeLabel(snapshot.sandbox_mode))} · {t(approvalPolicyLabel(snapshot.approval_policy))}</small>
          </div>
          <div aria-label={t("Permission presets")} className="settings-permission-options" role="group">
            {snapshot.available_presets.map((preset) => {
              const active = snapshot.active_preset === preset.key;
              return (
                <button
                  aria-pressed={active}
                  className={`${active ? "active" : ""} ${preset.key === "full-write" ? "is-dangerous" : ""}`}
                  disabled={snapshot.locked || saving}
                  key={preset.key}
                  onClick={() => onSelect(preset.key)}
                  type="button"
                >
                  <span><strong>{t(preset.label)}</strong>{active && <small>{t("Active")}</small>}</span>
                  <span>{t(sandboxModeLabel(preset.sandbox_mode))} · {t(approvalPolicyLabel(preset.approval_policy))}</span>
                </button>
              );
            })}
          </div>
          <dl className="settings-permission-meta">
            <div><dt>{t("Source")}</dt><dd>{t(snapshot.source)}</dd></div>
            <div><dt>{t("Permission ceiling")}</dt><dd>{t(snapshot.ceiling)}</dd></div>
          </dl>
          {snapshot.sandbox_mode === "danger-full-access" && (
            <small className="settings-permission-warning">{t(snapshot.approval_policy === "never"
              ? "Full write disables sandbox isolation and does not prompt before writes. Use it only for a trusted workspace."
              : "This preset disables sandbox isolation. Use it only for a trusted workspace.")}</small>
          )}
          {snapshot.lock_reason && <small className="settings-readonly-message">{t(snapshot.lock_reason)}</small>}
        </>
      ) : (
        <small>{t(supported ? "Loading permission presets…" : "Permission configuration is unavailable on this Host.")}</small>
      )}
      {message && <small className="settings-message">{t(message)}</small>}
      <small>{t("The browser submits only a preset key; the Host owns rules, paths, sandboxing, and approvals.")}</small>
      <small>{t("Changes apply only to new runs; active and historical runs keep their recorded policy.")}</small>
    </section>
  );
}

function telemetrySinkLabel(sink: TelemetryStatusSnapshot["sink"]): string {
  if (sink === "noop") return "No export";
  if (sink === "memory") return "In-memory telemetry";
  if (sink === "otlp_http") return "OTLP/HTTP";
  return "Custom telemetry sink";
}

function telemetryStateLabel(state: TelemetryStatusSnapshot["state"]): string {
  if (state === "disabled") return "Disabled";
  if (state === "active") return "Export active";
  return "Degraded";
}

/** Read-only by design: server-owned endpoint, headers and credentials are not
 * represented by TelemetryStatusSnapshot and cannot be edited here. */
export function TelemetrySettingsSection({
  snapshot,
  supported,
  message,
}: {
  snapshot: TelemetryStatusSnapshot | null;
  supported: boolean;
  message: string;
}) {
  const { t } = useI18n();
  return (
    <section className="settings-section settings-telemetry-section">
      <div className="settings-section-copy">
        <strong>{t("Telemetry")}</strong>
        <span>{t("Export status is read-only and controlled by the local Host.")}</span>
      </div>
      {snapshot ? (
        <>
          <div className={`settings-telemetry-current state-${snapshot.state}`}>
            <span>{t("Telemetry state")}</span>
            <strong>{t(telemetryStateLabel(snapshot.state))}</strong>
            <small>{t(telemetrySinkLabel(snapshot.sink))}</small>
          </div>
          <dl className="settings-permission-meta settings-telemetry-meta">
            <div><dt>{t("Sink")}</dt><dd>{t(telemetrySinkLabel(snapshot.sink))}</dd></div>
            <div><dt>{t("Export errors")}</dt><dd>{snapshot.error_count}</dd></div>
            <div>
              <dt>{t("Last export error")}</dt>
              <dd>{snapshot.last_error_at
                ? <time dateTime={snapshot.last_error_at}>{snapshot.last_error_at}</time>
                : t("None recorded")}</dd>
            </div>
          </dl>
        </>
      ) : (
        <small>{t(supported ? "Loading telemetry status…" : "Telemetry status is unavailable on this Host.")}</small>
      )}
      {message && <small className="settings-message">{message}</small>}
      <small>{t("The browser cannot configure telemetry destinations or authorization data.")}</small>
    </section>
  );
}

export function ExtensionSettingsSection({
  statuses,
  supported,
  reloading,
  message,
  onReload,
}: {
  statuses: readonly ExtensionStatusSnapshot[] | null;
  supported: boolean;
  reloading: string | null;
  message: string;
  onReload: (name: string) => void;
}) {
  const { t } = useI18n();
  return (
    <section className="settings-section settings-extension-section">
      <div className="settings-section-copy">
        <strong>{t("Extensions")}</strong>
        <span>{t("Only trusted extensions bundled with the local Host can be enabled or reloaded.")}</span>
      </div>
      {statuses ? (
        <div className="settings-extension-list">
          {statuses.map((status) => (
            <article className={`settings-extension state-${status.state}`} key={status.name}>
              <div>
                <strong><code>{status.name}</code></strong>
                <small>{t(status.state)} · {t("Generation")} {status.generation} · {t("Contributions")} {status.registration_count}</small>
                {status.error_message && <small className="settings-readonly-message">{status.error_code}: {status.error_message}</small>}
              </div>
              <button
                className="button subtle"
                disabled={reloading !== null}
                onClick={() => onReload(status.name)}
                type="button"
              >{t(reloading === status.name ? "Reloading…" : "Reload")}</button>
            </article>
          ))}
        </div>
      ) : (
        <small>{t(supported ? "Loading extensions…" : "Extension management is unavailable on this Host.")}</small>
      )}
      {message && <small className="settings-message">{message}</small>}
      <small>{t("Extension configuration is data-only and owned by the local Host.")}</small>
    </section>
  );
}

export function SkillSettingsSection({
  inspections,
  supported,
  message,
}: {
  inspections: readonly SkillProjectInspectionSnapshot[] | null;
  supported: boolean;
  message: string;
}) {
  const { t } = useI18n();
  return (
    <section className="settings-section settings-extension-section">
      <div className="settings-section-copy">
        <strong>{t("Skills")}</strong>
        <span>{t("Project Skills override user Skills; invalid SKILL.md files are skipped and audited.")}</span>
      </div>
      {inspections ? inspections.length === 0 ? (
        <small>{t("No registered projects expose Skills.")}</small>
      ) : (
        <div className="settings-extension-list">
          {inspections.map((inspection) => (
            <article className="settings-extension" key={inspection.project_id}>
              <div>
                <strong>{inspection.label}</strong>
                <small>{inspection.registry.skills.length} {t("loaded Skills")} · {inspection.registry.conflicts.length} {t("conflicts")} · {inspection.registry.diagnostics.length} {t("skipped")}</small>
                {inspection.registry.skills.map((skill) => (
                  <small key={`${inspection.project_id}:${skill.name}`}><code>{skill.name}</code> · {skill.description}</small>
                ))}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <small>{t(supported ? "Loading Skills…" : "Skill inspection is unavailable on this Host.")}</small>
      )}
      {message && <small className="settings-message">{message}</small>}
      <small>{t("Only SKILL.md metadata is shown here; Skill bodies are disclosed to the model only through load_skill.")}</small>
    </section>
  );
}

export function McpSettingsSection({
  snapshot,
  supported,
  message,
}: {
  snapshot: McpStatusSnapshotView | null;
  supported: boolean;
  message: string;
}) {
  const { t } = useI18n();
  return (
    <section className="settings-section settings-extension-section">
      <div className="settings-section-copy">
        <strong>{t("MCP servers")}</strong>
        <span>{t("External tools are discovered through bounded stdio JSON-RPC clients.")}</span>
      </div>
      {snapshot ? snapshot.servers.length === 0 ? (
        <small>{t("No MCP servers are configured.")}</small>
      ) : (
        <div className="settings-extension-list">
          {snapshot.servers.map((server) => (
            <article className="settings-extension" key={server.name}>
              <div>
                <strong><code>{server.name}</code></strong>
            <small>{t(server.state)} · {server.tool_count} {t("tools")} · {server.required ? t("required") : t("optional")}</small>
                {server.state === "degraded" && (
                  <small className="settings-message">{t("Degraded: the Host continued without this MCP server.")} {server.error_message ?? server.error_code}</small>
                )}
                {server.state === "ready" && server.tools.length > 0 && (
                  <small>{server.tools.map((tool) => tool.qualified_name).join(", ")}</small>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <small>{t(supported ? "Loading MCP status…" : "MCP management is unavailable on this Host.")}</small>
      )}
      {message && <small className="settings-message">{message}</small>}
      <small>{t("MCP configuration and credentials remain owned by the local Host; the browser only sees bounded status.")}</small>
    </section>
  );
}

export function LspSettingsSection({
  snapshot,
  supported,
  message,
}: {
  snapshot: LspStatusSnapshotView | null;
  supported: boolean;
  message: string;
}) {
  const { t } = useI18n();
  return (
    <section className="settings-section settings-extension-section">
      <div className="settings-section-copy">
        <strong>{t("LSP servers")}</strong>
        <span>{t("Native stdio language servers start lazily for diagnostics and semantic locations.")}</span>
      </div>
      {snapshot ? snapshot.servers.length === 0 ? (
        <small>{t("No LSP servers are configured.")}</small>
      ) : (
        <div className="settings-extension-list">
          {snapshot.servers.map((server) => (
            <article className="settings-extension" key={server.name}>
              <div>
                <strong><code>{server.name}</code></strong>
                <small>{t(server.state)} · {server.diagnostics_count} {t("diagnostics")} · {server.file_extensions.join(", ")}</small>
                {server.error_message && <small className="settings-message">{server.error_code}: {server.error_message}</small>}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <small>{t(supported ? "Loading LSP status…" : "LSP management is unavailable on this Host.")}</small>
      )}
      {message && <small className="settings-message">{message}</small>}
      <small>{t("LSP commands and workspace access remain owned by the local Host; the browser sees bounded status only.")}</small>
    </section>
  );
}

export function SettingsPanel({
  open,
  theme,
  onClose,
  onThemeChange,
  onGetPermissionConfig,
  onConfigurePermissionPreset,
  onGetModelConfig,
  onConfigureModel,
  onGetTelemetryStatus,
  onGetUsage,
  onListExtensions,
  onReloadExtension,
  onListSkills,
  onGetMcpStatus,
  onGetLspStatus,
}: {
  open: boolean;
  theme: Theme;
  onClose: () => void;
  onThemeChange: (theme: Theme) => void;
  onGetPermissionConfig?: () => Promise<PermissionConfigSnapshot>;
  onConfigurePermissionPreset?: (input: ConfigurePermissionPresetInput) => Promise<PermissionConfigSnapshot>;
  onGetModelConfig?: () => Promise<ModelConfigSnapshot>;
  onConfigureModel?: (input: ConfigureModelInput) => Promise<ModelConfigSnapshot>;
  onGetTelemetryStatus?: () => Promise<TelemetryStatusSnapshot>;
  onGetUsage?: () => Promise<UsageSnapshotSnapshot>;
  onListExtensions?: () => Promise<readonly ExtensionStatusSnapshot[]>;
  onReloadExtension?: (extensionName: string) => Promise<ExtensionStatusSnapshot>;
  onListSkills?: () => Promise<readonly SkillProjectInspectionSnapshot[]>;
  onGetMcpStatus?: () => Promise<McpStatusSnapshotView>;
  onGetLspStatus?: () => Promise<LspStatusSnapshotView>;
}) {
  const { language, setLanguage, t } = useI18n();
  const [provider, setProvider] = useState<ModelProvider>("openai");
  const [protocol, setProtocol] = useState<ModelProtocol>("openai-chat-completions");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [model, setModel] = useState("gpt-4.1-mini");
  const [apiKey, setApiKey] = useState("");
  const [permissionSnapshot, setPermissionSnapshot] = useState<PermissionConfigSnapshot | null>(null);
  const [permissionSaving, setPermissionSaving] = useState(false);
  const [permissionMessage, setPermissionMessage] = useState("");
  const [modelSnapshot, setModelSnapshot] = useState<ModelConfigSnapshot | null>(null);
  const [telemetrySnapshot, setTelemetrySnapshot] = useState<TelemetryStatusSnapshot | null>(null);
  const [telemetryMessage, setTelemetryMessage] = useState("");
  const [usageSnapshot, setUsageSnapshot] = useState<UsageSnapshotSnapshot | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageMessage, setUsageMessage] = useState("");
  const [extensionStatuses, setExtensionStatuses] = useState<readonly ExtensionStatusSnapshot[] | null>(null);
  const [extensionMessage, setExtensionMessage] = useState("");
  const [reloadingExtension, setReloadingExtension] = useState<string | null>(null);
  const [skillInspections, setSkillInspections] = useState<readonly SkillProjectInspectionSnapshot[] | null>(null);
  const [skillMessage, setSkillMessage] = useState("");
  const [mcpSnapshot, setMcpSnapshot] = useState<McpStatusSnapshotView | null>(null);
  const [mcpMessage, setMcpMessage] = useState("");
  const [lspSnapshot, setLspSnapshot] = useState<LspStatusSnapshotView | null>(null);
  const [lspMessage, setLspMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [activeSection, setActiveSection] = useState<SettingsSection>("general");
  const [languageMessage, setLanguageMessage] = useState("");
  useEffect(() => {
    if (!open || !onGetModelConfig) return;
    void onGetModelConfig().then((value) => {
      setProvider(value.provider);
      setProtocol(value.protocol);
      setBaseUrl(value.base_url);
      setModel(value.model);
      setModelSnapshot(value);
      setApiKey("");
    }).catch((error: unknown) => setMessage(error instanceof Error ? error.message : String(error)));
  }, [open, onGetModelConfig]);
  useEffect(() => {
    if (!open || !onGetPermissionConfig) return;
    let current = true;
    setPermissionMessage("");
    void onGetPermissionConfig().then((value) => {
      if (current) setPermissionSnapshot(value);
    }).catch((error: unknown) => {
      if (current) setPermissionMessage(error instanceof Error ? error.message : String(error));
    });
    return () => { current = false; };
  }, [open, onGetPermissionConfig]);
  useEffect(() => {
    if (!open || !onGetTelemetryStatus) return;
    let current = true;
    // Never present a previous fetch as the current process-local status.
    setTelemetrySnapshot(null);
    setTelemetryMessage("");
    void onGetTelemetryStatus().then((value) => {
      if (current) setTelemetrySnapshot(value);
    }).catch((error: unknown) => {
      if (current) setTelemetryMessage(error instanceof Error ? error.message : String(error));
    });
    return () => { current = false; };
  }, [open, onGetTelemetryStatus]);
  useEffect(() => {
    if (!open || activeSection !== "usage" || !onGetUsage) return;
    let current = true;
    setUsageSnapshot(null);
    setUsageLoading(true);
    setUsageMessage("");
    void onGetUsage().then((value) => {
      if (current) setUsageSnapshot(value);
    }).catch((error: unknown) => {
      if (current) setUsageMessage(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (current) setUsageLoading(false);
    });
    return () => { current = false; };
  }, [activeSection, onGetUsage, open]);
  useEffect(() => {
    if (!open || !onListExtensions) return;
    let current = true;
    setExtensionStatuses(null);
    setExtensionMessage("");
    void onListExtensions().then((value) => {
      if (current) setExtensionStatuses(value);
    }).catch((error: unknown) => {
      if (current) setExtensionMessage(error instanceof Error ? error.message : String(error));
    });
    return () => { current = false; };
  }, [open, onListExtensions]);
  useEffect(() => {
    if (!open || !onListSkills) return;
    let current = true;
    setSkillInspections(null);
    setSkillMessage("");
    void onListSkills().then((value) => {
      if (current) setSkillInspections(value);
    }).catch((error: unknown) => {
      if (current) setSkillMessage(error instanceof Error ? error.message : String(error));
    });
    return () => { current = false; };
  }, [open, onListSkills]);
  useEffect(() => {
    if (!open || !onGetMcpStatus) return;
    let current = true;
    setMcpSnapshot(null);
    setMcpMessage("");
    void onGetMcpStatus().then((value) => {
      if (current) setMcpSnapshot(value);
    }).catch((error: unknown) => {
      if (current) setMcpMessage(error instanceof Error ? error.message : String(error));
    });
    return () => { current = false; };
  }, [open, onGetMcpStatus]);
  useEffect(() => {
    if (!open || !onGetLspStatus) return;
    let current = true;
    setLspSnapshot(null);
    setLspMessage("");
    void onGetLspStatus().then((value) => {
      if (current) setLspSnapshot(value);
    }).catch((error: unknown) => {
      if (current) setLspMessage(error instanceof Error ? error.message : String(error));
    });
    return () => { current = false; };
  }, [open, onGetLspStatus]);
  if (!open) return null;

  const credentialStatus = credentialStatusForProvider(modelSnapshot, provider);
  const credentialReadOnly = modelSettingsAreReadOnly(modelSnapshot);
  const activeSectionLabel = SETTINGS_SECTIONS.find(({ id }) => id === activeSection)?.label ?? "General";
  const settingsSectionClass = (section: SettingsSection) => `settings-section-group ${activeSection === section ? "is-active" : "is-hidden"}`;

  const save = async () => {
    if (!onConfigureModel || credentialReadOnly) return;
    setSaving(true); setMessage("");
    try {
      const value = await onConfigureModel({
        provider,
        protocol,
        base_url: baseUrl,
        model,
        ...(apiKey.trim() ? { api_key: apiKey } : {}),
      });
      setProvider(value.provider);
      setProtocol(value.protocol);
      setBaseUrl(value.base_url);
      setModel(value.model);
      setModelSnapshot(value);
      setApiKey("");
      setMessage(t("Model configuration saved on this computer."));
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  };
  const selectPermissionPreset = async (presetKey: BuiltinPermissionPresetKey) => {
    if (!onConfigurePermissionPreset || permissionSnapshot?.locked || permissionSnapshot?.active_preset === presetKey) return;
    setPermissionSaving(true);
    setPermissionMessage("");
    try {
      const value = await onConfigurePermissionPreset({ preset_key: presetKey });
      setPermissionSnapshot(value);
      setPermissionMessage("Permission preset saved on this computer.");
    } catch (error) {
      setPermissionMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPermissionSaving(false);
    }
  };
  const reloadExtension = async (extensionName: string) => {
    if (!onReloadExtension) return;
    setReloadingExtension(extensionName);
    setExtensionMessage("");
    try {
      const updated = await onReloadExtension(extensionName);
      setExtensionStatuses((current) => current?.map((status) => (
        status.name === updated.name ? updated : status
      )) ?? [updated]);
      setExtensionMessage(t("Extension reloaded."));
    } catch (error) {
      setExtensionMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setReloadingExtension(null);
    }
  };
  const changeProvider = (next: ModelProvider) => {
    const preset = MODEL_PROVIDER_PRESETS[next];
    setProvider(next);
    setProtocol(preset.protocol);
    setBaseUrl(preset.baseUrl);
    setModel(preset.models[0]?.value ?? "");
    setApiKey("");
    setMessage("");
  };
  const modelOptions = MODEL_PROVIDER_PRESETS[provider].models;
  const selectedModel = modelOptions.some((option) => option.value === model) ? model : CUSTOM_MODEL;
  const chooseModel = (value: string) => setModel(value === CUSTOM_MODEL ? "" : value);

  return (
    <>
      <button aria-label={t("Close settings")} className="settings-backdrop" onClick={onClose} type="button" />
      <section aria-label={t("Settings")} aria-modal="true" className="settings-panel" role="dialog">
        <div className="settings-shell">
          <aside className="settings-sidebar">
            <button className="settings-back-link" onClick={onClose} type="button"><Icon name="arrow-left" size={16} />{t("Back to workbench")}</button>
            <div className="settings-sidebar-brand"><span className="settings-icon"><Icon name="settings" size={16} /></span><span><strong>{t("Settings")}</strong><small>{t("Interface preferences")}</small></span></div>
            <label className="settings-search"><Icon name="search" size={14} /><input aria-label={t("Search settings")} placeholder={t("Search settings")} type="search" /></label>
            <nav aria-label={t("Settings navigation")} className="settings-nav">
              {SETTINGS_SECTIONS.map((section) => <button aria-current={activeSection === section.id ? "page" : undefined} className={activeSection === section.id ? "active" : ""} key={section.id} onClick={() => setActiveSection(section.id)} type="button"><Icon name={section.icon} size={15} /><span><strong>{t(section.label)}</strong><small>{t(section.description)}</small></span></button>)}
            </nav>
            <div className="settings-sidebar-footer"><span className="sidebar-account-avatar">TG</span><span><strong>TraceGraph</strong><small>{t("Local workspace")}</small></span></div>
          </aside>

          <main className="settings-content">
            <header>
              <div><strong>{t(activeSectionLabel)}</strong><small>{t("TraceGraph workspace preferences")}</small></div>
              <IconButton icon="close" label={t("Close settings")} onClick={onClose} />
            </header>

            <div className="settings-body">
          <div className={settingsSectionClass("general")}>
          <section className="settings-section">
            <div className="settings-section-copy"><strong>{t("Language")}</strong><span>{t("Choose the interface language")}</span></div>
            <div aria-label={t("Language")} className="settings-segmented" role="group">
              <button aria-pressed={language === "zh-CN"} className={language === "zh-CN" ? "active" : ""} data-language="zh-CN" onClick={() => { setLanguage("zh-CN"); setLanguageMessage("Language preference saved locally."); }} type="button">中文</button>
              <button aria-pressed={language === "en"} className={language === "en" ? "active" : ""} data-language="en" onClick={() => { setLanguage("en"); setLanguageMessage("Language preference saved locally."); }} type="button">English</button>
            </div>
            {languageMessage && <small className="settings-inline-status" role="status">{t(languageMessage)}</small>}
          </section>

          <PermissionSettingsSection
            message={permissionMessage}
            onSelect={(presetKey) => void selectPermissionPreset(presetKey)}
            saving={permissionSaving}
            snapshot={permissionSnapshot}
            supported={Boolean(onGetPermissionConfig && onConfigurePermissionPreset)}
          />

          <TelemetrySettingsSection
            message={telemetryMessage}
            snapshot={telemetrySnapshot}
            supported={Boolean(onGetTelemetryStatus)}
          />
          </div>

          <div className={settingsSectionClass("tools")}>
          <ExtensionSettingsSection
            message={extensionMessage}
            onReload={(name) => void reloadExtension(name)}
            reloading={reloadingExtension}
            statuses={extensionStatuses}
            supported={Boolean(onListExtensions && onReloadExtension)}
          />

          <SkillSettingsSection
            inspections={skillInspections}
            message={skillMessage}
            supported={Boolean(onListSkills)}
          />

          <McpSettingsSection
            message={mcpMessage}
            snapshot={mcpSnapshot}
            supported={Boolean(onGetMcpStatus)}
          />

          <LspSettingsSection
            message={lspMessage}
            snapshot={lspSnapshot}
            supported={Boolean(onGetLspStatus)}
          />
          </div>

          <div className={settingsSectionClass("models")}>
          <section className="settings-section settings-model-section">
            <div className="settings-section-copy"><strong>{t("Model provider")}</strong><span>{t(credentialStatus.configured ? "Configured · ready for real project tasks" : "Not configured · choose a provider to run tasks")}</span></div>
            <label><span>{t("Provider")}</span><select onChange={(event) => changeProvider(event.target.value as ModelProvider)} value={provider}>{Object.entries(MODEL_PROVIDER_PRESETS).map(([id, preset]) => <option key={id} value={id}>{preset.label}</option>)}</select></label>
            {provider === "custom" && <label><span>{t("API protocol")}</span><select onChange={(event) => setProtocol(event.target.value as ModelProtocol)} value={protocol}><option value="openai-chat-completions">OpenAI Chat Completions</option><option value="anthropic-messages">Anthropic Messages</option></select></label>}
            <label><span>{t("Base URL")}</span><input onChange={(event) => setBaseUrl(event.target.value)} value={baseUrl} /></label>
            {provider === "custom" ? (
              <label><span>{t("Model")}</span><input onChange={(event) => setModel(event.target.value)} placeholder={t("Enter model ID")} value={model} /></label>
            ) : (
              <>
                <label><span>{t("Model")}</span><select onChange={(event) => chooseModel(event.target.value)} value={selectedModel}>{modelOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}<option value={CUSTOM_MODEL}>{t("Custom model")}</option></select></label>
                {selectedModel === CUSTOM_MODEL && <label><span>{t("Custom model ID")}</span><input onChange={(event) => setModel(event.target.value)} placeholder={t("Enter model ID")} value={model} /></label>}
              </>
            )}
            <label><span>{t("API Key")}</span><input autoComplete="new-password" disabled={credentialReadOnly} onChange={(event) => setApiKey(event.target.value)} placeholder={credentialStatus.hasKey ? t("Enter a new key to replace the current one") : "sk-…"} spellCheck={false} type="password" value={apiKey} /></label>
            <button className="button primary" disabled={credentialReadOnly || saving || (!credentialStatus.hasKey && !apiKey.trim()) || !baseUrl.trim() || !model.trim()} onClick={() => void save()} type="button">{t(saving ? "Saving…" : "Save model configuration")}</button>
            {message && <small className="settings-message">{message}</small>}
            <small>{t("The API Key is write-only: it is sent to the loopback Host and is never returned to the browser.")}</small>
          </section>
          </div>

          <div className={settingsSectionClass("appearance")}>
          <section className="settings-section">
            <div className="settings-section-copy"><strong>{t("Appearance")}</strong><span>{t("Choose the workbench color theme")}</span></div>
            <div aria-label={t("Appearance")} className="theme-options" role="group">
              <button aria-pressed={theme === "light"} className={theme === "light" ? "active" : ""} onClick={() => onThemeChange("light")} type="button">
                <span className="theme-preview theme-preview-light"><i /><i /><i /></span>
                <span><strong>{t("Light")}</strong><small>{t("Default")}</small></span>
                {theme === "light" && <Icon name="check" size={15} />}
              </button>
              <button aria-pressed={theme === "dark"} className={theme === "dark" ? "active" : ""} onClick={() => onThemeChange("dark")} type="button">
                <span className="theme-preview theme-preview-dark"><i /><i /><i /></span>
                <span><strong>{t("Dark")}</strong><small>{t("Low-light workspace")}</small></span>
                {theme === "dark" && <Icon name="check" size={15} />}
              </button>
            </div>
          </section>
          </div>

          <div className={settingsSectionClass("usage")}>
            <section className="settings-section settings-info-section">
              <div className="settings-section-copy"><strong>{t("Usage and costs")}</strong><span>{t("A local, inspectable view of TraceGraph activity")}</span></div>
              {usageLoading && <small className="settings-inline-status">{t("Loading usage…")}</small>}
              {usageMessage && <small className="settings-message">{usageMessage}</small>}
              <div className="settings-info-grid">
                <article><span>{t("Runs in ledger")}</span><strong>{usageSnapshot ? usageSnapshot.run_count.toLocaleString() : "—"}</strong><small>{t(usageSnapshot?.source === "ledger" ? "Read from the canonical event ledger" : "No ledger data is available")}</small></article>
                <article><span>{t("Total tokens")}</span><strong>{usageSnapshot ? usageSnapshot.total_tokens.toLocaleString() : "—"}</strong><small>{usageSnapshot ? `${t("Input")} ${usageSnapshot.input_tokens.toLocaleString()} · ${t("Output")} ${usageSnapshot.output_tokens.toLocaleString()}` : t("Waiting for Host usage")}</small></article>
                <article><span>{t("Reported costs")}</span><strong>{usageSnapshot?.costs.length ? usageSnapshot.costs.map(({ amount, currency }) => `${amount.toFixed(4)} ${currency}`).join(" · ") : "—"}</strong><small>{t("Only provider-reported costs are included")}</small></article>
              </div>
              {usageSnapshot && <small className="settings-muted-note">{t("Cached input")} {usageSnapshot.cached_input_tokens.toLocaleString()} · {t("Reasoning output")} {usageSnapshot.reasoning_output_tokens.toLocaleString()} · {new Date(usageSnapshot.generated_at).toLocaleString()}</small>}
            </section>
          </div>

            </div>
          </main>
        </div>
      </section>
    </>
  );
}
