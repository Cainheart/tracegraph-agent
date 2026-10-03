import { useState } from "react";
import type { HostCapabilities, MigrationCommitReceipt, MigrationPreviewSnapshot } from "@tracegraph/contracts";
import type { MigrationResultSnapshot, WorkbenchClient } from "../client";
import { useI18n } from "../i18n";
import { capabilityAvailable, capabilityFor, safeError } from "./UnifiedSettings";

export function MigrationSettings({ client, capabilities }: { client: WorkbenchClient; capabilities: HostCapabilities | null }) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<MigrationPreviewSnapshot | null>(null);
  const [selected, setSelected] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<MigrationCommitReceipt | null>(null);
  const [outcome, setOutcome] = useState<MigrationResultSnapshot | null>(null);
  const [inspected, setInspected] = useState(false);
  const inspect = async () => {
    if (!client.getMigrationResult) return;
    setBusy(true); setError(null);
    try { const result = await client.getMigrationResult(); setOutcome(result ?? null); setInspected(true); if (result?.receipt) { setReceipt(result.receipt); setPreview(null); } }
    catch (caught) { setError(safeError(caught)); }
    finally { setBusy(false); }
  };
  const read = async () => {
    if (!client.previewMigration) return;
    setBusy(true); setError(null); setReviewed(false); setReceipt(null);
    try {
      const next = await client.previewMigration();
      if (next) { setPreview(next); setSelected(next.selected_source_id ?? (next.sources.length === 1 ? next.sources[0]!.source_id : "")); }
    } catch (caught) { setError(safeError(caught)); }
    finally { setBusy(false); }
  };
  const commit = async () => {
    if (!client.commitMigration || !reviewed || !selected || !preview) return;
    if (!window.confirm(t("Import the selected source after backing up this profile? Conflicting sources will be preserved separately."))) return;
    setBusy(true); setError(null);
    try { setReceipt(await client.commitMigration({ source_id: selected })); setPreview(null); }
    catch (caught) { setError(safeError(caught)); }
    finally { setBusy(false); }
  };
  return <section className="migration-settings"><h3>{t("Import local data")}</h3><p>{t("Preview source metadata, choose one source and inspect conflicts before importing. Credentials are never displayed.")}</p>
    {!capabilityAvailable(capabilities, "migration.preview") && <p>{t(capabilityFor(capabilities, "migration.preview")?.reason ?? "Native data selection is unavailable on this client. Use the local CLI migration preview.")}</p>}
    <button className="button subtle" disabled={busy || !client.previewMigration || !capabilityAvailable(capabilities, "migration.preview")} onClick={() => void read()} type="button">{t("Choose source and preview")}</button>
    {capabilityAvailable(capabilities, "migration.result") && <button className="button subtle" disabled={busy || !client.getMigrationResult} onClick={() => void inspect()} type="button">{t("Inspect previous result")}</button>}
    {outcome && <p role="status">{t(outcome.state)} · <code>{outcome.operation_id}</code>{outcome.code && ` · ${outcome.code}`}{outcome.message && ` · ${outcome.message}`}</p>}{inspected && !outcome && <p role="status">{t("No pending migration result")}</p>}
    {busy && <p role="status">{t("Reading migration result…")}</p>}{error && <p className="settings-error" role="alert">{t(error)}</p>}
    {preview && <><label>{t("Selected source")}<select aria-label={t("Selected source")} value={selected} disabled={busy} onChange={(event) => { setSelected(event.target.value); setReviewed(false); }}><option value="">{t("Choose a source")}</option>{preview.sources.map((source) => <option key={source.source_id} value={source.source_id}>{source.label} · {source.file_count} {t("files")}</option>)}</select></label>
      {preview.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
      {preview.active_writer_sources.length > 0 && <p role="alert">{t("Stop source writers before importing")}: {preview.active_writer_sources.join(", ")}</p>}
      <details><summary>{t("File scope and hashes")}: {preview.files.length}</summary>{preview.files.slice(0, 200).map((file, index) => <p key={index}><code>{file.source_id} · {file.scope} · {file.relative_path}</code><small>{file.bytes} B · {file.sha256}</small></p>)}{preview.files.length > 200 && <p>{t("Additional file metadata is omitted from this bounded view. Inspect the CLI preview for all files.")}</p>}</details>
      <details><summary>{t("Conflicts")}: {preview.conflicts.length}</summary>{preview.conflicts.map((conflict, index) => <p key={index}>{conflict.scope} · {conflict.relative_path} · {conflict.source_ids.join(", ")}</p>)}</details>
      <label className="memory-checkbox"><input type="checkbox" checked={reviewed} disabled={busy || !selected} onChange={(event) => setReviewed(event.target.checked)} />{t("I reviewed the selected source and conflict scope")}</label>
      <button className="button primary" disabled={busy || outcome?.state === "queued" || !reviewed || !selected || preview.active_writer_sources.length > 0 || !capabilityAvailable(capabilities, "migration.commit")} onClick={() => void commit()} type="button">{t("Back up and import selected source")}</button>
    </>}
    {receipt && <p role="status">{t("Import completed with backup")}: {receipt.copied_files} {t("files")} · {t("Preserved conflicting sources")}: {receipt.quarantined_source_ids.join(", ") || "—"}</p>}
  </section>;
}
