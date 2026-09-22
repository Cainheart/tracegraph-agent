import { useEffect, useRef, useState } from "react";
import { totalDiff, type ChangedFile, type ConnectionSnapshot, type ContextBudgetSnapshot, type ConversationTurn, type EvidenceSnapshot, type ModelSurfaceSnapshot, type PendingAttachment, type PublicActivitySnapshot, type ReasoningEffort, type RunMode, type RunStatus, type TraceEvent } from "../model";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";
import { MarkdownContent } from "./MarkdownContent";
import { ReasoningEffortPicker } from "./ReasoningEffortPicker";

export function NoProject({
  onStartChat,
  connection,
  onReconnect,
  reasoningEffort,
  onReasoningEffortChange,
}: {
  onStartChat: (task: string, reasoningEffort: ReasoningEffort, attachments: readonly PendingAttachment[]) => Promise<void>;
  connection: ConnectionSnapshot;
  onReconnect?: () => Promise<void>;
  reasoningEffort: ReasoningEffort;
  onReasoningEffortChange: (value: ReasoningEffort) => void;
}) {
  const { t } = useI18n();
  const [chatTask, setChatTask] = useState("");
  const [chatting, setChatting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [actionError, setActionError] = useState("");
  const startChat = async () => {
    if (!chatTask.trim()) return;
    if (connection.state !== "live") {
      setActionError(t("Reconnect to the local Host before sending a message."));
      return;
    }
    setChatting(true); setActionError("");
    try {
      await onStartChat(chatTask.trim(), reasoningEffort, []);
    }
    catch (error) { setActionError(t(error instanceof Error ? error.message : String(error))); }
    finally { setChatting(false); }
  };
  const reconnect = async () => {
    if (!onReconnect) return;
    setReconnecting(true);
    setActionError("");
    try {
      await onReconnect();
    } catch (error) {
      setActionError(t(error instanceof Error ? error.message : String(error)));
    } finally {
      setReconnecting(false);
    }
  };
  return (
    <main className="state-page">
      <div className="state-hero">
        <span className="state-hero-mark"><Icon name="graph" size={28} /></span>
        <span className="eyebrow">{t("TraceGraph workspace")}</span>
      </div>
      {connection.state !== "live" && (
        <div className="connection-recovery" role="alert">
          <span className="connection-recovery-icon"><Icon name="alert" size={16} /></span>
          <div><strong>{t("Connection unavailable")}</strong><p>{t(connection.message)}</p></div>
          {onReconnect && <button className="button subtle" disabled={reconnecting} onClick={() => void reconnect()} type="button"><Icon name="refresh" size={13} />{t(reconnecting ? "Reconnecting…" : "Reconnect")}</button>}
        </div>
      )}
      <div className="plain-chat-composer">
        <textarea aria-label={t("Plain chat message")} disabled={connection.state !== "live" || chatting} onChange={(event) => setChatTask(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void startChat(); } }} placeholder={t("Ask anything…")} rows={2} value={chatTask} />
        <div className="plain-chat-composer-footer"><ReasoningEffortPicker compact disabled={connection.state !== "live" || chatting} onChange={onReasoningEffortChange} value={reasoningEffort} /><span className="composer-safety-note"><Icon name="shield" size={12} />{t("Plain chat")}</span><button aria-label={t("Send message")} className="button primary composer-send" disabled={connection.state !== "live" || chatting || !chatTask.trim()} onClick={() => void startChat()} type="button"><Icon name="send" size={14} /></button></div>
      </div>
      {actionError && <div className="entry-error" role="alert"><Icon name="alert" size={14} />{actionError}</div>}
    </main>
  );
}

