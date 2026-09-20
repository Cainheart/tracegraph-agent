import type { ReactNode } from "react";
import { getStatusLabel, getStatusTone, type RunStatus } from "../model";
import { useI18n } from "../i18n";
import { Icon, type IconName } from "./Icon";

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand" aria-label="TraceGraph Agent">
      <span className="brand-mark"><span /><span /><span /></span>
      {!compact && <span className="brand-name">TraceGraph</span>}
    </div>
  );
}

export function StatusPill({ status, small = false }: { status: RunStatus; small?: boolean }) {
  const { t } = useI18n();
  return (
    <span className={`status-pill tone-${getStatusTone(status)} ${small ? "status-pill-small" : ""}`}>
      <span className={status === "running" || status === "indexing" || status === "reconnecting" ? "pulse-dot" : "solid-dot"} />
      {t(getStatusLabel(status))}
    </span>
  );
}

export function IconButton({
  label,
  icon,
  onClick,
  active = false,
  className = "",
  disabled = false,
}: {
  label: string;
  icon: IconName;
  onClick?: () => void;
  active?: boolean;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      aria-label={label}
      className={`icon-button ${active ? "is-active" : ""} ${className}`}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      <Icon name={icon} />
    </button>
  );
}

export function SectionLabel({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="section-label">
      <span>{children}</span>
      {trailing}
    </div>
  );
}

export function Notice({
  tone,
  icon,
  title,
  children,
  action,
}: {
  tone: "info" | "warning" | "danger" | "success";
  icon: IconName;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`notice notice-${tone}`} role={tone === "danger" ? "alert" : "status"}>
      <span className="notice-icon"><Icon name={icon} size={17} /></span>
      <div className="notice-copy"><strong>{title}</strong><span>{children}</span></div>
      {action && <div className="notice-action">{action}</div>}
    </div>
  );
}
