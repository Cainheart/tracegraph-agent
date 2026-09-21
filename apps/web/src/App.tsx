import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { WorkbenchClient } from "./client";
import { ApprovalStrip } from "./components/ApprovalStrip";
import { ChangesView } from "./components/ChangesView";
import { Icon } from "./components/Icon";
import { Inspector } from "./components/Inspector";
import { PlanApprovalBanner } from "./components/PlanApprovalBanner";
import { ReplayBanner } from "./components/ReplayBanner";
import { BrandMark, IconButton, Notice, StatusPill } from "./components/Primitives";
import { Sidebar } from "./components/Sidebar";
import { SettingsPanel, type Theme } from "./components/SettingsPanel";
import { Trajectory } from "./components/Trajectory";
import { ChatView, NoProject, ProjectReady } from "./components/WorkbenchStates";
import { ReasoningEffortPicker } from "./components/ReasoningEffortPicker";
import { SandboxBadge } from "./components/SandboxBadge";
import { SteeringComposer } from "./components/SteeringComposer";
import { LiveTraceGraphClient } from "./live-client";
import { LanguageProvider, useI18n } from "./i18n";
import { canUseExecuteMode, evidenceForSelection, totalDiff, type MainView, type PendingAttachment, type ReasoningEffort, type RunMode, type RunStatus, type TraceEvent, type WorkspaceKind } from "./model";
import type { TaskBoardItem, TodoItem, TodoState, UserInputKind } from "@tracegraph/contracts";

const defaultClient: WorkbenchClient = new LiveTraceGraphClient({ baseUrl: import.meta.env.VITE_TRACEGRAPH_API_URL ?? "" });

const THEME_STORAGE_KEY = "tracegraph.theme";
const REASONING_STORAGE_KEY = "tracegraph.reasoning-effort";

export function replayDirectionForKeyboard(input: {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  targetTagName?: string;
  targetContentEditable?: boolean;
}): -1 | 1 | null {
  if (
    input.defaultPrevented
    || input.isComposing
    || input.altKey
    || input.ctrlKey
    || input.metaKey
    || input.shiftKey
    || input.targetContentEditable
    || ["INPUT", "TEXTAREA", "SELECT"].includes(input.targetTagName?.toUpperCase() ?? "")
  ) return null;
  if (input.key === "ArrowLeft") return -1;
  if (input.key === "ArrowRight") return 1;
  return null;
}

export function replayTargetForEventSelection(
  dataSource: "demo" | "live",
  sequence: number,
): number | null {
  return dataSource === "live" ? sequence : null;
}

function initialTheme(): Theme {
  // TraceGraph is a long-running workbench: keep the first-run surface close
  // to the dark, low-glare desktop tools users already expect, while still
  // respecting an explicit local preference.
  if (typeof window === "undefined") return "dark";
  const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
  return saved === "dark" || saved === "light" ? saved : "dark";
}

function initialReasoningEffort(): ReasoningEffort {
  // Keep first-run interactions responsive. Users can still choose the
  // provider default or a stronger level from the picker and that choice is
  // persisted locally.
  if (typeof window === "undefined") return "low";
  const saved = window.localStorage.getItem(REASONING_STORAGE_KEY);
  return saved === "low" || saved === "medium" || saved === "high" || saved === "xhigh" || saved === "max" || saved === "default" ? saved : "low";
}

function todoUpdateDisabledReason(status: RunStatus): string | null {
  if (status === "interrupted") return "Todo changes are unavailable while the Run is interrupted. Resume the Run first.";
  if (status === "needs_manual_review") return "Todo changes are unavailable while the Run needs manual review.";
  if (status === "completed" || status === "failed" || status === "cancelled" || status === "ready_for_review" || status === "historical") {
    return "Todo changes are unavailable after the Run has stopped.";
  }
  return null;
}

function teamUpdateDisabledReason(status: RunStatus): string | null {
  if (status === "interrupted") return "Agent Team changes are unavailable while the Run is interrupted. Resume the Run first.";
  if (status === "needs_manual_review") return "Agent Team changes are unavailable while the Run needs manual review.";
  if (status === "completed" || status === "failed" || status === "cancelled" || status === "ready_for_review" || status === "historical") {
    return "Agent Team changes are unavailable after the Run has stopped.";
  }
  return null;
}

