import { useState } from "react";
import type { HostCapabilities } from "@tracegraph/contracts";
import type { WorkbenchClient } from "../client";
import type { AppliedPatchAction, RollbackReceipt, RunStatus } from "../model";
import { useI18n } from "../i18n";
import { capabilityAvailable, capabilityFor, safeError } from "./UnifiedSettings";

export function RollbackControls({ client, actions, capabilities, status, readOnly }: { client: WorkbenchClient; actions: readonly AppliedPatchAction[]; capabilities: HostCapabilities | null; status: RunStatus; readOnly: boolean }) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<AppliedPatchAction | null>(null), [force, setForce] = useState(false), [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<RollbackReceipt | null>(null), [error, setError] = useState<string | null>(null);
  const quiescent = ["completed", "ready_for_review", "failed", "cancelled", "interrupted", "needs_manual_review"].includes(status);
  const available = !readOnly && quiescent && capabilityAvailable(capabilities, "rollback.write");
  const request = async () => {
    if (!selected || !available || busy) return;
    setBusy(true); setError(null); setReceipt(null);
    try { setReceipt(await client.rollbackAction(selected.actionId, { force })); setSelected(null); }
    catch (caught) { setError(safeError(caught)); }
    finally { setBusy(false); }
  };
  return <section className="rollback-controls" aria-label={t("Action rollback")}><details><summary>{t("Applied actions and rollback")}</summary>
    <p>{t("The Host checks rollback policy, recorded backups and current file hashes before restoring files.")}</p>
    {!available && <p>{readOnly ? t("Exit replay before requesting rollback") : !quiescent ? t("Stop the Run before requesting Action rollback") : t(capabilityFor(capabilities, "rollback.write")?.reason ?? "Action rollback is unavailable on this Host")}</p>}
    {actions.length === 0 && <p>{t("No applied Action is recorded for this Run")}</p>}
    {actions.map((action) => <div className="rollback-action-row" key={action.actionId}><code>{action.actionId}</code><small>{action.scope.join(", ") || t("Scope unavailable")} · {t(action.state)}</small><button className="button subtle" disabled={!available || busy || action.state !== "applied" || action.scope.length === 0} onClick={() => { setSelected(action); setForce(false); setError(null); setReceipt(null); }} type="button">{t("Review rollback")}</button></div>)}
  </details>
    {selected && <section className="rollback-confirmation" role="alertdialog" aria-label={t("Confirm Action rollback")}><h3>{t("Restore the recorded files for this Action?")}</h3><code>{selected.projectId} · {selected.runId} · {selected.actionId}</code><small>{t("Applied patch event")}: {selected.patchEventId}</small><ul>{selected.scope.map((path) => <li key={path}><code>{path}</code></li>)}</ul><p>{t("Only the recorded Action scope will be requested. The Host refuses changed files or disallowed policy without restoring them.")}</p>{selected.workspaceKind !== "disposable_fixture" && <label><input type="checkbox" checked={force} disabled={busy || readOnly} onChange={(event) => setForce(event.target.checked)} />{t("Explicitly request force for this persistent workspace; Host policy must allow it")}</label>}<div className="resource-button-row"><button className="button danger" disabled={!available || busy || (selected.workspaceKind !== "disposable_fixture" && !force)} onClick={() => void request()} type="button">{t("Confirm rollback")}</button><button className="button subtle" disabled={busy} onClick={() => setSelected(null)} type="button">{t("Cancel")}</button></div></section>}
    {busy && <p role="status">{t("Waiting for durable rollback result…")}</p>}{error && <p role="alert" className="resource-error">{t(error)}</p>}{receipt && <p role={receipt.state === "refused" ? "alert" : "status"}>{t(receipt.state === "rolled_back" ? "Rollback recorded" : "Rollback refused; files were not restored")} · <code>{receipt.actionId}</code> · {receipt.eventId} #{receipt.sequence}{receipt.reason && ` · ${receipt.reason}`}</p>}
  </section>;
}
