import { useEffect, useState } from "react";
import type {
  ExperienceControlListResponse,
  ExperienceLifecycleAction,
  ExperienceLifecycleReviewResponse,
} from "@tracegraph/contracts";
import { Icon } from "./Icon";
import { useI18n } from "../i18n";

export function ExperienceControlSection({
  onList,
  onReview,
  writable = true, online = true,
}: {
  writable?: boolean; online?: boolean;
  onList: () => Promise<ExperienceControlListResponse>;
  onReview: (caseId: string, input: { expected_sequence: number; action: ExperienceLifecycleAction }) => Promise<ExperienceLifecycleReviewResponse>;
}) {
  const { t: title } = useI18n();
  const [items, setItems] = useState<ExperienceControlListResponse["items"]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true); setError(null);
    if (!online) { setLoading(false); return; }
    try {
      setItems((await onList()).items); setLoaded(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, [online]);

  const review = async (caseId: string, expectedSequence: number, action: ExperienceLifecycleAction) => {
    setBusy(caseId);
    setError(null);
    try {
      await onReview(caseId, { expected_sequence: expectedSequence, action });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const statusLabel = (status: string) => ({
    candidate: title("Candidate"),
    validated: title("Validated"),
    disputed: title("Disputed"),
    retired: title("Retired"),
  }[status] ?? status);

  return (
    <section className="experience-control-section" aria-label={title("Experience controls")}>
      <div className="memory-list-heading">
        <div><span className="eyebrow">{title("Evidence-backed experience cases")}</span><h3>{title("Experience cases")}</h3></div>
        <button className="button subtle" disabled={loading || busy !== null} onClick={() => void refresh()} type="button"><Icon name="refresh" size={13} />{title("Refresh")}</button>
      </div>
      {error && <div className="memory-control-error" role="alert">{error}</div>}
      {loading ? <p className="memory-empty">{title("Loading…")}</p> : !loaded ? <p className="memory-empty">{title(online ? "Your experience records could not be loaded. Try again." : "Reconnect to load your experience records.")}</p> : items.length === 0 ? (
        <div className="memory-empty">{title("No Experience cases are available for the current project.")}</div>
      ) : items.map(({ case: experience, lifecycleSequence }) => {
        const isBusy = busy === experience.caseId;
        const apply = (action: ExperienceLifecycleAction) => void review(experience.caseId, lifecycleSequence, action);
        return <article className="memory-record-card experience-record-card" key={experience.caseId}>
          <header>
            <span className={`memory-status memory-status-${experience.status}`}>{statusLabel(experience.status)}</span>
            <code>{experience.outcome.kind} · v{experience.version} · seq {lifecycleSequence}</code>
          </header>
          <h4>{experience.title}</h4>
          <p className="memory-record-claim">{experience.objective}</p>
          <div className="memory-record-meta">
            <span>{title("Project")}: <code>{experience.projectId}</code></span>
            <span>{title("Source Episode")}: <code>{experience.episodeId}</code></span>
            <span>{title("Outcome")}: {experience.outcome.summary}</span>
            {experience.confidence !== undefined && <span>{title("Extraction confidence")}: {Math.round(experience.confidence * 100)}%</span>}
          </div>
          <details className="experience-inspection">
            <summary>{title("Inspect conditions, actions, and evidence")}</summary>
            <div className="experience-inspection-body">
              <strong>{title("Situation")}</strong>
              <ul>{experience.situation.conditions.map((condition, index) => <li key={`${condition.dimension}:${index}`}>{condition.dimension} {condition.operator} {condition.value}</li>)}</ul>
              <strong>{title("Applicability")}</strong>
              <ul>{experience.applicability.map((rule, index) => <li key={`${rule.dimension}:${index}`}>{rule.dimension} {rule.operator} {rule.value}</li>)}</ul>
              {experience.actions.map((action, index) => <section key={`${action.intent}:${index}`}>
                <strong>{title("Action intent")}: {action.intent}</strong>
                <ol>{action.steps.map((step, stepIndex) => <li key={`${stepIndex}:${step.text}`}>{step.text}</li>)}</ol>
              </section>)}
              {experience.verification.length > 0 && <section><strong>{title("Verification")}</strong><ul>{experience.verification.map((item, index) => <li key={`${item.kind}:${index}`}>{item.kind}: {item.summary}</li>)}</ul></section>}
              {experience.counterexamples.length > 0 && <section><strong>{title("Counterexamples")}</strong><ul>{experience.counterexamples.map((item, index) => <li key={`${item.condition}:${index}`}>{item.condition} — {item.reason}</li>)}</ul></section>}
              <strong>{title("Evidence references")}</strong>
              <ul>{experience.evidenceRefs.map((ref) => <li key={ref.eventId}><code>{ref.eventType}</code> · <code>{ref.runId}</code> #{ref.sequence}</li>)}</ul>
            </div>
          </details>
          <div className="memory-record-actions">{experienceActionsForStatus(experience.status).map((action) => <button
            className={action === "validate" || action === "resolve" ? "button primary" : "button subtle"}
            disabled={isBusy || !writable}
            key={action}
            onClick={() => apply(action)}
            type="button"
          >{actionLabel(action, title)}</button>)}</div>
          <p className="memory-control-note">{title("Only explicitly validated cases are eligible for Experience recall. This control does not enable recall.")}</p>
        </article>;
      })}
    </section>
  );
}

type ExperienceStatus = ExperienceControlListResponse["items"][number]["case"]["status"];
const EXPERIENCE_ACTIONS_BY_STATUS: Readonly<Record<ExperienceStatus, readonly ExperienceLifecycleAction[]>> = {
  candidate: ["validate", "reject"],
  validated: ["dispute", "retire"],
  disputed: ["resolve", "retire"],
  retired: [],
};

export function experienceActionsForStatus(status: ExperienceStatus): readonly ExperienceLifecycleAction[] {
  return EXPERIENCE_ACTIONS_BY_STATUS[status];
}

function actionLabel(action: ExperienceLifecycleAction, title: (key: string) => string): string {
  return {
    validate: title("Validate"),
    reject: title("Reject"),
    dispute: title("Dispute"),
    resolve: title("Resolve"),
    retire: title("Retire"),
  }[action];
}
