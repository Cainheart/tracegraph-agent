import { useEffect, useRef, useState } from "react";
import { totalDiff, type ChangedFile, type ConnectionSnapshot, type ContextBudgetSnapshot, type ConversationTurn, type EvidenceSnapshot, type ModelSurfaceSnapshot, type PendingAttachment, type ProjectSnapshot, type PublicActivitySnapshot, type ReasoningEffort, type RunMode, type RunStatus, type TraceEvent } from "../model";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";
import { MarkdownContent } from "./MarkdownContent";
import { ReasoningEffortPicker } from "./ReasoningEffortPicker";
import { AttachmentComposer } from "./AttachmentComposer";

export function NoProject({
  onCreate,
  onOpenLocal,
  onStartChat,
  reasoningEffort,
  onReasoningEffortChange,
  connection,
}: {
  onCreate: (name: string) => Promise<void>;
  onOpenLocal: (access: "read_write" | "read_only") => Promise<void>;
  onStartChat: (task: string, reasoningEffort: ReasoningEffort, attachments: readonly PendingAttachment[]) => Promise<void>;
  reasoningEffort: ReasoningEffort;
  onReasoningEffortChange: (value: ReasoningEffort) => void;
  connection: ConnectionSnapshot;
}) {
  const { t } = useI18n();
  const [projectName, setProjectName] = useState("");
  const [chatTask, setChatTask] = useState("");
  const [attachments, setAttachments] = useState<readonly PendingAttachment[]>([]);
  const [creating, setCreating] = useState(false);
  const [opening, setOpening] = useState(false);
  const [chatting, setChatting] = useState(false);
  const [actionError, setActionError] = useState("");
  const create = async () => {
    setCreating(true); setActionError("");
    try { await onCreate(projectName.trim()); }
    catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
    finally { setCreating(false); }
  };
  const openLocal = async (access: "read_write" | "read_only") => {
    setOpening(true); setActionError("");
    try { await onOpenLocal(access); }
    catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
    finally { setOpening(false); }
  };
  const startChat = async () => {
    if (!chatTask.trim()) return;
    setChatting(true); setActionError("");
    try {
      await onStartChat(chatTask.trim(), reasoningEffort, attachments);
      setAttachments([]);
    }
    catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
    finally { setChatting(false); }
  };
  return (
    <main className="state-page">
      <div className="state-hero">
        <span className="state-hero-mark"><Icon name="graph" size={28} /></span>
        <span className="eyebrow">{t("Local-first agent workbench")}</span>
        <h1>{t("See every decision.")}<br />{t("Trust every change.")}</h1>
        <p>{t("Start a plain conversation or choose a real local folder. TraceGraph keeps public execution steps, context, architecture changes, and verification evidence inspectable.")}</p>
      </div>
      <div className="entry-mode-grid">
        <section className="entry-card plain-chat-card">
          <div className="create-project-heading"><span className="choice-icon accent"><Icon name="message" size={20} /></span><span><strong>{t("Plain chat")}</strong><small>{t("Ask general questions without granting filesystem access")}</small></span></div>
          <textarea aria-label={t("Plain chat message")} onChange={(event) => setChatTask(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void startChat(); } }} placeholder={t("Ask anything… Enter to send, Shift+Enter for a new line")} rows={4} value={chatTask} />
          <AttachmentComposer attachments={attachments} disabled={chatting} onChange={setAttachments} />
          <div className="entry-card-actions"><ReasoningEffortPicker compact onChange={onReasoningEffortChange} value={reasoningEffort} /><button className="button primary" disabled={chatting || !chatTask.trim()} onClick={() => void startChat()} type="button">{t(chatting ? "Starting…" : "Start chat")}<Icon name="send" size={14} /></button></div>
          <div className="create-project-boundary"><Icon name="shield" size={13} /><span>{t("No filesystem, search, command, or write capability")}</span></div>
        </section>
        <section className="entry-card local-folder-card">
          <div className="create-project-heading"><span className="choice-icon"><Icon name="folder" size={20} /></span><span><strong>{t("Open a local folder")}</strong><small>{t("The local Host opens the native folder picker; the browser never submits a path")}</small></span></div>
          <div className="local-folder-actions"><button className="button primary" disabled={opening || connection.state !== "live"} onClick={() => void openLocal("read_write")} type="button"><Icon name="folder" size={14} />{t(opening ? "Opening…" : "Open with gated writes")}</button><button className="button subtle" disabled={opening || connection.state !== "live"} onClick={() => void openLocal("read_only")} type="button">{t("Open read-only")}</button></div>
          <div className="create-project-boundary"><Icon name="shield" size={13} /><span>{t("Write access is explicit; every patch still requires one-time approval")}</span></div>
        </section>
      </div>
      <details className="managed-project-disclosure"><summary>{t("Create an empty managed project")}</summary><div className="create-project-card"><div className="create-project-heading"><span className="choice-icon accent"><Icon name="code" size={20} /></span><span><strong>{t("Create a project")}</strong><small>{t("Stored under the Host data directory and shown with its exact location")}</small></span></div><div className="create-project-controls"><input aria-label={t("Project name")} onChange={(event) => setProjectName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && projectName.trim()) void create(); }} placeholder={t("Project name")} value={projectName} /><button className="button primary" disabled={creating || !projectName.trim()} onClick={() => void create()} type="button">{t(creating ? "Creating…" : "Create")}<Icon name="chevron" size={13} /></button></div><div className="create-project-boundary"><Icon name="shield" size={13} /><span>{t("Persistent workspace · writes require approval")}</span></div></div></details>
      {actionError && <div className="entry-error" role="alert"><Icon name="alert" size={14} />{actionError}</div>}
      <div className={`connection-callout connection-${connection.state}`}><span className="online-dot" /><strong>{t(connection.state === "live" ? "Live" : connection.state)}</strong><span>{t(connection.message)}</span></div>
      <div className="boundary-note"><Icon name="shield" size={15} /><span>{t("Only folders explicitly chosen in the native picker are registered. Model credentials stay in the local Host.")}</span></div>
    </main>
  );
}

