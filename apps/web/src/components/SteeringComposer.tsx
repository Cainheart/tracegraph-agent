import type { ConsumedUserInputFact, PendingUserInput, UserInputKind } from "@tracegraph/contracts";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";

export function SteeringComposer({
  value,
  kind,
  pending,
  lastConsumed,
  busy,
  cancelBusy,
  error,
  disabledReason,
  onValueChange,
  onKindChange,
  onSubmit,
  onCancel,
}: {
  value: string;
  kind: Exclude<UserInputKind, "cancel">;
  pending: readonly PendingUserInput[];
  lastConsumed?: ConsumedUserInputFact;
  busy: boolean;
  cancelBusy: boolean;
  error: string | null;
  disabledReason: string | null;
  onValueChange: (value: string) => void;
  onKindChange: (kind: Exclude<UserInputKind, "cancel">) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { language, t } = useI18n();
  const queueFull = pending.length >= 100;
  const regularInputFull = pending.length >= 99;
  const hasPendingCancel = pending.some((input) => input.kind === "cancel");
  const disabled = disabledReason !== null;
  const canSubmit = !disabled && !busy && !regularInputFull && !hasPendingCancel && value.trim().length > 0;
  const canCancel = !disabled && !cancelBusy && !queueFull && !hasPendingCancel;

  return (
    <div className="steering-composer">
      <div className="steering-status" role="status">
        <span><Icon name="message" size={14} />{t("Queue mode")}</span>
        <strong>{pending.length > 0
          ? `${pending.length} ${t("queued — will be sent at the next safe step")}`
          : t("Will be sent at the next step")}</strong>
        {lastConsumed && <small>{t("Last consumed at step")} <code>{lastConsumed.at_step}</code></small>}
      </div>

      {pending.length > 0 && (
        <div className="steering-pending" aria-label={t("Pending input queue")}>
          {pending.map((input) => (
            <span key={input.input_id}>
              <b>{t(input.kind === "approve_hint" ? "Approval hint" : input.kind === "cancel" ? "Cancel" : "Message")}</b>
              <code>{input.kind === "cancel" ? t("Stop at the next safe boundary") : input.body}</code>
            </span>
          ))}
        </div>
      )}

      <div className={`composer-input ${disabled ? "is-disabled" : ""}`}>
        <Icon name="message" size={16} />
        <textarea
          aria-label={t("Steer this run")}
          disabled={disabled || busy || regularInputFull || hasPendingCancel}
          maxLength={8_000}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (canSubmit) onSubmit();
            }
          }}
          placeholder={disabledReason === null ? t("Send guidance for the next model step…") : t(disabledReason)}
          rows={2}
          value={value}
        />
        <button aria-label={t("Queue input")} className="button primary" disabled={!canSubmit} onClick={onSubmit} type="button"><Icon name="send" size={15} /></button>
      </div>

      <div className="steering-actions">
        <label>
          <span>{t("Input kind")}</span>
          <select disabled={disabled || busy || regularInputFull || hasPendingCancel} onChange={(event) => onKindChange(event.target.value as Exclude<UserInputKind, "cancel">)} value={kind}>
            <option value="message">{t("Message")}</option>
            <option value="approve_hint">{t("Approval hint")}</option>
          </select>
        </label>
        <button className="button subtle steering-cancel" disabled={!canCancel} onClick={onCancel} type="button"><Icon name="stop" size={13} />{hasPendingCancel ? t("Cancellation queued") : t("Cancel run safely")}</button>
      </div>
      <p className="steering-attachment-note"><Icon name="file" size={12} />{t("Attachments are available only for the next new task, not for a running Run.")}</p>
      {regularInputFull && !queueFull && <p className="steering-error" role="alert">{language === "zh-CN" ? "最后一个队列槽位已为紧急取消预留。" : "The final queue slot is reserved for emergency cancellation."}</p>}
      {queueFull && <p className="steering-error" role="alert">{t("The input queue is full. Wait for the next safe step.")}</p>}
      {error && <p className="steering-error" role="alert">{error}</p>}
    </div>
  );
}
