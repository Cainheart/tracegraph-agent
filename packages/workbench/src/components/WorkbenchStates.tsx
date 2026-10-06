import { useEffect, useRef, useState, type ReactNode } from "react";
import { totalDiff, type ChangedFile, type ConnectionSnapshot, type ContextBudgetSnapshot, type ConversationTurn, type GeneratedArtifact, type EvidenceSnapshot, type ModelSurfaceSnapshot, type PendingAttachment, type PublicActivitySnapshot, type ReasoningEffort, type RunMode, type RunStatus, type TraceEvent } from "../model";
import { publicOperations } from "../public-progress";
import { ChatProcess, TurnFailure, UserMessageText } from "./ChatProcess";
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
  onCreateMedia, composer,
}: {
  composer?: ReactNode;
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
    <main className="state-page no-project-state">
      <div className="state-hero">
        <BrandMark />
        <h1>{t("Start using Outlive")}</h1>
      </div>
      {(connection.state === "connecting" || connection.state === "reconnecting") ? <div className="connection-recovery" role="status"><Icon name="refresh" size={16} /><p>{t(connection.state === "connecting" ? "Connecting to Outlive Agent…" : "Restoring your connection…")}</p></div> : connection.state !== "live" && (
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
        <div className="plain-chat-composer-footer">{attachmentsAvailable && <AttachmentComposer minimal attachments={attachments} disabled={chatting || connection.state !== "live"} onChange={setAttachments} />}{onCreateMedia && <button aria-label={t("Create media")} className="composer-tool-button" disabled={chatting || connection.state !== "live"} onClick={onCreateMedia} type="button"><Icon name="spark" size={14} /></button>}<span className="composer-model">{modelName ?? t("Connect model")}</span><ReasoningEffortPicker compact disabled={connection.state !== "live" || chatting} onChange={onReasoningEffortChange} value={reasoningEffort} /><button aria-label={t("Send message")} className="button primary composer-send" disabled={connection.state !== "live" || chatting || !modelReady || !chatTask.trim()} onClick={() => void startChat()} type="button"><Icon name="send" size={14} /></button></div>
      </div>}
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
  onConnectModel, onReconnect, onOpenDiagnostics, onCreateMedia, composer,
}: {
  composer?: ReactNode;
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
        <h1>{t("Start using Outlive")}</h1>
      </div>
      {(connection.state === "connecting" || connection.state === "reconnecting") ? <div className="connection-recovery" role="status"><Icon name="refresh" size={16} /><p>{t(connection.state === "connecting" ? "Connecting to Outlive Agent…" : "Restoring your connection…")}</p></div> : connection.state !== "live" && <div className="connection-recovery" role="alert"><Icon name="alert" size={16} /><div><strong>{t("Let's get you connected")}</strong><p>{t("Try repairing the connection. If it still fails, open installation diagnostics.")}</p><details><summary>{t("Connection details")}</summary><p>{connection.message}</p></details></div>{onReconnect && <button className="button subtle" disabled={busy} onClick={() => { setBusy(true); void onReconnect().catch(() => setActionError(t("Couldn't reconnect. Open installation diagnostics for the next step."))).finally(() => setBusy(false)); }} type="button">{t("Repair connection")}</button>}{onOpenDiagnostics && <button className="button subtle" onClick={onOpenDiagnostics} type="button">{t("Installation diagnostics")}</button>}</div>}
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
    </main>
  );
}

