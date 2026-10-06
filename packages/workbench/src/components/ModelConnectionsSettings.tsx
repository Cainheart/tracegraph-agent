import { useEffect, useRef, useState } from "react";
import type { HostCapabilities, ModelCatalogEntry, ModelConnection, ModelConnectionsSnapshot, ModelConnectionSaveRequest, ModelConnectionTestResult } from "@tracegraph/contracts";
import type { WorkbenchClient } from "../client";
import { useI18n } from "../i18n";
import { MODEL_PROVIDER_PRESETS } from "./SettingsPanel";
import { capabilityAvailable, capabilityReadable, commandId, safeError } from "./UnifiedSettings";
import { ModelCapabilityTests } from "./ModelCapabilityTests";

const emptyDraft = (): Omit<ModelConnectionSaveRequest, "command_id"> => ({ label: "", provider: "openai", protocol: "openai-chat-completions", base_url: "https://api.openai.com/v1", model: "", models: [], image_input_models: [] });

function catalogSummary(entry: ModelCatalogEntry, t: (value: string) => string) {
  const values = [
    entry.context_window_tokens ? `${entry.context_window_tokens.toLocaleString()} ${t("context tokens")}` : null,
    entry.max_output_tokens ? `${entry.max_output_tokens.toLocaleString()} ${t("output tokens")}` : null,
    entry.input_modalities ? `${t("Input")}: ${entry.input_modalities.join(", ")}` : null,
    entry.output_modalities ? `${t("Output")}: ${entry.output_modalities.join(", ")}` : null,
    entry.reasoning_efforts ? `${t("Reasoning effort")}: ${entry.reasoning_efforts.join(", ")}` : null,
  ].filter((value): value is string => Boolean(value));
  return values.length ? values.join(" · ") : t("Capabilities were not reported by this provider.");
}

