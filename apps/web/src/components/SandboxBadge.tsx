import type { SandboxReport } from "@tracegraph/contracts";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";

function detail(report: SandboxReport): string {
  const mechanisms = report.mechanisms.length > 0
    ? `Mechanisms: ${report.mechanisms.join(", ")}`
    : "No sandbox mechanism is active";
  const unmet = report.unmet_constraints.length > 0
    ? `Unmet constraints: ${report.unmet_constraints.join(", ")}`
    : "All requested constraints are enforced";
  return `${report.mode} · ${report.enforcement} · ${report.platform}. ${mechanisms}. ${unmet}.`;
}

export function SandboxBadge({
  compact = false,
  report,
}: {
  readonly compact?: boolean;
  readonly report: SandboxReport;
}) {
  const { t } = useI18n();
  return (
    <span
      aria-label={`${t("Sandbox")} ${report.mode}, ${report.enforcement}`}
      className={`sandbox-badge sandbox-${report.enforcement} ${compact ? "is-compact" : ""}`}
      title={detail(report)}
    >
      <Icon name="shield" size={compact ? 10 : 12} />
      <span>{report.mode}</span>
      <strong>{report.enforcement}</strong>
    </span>
  );
}