export function ChatView({
  client, runId, feedbackReadable = false, feedbackWritable = false, onReviewFile, onOpenProjectFile, onConfigureModel, onSaveAsMemory,
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
  generatedArtifacts, onLoadGeneratedArtifact, generatedPreviewsDisabled = false, generatedPreviewsDisabledReason,
}: {
  client?: WorkbenchClient; runId?: string; feedbackReadable?: boolean; feedbackWritable?: boolean; onReviewFile?: (runId: string, path: string, patchEventId?: string) => void; onOpenProjectFile?: (path: string) => void; onConfigureModel?: () => void; onSaveAsMemory?: (draft: { claim: string; sourceDescription: string }) => void;
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
  generatedArtifacts?: readonly GeneratedArtifact[]; onLoadGeneratedArtifact?: (runId: string, artifactId: string) => Promise<GeneratedArtifactContent>; generatedPreviewsDisabled?: boolean; generatedPreviewsDisabledReason?: string;
}) {
  const { language, t } = useI18n();
  const endRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
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
        ? outcome ?? (language === "zh-CN" ? "暂无最终回答，请查看已记录的任务活动。" : "The final response is unavailable. Inspect recorded task activity.")
        : language === "zh-CN" ? "Agent 正在处理任务。请通过持久化轨迹查看最新的规范进度。" : "The Agent is processing the task. Follow the durable trajectory for the latest canonical progress.";
  useEffect(() => {
    if (followingRef.current) endRef.current?.scrollIntoView({ block: "end" });
  }, [conversation.length, events.length, outcome, publicActivities?.length, status, modelSurface?.length]);
  return (
    <section className="chat-view" onScroll={(event) => { const node = event.currentTarget; followingRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 72; setShowJump(!followingRef.current); }}>
      <div className="chat-date"><span />{t("Today")}<span /></div>
      {conversation.map((turn) => <ChatTurn {...(onConfigureModel ? { onConfigureModel } : {})} {...(onOpenProjectFile ? { onOpenProjectFile } : {})} {...(onSaveAsMemory ? { onSaveAsMemory } : {})} {...(onInspectEvent ? { onInspectEvent } : {})} generatedPreviewsDisabled={generatedPreviewsDisabled} {...(generatedPreviewsDisabledReason ? { generatedPreviewsDisabledReason } : {})} {...(onLoadGeneratedArtifact ? { onLoadGeneratedArtifact } : {})} {...(turn.generatedArtifacts ? { generatedArtifacts: turn.generatedArtifacts } : {})} dataSource={dataSource} events={turn.events} key={turn.runId} runId={turn.runId} {...(client ? { client } : {})} feedbackReadable={feedbackReadable} feedbackWritable={feedbackWritable} {...(onReviewFile ? { onReviewFile } : {})} changedFiles={turn.changedFiles ?? []} response={turn.response} status={turn.status} task={turn.task} {...(turn.contextBudget === undefined ? {} : { contextBudget: turn.contextBudget })} {...(turn.elapsed === undefined ? {} : { elapsed: turn.elapsed })} {...(turn.inputTokens === undefined ? {} : { inputTokens: turn.inputTokens })} {...(turn.totalTokens === undefined ? {} : { totalTokens: turn.totalTokens })} />)}
      <ChatTurn {...(onConfigureModel ? { onConfigureModel } : {})} {...(onOpenProjectFile ? { onOpenProjectFile } : {})} {...(onSaveAsMemory ? { onSaveAsMemory } : {})} key={runId ?? "current"} {...(client ? { client } : {})} {...(runId ? { runId } : {})} feedbackReadable={feedbackReadable} feedbackWritable={feedbackWritable} {...(onReviewFile ? { onReviewFile } : {})} generatedPreviewsDisabled={generatedPreviewsDisabled} {...(generatedPreviewsDisabledReason ? { generatedPreviewsDisabledReason } : {})} {...(onLoadGeneratedArtifact ? { onLoadGeneratedArtifact } : {})} {...(generatedArtifacts ? { generatedArtifacts } : {})} {...(runDetails === undefined ? {} : { runDetails })} {...(currentStep === undefined ? {} : { currentStep })} {...(onInspectEvent === undefined ? {} : { onInspectEvent })} changedFiles={changedFiles} dataSource={dataSource} events={events} evidence={evidence} progressive={progressive} response={response} status={status} task={task} {...(elapsed === undefined ? {} : { elapsed })} {...(inputTokens === undefined ? {} : { inputTokens })} {...(totalTokens === undefined ? {} : { totalTokens })} {...(contextBudget === undefined ? {} : { contextBudget })} {...(turnsCompleted === undefined ? {} : { turnsCompleted })} {...(turnLimit === undefined ? {} : { turnLimit })} {...(publicActivities === undefined ? {} : { publicActivities })} {...(modelSurface === undefined ? {} : { modelSurface })} />
      <div ref={endRef} />
      {showJump && <button className="chat-jump-bottom" aria-label={language === "zh-CN" ? "回到底部" : "Jump to latest"} onClick={() => { followingRef.current = true; setShowJump(false); endRef.current?.scrollIntoView({ block: "end" }); }} type="button">↓</button>}
    </section>
  );
}

