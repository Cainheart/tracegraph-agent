import { useEffect, useRef, useState } from "react";
import type { HostCapabilities, ModelConnection, ModelCapabilityTestResult, ModelProbeKind } from "@tracegraph/contracts";
import type { WorkbenchClient } from "../client";
import { useI18n } from "../i18n";
import { capabilityAvailable, capabilityReadable, commandId } from "./UnifiedSettings";

const labels: Record<ModelProbeKind, string> = { text: "Text response", tools: "Native tool calling", image: "Image input", structured: "Schema-constrained output" };
const messages: Record<string, string> = {
  model_probe_passed: "The dedicated fixture matched the expected result.", model_probe_format_unimplemented: "This adapter has not implemented the requested test format.",
  model_authentication_failed: "The provider rejected the credential.", model_not_found: "The provider could not find this model.", model_rate_limited: "The provider rate limit was reached.",
  model_probe_request_rejected: "The provider rejected this native test format.", model_provider_failed: "The provider could not complete this test.", model_timeout: "The request timed out. Its provider usage may be unknown.",
  model_transport_unknown: "The response was lost. The provider may have processed the request.", model_probe_not_started: "This test was not sent because the connection stopped.",
  model_credential_unavailable: "The saved credential could not be read. Repair its storage before testing.", model_credential_invalid: "The saved credential is invalid. Replace it before testing.", model_not_configured: "Add a saved credential before testing.", model_credential_missing: "Add a saved credential before testing.", model_response_invalid: "The provider returned an invalid response.",
  model_probe_response_too_large: "The response exceeded the small test limit.", model_probe_output_truncated: "The provider truncated the test response.", model_probe_refused: "The provider refused the test request.",
  model_probe_native_tool_missing: "No valid native tool call was returned.", model_probe_native_tool_invalid: "The native tool call did not match the test declaration.", model_probe_answer_mismatch: "The response did not match the dedicated fixture.", model_probe_schema_invalid: "The returned object did not match the requested schema.",
};
function marker(key: string, value?: string) { try { if (value !== undefined) sessionStorage.setItem(key, value); return sessionStorage.getItem(key) ?? ""; } catch { return value ?? ""; } }

