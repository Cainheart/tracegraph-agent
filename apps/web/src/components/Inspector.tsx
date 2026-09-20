import { useEffect, useMemo, useState } from "react";
import { getInspectorTabs, type EventEvidenceSnapshot, type EvidenceSlot, type InspectorTab, type TraceEvent } from "../model";
import { useI18n } from "../i18n";
import { ContextBudget, type ContextArchiveLoader } from "./ContextBudget";
import { Icon } from "./Icon";
import { IconButton } from "./Primitives";
import { MarkdownContent } from "./MarkdownContent";

const tabLabels: Record<InspectorTab, string> = {
  summary: "Summary",
  io: "I/O",
  context: "Context",
  memory: "Memory",
  changes: "Changes",
  architecture: "Architecture",
  evidence: "Evidence",
  timing: "Timing",
};

function InspectorSummary({ event, scope }: { event: TraceEvent; scope: EventEvidenceSnapshot }) {
  const { language, t } = useI18n();
  return (
    <div className="inspector-section-stack">
      <section className="inspector-block summary-block">
        <span className="eyebrow">{event.kind} · {language === "zh-CN" ? "事件" : "event"} #{event.sequence}</span>
        <h3>{t(event.title)}</h3>
        <MarkdownContent content={t(event.summary)} />
      </section>
      {event.rationale && (
        <section className="inspector-block">
          <h4>{t("Recorded rationale")}</h4>
          <MarkdownContent content={t(event.rationale)} />
        </section>
      )}
      <section className="inspector-block property-list">
        <h4>{t("Event properties")}</h4>
        <div><span>{t("Event ID")}</span><code>{event.id}</code></div>
        <div><span>{t("Sequence")}</span><code>{event.sequence}</code></div>
        <div><span>{t("State")}</span><strong className={`text-${event.state}`}>{t(event.state)}</strong></div>
        <div><span>{t("Committed at")}</span><code>{event.timestamp}</code></div>
        {event.policyDecision && <div><span>{t("Policy result")}</span><strong className={`text-${event.policyDecision.kind === "allow" ? "succeeded" : event.policyDecision.kind === "ask" ? "waiting" : "denied"}`}>{t(event.policyDecision.kind)}</strong></div>}
        {event.policyDecision && <div><span>{t("Decision source")}</span><code>{t(event.policyDecision.source)}</code></div>}
        {event.policyDecision?.matched_rule_id && <div><span>{t("Matched rule")}</span><code>{event.policyDecision.matched_rule_id}</code></div>}
        {event.policyDecision && <div><span>{t("Permission preset")}</span><code>{event.policyDecision.preset_key}</code></div>}
      </section>
      {(scope.patchEventId || scope.graphDeltaId || scope.testReceiptId || scope.contextManifestId) && (
        <section className="inspector-block link-chain">
          <h4>{t("Linked evidence")}</h4>
          {scope.contextManifestId && <div><Icon name="layers" size={14} /><span>{t("Context")}</span><code>{scope.contextManifestId}</code></div>}
          {scope.patchEventId && <div><Icon name="diff" size={14} /><span>{t("Patch")}</span><code>{scope.patchEventId}</code></div>}
          {scope.graphDeltaId && <div><Icon name="graph" size={14} /><span>{t("Graph")}</span><code>{scope.graphDeltaId}</code></div>}
          {scope.testReceiptId && <div><Icon name="check" size={14} /><span>{t("Test")}</span><code>{scope.testReceiptId}</code></div>}
        </section>
      )}
    </div>
  );
}

function ArtifactState({ slot }: { slot: EvidenceSlot }) {
  const { t } = useI18n();
  return (
    <div className={`artifact-state artifact-${slot.status}`}>
      <Icon name={slot.status === "available" || slot.status === "demo" ? "check" : slot.status === "loading" ? "refresh" : "alert"} size={14} />
      <div><strong>{t(slot.status.replace("_", " "))}</strong><span>{t(slot.message)}</span>{slot.artifactId && <code>{slot.artifactId}</code>}</div>
    </div>
  );
}