function ChatTurn({ client, runId, feedbackReadable = false, feedbackWritable = false, onReviewFile, onOpenProjectFile, onConfigureModel, onSaveAsMemory, task, response, status, events, dataSource, changedFiles = [], evidence, contextBudget, turnsCompleted, turnLimit, publicActivities, modelSurface, elapsed, inputTokens, totalTokens, progressive = false, currentStep, onInspectEvent, runDetails, generatedArtifacts = [], onLoadGeneratedArtifact, generatedPreviewsDisabled = false, generatedPreviewsDisabledReason }: {
  client?: WorkbenchClient; runId?: string; feedbackReadable?: boolean; feedbackWritable?: boolean; onReviewFile?: (runId: string, path: string, patchEventId?: string) => void; onOpenProjectFile?: (path: string) => void; onConfigureModel?: () => void; onSaveAsMemory?: (draft: { claim: string; sourceDescription: string }) => void;
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
  generatedArtifacts?: readonly GeneratedArtifact[]; onLoadGeneratedArtifact?: (runId: string, artifactId: string) => Promise<GeneratedArtifactContent>; generatedPreviewsDisabled?: boolean; generatedPreviewsDisabledReason?: string;
}) {
  const { language, t } = useI18n();
  const [filesExpanded, setFilesExpanded] = useState(false);
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
  const latestPublicAnswer = active ? currentAnswerDraft(safeModelSurface, process) : undefined;
  const answerTarget = active ? latestPublicAnswer?.text ?? "" : response;
  const mediaEvent = events.filter((event) => ["generate_image", "render_diagram", "render_chart"].includes(event.toolName ?? "")).at(-1);
  const mediaActivity = generatedArtifacts.length || !mediaEvent ? undefined : mediaEvent.state === "failed" || mediaEvent.state === "denied" || ["failed", "interrupted", "cancelled", "needs_manual_review"].includes(status)
    ? { state: "failed" as const }
    : status === "completed" || status === "ready_for_review" || status === "historical"
      ? { state: "failed" as const, message: "The media operation ended without a verified Artifact in this Run." }
      : { state: "running" as const };
  // A completed Run is durable state, not a new stream. ChatView is mounted
  // again when the user returns from Trajectory, so feeding `progressive`
  // through unconditionally would reset the hook's local cursor and replay
  // the entire answer from an empty string. Only live Run states should paint
  // incrementally; terminal states render the persisted answer immediately.
  const progressiveResponse = useProgressiveText(answerTarget, shouldUseProgressiveAnswer(status, progressive));
  const answerStreaming = active && Boolean(latestPublicAnswer) && (latestPublicAnswer?.status === "streaming" || progressiveResponse.length < answerTarget.length);
  return <>
    <article className="chat-message user-message" data-chat-role="user"><span className="avatar user-avatar">C</span><div className="chat-turn-body"><header><strong>{t("You")}</strong><time>{dataSource === "demo" ? "10:02" : t("recorded")}</time></header><UserMessageText text={task} /></div><MessageActions text={task} {...(client ? { client } : {})} /></article>
    <article className={`chat-message agent-message ${active ? "is-live" : ""}`} data-chat-role="agent"><span className="avatar agent-avatar"><Icon name="graph" size={15} /></span><div className="chat-turn-body">
      <header><strong>Outlive</strong><time>{dataSource === "demo" ? "10:02" : t(status === "running" || status === "indexing" ? "live" : "recorded")}</time></header>
      <ChatProcess events={process} plans={visiblePlans} active={active} {...(runId ? { runId } : {})} {...(client ? { client } : {})} {...(elapsed ? { elapsed } : {})} {...(onInspectEvent ? { onInspectEvent } : {})} {...(onOpenProjectFile ? { onOpenProjectFile } : {})} />
      {(["failed", "interrupted", "needs_manual_review", "cancelled"] as readonly RunStatus[]).includes(status) && <TurnFailure {...(onConfigureModel ? { onConfigureModel } : {})} message={response} status={status} {...(onInspectEvent && events.at(-1) ? { onInspect: () => onInspectEvent(events.at(-1)!) } : {})} />}
      <div className={`chat-answer ${answerStreaming ? "is-streaming" : ""}`}>
      {active
        ? latestPublicAnswer?.text && <div aria-live="polite" className="chat-live-answer" aria-label={t("Answer draft — not verified")}><p><strong>{t("Answer draft — not verified")}</strong></p><MarkdownContent content={progressiveResponse} />{answerStreaming && <span aria-hidden="true" className="public-model-caret">▍</span>}</div>
        : !(["failed", "interrupted", "needs_manual_review", "cancelled"] as readonly RunStatus[]).includes(status) && <MarkdownContent content={response} />}
      </div>
      <GeneratedGallery artifacts={generatedArtifacts} disabled={generatedPreviewsDisabled} autoPreview={!active} {...(mediaActivity ? { activity: mediaActivity } : {})} {...(generatedPreviewsDisabledReason ? { disabledReason: generatedPreviewsDisabledReason } : {})} {...(onLoadGeneratedArtifact ? { onLoad: onLoadGeneratedArtifact } : {})} />
      {changedFiles.length > 0 && <section className="turn-changed-files" aria-label={t("Edited files")}><header><Icon name="diff" size={14} /><strong>{changedFiles.length} {t("Edited files")}</strong><small>+{totalDiff(changedFiles).additions} −{totalDiff(changedFiles).deletions}</small></header>{(filesExpanded ? changedFiles : changedFiles.slice(0, 3)).map((file) => <button disabled={!runId || !onReviewFile} onClick={() => { if (runId) onReviewFile?.(runId, file.path, file.patchEventId); }} key={file.path} type="button"><Icon name="file" size={13} /><span>{file.path}</span><small>+{file.additions} −{file.deletions}</small></button>)}{changedFiles.length > 3 && <button className="turn-more-files" aria-expanded={filesExpanded} onClick={() => setFilesExpanded(!filesExpanded)} type="button">{language === "zh-CN" ? filesExpanded ? "收起文件" : `再显示 ${changedFiles.length - 3} 个文件` : filesExpanded ? "Show fewer files" : `Show ${changedFiles.length - 3} more files`}<Icon name="chevron" size={12} /></button>}</section>}
      <div className="chat-evidence" hidden>{changedFiles.length > 0 && <span><Icon name="diff" size={13} />{changedFiles.length} {t("files")} · +{totalDiff(changedFiles).additions} −{totalDiff(changedFiles).deletions}</span>}{evidence && <span><Icon name="graph" size={13} />{t("Graph")} {evidence.graph.status}</span>}<span><Icon name="shield" size={13} />{t(status)}</span></div>
      {!active && !answerStreaming && (elapsed || contextBudget) && <>
        <ChatRunSummary language={language} {...(contextBudget === undefined ? {} : { contextBudget })} {...(elapsed === undefined ? {} : { elapsed })} />
        {runDetails && <details className="turn-diagnostics"><summary>{language === "zh-CN" ? "任务诊断" : "Task diagnostics"}</summary>{runDetails}</details>}
      </>}
    </div>{!active && !answerStreaming && answerTarget && <MessageActions text={answerTarget} {...(client ? { client } : {})} {...(runId ? { runId } : {})} feedbackReadable={feedbackReadable && status === "completed"} feedbackWritable={feedbackWritable && status === "completed"} {...(onSaveAsMemory && runId && status === "completed" ? { onSaveAsMemory: (claim: string) => { const answerEvent = events.find((event) => event.sourceType === "run.completed"); if (answerEvent) onSaveAsMemory({ claim, sourceDescription: `来自 Run ${runId} 的最终回答事件 ${answerEvent.id}` }); } } : {})} />}</article>
  </>;
}

