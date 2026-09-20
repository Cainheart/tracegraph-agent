import type { TaskBoardItem, TeamProjection, TodoItem, TodoState } from "@tracegraph/contracts";
import { useEffect, useRef, useState } from "react";
import type { AttachmentPreviewContent, AttachmentSnapshot, SubagentSnapshot, TraceEvent } from "../model";
import { useI18n } from "../i18n";
import { Icon, type IconName } from "./Icon";
import { SandboxBadge } from "./SandboxBadge";
import { TodoPanel } from "./TodoPanel";
import { TeamPanel } from "./TeamPanel";

const eventIcons: Record<TraceEvent["kind"], IconName> = {
  query: "message",
  context: "layers",
  decision: "route",
  tool: "terminal",
  approval: "shield",
  patch: "diff",
  graph: "graph",
  test: "check",
  permission: "shield",
  sandbox: "shield",
  todo: "check",
  subagent: "route",
  team: "route",
  attachment: "file",
  run: "flag",
};

function StateGlyph({ event }: { event: TraceEvent }) {
  const { t } = useI18n();
  if (event.state === "running") return <span className="event-spinner" aria-label={t("Running event")} />;
  if (event.state === "waiting") return <span className="event-waiting" aria-label={t("Waiting")}><Icon name="clock" size={12} /></span>;
  if (event.state === "failed") return <span className="event-failed" aria-label={t("Failed")}><Icon name="x" size={12} /></span>;
  if (event.state === "denied") return <span className="event-denied" aria-label={t("Denied")}><Icon name="close" size={12} /></span>;
  return <span className="event-succeeded" aria-label={t("Succeeded")}><Icon name="check" size={12} /></span>;
}

