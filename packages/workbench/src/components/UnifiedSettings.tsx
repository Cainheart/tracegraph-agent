import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { McpConfigSchema, LspConfigSchema, type HostCapabilities, type ModelConnectionTestResult, type WorkbenchSettingsSnapshot, type WorkbenchSettingsValues, type UsageSnapshot, type SkillProjectInspection, type ExtensionStatus, type McpStatusSnapshot, type LspStatusSnapshot, type PermissionSettingsResponse, type TelemetryStatus } from "@tracegraph/contracts";
import type { WorkbenchClient, ModelConfigSnapshot } from "../client";
import { useI18n } from "../i18n";
import { MigrationSettings } from "./MigrationSettings";
import { ModelConnectionsSettings } from "./ModelConnectionsSettings";
import { ImageProviderSettings } from "./ImageProviderSettings";
import { SettingsHistory } from "./SettingsHistory";
import { McpConnectionForm } from "./McpConnectionForm";
import { SettingsCapabilityGuide } from "./SettingsCapabilityGuide";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import { SkillsManager } from "./SkillsManager";
import { VisualRetentionSettingsPanel } from "./VisualRetentionSettings";
import { ComputerSettings } from "./ComputerSettings";
import { PersonalProfile } from "./PersonalProfile";
import { UsageOverview } from "./UsageOverview";
import { Icon } from "./Icon";
import { ReasoningEffortPicker } from "./ReasoningEffortPicker";
import { MODEL_PROVIDER_PRESETS, ModelCredentialStatus, PermissionSettingsSection, TelemetrySettingsSection } from "./SettingsPanel";

export function capabilityFor(capabilities: HostCapabilities | null, operation: string) {
  return capabilities?.capabilities.find((item) => item.operation === operation);
}
export function capabilityAvailable(capabilities: HostCapabilities | null, operation: string): boolean {
  return capabilityFor(capabilities, operation)?.state === "available";
}
export function capabilityReadable(capabilities: HostCapabilities | null, operation: string): boolean {
  const state = capabilityFor(capabilities, operation)?.state; return state === "available" || state === "readonly";
}
const extensionDisplayName = (name: string) => name === "@tracegraph/builtin-artifact-tools" ? "Built-in artifact tools" : name === "@tracegraph/builtin-run-state-tools" ? "Built-in task status tools" : name;
const extensionStateLabel = (state: ExtensionStatus["state"]) => ({ active: "Enabled", inactive: "Disabled", activating: "Enabling…", deactivating: "Disabling…", failed: "Failed", rejected: "Rejected" })[state];
export const commandId = () => globalThis.crypto.randomUUID();
export function safeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "This request could not be completed. Try again.";
}
export const categories = [
  ["general", "General", "Language settings history restore defaults inheritance"],
  ["profile", "Personal profile", "Private local identity data profile export"],
  ["shortcuts", "Keyboard shortcuts", "Send shortcut navigation command palette"],
  ["notifications", "Notifications", "Completion failure approval background system notification"],
  ["appearance", "Appearance", "Theme font density color"],
  ["personalization", "Personalization", "Instructions preferences style"],
  ["model", "Models", "Provider model API credentials reasoning effort"],
  ["permissions", "Permissions", "Sandbox approval policy workspace"],
  ["browser", "Browser", "Browser tabs navigation preview connection"],
  ["computer", "Computer", "Native apps observe input consent handover"],
  ["memory", "Memory and privacy", "Recall consent experience scope"],
  ["developer", "Development environment", "Editor shell worktrees concurrency"],
  ["git", "Git", "Review branch worktree changes"],
  ["skills", "Skills and extensions", "Skills extensions conflicts validation"],
  ["tools", "MCP and LSP", "MCP LSP tools connections"],
  ["tasks", "Tasks and Agents", "Budget goals queues team subagents concurrency"],
  ["usage", "Usage and diagnostics", "Tokens costs telemetry errors connection"],
  ["archive", "Archive", "Archived conversations restore"],
  ["about", "About and updates", "Version profile installation capabilities"],
] as const;
export type SettingsCategory = typeof categories[number][0];