export function shouldUseProgressiveAnswer(status: RunStatus, enabled: boolean): boolean {
  return enabled && (status === "indexing" || status === "running" || status === "reconnecting");
}

/**
 * Surface cursors are not ledger sequence numbers. A draft belongs only to
 * its explicit model call; a recorded decision settles that candidate before
 * delivery review or verification can accept or reject the task as a whole.
 */
function currentAnswerDraft(surface: readonly ModelSurfaceSnapshot[], events: readonly TraceEvent[]): ModelSurfaceSnapshot | undefined {
  const candidate = surface.filter((item) => item.type === "answer_snapshot").at(-1);
  if (!candidate?.text || candidate.status === "failed" || candidate.status === "cancelled") return undefined;
  const modelEvents = events.filter((event) => event.sourceType === "model.request_started"
    || event.sourceType === "model.decision" || event.sourceType === "model.request_failed"
    || event.sourceType === "model.output_invalid" || event.sourceType === "model.request_cancelled");
  if (modelEvents.some((event) => event.sourceType !== "model.request_started"
    && (event.operationId === candidate.modelCallId || event.operationId === undefined))) return undefined;
  const latestRequest = modelEvents.filter((event) => event.sourceType === "model.request_started").at(-1);
  if (latestRequest && latestRequest.operationId !== candidate.modelCallId) return undefined;
  // Older Hosts without model-operation history retain compatibility drafts.
  // Once history exists, an unbound candidate cannot borrow another call's
  // authority or survive a reconnect window containing its recorded decision.
  if (modelEvents.length > 0 && !modelEvents.some((event) => event.operationId === candidate.modelCallId)) return undefined;
  return candidate;
}

