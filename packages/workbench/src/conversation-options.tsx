import {resolveModelCatalogEntry,SessionRunOptionsSchema} from "@tracegraph/contracts";
import { useEffect, useRef, useState } from "react";
import type { HostCapabilities, ModelConnectionsSnapshot, PermissionGrant, PermissionSettingsResponse, SessionRunOptions, SessionRunOptionsOverride, SessionRunOptionsSnapshot } from "@tracegraph/contracts";
import type { WorkbenchClient } from "./client";
import { useI18n } from "./i18n";
import { Icon } from "./components/Icon";
import { EFFORT_LABELS } from "./components/ReasoningEffortPicker";
import { capabilityAvailable, capabilityReadable, commandId, safeError } from "./components/UnifiedSettings";
import { useComposerPopover } from "./popover";

const defaultOptions: SessionRunOptions = { mode: "execute", reasoning_effort: "default", permission_preset: "workspace-write" };
export function useConversationOptions({ client, scope, sessionId, online, capabilities, refreshKey }: {
  client: WorkbenchClient; scope: string; sessionId: string | null; online: boolean; capabilities: HostCapabilities | null; refreshKey: unknown;
}) {
  const { t } = useI18n();
  const drafts = useRef(new Map<string, SessionRunOptionsOverride>());
  const [overrides, setOverrides] = useState<SessionRunOptionsOverride>({});
  const [fields, setFields] = useState<NonNullable<SessionRunOptionsSnapshot["fields"]>>([]);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [ready, setReady] = useState(false);
  const [options, setOptions] = useState<SessionRunOptions>(defaultOptions);
  const [stored, setStored] = useState<SessionRunOptionsSnapshot | null>(null);
  const [connections, setConnections] = useState<ModelConnectionsSnapshot | null>(null);
  const [modelsState, setModelsState] = useState<"unknown" | "ready" | "failed" | "unavailable">("unknown");
  const [permission, setPermission] = useState<PermissionSettingsResponse | null>(null);
  const [grant, setGrant] = useState<PermissionGrant | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(false);
  const revision = useRef(0);
  const capabilityRevision = JSON.stringify(capabilities?.capabilities);
  useEffect(() => {
    const generation = ++revision.current; setBusy(false); setStored(null); setOptions(SessionRunOptionsSchema.parse({ ...defaultOptions, ...drafts.current.get(scope) })); setOverrides(drafts.current.get(scope) ?? {}); setReady(false); setError(null);
    if (!online) { setLoading(false); return; }
    setLoading(true);
    const read = async () => {
      const [models, policy, eligibility, session, project, profile] = await Promise.allSettled([
        client.getModelConnections && capabilityReadable(capabilities, "models.read") ? client.getModelConnections() : Promise.resolve(null),
        capabilityReadable(capabilities, "permission.read") ? client.getPermissionConfig() : Promise.resolve(null),
        client.getPermissionGrant && capabilityReadable(capabilities, "permission.grant") ? client.getPermissionGrant() : Promise.resolve(null),
        sessionId && client.getSessionRunOptions && capabilityReadable(capabilities, "session.options.read") ? client.getSessionRunOptions(sessionId) : Promise.resolve(null),
        !sessionId && client.getProjectRunDefaults && capabilityReadable(capabilities, "project.defaults.read") ? client.getProjectRunDefaults(scope.startsWith("new-project:") ? scope.slice("new-project:".length) : "chat:local") : Promise.resolve(null),
        !sessionId && capabilityReadable(capabilities, "settings.read") ? client.getWorkbenchSettings() : Promise.resolve(null),
      ]);
      if (generation !== revision.current) return;
      const modelList = models.status === "fulfilled" ? models.value : null;
      setModelsState(models.status === "rejected" ? "failed" : modelList ? "ready" : capabilities ? "unavailable" : "unknown");
      if (modelList) setConnections(modelList); if (policy.status === "fulfilled" && policy.value) setPermission(policy.value); if (eligibility.status === "fulfilled" && eligibility.value) setGrant(eligibility.value);
      const nextStored = session.status === "fulfilled" ? session.value : null; setStored(nextStored);
      const explicit = nextStored ? nextStored.overrides ?? nextStored.options : drafts.current.get(scope) ?? {};
      const base = project.status === "fulfilled" && project.value ? project.value.options : { ...defaultOptions,
        ...(profile.status === "fulfilled" && profile.value ? { reasoning_effort: profile.value.settings.model.reasoning_effort } : {}),
        ...(policy.status === "fulfilled" && policy.value ? { permission_preset: (policy.value.active_preset === "custom" ? "read-only" : policy.value.active_preset) } : {}),
      };
      let next = nextStored?.options ?? SessionRunOptionsSchema.parse({ ...base, ...explicit });
      if (!next.connection_id && modelList?.default_connection_id) { const connection = modelList.connections.find((item) => item.connection_id === modelList.default_connection_id); if (connection) next = { ...next, connection_id: connection.connection_id, model: connection.model }; }
      setOverrides(explicit); setOptions(next); setFields(nextStored?.fields ?? (project.status === "fulfilled" ? project.value?.fields : undefined) ?? []);
      const failed = [models, policy, eligibility, session, project, profile].find((item) => item.status === "rejected"); if (failed?.status === "rejected") setError(safeError(failed.reason));
      setReady(Boolean(sessionId ? nextStored : project.status === "fulfilled" && project.value || profile.status === "fulfilled" && profile.value && policy.status === "fulfilled" && policy.value));
      setLoading(false);
    };
    void read().catch((caught) => { if (generation === revision.current) { setError(safeError(caught)); setLoading(false); } });
    return () => { revision.current += 1; };
  }, [client, scope, sessionId, online, capabilityRevision, refreshKey, reloadVersion]);
  const update = async (patch: Partial<SessionRunOptions>) => {
    if (busy || !online) return;
    const next = { ...options, ...patch }; const nextOverrides = { ...overrides, ...patch }; setBusy(true); setError(null); const generation = revision.current;
    try {
      if (sessionId) { if (!client.updateSessionRunOptions || !stored || !capabilityAvailable(capabilities, "session.options.write")) throw new Error("Conversation options could not be saved. Refresh and try again."); const receipt = await client.updateSessionRunOptions(sessionId, { command_id: commandId(), expected_revision: stored.revision, overrides: nextOverrides }); if (generation !== revision.current) return; setStored(receipt); setOverrides(receipt.overrides ?? receipt.options); setOptions(receipt.options); setFields(receipt.fields ?? []); }
      else { drafts.current.set(scope, nextOverrides); setOverrides(nextOverrides); setOptions(next); }
    } catch (caught) { if (generation === revision.current) setError(safeError(caught)); } finally { if (generation === revision.current) setBusy(false); }
  };
  const reset = async (field?: keyof SessionRunOptionsOverride) => {
    if (busy || !online) return;
    const generation = revision.current; setBusy(true); setError(null);
    try {
      if (sessionId) {
        if (!stored || !client.resetSessionRunOptions || !capabilityAvailable(capabilities, "session.options.reset")) throw new Error("Conversation settings could not be reset. Refresh and try again.");
        const next = await client.resetSessionRunOptions(sessionId, { command_id: commandId(), expected_revision: stored.revision, ...(field ? { fields: [field] } : {}) });
        if (generation !== revision.current) return;
        setStored(next); setOverrides(next.overrides ?? {}); setOptions(next.options); setFields(next.fields ?? []);
      } else {
        const next = { ...overrides }; if (field) delete next[field]; else for (const key of Object.keys(next)) delete next[key as keyof SessionRunOptionsOverride];
        drafts.current.set(scope, next); setOverrides(next); setReloadVersion((value) => value + 1);
      }
    } catch (caught) { if (generation === revision.current) setError(safeError(caught)); }
    finally { if (generation === revision.current) setBusy(false); }
  };
  const allowFull = async () => {
    if (!online || busy || !client.setPermissionGrant || !grant?.can_grant || !capabilityAvailable(capabilities, "permission.grant")) return;
    if (!window.confirm(t("Allow Full access on this local profile? New conversations still default to workspace access. Existing tasks keep their original permissions."))) return;
    const generation = revision.current;
    setBusy(true); setError(null);
    try {
      const saved = await client.setPermissionGrant({ command_id: commandId(), enabled: true, confirmed: true }); if (generation !== revision.current) return; setGrant(saved);
      // A receipt of eligibility is not an effective ceiling. Read until the owner confirms replacement.
      if (saved.pending_restart) { const deadline = Date.now() + 10_000; while (Date.now() < deadline && generation === revision.current) { await new Promise((done) => setTimeout(done, 400)); try { const next = await client.getPermissionGrant!(); if (generation !== revision.current) return; setGrant(next); if (!next.pending_restart) break; } catch { /* Owner replacement is a read recovery only. */ } } }
      const policy = await client.getPermissionConfig(); if (generation === revision.current) setPermission(policy);
    } catch (caught) { if (generation === revision.current) setError(safeError(caught)); } finally { if (generation === revision.current) setBusy(false); }
  };
  return { options, overrides: sessionId ? {} as SessionRunOptionsOverride : overrides, ready, connections, modelsState, permission, grant, loading, busy, error, fields, explicitOverrides: overrides, reset, update, allowFull };
}

