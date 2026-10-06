import { useEffect, useRef, useState } from "react";
import { ComputerActionRequestSchema, type ComputerAction, type ComputerActionResult, type ComputerGrant, type ComputerLease, type ComputerObservation, type ComputerStatus, type ComputerTarget, type HostCapabilities } from "@tracegraph/contracts";
import type { WorkbenchClient } from "../client";
import { mutationWasRejected } from "../mutation-rejection";
import { useI18n } from "../i18n";
import { capabilityAvailable, capabilityReadable, commandId, safeError } from "./UnifiedSettings";

type ComputerResult = ComputerGrant | ComputerLease | ComputerObservation | ComputerActionResult;
export function ComputerSettings({ client, capabilities, online, readOnly = false, generation }: { client: WorkbenchClient; capabilities: HostCapabilities | null; online: boolean; readOnly?: boolean; generation?: number | undefined }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<ComputerStatus | null>(null), [targets, setTargets] = useState<ComputerTarget[]>([]), [selected, setSelected] = useState(""), [duration, setDuration] = useState<"once" | "always">("once"), [seconds, setSeconds] = useState(300);
  const [observation, setObservation] = useState<ComputerObservation | null>(null), [capture, setCapture] = useState(false), [image, setImage] = useState<string | null>(null), [imageError, setImageError] = useState(false);
  const [busy, setBusy] = useState(false), [safetyBusy, setSafetyBusy] = useState(false), [error, setError] = useState<string | null>(null), [message, setMessage] = useState<string | null>(null), [unknown, setUnknown] = useState<string | null>(null);
  const [kind, setKind] = useState<ComputerAction["kind"]>("key"), [key, setKey] = useState<Extract<ComputerAction, { kind: "key" }>["key"]>("Enter"), [text, setText] = useState(""), [x, setX] = useState(""), [y, setY] = useState("");
  const mounted = useRef(true), readVersion = useRef(0), previewVersion = useRef(0), objectUrl = useRef<string | null>(null);
  const readable = online && capabilityReadable(capabilities, "computer.read") && Boolean(client.getComputerStatus);
  const can = (operation: string) => online && !readOnly && capabilityAvailable(capabilities, operation);
  const target = targets.find((target) => `${target.application_id}:${target.pid}:${target.window_id}` === selected);
  const grant = target && status?.grants.find((grant) => grant.state === "active" && grant.application_id === target.application_id && grant.identity === target.identity);
  const lease = status?.lease;
  const selectedOwnsLease = Boolean(target && lease && target.application_id === lease.target.application_id && target.pid === lease.target.pid && target.window_id === lease.target.window_id && target.identity === lease.target.identity);
  const clearPreview = () => { previewVersion.current++; setImage(null); setImageError(false); if (objectUrl.current) { URL.revokeObjectURL(objectUrl.current); objectUrl.current = null; } };
  const refresh = async () => {
    if (!readable) return;
    const version = ++readVersion.current;
    try {
      const next = await client.getComputerStatus!();
      if (!mounted.current || version !== readVersion.current) return;
      setStatus(next);
      if (capabilityReadable(capabilities, "computer.targets") && client.listComputerTargets) {
        const windows = await client.listComputerTargets(); if (!mounted.current || version !== readVersion.current) return;
        setTargets(windows); setSelected((prior) => windows.some((target) => `${target.application_id}:${target.pid}:${target.window_id}` === prior) ? prior : "");
      }
    } catch (caught) { if (mounted.current && version === readVersion.current) setError(safeError(caught)); }
  };
  useEffect(() => { mounted.current = true; if (readable) void refresh(); return () => { mounted.current = false; readVersion.current++; previewVersion.current++; if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); }; }, [client, readable, generation, JSON.stringify(capabilities?.capabilities)]);
  useEffect(() => { setObservation(null); clearPreview(); }, [selected, online, readOnly, generation]);
  // Observe lease state only. Opening settings never resumes or acquires input authority.
  useEffect(() => { if (!readable || !lease || lease.state === "released") return; const timer = window.setInterval(() => { void refresh(); }, 1500); return () => window.clearInterval(timer); }, [readable, lease?.lease_id, lease?.state]);
  const receive = (result: ComputerResult) => {
    if ("lease_id" in result) setStatus((prior) => prior ? { ...prior, lease: result } : prior);
    if ("source" in result) { setObservation(result); clearPreview(); }
    if ("status" in result) setMessage(t(result.status === "posted" ? "Native input was posted. Observe the application to verify the result." : "Native input has an unknown outcome. Observe external state and inspect the original receipt; it was not repeated."));
    else setMessage(t("Computer control receipt recorded. No input is sent automatically."));
  };
  const perform = async (id: string, execute: () => Promise<ComputerResult>, safety = false, allowUnknown = false) => {
    if (!online || readOnly || (safety ? safetyBusy : busy || unknown !== null && !allowUnknown)) return;
    safety ? setSafetyBusy(true) : setBusy(true); setError(null); setMessage(null);
    try { const result = await execute(); if (!mounted.current) return; receive(result); if ("status" in result && result.status === "unknown") setUnknown((prior) => prior ?? id); await refresh(); }
    catch (caught) { if (mounted.current) { setError(safeError(caught)); if (!mutationWasRejected(caught)) setUnknown((prior) => prior ?? id); } }
    finally { if (mounted.current) safety ? setSafetyBusy(false) : setBusy(false); }
  };
  const inspect = async () => {
    if (!unknown || busy || !online || !capabilityReadable(capabilities, "computer.receipt.read") || !client.getComputerCommandReceipt) return;
    const id = unknown; setBusy(true); setError(null);
    try {
      const receipt = await client.getComputerCommandReceipt(id); if (receipt.command_id !== id) throw new Error("Computer receipt does not match the original command.");
      if (receipt.state === "completed" && receipt.result) { receive(receipt.result); if (!("status" in receipt.result) || receipt.result.status === "posted") setUnknown(null); await refresh(); }
      else if (receipt.state === "failed" && mutationWasRejected({ status: 409, body: { error: receipt.code } })) { setUnknown(null); setMessage(t("Computer control was refused before input. Review its reason before making a new request.")); }
      else setMessage(`${t("Computer command is not reconciled")}: ${t(receipt.state)}${receipt.code ? ` · ${receipt.code}` : ""}`);
    } catch (caught) { setError(safeError(caught)); } finally { setBusy(false); }
  };
  const loadCapture = async () => {
    if (!observation?.capture_artifact || !grant || !target || !online || readOnly || !capabilityReadable(capabilities, "computer.capture.read") || !client.getComputerCapture) return;
    const version = ++previewVersion.current, artifact = observation.capture_artifact; setBusy(true); setError(null);
    try {
      const content = await client.getComputerCapture({ grant_id: grant.grant_id, target, artifact });
      if (content.sha256 !== artifact.content_hash || content.bytes.byteLength !== artifact.byte_length || artifact.mime_type !== "image/png") throw new Error("Computer capture does not match its verified Artifact.");
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(content.bytes).buffer));
      if (`sha256:${[...digest].map((value) => value.toString(16).padStart(2, "0")).join("")}` !== artifact.content_hash) throw new Error("Computer capture failed content verification.");
      if (!mounted.current || version !== previewVersion.current) return;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); objectUrl.current = URL.createObjectURL(new Blob([Uint8Array.from(content.bytes).buffer], { type: "image/png" })); setImage(objectUrl.current); setImageError(false);
    } catch (caught) { if (mounted.current && version === previewVersion.current) setError(safeError(caught)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const sendInput = () => {
    if (!lease || !selectedOwnsLease || lease.state !== "active" || !can("computer.action") || !client.computerAction || busy || unknown) return;
    let action: ComputerAction; const id = commandId();
    try {
      if ((kind === "click" || kind === "scroll") && (!x.trim() || !y.trim())) throw new Error("Enter both coordinates or scroll deltas.");
      action = kind === "key" ? { kind, key, modifiers: [] } : kind === "type" ? { kind, text } : kind === "click" ? { kind, x: Number(x), y: Number(y), button: "left" } : { kind, delta_x: Number(x), delta_y: Number(y) };
      const input = ComputerActionRequestSchema.parse({ command_id: id, lease_id: lease.lease_id, expected_generation: lease.generation, action });
      void perform(id, () => client.computerAction!(input));
    } catch { setError(t("Check the exact input action. Coordinates must be finite and text cannot be empty.")); }
  };
  return <section className="computer-settings"><p>{t("Computer access is separate from file permissions. Choose the exact application window, grant it explicitly, then acquire a finite input lease.")}</p><button className="button subtle" disabled={!readable || busy} onClick={() => void refresh()} type="button">{t("Refresh computer status")}</button>
    {!online && <p role="status">{t("Reconnect to inspect computer access. Input is never resumed automatically.")}</p>}{readOnly && <p>{t("Replay is read-only. Return to now to make changes.")}</p>}{online && !readable && <p>{t("Computer availability has not been confirmed. Inspect installation diagnostics; ordinary chat remains available.")}</p>}{error && <p role="alert">{t(error)}</p>}{message && <p role="status">{message}</p>}{unknown && <div role="alert"><p>{t("This computer command has an unknown outcome. Observe the application and inspect the original receipt before any new input.")}</p><code>{unknown}</code><button className="button subtle" disabled={!online || busy || !capabilityReadable(capabilities, "computer.receipt.read") || !client.getComputerCommandReceipt} onClick={() => void inspect()} type="button">{t("Inspect original computer command")}</button></div>}
    {status && <><div className="computer-permission-state"><p>{t("Platform")}: {status.platform}</p>{!status.backend_available && <p>{status.reason ?? t("Repair the native computer component in this installation.")}</p>}{status.locked && <p>{t("Unlock the computer, refresh status, and resume control explicitly.")}</p>}{!status.accessibility && <p>{t("Allow Accessibility for the Outlive Agent helper in system privacy settings, then refresh.")}</p>}{!status.screen_capture && <p>{t("Allow Screen Recording for the Outlive Agent helper before requesting window pixels. Text observation can work separately.")}</p>}{!status.input_monitoring && <p>{t("Allow Input Monitoring for the Outlive Agent helper. Input control stays paused until user input can be detected.")}</p>}{!status.human_grant_available && <p>{t("Open this profile in Desktop to use the trusted computer permission confirmation.")}</p>}</div>
      <details><summary>{t("Saved application permissions")}: {status.grants.filter((item) => item.state === "active").length}</summary>{status.grants.filter((item) => item.state === "active").map((permission) => <div className="settings-extension-row" key={permission.grant_id}><span>{permission.application_id} · {t(permission.duration)}</span><button className="button danger" disabled={!can("computer.revoke") || safetyBusy || !client.revokeComputerGrant} onClick={() => { const id = commandId(); void perform(id, () => client.revokeComputerGrant!({ command_id: id, grant_id: permission.grant_id }), true); }} type="button">{t("Revoke application permission")}</button></div>)}</details><label>{t("Application window")}<select aria-label={t("Computer application window")} value={selected} disabled={busy} onChange={(event) => setSelected(event.target.value)}><option value="">{t("Choose an observed application window")}</option>{targets.map((target) => <option key={`${target.application_id}:${target.pid}:${target.window_id}`} value={`${target.application_id}:${target.pid}:${target.window_id}`}>{target.title || target.application_id} · {target.application_id} · {target.window_id}</option>)}</select></label>{targets.length === 0 && status.backend_available && <p>{t("No application windows were returned. Open the target application, then refresh.")}</p>}
      {target && <><p className="setting-metadata">{target.application_id} · {t("Window")}: {target.window_id} · {target.identity}</p><label>{t("Computer permission duration")}<select value={duration} onChange={(event) => setDuration(event.target.value as typeof duration)}><option value="once">{t("Once")}</option><option value="always">{t("Always until revoked")}</option></select></label><div className="settings-button-row"><button className="button subtle" disabled={!can("computer.grant") || !status.human_grant_available || !status.backend_available || !status.accessibility || status.locked || busy || Boolean(unknown) || !client.requestComputerGrant} onClick={() => { const id = commandId(); void perform(id, () => client.requestComputerGrant!({ command_id: id, target, duration })); }} type="button">{t("Request application permission")}</button>{grant && <button className="button danger" disabled={!can("computer.revoke") || safetyBusy || !client.revokeComputerGrant} onClick={() => { const id = commandId(); void perform(id, () => client.revokeComputerGrant!({ command_id: id, grant_id: grant.grant_id }), true); }} type="button">{t("Revoke application permission")}</button>}</div>
        {grant && <><label><input type="checkbox" checked={capture} disabled={!status.screen_capture} onChange={(event) => setCapture(event.target.checked)} />{t("Include window screenshot in observation")}</label><button className="button subtle" disabled={!can("computer.observe") || busy || !client.observeComputer} onClick={() => { const id = commandId(); void perform(id, () => client.observeComputer!({ command_id: id, grant_id: grant.grant_id, target, capture }), false, true); }} type="button">{t("Observe application")}</button><label>{t("Input lease seconds")}<input aria-label={t("Computer input lease seconds")} type="number" min={15} max={600} value={seconds} onChange={(event) => setSeconds(Number(event.target.value))} /></label><button className="button subtle" disabled={!can("computer.lease") || !status.human_grant_available || !status.input_monitoring || status.locked || busy || Boolean(unknown) || Boolean(lease && lease.state !== "released") || !Number.isInteger(seconds) || seconds < 15 || seconds > 600 || !client.acquireComputerLease} onClick={() => { const id = commandId(); void perform(id, () => client.acquireComputerLease!({ command_id: id, grant_id: grant.grant_id, target, seconds })); }} type="button">{t("Request input control")}</button></>}
      </>}
      {lease && lease.state !== "released" && <section className="computer-lease"><h3>{t("Input control")}</h3><p>{lease.target.title || lease.target.application_id} · {t(lease.state)} · {t("Generation")} {lease.generation}{lease.pause_reason && ` · ${t(lease.pause_reason)}`} · {t("Expires")}: {lease.expires_at}</p><p>{t("Typing or clicking yourself pauses Agent input. Locking the computer also pauses it. Resuming always requires an explicit human confirmation.")}</p><div className="settings-button-row">{lease.state === "paused" && <button className="button subtle" disabled={!can("computer.lease") || busy || Boolean(unknown) || status.locked || !status.input_monitoring || !status.human_grant_available || !client.resumeComputerLease} onClick={() => { const id = commandId(); void perform(id, () => client.resumeComputerLease!({ command_id: id, lease_id: lease.lease_id, expected_generation: lease.generation })); }} type="button">{t("Resume input explicitly")}</button>}<button className="button danger" disabled={!can("computer.lease") || safetyBusy || !client.releaseComputerLease} onClick={() => { const id = commandId(); void perform(id, () => client.releaseComputerLease!({ command_id: id, lease_id: lease.lease_id }), true); }} type="button">{t("Release input control")}</button></div>
        {!selectedOwnsLease && <p>{t("Select the exact leased application window before sending input.")}</p>}<form className="computer-input-form" onSubmit={(event) => { event.preventDefault(); sendInput(); }}><label>{t("Input action")}<select aria-label={t("Computer input action")} value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>{["key", "type", "click", "scroll"].map((value) => <option key={value} value={value}>{t(value)}</option>)}</select></label>{kind === "key" ? <select aria-label={t("Computer key")} value={key} onChange={(event) => setKey(event.target.value as typeof key)}>{["Enter", "Escape", "Tab", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].map((value) => <option key={value} value={value}>{value}</option>)}</select> : kind === "type" ? <textarea aria-label={t("Computer input text")} maxLength={4000} value={text} onChange={(event) => setText(event.target.value)} /> : <><input aria-label={t(kind === "click" ? "Computer X coordinate" : "Computer horizontal scroll")} type="number" value={x} onChange={(event) => setX(event.target.value)} /><input aria-label={t(kind === "click" ? "Computer Y coordinate" : "Computer vertical scroll")} type="number" value={y} onChange={(event) => setY(event.target.value)} /></>}<button className="button subtle" disabled={!can("computer.action") || !selectedOwnsLease || lease.state !== "active" || busy || Boolean(unknown) || status.locked || !status.input_monitoring || !client.computerAction} type="submit">{t("Send exact native input")}</button></form><small>{t("Posted input is not proof that the application completed the intended operation. Observe and verify its real state afterwards.")}</small></section>}
      {observation && <section className="computer-observation"><h3>{t("Native observation")}</h3><p>{observation.target.title} · {observation.captured_at} · {observation.artifact.artifact_id}</p>{observation.elements.map((element) => <details key={element.element_id}><summary>{element.role} · {element.title || element.element_id}</summary><p>{element.value}</p>{element.bounds && <p>{element.bounds.x}, {element.bounds.y} · {element.bounds.width} × {element.bounds.height}</p>}</details>)}{observation.truncated && <p>{t("This observation is bounded. Inspect the target again for current details.")}</p>}{observation.capture_artifact && <button className="button subtle" disabled={!online || readOnly || busy || !capabilityReadable(capabilities, "computer.capture.read") || !client.getComputerCapture} onClick={() => void loadCapture()} type="button">{t("Preview verified window pixels")}</button>}{image && !imageError && <img alt={t("Verified native window capture")} src={image} onError={() => setImageError(true)} />}{imageError && <p role="alert">{t("The verified window capture could not be decoded. Its contents were not displayed.")}</p>}</section>}
    </>}
  </section>;
}
