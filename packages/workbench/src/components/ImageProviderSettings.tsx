import { useEffect, useState } from "react";
import { ImageProviderConfigUpdateSchema, type HostCapabilities, type ImageProviderConfigSnapshot } from "@tracegraph/contracts";
import type { WorkbenchClient } from "../client";
import { useI18n } from "../i18n";
import { capabilityAvailable, capabilityFor, capabilityReadable } from "./UnifiedSettings";

export function ImageProviderSettings({ client, capabilities }: { client: WorkbenchClient; capabilities: HostCapabilities | null }) {
  const { t } = useI18n();
  const [configuration, setConfiguration] = useState<ImageProviderConfigSnapshot | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const readable = capabilityReadable(capabilities, "image.read");
  useEffect(() => {
    let current = true; setLoading(true); setError(null);
    if (!readable) { setConfiguration(null); setLoading(false); return; }
    void client.getImageConfig().then((snapshot) => { if (current) setConfiguration(snapshot); }).catch((caught) => { if (current) setError(caught instanceof Error ? caught.message : "Image settings could not be loaded."); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [client, readable, revision]);
  const save = async () => {
    if (busy || !configuration) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const input = ImageProviderConfigUpdateSchema.parse({ protocol: configuration.protocol, base_url: configuration.base_url.trim(), model: configuration.model.trim(), ...(configuration.image_model?.trim() ? { image_model: configuration.image_model.trim() } : {}), ...(apiKey ? { api_key: apiKey } : {}) });
      setConfiguration(await client.configureImageProvider(input)); setApiKey(""); setMessage("Image configuration saved. Generate an image to verify this provider.");
    } catch (caught) { setError((caught instanceof Error ? caught.message : "Image configuration could not be saved.").replaceAll(apiKey || "\u0000", "[redacted]")); }
    finally { setBusy(false); }
  };
  const clear = async () => {
    if (busy || !window.confirm(t("Remove this image provider and its saved API Key?"))) return;
    setBusy(true); setError(null); setMessage(null);
    try { setConfiguration(await client.clearImageProvider()); setApiKey(""); setMessage("Image provider removed"); }
    catch (caught) { setError((caught instanceof Error ? caught.message : "Image configuration could not be removed.").replaceAll(apiKey || "\u0000", "[redacted]")); }
    finally { setBusy(false); }
  };
  const writable = !busy && capabilityAvailable(capabilities, "image.configure");
  return <section className="image-provider-settings" aria-label={t("Image generation")}><h3>{t("Image generation")}</h3><p>{t("Optional image provider. Diagrams and charts are rendered locally and do not require a chat or image model.")}</p>
    {loading && <p role="status">{t("Loading image settings…")}</p>}
    {!readable && <p>{t("Image settings are unavailable on this installation.")} <small>{capabilityFor(capabilities, "image.read")?.reason}</small></p>}
    {error && <div role="alert"><p>{t(error)}</p><button className="button subtle" disabled={busy} onClick={() => setRevision((value) => value + 1)} type="button">{t("Retry")}</button></div>}
    {message && <p role="status">{t(message)}</p>}
    {configuration && <><p>{t(configuration.configured && configuration.has_key ? "Image provider configured" : "Connect an image provider")}</p>
      <label>{t("Image API protocol")}<select aria-label={t("Image API protocol")} disabled={!writable} value={configuration.protocol} onChange={(event) => setConfiguration({ ...configuration, protocol: event.target.value as ImageProviderConfigSnapshot["protocol"] })}><option value="openai-images">OpenAI Images</option><option value="openai-responses">OpenAI Responses</option><option value="openai-chat-images">OpenAI Chat Images</option></select></label>
      <label>{t("Image provider address")}<input aria-label={t("Image provider address")} disabled={!writable} value={configuration.base_url} onChange={(event) => setConfiguration({ ...configuration, base_url: event.target.value })} /></label>
      <label>{t("Image model")}<input aria-label={t("Image model")} disabled={!writable} value={configuration.model} onChange={(event) => setConfiguration({ ...configuration, model: event.target.value })} /></label>
      {configuration.protocol === "openai-responses" && <label>{t("Responses image tool model")}<input aria-label={t("Responses image tool model")} disabled={!writable} value={configuration.image_model ?? ""} onChange={(event) => setConfiguration({ ...configuration, image_model: event.target.value })} placeholder={t("Optional")} /></label>}
      <label>{t("Image API Key")}<input aria-label={t("Image API Key")} autoComplete="new-password" type="password" spellCheck={false} disabled={!writable} value={apiKey} placeholder={t(configuration.has_key ? "Enter a new key to replace the current one" : "Enter API Key")} onChange={(event) => setApiKey(event.target.value)} /></label>
      <div className="settings-button-row"><button className="button primary" disabled={!writable || !configuration.base_url.trim() || !configuration.model.trim()} onClick={() => void save()} type="button">{t("Save image configuration")}</button><button className="button subtle" disabled={busy || !capabilityAvailable(capabilities, "image.clear") || !configuration.configured} onClick={() => void clear()} type="button">{t("Remove image provider")}</button></div><p>{t("Credentials are write-only. Saving does not send a generation request.")}</p>
    </>}
  </section>;
}