export function ProjectReady({
  readonly,
  onStart,
  reasoningEffort,
  onReasoningEffortChange,
}: {
  readonly: boolean;
  onStart: (task: string, mode: RunMode, reasoningEffort: ReasoningEffort, attachments: readonly PendingAttachment[]) => Promise<void>;
  reasoningEffort: ReasoningEffort;
  onReasoningEffortChange: (value: ReasoningEffort) => void;
}) {
  const { t } = useI18n();
  const [task, setTask] = useState("");
  const [mode, setMode] = useState<RunMode>(readonly ? "plan" : "execute");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  const start = async () => {
    if (!task.trim()) return;
    setBusy(true);
    setActionError("");
    try {
      await onStart(task.trim(), mode, reasoningEffort, []);
    } catch (error) {
      setActionError(t(error instanceof Error ? error.message : String(error)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="state-page project-ready-page">
      <div className="ready-card">
        <textarea aria-label={t("Task")} onChange={(event) => setTask(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && task.trim()) { event.preventDefault(); void start(); } }} placeholder={t("Describe what you want the Agent to do…")} rows={2} value={task} />
        <div className="ready-options">
          <div className="ready-control-row">
            <div className="mode-picker" role="group" aria-label={t("Run mode")}>
              <button className={mode === "plan" ? "active" : ""} onClick={() => setMode("plan")} type="button"><Icon name="search" size={14} />{t("Plan")}</button>
              <button className={mode === "execute" ? "active" : ""} disabled={readonly} onClick={() => setMode("execute")} title={t(readonly ? "Execute is unavailable for a read-only project" : "Execute with the active permission policy")} type="button"><Icon name="play" size={14} />{t("Execute")}</button>
            </div>
            <ReasoningEffortPicker onChange={onReasoningEffortChange} value={reasoningEffort} />
          </div>
          <button className="button primary start-run" disabled={busy || task.trim().length === 0} onClick={() => void start()} type="button">{t(busy ? "Starting…" : "Start run")}<Icon name="send" size={14} /></button>
        </div>
      </div>
      {actionError && <div className="entry-error" role="alert"><Icon name="alert" size={14} />{actionError}</div>}
      <div className="ready-facts"><span><Icon name="graph" size={14} />{t("Static module graph")}</span><span><Icon name="layers" size={14} />{t("Inspectable context")}</span><span><Icon name="activity" size={14} />{t("Durable trajectory")}</span></div>
    </main>
  );
}

export function ChatView({
  conversation,
  events,
  task,
  status,
  dataSource,
  changedFiles,
  evidence,
  outcome,
  contextBudget,
  turnsCompleted,
  turnLimit,
  publicActivities,
  modelSurface,
  elapsed,
  inputTokens,
  totalTokens,
  progressive = false,
}: {
  conversation: readonly ConversationTurn[];
  events: readonly TraceEvent[];
  task: string;
  status: RunStatus;
  dataSource: "demo" | "live";
  changedFiles: readonly ChangedFile[];
  evidence: EvidenceSnapshot;
  outcome?: string;
  contextBudget?: ContextBudgetSnapshot;
  turnsCompleted?: number;
  turnLimit?: number;
  publicActivities?: readonly PublicActivitySnapshot[];
  modelSurface?: readonly ModelSurfaceSnapshot[];
  elapsed?: string;
  inputTokens?: number;
  totalTokens?: number;
  progressive?: boolean;
}) {
  const { language, t } = useI18n();
  const endRef = useRef<HTMLDivElement>(null);
  const response =
    status === "awaiting_plan_approval"
      ? language === "zh-CN" ? "规划已写入 Todo 清单，执行会保持暂停，直到你审批当前计划版本。" : "The plan is recorded in the Todo list. Execution stays paused until you approve this exact revision."
      : status === "needs_approval"
      ? language === "zh-CN" ? "限定范围的补丁预览正在审批关卡等待。允许写入前，请先审查已记录的差异和证据。" : "A scoped patch preview is waiting at the approval gate. Review the recorded diff and evidence before allowing the write."
      : status === "needs_manual_review"
        ? outcome ?? events.at(-1)?.summary ?? (language === "zh-CN" ? "工作区状态与 Action WAL 不一致。系统已停止自动修改，请检查持久化轨迹。" : "The workspace state differs from the Action WAL. Automatic changes stopped; inspect the durable trajectory.")
      : status === "failed" || status === "cancelled" || status === "interrupted"
        ? outcome ?? events.at(-1)?.summary ?? (language === "zh-CN" ? "本次运行没有生成最终回答，请检查推理过程中的失败步骤。" : "This run did not produce a final answer. Inspect the failed step in the reasoning process.")
      : status === "completed" || status === "ready_for_review" || status === "historical"
        ? outcome ?? (language === "zh-CN" ? "本次运行已进入可审查状态。下方仅显示由本地主机引用并验证的制品。" : "The run has reached a reviewable state. Only artifacts referenced and verified by the Host are shown below.")
        : language === "zh-CN" ? "Agent 正在处理任务。请通过持久化轨迹查看最新的规范进度。" : "The Agent is processing the task. Follow the durable trajectory for the latest canonical progress.";
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [conversation.length, events.length, outcome, publicActivities?.length, status, modelSurface?.length]);
  return (
    <section className="chat-view">
      <div className="chat-date"><span />{t("Today")}<span /></div>
      {conversation.map((turn) => <ChatTurn dataSource={dataSource} events={turn.events} key={turn.runId} response={turn.response} status={turn.status} task={turn.task} {...(turn.elapsed === undefined ? {} : { elapsed: turn.elapsed })} {...(turn.inputTokens === undefined ? {} : { inputTokens: turn.inputTokens })} {...(turn.totalTokens === undefined ? {} : { totalTokens: turn.totalTokens })} />)}
      <ChatTurn changedFiles={changedFiles} dataSource={dataSource} events={events} evidence={evidence} progressive={progressive} response={response} status={status} task={task} {...(elapsed === undefined ? {} : { elapsed })} {...(inputTokens === undefined ? {} : { inputTokens })} {...(totalTokens === undefined ? {} : { totalTokens })} {...(contextBudget === undefined ? {} : { contextBudget })} {...(turnsCompleted === undefined ? {} : { turnsCompleted })} {...(turnLimit === undefined ? {} : { turnLimit })} {...(publicActivities === undefined ? {} : { publicActivities })} {...(modelSurface === undefined ? {} : { modelSurface })} />
      <div ref={endRef} />
    </section>
  );
}

function ChatTurn({ task, response, status, events, dataSource, changedFiles = [], evidence, contextBudget, turnsCompleted, turnLimit, publicActivities, modelSurface, elapsed, inputTokens, totalTokens, progressive = false }: {
  task: string;
  response: string;
  status: RunStatus;
  events: readonly TraceEvent[];
  dataSource: "demo" | "live";
  changedFiles?: readonly ChangedFile[];
  evidence?: EvidenceSnapshot;
  contextBudget?: ContextBudgetSnapshot;
  turnsCompleted?: number;
  turnLimit?: number;
  publicActivities?: readonly PublicActivitySnapshot[];
  modelSurface?: readonly ModelSurfaceSnapshot[];
  elapsed?: string;
  inputTokens?: number;
  totalTokens?: number;
  progressive?: boolean;
}) {
  const { language, t } = useI18n();
  const process = publicProcess(events, publicActivities);
  const active = status === "running" || status === "indexing" || status === "reconnecting";
  const persistedPlans = process
    .filter((event) => event.kind === "decision" && event.state === "succeeded" && Boolean(event.rationale ?? event.summary))
    .map((event) => ({
      id: `decision:${event.id}`,
      modelCallId: event.operationId ?? event.id,
      cursor: event.sequence,
      timestamp: event.timestamp,
      type: "public_plan_snapshot" as const,
      status: "completed" as const,
      text: event.rationale ?? event.summary,
    }));
  // Older Hosts may still send a `thinking_snapshot` produced from a
  // provider's private reasoning channel.  Treat it as compatibility data,
  // never as public UI content.  Public plans and answer previews are
  // explicit Decision fields; tool facts come from the durable event feed.
  const safeModelSurface = modelSurface?.filter((item) => item.type !== "thinking_snapshot") ?? [];
  // The inline reasoning stream is deliberately limited to public plans and
  // actual execution facts. Answer snapshots are rendered in the answer body
  // below; showing them here made the "推理过程" look like a duplicate reply.
  const visibleSurface = safeModelSurface.filter((item) => item.type === "public_plan_snapshot");
  // Durable decision events keep the complete history, while the volatile
  // surface stream may only contain the most recent reconnect window. Merge
  // by model call so a reconnect cannot make earlier public plans disappear;
  // the fresher surface snapshot wins for the same call.
  const plansByCall = new Map<string, ModelSurfaceSnapshot>();
  for (const plan of persistedPlans) plansByCall.set(plan.modelCallId, plan);
  for (const plan of visibleSurface) plansByCall.set(plan.modelCallId, plan);
  const decisionOrder = new Map(
    process
      .filter((event) => event.kind === "decision")
      .map((event) => [event.operationId ?? event.id, event.sequence] as const),
  );
  const visiblePlans = [...plansByCall.values()].sort((left, right) =>
    (decisionOrder.get(left.modelCallId) ?? left.cursor) - (decisionOrder.get(right.modelCallId) ?? right.cursor),
  );
  const latestPublicAnswer = safeModelSurface.filter((item) => item.type === "answer_snapshot").at(-1);
  // Keep the complete public event order. A model decision is replaced by its
  // public plan entry when one is available; context, tool, patch, graph and
  // test facts remain visible as their own timeline entries. This is what
  // makes one question read like a sequence of inspectable steps instead of a
  // single boxed paragraph.
  const publicPlanCallIds = new Set(visiblePlans.map((item) => item.modelCallId));
  const progressEvents = process.filter((event) =>
    !(event.kind === "decision" && publicPlanCallIds.has(event.operationId ?? event.id)),
  );
  const answerTarget = latestPublicAnswer?.text ?? response;
  // A completed Run is durable state, not a new stream. ChatView is mounted
  // again when the user returns from Trajectory, so feeding `progressive`
  // through unconditionally would reset the hook's local cursor and replay
  // the entire answer from an empty string. Only live Run states should paint
  // incrementally; terminal states render the persisted answer immediately.
  const progressiveResponse = useProgressiveText(answerTarget, shouldUseProgressiveAnswer(status, progressive));
  const answerStreaming = latestPublicAnswer?.status === "streaming" || progressiveResponse.length < answerTarget.length;
  return <>
    <article className="chat-message user-message" data-chat-role="user"><span className="avatar user-avatar">C</span><div className="chat-turn-body"><header><strong>{t("You")}</strong><time>{dataSource === "demo" ? "10:02" : t("recorded")}</time>{(elapsed || inputTokens !== undefined || totalTokens !== undefined) && <span className="chat-turn-metrics">{elapsed && <span><Icon name="clock" size={11} />{elapsed}</span>}{inputTokens !== undefined && <span>{language === "zh-CN" ? "输入" : "in"} {formatTokens(inputTokens)}</span>}{totalTokens !== undefined && <span>{language === "zh-CN" ? "总计" : "total"} {formatTokens(totalTokens)}</span>}</span>}</header><p>{task}</p></div></article>
    <article className={`chat-message agent-message ${active ? "is-live" : ""}`} data-chat-role="agent"><span className="avatar agent-avatar"><Icon name="graph" size={15} /></span><div className="chat-turn-body">
      <header><strong>TraceGraph Agent</strong><time>{dataSource === "demo" ? "10:02" : t(status === "running" || status === "indexing" ? "live" : "recorded")}</time></header>
      {contextBudget && <ContextBudgetStrip budget={contextBudget} language={language} {...(turnsCompleted === undefined ? {} : { turnsCompleted })} {...(turnLimit === undefined ? {} : { turnLimit })} />}
      {(visiblePlans.length > 0 || progressEvents.length > 0 || active) && <section aria-label={t("Reasoning process")} className="public-model-process">
        <div className="public-progress-heading" title={language === "zh-CN" ? "仅显示模型明确发布的公开计划和已经发生的工具事实" : "Only explicit public plans and observed tool facts are shown"}>
          <Icon name="activity" size={14} /><span>{t("Reasoning process")}</span>{active && <em><i />{language === "zh-CN" ? "实时" : "live"}</em>}<small>{active ? (language === "zh-CN" ? "流式" : "streaming") : (language === "zh-CN" ? "已记录" : "recorded")}</small>
        </div>
        <PublicModelSurface active={active} events={process} language={language} surface={visiblePlans} />
      </section>}
      <div className={`chat-answer ${answerStreaming ? "is-streaming" : ""}`}>
      {latestPublicAnswer?.text
        ? <div aria-live="polite" className="chat-live-answer"><MarkdownContent content={progressiveResponse} />{(active || answerStreaming) && <span aria-hidden="true" className="public-model-caret">▍</span>}</div>
        : active
          ? <div aria-live="polite" className="chat-live-response"><span className="event-spinner" /><div><strong>{t("Working on your request")}</strong><p>{language === "zh-CN" ? "正在分析请求并等待下一步公开计划…" : "Analyzing the request and waiting for the next public plan…"}</p></div></div>
          : <MarkdownContent content={progressiveResponse} />}
      </div>
      <div className="chat-evidence">{changedFiles.length > 0 && <span><Icon name="diff" size={13} />{changedFiles.length} {t("files")} · +{totalDiff(changedFiles).additions} −{totalDiff(changedFiles).deletions}</span>}{evidence && <span><Icon name="graph" size={13} />{t("Graph")} {evidence.graph.status}</span>}<span><Icon name="shield" size={13} />{t(status)}</span></div>
    </div></article>
  </>;
}

export function shouldUseProgressiveAnswer(status: RunStatus, enabled: boolean): boolean {
  return enabled && (status === "indexing" || status === "running" || status === "reconnecting");
}

/**
 * Keep the public answer readable while the Host catches up with the model
 * surface stream. The provider stream remains authoritative; this only
 * controls how quickly an already-safe public snapshot is painted.
 */
function useProgressiveText(target: string, enabled: boolean): string {
  // A terminal snapshot mounted for the first time should be shown at once,
  // while a stream that was already visible must finish at the same cadence
  // instead of jumping to the full answer when the Run becomes completed.
  const wasLiveRef = useRef(enabled);
  // Historical/terminal snapshots should render immediately. A live snapshot
  // starts empty so the timer below paints it in small increments instead of
  // flashing the whole public plan on the first render.
  const [visible, setVisible] = useState(enabled ? "" : target);
  const shouldAnimate = enabled || wasLiveRef.current;

  useEffect(() => {
    if (enabled) {
      wasLiveRef.current = true;
    }
    if (!shouldAnimate) {
      setVisible(target);
      return;
    }
    setVisible((current) => target.startsWith(current) ? current : "");
  }, [enabled, shouldAnimate, target]);

  useEffect(() => {
    const characters = Array.from(target);
    const visibleCharacters = Array.from(visible);
    if (!shouldAnimate || visibleCharacters.length >= characters.length) return;
    // Paint genuine incremental updates instead of revealing an entire answer
    // over only a few animation frames.  Array.from keeps emoji and CJK text
    // intact enough for a readable, stable public-answer cadence.
    // Two code points every 28ms is roughly 70 characters/second: fast enough
    // to feel live, but slow enough that a newly received snapshot is not
    // revealed as one visually abrupt burst.
    const step = 2;
    const timer = window.setTimeout(() => {
      setVisible((current) => {
        const currentCharacters = Array.from(current);
        return target.startsWith(current)
          ? characters.slice(0, currentCharacters.length + step).join("")
          : characters.slice(0, step).join("");
      });
    }, 28);
    return () => window.clearTimeout(timer);
  }, [shouldAnimate, target, visible]);

  return visible;
}

function PublicModelSurface({
  surface,
  events,
  active,
  language,
}: {
  surface: readonly ModelSurfaceSnapshot[];
  events: readonly TraceEvent[];
  active: boolean;
  language: "zh-CN" | "en";
}) {
  // `thinking_snapshot` is retained in the wire schema for reconnect
  // compatibility only.  It represents provider-private reasoning and must
  // not be rendered as if it were a user-safe explanation.
  const plans = surface.filter((item) => item.type === "public_plan_snapshot");
  const latestPlan = plans.at(-1);
  const visiblePlanText = useProgressiveText(latestPlan?.text ?? "", active && latestPlan?.status === "streaming");
  const planCallIds = new Set(plans.map((item) => item.modelCallId));
  const decisionOrder = new Map(
    events
      .filter((event) => event.kind === "decision")
      .map((event) => [event.operationId ?? event.id, event.sequence] as const),
  );
  const timeline = [
    ...plans.map((item, index) => ({
      id: item.id,
      order: (decisionOrder.get(item.modelCallId) ?? Number.MAX_SAFE_INTEGER) + (index + 1) / 10_000,
      kind: "plan" as const,
      status: item.status,
      timestamp: item.timestamp,
      text: item === latestPlan ? visiblePlanText : item.text,
      label: language === "zh-CN" ? "深度思考" : "Public plan",
      streaming: item.status === "streaming" && active,
    })),
    ...events
      .filter((event) => !(event.kind === "decision" && planCallIds.has(event.operationId ?? event.id)))
      .map((event) => ({
        id: event.id,
        order: event.sequence,
        kind: "event" as const,
        status: event.state,
        timestamp: event.timestamp,
        text: event.summary,
        label: progressEventLabel(event.kind, language),
        streaming: event.state === "running",
        detail: [event.toolName, event.target].filter((value): value is string => Boolean(value)).join(" · ") || undefined,
      })),
  ].sort((left, right) => left.order - right.order);

  return <div aria-live="polite" className="public-model-surface">
    {timeline.map((item) => {
      // Keep disclosure summaries phrasing-only.  The same compact content is
      // used for both expandable tool facts and plain public-plan rows, so a
      // <details> row remains keyboard- and screen-reader-friendly.
      const content = <><span className="public-progress-meta"><span>{item.label}</span><time>{item.timestamp}</time></span><span className="public-progress-copy">{item.text}{item.streaming && <span aria-hidden="true" className="public-model-caret">▍</span>}</span></>;
      return item.kind === "event" && item.detail ? (
        <details className={`public-progress-item is-${item.kind} is-${item.status} is-disclosure`} key={item.id}>
          <summary>{content}<Icon aria-hidden="true" className="public-progress-chevron" name="chevron" size={13} /></summary>
          <div className="public-progress-detail"><code>{item.detail}</code></div>
        </details>
      ) : <div className={`public-progress-item is-${item.kind} is-${item.status}`} key={item.id}>{content}</div>;
    })}
    {active && timeline.length === 0 && <p className="public-model-awaiting">{language === "zh-CN" ? "等待模型提供下一步公开进度…" : "Waiting for the next public model update…"}</p>}
  </div>;
}

function progressEventLabel(kind: TraceEvent["kind"], language: "zh-CN" | "en"): string {
  if (language !== "zh-CN") {
    const labels: Record<string, string> = {
      run: "Run",
      context: "Context",
      decision: "Decision",
      tool: "Tool",
      approval: "Approval",
      patch: "Change",
      graph: "Graph",
      test: "Verification",
    };
    return labels[kind] ?? "Progress";
  }
  const labels: Record<string, string> = {
    run: "运行",
    context: "上下文",
    decision: "深度思考",
    tool: "执行",
    approval: "审批",
    patch: "修改",
    graph: "图谱",
    test: "验证",
  };
  return labels[kind] ?? "进度";
}

function publicProcess(
  events: readonly TraceEvent[],
  liveActivities: readonly PublicActivitySnapshot[] = [],
): TraceEvent[] {
  const visibleKinds: readonly TraceEvent["kind"][] = ["run", "context", "decision", "tool", "approval", "patch", "graph", "test"];
  // The rapid feed arrives before the durable event projection. As soon as
  // the canonical source event is available, it replaces the compact live
  // row at the same sequence. This avoids fake thinking text and duplicates.
  const process = new Map<string, TraceEvent>();
  for (const activity of liveActivities) process.set(activity.sourceEventId, traceFromLiveActivity(activity));
  for (const event of events) {
    if (visibleKinds.includes(event.kind)) process.set(event.id, event);
  }
  return [...process.values()].sort((left, right) => left.sequence - right.sequence);
}

function traceFromLiveActivity(activity: PublicActivitySnapshot): TraceEvent {
  const state: TraceEvent["state"] = activity.status === "started"
    ? "running"
    : activity.status === "failed"
      ? "failed"
      : activity.status === "cancelled"
        ? "denied"
        : "succeeded";
  const kind: TraceEvent["kind"] = activity.kind === "model" ? "decision" : activity.kind;
  return {
    id: activity.sourceEventId,
    sequence: activity.sequence,
    kind,
    title: activity.sourceEventType.split(".").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" · "),
    summary: activity.summary,
    timestamp: activity.timestamp,
    state,
  };
}

