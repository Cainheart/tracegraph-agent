import { useState } from "react";
import type { HostCapabilities, WorkbenchSettingsHistory, WorkbenchSettingsHistoryEntry, WorkbenchSettingsSnapshot } from "@tracegraph/contracts";
import type { WorkbenchClient } from "../client";
import { useI18n } from "../i18n";
import { capabilityAvailable, capabilityReadable, commandId, safeError } from "./UnifiedSettings";

/** A history snapshot is already sanitized by the Host. Do not render credential
 * shaped fields even if a future history producer accidentally includes them. */
export function settingsHistoryDiff(previous: Record<string, unknown>, next: Record<string, unknown>, redactedPaths: readonly string[] = []) {
  const flatten = (value: Record<string, unknown>, prefix = ""): Record<string, unknown> => Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (redactedPaths.some((redacted) => path === redacted || path.startsWith(`${redacted}.`)) || /(?:credential|api_key|secret|authorization)/iu.test(path)) return [];
    return item !== null && typeof item === "object" && !Array.isArray(item) ? Object.entries(flatten(item as Record<string, unknown>, path)) : [[path, item]];
  }));
  const before = flatten(previous), after = flatten(next);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter((path) => JSON.stringify(before[path]) !== JSON.stringify(after[path])).map((path) => ({ path, before: before[path], after: after[path] }));
}

export function SettingsHistory({ client, capabilities, snapshot, online, onApplied }: { client: WorkbenchClient; capabilities: HostCapabilities | null; snapshot: WorkbenchSettingsSnapshot; online: boolean; onApplied: (snapshot: WorkbenchSettingsSnapshot) => void }) {
  const { t, language } = useI18n();
  const [history, setHistory] = useState<WorkbenchSettingsHistory | null>(null);
  const [selected, setSelected] = useState<WorkbenchSettingsHistoryEntry | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [message, setMessage] = useState<string | null>(null);
  const [limit, setLimit] = useState(40);
  const readable = online && capabilityReadable(capabilities, "settings.history") && Boolean(client.getWorkbenchSettingsHistory);
  const load = async () => { if (!readable || busy) return; setBusy(true); setError(null); try { setHistory(await client.getWorkbenchSettingsHistory!()); } catch (caught) { setError(safeError(caught)); } finally { setBusy(false); } };
  const restore = async () => {
    if (!selected || busy || !online || !capabilityAvailable(capabilities, "settings.restore") || !client.restoreWorkbenchSettings) return;
    if (!window.confirm(`${t("Restore settings revision")}: ${selected.revision}? ${t("Credentials and permission grants will be preserved.")}`)) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const receipt = await client.restoreWorkbenchSettings({ command_id: commandId(), expected_revision: snapshot.revision, target_revision: selected.revision });
      onApplied(receipt.snapshot);
      setMessage(`${t("Restored settings revision")} ${receipt.restored_from_revision}. ${t("Preserved current sections")}: ${receipt.preserved_sections.join(", ") || t("None")}`);
      setSelected(null);
      // A completed restore is authoritative even if the optional history refresh fails.
      try { setHistory(await client.getWorkbenchSettingsHistory!()); } catch { setError(t("Settings were restored. Refresh history to inspect the new revision.")); }
    } catch (caught) { setError(safeError(caught)); }
    finally { setBusy(false); }
  };
  const diff = selected ? settingsHistoryDiff(selected.settings, snapshot.settings as unknown as Record<string, unknown>, selected.redacted_paths) : [];
  return <section className="settings-history"><h3>{t("Settings history")}</h3><p>{t("Compare saved revisions before restoring. Credentials and permission grants are never restored from history.")}</p><button className="button subtle" disabled={!readable || busy} onClick={() => void load()} type="button">{t(busy ? "Loading…" : "Load settings history")}</button>
    {!readable && <p className="setting-metadata">{t(!online ? "Reconnect to inspect settings history." : "Settings history is unavailable on this installation. Your current settings are preserved.")}</p>}
    {error && <p role="alert">{t(error)}</p>}{message && <p role="status">{message}</p>}
    {history && <div className="settings-history-layout"><div className="settings-revision-list" aria-label={t("Settings revisions")}>{[...history.entries].reverse().slice(0, limit).map((entry) => <button className={selected?.revision === entry.revision ? "active" : ""} aria-pressed={selected?.revision === entry.revision} key={entry.revision} onClick={() => setSelected(entry)} type="button"><strong>{t("Revision")} {entry.revision}</strong><span>{t(entry.operation)} · {new Date(entry.occurred_at).toLocaleString(language)}</span></button>)}{history.entries.length > limit && <button onClick={() => setLimit(limit + 40)} type="button">{t("Show earlier revisions")}</button>}{history.has_more && <small>{t("Only the most recent retained revisions are available.")}</small>}</div>
      {selected && <section aria-label={t("Settings differences")}><h4>{t("Revision")} {selected.revision} → {t("Current")} {snapshot.revision}</h4>{diff.length ? <ul className="settings-diff-list">{diff.map((change) => <li key={change.path}><code>{change.path}</code><del>{JSON.stringify(change.before) ?? "—"}</del><ins>{JSON.stringify(change.after) ?? "—"}</ins></li>)}</ul> : <p>{t("No restorable differences")}</p>}{selected.redacted_paths.length > 0 && <small>{t("Sensitive history values are redacted.")}</small>}<button className="button subtle" disabled={!online || busy || selected.revision === snapshot.revision || !capabilityAvailable(capabilities, "settings.restore")} onClick={() => void restore()} type="button">{t("Restore this revision")}</button></section>}
    </div>}
  </section>;
}
