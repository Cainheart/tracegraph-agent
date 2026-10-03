import { useEffect, useRef, useState } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, lineNumbers, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import type { HostCapabilities, ProjectFileList, ProjectFileSnapshot, ProjectFileSaveRequest, ProjectFileSaveResult } from "@tracegraph/contracts";
import type { WorkbenchClient } from "../client";
import { useI18n } from "../i18n";
import { capabilityAvailable, capabilityReadable, commandId, safeError } from "./UnifiedSettings";
import { Icon } from "./Icon";

export function ProjectFiles({ client, projectId, sessionId, capabilities, readOnly, online, onDirty }: {
  client: WorkbenchClient; projectId?: string; sessionId?: string; capabilities: HostCapabilities | null; readOnly: boolean; online: boolean; onDirty?: (dirty: boolean) => void;
}) {
  const { t } = useI18n();
  const [directory, setDirectory] = useState("");
  const [listing, setListing] = useState<ProjectFileList | null>(null);
  const [file, setFile] = useState<ProjectFileSnapshot | null>(null);
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<ProjectFileSaveRequest | null>(null);
  const [result, setResult] = useState<ProjectFileSaveResult | null>(null);
  const [admissionRejected, setAdmissionRejected] = useState(false);
  const [retryReady, setRetryReady] = useState(false);
  const generation = useRef(0);
  const previousOnline = useRef(online);
  const dirty = file?.kind === "text" && content !== file.content;
  useEffect(() => { if (!dirty) return; const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; }; window.addEventListener("beforeunload", guard); return () => window.removeEventListener("beforeunload", guard); }, [dirty]);
  useEffect(() => { onDirty?.(Boolean(dirty)); return () => onDirty?.(false); }, [dirty, onDirty]);
  const list = async (path: string) => {
    if (!projectId || !client.listProjectFiles || !online) return;
    const token = ++generation.current; setBusy(true); setError(null);
    try { const next = await client.listProjectFiles(projectId, path ? { path } : {}); if (token === generation.current) { setListing(next); setDirectory(path); } }
    catch (caught) { if (token === generation.current) setError(safeError(caught)); }
    finally { if (token === generation.current) setBusy(false); }
  };
  useEffect(() => { setFile(null); setAttempt(null); setResult(null); setAdmissionRejected(false); setRetryReady(false); setContent(""); setListing(null); setDirectory(""); void list(""); return () => { generation.current += 1; }; }, [projectId]);
  useEffect(() => { if (online && !previousOnline.current) void list(directory); previousOnline.current = online; }, [online]);
  const open = async (path: string, discardConfirmed = false) => {
    if (!projectId || !client.readProjectFile || !online || (dirty && !discardConfirmed && !window.confirm(t("Discard unsaved edits?")))) return;
    const token = ++generation.current; setBusy(true); setError(null);
    try { const next = await client.readProjectFile(projectId, { path }); if (token === generation.current) { setFile(next); setContent(next.content ?? ""); setAttempt(null); setResult(null); setAdmissionRejected(false); setRetryReady(false); } }
    catch (caught) { if (token === generation.current) setError(safeError(caught)); }
    finally { if (token === generation.current) setBusy(false); }
  };
  const save = async (request?: ProjectFileSaveRequest) => {
    if (!projectId || !file || !client.saveProjectFile || busy || !online || readOnly) return;
    const input = request ?? { command_id: commandId(), path: file.path, expected_sha256: file.sha256, content, ...(sessionId ? { session_id: sessionId } : {}) };
    const token = generation.current;
    setAttempt(input); setAdmissionRejected(false); setRetryReady(false); setBusy(true); setError(null);
    let acceptedReceipt = false;
    try { const receipt = await client.saveProjectFile(projectId, input); if (token !== generation.current) return; acceptedReceipt = true; setResult(receipt); if (receipt.status === "succeeded") { const next = await client.readProjectFile!(projectId, { path: file.path }); if (token !== generation.current) return; setFile(next); setContent(next.content ?? ""); setAttempt(null); } }
    catch (caught) { if (token === generation.current) { const rejected = !acceptedReceipt && isRejectedBeforeAdmission(caught); setError(rejected ? null : safeError(caught)); if (!acceptedReceipt) { setResult(null); setAdmissionRejected(rejected); } } }
    finally { if (token === generation.current) setBusy(false); }
  };
  const repairRejectedSave = async () => {
    if (!projectId || !attempt || !client.readProjectFile || busy) return;
    const token = generation.current; setBusy(true); setError(null); setRetryReady(false);
    try { await client.reconnect(); await client.readProjectFile(projectId, { path: attempt.path }); if (token === generation.current) setRetryReady(true); }
    catch (caught) { if (token === generation.current) setError(safeError(caught)); }
    finally { if (token === generation.current) setBusy(false); }
  };
  const reconcile = async () => {
    if (!projectId || !attempt || !client.reconcileProjectFileSave || !online || busy) return;
    const token = generation.current;
    setBusy(true); setError(null);
    try { const receipt = await client.reconcileProjectFileSave(projectId, { command_id: attempt.command_id }); if (token !== generation.current) return; setResult(receipt); if (receipt.status === "succeeded" && client.readProjectFile) { const next = await client.readProjectFile(projectId, { path: attempt.path }); if (token !== generation.current) return; setFile(next); setContent(next.content ?? ""); setAttempt(null); } }
    catch (caught) { if (token === generation.current) setError(safeError(caught)); } finally { if (token === generation.current) setBusy(false); }
  };
  if (!projectId) return <div className="panel-empty">{t("Choose a project to browse and edit files.")}</div>;
  const canEdit = online && !readOnly && capabilityAvailable(capabilities, "files.save") && file?.kind === "text" && !busy && !attempt;
  return <section className="project-files" aria-label={t("Project files")}>
    {!online && <p role="status">{t("Reconnect to refresh or save files. Your edits are preserved.")}</p>}
    <div className="project-file-browser"><header><strong>{directory || t("Project files")}</strong>{directory && <button className="icon-button" aria-label={t("Parent directory")} disabled={busy || !online} onClick={() => void list(directory.split("/").slice(0, -1).join("/"))} type="button"><Icon name="arrow-left" /></button>}<button className="icon-button" aria-label={t("Refresh files")} disabled={busy || !online} onClick={() => void list(directory)} type="button"><Icon name="refresh" /></button></header>{!listing && !busy && !error && <p>{t(capabilityReadable(capabilities, "files.list") ? "No files loaded." : "File browsing is unavailable on this installation.")}</p>}{listing?.entries.map((entry) => <button key={entry.path} disabled={busy || !online} className={file?.path === entry.path ? "active" : ""} onClick={() => void (entry.kind === "directory" ? list(entry.path) : open(entry.path))} type="button"><Icon name={entry.kind === "directory" ? "folder" : "file"} size={13} /><span>{entry.name}</span></button>)}{listing?.truncated && <small>{t("This directory listing is truncated.")}</small>}</div>
    <div className="project-file-editor">{file ? <><header><strong title={file.path}>{file.path}{dirty ? " *" : ""}</strong><button className="button subtle" disabled={!canEdit || !dirty} onClick={() => void save()} type="button">{t(busy ? "Saving…" : "Save")}</button></header>{file.kind === "text" ? <CodeEditor path={file.path} value={content} onChange={setContent} readOnly={!canEdit} onSave={() => { if (canEdit && dirty) void save(); }} /> : file.image ? <ImageFilePreview file={file} /> : <p>{t(file.kind === "binary" ? "This binary file can be inspected but cannot be edited here." : "This file is too large for the editor.")}</p>}<small className="file-version">SHA256 {file.sha256}</small></> : <p className="panel-empty">{t("Select a file")}</p>}</div>
    {busy && <p role="status">{t("Loading…")}</p>}{error && <p role="alert">{error}</p>}
    {result && <div className="file-save-result" role="status"><strong>{t(result.status)}</strong><p>{result.path} · {result.code}</p>{result.receipt_event_id && <code>{result.receipt_event_id}</code>}{result.status === "conflict" && <><p>{t("The file changed since it was opened. Your edits have been preserved. Reload before saving again.")}</p><button disabled={busy} className="button subtle" onClick={() => { if (window.confirm(t("Discard unsaved edits?"))) { setContent(file?.content ?? ""); setAttempt(null); if (file) void open(file.path, true); } }} type="button">{t("Reload file")}</button></>}{result.status === "awaiting_approval" && attempt && result.approval_id && <><p>{t("Approve saving exactly this edited content to the selected file?")}</p><code>{attempt.path} · {attempt.expected_sha256} → {result.content_sha256}</code><div><button disabled={busy || !online} className="button primary" onClick={() => void save({ ...attempt, approval: { approval_id: result.approval_id!, decision: "approve" } })} type="button">{t("Approve save")}</button><button disabled={busy || !online} className="button subtle" onClick={() => void save({ ...attempt, approval: { approval_id: result.approval_id!, decision: "deny" } })} type="button">{t("Reject")}</button></div></>}{["denied", "failed"].includes(result.status) && <button className="button subtle" onClick={() => { setAttempt(null); setResult(null); }} type="button">{t("Keep editing")}</button>}</div>}
    {attempt && admissionRejected && <div className="file-save-recovery" role="status"><p>{t("The save was not accepted. Repair the connection, then retry the same save. Your edits are preserved.")}</p><button className="button subtle" disabled={busy} onClick={() => void repairRejectedSave()} type="button">{t("Repair connection")}</button><button className="button primary" disabled={busy || !online || !retryReady} onClick={() => void save(attempt)} type="button">{t("Retry save")}</button>{!attempt.approval && <button className="button subtle" disabled={busy} onClick={() => { setAttempt(null); setResult(null); setAdmissionRejected(false); setRetryReady(false); }} type="button">{t("Keep editing")}</button>}</div>}
    {attempt && !admissionRejected && (!result || result.status === "unknown") && <div><p>{t("The save outcome is unknown. Inspect the original command before retrying.")}</p><button className="button subtle" disabled={busy || !online} onClick={() => void reconcile()} type="button">{t("Inspect save result")}</button></div>}
    {attempt && result?.status === "succeeded" && <button className="button subtle" disabled={busy || !online} onClick={() => file && void open(file.path, true)} type="button">{t("Reload file")}</button>}
  </section>;
}