function SubagentPanel({
  disabled,
  onLoad,
  subagents,
}: {
  disabled: boolean;
  onLoad: (subagentId: string) => void;
  subagents: readonly SubagentSnapshot[];
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (disabled) return;
    for (const subagent of subagents) {
      if (expanded.has(subagent.id) && subagent.detail.state === "idle") {
        onLoad(subagent.id);
      }
    }
  }, [disabled, expanded, onLoad, subagents]);
  if (subagents.length === 0) return null;

  const toggle = (subagent: SubagentSnapshot) => {
    const opening = !expanded.has(subagent.id);
    setExpanded((current) => {
      const next = new Set(current);
      if (opening) next.add(subagent.id);
      else next.delete(subagent.id);
      return next;
    });
    if (
      opening
      && !disabled
      && (
        subagent.detail.state === "error"
        || (subagent.status === "running" && subagent.detail.state === "available")
      )
    ) onLoad(subagent.id);
  };

  return (
    <section className="subagent-panel" aria-label={t("Delegated subagents")}>
      <div className="subagent-panel-heading">
        <div>
          <span className="eyebrow">{t("Read-only child ledgers")}</span>
          <h3>{t("Delegated subagents")}</h3>
        </div>
        <span className="subagent-count">{subagents.length}</span>
      </div>
      <div className="subagent-list">
        {subagents.map((subagent) => {
          const isExpanded = expanded.has(subagent.id);
          return (
            <article className={`subagent-card status-${subagent.status}`} key={subagent.id}>
              <button
                aria-expanded={isExpanded}
                className="subagent-card-toggle"
                onClick={() => toggle(subagent)}
                type="button"
              >
                <span className="subagent-card-icon"><Icon name="route" size={15} /></span>
                <span className="subagent-card-copy">
                  <span className="subagent-title-line">
                    <strong>{subagent.name}</strong>
                    <span className={`subagent-status subagent-status-${subagent.status}`}>{t(subagent.status)}</span>
                  </span>
                  <small>{t("depth")} {subagent.depth} · {subagent.messageCount} {t("messages")} · {subagent.contextScope}</small>
                </span>
                <Icon name="chevron" size={14} />
              </button>
              {isExpanded && (
                <div className="subagent-detail">
                  {disabled && <p role="status">{t("Child Run details are unavailable in replay.")}</p>}
                  {!disabled && subagent.detail.state === "idle" && <p>{t("Load the canonical child Run ledger on demand.")}</p>}
                  {!disabled && subagent.detail.state === "loading" && <p role="status">{t("Loading child Run ledger…")}</p>}
                  {!disabled && subagent.detail.state === "error" && <p className="subagent-error" role="alert">{subagent.detail.message}</p>}
                  {!disabled && subagent.detail.state === "available" && (
                    <div className="subagent-ledger">
                      <div className="subagent-ledger-meta">
                        <code>{subagent.detail.run.id}</code>
                        <span>{t(subagent.detail.run.status)}</span>
                        <span>#{subagent.detail.run.lastSequence}</span>
                      </div>
                      <p>{subagent.detail.run.task}</p>
                      <ol>
                        {subagent.detail.run.events.map((event) => (
                          <li key={event.id}>
                            <code>#{event.sequence}</code>
                            <span><strong>{t(event.title)}</strong><small>{t(event.summary)}</small></span>
                          </li>
                        ))}
                      </ol>
                      {subagent.detail.run.events.length === 0 && <p>{t("No child Run events were recorded.")}</p>}
                    </div>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

type AttachmentPreviewState =
  | { readonly state: "idle" | "loading" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "available"; readonly objectUrl: string; readonly mediaType: AttachmentPreviewContent["mediaType"] };

function AttachmentPanel({
  attachments,
  disabled,
  onLoad,
}: {
  attachments: readonly AttachmentSnapshot[];
  disabled: boolean;
  onLoad: (attachmentId: string) => Promise<AttachmentPreviewContent>;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [previews, setPreviews] = useState<ReadonlyMap<string, AttachmentPreviewState>>(() => new Map());
  const objectUrls = useRef(new Map<string, string>());
  const mounted = useRef(true);
  const visibleAttachmentIds = useRef(new Set(attachments.map(({ id }) => id)));
  const previewsDisabled = useRef(disabled);

  useEffect(() => () => {
    mounted.current = false;
    for (const url of objectUrls.current.values()) URL.revokeObjectURL(url);
    objectUrls.current.clear();
  }, []);
  useEffect(() => {
    const visible = new Set(attachments.map(({ id }) => id));
    visibleAttachmentIds.current = visible;
    for (const [id, url] of objectUrls.current) {
      if (visible.has(id)) continue;
      URL.revokeObjectURL(url);
      objectUrls.current.delete(id);
    }
  }, [attachments]);
  useEffect(() => {
    previewsDisabled.current = disabled;
    if (!disabled) return;
    for (const url of objectUrls.current.values()) URL.revokeObjectURL(url);
    objectUrls.current.clear();
    setPreviews(new Map());
  }, [disabled]);

  if (attachments.length === 0) return null;

  const load = async (attachment: AttachmentSnapshot) => {
    if (disabled || attachment.status === "rejected") return;
    const current = previews.get(attachment.id);
    if (current?.state === "loading" || current?.state === "available") return;
    setPreviews((items) => new Map(items).set(attachment.id, { state: "loading" }));
    try {
      const content = await onLoad(attachment.id);
      if (
        !mounted.current
        || previewsDisabled.current
        || !visibleAttachmentIds.current.has(attachment.id)
      ) return;
      const blob = new Blob([Uint8Array.from(content.bytes).buffer], { type: content.mediaType });
      const objectUrl = URL.createObjectURL(blob);
      const prior = objectUrls.current.get(attachment.id);
      if (prior !== undefined) URL.revokeObjectURL(prior);
      objectUrls.current.set(attachment.id, objectUrl);
      setPreviews((items) => new Map(items).set(attachment.id, {
        state: "available",
        objectUrl,
        mediaType: content.mediaType,
      }));
    } catch (error) {
      if (!mounted.current || !visibleAttachmentIds.current.has(attachment.id)) return;
      setPreviews((items) => new Map(items).set(attachment.id, {
        state: "error",
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  const toggle = (attachment: AttachmentSnapshot) => {
    const opening = !expanded.has(attachment.id);
    setExpanded((current) => {
      const next = new Set(current);
      if (opening) next.add(attachment.id);
      else next.delete(attachment.id);
      return next;
    });
    if (opening) void load(attachment);
  };

  return <section aria-label={t("Run attachments")} className="attachment-panel">
    <div className="subagent-panel-heading"><div><span className="eyebrow">{t("Verified binary inputs")}</span><h3>{t("Run attachments")}</h3></div><span className="subagent-count">{attachments.length}</span></div>
    <div className="attachment-card-list">{attachments.map((attachment) => {
      const isExpanded = expanded.has(attachment.id);
      const preview = previews.get(attachment.id) ?? { state: "idle" as const };
      return <article className={`attachment-card status-${attachment.status}`} key={attachment.id}>
        <button aria-expanded={isExpanded} className="attachment-card-toggle" onClick={() => toggle(attachment)} type="button">
          <span className="subagent-card-icon"><Icon name="file" size={15} /></span>
          <span><strong>{attachment.mediaType ?? t("Rejected attachment")}</strong><small>{formatAttachmentBytes(attachment.bytes)} · {t(attachment.status)} · {t(attachment.delivery)}</small></span>
          <Icon name="chevron" size={14} />
        </button>
        {isExpanded && <div className="attachment-preview">
          <code>{attachment.id}</code>
          {attachment.status === "rejected" && <p className="attachment-preview-error" role="alert">{attachment.rejectionCode}: {attachment.reason}</p>}
          {attachment.status !== "rejected" && disabled && <p role="status">{t("Attachment previews are unavailable in replay.")}</p>}
          {attachment.status !== "rejected" && !disabled && preview.state === "loading" && <p role="status">{t("Loading verified attachment…")}</p>}
          {attachment.status !== "rejected" && !disabled && preview.state === "error" && <p className="attachment-preview-error" role="alert">{preview.message}</p>}
          {attachment.status !== "rejected" && !disabled && preview.state === "available" && <VerifiedAttachmentPreview mediaType={preview.mediaType} objectUrl={preview.objectUrl} />}
          {attachment.pdfExtraction?.status === "extracted" && <p>{t("PDF text extracted")} · {attachment.pdfExtraction.characters.toLocaleString()} {t("characters")}</p>}
          {attachment.pdfExtraction?.status === "failed" && <p className="attachment-preview-error">{t("PDF text extraction failed; the original remains available by reference.")} {attachment.pdfExtraction.reason}</p>}
        </div>}
      </article>;
    })}</div>
  </section>;
}

/** Keep untrusted documents out of browser document/embed contexts. */
export function VerifiedAttachmentPreview({
  mediaType,
  objectUrl,
}: {
  mediaType: AttachmentPreviewContent["mediaType"];
  objectUrl: string;
}) {
  const { t } = useI18n();
  if (mediaType.startsWith("image/")) {
    return <img alt={t("Verified attachment preview")} src={objectUrl} />;
  }
  return <div className="pdf-download">
    <Icon name="shield" size={14} />
    <span>{t("PDF is not embedded because uploaded documents are untrusted.")}</span>
    <a download="tracegraph-attachment.pdf" href={objectUrl}>{t("Download verified PDF")}</a>
  </div>;
}

function formatAttachmentBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(0, Math.ceil(bytes / 1024))} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function Trajectory({
  events,
  selectedId,
  tailFollowing,
  onSelect,
  onResumeLive,
  todos = [],
  busyTodoId = null,
  todoUpdatesDisabled = false,
  todoUpdatesDisabledReason = null,
  todoError = null,
  onTodoStateChange = () => undefined,
  team,
  teamBusyKey = null,
  teamControlsDisabled = false,
  teamControlsDisabledReason = null,
  teamError = null,
  onCreateTeam = () => undefined,
  onSteerTeamMember = async () => false,
  onCancelTeamTask = () => undefined,
  subagents = [],
  onLoadSubagent = () => undefined,
  subagentDetailsDisabled = false,
  attachments = [],
  onLoadAttachment = async () => { throw new Error("Attachment preview is unavailable"); },
  attachmentPreviewsDisabled = false,
  replaySequence,
}: {
  events: readonly TraceEvent[];
  selectedId: string | null;
  tailFollowing: boolean;
  onSelect: (event: TraceEvent) => void;
  onResumeLive: () => void;
  todos?: readonly TodoItem[];
  busyTodoId?: string | null;
  todoUpdatesDisabled?: boolean;
  todoUpdatesDisabledReason?: string | null;
  todoError?: string | null;
  onTodoStateChange?: (todo: TodoItem, state: TodoState) => void;
  team?: TeamProjection;
  teamBusyKey?: string | null;
  teamControlsDisabled?: boolean;
  teamControlsDisabledReason?: string | null;
  teamError?: string | null;
  onCreateTeam?: () => void;
  onSteerTeamMember?: (subagentId: string, payload: string) => Promise<boolean>;
  onCancelTeamTask?: (task: TaskBoardItem) => void;
  subagents?: readonly SubagentSnapshot[];
  onLoadSubagent?: (subagentId: string) => void;
  subagentDetailsDisabled?: boolean;
  attachments?: readonly AttachmentSnapshot[];
  onLoadAttachment?: (attachmentId: string) => Promise<AttachmentPreviewContent>;
  attachmentPreviewsDisabled?: boolean;
  replaySequence?: number;
}) {
  const { t } = useI18n();
  return (
    <section className="trajectory" aria-label={t("Run trajectory")}>
      <TodoPanel
        busyTodoId={busyTodoId}
        disabled={todoUpdatesDisabled}
        disabledReason={todoUpdatesDisabledReason}
        error={todoError}
        onSelectEvidence={(eventId) => {
          const event = events.find(({ id }) => id === eventId);
          if (event) onSelect(event);
        }}
        onStateChange={onTodoStateChange}
        todos={todos}
      />
      <TeamPanel
        busyKey={teamBusyKey}
        disabled={teamControlsDisabled}
        disabledReason={teamControlsDisabledReason}
        error={teamError}
        onCancelTask={onCancelTeamTask}
        onCreate={onCreateTeam}
        onSteer={onSteerTeamMember}
        {...(team === undefined ? {} : { team })}
      />
      <SubagentPanel
        disabled={subagentDetailsDisabled}
        onLoad={onLoadSubagent}
        subagents={subagents}
      />
      <AttachmentPanel
        attachments={attachments}
        disabled={attachmentPreviewsDisabled}
        onLoad={onLoadAttachment}
      />
      <div className="trajectory-heading">
        <div>
          <span className="eyebrow">{t(replaySequence === undefined ? "Live execution" : "Replay mode")}</span>
          <h2>{t("Run trajectory")}</h2>
        </div>
        <div className="trajectory-legend"><span className="online-dot" /> {t("Canonical events")}</div>
      </div>

      {!tailFollowing && (
        <button className="resume-live" onClick={onResumeLive} type="button">
          <Icon name="arrow-left" size={14} /> {t("Return to live")}
        </button>
      )}

      <div className="event-list">
        {events.map((event, index) => (
          <button
            aria-label={`${t("Replay event")} #${event.sequence}: ${t(event.title)}`}
            aria-current={selectedId === event.id ? "true" : undefined}
            className={`event-row event-${event.kind} state-${event.state} ${selectedId === event.id ? "is-selected" : ""} ${event.depth ? "is-child" : ""}`}
            key={event.id}
            onClick={() => onSelect(event)}
            type="button"
          >
            <span className="event-time">{event.timestamp}</span>
            <span className="event-rail" aria-hidden="true">
              {index < events.length - 1 && <span className="event-line" />}
              <span className="event-node"><Icon name={eventIcons[event.kind]} size={15} /></span>
            </span>
            <span className="event-copy">
              <span className="event-title-line">
                <strong>{t(event.title)}</strong>
                {event.risk && <span className={`risk risk-${event.risk}`}>{event.risk}</span>}
                {event.policyDecision && <span className={`policy-decision-chip policy-${event.policyDecision.kind}`}>{t(event.policyDecision.kind)}</span>}
                {event.sandboxReport && <SandboxBadge compact report={event.sandboxReport} />}
                {event.atStep !== undefined && <span className="input-step-chip">{t("step")} {event.atStep}</span>}
                <StateGlyph event={event} />
              </span>
              <span className="event-summary">{t(event.summary)}</span>
              {event.policyDecision && <span className="event-policy-explanation">{t(event.policyDecision.explanation)}{event.policyDecision.matched_rule_id ? ` · ${t("rule")} ${event.policyDecision.matched_rule_id}` : ` · ${t(event.policyDecision.source)}`}</span>}
            </span>
            <span className="event-meta">
              {event.duration && <small>{event.duration}</small>}
              <Icon name="chevron" size={14} />
            </span>
          </button>
        ))}
      </div>

      {events.length === 0 && (
        <div className="empty-events"><span className="empty-ring" /><p>{t("Events will appear here as the run advances.")}</p></div>
      )}
    </section>
  );
}