export function ModelCapabilityTests({ client, connection, capabilities, online, generation }: { client: WorkbenchClient; connection: ModelConnection; capabilities: HostCapabilities | null; online: boolean; generation?: number | undefined }) {
  const { t } = useI18n(); const storageKey = `outlive:model-test:${capabilities?.profile_id ?? "unknown"}:${connection.connection_id}`;
  const [model, setModel] = useState(connection.model), [features, setFeatures] = useState<ModelProbeKind[]>(["text"]), [result, setResult] = useState<ModelCapabilityTestResult | null>(connection.capability_test ?? null), [previousId, setPreviousId] = useState(() => marker(storageKey) || connection.capability_test?.command_id || ""), [pending, setPending] = useState(() => Boolean(marker(storageKey))), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [localProofId, setLocalProofId] = useState("");
  const epoch = useRef(0), previousScope = useRef(storageKey);
  useEffect(() => {
    const current = ++epoch.current;
    const sameScope = previousScope.current === storageKey; previousScope.current = storageKey;
    const previous = marker(storageKey) || connection.capability_test?.command_id || (sameScope ? previousId : "");
    setPreviousId(previous); setPending(Boolean(previous) && previous !== connection.capability_test?.command_id);
    setResult(online ? connection.capability_test ?? null : null); setLocalProofId(""); setBusy(false); setError(null);
    setModel(value => connection.models.includes(value) ? value : connection.model);
    if (connection.protocol === "anthropic-messages") setFeatures(value => value.filter(feature => feature !== "structured"));
    return () => { if (epoch.current === current) ++epoch.current; };
  }, [client, storageKey, generation, online, connection]);
  const canTest = online && connection.has_key && capabilityAvailable(capabilities, "models.capabilities.test");
  const canRead = online && capabilityReadable(capabilities, "models.capabilities.read");
  const test = async () => {
    if (!canTest || busy || pending || !features.length || !client.testModelCapabilities || !window.confirm(t("Run the selected small tests? Each supported item sends one provider request and may incur charges. No project or chat content is sent. Previous unknown requests may already have incurred usage."))) return;
    const id = commandId(), current = epoch.current; marker(storageKey, id); setPreviousId(id); setPending(true); setBusy(true); setError(null); setResult(null);
    try { const next = await client.testModelCapabilities(connection.connection_id, { command_id: id, expected_revision: connection.revision, model, features, confirmed: true }); if (current === epoch.current) { setResult(next); setLocalProofId(id); setPending(false); } }
    catch (caught) { if (current === epoch.current) { const record = caught as { code?: unknown; body?: { error?: unknown }; admission?: unknown }; const code = record?.code ?? record?.body?.error; const rejected = record?.admission === "rejected" || ["model_connection_revision_conflict", "model_connection_missing", "model_not_configured"].includes(String(code)); setPending(!rejected); setError(t(rejected ? "The test was refused before a provider request. Reload the connection before deciding to test again." : "The test receipt is uncertain. Inspect the original command; it will not be repeated automatically.")); } }
    finally { if (current === epoch.current) setBusy(false); }
  };
  const inspect = async () => {
    if (!canRead || busy || !previousId || !client.getModelCapabilityTestReceipt) return;
    const current = epoch.current; setBusy(true); setError(null);
    try { const receipt = await client.getModelCapabilityTestReceipt(previousId); if (current !== epoch.current) return; if (receipt.state === "completed" && receipt.result) { setResult(receipt.result); setPending(false); } else if (receipt.state === "failed") { setPending(false); setError(t("The original test has a failed receipt. Reload the connection before deciding on a new test.")); } else { setPending(true); setError(t("No settled test receipt was found. Do not repeat the request automatically.")); } }
    catch { if (current === epoch.current) setError(t("Could not read the original test receipt. Reconnect and inspect again.")); }
    finally { if (current === epoch.current) setBusy(false); }
  };
  const historical = result && (result.connection_revision !== connection.revision || result.model !== model || connection.source === "environment" && result.command_id !== connection.capability_test?.command_id && result.command_id !== localProofId);
  return <details className="model-capability-tests"><summary>{t("Test model capabilities")}</summary><p>{t("These small probes check one exact model and configuration. A passing fixture does not guarantee general quality or grant tool permissions. Image declarations remain unchanged.")}</p><label>{t("Model to test")}<select aria-label={t("Model to test")} value={model} disabled={busy || pending || !canTest} onChange={event => setModel(event.target.value)}>{connection.models.map(value => <option key={value} value={value}>{value}</option>)}</select></label><fieldset disabled={busy || pending || !canTest}><legend>{t("Select small tests")}</legend>{(Object.keys(labels) as ModelProbeKind[]).map(feature => <label key={feature}><input type="checkbox" checked={features.includes(feature)} disabled={feature === "structured" && connection.protocol === "anthropic-messages"} onChange={event => setFeatures(event.target.checked ? [...features, feature] : features.filter(value => value !== feature))} />{t(labels[feature])}</label>)}</fieldset>{connection.protocol === "anthropic-messages" && <p>{t("Schema-constrained testing is not implemented for Anthropic Messages in this version. Text, native tool and image tests are available.")}</p>}{!online ? <p>{t("Reconnect before sending or inspecting a model test.")}</p> : !connection.has_key ? <p>{t("Add a saved credential before testing.")}</p> : !capabilityAvailable(capabilities, "models.capabilities.test") && <p>{t("This installation does not provide model capability tests.")}</p>}<div className="settings-button-row"><button type="button" className="button subtle" disabled={!canTest || busy || pending || !features.length} onClick={() => void test()}>{t(busy ? "Testing…" : "Run selected tests")}</button>{previousId && <button type="button" className="button subtle" disabled={!canRead || busy} onClick={() => void inspect()}>{t("Inspect previous test")}</button>}</div>{error && <p role="alert">{error}</p>}{result && <section aria-label={t("Model test results")}><p>{result.model} · {t("Revision")} {result.connection_revision} · {result.duration_ms} ms</p>{historical && <p>{t("This receipt describes an earlier model or configuration. It does not verify the current selection.")}</p>}{result.results.map(item => <article key={item.feature}><strong>{t(labels[item.feature])} · {t(item.status)}</strong><p>{t(messages[item.code] ?? "The provider could not complete this test.")}</p><small>{item.duration_ms} ms · {t("Provider usage")}: {item.usage ? `${item.usage.input_tokens} + ${item.usage.output_tokens} = ${item.usage.total_tokens} ${t("tokens")}` : t("Unknown")} · {t("Cost")}: {item.usage?.cost ? `${item.usage.cost.amount} ${item.usage.cost.currency}` : t("Unknown")}</small></article>)}<details><summary>{t("Test receipt details")}</summary><p>{result.command_id} · {result.protocol} · {result.checked_at}</p>{result.results.map(item => <p key={item.feature}>{item.feature} · {item.code} · {item.evidence ?? t("None")} · {t(item.dispatched ? "Request sent" : "Request not sent")}</p>)}</details></section>}{previousId && !result && <small>{t("Original test command")}: {previousId}</small>}</details>;
}
