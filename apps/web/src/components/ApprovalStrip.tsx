import type { ApprovalRequest } from "../model";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";

export function ApprovalStrip({
  approval,
  busy,
  onViewDiff,
  onReject,
  onApprove,
  error = null,
  disabled = false,
}: {
  approval: ApprovalRequest;
  busy: boolean;
  onViewDiff: () => void;
  onReject: () => void;
  onApprove: () => void;
  error?: string | null;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <section className="approval-strip" aria-label={t("Approval required")}>
      <span className="approval-shield"><Icon name="shield" size={19} /></span>
      <div className="approval-copy">
        <div><span className={`risk risk-${approval.risk}`}>{t(approval.risk)} {t("risk")}</span><strong>{t(approval.action)}</strong><code>{approval.id}</code></div>
        <p>{approval.files} {t("files")} · <i>+{approval.additions}</i> <b>−{approval.deletions}</b> · {approval.target} · {t(approval.rollbackAvailable ? "rollback available" : "no rollback")}</p>
        <p className={approval.reviewReady ? "approval-evidence-ready" : "approval-evidence-blocked"}>{t(approval.reviewMessage)}</p>
        {error && <p className="approval-error" role="alert">{error}</p>}
      </div>
      <span className="approval-expiry"><Icon name="clock" size={14} /> {approval.expiresAt}</span>
      <div className="approval-actions">
        <button className="button subtle" onClick={onViewDiff} type="button">{t("View diff")}</button>
        <button className="button danger" disabled={busy || disabled} onClick={onReject} type="button">{t("Reject")}</button>
        <button className="button primary" disabled={busy || disabled || !approval.reviewReady} onClick={onApprove} type="button">{t(busy ? "Applying…" : approval.reviewReady ? "Allow once" : "Verify full diff")}</button>
      </div>
    </section>
  );
}