export function UnifiedSettings({ client, open, onClose, onMemory, onApplied, onBrowser, onGoals, background, initialCategory = "general" }: {
  client: WorkbenchClient; open: boolean; onClose: () => void; onMemory: () => void; onApplied: (snapshot: WorkbenchSettingsSnapshot) => void; initialCategory?: SettingsCategory; onBrowser?: () => void; onGoals?: () => void; background?: RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const connection = useSyncExternalStore((listener) => client.subscribe(listener), () => client.getSnapshot().connection, () => client.getSnapshot().connection);
  const online = connection.state === "live";
  const connectionPending = connection.state === "connecting" || connection.state === "reconnecting";
  const [repairing, setRepairing] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const [notificationPermission, setNotificationPermission] = useState(typeof Notification === "undefined" ? "unavailable" : Notification.permission);
  const [category, setCategory] = useState<SettingsCategory>(initialCategory);
  const [search, setSearch] = useState("");
  const [settings, setSettings] = useState<WorkbenchSettingsSnapshot | null>(null);
  const [caps, setCaps] = useState<HostCapabilities | null>(null);
  const preferDailyUsage = capabilityReadable(caps, "usage.daily") && Boolean(client.queryPersonalUsage);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [restartPending, setRestartPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [modelConfig, setModelConfig] = useState<ModelConfigSnapshot | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [test, setTest] = useState<ModelConnectionTestResult | null>(null);
  const [permission, setPermission] = useState<PermissionSettingsResponse | null>(null);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryStatus | null>(null);
  const [skills, setSkills] = useState<readonly SkillProjectInspection[]>([]);
  const [extensions, setExtensions] = useState<readonly ExtensionStatus[]>([]);
  const [mcp, setMcp] = useState<McpStatusSnapshot | null>(null);
  const [lsp, setLsp] = useState<LspStatusSnapshot | null>(null);
  const [diagnostics, setDiagnostics] = useState<string | null>(null);
  const [usageProject, setUsageProject] = useState("");
  const [usageSession, setUsageSession] = useState("");
  const [usageFrom, setUsageFrom] = useState("");
  const [usageTo, setUsageTo] = useState("");
  const [about, setAbout] = useState<Record<string, unknown> | null>(null);
  const [loadedOperations, setLoadedOperations] = useState<readonly string[]>([]);
  const [sectionFailures, setSectionFailures] = useState<Record<string, string>>({});
  const [sectionLoading, setSectionLoading] = useState(false);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => { if (open) { setCategory(initialCategory); setSearch(""); } }, [initialCategory, open]);

  useEffect(() => {
    if (!open) { setApiKey(""); return; }
    if (!online) { setLoading(false); return; }
    let current = true;
    setLoading(true); setError(null); setApiKey("");
    void client.getCapabilities().then(async (capabilities) => {
      if (!current) return;
      setCaps(capabilities);
      if (!capabilityReadable(capabilities, "settings.read")) throw new Error(capabilityFor(capabilities, "settings.read")?.reason ?? "Settings are unavailable. Repair the connection and try again.");
      const snapshot = await client.getWorkbenchSettings();
      if (current) { setSettings(snapshot); setTest(snapshot.model_test ?? null); onApplied(snapshot); }
    }).catch((caught: unknown) => { if (current) setError(safeError(caught)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [client, open, version, online, connection.generation]);

  useEffect(() => {
    if (!open || !caps || !online) { setSectionLoading(false); return; }
    let current = true;
    setSectionLoading(true);
    const queries: Promise<void>[] = [];
    const query = <T,>(operation: string, load: () => Promise<T>, set: (value: T) => void) => {
      if (capabilityFor(caps, operation)?.state === "available" || capabilityFor(caps, operation)?.state === "readonly" || capabilityFor(caps, operation)?.state === "unconfigured") queries.push(load().then((value) => { if (current) { set(value); setLoadedOperations((prior) => prior.includes(operation) ? prior : [...prior, operation]); setSectionFailures((prior) => { const next = { ...prior }; delete next[operation]; return next; }); } }).catch((caught) => { if (current) setSectionFailures((prior) => ({ ...prior, [operation]: safeError(caught) })); throw caught; }));
    };
    if ((search || category === "model")) query("model.configure", () => client.getModelConfig(), setModelConfig);
    if ((search || category === "permissions")) query("permission.read", () => client.getPermissionConfig(), setPermission);
    if ((search || category === "usage")) { if (!preferDailyUsage) query("usage.read", () => client.getUsage(), setUsage); query("telemetry.read", () => client.getTelemetryStatus(), setTelemetry); }
    if ((search || category === "skills")) { if (!client.listManagedSkills || !capabilityReadable(caps, "skills.manage.read")) query("skills.read", () => client.listSkills(), setSkills); query("extensions.read", () => client.listExtensions(), setExtensions); }
    if ((search || category === "tools")) { query("mcp.read", () => client.getMcpStatus(), setMcp); query("lsp.read", () => client.getLspStatus(), setLsp); }
    if (category === "about") query("host.diagnostics", async () => { const result = await client.workbenchCommand({ type: "host.diagnostics", command_id: commandId() }); return JSON.parse(result.text ?? "{}") as Record<string, unknown>; }, setAbout);
    void Promise.allSettled(queries).then((results) => { if (!current) return; const failure = results.find((result) => result.status === "rejected"); if (failure?.status === "rejected") setError(safeError(failure.reason)); setSectionLoading(false); });
    return () => { current = false; };
  }, [category, client, caps, open, Boolean(search), online, connection.generation]);

  useLayoutEffect(() => {
    if (!open || !dialog.current) return;
    const previous = document.activeElement;
    const surface = background?.current, previousInert = surface?.getAttribute("inert");
    // Capture the opener before making its surface inert: browsers may otherwise
    // move focus to the body and lose the real return target.
    surface?.setAttribute("inert", "");
    const controls = () => [...(dialog.current?.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], summary, [tabindex], [contenteditable="true"]') ?? [])].filter((item) => {
      const closed = item.closest("details:not([open])");
      const summary = item.matches("summary") && !item.hasAttribute("tabindex") && item.parentElement?.firstElementChild === item;
      return (summary || item.tabIndex >= 0) && !item.matches(":disabled") && !item.closest('[hidden], [aria-hidden="true"], [inert]') && (!closed || closed.querySelector("summary")?.contains(item)) && item.getClientRects().length > 0;
    });
    const focusBoundary = (end = false) => { const current = controls(); ((end ? current.at(-1) : current[0]) ?? dialog.current)?.focus(); };
    focusBoundary();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialog.current) return;
      const current = controls(), first = current[0], last = current.at(-1);
      if (!dialog.current.contains(document.activeElement) || current.length === 0 || !current.includes(document.activeElement as HTMLElement)) { event.preventDefault(); focusBoundary(event.shiftKey); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); focusBoundary(true); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); focusBoundary(); }
    };
    const containFocus = (event: FocusEvent) => { if (dialog.current && event.target instanceof Node && !dialog.current.contains(event.target)) focusBoundary(); };
    document.addEventListener("keydown", trap);
    document.addEventListener("focusin", containFocus);
    return () => {
      document.removeEventListener("keydown", trap); document.removeEventListener("focusin", containFocus);
      if (surface) { if (previousInert === null) surface.removeAttribute("inert"); else if (previousInert !== undefined) surface.setAttribute("inert", previousInert); }
      if (previous instanceof HTMLElement && previous.isConnected && !previous.closest("[inert]")) previous.focus();
    };
  }, [open, background]);

  const mutate = async (operation: () => Promise<unknown>, success = "Saved") => {
    if (busy) return false;
    setBusy(true); setError(null); setMessage(null);
    try { await operation(); setMessage(success); return true; }
    catch (caught) { setError(safeError(caught).replaceAll(apiKey || "\u0000", "[redacted]")); return false; }
    finally { setBusy(false); }
  };
  const saveSection = <K extends keyof WorkbenchSettingsValues,>(key: K, patch: Partial<WorkbenchSettingsValues[K]>) => mutate(async () => {
    if (!settings) throw new Error("Settings have not been loaded");
    const next = await client.updateWorkbenchSettings({ command_id: commandId(), expected_revision: settings.revision, patch: { [key]: { ...settings.settings[key], ...patch } } });
    setSettings(next); onApplied(next);
  });
  const writable = (path: string) => online && !busy && capabilityAvailable(caps, "settings.write") && settings?.fields.find((field) => field.path === path)?.writable === true;
  const applyRestart = async () => {
    if (busy) return;
    if (!restartPending && !window.confirm(t("Restart Outlive Agent's background service to apply these settings? Active tasks must finish first."))) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      if (!restartPending) { setRestartPending(true); await client.workbenchCommand({ type: "host.restart", command_id: commandId() }); }
      setMessage("Restart requested. Checking the connection…");
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          await client.reconnect(); const next = await client.getWorkbenchSettings();
          if (!next.pending_restart.length) { setSettings(next); onApplied(next); setRestartPending(false); setMessage("Settings applied after restart"); refresh(); return; }
        } catch { /* The owner may be replacing its private socket and HTTP gateway. */ }
        await new Promise((done) => window.setTimeout(done, 300));
      }
      setError("The restart has not been confirmed. Check the connection to inspect this request.");
    } catch (caught) {
      const typed = caught as { code?: string; body?: { error?: string }; protocolError?: { code?: string } };
      const code = typed?.code ?? typed?.body?.error ?? typed?.protocolError?.code;
      if (code === "restart_busy" || code === "host_restart_unavailable") setRestartPending(false);
      setError(safeError(caught));
    }
    finally { setBusy(false); }
  };
  const field = (path: string, label: string, control: ReactNode, description?: string) => {
    const metadata = settings?.fields.find((item) => item.path === path);
    const [section, key] = path.split(".");
    const rawValue = (settings?.settings[section as keyof WorkbenchSettingsValues] as unknown as Record<string, unknown> | undefined)?.[key ?? ""];
    const value = rawValue && typeof rawValue === "object" && !Array.isArray(rawValue) ? t("Managed configuration") : JSON.stringify(rawValue) ?? t("Not loaded");
  return <section className="unified-setting-row" key={path}><div><strong>{t(label)}</strong>{description && <p>{t(description)}</p>}<small className="setting-metadata">{metadata ? `${t(metadata.source)} · ${t(metadata.scope)} · ${t(metadata.effective)}` : t("Metadata unavailable")}{metadata?.reason && ` · ${metadata.reason}`}</small><details className="setting-help"><summary>{t("Help and scope")}</summary><dl className="settings-scope-facts"><dt>{t("Current value")}</dt><dd>{value}</dd><dt>{t("Source")}</dt><dd>{metadata ? t(metadata.source) : t("Not loaded")}</dd><dt>{t("Scope")}</dt><dd>{metadata ? t(metadata.scope) : t("Not loaded")}</dd><dt>{t("Effective")}</dt><dd>{metadata ? t(metadata.effective) : t("Not loaded")}</dd></dl><p>{t(metadata?.effective === "restart" ? "Save first, then apply when active work has finished. A restart request is only complete after the connection confirms the new settings." : metadata?.effective === "new-run" ? "This preference is used by the next admitted task. Current work keeps its original settings." : "The displayed value is the last confirmed setting. A failed save keeps the previous value.")}</p>{!metadata?.writable && <p>{t("This value is controlled by its displayed source. Change that source rather than adding a conflicting override.")}</p>}</details></div><div className="setting-control">{control}</div></section>;
  };
  const toggle = <K extends keyof WorkbenchSettingsValues,>(section: K, key: keyof WorkbenchSettingsValues[K], label: string) => field(`${section}.${String(key)}`, label, <input aria-label={t(label)} type="checkbox" checked={Boolean(settings?.settings[section][key])} disabled={!writable(`${section}.${String(key)}`)} onChange={(event) => void saveSection(section, { [key]: event.target.checked } as Partial<WorkbenchSettingsValues[K]>)} />);
  const repair = async () => { setRepairing(true); setError(null); try { if (client.startHost) await client.startHost(); await client.reconnect(); refresh(); } catch (caught) { setError(safeError(caught)); } finally { setRepairing(false); } };
  const missing = (operation: string) => {
    const capability = capabilityFor(caps, operation);
    const text = connectionPending ? "Connecting to Outlive Agent…" : !online ? "Reconnect to load this feature." : loading || sectionLoading ? "Loading…" : sectionFailures[operation] || !capability || capabilityReadable(caps, operation) ? "This feature could not be loaded. Refresh to try again." : capability.state === "unconfigured" ? "Optional tool connection is not configured. You can continue chatting." : capability.state === "policy-denied" ? "Your current permissions do not allow this feature." : "This feature is unavailable on this installation.";
    return <div className="settings-capability-state"><p>{t(text)}</p>{!online && !connectionPending && <button className="button subtle" disabled={repairing} onClick={() => void repair()} type="button">{t(repairing ? "Connecting…" : "Repair connection")}</button>}<details><summary>{t("Feature diagnostics")}</summary><small>{t(capability?.state ?? "Unknown")} · {capability?.reason}</small></details></div>;
  };
  if (!open) return null;
  const values = settings?.settings;
  const matched = categories.filter(([id, label, keywords]) => `${t(label)} ${keywords}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const displayed = search ? matched.map(([id]) => id) : [category];
  const sectionHeading = (label: string) => !search && t(label) === t(categories.find(([id]) => id === category)?.[1] ?? "Settings") ? null : <h2>{t(label)}</h2>;
  return <section className="unified-settings settings-panel" aria-label={t("Settings")} role="dialog" aria-modal="true" tabIndex={-1} ref={dialog}>
    <aside className="settings-sidebar"><button className="settings-back" onClick={onClose} type="button"><Icon name="arrow-left" size={16} />{t("Back to workbench")}</button><h2>{t("Settings")}</h2><label className="settings-search"><Icon name="search" size={14} /><input aria-label={t("Search settings")} type="search" placeholder={t("Search settings")} value={search} onChange={(event) => setSearch(event.target.value)} /></label><nav aria-label={t("Settings sections")}>{categories.map(([id, label]) => <button aria-current={!search && category === id ? "page" : undefined} className={category === id ? "active" : ""} key={id} onClick={() => { setCategory(id); setSearch(""); setError(null); }} type="button">{t(label)}</button>)}</nav><small>Outlive Agent</small></aside>
    <main className="settings-main"><header><h1>{search ? t("Search results") : t(categories.find(([id]) => id === category)?.[1] ?? "Settings")}</h1><button className="button subtle" disabled={busy || loading} onClick={refresh} type="button"><Icon name="refresh" size={13} />{t("Refresh")}</button></header>
      {!online && <div className="settings-connection-state" role="status"><p>{t(connectionPending ? connection.state === "connecting" ? "Connecting to Outlive Agent…" : "Restoring your connection…" : settings ? "Showing the last loaded settings. Reconnect to confirm current values." : "Reconnect to load your settings.")}</p>{!connectionPending && <button className="button subtle" disabled={repairing} onClick={() => void repair()} type="button">{t(repairing ? "Connecting…" : "Repair connection")}</button>}</div>}
      <fieldset className="settings-content-fields" disabled={!online || repairing}>
      {loading && <p role="status">{t("Loading settings…")}</p>}
      {error && <div className="settings-error" role="alert">{t(error)}<button className="button subtle" disabled={busy} onClick={refresh} type="button">{t("Refresh")}</button></div>}
      {message && <p role="status" className="settings-success">{t(message)}</p>}
      {settings?.pending_restart.length || restartPending ? <div className="settings-button-row"><p role="status">{t("Apply after restart")}{settings?.pending_restart.length ? `: ${settings.pending_restart.join(", ")}` : ""}</p>{(restartPending || capabilityAvailable(caps, "host.restart")) && <button className="button subtle" disabled={busy} onClick={() => void applyRestart()} type="button">{t(restartPending ? "Check restart" : "Restart to apply")}</button>}</div> : null}
      {matched.length === 0 && <p>{t("No settings match this search")}</p>}
      {sectionLoading && <p role="status">{t("Loading capability status…")}</p>}
      {values && displayed.includes("general") && <div className="settings-group">{sectionHeading("General")}
        {toggle("general", "prevent_sleep_during_tasks", "Keep this computer awake during active tasks")}
        <p className="setting-metadata">{t("Off by default. Desktop prevents automatic app suspension only while a task is executing. It does not prevent screen locking, lid closure or manual sleep.")}</p>
        {field("general.language", "Language", <select aria-label={t("Language")} disabled={!writable("general.language")} value={values.general.language} onChange={(event) => void saveSection("general", { language: event.target.value as "en" | "zh-CN" })}><option value="zh-CN">中文</option><option value="en">English</option></select>)}
        <ProjectDefaultsSettings client={client} capabilities={caps} online={online} />
        {settings && <SettingsHistory client={client} capabilities={caps} snapshot={settings} online={online} onApplied={(next) => { setSettings(next); onApplied(next); }} />}
      </div>}
      {values && displayed.includes("shortcuts") && <div className="settings-group">{sectionHeading("Keyboard shortcuts")}
        {field("general.enter_behavior", "Send shortcut", <select aria-label={t("Send shortcut")} disabled={!writable("general.enter_behavior")} value={values.general.enter_behavior} onChange={(event) => void saveSection("general", { enter_behavior: event.target.value as "enter" | "mod-enter" })}><option value="enter">Enter</option><option value="mod-enter">⌘ / Ctrl + Enter</option></select>)}
        <div className="shortcut-reference"><p>⌘ / Ctrl + B · {t("Toggle navigation")}</p><p>⌘ / Ctrl + K · {t("Command palette")}</p><p>⌘ / Ctrl + , · {t("Settings")}</p></div>
        <SettingsCapabilityGuide category="shortcuts" capabilities={caps} online={online} client={client} onNavigate={setCategory} />
      </div>}
      {values && displayed.includes("notifications") && <div className="settings-group">{sectionHeading("Notifications")}
        {toggle("general", "notify_completed", "Notify when completed")}{toggle("general", "notify_failed", "Notify when failed")}{toggle("general", "notify_approval", "Notify when approval is needed")}
        <p>{t("System notifications require a connected client and permission. Recorded notifications remain available after reconnecting.")}</p><div className="settings-button-row"><small>{t("System notifications")}: {t(notificationPermission)}</small><button className="button subtle" disabled={notificationPermission !== "default"} onClick={() => void Notification.requestPermission().then(setNotificationPermission).catch((error) => setError(safeError(error)))} type="button">{t("Allow system notifications")}</button></div>
      </div>}
      {values && displayed.includes("appearance") && <div className="settings-group">{sectionHeading("Appearance")}{field("appearance.theme", "Theme", <select aria-label={t("Theme")} disabled={!writable("appearance.theme")} value={values.appearance.theme} onChange={(event) => void saveSection("appearance", { theme: event.target.value as "system" | "light" | "dark" })}>{["system", "light", "dark"].map((theme) => <option key={theme} value={theme}>{t(theme)}</option>)}</select>)}
        {(["ui_font_size", "code_font_size"] as const).map((key) => field(`appearance.${key}`, key === "ui_font_size" ? "UI font size" : "Code font size", <input aria-label={t(key === "ui_font_size" ? "UI font size" : "Code font size")} disabled={!writable(`appearance.${key}`)} type="number" min={key === "ui_font_size" ? 12 : 11} max={24} value={values.appearance[key]} onChange={(event) => { const value = Number(event.target.value); if (value >= (key === "ui_font_size" ? 12 : 11) && value <= 24) void saveSection("appearance", { [key]: value }); }} />))}
        {field("appearance.output_density", "Output density", <select disabled={!writable("appearance.output_density")} aria-label={t("Output density")} value={values.appearance.output_density} onChange={(event) => void saveSection("appearance", { output_density: event.target.value as "compact" | "expanded" })}><option value="compact">{t("Compact")}</option><option value="expanded">{t("Expanded")}</option></select>)}
      </div>}
      {displayed.includes("model") && <div className="settings-group">{sectionHeading("Models")}<ModelConnectionsSettings client={client} capabilities={caps} online={online} generation={connection.generation} />{values && field("model.reasoning_effort", "Default reasoning effort", <ReasoningEffortPicker disabled={!writable("model.reasoning_effort")} onChange={(reasoning_effort) => void saveSection("model", { reasoning_effort })} value={values.model.reasoning_effort} />)}<ImageProviderSettings client={client} capabilities={caps} /></div>}
      {displayed.includes("permissions") && <div className="settings-group">{sectionHeading("Permissions")}{permission ? <PermissionSettingsSection message={null} onSelect={(preset_key) => void mutate(async () => { setPermission(await client.configurePermissionPreset({ preset_key })); }, "Applies to new runs")} saving={busy || !capabilityAvailable(caps, "permission.write")} snapshot={permission} supported /> : !sectionLoading && missing("permission.read")}</div>}
      {values && displayed.includes("memory") && <div className="settings-group">{sectionHeading("Memory and privacy")}{toggle("memory", "memory_recall", "Enable reviewed Memory recall")}{toggle("memory", "experience_recall", "Enable validated Experience recall")}
        {field("memory.project_ids", "Recall project scope", <SettingText disabled={!writable("memory.project_ids")} value={values.memory.project_ids.join(", ")} onSave={(value) => void saveSection("memory", { project_ids: value.split(",").map((id) => id.trim()).filter(Boolean) })} />)}
        <p>{t("Recall still checks provenance, review, consent, scope and policy. Enabling it does not activate candidates.")}</p><button className="button subtle" onClick={onMemory} type="button">{t("Manage Memory and Experience")}</button><VisualRetentionSettingsPanel key={caps?.profile_id} client={client} capabilities={caps}/></div>}
      {values && displayed.includes("developer") && <div className="settings-group">{sectionHeading("Developer")}{(["editor", "shell", "worktree_directory"] as const).map((key) => field(`developer.${key}`, key === "editor" ? "External editor" : key === "shell" ? "Terminal shell" : "Worktree directory", <SettingText disabled={!writable(`developer.${key}`)} value={values.developer[key]} onSave={(value) => void saveSection("developer", { [key]: value })} />))}
      </div>}
      {values && displayed.includes("browser") && <div className="settings-group">{sectionHeading("Browser")}        {field("developer.preview_open", "Open preview in", <select aria-label={t("Open preview in")} disabled={!writable("developer.preview_open")} value={values.developer.preview_open} onChange={(event) => void saveSection("developer", { preview_open: event.target.value as "panel" | "browser" })}><option value="panel">{t("Panel")}</option><option value="browser">{t("Browser")}</option></select>)}
<SettingsCapabilityGuide category="browser" capabilities={caps} online={online} client={client} onNavigate={setCategory} {...(onBrowser ? { onOpenBrowser: onBrowser } : {})} />
      </div>}
      {values && displayed.includes("git") && <div className="settings-group">{sectionHeading("Git")}        {field("developer.review_scope", "Default Git review", <select disabled={!writable("developer.review_scope")} aria-label={t("Default Git review")} value={values.developer.review_scope} onChange={(event) => void saveSection("developer", { review_scope: event.target.value as "workspace" | "staged" | "branch" })}>{["workspace", "staged", "branch"].map((scope) => <option key={scope}>{scope}</option>)}</select>)}
<SettingsCapabilityGuide category="git" capabilities={caps} online={online} client={client} onNavigate={setCategory} />
      </div>}
      {values && displayed.includes("tasks") && <div className="settings-group">{sectionHeading("Tasks and Agents")}        {field("developer.max_parallel_runs", "Parallel runs", <input aria-label={t("Parallel runs")} type="number" min={1} max={16} value={values.developer.max_parallel_runs} disabled={!writable("developer.max_parallel_runs")} onChange={(event) => { const max_parallel_runs = Number(event.target.value); if (max_parallel_runs >= 1 && max_parallel_runs <= 16) void saveSection("developer", { max_parallel_runs }); }} />)}
<SettingsCapabilityGuide category="tasks" capabilities={caps} online={online} client={client} onNavigate={setCategory} />
      </div>}
      {values && displayed.includes("skills") && <div className="settings-group">{sectionHeading("Skills and extensions")}<h3>{t("Skills")}</h3>{client.listManagedSkills && capabilityReadable(caps, "skills.manage.read") ? <SkillsManager key={caps?.profile_id} client={client} capabilities={caps} /> : !loadedOperations.includes("skills.read") || Boolean(sectionFailures["skills.read"]) || !capabilityReadable(caps, "skills.read") ? missing("skills.read") : skills.length === 0 ? <p>{t("No registered projects expose Skills.")}</p> : skills.map((inspection) => <section key={inspection.project_id}><h4>{inspection.label}</h4>{inspection.registry.skills.map((skill) => <label key={skill.name} className="settings-skill-row"><input type="checkbox" checked={!values.tools.disabled_skills.includes(skill.name)} disabled={!writable("tools.disabled_skills")} onChange={(event) => void saveSection("tools", { disabled_skills: event.target.checked ? values.tools.disabled_skills.filter((name) => name !== skill.name) : [...values.tools.disabled_skills, skill.name] })} /><span><strong>{skill.name}</strong><small>{skill.version} · {skill.source}</small><p>{skill.description}</p></span></label>)}<details><summary>{t("Conflicts and validation diagnostics")}: {inspection.registry.conflicts.length + inspection.registry.diagnostics.length}</summary><pre>{JSON.stringify({ conflicts: inspection.registry.conflicts, diagnostics: inspection.registry.diagnostics }, null, 2)}</pre></details><button className="button subtle" disabled={busy || !capabilityAvailable(caps, "skills.validate")} onClick={() => void mutate(async () => { const result = await client.workbenchCommand({ type: "skills.validate", command_id: commandId(), project_id: inspection.project_id }); setDiagnostics(result.text ?? result.message); }, "Validation finished")} type="button">{t("Validate Skills")}</button></section>)}
        <h3>{t("Extensions")}</h3>{loadedOperations.includes("extensions.read") && !sectionFailures["extensions.read"] && !sectionLoading && extensions.length === 0 && <p>{t("No extensions are configured.")}</p>}{(!loadedOperations.includes("extensions.read") || Boolean(sectionFailures["extensions.read"]) || !capabilityReadable(caps, "extensions.read")) && missing("extensions.read")}{extensions.map((extension) => <section key={extension.name} className="settings-extension-row"><label><input type="checkbox" checked={!values.tools.disabled_extensions.includes(extension.name)} disabled={!writable("tools.disabled_extensions")} onChange={(event) => void saveSection("tools", { disabled_extensions: event.target.checked ? values.tools.disabled_extensions.filter((name) => name !== extension.name) : [...values.tools.disabled_extensions, extension.name] })} />{t(extensionDisplayName(extension.name))}</label><details><summary>{t("Extension identifier")}</summary><code>{extension.name}</code><p>{t("Generation")}: {extension.generation}</p></details><small>{t(extensionStateLabel(extension.state))}</small><button className="button subtle" disabled={busy || !capabilityAvailable(caps, "extensions.reload")} onClick={() => void mutate(async () => { await client.reloadExtension(extension.name); refresh(); }, "Reload completed")} type="button">{t("Reload")}</button></section>)}
        {diagnostics && <details><summary>{t("Validation result")}</summary><pre>{diagnostics}</pre></details>}</div>}
      {values && displayed.includes("tools") && <div className="settings-group">{sectionHeading("MCP and LSP")}<h3>{t("MCP servers")}</h3>{mcp?.servers.length === 0 && <p>{t("No MCP servers are configured.")}</p>}{(!mcp || Boolean(sectionFailures["mcp.read"])) && missing("mcp.read")}{mcp?.servers.map((server) => <div className="settings-extension-row" key={server.name}><span><strong>{server.name}</strong><small>{server.state} · {server.tool_count} {t("tools")} {server.error_code}</small></span><button className="button subtle" disabled={busy || !capabilityAvailable(caps, "mcp.restart")} onClick={() => void mutate(async () => { await client.restartMcpServer(server.name); refresh(); }, "Restart completed")} type="button">{t("Restart")}</button></div>)}
        <McpConnectionForm value={values.tools.mcp} disabled={!writable("tools.mcp")} onSave={async (mcp) => { if (!await saveSection("tools", { mcp })) throw new Error("MCP configuration was not saved. Inspect the error and try again."); }} />
        {field("tools.mcp", "MCP configuration", <JsonSetting disabled={!writable("tools.mcp")} value={values.tools.mcp} onSave={(value) => void saveSection("tools", { mcp: McpConfigSchema.parse(value) })} />)}
        <h3>{t("LSP servers")}</h3>{lsp?.servers.length === 0 && <p>{t("No LSP servers are configured.")}</p>}{(!lsp || Boolean(sectionFailures["lsp.read"])) && missing("lsp.read")}{lsp?.servers.map((server) => <div className="settings-extension-row" key={server.name}><span>{server.name} · {server.state} · {server.diagnostics_count} {t("diagnostics")} {server.error_code}</span><button className="button subtle" disabled={busy || !capabilityAvailable(caps, "lsp.restart")} onClick={() => void mutate(async () => { await client.workbenchCommand({ type: "lsp.restart", command_id: commandId(), server_name: server.name }); refresh(); }, "Restart completed")} type="button">{t("Restart")}</button></div>)}
        {field("tools.lsp", "LSP configuration", <JsonSetting disabled={!writable("tools.lsp")} value={values.tools.lsp} onSave={(value) => void saveSection("tools", { lsp: LspConfigSchema.parse(value) })} />)}
        {diagnostics && <details><summary>{t("Validation result")}</summary><pre>{diagnostics}</pre></details>}<p>{t("Configuration uses typed Host validation and credential references. Restart requirements are shown after saving.")}</p>
      </div>}
      {displayed.includes("usage") && <div className="settings-group">{sectionHeading("Usage and diagnostics")}{preferDailyUsage ? <UsageOverview client={client} capabilities={caps} online={online} generation={connection.generation} /> : <><div className="usage-filter-row"><label>{t("Project")}<select aria-label={t("Usage project")} value={usageProject} onChange={(event) => setUsageProject(event.target.value)}><option value="">{t("All projects")}</option>{client.getSnapshot().availableProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label>{t("Session")}<select aria-label={t("Usage session")} value={usageSession} onChange={(event) => setUsageSession(event.target.value)}><option value="">{t("All sessions")}</option>{client.getSnapshot().sessions.map((session) => <option key={session.session_id} value={session.session_id}>{session.title ?? session.session_id}</option>)}</select></label><label>{t("From")}<input aria-label={t("Usage from")} type="datetime-local" value={usageFrom} onChange={(event) => setUsageFrom(event.target.value)} /></label><label>{t("To")}<input aria-label={t("Usage to")} type="datetime-local" value={usageTo} onChange={(event) => setUsageTo(event.target.value)} /></label><button className="button subtle" disabled={busy || !capabilityAvailable(caps, "usage.query")} onClick={() => void mutate(async () => { const result = await client.workbenchCommand({ type: "usage.query", command_id: commandId(), ...(usageProject ? { project_id: usageProject } : {}), ...(usageSession ? { session_id: usageSession } : {}), ...(usageFrom ? { from: new Date(usageFrom).toISOString() } : {}), ...(usageTo ? { to: new Date(usageTo).toISOString() } : {}) }); if (!result.usage) throw new Error("Usage result is unavailable"); setUsage(result.usage); }, "Usage filters applied")} type="button">{t("Apply filters")}</button></div>{usage ? <><p>{t("Runs in ledger")}: {usage.run_count} · {t("Total tokens")}: {usage.total_tokens}</p><p>{t("Input")}: {usage.input_tokens} · {t("Output")}: {usage.output_tokens} · {t("Cached input")}: {usage.cached_input_tokens} · {t("Reasoning output")}: {usage.reasoning_output_tokens}</p><p>{t("Reported costs")}: {usage.costs.length ? usage.costs.map((cost) => `${cost.amount} ${cost.currency}`).join(" · ") : t("Unknown")}</p><small>{usage.generated_at} · {t("Only provider-reported costs are included")}</small></> : !sectionLoading && missing("usage.read")}</>}
        <TelemetrySettingsSection snapshot={telemetry} message={null} supported={capabilityAvailable(caps, "telemetry.read")} />
        {values && <>{toggle("telemetry", "enabled", "Enable telemetry export")}{field("telemetry.endpoint", "Telemetry endpoint", <SettingText disabled={!writable("telemetry.endpoint")} value={values.telemetry.endpoint} onSave={(endpoint) => void saveSection("telemetry", { endpoint })} />)}{field("telemetry.authorization_ref", "Telemetry credential reference", <SettingText disabled={!writable("telemetry.authorization_ref")} value={values.telemetry.authorization_ref} onSave={(authorization_ref) => void saveSection("telemetry", { authorization_ref })} />)}</>}
        <button className="button subtle" disabled={busy || !capabilityAvailable(caps, "host.diagnostics")} onClick={() => void mutate(async () => { const result = await client.workbenchCommand({ type: "host.diagnostics", command_id: commandId() }); setDiagnostics(result.text ?? result.message); }, "Diagnostics loaded locally")} type="button">{t("Inspect Host diagnostics")}</button>{diagnostics && <details open><summary>{t("Local diagnostic report")}</summary><pre>{diagnostics}</pre><button className="button subtle" onClick={() => { const url = URL.createObjectURL(new Blob([diagnostics], { type: "text/plain" })); const link = document.createElement("a"); link.href = url; link.download = "outlive-diagnostics.txt"; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 0); }} type="button">{t("Save diagnostic report")}</button></details>}
      </div>}
      {displayed.includes("computer") && <div className="settings-group">{sectionHeading("Computer")}<ComputerSettings client={client} capabilities={caps} online={online} generation={connection.generation} /></div>}
      {displayed.includes("profile") && <div className="settings-group">{sectionHeading("Personal profile")}<PersonalProfile client={client} capabilities={caps} online={online} generation={connection.generation} /><UsageOverview client={client} capabilities={caps} online={online} generation={connection.generation} /></div>}
      {displayed.filter((id) => ["personalization", "archive"].includes(id)).map((id) => <div className="settings-group" key={id}>{sectionHeading(categories.find(([categoryId]) => categoryId === id)?.[1] ?? id)}<SettingsCapabilityGuide category={id} capabilities={caps} online={online} client={client} onNavigate={setCategory} /></div>)}
      {displayed.includes("about") && <div className="settings-group"><h2>Outlive Agent</h2><p>{t("Closing this window keeps your tasks running. Reopen Outlive Agent to continue.")}</p><div className="settings-button-row"><button className="button subtle" disabled={busy} onClick={() => void mutate(async () => { if (client.startHost && capabilityAvailable(caps, "host.start")) await client.startHost(); else await client.reconnect(); refresh(); }, "Connection recovered")} type="button">{t("Repair connection")}</button></div><MigrationSettings client={client} capabilities={caps} /><details className="installation-diagnostics"><summary>{t("Installation diagnostics")}</summary><p>{t("App version")}: {typeof about?.app_version === "string" ? about.app_version : t("Unavailable")} · {t("Host version")}: {typeof about?.host_version === "string" ? about.host_version : t("Unavailable")} · {t("CLI version")}: {typeof about?.cli_version === "string" ? about.cli_version : t("Unavailable")}</p><p>{t("Host lifecycle")}: {t("Closing this client does not stop the Host or background tasks.")}</p><p>{t("Start or reconnect the local Host from the CLI")}: <code>node apps/cli/dist/index.js host start</code></p><button className="button danger" disabled={busy || !capabilityAvailable(caps, "host.stop")} onClick={() => { if (window.confirm(t("Stop this local Host and its active tasks, terminals, previews and schedules?"))) void mutate(() => client.workbenchCommand({ type: "host.stop", command_id: commandId() }), "Host shutdown requested"); }} type="button">{t("Stop local Host")}</button><p>{t("Profile")}: {caps?.profile_id ?? t("Unavailable")}</p><p>{t("Protocol")}: {caps?.protocol_version ?? t("Unavailable")}</p><p>{t("Settings revision")}: {settings?.revision ?? "—"}</p><details><summary>{t("Host capabilities")}</summary>{caps?.capabilities.map((capability) => <p key={capability.operation}><code>{capability.operation}</code> · {t(capability.state)} · {t(capability.scope)} {capability.reason}</p>)}</details></details></div>}
      </fieldset>
    </main>
  </section>;
}

function SettingText({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (value: string) => void }) {
  const { t } = useI18n(); const [draft, setDraft] = useState(value); useEffect(() => setDraft(value), [value]);
  return <div className="setting-text-edit"><input aria-label={t("Setting value")} disabled={disabled} value={draft} onChange={(event) => setDraft(event.target.value)} /><button className="button subtle" disabled={disabled || draft === value} onClick={() => onSave(draft)} type="button">{t("Save")}</button></div>;
}
function JsonSetting({ value, disabled, onSave }: { value: unknown; disabled: boolean; onSave: (value: unknown) => void }) {
  const { t } = useI18n(); const [draft, setDraft] = useState(JSON.stringify(value, null, 2)); const [error, setError] = useState<string | null>(null); useEffect(() => { setDraft(JSON.stringify(value, null, 2)); setError(null); }, [value]);
  return <details className="typed-config-editor"><summary>{t("Edit configuration")}</summary><textarea aria-label={t("Configuration JSON")} disabled={disabled} spellCheck={false} rows={12} value={draft} onChange={(event) => setDraft(event.target.value)} /><button className="button subtle" disabled={disabled || draft === JSON.stringify(value, null, 2)} onClick={() => { try { onSave(JSON.parse(draft)); setError(null); } catch { setError(t("Configuration is invalid. Check the typed format and credential references.")); } }} type="button">{t("Validate and save")}</button>{error && <p role="alert">{error}</p>}</details>;
}
