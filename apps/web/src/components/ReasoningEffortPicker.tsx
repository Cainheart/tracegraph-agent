import type { ReasoningEffort } from "../model";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";

const EFFORTS: readonly ReasoningEffort[] = ["default", "low", "medium", "high", "xhigh", "max"];

export function ReasoningEffortPicker({
  value,
  onChange,
  compact = false,
  disabled = false,
}: {
  value: ReasoningEffort;
  onChange: (value: ReasoningEffort) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <label className={`reasoning-picker ${compact ? "is-compact" : ""}`}>
      <Icon name="spark" size={compact ? 13 : 14} />
      {!compact && <span>{t("Reasoning effort")}</span>}
      <select
        aria-label={t("Reasoning effort")}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as ReasoningEffort)}
        title={t("Controls how much supported models reason before answering")}
        value={value}
      >
        {EFFORTS.map((effort) => <option key={effort} value={effort}>{t(`effort.${effort}`)}</option>)}
      </select>
    </label>
  );
}
