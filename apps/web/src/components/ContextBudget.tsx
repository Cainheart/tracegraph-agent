import { useEffect, useRef, useState } from "react";
import type { ContextArchiveLoadResult, ContextBudgetSnapshot, ContextSource } from "../model";
import { useI18n } from "../i18n";

export type ContextArchiveLoader = (artifactId: string) => Promise<ContextArchiveLoadResult>;

export async function loadContextArchiveOnOpen({
  open,
  artifactId,
  load,
  update,
}: {
  open: boolean;
  artifactId: string;
  load: ContextArchiveLoader;
  update: (result: ContextArchiveLoadResult) => void;
}): Promise<void> {
  if (!open) return;
  update({ status: "loading", message: "Loading archived Context source…" });
  try {
    update(await load(artifactId));
  } catch {
    update({ status: "unavailable", message: "Archived Context source request failed." });
  }
}

export function ContextBudget({
  sources,
  used,
  limit,
  reservedOutput,
  windowLimit,
  status,
  estimator = "heuristic_v2",
  warningThreshold,
  compressionThreshold,
  compression,
  estimate,
  providerUsage,
  onLoadArchive,
}: {
  sources: readonly ContextSource[];
  used: number;
  limit: number;
  reservedOutput: number;
  windowLimit?: number;
  status?: "healthy" | "warning" | "compressed";
  estimator?: "heuristic_v2" | "provider_tokenizer";
  warningThreshold?: number;
  compressionThreshold?: number;
  compression?: {
    strategy: "none" | "tiered_history_checkpoint";
    appliedStrategy: "none" | "tiered_history_checkpoint" | "bounded_history" | "bounded_tool_output" | "mixed" | "strategy_chain";
    trigger: "within_budget" | "warning_threshold" | "compression_threshold" | "hard_budget";
    beforeTokens: number;
    afterTokens: number;
    checkpointTokens: number;
    preservedRecentMessageCount: number;
    compactedHistoryMessageCount: number;
  };
  estimate?: ContextBudgetSnapshot["estimate"];
  providerUsage?: ContextBudgetSnapshot["providerUsage"];
  onLoadArchive?: ContextArchiveLoader;
}) {
  const { language, t } = useI18n();
  const [archiveResults, setArchiveResults] = useState<Readonly<Record<string, ContextArchiveLoadResult>>>({});
  const loadingArchives = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const percentage = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const effectiveCompression = compression?.appliedStrategy === "none" ? undefined : compression;
  const compressionLabel = effectiveCompression === undefined
    ? undefined
    : effectiveCompression.appliedStrategy === "tiered_history_checkpoint"
      ? t("History checkpoint applied")
      : effectiveCompression.appliedStrategy === "bounded_history"
        ? t("Conversation history bounded")
        : effectiveCompression.appliedStrategy === "bounded_tool_output"
          ? t("Tool evidence bounded")
          : effectiveCompression.appliedStrategy === "strategy_chain"
            ? t("Compaction strategy chain applied")
            : t("History and tool evidence bounded");
  return (
    <div className="context-budget">
      <div className="budget-heading">
        <div><span>{t("Input budget")}</span><strong>{used.toLocaleString()} <small>/ {limit.toLocaleString()}</small></strong></div>
        <div><span>{t("Reserved output")}</span><strong>{reservedOutput.toLocaleString()}</strong></div>
      </div>
      <div className="budget-meta"><span className={`context-status status-${status ?? "healthy"}`}>{t(status ?? "healthy")} · {percentage}%</span>{windowLimit !== undefined && <span>{t("Window")} {windowLimit.toLocaleString()}</span>}<span>{estimator === "provider_tokenizer" ? t("Provider tokenizer") : t("Conservative estimate")}</span></div>
      {estimate && <section aria-label={t("Budget estimate")} className="context-token-estimate">
        <header><strong>{t("Budget estimate")}</strong><span>{t(confidenceLabel(estimate.confidence))}</span><code>{estimate.estimatorId}</code></header>
        <div className="context-token-totals">
          <span>{t("Input")} <strong>{estimate.inputTokens.toLocaleString()}</strong></span>
          <span>{t("Estimated output")} <strong>{estimate.outputTokens.toLocaleString()}</strong></span>
          {estimate.cachedTokens !== undefined && <span>{t("Estimated cached input")} <strong>{estimate.cachedTokens.toLocaleString()}</strong></span>}
        </div>
        <div className="context-token-sections">
          {Object.entries(estimate.perSection).map(([section, tokens]) => <span key={section}>{t(titleCase(section))} <code>{tokens.toLocaleString()}</code></span>)}
        </div>
      </section>}
      {providerUsage && <section aria-label={t("Provider reported usage")} className="context-provider-usage">
        <header><strong>{t("Provider reported usage")}</strong><span>{providerUsage.provider} · {providerUsage.model} · {t(providerUsage.requestKind === "repair" ? "Repair request" : providerUsage.requestKind === "summary" ? "Summary request" : "Initial request")} #{providerUsage.requestSequence}</span></header>
        <div className="context-token-totals">
          <span>{t("Input")} <strong>{providerUsage.inputTokens.toLocaleString()}</strong></span>
          <span>{t("Output")} <strong>{providerUsage.outputTokens.toLocaleString()}</strong></span>
          {providerUsage.cachedInputTokens !== undefined && <span>{t("Cached input")} <strong>{providerUsage.cachedInputTokens.toLocaleString()}</strong></span>}
          {providerUsage.reasoningOutputTokens !== undefined && <span>{t("Reasoning output")} <strong>{providerUsage.reasoningOutputTokens.toLocaleString()}</strong></span>}
          <span>{t("Total")} <strong>{providerUsage.totalTokens.toLocaleString()}</strong></span>
        </div>
        <div className="context-usage-cost">{providerUsage.cost.status === "provider_reported"
          ? <span>{t("Reported cost")} <strong>{formatCost(providerUsage.cost.amount, providerUsage.cost.currency, language)}</strong></span>
          : <span>{t("Cost unavailable")}</span>}</div>
        {providerUsage.anomaly && <div className="context-usage-anomaly" role="alert"><strong>{t("Usage anomaly")}</strong><span>{t("Provider input differs from the preflight estimate")}</span></div>}
      </section>}
      <div className="budget-bar" aria-label={`${used} of ${limit} input tokens used`}>
        {sources.filter((source) => source.tokens > 0).map((source) => (
          <span
            key={source.itemId}
            style={{ backgroundColor: source.color, width: `${(source.tokens / limit) * 100}%` }}
            title={`${source.name}: ${source.tokens} tokens`}
          />
        ))}
        <span className="budget-unused" style={{ width: `${Math.max(0, ((limit - used) / limit) * 100)}%` }} />
      </div>
      {(warningThreshold !== undefined || compressionThreshold !== undefined) && <div className="budget-thresholds"><span>{t("Warning")} {warningThreshold?.toLocaleString() ?? "—"}</span><span>{t("Compression")} {compressionThreshold?.toLocaleString() ?? "—"}</span></div>}
      {compressionLabel && effectiveCompression && <div className="context-compression-note"><strong>{compressionLabel}</strong><span>{effectiveCompression.appliedStrategy === "tiered_history_checkpoint" ? `${t("Compacted older turns while retaining recent messages")}: ${effectiveCompression.compactedHistoryMessageCount} → ${effectiveCompression.preservedRecentMessageCount} · ` : ""}{effectiveCompression.beforeTokens.toLocaleString()}→{effectiveCompression.afterTokens.toLocaleString()}</span></div>}
      <div className="budget-legend">
        {sources.filter((source) => source.tokens > 0).map((source) => (
          <span key={source.itemId}><i style={{ backgroundColor: source.color }} />{source.name}</span>
        ))}
      </div>
      <div className="context-table" role="table" aria-label={t("Context sources")}>
        <div className="context-table-row context-table-header" role="row">
          <span>{t("Source")}</span><span>{t("Tokens")}</span><span>{t("Action")}</span><span>{t("Reason")}</span>
        </div>
        {sources.map((source) => {
          const archiveKey = source.archive === undefined ? undefined : `${source.itemId}\u0000${source.archive.artifactId}`;
          const archiveResult = archiveKey === undefined ? undefined : archiveResults[archiveKey];
          const archive = source.archive === undefined
            ? undefined
            : { ...source.archive, ...archiveResult };
          const loadArchive = async (open: boolean) => {
            if (
              !open
              || source.archive === undefined
              || archiveKey === undefined
              || onLoadArchive === undefined
              || source.archive.content !== undefined
              || source.archive.status !== "idle"
              || archiveResults[archiveKey] !== undefined
              || loadingArchives.current.has(archiveKey)
            ) return;
            loadingArchives.current.add(archiveKey);
            await loadContextArchiveOnOpen({
              open,
              artifactId: source.archive.artifactId,
              load: onLoadArchive,
              update: (result) => {
                if (mounted.current) setArchiveResults((current) => ({ ...current, [archiveKey]: result }));
              },
            });
            loadingArchives.current.delete(archiveKey);
          };
          return (
            <div className="context-table-row" data-context-item-id={source.itemId} key={source.itemId} role="row">
              <span><i style={{ backgroundColor: source.color }} />{source.name}</span>
              <code>{source.originalTokens ? `${source.originalTokens.toLocaleString()}→${source.tokens.toLocaleString()}` : source.tokens.toLocaleString()}</code>
              <span className={`context-action action-${source.action}`}>{source.action}</span>
              <span><code>{source.reason}</code>{archive && <details aria-busy={archive.status === "loading"} className="context-archive" onToggle={(event) => { void loadArchive(event.currentTarget.open); }}><summary>{t("View compressed source")}</summary><code>{archive.locator}</code>{archive.content === undefined ? <p>{archive.message}</p> : <pre>{archive.content}</pre>}</details>}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function confidenceLabel(confidence: NonNullable<ContextBudgetSnapshot["estimate"]>["confidence"]): string {
  if (confidence === "calibrated") return "Calibrated estimate";
  if (confidence === "exact") return "Exact tokenizer";
  return "Estimated";
}

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function formatCost(amount: number, currency: string, language: "zh-CN" | "en"): string {
  return `${amount.toLocaleString(language, { maximumFractionDigits: 8 })} ${currency}`;
}
