import { useEffect, useRef, useState } from "react";
import type { HostCapabilities, ModelConnectionsSnapshot, PermissionSettingsResponse, ProjectRunDefaultsSnapshot, SessionRunOptionsOverride } from "@tracegraph/contracts";
import type { WorkbenchClient } from "../client";
import { useI18n } from "../i18n";
import { capabilityAvailable, capabilityReadable, commandId, safeError } from "./UnifiedSettings";

export function ProjectDefaultsSettings({ client, capabilities, online }: { client: WorkbenchClient; capabilities: HostCapabilities | null; online: boolean }) {
  const { t } = useI18n(); const projects = client.getSnapshot().availableProjects;
  const [scope, setScope] = useState(client.getSnapshot().project?.id ?? "chat:local"), [snapshot, setSnapshot] = useState<ProjectRunDefaultsSnapshot | null>(null);
  const [models, setModels] = useState<ModelConnectionsSnapshot | null>(null), [draft, setDraft] = useState<SessionRunOptionsOverride>({}), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [version, setVersion] = useState(0);
  const [permission, setPermission] = useState<PermissionSettingsResponse | null>(null);
  const drafts = useRef(new Map<string, SessionRunOptionsOverride>());
  const capRevision = JSON.stringify(capabilities?.capabilities);
  const readable = online && capabilityReadable(capabilities, "project.defaults.read") && Boolean(client.getProjectRunDefaults);
  useEffect(() => {
    if (!readable) return;
    let current = true; setError(null); setBusy(true); setSnapshot(null);
    void client.getProjectRunDefaults!(scope).then((next) => { if (current) { setSnapshot(next); setDraft(drafts.current.get(scope) ?? next.overrides); } }).catch((caught) => { if (current) setError(safeError(caught)); }).finally(() => { if (current) setBusy(false); });
    if (client.getModelConnections && capabilityReadable(capabilities, "models.read")) void client.getModelConnections().then((next) => { if (current) setModels(next); }).catch((caught) => { if (current) setError(safeError(caught)); });
    if (capabilityReadable(capabilities, "permission.read")) void client.getPermissionConfig().then((next) => { if (current) setPermission(next); }).catch((caught) => { if (current) setError(safeError(caught)); });
    return () => { current = false; };
  }, [client, readable, scope, capRevision, version]);
  const update = (key: keyof SessionRunOptionsOverride, value: string) => { const next = { ...draft }; if (value === "") delete next[key]; else Object.assign(next, { [key]: value }); drafts.current.set(scope, next); setDraft(next); };
  const save = async () => { if (!snapshot || busy || !online || !client.updateProjectRunDefaults || !capabilityAvailable(capabilities, "project.defaults.write")) return; setBusy(true); setError(null); try { const next = await client.updateProjectRunDefaults(scope, { command_id: commandId(), expected_revision: snapshot.revision, overrides: draft }); setSnapshot(next); setDraft(next.overrides); drafts.current.delete(scope); } catch (caught) { setError(safeError(caught)); } finally { setBusy(false); } };
  const writable = online && !busy && capabilityAvailable(capabilities, "project.defaults.write") && Boolean(client.updateProjectRunDefaults);
  const changed = snapshot && JSON.stringify(draft) !== JSON.stringify(snapshot.overrides);
  const inherited = <option value="">{t("Inherit from profile")}</option>;
  const choice = (key: keyof SessionRunOptionsOverride, label: string, options: { value: string; label: string }[]) => <label className="project-default-field"><span>{t(label)}<small>{t("Source")}: {t(snapshot?.fields.find((field) => field.path === key)?.source ?? "Unknown")} · {t("Applies to new tasks")}</small></span><select aria-label={`${t("Project default")}: ${t(label)}`} disabled={!writable} value={draft[key] ?? ""} onChange={(event) => update(key, event.target.value)}>{inherited}{options.map((option) => <option key={option.value} value={option.value}>{t(option.label)}</option>)}</select></label>;
  const connection = models?.connections.find((item) => item.connection_id === (draft.connection_id ?? snapshot?.options.connection_id));
  return <section className="project-default-settings"><h3>{t("Project defaults")}</h3><p>{t("Profile defaults are inherited unless a project or conversation explicitly overrides them. Running tasks keep their admitted settings.")}</p><label>{t("Scope")}<select aria-label={t("Defaults scope")} disabled={busy} value={scope} onChange={(event) => setScope(event.target.value)}><option value="chat:local">{t("Plain chat")}</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>{!readable ? <p>{t(!online ? "Reconnect to inspect project defaults." : "Project defaults are unavailable on this installation.")}</p> : snapshot ? <>
    {choice("connection_id", "Model connection", models?.connections.filter((item) => item.has_key).map((item) => ({ value: item.connection_id, label: item.label })) ?? [])}
    {choice("model", "Model", connection?.models.map((model) => ({ value: model, label: model })) ?? [])}
    {choice("reasoning_effort", "Reasoning effort", (connection?.reasoning_by_model?.[draft.model ?? snapshot.options.model ?? connection.model] ?? ["default"]).map((effort) => ({ value: effort, label: effort === "default" ? "Default" : effort })))}
    {choice("mode", "Mode", [{ value: "execute", label: "Execute" }, { value: "plan", label: "Plan" }])}
    {choice("permission_preset", "Permissions", [{ value: "read-only", label: "Read only" }, { value: "workspace-write", label: "Workspace access" }, ...(permission?.ceiling === "full-write" ? [{ value: "full-write", label: "Full access" }] : [])])}
    <p className="setting-metadata">{t("Resolved")}: {snapshot.options.model ?? t("Default model")} · {t(snapshot.options.mode === "plan" ? "Plan" : "Execute")} · {t(snapshot.options.permission_preset)} · {t("Revision")} {snapshot.revision}</p><div className="settings-button-row"><button className="button subtle" disabled={!writable || !changed} onClick={() => void save()} type="button">{t("Save project defaults")}</button><button className="button subtle" disabled={!writable || Object.keys(draft).length === 0} onClick={() => { drafts.current.set(scope, {}); setDraft({}); }} type="button">{t("Clear project overrides")}</button><button className="button subtle" disabled={busy} onClick={() => setVersion(version + 1)} type="button">{t("Refresh")}</button></div></> : busy ? <p role="status">{t("Loading…")}</p> : null}{error && <p role="alert">{t(error)}</p>}</section>;
}