export function ModelConnectionsSettings({ client, capabilities, online, generation }: { client: WorkbenchClient; capabilities: HostCapabilities | null; online: boolean; generation?: number | undefined }) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<ModelConnectionsSnapshot | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [models, setModels] = useState("");
  const [busy, setBusy] = useState(false);
  const [catalogBusy, setCatalogBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [test, setTest] = useState<ModelConnectionTestResult | null>(null);
  const queryEpoch = useRef(0);

  const refresh = async () => {
    if (!online || !client.getModelConnections || !capabilityReadable(capabilities, "models.read")) return;
    const current = ++queryEpoch.current;
    setLoading(true); setError(null);
    try { const next = await client.getModelConnections(); if (current === queryEpoch.current) setSnapshot(next); }
    catch (caught) { if (current === queryEpoch.current) setError(safeError(caught)); }
    finally { if (current === queryEpoch.current) setLoading(false); }
  };
  useEffect(() => { setSnapshot(null); setTest(null); }, [client, generation]);
  useEffect(() => { void refresh(); return () => { ++queryEpoch.current; setKey(""); }; }, [client, online, capabilities, generation]);

  const writable = online && capabilityAvailable(capabilities, "models.write") && !busy && catalogBusy === null;
  const edit = (connection: ModelConnection) => {
    setDraft({ connection_id: connection.connection_id, expected_revision: connection.revision, label: connection.label, provider: connection.provider, protocol: connection.protocol, base_url: connection.base_url, model: connection.model, models: connection.models, image_input_models: connection.image_input_models ?? [] });
    setModels(connection.models.join("\n")); setKey(""); setTest(connection.test ?? null); setEditing(true); setError(null); setMessage(null);
  };
  const configuredModels = Array.from(new Set([...models.split(/[\n,]/u).map((item) => item.trim()).filter(Boolean), draft.model.trim()].filter(Boolean)));
  const save = async () => {
    if (!writable || !client.saveModelConnection) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const saved = await client.saveModelConnection({ ...draft, command_id: commandId(), models: configuredModels, image_input_models: (draft.image_input_models ?? []).filter((model) => configuredModels.includes(model)), ...(key ? { api_key: key } : {}) });
      setSnapshot(saved); setKey(""); setEditing(false); setTest(null); setMessage(t("Connection saved. Test it before starting work."));
    } catch (caught) { setError(safeError(caught)); }
    finally { setBusy(false); }
  };
  const clearKey = async (connection: ModelConnection) => {
    if (!writable || !connection.writable || !connection.has_key || !client.saveModelConnection || !window.confirm(t("Clear the API key for this connection? Running tasks keep their original credentials. New tasks need a new key."))) return;
    setBusy(true); setError(null); setMessage(null);
    try { setSnapshot(await client.saveModelConnection({ command_id: commandId(), connection_id: connection.connection_id, expected_revision: connection.revision, label: connection.label, provider: connection.provider, protocol: connection.protocol, base_url: connection.base_url, model: connection.model, models: connection.models, ...(connection.image_input_models ? { image_input_models: connection.image_input_models } : {}), clear_key: true })); setKey(""); setTest(null); setMessage(t("API key cleared. Add a new key to use this connection.")); }
    catch (caught) { setError(safeError(caught)); }
    finally { setBusy(false); }
  };
  const testConnection = async (connection: ModelConnection) => {
    if (!client.testModelConnection || !online || busy || !window.confirm(t("This sends one small request to your provider. Provider charges may apply."))) return;
    setBusy(true); setError(null); setTest(null);
    try { setTest(await client.testModelConnection(connection.connection_id, { command_id: commandId() })); await refresh(); }
    catch (caught) { setError(safeError(caught)); }
    finally { setBusy(false); }
  };
  const discoverModels = async (connection: ModelConnection) => {
    if (!client.discoverModelCatalog || !online || catalogBusy !== null || !connection.has_key) return;
    setCatalogBusy(connection.connection_id); setError(null); setMessage(null);
    try {
      const result = await client.discoverModelCatalog(connection.connection_id, { command_id: commandId(), expected_revision: connection.revision });
      setSnapshot((current) => current && ({ ...current, connections: current.connections.map((item) => item.connection_id === connection.connection_id ? { ...item, model_catalog: result.models, model_catalog_status: result.status, model_catalog_checked_at: result.discovered_at, ...(result.error_code ? { model_catalog_error_code: result.error_code } : {}) } : item) }));
      if (result.status === "succeeded") setMessage(`${t("Discovered models")}: ${result.models.length}`);
      else setError(result.message ?? t("Model discovery failed. Check the saved key, address, and network."));
    } catch (caught) { setError(safeError(caught)); }
    finally { setCatalogBusy(null); }
  };
  const chooseCatalogModel = (connection: ModelConnection, entry: ModelCatalogEntry) => {
    const nextModels = [...new Set([...connection.models, entry.id])];
    if (nextModels.length > 100) { setError(t("A connection can contain at most 100 model IDs.")); return; }
    setDraft({ connection_id: connection.connection_id, expected_revision: connection.revision, label: connection.label, provider: connection.provider, protocol: connection.protocol, base_url: connection.base_url, model: entry.id, models: nextModels, image_input_models: connection.image_input_models ?? [] });
    setModels(nextModels.join("\n")); setKey(""); setTest(connection.test ?? null); setEditing(true); setError(null); setMessage(t("Selected model. Save the connection to use it in chat."));
  };

  return <section className="model-connections-settings" aria-label={t("Saved model connections")}>
    <p>{t("Each conversation can choose a saved provider and model. Running tasks keep their original configuration.")}</p>
    {loading && <p role="status">{t("Loading…")}</p>}
    {error && <p role="alert">{error}<button className="button subtle" disabled={!online || loading} onClick={() => void refresh()} type="button">{t("Try again")}</button></p>}
    {message && <p role="status">{message}</p>}
    {snapshot?.connections.map((connection) => <article className="saved-model-connection" key={connection.connection_id}>
      <header><strong>{connection.label}</strong><span>{connection.provider} · {connection.source === "environment" ? t("Read-only") : t("This profile")}</span></header>
      <p>{connection.models.join(" · ")}</p>
      <p className="saved-image-input-models">{t("Image input models")}: {connection.image_input_models?.join(" · ") || t("None")}</p>
      <small>{t(connection.has_key ? "Credential saved" : "API Key required")}{snapshot.default_connection_id === connection.connection_id ? ` · ${t("Default")}` : ""}</small>
      <div className="settings-button-row">
        <button className="button subtle" disabled={!writable || !connection.writable} onClick={() => edit(connection)} type="button">{t("Edit connection")}</button>
        <button className="button subtle" disabled={!online || busy || catalogBusy !== null || !connection.has_key} onClick={() => void discoverModels(connection)} type="button">{catalogBusy === connection.connection_id ? t("Discovering…") : t("Discover models")}</button>
        <button className="button subtle" disabled={!online || busy || !connection.has_key || !capabilityAvailable(capabilities, "models.test")} onClick={() => void testConnection(connection)} type="button">{t("Test model connection")}</button>
        <button className="button subtle" disabled={!writable || !connection.writable || !connection.has_key} onClick={() => void clearKey(connection)} type="button">{t("Clear API key")}</button>
        <button className="button subtle" disabled={!writable || !connection.writable} onClick={() => { if (client.removeModelConnection && window.confirm(t("Remove this saved connection? Existing tasks keep their original configuration."))) { setBusy(true); setError(null); void client.removeModelConnection(connection.connection_id, { command_id: commandId(), expected_revision: connection.revision }).then(setSnapshot).catch((caught) => setError(safeError(caught))).finally(() => setBusy(false)); } }} type="button">{t("Remove connection")}</button>
      </div>
      {connection.model_catalog && connection.model_catalog.length > 0 && <details className="model-catalog-details">
        <summary>{t("Discovered models")}: {connection.model_catalog.length}{connection.model_catalog_status === "succeeded" ? ` · ${connection.model_catalog_checked_at ?? ""}` : ""}</summary>
        <div className="model-catalog-list">{connection.model_catalog.map((entry) => <article key={entry.id}>
          <div><strong>{entry.name ?? entry.id}</strong><small>{entry.id} · {t(entry.capability_status === "confirmed" ? "Capabilities confirmed" : entry.capability_status === "partial" ? "Some capabilities known" : "Capabilities unknown")}</small><small>{catalogSummary(entry, t)}</small></div>
          <button className="button subtle" disabled={!writable || !connection.writable} onClick={() => chooseCatalogModel(connection, entry)} type="button">{t("Use as default")}</button>
        </article>)}</div>
      </details>}
      {connection.test && <p role="status">{t(connection.test.status)} · {connection.test.model} · {connection.test.checked_at}</p>}
      <ModelCapabilityTests client={client} connection={connection} capabilities={capabilities} online={online} generation={generation} />
    </article>)}
    {!snapshot && !loading && !error && capabilities && <p>{t(online ? "Saved model connections are unavailable on this installation." : "Reconnect to load your saved model connections.")}</p>}
    {snapshot?.connections.length === 0 && <p>{t("No saved model connections yet.")}</p>}
    {!editing && <button className="button subtle" disabled={!writable} onClick={() => { setDraft(emptyDraft()); setModels(""); setKey(""); setEditing(true); }} type="button">{t("Add model connection")}</button>}
    {editing && <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label>{t("Connection name")}<input aria-label={t("Connection name")} disabled={!writable} maxLength={200} value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} /></label>
      <label>{t("Provider")}<select aria-label={t("Connection provider")} disabled={!writable} value={draft.provider} onChange={(event) => { const provider = event.target.value as ModelConnectionSaveRequest["provider"]; const preset = MODEL_PROVIDER_PRESETS[provider]; const model = preset.models[0] ?? ""; setDraft({ ...draft, provider, protocol: preset.protocol, base_url: preset.baseUrl, model, image_input_models: [] }); setModels(model); setKey(""); }}>{Object.keys(MODEL_PROVIDER_PRESETS).map((provider) => <option value={provider} key={provider}>{provider}</option>)}</select></label>
      <label>{t("API protocol")}<select aria-label={t("Connection protocol")} disabled={!writable} value={draft.protocol} onChange={(event) => setDraft({ ...draft, protocol: event.target.value as ModelConnectionSaveRequest["protocol"] })}><option value="openai-chat-completions">OpenAI Chat Completions</option><option value="anthropic-messages">Anthropic Messages</option></select></label>
      <label>{t("Base URL")}<input aria-label={t("Connection address")} disabled={!writable} value={draft.base_url} onChange={(event) => setDraft({ ...draft, base_url: event.target.value })} /></label>
      <label>{t("Default model")}<input aria-label={t("Connection default model")} disabled={!writable} value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} /></label>
      <label>{t("Available models (one per line)")}<textarea aria-label={t("Connection model list")} rows={3} disabled={!writable} value={models} onChange={(event) => setModels(event.target.value)} /></label>
      <fieldset className="model-image-input-options" disabled={!writable}><legend>{t("Image input models")}</legend><p>{t("Image input is declared by you. A text connection test does not verify it; inspect a dedicated image test or a real task before relying on compatibility.")}</p>{configuredModels.map((model) => <label key={model}><input aria-label={`${t("Enable image input for")} ${model}`} type="checkbox" checked={(draft.image_input_models ?? []).includes(model)} onChange={(event) => setDraft({ ...draft, image_input_models: event.target.checked ? [...(draft.image_input_models ?? []), model] : (draft.image_input_models ?? []).filter((item) => item !== model) })} /><span>{t("Enable image input for")} {model}</span></label>)}</fieldset>
      <label>{t("API Key")}<input aria-label={t("Connection API key")} type="password" spellCheck={false} autoComplete="new-password" disabled={!writable} value={key} placeholder={t(draft.connection_id ? "Leave empty to keep the saved key" : "Enter API Key")} onChange={(event) => setKey(event.target.value)} /></label>
      <div className="settings-button-row"><button className="button primary" disabled={!writable || !draft.label.trim() || !draft.model.trim() || !draft.base_url.trim()} type="submit">{t("Save connection")}</button><button className="button subtle" disabled={busy || catalogBusy !== null} onClick={() => { setKey(""); setEditing(false); }} type="button">{t("Cancel")}</button></div>
      {draft.connection_id && <p>{t("Save a changed API key first. Model discovery uses the saved key on the Host and does not expose it to the browser after saving.")}</p>}
      <p>{t("Credentials are write-only. Saving configuration does not verify the provider connection.")}</p>
    </form>}
    {test && <p role={test.status === "failed" ? "alert" : "status"}>{t(test.status)} · {test.code} · {test.model} · {test.message}</p>}
  </section>;
}