/** Only transport-owned, explicit pre-admission rejection permits an ordinary retry. */
function isRejectedBeforeAdmission(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("admission" in error) || error.admission !== "rejected") return false;
  if ("code" in error && error.code === "mutation_preflight_failed" && "commandDispatched" in error && error.commandDispatched === false) return true;
  if (!("status" in error) || error.status !== 401 || !("body" in error) || typeof error.body !== "object" || error.body === null || !("error" in error.body)) return false;
  return ["capability_required", "capability_invalid", "capability_expired"].includes(String(error.body.error));
}

export function CodeEditor({ path, value, onChange, readOnly, onSave }: { path: string; value: string; onChange: (value: string) => void; readOnly: boolean; onSave?: () => void }) {
  const host = useRef<HTMLDivElement>(null); const editor = useRef<EditorView | null>(null); const readonly = useRef(new Compartment()); const callback = useRef(onChange); callback.current = onChange; const saveCallback = useRef(onSave); saveCallback.current = onSave;
  useEffect(() => {
    if (!host.current) return;
    const language = /\.[jt]sx?$/u.test(path) ? javascript({ typescript: /\.tsx?$/u.test(path), jsx: /x$/u.test(path) }) : /\.json$/u.test(path) ? json() : /\.md$/u.test(path) ? markdown() : [];
    const view = new EditorView({ parent: host.current, state: EditorState.create({ doc: value, extensions: [lineNumbers(), history(), keymap.of([{ key: "Mod-s", run: () => { saveCallback.current?.(); return true; } }, ...defaultKeymap, ...historyKeymap]), syntaxHighlighting(defaultHighlightStyle), language, readonly.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]), EditorView.updateListener.of((update) => { if (update.docChanged) callback.current(update.state.doc.toString()); }), EditorView.theme({ "&": { height: "100%", fontSize: "13px", backgroundColor: "var(--panel)", color: "var(--text)" }, ".cm-scroller": { overflow: "auto", fontFamily: "ui-monospace, monospace" }, ".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--muted)", border: "none" }, ".cm-content": { minHeight: "300px" } })] }) }); editor.current = view;
    return () => { view.destroy(); editor.current = null; };
  }, [path]);
  useEffect(() => { const view = editor.current; if (view && view.state.doc.toString() !== value) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }); }, [value]);
  useEffect(() => { editor.current?.dispatch({ effects: readonly.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) }); }, [readOnly]);
  return <div className="code-editor" ref={host} aria-label={`File editor: ${path}`} />;
}

function ImageFilePreview({ file }: { file: ProjectFileSnapshot }) {
  const { t } = useI18n(); const [url, setUrl] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => { setError(null); setUrl(null); if (!file.image) return; let value: string | null = null; try { const decoded = atob(file.image.data_base64); const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0)); if (bytes.byteLength !== file.byte_length) throw new Error("Image file verification failed."); value = URL.createObjectURL(new Blob([bytes], { type: file.image.media_type })); setUrl(value); } catch { setError(t("Image preview could not be decoded.")); } return () => { if (value) URL.revokeObjectURL(value); }; }, [file.path, file.sha256]);
  return <div className="project-image-preview">{url && !error && <img alt={file.path} src={url} onError={() => setError(t("Image preview could not be decoded."))} />}{file.image && <small>{file.image.width} × {file.image.height} · {file.image.media_type}</small>}{error && <p role="alert">{error}</p>}</div>;
}
