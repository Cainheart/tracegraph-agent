import { useEffect, useRef, useState } from "react";
import type { ReasoningEffort } from "../model";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";

export const EFFORT_LABELS: Record<ReasoningEffort, string> = { default: "Default", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum" };

const EFFORTS: readonly ReasoningEffort[] = ["default", "low", "medium", "high", "xhigh", "max"];

export function ReasoningEffortPicker({
  value,
  onChange,
  compact = false,
  disabled = false, allowed = EFFORTS,
}: {
  value: ReasoningEffort;
  onChange: (value: ReasoningEffort) => void;
  compact?: boolean;
  disabled?: boolean; allowed?: readonly ReasoningEffort[];
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
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
    <label className={`reasoning-picker ${compact ? "is-compact" : ""} ${open ? "is-open" : ""}`} data-supported-values={allowed.join(",")} ref={pickerRef}>
      <Icon name="spark" size={compact ? 13 : 14} />
      {!compact && <span>{t("Reasoning effort")}</span>}
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className="reasoning-picker-trigger"
        aria-label={t("Reasoning effort")}
        disabled={disabled}
        ref={triggerRef}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" || disabled) return;
          event.preventDefault();
          setOpen(true);
          window.setTimeout(() => pickerRef.current?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')?.focus(), 0);
        }}
        onClick={() => setOpen((value) => !value)}
        title={t("Controls how much supported models reason before answering")}
        type="button"
      >
        <span>{t(EFFORT_LABELS[value])}</span><Icon name="chevron" size={12} />
      </button>
      {open && <div className="reasoning-picker-menu" onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus();
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const options = [...(pickerRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])];
        const index = options.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
        options[next]?.focus();
      }} role="listbox" aria-label={t("Reasoning effort")}>
        {allowed.map((effort) => <button aria-selected={value === effort} className={value === effort ? "active" : ""} key={effort} onClick={() => choose(effort)} role="option" type="button">{t(EFFORT_LABELS[effort])}</button>)}
      </div>}
    </label>
  );
}