function useSnapshot(client: WorkbenchClient) {
  return useSyncExternalStore(
    (listener) => client.subscribe(listener),
    () => client.getSnapshot(),
    () => client.getSnapshot(),
  );
}

function RunHeader({
  view,
  snapshot,
  onViewChange,
  onStop,
  onOpenInspector,
  stopDisabled,
  replayReadOnly,
}: {
  view: MainView;
  snapshot: ReturnType<WorkbenchClient["getSnapshot"]>;
  onViewChange: (view: MainView) => void;
  onStop: () => void;
  onOpenInspector: () => void;
  stopDisabled: boolean;
  replayReadOnly: boolean;
}) {
  const { t } = useI18n();
  const { project, run } = snapshot;
  const totals = totalDiff(snapshot.changedFiles);
  return (
    <>
      <header className="app-header">
        <BrandMark />
        <div className="header-project">
          {project ? <><Icon name="branch" size={14} /><strong>{project.name}</strong>{project.branch && <><span>/</span><code>{project.branch}</code></>}</> : run ? <><Icon name="message" size={14} /><strong>{t("Plain chat")}</strong></> : <span>{t("No project selected")}</span>}
        </div>
        {run && <div className="header-run-metrics"><StatusPill status={run.status} />{run.permission && <span className={`permission-badge ${run.permission.sandbox_mode === "danger-full-access" ? "permission-danger" : ""}`} title={`${t("Permission preset")}: ${t(run.permission.label)}`}><Icon name="shield" size={12} />{t(run.permission.label)}</span>}{run.sandboxReport && <SandboxBadge report={run.sandboxReport} />}{snapshot.changedFiles.length > 0 && <span className="diff-stat"><i>+{totals.additions}</i><b>−{totals.deletions}</b></span>}</div>}
        <div className="header-actions"><span className={`host-chip connection-${snapshot.connection.state}`} title={snapshot.connection.message}><i />{snapshot.connection.state === "live" ? t("Local") : t(snapshot.connection.state)}</span></div>
      </header>
      {run && (
        <div className="run-nav">
          <div className="run-nav-spacer" aria-hidden="true" />
          <nav aria-label={t("Workbench views")}>
            {(["chat", "trajectory", "changes"] as const).map((item) => (
              <button aria-current={view === item ? "page" : undefined} className={view === item ? "active" : ""} key={item} onClick={() => onViewChange(item)} type="button">{t(item)}</button>
            ))}
          </nav>
          <div className="run-nav-actions">
            {view === "trajectory" && <button className="button subtle responsive-inspector-trigger" onClick={onOpenInspector} type="button"><Icon name="sidebar" size={13} />{t("Inspector")}</button>}
            {(run.status === "running" || run.status === "indexing" || run.status === "reconnecting" || run.status === "awaiting_plan_approval" || run.status === "needs_approval") && <button className="button subtle stop-button" disabled={stopDisabled || replayReadOnly} onClick={onStop} type="button"><Icon name="stop" size={13} />{t("Stop")}</button>}
            {run.status === "historical" && <span className="readonly-chip"><Icon name="clock" size={13} />{t("Read-only history")}</span>}
          </div>
        </div>
      )}
    </>
  );
}