export function Inspector({
  event,
  scope,
  drawer = false,
  onClose,
  onLoadContextArchive,
}: {
  event: TraceEvent | null;
  scope: EventEvidenceSnapshot;
  drawer?: boolean;
  onClose?: () => void;
  onLoadContextArchive?: ContextArchiveLoader;
}) {
  const { language, t } = useI18n();
  const tabs = useMemo(() => getInspectorTabs(event, scope), [event, scope]);
  const [activeTab, setActiveTab] = useState<InspectorTab>("summary");

  useEffect(() => {
    if (!tabs.includes(activeTab)) setActiveTab(tabs[0] ?? "summary");
  }, [activeTab, tabs]);

  return (
    <aside className={`inspector ${drawer ? "inspector-drawer" : ""}`} aria-label={t("Event inspector")}>
      <header className="inspector-header">
        <div><span className="eyebrow">{t("Selected event")}</span><strong>{t("Inspector")}</strong></div>
        <div className="inspector-header-actions">
          <IconButton icon="more" label={t("Inspector options")} />
          {onClose && <IconButton icon="close" label={t("Close inspector")} onClick={onClose} />}
        </div>
      </header>
      {!event ? (
        <div className="inspector-empty">
          <span><Icon name="route" size={22} /></span>
          <h3>{t("Select a trajectory event")}</h3>
          <p>{t("Its recorded input, context, changes, and verification evidence will appear here.")}</p>
        </div>
      ) : (
        <>
          <nav className="inspector-tabs" aria-label={t("Inspector views")}>
            {tabs.map((tab) => (
              <button
                aria-current={activeTab === tab ? "page" : undefined}
                className={activeTab === tab ? "active" : ""}
                key={tab}
                onClick={() => setActiveTab(tab)}
                type="button"
              >
                {t(tabLabels[tab])}
              </button>
            ))}
          </nav>
          <div className="inspector-content">
            {activeTab === "summary" && <InspectorSummary event={event} scope={scope} />}
            {activeTab === "io" && (
              <div className="inspector-section-stack">
                <section className="inspector-block code-block"><h4>{t("Validated input")}</h4><pre>{event.input ?? t("No durable input was recorded.")}</pre></section>
                <section className="inspector-block code-block"><h4>{t("Bounded output")}</h4><pre>{event.output ?? t("Output stored as an artifact reference.")}</pre></section>
              </div>
            )}
            {activeTab === "context" && (
              <div className="inspector-section-stack">
                <ArtifactState slot={scope.evidence.context} />
                {scope.inputTokens !== undefined && scope.tokenLimit !== undefined && scope.reservedOutput !== undefined && (
                  <ContextBudget
                    sources={scope.contextSources}
                    used={scope.contextBudget?.usedTokens ?? scope.inputTokens}
                    limit={scope.contextBudget?.inputBudgetTokens ?? scope.tokenLimit - scope.reservedOutput}
                    reservedOutput={scope.contextBudget?.reservedOutputTokens ?? scope.reservedOutput}
                    {...(onLoadContextArchive === undefined ? {} : { onLoadArchive: onLoadContextArchive })}
                    {...(scope.contextBudget === undefined ? {} : {
                      windowLimit: scope.contextBudget.windowTokens,
                      status: scope.contextBudget.status,
                      estimator: scope.contextBudget.estimator,
                      warningThreshold: scope.contextBudget.warningThresholdTokens,
                      compressionThreshold: scope.contextBudget.compressionThresholdTokens,
                      compression: scope.contextBudget.compression,
                      estimate: scope.contextBudget.estimate,
                      providerUsage: scope.contextBudget.providerUsage,
                    })}
                  />
                )}
              </div>
            )}
            {activeTab === "changes" && (
              <div className="inspector-section-stack">
                <ArtifactState slot={scope.evidence.diff} />
                <section className="inspector-block property-list"><div><span>{t("Patch relation")}</span><code>{scope.patchEventId ?? t("unavailable")}</code></div><div><span>{t("Artifact status")}</span><strong>{scope.evidence.diff.status}</strong></div></section>
              </div>
            )}
            {activeTab === "architecture" && (
              <div className="inspector-section-stack">
                <ArtifactState slot={scope.evidence.graph} />
                <section className="inspector-block"><h4>{t("Graph relation")}</h4><p>{scope.graphDeltaId ? (language === "zh-CN" ? `关联差异：${scope.graphDeltaId}` : `Linked delta: ${scope.graphDeltaId}`) : t("No graph_delta_id was resolved for this event.")}</p></section>
              </div>
            )}
            {activeTab === "evidence" && (
              <div className="inspector-section-stack evidence-list">
                {(event.evidenceRefs ?? []).map((ref) => <button key={ref} type="button"><Icon name="external" size={13} /><code>{ref}</code></button>)}
                {scope.testReceiptId && <div className="test-receipt"><span><Icon name={scope.evidence.test.status === "available" || scope.evidence.test.status === "demo" ? "check" : "alert"} size={15} /></span><div><strong>{t("Test receipt recorded")}</strong><code>{scope.testReceiptId} · artifact {scope.evidence.test.status}</code></div></div>}
              </div>
            )}
            {activeTab === "timing" && (
              <section className="inspector-block property-list"><h4>{t("Timing")}</h4><div><span>{t("Started")}</span><code>{event.timestamp}</code></div><div><span>{t("Duration")}</span><strong>{event.duration ?? t("In flight")}</strong></div><div><span>{t("Attempts")}</span><strong>1</strong></div></section>
            )}
            {activeTab === "memory" && <section className="inspector-block"><h4>{t("Memory fixture")}</h4><p>{t("Memory retrieval evidence is shown here when linked to this event.")}</p></section>}
          </div>
        </>
      )}
    </aside>
  );
}
