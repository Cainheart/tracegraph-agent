import { useEffect, useRef, useState, type ReactNode } from "react";
import { totalDiff, type ChangedFile, type ConnectionSnapshot, type ContextBudgetSnapshot, type ConversationTurn, type GeneratedArtifact, type EvidenceSnapshot, type ModelSurfaceSnapshot, type PendingAttachment, type PublicActivitySnapshot, type ReasoningEffort, type RunMode, type RunStatus, type TraceEvent } from "../model";
import { compactOperationLabel, publicOperations } from "../public-progress";
import { useI18n } from "../i18n";
import { MessageActions } from "./MessageActions";
import type { WorkbenchClient } from "../client";
import type { GeneratedArtifactContent } from "../client";
import { GeneratedGallery } from "./GeneratedGallery";
import { AttachmentComposer } from "./AttachmentComposer";
import { Icon } from "./Icon";
import { BrandMark } from "./Primitives";
import { MarkdownContent } from "./MarkdownContent";
import { ReasoningEffortPicker } from "./ReasoningEffortPicker";

export function NoProject({
  onStartChat,
  connection,
  onReconnect,
  reasoningEffort,
  onReasoningEffortChange,
  modelName = null,
  enterBehavior = "enter",
  attachmentsAvailable = false,
  modelReady = true,
  modelLoading = false,
  modelError = null,
  onConnectModel,
  onOpenDiagnostics,
  onCreateMedia, composer, onDraftChange,
}: {
  composer?: ReactNode; onDraftChange?: (value: string) => void;
  onStartChat: (task: string, reasoningEffort: ReasoningEffort, attachments: readonly PendingAttachment[]) => Promise<void>;
  connection: ConnectionSnapshot;
  onReconnect?: () => Promise<void>;
  reasoningEffort: ReasoningEffort;
  onReasoningEffortChange: (value: ReasoningEffort) => void;
  modelName?: string | null;
  enterBehavior?: "enter" | "mod-enter";
  attachmentsAvailable?: boolean;
  modelReady?: boolean; modelLoading?: boolean; modelError?: string | null;
  onConnectModel?: () => void; onOpenDiagnostics?: () => void; onCreateMedia?: () => void;
}) {
  const { t } = useI18n();
  const [attachments, setAttachments] = useState<readonly PendingAttachment[]>([]);
  const [chatTask, setChatTask] = useState("");
  const [chatting, setChatting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [actionError, setActionError] = useState("");
  const startChat = async () => {
    if (!chatTask.trim() || !modelReady) return;
    if (connection.state !== "live") {
      setActionError(t("Repair the connection before sending a message."));
      return;
    }
    setChatting(true); setActionError("");
    try {
      await onStartChat(chatTask.trim(), reasoningEffort, attachments);
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
        <BrandMark />
        <h1>{t("What would you like to work on?")}</h1>
        <p>{t("Start a conversation, or choose a project to work with files and tools.")}</p>
      </div>
      {connection.state !== "live" && (
        <div className="connection-recovery" role="alert">
          <span className="connection-recovery-icon"><Icon name="alert" size={16} /></span>
          <div><strong>{t("Let's get you connected")}</strong><p>{t("Try repairing the connection. If it still fails, open installation diagnostics.")}</p><details><summary>{t("Connection details")}</summary><p>{connection.message}</p></details></div>
          {onReconnect && <button className="button subtle" disabled={reconnecting} onClick={() => void reconnect()} type="button"><Icon name="refresh" size={13} />{t(reconnecting ? "Connecting…" : "Repair connection")}</button>}
          {onOpenDiagnostics && <button className="button subtle" onClick={onOpenDiagnostics} type="button">{t("Installation diagnostics")}</button>}
        </div>
      )}
      {!modelReady && connection.state === "live" && <ModelConnectionPrompt loading={modelLoading} error={modelError} onConnect={onConnectModel} />}
      {composer ?? <div className="plain-chat-composer">
        <textarea aria-label={t("Plain chat message")} disabled={connection.state !== "live" || chatting || modelLoading} onChange={(event) => setChatTask(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && (enterBehavior === "enter" ? !(event.metaKey || event.ctrlKey) : event.metaKey || event.ctrlKey)) { event.preventDefault(); void startChat(); } }} placeholder={t("Ask anything…")} rows={2} value={chatTask} />
        <div className="plain-chat-composer-footer">{attachmentsAvailable && <AttachmentComposer minimal attachments={attachments} disabled={chatting || connection.state !== "live"} onChange={setAttachments} />}{onCreateMedia && <button aria-label={t("Create media")} className="composer-tool-button" disabled={chatting || connection.state !== "live"} onClick={onCreateMedia} type="button"><Icon name="spark" size={14} /></button>}<span className="composer-model">{modelName ?? t("Connect model")}</span><ReasoningEffortPicker compact disabled={connection.state !== "live" || chatting} onChange={onReasoningEffortChange} value={reasoningEffort} /><span className="composer-safety-note"><Icon name="shield" size={12} />{t("Plain chat")}</span><button aria-label={t("Send message")} className="button primary composer-send" disabled={connection.state !== "live" || chatting || !modelReady || !chatTask.trim()} onClick={() => void startChat()} type="button"><Icon name="send" size={14} /></button></div>
      </div>}
      <div className="entry-suggestions" aria-label={t("Conversation starters")}>
        <button onClick={() => (onDraftChange ?? setChatTask)(t("Explain a concept step by step"))} type="button"><Icon name="spark" size={16} /><span>{t("Explain a concept")}</span></button>
        <button onClick={() => (onDraftChange ?? setChatTask)(t("Help me write a clear first draft"))} type="button"><Icon name="file" size={16} /><span>{t("Write something")}</span></button>
        <button onClick={() => (onDraftChange ?? setChatTask)(t("Help me turn an idea into a plan"))} type="button"><Icon name="route" size={16} /><span>{t("Make a plan")}</span></button>
      </div>
      <p className="entry-boundary-note"><Icon name="shield" size={13} />{t("No project filesystem or command access; media tools can create scoped Artifacts")}</p>
      {actionError && <div className="entry-error" role="alert"><Icon name="alert" size={14} />{actionError}</div>}
    </main>
  );
}

function ModelConnectionPrompt({ loading, error, onConnect }: { loading: boolean; error: string | null; onConnect?: (() => void) | undefined }) {
  const { t } = useI18n();
  return <div className="model-connection-prompt" role={error ? "alert" : "status"}><Icon name="spark" size={18} /><span>{t(loading ? "Loading your model…" : error ?? "Connect a model to start a conversation.")}</span>{onConnect && <button className="button primary" disabled={loading} onClick={onConnect} type="button">{t(error ? "Try again" : "Connect model")}</button>}</div>;
}

export function ProjectReady({
  readonly,
  connection,
  projectName,
  onStart,
  reasoningEffort,
  onReasoningEffortChange,
  modelName = null,
  enterBehavior = "enter",
  attachmentsAvailable = false,
  modelReady = true, modelLoading = false, modelError = null,
  onConnectModel, onReconnect, onOpenDiagnostics, onCreateMedia, composer, onDraftChange,
}: {
  composer?: ReactNode; onDraftChange?: (value: string) => void;
  readonly: boolean;
  connection: ConnectionSnapshot;
  projectName: string;
  onStart: (task: string, mode: RunMode, reasoningEffort: ReasoningEffort, attachments: readonly PendingAttachment[]) => Promise<void>;
  reasoningEffort: ReasoningEffort;
  onReasoningEffortChange: (value: ReasoningEffort) => void;
  modelName?: string | null;
  enterBehavior?: "enter" | "mod-enter";
  attachmentsAvailable?: boolean;
  modelReady?: boolean; modelLoading?: boolean; modelError?: string | null;
  onConnectModel?: () => void; onReconnect?: () => Promise<void>; onOpenDiagnostics?: () => void; onCreateMedia?: () => void;
}) {
  const { t } = useI18n();
  const [attachments, setAttachments] = useState<readonly PendingAttachment[]>([]);
  const [task, setTask] = useState("");
  const [mode, setMode] = useState<RunMode>(readonly ? "plan" : "execute");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  const start = async () => {
    if (!task.trim() || busy || connection.state !== "live" || !modelReady) return;
    setBusy(true);
    setActionError("");
    try {
      await onStart(task.trim(), mode, reasoningEffort, attachments);
    } catch (error) {
      setActionError(t(error instanceof Error ? error.message : String(error)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="state-page project-ready-page">
      <div className="state-hero">
        <span className="entry-project-icon"><Icon name="folder" size={25} /></span>
        <span className="eyebrow">{projectName}</span>
        <h1>{t("Let's build something")}</h1>
        <p>{t(readonly ? "Explore this project and make an inspectable plan. File writes are unavailable." : "Describe a task. Your agent can inspect, plan and work in this project with your active permissions.")}</p>
      </div>
      {connection.state !== "live" && <div className="connection-recovery" role="alert"><Icon name="alert" size={16} /><div><strong>{t("Let's get you connected")}</strong><p>{t("Try repairing the connection. If it still fails, open installation diagnostics.")}</p><details><summary>{t("Connection details")}</summary><p>{connection.message}</p></details></div>{onReconnect && <button className="button subtle" disabled={busy} onClick={() => { setBusy(true); void onReconnect().catch(() => setActionError(t("Couldn't reconnect. Open installation diagnostics for the next step."))).finally(() => setBusy(false)); }} type="button">{t("Repair connection")}</button>}{onOpenDiagnostics && <button className="button subtle" onClick={onOpenDiagnostics} type="button">{t("Installation diagnostics")}</button>}</div>}
      {!modelReady && connection.state === "live" && <ModelConnectionPrompt loading={modelLoading} error={modelError} onConnect={onConnectModel} />}
      {composer ?? <div className="ready-card">
        <textarea aria-label={t("Task")} disabled={busy || connection.state !== "live"} onChange={(event) => setTask(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && (enterBehavior === "enter" ? !(event.metaKey || event.ctrlKey) : event.metaKey || event.ctrlKey) && task.trim()) { event.preventDefault(); void start(); } }} placeholder={t("Describe what you want the Agent to do…")} rows={2} value={task} />
        <div className="ready-options">
          <div className="ready-control-row">{attachmentsAvailable && <AttachmentComposer minimal attachments={attachments} disabled={busy || connection.state !== "live"} onChange={setAttachments} />}{onCreateMedia && <button aria-label={t("Create media")} className="composer-tool-button" disabled={busy || connection.state !== "live"} onClick={onCreateMedia} type="button"><Icon name="spark" size={14} /></button>}<span className="composer-model">{modelName ?? t("Connect model")}</span>
            <div className="mode-picker" role="group" aria-label={t("Run mode")}>
              <button className={mode === "plan" ? "active" : ""} onClick={() => setMode("plan")} type="button"><Icon name="search" size={14} />{t("Plan")}</button>
              <button className={mode === "execute" ? "active" : ""} disabled={readonly} onClick={() => setMode("execute")} title={t(readonly ? "Execute is unavailable for a read-only project" : "Execute with the active permission policy")} type="button"><Icon name="play" size={14} />{t("Execute")}</button>
            </div>
            <ReasoningEffortPicker compact onChange={onReasoningEffortChange} value={reasoningEffort} />
          </div>
          <button className="button primary start-run" disabled={busy || connection.state !== "live" || !modelReady || task.trim().length === 0} onClick={() => void start()} type="button">{t(busy ? "Starting…" : "Start run")}<Icon name="send" size={14} /></button>
        </div>
      </div>}
      {actionError && <div className="entry-error" role="alert"><Icon name="alert" size={14} />{actionError}</div>}
      <div className="entry-suggestions" aria-label={t("Project starters")}>
        <button onClick={() => (onDraftChange ?? setTask)(t("Explain the structure of this project and its main entry points"))} type="button"><Icon name="search" size={16} /><span>{t("Explore this project")}</span></button>
        <button onClick={() => (onDraftChange ?? setTask)(t("Inspect the project and suggest a small, verifiable improvement"))} type="button"><Icon name="code" size={16} /><span>{t("Find an improvement")}</span></button>
      </div>
      <p className="entry-boundary-note"><Icon name="shield" size={13} />{t("Your permission policy applies to every tool call")}</p>
    </main>
  );
}

export function ChatView({
  client, runId, feedbackReadable = false, feedbackWritable = false, onReviewFile,
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
  currentStep,
  onInspectEvent,
  runDetails,
  generatedArtifacts, onLoadGeneratedArtifact, generatedPreviewsDisabled = false,
}: {
  client?: WorkbenchClient; runId?: string; feedbackReadable?: boolean; feedbackWritable?: boolean; onReviewFile?: (runId: string, path: string, patchEventId?: string) => void;
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
  currentStep?: string;
  onInspectEvent?: (event: TraceEvent) => void;
  runDetails?: ReactNode;
  generatedArtifacts?: readonly GeneratedArtifact[]; onLoadGeneratedArtifact?: (runId: string, artifactId: string) => Promise<GeneratedArtifactContent>; generatedPreviewsDisabled?: boolean;
}) {
  const { language, t } = useI18n();
  const endRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const response =
    status === "awaiting_plan_approval"
      ? language === "zh-CN" ? "规划已写入 Todo 清单，执行会保持暂停，直到你审批当前计划版本。" : "The plan is recorded in the Todo list. Execution stays paused until you approve this exact revision."
      : status === "needs_approval"
      ? language === "zh-CN" ? "限定范围的补丁预览正在审批关卡等待。允许写入前，请先审查已记录的差异和证据。" : "A scoped patch preview is waiting at the approval gate. Review the recorded diff and evidence before allowing the write."
      : status === "needs_manual_review"
        ? outcome ?? events.at(-1)?.summary ?? (language === "zh-CN" ? "工作区状态与 Action WAL 不一致。系统已停止自动修改，请检查持久化轨迹。" : "The workspace state differs from the Action WAL. Automatic changes stopped; inspect the durable trajectory.")
      : status === "failed" || status === "cancelled" || status === "interrupted"
        ? outcome ?? events.at(-1)?.summary ?? (language === "zh-CN" ? "本次运行没有生成最终回答，请查看任务活动中的失败步骤。" : "This run did not produce a final answer. Inspect the failed step in task activity.")
      : status === "completed" || status === "ready_for_review" || status === "historical"
        ? outcome ?? (language === "zh-CN" ? "本次任务已完成，可以查看结果。下方显示本次任务实际生成并验证的结果。" : "The task is ready for review. Verified results generated by this task are shown below.")
        : language === "zh-CN" ? "Agent 正在处理任务。请通过持久化轨迹查看最新的规范进度。" : "The Agent is processing the task. Follow the durable trajectory for the latest canonical progress.";
  useEffect(() => {
    if (followingRef.current) endRef.current?.scrollIntoView({ block: "end" });
  }, [conversation.length, events.length, outcome, publicActivities?.length, status, modelSurface?.length]);
  return (
    <section className="chat-view" onScroll={(event) => { const node = event.currentTarget; followingRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 72; }}>
      <div className="chat-date"><span />{t("Today")}<span /></div>
      {conversation.map((turn) => <ChatTurn generatedPreviewsDisabled={generatedPreviewsDisabled} {...(onLoadGeneratedArtifact ? { onLoadGeneratedArtifact } : {})} {...(turn.generatedArtifacts ? { generatedArtifacts: turn.generatedArtifacts } : {})} dataSource={dataSource} events={turn.events} key={turn.runId} runId={turn.runId} {...(client ? { client } : {})} feedbackReadable={feedbackReadable} feedbackWritable={feedbackWritable} {...(onReviewFile ? { onReviewFile } : {})} changedFiles={turn.changedFiles ?? []} response={turn.response} status={turn.status} task={turn.task} {...(turn.contextBudget === undefined ? {} : { contextBudget: turn.contextBudget })} {...(turn.elapsed === undefined ? {} : { elapsed: turn.elapsed })} {...(turn.inputTokens === undefined ? {} : { inputTokens: turn.inputTokens })} {...(turn.totalTokens === undefined ? {} : { totalTokens: turn.totalTokens })} />)}
      <ChatTurn {...(client ? { client } : {})} {...(runId ? { runId } : {})} feedbackReadable={feedbackReadable} feedbackWritable={feedbackWritable} {...(onReviewFile ? { onReviewFile } : {})} generatedPreviewsDisabled={generatedPreviewsDisabled} {...(onLoadGeneratedArtifact ? { onLoadGeneratedArtifact } : {})} {...(generatedArtifacts ? { generatedArtifacts } : {})} {...(runDetails === undefined ? {} : { runDetails })} {...(currentStep === undefined ? {} : { currentStep })} {...(onInspectEvent === undefined ? {} : { onInspectEvent })} changedFiles={changedFiles} dataSource={dataSource} events={events} evidence={evidence} progressive={progressive} response={response} status={status} task={task} {...(elapsed === undefined ? {} : { elapsed })} {...(inputTokens === undefined ? {} : { inputTokens })} {...(totalTokens === undefined ? {} : { totalTokens })} {...(contextBudget === undefined ? {} : { contextBudget })} {...(turnsCompleted === undefined ? {} : { turnsCompleted })} {...(turnLimit === undefined ? {} : { turnLimit })} {...(publicActivities === undefined ? {} : { publicActivities })} {...(modelSurface === undefined ? {} : { modelSurface })} />
      <div ref={endRef} />
    </section>
  );
}

function ChatTurn({ client, runId, feedbackReadable = false, feedbackWritable = false, onReviewFile, task, response, status, events, dataSource, changedFiles = [], evidence, contextBudget, turnsCompleted, turnLimit, publicActivities, modelSurface, elapsed, inputTokens, totalTokens, progressive = false, currentStep, onInspectEvent, runDetails, generatedArtifacts = [], onLoadGeneratedArtifact, generatedPreviewsDisabled = false }: {
  client?: WorkbenchClient; runId?: string; feedbackReadable?: boolean; feedbackWritable?: boolean; onReviewFile?: (runId: string, path: string, patchEventId?: string) => void;
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
  currentStep?: string;
  onInspectEvent?: (event: TraceEvent) => void;
  runDetails?: ReactNode;
  generatedArtifacts?: readonly GeneratedArtifact[]; onLoadGeneratedArtifact?: (runId: string, artifactId: string) => Promise<GeneratedArtifactContent>; generatedPreviewsDisabled?: boolean;
}) {
  const { language, t } = useI18n();
  const process = publicProcess(events, publicActivities);
  const active = status === "running" || status === "indexing" || status === "reconnecting";
  const persistedPlans = process
    .filter((event) => event.kind === "decision" && event.state === "succeeded" && Boolean(event.publicPlan?.trim()))
    .map((event) => ({
      id: `decision:${event.id}`,
      modelCallId: event.operationId ?? event.id,
      cursor: event.sequence,
      timestamp: event.timestamp,
      type: "public_plan_snapshot" as const,
      status: "completed" as const,
      text: event.publicPlan!.trim(),
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
  const operations = publicOperations(process);
  const latestOperation = [...operations].reverse().find((operation) => operation.family !== "event") ?? operations.at(-1);
  const publicStatement = visiblePlans.at(-1)?.text.split(/\n/).find((line) => line.trim()) ?? (active ? t("Waiting for the next update") : undefined);
  const answerTarget = latestPublicAnswer?.text ?? response;
  // A completed Run is durable state, not a new stream. ChatView is mounted
  // again when the user returns from Trajectory, so feeding `progressive`
  // through unconditionally would reset the hook's local cursor and replay
  // the entire answer from an empty string. Only live Run states should paint
  // incrementally; terminal states render the persisted answer immediately.
  const progressiveResponse = useProgressiveText(answerTarget, shouldUseProgressiveAnswer(status, progressive));
  const answerStreaming = (active && latestPublicAnswer?.status === "streaming") || progressiveResponse.length < answerTarget.length;
  return <>
    <article className="chat-message user-message" data-chat-role="user"><span className="avatar user-avatar">C</span><div className="chat-turn-body"><header><strong>{t("You")}</strong><time>{dataSource === "demo" ? "10:02" : t("recorded")}</time></header><p>{task}</p><MessageActions text={task} {...(client ? { client } : {})} /></div></article>
    <article className={`chat-message agent-message ${active ? "is-live" : ""}`} data-chat-role="agent"><span className="avatar agent-avatar"><Icon name="graph" size={15} /></span><div className="chat-turn-body">
      <header><strong>Outlive</strong><time>{dataSource === "demo" ? "10:02" : t(status === "running" || status === "indexing" ? "live" : "recorded")}</time></header>
      {(visiblePlans.length > 0 || progressEvents.length > 0 || active) && <section aria-label={t("Run activity")} title={t("Only explicit public plans and observed tool facts are shown")} className="compact-run-progress">
        {publicStatement && <p className="current-public-statement">{publicStatement}</p>}
        <details className="inline-activity-details">
          <summary><Icon name={latestOperation?.state === "failed" ? "alert" : latestOperation?.state === "started" ? "activity" : "check"} size={14} /><span>{latestOperation ? t(compactOperationLabel(latestOperation)) : t("Waiting for a public update")}</span>{latestOperation && <small>{t(latestOperation.state === "started" ? "Started" : latestOperation.state === "completed" ? "Completed" : latestOperation.state === "failed" ? "Failed" : latestOperation.state === "unknown" ? "Outcome unknown" : latestOperation.state === "cancelled" ? "Cancelled" : "Recorded")}</small>}<Icon name="chevron" size={12} /></summary>
          <div className="inline-activity-history">
            <PublicModelSurface active={active} events={process} language={language} surface={visiblePlans} />
            {runDetails}
            {onInspectEvent && <div className="activity-evidence-actions">{operations.map((operation) => <button className="button subtle" key={operation.id} onClick={() => onInspectEvent(operation.event)} type="button"><Icon name="file" size={12} />{t("Inspect evidence")} · {operation.event.title}</button>)}</div>}
          </div>
        </details>
      </section>}
      <div className={`chat-answer ${answerStreaming ? "is-streaming" : ""}`}>
      {latestPublicAnswer?.text
        ? <div aria-live="polite" className="chat-live-answer"><MarkdownContent content={progressiveResponse} />{(active || answerStreaming) && <span aria-hidden="true" className="public-model-caret">▍</span>}</div>
          : active ? null : <MarkdownContent content={progressiveResponse} />}
      </div>
      <GeneratedGallery artifacts={generatedArtifacts} disabled={generatedPreviewsDisabled} {...(onLoadGeneratedArtifact ? { onLoad: onLoadGeneratedArtifact } : {})} />
      {changedFiles.length > 0 && <section className="turn-changed-files" aria-label={t("Edited files")}><header><Icon name="diff" size={14} /><strong>{changedFiles.length} {t("Edited files")}</strong><small>+{totalDiff(changedFiles).additions} −{totalDiff(changedFiles).deletions}</small></header>{changedFiles.map((file) => <button disabled={!runId || !onReviewFile} onClick={() => { if (runId) onReviewFile?.(runId, file.path, file.patchEventId); }} key={file.path} type="button"><Icon name="file" size={13} /><span>{file.path}</span><small>+{file.additions} −{file.deletions}</small></button>)}</section>}
      {!active && !answerStreaming && answerTarget && <MessageActions text={answerTarget} {...(client ? { client } : {})} {...(runId ? { runId } : {})} feedbackReadable={feedbackReadable && status === "completed"} feedbackWritable={feedbackWritable && status === "completed"} />}
      <div className="chat-evidence" hidden>{changedFiles.length > 0 && <span><Icon name="diff" size={13} />{changedFiles.length} {t("files")} · +{totalDiff(changedFiles).additions} −{totalDiff(changedFiles).deletions}</span>}{evidence && <span><Icon name="graph" size={13} />{t("Graph")} {evidence.graph.status}</span>}<span><Icon name="shield" size={13} />{t(status)}</span></div>
      {!active && !answerStreaming && (elapsed || contextBudget) && <ChatRunSummary language={language} {...(contextBudget === undefined ? {} : { contextBudget })} {...(elapsed === undefined ? {} : { elapsed })} />}
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
      label: language === "zh-CN" ? "模型计划" : "Public plan",
      streaming: item.status === "streaming" && active,
    })),
    ...publicOperations(events.filter((event) => !(event.kind === "decision" && planCallIds.has(event.operationId ?? event.id))))
      .map((operation) => { const event = operation.event; return ({
        id: event.id,
        order: event.sequence,
        kind: "event" as const,
        status: operation.state,
        timestamp: event.timestamp,
        text: event.summary,
        label: progressEventLabel(event.kind, language, event.sourceType),
        streaming: operation.state === "started",
        detail: [event.toolName, event.target, operation.start ? `${operation.start.timestamp} · ${operation.start.summary}` : undefined].filter((value): value is string => Boolean(value)).join(" · ") || undefined,
      }); }),
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

function progressEventLabel(kind: TraceEvent["kind"], language: "zh-CN" | "en", sourceType?: string): string {
  if (language !== "zh-CN") {
    if (sourceType === "policy.evaluated" || sourceType === "policy.denied") return "Policy";
    if (sourceType === "model.request_started") return "Model request";
    if (sourceType === "model.decision") return "Model decision";
    if (sourceType?.startsWith("action.")) return "Validation";
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
  if (sourceType === "policy.evaluated" || sourceType === "policy.denied") return "策略";
  if (sourceType === "model.request_started") return "模型请求";
  if (sourceType === "model.decision") return "模型决策";
  if (sourceType?.startsWith("action.")) return "校验";
  const labels: Record<string, string> = {
    run: "运行",
    context: "上下文",
    decision: "决策",
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
    sourceType: activity.sourceEventType,
    ...(activity.operationId === undefined ? {} : { operationId: activity.operationId }),
  };
}

function ChatRunSummary({ contextBudget, elapsed, language }: {
  contextBudget?: ContextBudgetSnapshot;
  elapsed?: string;
  language: "zh-CN" | "en";
}) {
  const labels = language === "zh-CN"
    ? { elapsed: "运行", context: "上下文", healthy: "健康", warning: "预警", compressed: "已压缩" }
    : { elapsed: "Run", context: "Context", healthy: "Healthy", warning: "Warning", compressed: "Compressed" };
  const contextUsage = contextBudget
    ? `${formatTokens(contextBudget.usedTokens)} / ${formatTokens(contextBudget.inputBudgetTokens)}`
    : undefined;
  const statusLabel = contextBudget ? labels[contextBudget.status] : undefined;
  return <footer aria-label={language === "zh-CN" ? "运行摘要" : "Run summary"} className="chat-run-summary">
    {elapsed && <span><Icon name="clock" size={11} />{labels.elapsed} {elapsed}</span>}
    {contextUsage && <span><Icon name="layers" size={11} />{labels.context} {contextUsage}</span>}
    {statusLabel && <span className={`chat-run-summary-status is-${contextBudget?.status}`}>{statusLabel}</span>}
  </footer>;
}

function formatTokens(value: number): string {
  if (value < 1_000) return value.toLocaleString();
  const thousands = value / 1_000;
  return `${thousands >= 100 || Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1)}K`;
}