export function ProjectReady({
  project,
  readonly,
  onStart,
  onReveal,
  reasoningEffort,
  onReasoningEffortChange,
}: {
  project: ProjectSnapshot;
  readonly: boolean;
  onStart: (task: string, mode: RunMode, reasoningEffort: ReasoningEffort, attachments: readonly PendingAttachment[]) => Promise<void>;
  onReveal?: () => Promise<void>;
  reasoningEffort: ReasoningEffort;
  onReasoningEffortChange: (value: ReasoningEffort) => void;
}) {
  const { t } = useI18n();
  const [task, setTask] = useState("");
  const [mode, setMode] = useState<RunMode>(readonly ? "plan" : "execute");
  const [busy, setBusy] = useState(false);
  const [attachments, setAttachments] = useState<readonly PendingAttachment[]>([]);

  const start = async () => {
    setBusy(true);
    try {
      await onStart(task, mode, reasoningEffort, attachments);
      setAttachments([]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="state-page project-ready-page">
      <div className="ready-card">
        <div className="ready-heading"><span><Icon name="code" size={21} /></span><div><span className="eyebrow">{t("Project ready")}</span><h1>{t("What should the Agent investigate?")}</h1></div></div>
        <div className="ready-project-location"><div><span>{t("Project location")}</span><code title={project.pathLabel}>{project.pathLabel}</code></div>{onReveal && <button className="button subtle" onClick={() => void onReveal()} type="button"><Icon name="folder" size={14} />{t("Show in Finder")}</button>}</div>
        <textarea aria-label={t("Task")} onChange={(event) => setTask(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && task.trim()) { event.preventDefault(); void start(); } }} placeholder={t("Describe what you want the Agent to do…")} rows={5} value={task} />
        <AttachmentComposer attachments={attachments} disabled={busy} onChange={setAttachments} />
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
        <div className={`capability-banner ${readonly ? "readonly" : "fixture"}`}>
          <Icon name="shield" size={16} />
          <div><strong>{t(readonly ? "Read-only local repository" : "Writable project workspace")}</strong><span>{t(readonly ? "Execution remains bounded by the read-only workspace capability; filesystem writes stay unavailable." : "The Agent may inspect and preview file changes. Every patch commit still requires a one-time approval.")}</span></div>
        </div>
      </div>
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
        ? outcome ?? events.at(-1)?.summary ?? (language === "zh-CN" ? "本次运行没有生成最终回答，请检查公开执行过程中的失败步骤。" : "This run did not produce a final answer. Inspect the failed step in the public execution process.")
      : status === "completed" || status === "ready_for_review" || status === "historical"
        ? outcome ?? (language === "zh-CN" ? "本次运行已进入可审查状态。下方仅显示由本地主机引用并验证的制品。" : "The run has reached a reviewable state. Only artifacts referenced and verified by the Host are shown below.")
        : language === "zh-CN" ? "Agent 正在处理任务。请通过持久化轨迹查看最新的规范进度。" : "The Agent is processing the task. Follow the durable trajectory for the latest canonical progress.";
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [conversation.length, events.length, outcome, publicActivities?.length, status]);
  return (
    <section className="chat-view">
      <div className="chat-date"><span />{t("Today")}<span /></div>
      {conversation.map((turn) => <ChatTurn dataSource={dataSource} events={turn.events} key={turn.runId} response={turn.response} status={turn.status} task={turn.task} />)}
      <ChatTurn changedFiles={changedFiles} dataSource={dataSource} events={events} evidence={evidence} response={response} status={status} task={task} {...(contextBudget === undefined ? {} : { contextBudget })} {...(turnsCompleted === undefined ? {} : { turnsCompleted })} {...(turnLimit === undefined ? {} : { turnLimit })} {...(publicActivities === undefined ? {} : { publicActivities })} {...(modelSurface === undefined ? {} : { modelSurface })} />
      <div ref={endRef} />
    </section>
  );
}

function ChatTurn({ task, response, status, events, dataSource, changedFiles = [], evidence, contextBudget, turnsCompleted, turnLimit, publicActivities, modelSurface }: {
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
  const visibleSurface = safeModelSurface.length > 0 ? safeModelSurface : persistedPlans;
  const latestPublicPlan = visibleSurface.filter((item) => item.type === "public_plan_snapshot").at(-1);
  const latestPublicAnswer = visibleSurface.filter((item) => item.type === "answer_snapshot").at(-1);
  const actualOperations = process.filter((event) => ["tool", "patch", "test", "approval"].includes(event.kind));
  return <>
    <article className="chat-message user-message"><span className="avatar user-avatar">C</span><div><header><strong>{t("You")}</strong><time>{dataSource === "demo" ? "10:02" : t("recorded")}</time></header><p>{task}</p></div></article>
    <article className="chat-message agent-message"><span className="avatar agent-avatar"><Icon name="graph" size={15} /></span><div>
      <header><strong>TraceGraph Agent</strong><time>{dataSource === "demo" ? "10:02" : t(status === "running" || status === "indexing" ? "live" : "recorded")}</time></header>
      {contextBudget && <ContextBudgetStrip budget={contextBudget} language={language} {...(turnsCompleted === undefined ? {} : { turnsCompleted })} {...(turnLimit === undefined ? {} : { turnLimit })} />}
      {(visibleSurface.length > 0 || actualOperations.length > 0 || active) && <details className="chat-process public-model-process" open>
        <summary title={language === "zh-CN" ? "仅显示模型明确给出的公开内容和已发生的工具事实" : "Only explicit public model text and actual tool facts are shown"}><Icon name="activity" size={14} /><span>{language === "zh-CN" ? "公开执行过程" : "Public execution"}</span>{active && <em><i />{language === "zh-CN" ? "实时" : "live"}</em>}<small>{active ? (language === "zh-CN" ? "流式" : "streaming") : (language === "zh-CN" ? "已记录" : "recorded")}</small></summary>
        <PublicModelSurface active={active} language={language} operations={actualOperations} surface={visibleSurface} />
        <footer><Icon name="shield" size={12} />{language === "zh-CN" ? "实时区只显示模型明确发布的计划和已验证的工具事实；供应商私有思考不会展示。" : "Live progress shows only the model's explicit public plan and verified tool facts; private provider reasoning is hidden."}</footer>
      </details>}
      {active && latestPublicAnswer?.text
        ? <div aria-live="polite" className="chat-live-answer"><MarkdownContent content={latestPublicAnswer.text} /><span aria-hidden="true" className="public-model-caret">▍</span></div>
        : active
          ? <div aria-live="polite" className="chat-live-response"><span className="event-spinner" /><div><strong>{t("Working on your request")}</strong><p>{latestPublicPlan?.text ?? (language === "zh-CN" ? "正在分析请求并等待下一步公开计划…" : "Analyzing the request and waiting for the next public plan…")}</p></div></div>
          : <MarkdownContent content={response} />}
      <div className="chat-evidence">{changedFiles.length > 0 && <span><Icon name="diff" size={13} />{changedFiles.length} {t("files")} · +{totalDiff(changedFiles).additions} −{totalDiff(changedFiles).deletions}</span>}{evidence && <span><Icon name="graph" size={13} />{t("Graph")} {evidence.graph.status}</span>}<span><Icon name="shield" size={13} />{t(status)}</span></div>
    </div></article>
  </>;
}

function PublicModelSurface({
  surface,
  operations,
  active,
  language,
}: {
  surface: readonly ModelSurfaceSnapshot[];
  operations: readonly TraceEvent[];
  active: boolean;
  language: "zh-CN" | "en";
}) {
  // `thinking_snapshot` is retained in the wire schema for reconnect
  // compatibility only.  It represents provider-private reasoning and must
  // not be rendered as if it were a user-safe explanation.
  const safeSurface = surface.filter((item) => item.type !== "thinking_snapshot");
  const plans = safeSurface.filter((item) => item.type === "public_plan_snapshot");
  const answers = safeSurface.filter((item) => item.type === "answer_snapshot");
  return <div aria-live="polite" className="public-model-surface">
    {plans.map((item) => <p className={`public-model-text is-${item.status}`} key={item.id}>{item.text}{item.status === "streaming" && active && <span aria-hidden="true" className="public-model-caret">▍</span>}</p>)}
    {active && plans.length === 0 && <p className="public-model-awaiting">{language === "zh-CN" ? "等待模型提供可公开展示的进度…" : "Waiting for a model-provided public update…"}</p>}
    {answers.map((item) => <pre className={`public-answer-preview is-${item.status}`} key={item.id}>{item.text}{item.status === "streaming" && active && <span aria-hidden="true" className="public-model-caret">▍</span>}</pre>)}
    {operations.length > 0 && <details className="actual-operation-log">
      <summary>{language === "zh-CN" ? `实际执行事件 · ${operations.length}` : `Actual execution events · ${operations.length}`}</summary>
      <div>{operations.map((event) => <p className={`is-${event.state}`} key={event.id}>{event.summary}</p>)}</div>
    </details>}
  </div>;
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