function ContextBudgetStrip({ budget, language, turnsCompleted, turnLimit }: { budget: ContextBudgetSnapshot; language: "zh-CN" | "en"; turnsCompleted?: number; turnLimit?: number }) {
  const inputBudget = Math.max(1, budget.inputBudgetTokens);
  const usagePercent = percentage(budget.usedTokens, inputBudget);
  const warningPercent = percentage(budget.warningThresholdTokens, inputBudget);
  const compressionPercent = percentage(budget.compressionThresholdTokens, inputBudget);
  const status = language === "zh-CN"
    ? { healthy: "健康", warning: "预警", compressed: "已压缩" }[budget.status]
    : { healthy: "Healthy", warning: "Warning", compressed: "Compressed" }[budget.status];
  const labels = language === "zh-CN"
    ? { context: "上下文", input: "输入预算", window: "窗口", output: "输出预留", warning: "预警", compression: "压缩", turns: "轮次" }
    : { context: "Context", input: "input budget", window: "window", output: "output reserved", warning: "warning", compression: "compression", turns: "turns" };
  return (
    <section aria-label={`${labels.context}: ${status}`} className={`context-budget-strip context-budget-${budget.status}`}>
      <div className="context-budget-heading">
        <span><Icon name="layers" size={13} /><strong>{labels.context}</strong><b>{formatTokens(budget.usedTokens)} / {formatTokens(budget.inputBudgetTokens)}</b><small>{labels.input}</small></span>
        <em>{status}</em>
      </div>
      <div aria-label={`${usagePercent}%`} aria-valuemax={100} aria-valuemin={0} aria-valuenow={usagePercent} className="context-budget-track" role="progressbar">
        <i style={{ width: `${usagePercent}%` }} />
        <span className="context-budget-threshold is-warning" style={{ left: `${warningPercent}%` }} />
        <span className="context-budget-threshold is-compression" style={{ left: `${compressionPercent}%` }} />
      </div>
      <footer>
        <span>{formatTokens(budget.windowTokens)} {labels.window}</span>
        <span>{formatTokens(budget.reservedOutputTokens)} {labels.output}</span>
        {turnsCompleted !== undefined && turnLimit !== undefined && <span>{turnsCompleted} / {turnLimit} {labels.turns}</span>}
        <span>{warningPercent}% {labels.warning}</span>
        <span>{compressionPercent}% {labels.compression}</span>
      </footer>
      <ContextUsageSummary budget={budget} language={language} />
    </section>
  );
}

