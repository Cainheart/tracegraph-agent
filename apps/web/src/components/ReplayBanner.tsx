import { adjacentReplaySequence, type ReplayViewState } from "../model";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";

function shortHash(value: string | undefined): string {
  if (!value) return "pending";
  const body = value.startsWith("sha256:") ? value.slice(7) : value;
  return `sha256:${body.slice(0, 12)}…`;
}

export function ReplayBanner({
  replay,
  error,
  onStep,
  onReturnToLive,
}: {
  replay: ReplayViewState;
  error?: string | null;
  onStep: (direction: -1 | 1) => void;
  onReturnToLive: () => void;
}) {
  const { t } = useI18n();
  const previous = adjacentReplaySequence(replay.availableSequences, replay.requestedSequence, -1);
  const next = adjacentReplaySequence(replay.availableSequences, replay.requestedSequence, 1);
  const busy = replay.state !== "active";
  const diff = replay.diff;

  return (
    <section
      aria-keyshortcuts="ArrowLeft ArrowRight"
      aria-label={t("Replay mode")}
      className={`replay-banner replay-${replay.state}`}
      role="region"
    >
      <span className="replay-banner-icon"><Icon name={busy ? "refresh" : "clock"} size={18} /></span>
      <div className="replay-banner-copy">
        <div aria-live="polite">
          <strong>{t(replay.state === "restoring" ? "Returning to now" : "Replay mode")}</strong>
          <code>#{replay.requestedSequence} / #{replay.headSequence}</code>
          <code>{shortHash(replay.projectionHash)}</code>
        </div>
        <span>{t("This is a read-only durable snapshot. The Agent may continue running on the Host while live updates are paused.")}</span>
        {error && <em role="alert">{error}</em>}
        {diff && (
          <details className="replay-diff-summary">
            <summary>{t("Step changes")} · #{diff.fromSequence} → #{diff.toSequence}</summary>
            <div>
              <span>+{diff.addedEvents.length} {t("events")}</span>
              <span>−{diff.removedEvents.length} {t("events")}</span>
              <span>{diff.toolResults.length} {t("tool results")}</span>
              <span>{diff.todoChanges.length} {t("Todo changes")}</span>
              <span>{diff.addedEvidenceCount} {t("evidence added")}</span>
              {diff.statusBefore !== diff.statusAfter && <span>{diff.statusBefore} → {diff.statusAfter}</span>}
              {diff.approvalChanged && <span>{t("approval changed")}</span>}
            </div>
            {diff.todoChanges.map((change) => (
              <p key={`${change.kind}:${change.todoId}`}>
                <strong>{change.kind}</strong> {change.title}
                {change.beforeState !== change.afterState && <code>{change.beforeState ?? "—"} → {change.afterState ?? "—"}</code>}
              </p>
            ))}
            {diff.addedEvents.map((event) => (
              <p key={`added:${event.id}`}><strong>+</strong> #{event.sequence} {t(event.title)} · {t(event.summary)}</p>
            ))}
            {diff.removedEvents.map((event) => (
              <p key={`removed:${event.id}`}><strong>−</strong> #{event.sequence} {t(event.title)} · {t(event.summary)}</p>
            ))}
            {diff.toolResults.map((result) => (
              <p key={`${result.kind}:${result.eventId}`}><strong>{result.kind === "added" ? "+" : "−"} {result.toolName ?? result.type}</strong> {result.summary}</p>
            ))}
          </details>
        )}
      </div>
      <div className="replay-banner-actions">
        <button
          aria-label={t("Previous replay event")}
          className="button subtle"
          disabled={busy || previous === null}
          onClick={() => onStep(-1)}
          type="button"
        ><Icon name="arrow-left" size={13} />{t("Previous")}</button>
        <button
          aria-label={t("Next replay event")}
          className="button subtle replay-next"
          disabled={busy || next === null}
          onClick={() => onStep(1)}
          type="button"
        >{t("Next")}<Icon name="arrow-left" size={13} /></button>
        <button className="button primary" disabled={replay.state === "restoring"} onClick={onReturnToLive} type="button">
          <Icon name="refresh" size={13} />{t("Return to now")}
        </button>
      </div>
    </section>
  );
}