export function StateNotice({ status, sessionViewState, onResumeSession, onReview, onRefresh, currentStep, lastSequence, connectionMessage, indexedFiles, scanScope, readOnly = false }: { status: RunStatus; sessionViewState: "restored" | "resumed" | null; onResumeSession: () => void; onReview: () => void; onRefresh: () => void; currentStep: string; lastSequence: number; connectionMessage: string; indexedFiles: number | undefined; scanScope: string | undefined; readOnly?: boolean }) {
  const { language, t } = useI18n();
  if (status === "interrupted") return <Notice action={readOnly ? undefined : <button className="button primary" onClick={onResumeSession} type="button"><Icon name="play" size={13} />{t("Resume session")}</button>} icon="alert" title={t("Last session was interrupted")} tone="warning">{t("The durable view was recovered. No tool was rerun automatically.")}</Notice>;
  if (status === "needs_manual_review") return <Notice icon="alert" title={t("Needs manual review")} tone="warning">{t("The workspace no longer matches the Action WAL. TraceGraph did not change files automatically.")}</Notice>;
  if (sessionViewState === "restored") return <Notice icon="clock" title={t("Recovered session view")} tone="info">{t("This view was rebuilt from the durable ledger. Opening it did not execute tools.")}</Notice>;
  if (sessionViewState === "resumed") return <Notice icon="refresh" title={t("Session resumed")} tone="success">{t("The Host appended a resume event and restored the canonical projection.")}</Notice>;
  if (status === "indexing") return <Notice icon="search" title={t("Building the baseline graph")} tone="info">{scanScope ? (language === "zh-CN" ? `正在扫描 ${scanScope}` : `Scanning ${scanScope}`) : currentStep}{indexedFiles === undefined ? ` · ${t("progress is event-based")}` : language === "zh-CN" ? ` · 已处理 ${indexedFiles} 个文件` : ` · ${indexedFiles} files processed`} · {t("no percentage estimated")}</Notice>;
  if (status === "reconnecting") return <Notice action={<button className="button subtle" onClick={onRefresh} type="button"><Icon name="refresh" size={13} />{t("Retry now")}</button>} icon="refresh" title={t("Reconnecting to the local host")} tone="warning">{language === "zh-CN" ? `已保留最后一个持久化事件 #${lastSequence}。` : `Last durable event #${lastSequence} is preserved.`} {connectionMessage}</Notice>;
  if (status === "failed") return <Notice icon="alert" title={t("Run stopped safely")} tone="danger">{currentStep}{language === "zh-CN" ? "。此前已提交的事件仍可检查。" : ". Earlier committed events remain available for inspection."}</Notice>;
  if (status === "cancelled") return <Notice icon="stop" title={t("Run cancelled")} tone="warning">{currentStep}</Notice>;
  if (status === "ready_for_review") return <Notice action={<button className="button primary" onClick={onReview} type="button">{t("Review changes")} <Icon name="chevron" size={13} /></button>} icon="check" title={t("Ready for review")} tone="success">{t("Patch, graph delta, and test receipt are linked and ready to inspect.")}</Notice>;
  if (status === "historical") return <Notice icon="clock" title={t("Historical run")} tone="info">{t("This projection is read-only. Opening it never executes tools.")}</Notice>;
  return null;
}