function ContextUsageSummary({ budget, language }: { budget: ContextBudgetSnapshot; language: "zh-CN" | "en" }) {
  const { t } = useI18n();
  const estimate = budget.estimate;
  const usage = budget.providerUsage;
  if (!estimate && !usage) return null;
  const confidence = estimate?.confidence === "calibrated"
    ? t("Calibrated estimate")
    : estimate?.confidence === "exact"
      ? t("Exact tokenizer")
      : t("Estimated");
  return <div className="context-usage-summary">
    {estimate && <section aria-label={t("Budget estimate")} className="context-token-estimate">
      <header><strong>{t("Budget estimate")}</strong><span>{confidence}</span><code>{estimate.estimatorId}</code></header>
      <div className="context-token-totals">
        <span>{t("Input")} <b>{formatTokens(estimate.inputTokens)}</b></span>
        <span>{t("Estimated output")} <b>{formatTokens(estimate.outputTokens)}</b></span>
        {estimate.cachedTokens !== undefined && <span>{t("Estimated cached input")} <b>{formatTokens(estimate.cachedTokens)}</b></span>}
      </div>
      <div className="context-token-sections">
        {Object.entries(estimate.perSection).map(([section, tokens]) => <span key={section}>{t(titleCase(section))} <code>{formatTokens(tokens)}</code></span>)}
      </div>
    </section>}
    {usage && <section aria-label={t("Provider reported usage")} className="context-provider-usage">
      <header><strong>{t("Provider reported usage")}</strong><span>{usage.provider} · {usage.model} · {t(usage.requestKind === "repair" ? "Repair request" : usage.requestKind === "summary" ? "Summary request" : "Initial request")} #{usage.requestSequence}</span></header>
      <div className="context-token-totals">
        <span>{t("Input")} <b>{formatTokens(usage.inputTokens)}</b></span>
        <span>{t("Output")} <b>{formatTokens(usage.outputTokens)}</b></span>
        {usage.cachedInputTokens !== undefined && <span>{t("Cached input")} <b>{formatTokens(usage.cachedInputTokens)}</b></span>}
        {usage.reasoningOutputTokens !== undefined && <span>{t("Reasoning output")} <b>{formatTokens(usage.reasoningOutputTokens)}</b></span>}
        <span>{t("Total")} <b>{formatTokens(usage.totalTokens)}</b></span>
      </div>
      <div className="context-usage-cost">{usage.cost.status === "provider_reported"
        ? <span>{t("Reported cost")} <b>{formatCost(usage.cost.amount, usage.cost.currency, language)}</b></span>
        : <span>{t("Cost unavailable")}</span>}</div>
      {usage.anomaly && <div className="context-usage-anomaly" role="alert"><strong>{t("Usage anomaly")}</strong><span>{t("Provider input differs from the preflight estimate")}</span></div>}
    </section>}
  </div>;
}

function percentage(value: number, total: number): number {
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
}

function formatTokens(value: number): string {
  if (value < 1_000) return value.toLocaleString();
  const thousands = value / 1_000;
  return `${thousands >= 100 || Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1)}K`;
}

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function formatCost(amount: number, currency: string, language: "zh-CN" | "en"): string {
  return `${amount.toLocaleString(language, { maximumFractionDigits: 8 })} ${currency}`;
}