export function ComposerModelMenu({ connections, options, onChange, onSettings, disabled }: {
  connections: ModelConnectionsSnapshot | null; options: SessionRunOptions; onChange: (patch: Partial<SessionRunOptions>) => void; onSettings: () => void; disabled: boolean; active: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<"root" | "model" | "effort">("root");
  const popover = useComposerPopover(open, setOpen);
  const selected = connections?.connections.find((item) => item.connection_id === options.connection_id);
  const selectedModel = options.model ?? selected?.model;
  const efforts = selected?.reasoning_by_model?.[selectedModel ?? ""] ?? ["default"];
  const capabilities = selected && selectedModel
    ? resolveModelCatalogEntry(selectedModel, selected.model_catalog, selected.provider, selected.base_url)
    : undefined;
  const selectedCatalogName = selected && selectedModel
    ? resolveModelCatalogEntry(selectedModel, selected.model_catalog, selected.provider, selected.base_url)?.name
    : undefined;
  const close = () => { setOpen(false); setPane("root"); };
  const showPane = (next: "model" | "effort") => setPane(next);

  return (
    <div className="composer-model-menu" {...popover}>
      <button
        aria-label={t("Choose model")}
        className="composer-option"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => { setPane("root"); setOpen(!open); }}
        type="button"
      >
        {selectedCatalogName ?? selectedModel ?? t("Connect model")}
        <span className="composer-selected-effort">· {t(EFFORT_LABELS[options.reasoning_effort])}</span>
        <Icon name="chevron" size={11} />
      </button>
      {open && (
        <div className={`composer-popover model-choice-popover model-choice-${pane}`} aria-label={t("Choose model")}>
          {pane === "root" ? (
            <div className="model-choice-overview">
              <button aria-label={t("Model")} className="model-choice-row" onClick={() => showPane("model")} type="button">
                <span>{t("Model")}</span>
                <span className="model-choice-value">{selectedCatalogName ?? selectedModel ?? t("Connect model")}</span>
                <Icon name="chevron" size={13} />
              </button>
              <button aria-label={t("Reasoning effort")} className="model-choice-row" onClick={() => showPane("effort")} type="button">
                <span>{t("Reasoning effort")}</span>
                <span className="model-choice-value">{t(EFFORT_LABELS[options.reasoning_effort])}</span>
                <Icon name="chevron" size={13} />
              </button>
            </div>
          ) : (
            <>
              <header className="model-choice-header">
                <button aria-label={t("Back")} onClick={() => setPane("root")} type="button"><Icon name="arrow-left" size={15} /></button>
                <strong>{t(pane === "model" ? "Model" : "Reasoning effort")}</strong>
              </header>
              {pane === "model" ? (
                <>
                  <div className="model-choice-list">
                    {connections?.connections.map((connection) => (
                      <section key={connection.connection_id}>
                        <strong>{connection.label}</strong>
                        {connection.models.map((model) => {
                          const catalog = resolveModelCatalogEntry(model, connection.model_catalog, connection.provider, connection.base_url);
                          const isSelected = options.connection_id === connection.connection_id && selectedModel === model;
                          return (
                            <button
                              key={`${connection.connection_id}:${model}`}
                              aria-label={catalog?.name ?? model}
                              aria-pressed={isSelected}
                              disabled={!connection.has_key || disabled}
                              onClick={() => {
                                const supported = connection.reasoning_by_model?.[model] ?? ["default"];
                                onChange({
                                  connection_id: connection.connection_id,
                                  model,
                                  reasoning_effort: supported.includes(options.reasoning_effort) ? options.reasoning_effort : "default",
                                });
                                close();
                              }}
                              type="button"
                            >
                              <span className="model-choice-label">
                                <span>{catalog?.name ?? model}</span>
                                {catalog?.name && catalog.name !== model && <small>{model}</small>}
                                {catalog?.capability_status === "unknown" && <small className="model-capability-unknown">{t("Capabilities unknown")}</small>}
                              </span>
                              {isSelected && <Icon className="composer-menu-check" name="check" size={14} />}
                            </button>
                          );
                        })}
                      </section>
                    ))}
                    {(!connections || connections.connections.length === 0) && <p className="model-choice-empty">{t("No saved model connections yet.")}</p>}
                  </div>
                  {capabilities && (
                    <small className="model-capability-summary">
                      {capabilities.context_window_tokens ? `${capabilities.context_window_tokens.toLocaleString()} ${t("context tokens")}` : t("Context window unknown")}
                      {" · "}
                      {capabilities.max_output_tokens ? `${capabilities.max_output_tokens.toLocaleString()} ${t("output tokens")}` : t("Output limit unknown")}
                    </small>
                  )}
                  <button className="model-choice-manage" onClick={() => { close(); onSettings(); }} type="button"><Icon name="settings" size={14} />{t("Manage model connections")}</button>
                </>
              ) : (
                <div className="model-reasoning-levels" aria-label={t("Reasoning effort")}>
                  {efforts.map((effort) => {
                    const value = effort as SessionRunOptions["reasoning_effort"];
                    return (
                      <button
                        key={effort}
                        aria-pressed={options.reasoning_effort === value}
                        disabled={disabled}
                        onClick={() => { onChange({ reasoning_effort: value }); close(); }}
                        type="button"
                      >
                        <span>{t(EFFORT_LABELS[value])}</span>
                        {options.reasoning_effort === value && <Icon className="composer-menu-check" name="check" size={14} />}
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ComposerPermissionMenu({ options, permission, grant, disabled, onChange, onGrant, active }: {
  options: SessionRunOptions; permission: PermissionSettingsResponse | null; grant: PermissionGrant | null; disabled: boolean; onChange: (patch: Partial<SessionRunOptions>) => void; onGrant: () => void; active: boolean;
}) {
  const { t } = useI18n(); const [open, setOpen] = useState(false);
  const popover = useComposerPopover(open, setOpen);
  const fullEffective = permission?.ceiling === "full-write" && grant?.pending_restart !== true;
  const label = options.permission_preset === "full-write" && fullEffective ? "Full access" : options.permission_preset === "read-only" ? "Read only" : "Workspace access";
  return <div className="composer-permission-menu" {...popover}><button className="composer-option" aria-label={t("Choose permissions")} aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)} type="button"><Icon name="shield" size={12} />{t(label)}<Icon name="chevron" size={11} /></button>{open && <div className="composer-popover"><p>{t(active ? "Applies to the next task" : "Permissions for this conversation")}</p>{permission?.available_presets.map((preset) => <button disabled={preset.key === "full-write" && !fullEffective} aria-pressed={options.permission_preset === preset.key} key={preset.key} onClick={() => { onChange({ permission_preset: preset.key as SessionRunOptions["permission_preset"] }); setOpen(false); }} type="button">{t(preset.key === "full-write" ? "Full access" : preset.key === "read-only" ? "Read only" : "Workspace access")}</button>)}{!fullEffective && <button disabled={!grant?.can_grant || grant.pending_restart} onClick={() => { setOpen(false); onGrant(); }} type="button">{t(grant?.pending_restart ? "Applying permission grant…" : "Allow Full access…")}</button>}<small>{t(grant?.source ?? permission?.source ?? "Permissions have not been loaded")}</small></div>}</div>;
}


export function ConversationSettingsSource({ fields, overrides, onReset, disabled }: { fields: NonNullable<SessionRunOptionsSnapshot["fields"]>; overrides: SessionRunOptionsOverride; onReset: (field?: keyof SessionRunOptionsOverride) => void; disabled: boolean }) {
  const { t } = useI18n();
  const labels = { connection_id: "Model connection", model: "Model", reasoning_effort: "Reasoning effort", mode: "Mode", permission_preset: "Permissions" } as const;
  return <details className="composer-inheritance"><summary>{t(Object.keys(overrides).length ? "Conversation overrides" : "Inherited settings")}</summary><p>{t("Changes apply to the next task. Current work keeps its original settings.")}</p>{Object.entries(labels).map(([key, label]) => <div key={key}><span>{t(label)} · {t(Object.hasOwn(overrides, key) ? "Conversation override" : fields.find((field) => field.path === key)?.source ?? "Unknown")}</span>{Object.hasOwn(overrides, key) && <button disabled={disabled} onClick={() => onReset(key as keyof SessionRunOptionsOverride)} type="button">{t("Reset to inherited")}</button>}</div>)}{Object.keys(overrides).length > 0 && <button disabled={disabled} onClick={() => onReset()} type="button">{t("Reset all conversation overrides")}</button>}</details>;
}
