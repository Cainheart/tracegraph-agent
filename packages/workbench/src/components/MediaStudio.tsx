import { useEffect, useRef, useState } from "react";
import { MediaOperationSchema, type HostCapabilities, type MediaOperation, type StartMediaRunRequest } from "@tracegraph/contracts";
import type { WorkbenchClient } from "../client";
import { useI18n } from "../i18n";
import { capabilityAvailable, capabilityFor, commandId } from "./UnifiedSettings";

export function MediaStudio({ client, capabilities, onClose, onSettings, onCreated, open }: { client: WorkbenchClient; capabilities: HostCapabilities | null; onClose: () => void; onSettings: () => void; onCreated: () => void; open: boolean }) {
  const { t } = useI18n(); const dialog = useRef<HTMLElement>(null);
  const [kind, setKind] = useState<MediaOperation["kind"]>(capabilityAvailable(capabilities, "media.generate") ? "generate" : "diagram");
  const [prompt, setPrompt] = useState(""); const [title, setTitle] = useState("");
  const [size, setSize] = useState<"1024x1024" | "1536x1024" | "1024x1536">("1024x1024");
  const [quality, setQuality] = useState<"auto" | "low" | "medium" | "high">("auto");
  const [nodes, setNodes] = useState([{ id: "node-1", label: "" }, { id: "node-2", label: "" }]);
  const [edges, setEdges] = useState([{ from: "node-1", to: "node-2", label: "" }]);
  const [points, setPoints] = useState([{ label: "", value: "" }, { label: "", value: "" }]); const [chartType, setChartType] = useState<"bar" | "line">("bar");
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const attempt = useRef<{ fingerprint: string; commandId: string; request: StartMediaRunRequest } | null>(null);
  const [unknown, setUnknown] = useState(false);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement; dialog.current?.querySelector<HTMLElement>("input, textarea")?.focus();
    return () => { if (previous instanceof HTMLElement) previous.focus(); };
  }, [open]);
  const operation = (): MediaOperation => MediaOperationSchema.parse(kind === "generate" ? { kind, prompt, format: "png", size, quality } : kind === "diagram" ? { kind, title, nodes, edges: edges.map((edge) => ({ from: edge.from, to: edge.to, ...(edge.label ? { label: edge.label } : {}) })) } : { kind, title, chart_type: chartType, labels: points.map((point) => point.label), values: points.map((point) => point.value.trim() ? Number(point.value) : NaN) });
  const submit = async () => {
    if (busy) return;
    let parsed: MediaOperation;
    try { parsed = operation(); } catch { setError("Complete the required fields with valid labels and numbers."); return; }
    const fingerprint = JSON.stringify({ operation: parsed, project: client.getSnapshot().project?.id ?? null });
    if (!unknown && attempt.current?.fingerprint !== fingerprint) {
      const id = commandId(), projectId = client.getSnapshot().project?.id;
      attempt.current = { fingerprint, commandId: id, request: { command_id: id, ...(projectId ? { project_id: projectId } : {}), operation: parsed } };
    }
    if (!attempt.current) return;
    setBusy(true); setError(null);
    try { await client.startMediaRun(attempt.current.request); attempt.current = null; setUnknown(false); onCreated(); onClose(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The creation request could not be confirmed."); setUnknown(true); }
    finally { setBusy(false); }
  };
  if (!open) return null;
  const locked = busy || unknown;
  const operationName = `media.${kind}`;
  const enabled = capabilityAvailable(capabilities, operationName);
  return <div className="media-studio-backdrop"><section className="media-studio" role="dialog" aria-modal="true" aria-label={t("Create media")} ref={dialog} onKeyDown={(event) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); }
    if (event.key === "Tab") { const controls = [...(dialog.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]") ?? [])].filter((control) => control.getClientRects().length); const first = controls[0], last = controls.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
  }}><header><h2>{t("Create media")}</h2><button className="button subtle" disabled={busy} onClick={onClose} type="button">{t("Close")}</button></header>
    <nav aria-label={t("Media type")}>{(["generate", "diagram", "chart"] as const).map((value) => <button className={kind === value ? "active" : ""} aria-pressed={kind === value} disabled={locked} onClick={() => { setKind(value); setError(null); }} type="button" key={value}>{t(value === "generate" ? "Image" : value === "diagram" ? "Diagram" : "Chart")}</button>)}</nav>
    {kind === "generate" ? <><label>{t("Describe your image")}<textarea aria-label={t("Describe your image")} disabled={locked} maxLength={4000} rows={5} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label><div className="media-options"><label>{t("Image size")}<select disabled={locked} value={size} onChange={(event) => setSize(event.target.value as typeof size)}>{["1024x1024", "1536x1024", "1024x1536"].map((value) => <option key={value}>{value}</option>)}</select></label><label>{t("Image quality")}<select disabled={locked} value={quality} onChange={(event) => setQuality(event.target.value as typeof quality)}>{["auto", "low", "medium", "high"].map((value) => <option value={value} key={value}>{t(value)}</option>)}</select></label></div><p>{t("PNG output. Generating an image sends a request to your saved provider and may incur charges.")}</p></> : <><label>{t("Title")}<input aria-label={t("Media title")} maxLength={120} disabled={locked} value={title} onChange={(event) => setTitle(event.target.value)} /></label>{kind === "diagram" ? <><h3>{t("Nodes")}</h3>{nodes.map((node, index) => <div className="media-data-row" key={node.id}><input aria-label={`${t("Node label")} ${index + 1}`} maxLength={120} disabled={locked} value={node.label} onChange={(event) => setNodes(nodes.map((item) => item.id === node.id ? { ...item, label: event.target.value } : item))} /><button className="button subtle" disabled={locked || nodes.length <= 1} onClick={() => { setNodes(nodes.filter((item) => item.id !== node.id)); setEdges(edges.filter((edge) => edge.from !== node.id && edge.to !== node.id)); }} type="button">{t("Remove")}</button></div>)}<button className="button subtle" disabled={locked || nodes.length >= 16} onClick={() => setNodes([...nodes, { id: commandId(), label: "" }])} type="button">{t("Add node")}</button><h3>{t("Connections")}</h3>{edges.map((edge, index) => <div className="media-edge-row" key={index}><select aria-label={`${t("From node")} ${index + 1}`} disabled={locked} value={edge.from} onChange={(event) => setEdges(edges.map((item, position) => position === index ? { ...item, from: event.target.value } : item))}>{nodes.map((node, position) => <option key={node.id} value={node.id}>{node.label || `${t("Node")} ${position + 1}`}</option>)}</select><span>→</span><select aria-label={`${t("To node")} ${index + 1}`} disabled={locked} value={edge.to} onChange={(event) => setEdges(edges.map((item, position) => position === index ? { ...item, to: event.target.value } : item))}>{nodes.map((node, position) => <option key={node.id} value={node.id}>{node.label || `${t("Node")} ${position + 1}`}</option>)}</select><input aria-label={`${t("Connection label")} ${index + 1}`} placeholder={t("Optional label")} disabled={locked} maxLength={120} value={edge.label} onChange={(event) => setEdges(edges.map((item, position) => position === index ? { ...item, label: event.target.value } : item))} /><button className="button subtle" disabled={locked} onClick={() => setEdges(edges.filter((_, position) => position !== index))} type="button">{t("Remove")}</button></div>)}<button className="button subtle" disabled={locked || edges.length >= 32 || !nodes.length} onClick={() => setEdges([...edges, { from: nodes[0]!.id, to: nodes.at(-1)!.id, label: "" }])} type="button">{t("Add connection")}</button></> : <><label>{t("Chart type")}<select disabled={locked} value={chartType} onChange={(event) => setChartType(event.target.value as typeof chartType)}><option value="bar">{t("Bar")}</option><option value="line">{t("Line")}</option></select></label><h3>{t("Data")}</h3>{points.map((point, index) => <div className="media-data-row" key={index}><input aria-label={`${t("Data label")} ${index + 1}`} maxLength={120} disabled={locked} value={point.label} onChange={(event) => setPoints(points.map((item, position) => position === index ? { ...item, label: event.target.value } : item))} /><input aria-label={`${t("Data value")} ${index + 1}`} disabled={locked} type="number" value={point.value} onChange={(event) => setPoints(points.map((item, position) => position === index ? { ...item, value: event.target.value } : item))} /><button className="button subtle" disabled={locked || points.length <= 1} onClick={() => setPoints(points.filter((_, position) => position !== index))} type="button">{t("Remove")}</button></div>)}<button className="button subtle" disabled={locked || points.length >= 24} onClick={() => setPoints([...points, { label: "", value: "" }])} type="button">{t("Add data point")}</button></>}<p>{t("Rendered locally as SVG. No model request is sent.")}</p></>}
    {!enabled && <p role="status">{t(kind === "generate" ? "Connect an image provider in Settings to generate images." : "This creation tool is unavailable on this installation.")}<small>{capabilityFor(capabilities, operationName)?.reason}</small>{kind === "generate" && <button className="button subtle" onClick={() => { onClose(); onSettings(); }} type="button">{t("Image settings")}</button>}</p>}
    {error && <p role="alert">{t(error)}</p>}{unknown && <div><p>{t("The request may already have been accepted. Retry checks the same request without creating a second one.")}</p><code>{attempt.current?.commandId}</code><button className="button subtle" disabled={busy} onClick={() => { if (window.confirm(t("The previous request may already be running. Start a different request?"))) { attempt.current = null; setUnknown(false); setError(null); } }} type="button">{t("Start a different request")}</button></div>}
    <footer><button className="button primary" disabled={busy || !enabled} onClick={() => void submit()} type="button">{t(busy ? "Submitting request…" : unknown ? "Check previous request" : "Create")}</button></footer>
  </section></div>;
}
