import { useEffect, useRef, useState } from "react";
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
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLLabelElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => {
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const choose = (effort: ReasoningEffort) => {
    onChange(effort);
    setOpen(false);
  };
  return (
    <label className={`reasoning-picker ${compact ? "is-compact" : ""} ${open ? "is-open" : ""}`} data-supported-values={EFFORTS.join(",")} ref={pickerRef}>
      <Icon name="spark" size={compact ? 13 : 14} />
      {!compact && <span>{t("Reasoning effort")}</span>}
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className="reasoning-picker-trigger"
        aria-label={t("Reasoning effort")}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        title={t("Controls how much supported models reason before answering")}
        type="button"
      >
        <span>{t(`effort.${value}`)}</span><Icon name="chevron" size={12} />
      </button>
      {open && <div className="reasoning-picker-menu" role="listbox" aria-label={t("Reasoning effort")}>
        {EFFORTS.map((effort) => <button aria-selected={value === effort} className={value === effort ? "active" : ""} key={effort} onClick={() => choose(effort)} role="option" type="button">{t(`effort.${effort}`)}</button>)}
      </div>}
    </label>
  );
}
