import type { TodoItem } from "@tracegraph/contracts";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";

export function PlanApprovalBanner({
  eventId,
  todos,
  busy,
  disabled = false,
  error,
  onApprove,
}: {
  eventId: string;
  todos: readonly TodoItem[];
  busy: boolean;
  disabled?: boolean;
  error?: string | null;
  onApprove: () => void;
}) {
  const { t } = useI18n();
  return (
    <section className="plan-approval-banner" role="status">
      <span className="plan-approval-icon"><Icon name="route" size={18} /></span>
      <div className="plan-approval-copy">
        <strong>{t("Plan ready for approval")}</strong>
        <span>{t("Plan mode is paused before execution. Review the Todo list, then approve this exact plan revision.")}</span>
        <small>{todos.length} {t("Todo items")} · <code>{eventId}</code></small>
        {error && <em className="plan-approval-error" role="alert">{error}</em>}
      </div>
      <button className="button primary" disabled={busy || disabled} onClick={onApprove} type="button">
        <Icon name="play" size={13} />{t(busy ? "Approving…" : "Approve and execute")}
      </button>
    </section>
  );
}
