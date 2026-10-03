import { useEffect, useRef, useState } from "react";
import { MAX_PROJECT_CONTEXT_FILES, MAX_PROJECT_CONTEXT_FILE_BYTES, MAX_PROJECT_CONTEXT_TOTAL_BYTES, type HostCapabilities, type ProjectFileList } from "@tracegraph/contracts";
import type { WorkbenchClient } from "../client";
import type { PendingProjectFileContext } from "../drafts";
import { useI18n } from "../i18n";
import { capabilityAvailable, safeError } from "./UnifiedSettings";
import { Icon } from "./Icon";

/** Select metadata for admission; file contents never become client-authored task text. */
export function ProjectFileContextPicker({ client, projectId, selected, onChange, onClose, online, readOnly, capabilities }: {
  client: WorkbenchClient; projectId: string; selected: readonly PendingProjectFileContext[]; onChange: (selected: readonly PendingProjectFileContext[]) => void; onClose: () => void; online: boolean; readOnly: boolean; capabilities: HostCapabilities | null;
}) {
  const { t } = useI18n(); const dialog = useRef<HTMLElement>(null); const generation = useRef(0);
  const [directory, setDirectory] = useState(""); const [listing, setListing] = useState<ProjectFileList | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const available = online && !readOnly && capabilityAvailable(capabilities, "files.list") && capabilityAvailable(capabilities, "files.read");
  const list = async (path: string) => {
    if (!available || !client.listProjectFiles) return;
    const token = ++generation.current; setBusy(true); setError(null);
    try { const next = await client.listProjectFiles(projectId, path ? { path } : {}); if (token === generation.current) { setListing(next); setDirectory(path); } }
    catch (caught) { if (token === generation.current) setError(safeError(caught)); }
    finally { if (token === generation.current) setBusy(false); }
  };
  useEffect(() => { if (!available) { generation.current += 1; setBusy(false); return; } void list(directory); return () => { generation.current += 1; }; }, [projectId, available]);
  useEffect(() => { const previous = document.activeElement; dialog.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus(); return () => { if (previous instanceof HTMLElement && document.contains(previous)) previous.focus(); }; }, []);
  const toggle = async (path: string) => {
    if (!available || busy || !client.readProjectFile) return;
    if (selected.some((item) => item.path === path)) { onChange(selected.filter((item) => item.path !== path)); return; }
    if (selected.length >= MAX_PROJECT_CONTEXT_FILES) { setError(t("Choose at most 5 project files.")); return; }
    const token = generation.current; setBusy(true); setError(null);
    try {
      const file = await client.readProjectFile(projectId, { path });
      if (token !== generation.current) return;
      if (file.project_id !== projectId || file.path !== path || !/^sha256:[a-f0-9]{64}$/u.test(file.sha256)) throw new Error(t("The selected file could not be verified."));
      if (file.kind !== "text" || file.content === undefined) throw new Error(t("Only existing UTF-8 text files can be added as project context."));
      if (file.byte_length > MAX_PROJECT_CONTEXT_FILE_BYTES) throw new Error(t("Each project context file must be 64 KiB or smaller."));
      if (selected.reduce((total, item) => total + item.byte_length, file.byte_length) > MAX_PROJECT_CONTEXT_TOTAL_BYTES) throw new Error(t("Selected project context must total 128 KiB or less."));
      onChange([...selected, { path: file.path, expected_sha256: file.sha256, byte_length: file.byte_length }]);
    } catch (caught) { if (token === generation.current) setError(safeError(caught)); }
    finally { if (token === generation.current) setBusy(false); }
  };
  return <div className="file-context-backdrop"><section className="file-context-picker" role="dialog" aria-modal="true" aria-label={t("Project file context")} ref={dialog} onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    if (event.key === "Tab") { const controls = [...(dialog.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])].filter((item) => item.getClientRects().length); const first = controls[0], last = controls.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
  }}><header><h2>{t("Project file context")}</h2><button className="icon-button" aria-label={t("Close file context picker")} onClick={onClose} type="button"><Icon name="x" /></button></header><p>{t("Selected files are checked again when the task starts. Their contents are provided as untrusted context, not as instructions.")}</p><small>{selected.length}/{MAX_PROJECT_CONTEXT_FILES} · {selected.reduce((total, item) => total + item.byte_length, 0)}/{MAX_PROJECT_CONTEXT_TOTAL_BYTES} {t("bytes")}</small><nav aria-label={t("Context file directory")}><strong title={directory}>{directory || "/"}</strong>{directory && <button className="icon-button" aria-label={t("Parent directory")} disabled={busy || !available} onClick={() => void list(directory.split("/").slice(0, -1).join("/"))} type="button"><Icon name="arrow-left" /></button>}<button className="icon-button" aria-label={t("Refresh files")} disabled={busy || !available} onClick={() => void list(directory)} type="button"><Icon name="refresh" /></button></nav><div className="context-file-list">{listing?.entries.map((entry) => <button className={selected.some((item) => item.path === entry.path) ? "active" : ""} key={entry.path} disabled={busy || !available} aria-pressed={entry.kind === "file" ? selected.some((item) => item.path === entry.path) : undefined} onClick={() => void (entry.kind === "directory" ? list(entry.path) : toggle(entry.path))} type="button"><Icon name={entry.kind === "directory" ? "folder" : "file"} size={14} /><span>{entry.name}</span>{selected.some((item) => item.path === entry.path) && <Icon name="check" size={14} />}</button>)}{!busy && listing?.entries.length === 0 && <p>{t("No files in this directory.")}</p>}{listing?.truncated && <p>{t("This directory listing is truncated.")}</p>}</div>{busy && <p role="status">{t("Loading…")}</p>}{error && <p role="alert">{error}</p>}{!available && <p role="status">{t(online ? "Project file context is unavailable with the current permissions." : "Reconnect to choose project file context. Your selections are preserved.")}</p>}<footer><button className="button primary" onClick={onClose} type="button">{t("Done")}</button></footer></section></div>;
}
