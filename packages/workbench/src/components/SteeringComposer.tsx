import type { ConsumedUserInputFact, PendingUserInput, UserInputKind } from "@tracegraph/contracts";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";

export function SteeringComposer({
  enterBehavior = "enter",
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
  enterBehavior?: "enter" | "mod-enter";
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
      {pending.length > 0 && <details className="steering-queue-summary"><summary>{t("Queued")}: {pending.length}</summary><div className="steering-pending" aria-label={t("Pending input queue")}>{pending.map((input) => <p key={input.input_id}><strong>{t(input.kind === "approve_hint" ? "Approval hint" : input.kind === "cancel" ? "Cancel" : "Message")}</strong> {input.kind === "cancel" ? t("Stop at the next safe boundary") : input.body}</p>)}</div>{lastConsumed && <small>{t("Last consumed at step")} {lastConsumed.at_step}</small>}<small>{t("Will be sent at the next step")}</small></details>}
      <div className={`composer-input ${disabled ? "is-disabled" : ""}`}>
        <Icon name="message" size={16} />
        <textarea
          aria-label={t("Steer this run")}
          disabled={disabled || busy || regularInputFull || hasPendingCancel}
          maxLength={8_000}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && (enterBehavior === "enter" ? !(event.metaKey || event.ctrlKey) : event.metaKey || event.ctrlKey)) {
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
        <button className="button subtle steering-cancel" disabled={!canCancel} onClick={onCancel} type="button"><Icon name="stop" size={13} />{hasPendingCancel ? t("Cancellation queued") : t("Stop")}</button>
      </div>

      {regularInputFull && !queueFull && <p className="steering-error" role="alert">{language === "zh-CN" ? "最后一个队列槽位已为紧急取消预留。" : "The final queue slot is reserved for emergency cancellation."}</p>}
      {queueFull && <p className="steering-error" role="alert">{t("The input queue is full. Wait for the next safe step.")}</p>}
      {error && <p className="steering-error" role="alert">{error}</p>}
    </div>
  );
}
