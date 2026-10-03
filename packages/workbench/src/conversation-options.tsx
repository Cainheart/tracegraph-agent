import { useEffect, useRef, useState } from "react";
import type { HostCapabilities, ModelConnectionsSnapshot, PermissionGrant, PermissionSettingsResponse, SessionRunOptions, SessionRunOptionsSnapshot } from "@tracegraph/contracts";
import type { WorkbenchClient } from "./client";
import { useI18n } from "./i18n";
import { Icon } from "./components/Icon";
import { EFFORT_LABELS, ReasoningEffortPicker } from "./components/ReasoningEffortPicker";
import { capabilityAvailable, capabilityReadable, commandId, safeError } from "./components/UnifiedSettings";
import { useComposerPopover } from "./popover";

const defaultOptions: SessionRunOptions = { mode: "execute", reasoning_effort: "default", permission_preset: "workspace-write" };
export function useConversationOptions({ client, scope, sessionId, online, capabilities, refreshKey }: {
  client: WorkbenchClient; scope: string; sessionId: string | null; online: boolean; capabilities: HostCapabilities | null; refreshKey: unknown;
}) {
  const { t } = useI18n();
  const drafts = useRef(new Map<string, SessionRunOptions>());
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
    const generation = ++revision.current; setBusy(false); setStored(null); setOptions(drafts.current.get(scope) ?? defaultOptions); setError(null);
    if (!online) { setLoading(false); return; }
    setLoading(true);
    const read = async () => {
      const [models, policy, eligibility, session] = await Promise.allSettled([
        client.getModelConnections && capabilityReadable(capabilities, "models.read") ? client.getModelConnections() : Promise.resolve(null),
        capabilityReadable(capabilities, "permission.read") ? client.getPermissionConfig() : Promise.resolve(null),
        client.getPermissionGrant && capabilityReadable(capabilities, "permission.grant") ? client.getPermissionGrant() : Promise.resolve(null),
        sessionId && client.getSessionRunOptions && capabilityReadable(capabilities, "session.options.read") ? client.getSessionRunOptions(sessionId) : Promise.resolve(null),
      ]);
      if (generation !== revision.current) return;
      const modelList = models.status === "fulfilled" ? models.value : null;
      setModelsState(models.status === "rejected" ? "failed" : modelList ? "ready" : capabilities ? "unavailable" : "unknown");
      if (modelList) setConnections(modelList); if (policy.status === "fulfilled" && policy.value) setPermission(policy.value); if (eligibility.status === "fulfilled" && eligibility.value) setGrant(eligibility.value);
      const nextStored = session.status === "fulfilled" ? session.value : null; setStored(nextStored);
      let next = nextStored?.options ?? drafts.current.get(scope) ?? defaultOptions;
      if (!next.connection_id && modelList?.default_connection_id) { const connection = modelList.connections.find((item) => item.connection_id === modelList.default_connection_id); if (connection) next = { ...next, connection_id: connection.connection_id, model: connection.model }; }
      drafts.current.set(scope, next); setOptions(next);
      const failed = [models, policy, eligibility, session].find((item) => item.status === "rejected"); if (failed?.status === "rejected") setError(safeError(failed.reason));
      setLoading(false);
    };
    void read().catch((caught) => { if (generation === revision.current) { setError(safeError(caught)); setLoading(false); } });
    return () => { revision.current += 1; };
  }, [client, scope, sessionId, online, capabilityRevision, refreshKey]);
  const update = async (patch: Partial<SessionRunOptions>) => {
    if (busy || !online) return;
    const next = { ...options, ...patch }; setBusy(true); setError(null); const generation = revision.current;
    try {
      if (sessionId) { if (!client.updateSessionRunOptions || !stored || !capabilityAvailable(capabilities, "session.options.write")) throw new Error("Conversation options could not be saved. Refresh and try again."); const receipt = await client.updateSessionRunOptions(sessionId, { command_id: commandId(), expected_revision: stored.revision, options: next }); if (generation !== revision.current) return; setStored(receipt); drafts.current.set(scope, receipt.options); setOptions(receipt.options); }
      else { drafts.current.set(scope, next); setOptions(next); }
    } catch (caught) { if (generation === revision.current) setError(safeError(caught)); } finally { if (generation === revision.current) setBusy(false); }
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
  return { options, connections, modelsState, permission, grant, loading, busy, error, update, allowFull };
}

export function ComposerModelMenu({ connections, options, onChange, onSettings, disabled, active }: {
  connections: ModelConnectionsSnapshot | null; options: SessionRunOptions; onChange: (patch: Partial<SessionRunOptions>) => void; onSettings: () => void; disabled: boolean; active: boolean;
}) {
  const { t } = useI18n(); const [open, setOpen] = useState(false);
  const popover = useComposerPopover(open, setOpen);
  const selected = connections?.connections.find((item) => item.connection_id === options.connection_id);
  return <div className="composer-model-menu" {...popover}><button aria-label={t("Choose model")} className="composer-option" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)} type="button">{options.model ?? selected?.model ?? t("Connect model")}{options.reasoning_effort !== "default" && <span className="composer-selected-effort">· {t(EFFORT_LABELS[options.reasoning_effort])}</span>}<Icon name="chevron" size={11} /></button>{open && <div className="composer-popover model-choice-popover"><p>{t(active ? "Applies to the next task" : "Model for this conversation")}</p>{connections?.connections.map((connection) => <section key={connection.connection_id}><strong>{connection.label} · {connection.provider}</strong>{connection.models.map((model) => <button disabled={!connection.has_key} aria-pressed={options.connection_id === connection.connection_id && options.model === model} onClick={() => { onChange({ connection_id: connection.connection_id, model, reasoning_effort: (connection.reasoning_by_model?.[model] ?? ["default"]).includes(options.reasoning_effort) ? options.reasoning_effort : "default" }); setOpen(false); }} key={model} type="button">{model}{options.connection_id === connection.connection_id && options.model === model && <Icon name="check" size={12} />}</button>)}</section>)}<ReasoningEffortPicker compact allowed={selected?.reasoning_by_model?.[options.model ?? selected.model] ?? ["default"]} disabled={disabled} onChange={(reasoning_effort) => onChange({ reasoning_effort })} value={options.reasoning_effort} /><button onClick={() => { setOpen(false); onSettings(); }} type="button"><Icon name="settings" size={13} />{t("Manage model connections")}</button></div>}</div>;
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
