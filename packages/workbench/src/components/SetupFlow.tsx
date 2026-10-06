import { useEffect, useRef, useState } from "react";
import type { HostCapabilities, ModelConnectionTestResult } from "@tracegraph/contracts";
import type { ModelConfigSnapshot, ModelProvider, WorkbenchClient } from "../client";
import type { ProjectSnapshot } from "../model";
import { useI18n } from "../i18n";
import { MODEL_PROVIDER_PRESETS } from "./SettingsPanel";
import { capabilityAvailable, commandId } from "./UnifiedSettings";
import { Icon } from "./Icon";

type Step = "model" | "test" | "project";
export function SetupFlow({ client, configuration, capabilities, projects, onConfigured, onClose, onFinish }: {
  client: WorkbenchClient; configuration: ModelConfigSnapshot; capabilities: HostCapabilities | null; projects: readonly ProjectSnapshot[];
  onConfigured: (configuration: ModelConfigSnapshot) => void; onClose: () => void; onFinish: () => void;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState<Step>(configuration.configured && configuration.has_key ? "test" : "model");
  const [draft, setDraft] = useState(configuration), [saved, setSaved] = useState(configuration);
  const [apiKey, setApiKey] = useState(""), [name, setName] = useState("");
  const [caps, setCaps] = useState(capabilities), [busy, setBusy] = useState(false);
  const [test, setTest] = useState<ModelConnectionTestResult | null>(null);
  const [error, setError] = useState<string | null>(null), [diagnostic, setDiagnostic] = useState<string | null>(null);
  const dialog = useRef<HTMLElement>(null);
  const locked = configuration.credential?.writable === false;
  useEffect(() => setCaps(capabilities), [capabilities]);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), button:not([disabled])")?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) { event.preventDefault(); onClose(); }
      if (event.key !== "Tab" || !dialog.current) return;
      const controls = [...dialog.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled])")];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    dialog.current?.addEventListener("keydown", keyboard);
    return () => { dialog.current?.removeEventListener("keydown", keyboard); if (previous instanceof HTMLElement) previous.focus(); };
  }, [busy, onClose, step]);
  const fail = (publicMessage: string, caught: unknown) => { setError(publicMessage); setDiagnostic((caught instanceof Error ? caught.message : String(caught)).replaceAll(apiKey || "\u0000", "[redacted]")); };
  const save = async () => {
    if (busy || locked || !capabilityAvailable(caps, "model.configure")) return;
    setBusy(true); setError(null); setDiagnostic(null); setTest(null);
    try {
      const value = await client.configureModel({ provider: draft.provider, protocol: draft.protocol, model: draft.model.trim(), base_url: draft.base_url.trim(), ...(apiKey.trim() ? { api_key: apiKey } : {}) });
      setSaved(value); setDraft(value); setApiKey(""); onConfigured(value);
      if (!value.configured || !value.has_key) { setError("Add an API key for this provider, then save again."); return; }
      setStep("test");
      try { setCaps(await client.getCapabilities()); } catch { /* A failed capability refresh cannot fabricate test readiness. */ }
    } catch (caught) { fail("Couldn't save this model. Check the fields and try again.", caught); }
    finally { setBusy(false); }
  };
  const check = async () => {
    if (busy || !capabilityAvailable(caps, "model.test") || !saved.configured || !saved.has_key) return;
    setBusy(true); setError(null); setDiagnostic(null); setTest(null);
    try { const result = await client.testModel({ command_id: commandId() }); setTest(result); if (result.status === "failed") { setError("Couldn't connect. Check the API key, model name and address, then try again."); setDiagnostic(`${result.code}: ${result.message}`); } }
    catch (caught) { fail("Couldn't complete the connection test. Try again or check your connection.", caught); }
    finally { setBusy(false); }
  };
  const project = async (operation: () => Promise<void | boolean>) => {
    if (busy) return; setBusy(true); setError(null); setDiagnostic(null);
    try { if (await operation() !== false) onFinish(); } catch (caught) { fail("Couldn't open this project. Choose another or try again.", caught); }
    finally { setBusy(false); }
  };
  const provider = (value: ModelProvider) => { const preset = MODEL_PROVIDER_PRESETS[value]; setDraft({ ...draft, provider: value, protocol: preset.protocol, base_url: preset.baseUrl, model: preset.models[0] ?? "" }); setApiKey(""); setTest(null); setError(null); };
  return <div className="setup-backdrop"><section ref={dialog} className="setup-flow" role="dialog" aria-modal="true" aria-label={t("Set up Outlive Agent")}>
    <header><strong>Outlive Agent</strong><button className="icon-button" aria-label={t("Return to workbench")} disabled={busy} onClick={onClose} type="button"><Icon name="close" size={18} /></button></header>
    <ol className="setup-steps" aria-label={t("Setup progress")}>{(["model", "test", "project"] as const).map((value, index) => <li key={value} aria-current={step === value ? "step" : undefined}><span>{index + 1}</span>{t(value === "model" ? "Connect model" : value === "test" ? "Test connection" : "Choose a project")}</li>)}</ol>
    <div className="setup-content">
      {step === "model" && <><h1>{t("Connect your model")}</h1><p>{t("Choose a provider and add its API key to start. Your key is saved locally and is never shown here.")}</p>
        {locked && <p role="status">{t("This model is managed outside the app. You can test its connection here.")}</p>}
        <label>{t("Provider")}<select aria-label={t("Setup provider")} disabled={busy || locked} value={draft.provider} onChange={(event) => provider(event.target.value as ModelProvider)}>{Object.entries(MODEL_PROVIDER_PRESETS).map(([value, preset]) => <option key={value} value={value}>{preset.label}</option>)}</select></label>
        <label>{t("Model ID")}<input aria-label={t("Setup model")} disabled={busy || locked} value={draft.model} placeholder={t("Enter model ID")} onChange={(event) => setDraft({ ...draft, model: event.target.value })} /></label>
        <label>{t("API Key")}<input aria-label={t("Setup API key")} type="password" autoComplete="new-password" spellCheck={false} disabled={busy || locked} value={apiKey} placeholder={t(saved.has_key && draft.provider === saved.provider ? "Leave empty to keep the saved key" : "Enter API Key")} onChange={(event) => setApiKey(event.target.value)} /></label>
        <details className="setup-address" open={draft.provider === "custom"}><summary>{t("Connection address and protocol")}</summary><label>{t("Base URL")}<input aria-label={t("Setup address")} disabled={busy || locked} value={draft.base_url} onChange={(event) => setDraft({ ...draft, base_url: event.target.value })} /></label><label>{t("API protocol")}<select aria-label={t("Setup protocol")} disabled={busy || locked} value={draft.protocol} onChange={(event) => setDraft({ ...draft, protocol: event.target.value as ModelConfigSnapshot["protocol"] })}><option value="openai-chat-completions">OpenAI Chat Completions</option><option value="anthropic-messages">Anthropic Messages</option></select></label></details>
        <p className="setup-footnote">{t("Saving does not send a model request. The next step lets you test explicitly.")}</p>
        <button className="button primary" disabled={busy || (!locked && (!capabilityAvailable(caps, "model.configure") || !draft.model.trim() || !draft.base_url.trim())) || (locked && !saved.configured)} onClick={() => locked ? setStep("test") : void save()} type="button">{t(busy ? "Saving…" : "Save and continue")}</button>
      </>}
      {step === "test" && <><h1>{t("Check your connection")}</h1><p><strong>{saved.model}</strong> · {MODEL_PROVIDER_PRESETS[saved.provider].label}</p><p>{t("This sends one small request to your provider. Provider charges may apply.")}</p>
        <div className="setup-test-result" role="status"><Icon name={test?.status === "passed" ? "check" : "activity"} size={20} /><span>{t(busy ? "Testing connection…" : test?.status === "passed" ? "Connected. You're ready to start." : "Configuration saved. Connection not tested yet.")}</span></div>
        <div className="setup-actions"><button className="button primary" disabled={busy || !capabilityAvailable(caps, "model.test")} onClick={() => void check()} type="button">{t(test ? "Test again" : "Test connection")}</button><button className="button primary" disabled={busy || test?.status !== "passed"} onClick={() => setStep("project")} type="button">{t("Continue")}</button><button className="button subtle" disabled={busy} onClick={() => { setStep("model"); setError(null); }} type="button">{t("Edit model")}</button></div>
      </>}
      {step === "project" && <><h1>{t("Choose how to start")}</h1><p>{t("Add a project to work with files, or start a conversation without one. Extra tools are optional.")}</p>
        <div className="setup-projects">{projects.map((value) => <button className="setup-project" key={value.id} disabled={busy} onClick={() => void project(() => client.chooseProjectById(value.id))} type="button"><Icon name="folder" size={18} /><span>{value.name}</span><Icon name="chevron" size={14} /></button>)}</div>
        {capabilityAvailable(caps, "projects.create") && <div className="setup-create-project"><label>{t("New project name")}<input aria-label={t("New project name")} disabled={busy} value={name} onChange={(event) => setName(event.target.value)} /></label><button className="button subtle" disabled={busy || !name.trim()} onClick={() => void project(() => client.createProject(name.trim()))} type="button">{t("Create project")}</button></div>}
        <div className="setup-actions">{capabilityAvailable(caps, "projects.open.native") && <button className="button subtle" disabled={busy} onClick={() => void project(() => client.openLocalProject())} type="button"><Icon name="folder" size={15} />{t("Open local folder")}</button>}<button className="button primary" disabled={busy} onClick={() => void project(() => client.returnHome())} type="button">{t("Start a conversation")}</button></div>
      </>}
      {error && <p className="setup-error" role="alert">{t(error)}</p>}{diagnostic && <details className="setup-diagnostic"><summary>{t("Connection details")}</summary><pre>{diagnostic}</pre></details>}
    </div>
  </section></div>;
}
