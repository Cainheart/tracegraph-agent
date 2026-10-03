import type { TaskBoardItem, TeamProjection } from "@tracegraph/contracts";
import { useState } from "react";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";

export function TeamPanel({
  team,
  disabled = false,
  disabledReason,
  busyKey,
  error,
  onCreate,
  onSteer,
  onCancelTask,
}: {
  team?: TeamProjection;
  disabled?: boolean;
  disabledReason?: string | null;
  busyKey?: string | null;
  error?: string | null;
  onCreate: () => void;
  onSteer: (subagentId: string, payload: string) => Promise<boolean>;
  onCancelTask: (task: TaskBoardItem) => void;
}) {
  const { t } = useI18n();
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});

  if (team === undefined) {
    return <section aria-label={t("Agent team")} className="team-panel team-panel-empty">
      <header className="team-panel-heading">
        <div><span className="eyebrow">G08</span><h3>{t("Agent team")}</h3></div>
      </header>
      <p>{t("No durable Team has been created for this Run.")}</p>
      {error && <p className="team-error" role="alert"><Icon name="alert" size={12} />{error}</p>}
      {!error && disabledReason && <p className="team-disabled-note" role="status"><Icon name="shield" size={12} />{disabledReason}</p>}
      <button className="button secondary" disabled={disabled || busyKey === "create"} onClick={onCreate} type="button">
        <Icon name="route" size={13} />{t(busyKey === "create" ? "Creating team…" : "Create team")}
      </button>
    </section>;
  }

  const ownerCounts = new Map<string, number>();
  for (const task of team.task_board.items) {
    if (task.owner !== undefined && task.state !== "done" && task.state !== "cancelled") {
      ownerCounts.set(task.owner, (ownerCounts.get(task.owner) ?? 0) + 1);
    }
  }

  return <section aria-label={t("Agent team")} className="team-panel">
    <header className="team-panel-heading">
      <div><span className="eyebrow">G08 · {t("Durable coordination")}</span><h3>{t("Agent team")}</h3></div>
      <span className="team-count">{team.roster.members.length}</span>
    </header>
    {error && <p className="team-error" role="alert"><Icon name="alert" size={12} />{error}</p>}
    {!error && disabledReason && <p className="team-disabled-note" role="status"><Icon name="shield" size={12} />{disabledReason}</p>}

    <div className="team-sections">
      <section aria-label={t("Team roster")} className="team-section">
        <h4>{t("Roster")}</h4>
        {team.roster.members.length === 0 ? <p className="team-empty">{t("No workers have joined this Team.")}</p> : (
          <ul className="team-roster">
            {team.roster.members.map((member) => {
              const id = member.link.subagent_id;
              const draft = drafts[id] ?? "";
              return <li className={`team-member status-${member.status}`} key={id}>
                <div className="team-member-line">
                  <span><strong>{member.role}</strong><code>{id}</code></span>
                  <span className={`team-status team-status-${member.status}`}>{t(member.status)}</span>
                </div>
                <small>{t("Last heartbeat")}: {formatDate(member.last_heartbeat_at)} · {ownerCounts.get(id) ?? 0} {t("active tasks")}</small>
                <div className="team-steer">
                  <input
                    aria-label={`${t("Steer worker")}: ${member.role}`}
                    disabled={disabled || member.status !== "active" || busyKey === `member:${id}`}
                    onChange={(event) => setDrafts((current) => ({ ...current, [id]: event.target.value }))}
                    placeholder={t("Send a durable steer message…")}
                    value={draft}
                  />
                  <button
                    aria-label={`${t("Send steer")}: ${member.role}`}
                    className="button secondary"
                    disabled={disabled || member.status !== "active" || busyKey === `member:${id}` || draft.trim().length === 0}
                    onClick={async () => {
                      const payload = draft.trim();
                      if (payload.length === 0) return;
                      if (!await didSteerSucceed(() => onSteer(id, payload))) return;
                      setDrafts((current) => {
                        const currentDraft = current[id] ?? "";
                        const nextDraft = steerDraftAfterDelivery(currentDraft, payload, true);
                        return nextDraft === currentDraft ? current : { ...current, [id]: nextDraft };
                      });
                    }}
                    type="button"
                  ><Icon name="send" size={12} />{t("Steer")}</button>
                </div>
              </li>;
            })}
          </ul>
        )}
      </section>

      <section aria-label={t("Team task board")} className="team-section">
        <h4>{t("Shared task board")}</h4>
        {team.task_board.items.length === 0 ? <p className="team-empty">{t("No shared Team tasks have been recorded.")}</p> : (
          <ol className="team-tasks">
            {team.task_board.items.map((task) => <li className={`team-task state-${task.state}`} key={task.task_id}>
              <div className="team-task-line">
                <strong>{task.title}</strong>
                <span>{t(task.state)} · v{task.version}</span>
              </div>
              {task.detail && <p>{task.detail}</p>}
              <small>{task.owner === undefined ? t("Unassigned") : `${t("Owner")}: ${task.owner}`}</small>
              <ul className="team-acceptance">{task.acceptance.map((item) => <li key={item}>{item}</li>)}</ul>
              {task.evidence_event_ids.length > 0 && <div className="team-evidence">{t("Evidence")}: {task.evidence_event_ids.map((id) => <code key={id}>{id}</code>)}</div>}
              {(task.state === "open" || task.state === "claimed" || task.state === "blocked") && <button
                className="button danger"
                disabled={disabled || busyKey === `task:${task.task_id}`}
                onClick={() => onCancelTask(task)}
                type="button"
              >{t("Cancel task")}</button>}
            </li>)}
          </ol>
        )}
      </section>

      <section aria-label={t("Team mailbox")} className="team-section team-mailbox-section">
        <h4>{t("Mailbox")}</h4>
        {team.mailbox.messages.length === 0 ? <p className="team-empty">{t("No Team messages have been delivered.")}</p> : (
          <ol className="team-mailbox">
            {[...team.mailbox.messages].slice(-100).reverse().map((message) => <li key={message.message_id}>
              <div><code>{message.from}</code><span aria-hidden="true">→</span><code>{message.to}</code><span className="team-message-kind">{t(message.kind)}</span></div>
              <p>{message.payload}</p>
              <small>{formatDate(message.delivered_at)} · {message.claimed_at === undefined ? t("Unclaimed") : `${t("Claimed")} ${formatDate(message.claimed_at)}`}</small>
            </li>)}
          </ol>
        )}
      </section>
    </div>
  </section>;
}

/** A rejected or explicitly failed request is an unknown/failed delivery, so the draft stays retryable. */
export async function didSteerSucceed(action: () => Promise<boolean>): Promise<boolean> {
  try {
    return await action();
  } catch {
    return false;
  }
}

/** Do not erase a failed request or newer text typed while the confirmed request was in flight. */
export function steerDraftAfterDelivery(
  currentDraft: string,
  submittedPayload: string,
  succeeded: boolean,
): string {
  return succeeded && currentDraft.trim() === submittedPayload ? "" : currentDraft;
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString();
}