function Workbench({ client }: { client: WorkbenchClient }) {
  const { t } = useI18n();
  const snapshot = useSnapshot(client);
  const [view, setView] = useState<MainView>("trajectory");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tailFollowing, setTailFollowing] = useState(true);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(initialReasoningEffort);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [planApprovalBusy, setPlanApprovalBusy] = useState(false);
  const [planApprovalError, setPlanApprovalError] = useState<string | null>(null);
  const [busyTodoId, setBusyTodoId] = useState<string | null>(null);
  const [todoError, setTodoError] = useState<string | null>(null);
  const [teamBusyKey, setTeamBusyKey] = useState<string | null>(null);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [followupTask, setFollowupTask] = useState("");
  const [followupAttachments, setFollowupAttachments] = useState<readonly PendingAttachment[]>([]);
  const [followupBusy, setFollowupBusy] = useState(false);
  const [steeringKind, setSteeringKind] = useState<Exclude<UserInputKind, "cancel">>("message");
  const [steeringBusy, setSteeringBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [steeringError, setSteeringError] = useState<string | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  const run = snapshot.run;
  const replay = snapshot.replay;
  const replayReadOnly = replay !== undefined;
  const todoDisabledReason = run === null ? null : todoUpdateDisabledReason(run.status);
  const teamDisabledReason = run === null ? null : teamUpdateDisabledReason(run.status);
  const selectedEvent = useMemo(() => run?.events.find((event) => event.id === selectedId) ?? null, [run, selectedId]);
  const displayedEvent = selectedEvent ?? run?.events.at(-1) ?? null;
  const selectedEvidence = useMemo(
    () => evidenceForSelection(snapshot, selectedEvent),
    [selectedEvent, snapshot],
  );
  const patchEvent = useMemo(() => [...(run?.events ?? [])].reverse().find((event) => event.kind === "patch") ?? null, [run]);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const configureModel = useCallback((input: Parameters<WorkbenchClient["configureModel"]>[0]) => (
    client.configureModel(input)
  ), [client]);
  const configurePermissionPreset = useCallback((input: Parameters<WorkbenchClient["configurePermissionPreset"]>[0]) => (
    client.configurePermissionPreset(input)
  ), [client]);
  const getModelConfig = useCallback(() => client.getModelConfig(), [client]);
  const getPermissionConfig = useCallback(() => client.getPermissionConfig(), [client]);
  const getTelemetryStatus = useCallback(() => client.getTelemetryStatus(), [client]);
  const getUsage = useCallback(() => client.getUsage(), [client]);
  const listExtensions = useCallback(() => client.listExtensions(), [client]);
  const reloadExtension = useCallback((extensionName: string) => client.reloadExtension(extensionName), [client]);
  const listSkills = useCallback(() => client.listSkills(), [client]);
  const getMcpStatus = useCallback(() => client.getMcpStatus(), [client]);
  const getLspStatus = useCallback(() => client.getLspStatus(), [client]);

  useEffect(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    document.documentElement.style.colorScheme = theme;
    window.dispatchEvent(new CustomEvent("tracegraph:themechange", { detail: theme }));
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem(REASONING_STORAGE_KEY, reasoningEffort);
  }, [reasoningEffort]);

  useEffect(() => {
    if (run?.status === "empty" || !run) setView("trajectory");
  }, [run]);

  useEffect(() => {
    if (!run) {
      setSelectedId(null);
      return;
    }
    if (selectedId && !run.events.some((event) => event.id === selectedId)) {
      setSelectedId(null);
    }
  }, [run, selectedId]);

  useEffect(() => {
    setTodoError(null);
    setPlanApprovalError(null);
    setSteeringError(null);
  }, [run?.id, run?.pendingPlan?.eventId]);

  useEffect(() => {
    if (!replay || !run) return;
    const replayedEvent = run.events.find(({ sequence }) => sequence === replay.requestedSequence);
    if (replayedEvent) setSelectedId(replayedEvent.id);
    setSettingsOpen(false);
  }, [replay, run]);

  useEffect(() => {
    if (!replay) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const direction = replayDirectionForKeyboard({
        key: event.key,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        isComposing: event.isComposing,
        defaultPrevented: event.defaultPrevented,
        ...(target === null ? {} : {
          targetTagName: target.tagName,
          targetContentEditable: target.isContentEditable,
        }),
      });
      if (direction === null) return;
      event.preventDefault();
      setReplayError(null);
      void client.stepReplay(direction).catch((error: unknown) => {
        setReplayError(error instanceof Error ? error.message : "Replay step failed");
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [client, replay]);

  const selectEvent = (event: TraceEvent) => {
    setSelectedId(event.id);
    setTailFollowing(event.id === run?.events.at(-1)?.id);
    const replayTarget = replayTargetForEventSelection(snapshot.dataSource, event.sequence);
    if (replayTarget !== null) {
      setReplayError(null);
      void client.enterReplay(replayTarget).catch((error: unknown) => {
        setReplayError(error instanceof Error ? error.message : "Replay could not be opened");
      });
    }
  };

  const returnToLive = () => {
    setReplayError(null);
    void client.returnToLive().then(() => {
      setSelectedId(null);
      setTailFollowing(true);
    }).catch((error: unknown) => {
      setReplayError(error instanceof Error ? error.message : "Could not return to the live projection");
    });
  };

  const chooseProject = (kind: WorkspaceKind) => void client.chooseProject(kind);
  const previewState = (status: RunStatus) => {
    setView(status === "completed" || status === "ready_for_review" || status === "historical" ? "changes" : "trajectory");
    setSelectedId(status === "needs_approval" ? "evt_012" : null);
    void client.previewState(status);
  };
  const startRun = async (task: string, mode: RunMode, effort: ReasoningEffort = reasoningEffort, attachments: readonly PendingAttachment[] = []) => {
    setView("chat");
    setSelectedId(null);
    setTailFollowing(true);
    await client.startRun(task, mode, effort, attachments);
  };
  const startChat = async (task: string, effort: ReasoningEffort = reasoningEffort, attachments: readonly PendingAttachment[] = []) => {
    setView("chat");
    setSelectedId(null);
    setTailFollowing(true);
    await client.startChat(task, effort, attachments);
  };
  const approve = async () => {
    if (!run?.approval) return;
    setApprovalBusy(true);
    try {
      await client.approve(run.approval.id);
      setView("changes");
      const nextEvents = client.getSnapshot().run?.events ?? [];
      setSelectedId([...nextEvents].reverse().find((event) => event.patchRef)?.id ?? nextEvents.at(-1)?.id ?? null);
    } finally {
      setApprovalBusy(false);
    }
  };
  const reject = async () => {
    if (!run?.approval) return;
    setApprovalBusy(true);
    try { await client.reject(run.approval.id); } finally { setApprovalBusy(false); }
  };
  const approvePlan = async () => {
    if (!run?.pendingPlan) return;
    setPlanApprovalError(null);
    setPlanApprovalBusy(true);
    try {
      await client.approvePlan();
    } catch (error) {
      setPlanApprovalError(error instanceof Error ? error.message : "Plan approval failed");
    } finally {
      setPlanApprovalBusy(false);
    }
  };
  const updateTodo = async (todo: TodoItem, state: TodoState) => {
    if (todo.state === state) return;
    setTodoError(null);
    setBusyTodoId(todo.todo_id);
    try {
      await client.updateTodo({ operation: "update", todo_id: todo.todo_id, state });
    } catch (error) {
      setTodoError(error instanceof Error ? error.message : "Todo update failed");
    } finally {
      setBusyTodoId(null);
    }
  };
  const createTeam = async () => {
    setTeamError(null);
    setTeamBusyKey("create");
    try {
      await client.createTeam();
    } catch (error) {
      setTeamError(error instanceof Error ? error.message : "Agent Team creation failed");
    } finally {
      setTeamBusyKey(null);
    }
  };
  const steerTeamMember = async (subagentId: string, payload: string) => {
    setTeamError(null);
    setTeamBusyKey(`member:${subagentId}`);
    try {
      await client.steerTeamMember(subagentId, payload);
      return true;
    } catch (error) {
      setTeamError(error instanceof Error ? error.message : "Team steer failed");
      return false;
    } finally {
      setTeamBusyKey(null);
    }
  };
  const cancelTeamTask = async (task: TaskBoardItem) => {
    setTeamError(null);
    setTeamBusyKey(`task:${task.task_id}`);
    try {
      await client.cancelTeamTask(task);
    } catch (error) {
      setTeamError(error instanceof Error ? error.message : "Team task cancellation failed");
    } finally {
      setTeamBusyKey(null);
    }
  };
  const jumpToPatch = () => {
    setView("trajectory");
    const linkedPatch = run?.events.find((event) => event.id === selectedEvidence.patchEventId);
    const source = selectedEvent ? linkedPatch : (linkedPatch ?? patchEvent);
    if (source) {
      setSelectedId(source.id);
      setTailFollowing(source.id === run?.events.at(-1)?.id);
    }
  };
  const reviewLatest = () => {
    setSelectedId(null);
    setTailFollowing(true);
    setView("changes");
  };
  const reviewPendingPatch = () => {
    setSelectedId(patchEvent?.id ?? null);
    setTailFollowing(patchEvent?.id === run?.events.at(-1)?.id);
    setView("changes");
  };
  const startFollowup = async () => {
    if (!followupTask.trim()) return;
    setFollowupBusy(true);
    try {
      if (snapshot.project) await startRun(followupTask.trim(), "execute", reasoningEffort, followupAttachments);
      else await startChat(followupTask.trim(), reasoningEffort, followupAttachments);
      setFollowupTask("");
      setFollowupAttachments([]);
    }
    finally { setFollowupBusy(false); }
  };
  const submitSteering = async () => {
    const body = followupTask.trim();
    if (!body) return;
    setSteeringBusy(true);
    setSteeringError(null);
    try {
      await client.submitUserInput(steeringKind, body);
      setFollowupTask("");
    } catch (error) {
      setSteeringError(error instanceof Error ? error.message : "Input could not be queued");
    } finally {
      setSteeringBusy(false);
    }
  };
  const cancelRun = async () => {
    setCancelBusy(true);
    setSteeringError(null);
    try {
      await client.stop();
    } catch (error) {
      setSteeringError(error instanceof Error ? error.message : "Cancellation could not be queued");
    } finally {
      setCancelBusy(false);
    }
  };
  const openSession = async (sessionId: string) => {
    setView("trajectory");
    setSelectedId(null);
    setTailFollowing(true);
    await client.openSession(sessionId);
  };
  const resumeSession = async (sessionId = snapshot.selectedSessionId) => {
    if (!sessionId) return;
    setView("trajectory");
    setSelectedId(null);
    setTailFollowing(true);
    await client.resumeSession(sessionId);
  };

  const projectCanExecute = canUseExecuteMode(snapshot.project);
  return (
    <div className={`app theme-${theme} ${view === "changes" ? "changes-mode" : ""}`}>
      <div className="compact-gate">
        <BrandMark />
        <IconButton className="compact-settings-trigger" disabled={replayReadOnly} icon="settings" label={t("Settings")} onClick={() => setSettingsOpen(true)} />
        <span><Icon name="sidebar" size={24} /></span>
        <h1>{t("TraceGraph needs a wider canvas")}</h1>
        <p>{t("Use a window at least 1024px wide to inspect Diff and Architecture Delta. This compact view remains read-only.")}</p>
        {run && <StatusPill status={run.status} />}
      </div>
      <div className="desktop-app">
        <RunHeader onOpenInspector={() => setDetailsOpen(true)} onStop={() => void cancelRun()} onViewChange={(nextView) => { setView(nextView); if (nextView !== "trajectory") setDetailsOpen(false); if (nextView !== "chat") setLogOpen(false); }} replayReadOnly={replayReadOnly} snapshot={snapshot} stopDisabled={cancelBusy || run?.status === "reconnecting" || run?.inputQueue.pending.some(({ kind }) => kind === "cancel") === true} view={view} />
        {replay && <ReplayBanner error={replayError} onReturnToLive={returnToLive} onStep={(direction) => { setReplayError(null); void client.stepReplay(direction).catch((error: unknown) => setReplayError(error instanceof Error ? error.message : "Replay step failed")); }} replay={replay} />}
        <div className={`workspace ${view === "changes" ? "workspace-changes" : ""} ${view === "chat" ? "workspace-chat" : ""}`}>
          <Sidebar onChooseProject={chooseProject} onDeleteSession={(sessionId) => client.deleteSession(sessionId)} onOpenLocal={(access) => client.openLocalProject(access)} onOpenSettings={() => setSettingsOpen(true)} onPreviewState={previewState} onRemoveProject={async (projectId) => { await client.removeProject(projectId); }} onResumeSession={resumeSession} onReturnHome={() => void client.returnHome()} onSearchSessions={(query) => client.searchSessions(query)} onSelectProject={(projectId) => void client.chooseProjectById(projectId)} onSelectSession={openSession} readOnly={replayReadOnly} snapshot={snapshot} />

          {!snapshot.project && !run && <NoProject onReasoningEffortChange={setReasoningEffort} onStartChat={startChat} reasoningEffort={reasoningEffort} />}
          {snapshot.project && !run && <ProjectReady key={snapshot.project.id} onReasoningEffortChange={setReasoningEffort} onStart={startRun} readonly={!projectCanExecute} reasoningEffort={reasoningEffort} />}

          {run && view !== "changes" && (
            <main className="main-workbench">
              <StateNotice connectionMessage={snapshot.connection.message} currentStep={run.currentStep} indexedFiles={run.indexedFiles} lastSequence={run.lastSequence} onRefresh={() => void client.previewState("running")} onResumeSession={() => void resumeSession()} onReview={reviewLatest} readOnly={replayReadOnly} scanScope={run.scanScope} sessionViewState={snapshot.sessionViewState} status={run.status} />
              {view === "chat" ? (
                <ChatView
                  changedFiles={snapshot.changedFiles}
                  conversation={snapshot.conversation}
                  dataSource={snapshot.dataSource}
                  events={run.events}
                  evidence={snapshot.evidence}
                  {...(run.contextBudget === undefined ? {} : { contextBudget: run.contextBudget })}
                  {...(run.turnsCompleted === undefined ? {} : { turnsCompleted: run.turnsCompleted })}
                  {...(run.turnLimit === undefined ? {} : { turnLimit: run.turnLimit })}
                  {...(run.publicActivities === undefined ? {} : { publicActivities: run.publicActivities })}
                  {...(run.modelSurface === undefined ? {} : { modelSurface: run.modelSurface })}
                  {...(run.outcome === undefined ? {} : { outcome: run.outcome })}
                  {...(run.elapsed === undefined ? {} : { elapsed: run.elapsed })}
                  {...(run.inputTokens === undefined ? {} : { inputTokens: run.inputTokens })}
                  {...(run.contextBudget?.providerUsage?.totalTokens === undefined ? {} : { totalTokens: run.contextBudget.providerUsage.totalTokens })}
                  progressive
                  status={run.status}
                  task={run.task}
                />
              ) : (
                <Trajectory
                  busyTodoId={busyTodoId}
                  events={run.events}
                  onResumeLive={returnToLive}
                  onSelect={selectEvent}
                  onLoadSubagent={(subagentId) => { void client.loadSubagent(subagentId); }}
                  onCreateTeam={() => { void createTeam(); }}
                  onSteerTeamMember={steerTeamMember}
                  onCancelTeamTask={(task) => { void cancelTeamTask(task); }}
                  onTodoStateChange={(todo, state) => void updateTodo(todo, state)}
                  {...(replay === undefined ? {} : { replaySequence: replay.requestedSequence })}
                  selectedId={selectedId}
                  subagentDetailsDisabled={replayReadOnly}
                  subagents={run.subagents}
                  {...(run.team === undefined ? {} : { team: run.team })}
                  teamBusyKey={teamBusyKey}
                  teamControlsDisabled={replayReadOnly || teamDisabledReason !== null}
                  teamControlsDisabledReason={replayReadOnly ? t("Replay is read-only. Return to now to make changes.") : teamDisabledReason === null ? null : t(teamDisabledReason)}
                  teamError={teamError}
                  attachmentPreviewsDisabled={replayReadOnly}
                  attachments={run.attachments}
                  onLoadAttachment={(attachmentId) => client.loadAttachment(attachmentId)}
                  tailFollowing={!replayReadOnly && tailFollowing}
                  todoError={todoError}
                  todoUpdatesDisabled={replayReadOnly || planApprovalBusy || todoDisabledReason !== null}
                  todoUpdatesDisabledReason={replayReadOnly ? t("Replay is read-only. Return to now to make changes.") : planApprovalBusy ? t("Todo changes are unavailable while plan approval is being submitted.") : todoDisabledReason === null ? null : t(todoDisabledReason)}
                  todos={run.todos}
                />
              )}
              {view === "chat" && <footer className="composer-shell">
                {run.status === "awaiting_plan_approval" && run.pendingPlan && (
                  <PlanApprovalBanner busy={planApprovalBusy} disabled={replayReadOnly || busyTodoId !== null} error={planApprovalError} eventId={run.pendingPlan.eventId} onApprove={() => void approvePlan()} todos={run.todos} />
                )}
                {run.mode === "plan" && (run.status === "running" || run.status === "indexing") && (
                  <div className="plan-mode-banner" role="status"><Icon name="shield" size={16} /><span><strong>{t("Plan mode")}</strong><small>{t("Write tools are disabled while the Agent builds an inspectable Todo plan.")}</small></span></div>
                )}
                <div className="composer-tools">
                  <ReasoningEffortPicker compact disabled={replayReadOnly || run.status === "running" || run.status === "indexing" || run.status === "reconnecting" || run.status === "awaiting_plan_approval" || run.status === "needs_approval"} onChange={setReasoningEffort} value={reasoningEffort} />
                  <button className="composer-tool-button" onClick={() => setLogOpen(true)} type="button"><Icon name="terminal" size={13} />{t("Test / raw log")}</button>
                </div>
                {run.status === "running" || run.status === "indexing" || run.status === "awaiting_plan_approval" || run.status === "needs_approval" || run.status === "reconnecting" || run.status === "interrupted" || run.status === "needs_manual_review" ? (
                  <SteeringComposer
                    busy={steeringBusy || approvalBusy || planApprovalBusy || busyTodoId !== null}
                    cancelBusy={cancelBusy}
                    disabledReason={replayReadOnly
                      ? "Replay is read-only. Return to now to make changes."
                      : run.status === "reconnecting"
                      ? "Steering is unavailable while reconnecting to the Host."
                      : run.status === "interrupted"
                        ? "Steering is unavailable while the Run is interrupted. Resume the Run first."
                        : run.status === "needs_manual_review"
                          ? "Steering is unavailable while the Run needs manual review."
                          : null}
                    error={steeringError}
                    kind={steeringKind}
                    {...(run.inputQueue.lastConsumed === undefined ? {} : { lastConsumed: run.inputQueue.lastConsumed })}
                    onCancel={() => void cancelRun()}
                    onKindChange={setSteeringKind}
                    onSubmit={() => void submitSteering()}
                    onValueChange={setFollowupTask}
                    pending={run.inputQueue.pending}
                    value={followupTask}
                  />
                ) : (
                  <div className="composer-input"><Icon name="message" size={16} /><textarea aria-label={t("New task")} disabled={replayReadOnly} onChange={(event) => setFollowupTask(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void startFollowup(); } }} placeholder={t("Ask a follow-up or create something…")} rows={2} value={followupTask} /><button aria-label={t("Send message")} className="button primary" disabled={replayReadOnly || followupBusy || !followupTask.trim()} onClick={() => void startFollowup()} type="button"><Icon name="send" size={15} /></button></div>
                )}
              </footer>}
              {run.approval && (
                <ApprovalStrip approval={run.approval} busy={approvalBusy} disabled={replayReadOnly} onApprove={() => void approve()} onReject={() => void reject()} onViewDiff={reviewPendingPatch} />
              )}
            </main>
          )}

          {run && view === "trajectory" && (
            <Inspector event={displayedEvent} onLoadContextArchive={(artifactId) => client.loadContextArchive(run.id, artifactId)} scope={selectedEvidence} />
          )}

          {run && view === "changes" && (
            <main className="changes-workbench">
              <ChangesView {...((selectedEvent ? selectedEvidence.codeIntel : run?.codeIntel) === undefined ? {} : { codeIntel: selectedEvent ? selectedEvidence.codeIntel : run?.codeIntel })} diffs={selectedEvidence.diffs} edges={selectedEvidence.graphEdges} evidence={selectedEvidence.evidence} files={selectedEvidence.changedFiles} nodes={selectedEvidence.graphNodes} onJumpToPatch={jumpToPatch} onOpenDetails={() => setDetailsOpen(true)} patchId={selectedEvidence.patchEventId} verified={["available", "demo"].includes(selectedEvidence.evidence.test.status)} />
            </main>
          )}

        </div>

        {detailsOpen && run && view === "trajectory" && (
          <><button aria-label={t("Close details")} className="drawer-backdrop" onClick={() => setDetailsOpen(false)} type="button" /><Inspector drawer event={displayedEvent} onClose={() => setDetailsOpen(false)} onLoadContextArchive={(artifactId) => client.loadContextArchive(run.id, artifactId)} scope={selectedEvidence} /></>
        )}
        {logOpen && view === "chat" && (
          <><button aria-label={t("Close log")} className="drawer-backdrop" onClick={() => setLogOpen(false)} type="button" /><section className="bottom-drawer"><header><div><Icon name="terminal" size={15} /><strong>{t("Test / raw log")}</strong><span>{selectedEvidence.evidence.test.artifactId ?? t("unavailable")}</span></div><IconButton icon="close" label={t("Close log")} onClick={() => setLogOpen(false)} /></header><pre>{selectedEvidence.evidence.test.content ?? selectedEvidence.evidence.test.message}</pre></section></>
        )}
      </div>
      <SettingsPanel
        onClose={closeSettings}
        onConfigureModel={configureModel}
        onConfigurePermissionPreset={configurePermissionPreset}
        onGetModelConfig={getModelConfig}
        onGetPermissionConfig={getPermissionConfig}
        onGetTelemetryStatus={getTelemetryStatus}
        onGetUsage={getUsage}
        onListExtensions={listExtensions}
        onReloadExtension={reloadExtension}
        onListSkills={listSkills}
        onGetMcpStatus={getMcpStatus}
        onGetLspStatus={getLspStatus}
        onThemeChange={setTheme}
        open={settingsOpen && !replayReadOnly}
        theme={theme}
      />
    </div>
  );
}

export function App({ client = defaultClient }: { client?: WorkbenchClient }) {
  return <LanguageProvider><Workbench client={client} /></LanguageProvider>;
}