/** Animate only live, explicitly provisional public text. Terminal results are immediate. */
function useProgressiveText(target: string, enabled: boolean): string {
  const [visible, setVisible] = useState(enabled ? "" : target);
  const matchingVisible = target.startsWith(visible) ? visible : "";

  useEffect(() => {
    setVisible((current) => !enabled ? target : target.startsWith(current) ? current : "");
  }, [enabled, target]);

  useEffect(() => {
    const characters = Array.from(target);
    if (!enabled || Array.from(matchingVisible).length >= characters.length) return;
    // Array.from keeps emoji/CJK code points intact. A changed or withdrawn
    // candidate is hidden synchronously, before this timer/effect can paint.
    const timer = window.setTimeout(() => {
      setVisible((current) => characters.slice(0, (target.startsWith(current) ? Array.from(current).length : 0) + 2).join(""));
    }, 28);
    return () => window.clearTimeout(timer);
  }, [enabled, target, matchingVisible]);

  return enabled ? matchingVisible : target;
}

export const PUBLIC_ACTIVITY_PAGE_SIZE = 80;

export function PublicModelSurface({
  surface,
  events,
  active,
  language,
  onInspectEvent,
}: {
  surface: readonly ModelSurfaceSnapshot[];
  events: readonly TraceEvent[];
  active: boolean;
  language: "zh-CN" | "en";
  onInspectEvent?: (event: TraceEvent) => void;
}) {
  // `thinking_snapshot` is retained in the wire schema for reconnect
  // compatibility only.  It represents provider-private reasoning and must
  // not be rendered as if it were a user-safe explanation.
  const plans = surface.filter((item) => item.type === "public_plan_snapshot");
  const latestPlan = plans.at(-1);
  const visiblePlanText = useProgressiveText(latestPlan?.text ?? "", active && latestPlan?.status === "streaming");
  const [visibleCount, setVisibleCount] = useState(PUBLIC_ACTIVITY_PAGE_SIZE);
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
      event: undefined,
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
        event,
        detail: [event.toolName, event.target, operation.start ? `${operation.start.timestamp} · ${operation.start.summary}` : undefined].filter((value): value is string => Boolean(value)).join(" · ") || undefined,
      }); }),
  ].sort((left, right) => left.order - right.order);
  const shown = timeline.slice(-visibleCount);
  const hidden = timeline.length - shown.length;
  const earlierFailures = timeline.slice(0, hidden).filter((item) => item.status === "failed" || item.status === "unknown").length;

  return <div aria-live="polite" className="public-model-surface">
    {hidden > 0 && <div className="public-activity-pagination"><button className="button subtle" onClick={() => setVisibleCount((count) => count + PUBLIC_ACTIVITY_PAGE_SIZE)} type="button">{language === "zh-CN" ? `查看更早的活动（${hidden}）` : `Show earlier activity (${hidden})`}</button>{earlierFailures > 0 && <span role="status">{language === "zh-CN" ? `更早记录含 ${earlierFailures} 项失败或未知结果` : `${earlierFailures} earlier failed or unknown outcomes`}</span>}</div>}
    {shown.map((item) => <PublicActivityRow key={item.id} item={item} {...(onInspectEvent ? { onInspectEvent } : {})} />)}
    {active && timeline.length === 0 && <p className="public-model-awaiting">{language === "zh-CN" ? "等待模型提供下一步公开进度…" : "Waiting for the next public model update…"}</p>}
  </div>;
}

function PublicActivityRow({ item, onInspectEvent }: {
  item: { id: string; kind: "event" | "plan"; status: string; timestamp: string; text: string; label: string; streaming: boolean; detail?: string | undefined; event?: TraceEvent | undefined };
  onInspectEvent?: (event: TraceEvent) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const firstLine = item.text.split(/\n/u).find((line) => line.trim()) ?? item.text;
  return <details className={`public-progress-item is-${item.kind} is-${item.status} is-disclosure`} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><span className="public-progress-meta"><span>{item.label}</span><time>{item.timestamp}</time></span><span className="public-progress-copy">{firstLine}{item.streaming && <span aria-hidden="true" className="public-model-caret">▍</span>}</span><Icon aria-hidden="true" className="public-progress-chevron" name="chevron" size={13} /></summary>
    <div className="public-progress-detail" hidden={!open}>{open && <><p>{item.text}</p>{item.detail && <code>{item.detail}</code>}{item.event && onInspectEvent && <button className="button subtle" onClick={() => onInspectEvent(item.event!)} type="button"><Icon name="file" size={12} />{t("Inspect evidence")}</button>}</>}</div>
  </details>;
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
