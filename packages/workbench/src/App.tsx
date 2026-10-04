import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ModelConfigSnapshot, WorkbenchClient } from "./client";
import { Composer } from "./components/Composer";
import { ProjectFileContextPicker } from "./components/ProjectFileContextPicker";
import { useConversationOptions, ComposerModelMenu, ComposerPermissionMenu } from "./conversation-options";
import { useConversationDraft } from "./drafts";
import { ApprovalStrip } from "./components/ApprovalStrip";
import { ChangesView } from "./components/ChangesView";
import { SetupFlow } from "./components/SetupFlow";
import { RollbackControls } from "./components/RollbackControls";
import { Icon } from "./components/Icon";
import { Inspector } from "./components/Inspector";
import { PlanApprovalBanner } from "./components/PlanApprovalBanner";
import { ReplayBanner } from "./components/ReplayBanner";
import { IconButton, Notice } from "./components/Primitives";
import { Sidebar } from "./components/Sidebar";
import { type Theme } from "./components/SettingsPanel";
import { UnifiedSettings, capabilityAvailable, capabilityReadable, capabilityFor, commandId, type SettingsCategory } from "./components/UnifiedSettings";
import { ProjectFiles } from "./components/ProjectFiles";
import { GeneratedGallery } from "./components/GeneratedGallery";
import { WorkspaceResources } from "./components/WorkspaceResources";
import { MediaStudio } from "./components/MediaStudio";
import { CommandPalette } from "./components/CommandPalette";
import { createNotificationTracker } from "./notifications";
import { MemoryControlPanel } from "./components/MemoryControlPanel";
import { Trajectory } from "./components/Trajectory";
import { ChatView, NoProject, ProjectReady } from "./components/WorkbenchStates";
import { ReasoningEffortPicker } from "./components/ReasoningEffortPicker";
import { LanguageProvider, useI18n } from "./i18n";
import { canUseExecuteMode, evidenceForSelection, type MainView, type EvidenceSlot, type PendingAttachment, type ReasoningEffort, type RunMode, type RunStatus, type TraceEvent, type WorkspaceKind } from "./model";
import type { HostCapabilities, WorkbenchSettingsSnapshot, WorkbenchResources, WorkbenchNotification, TaskBoardItem, TodoItem, TodoState, UserInputKind, ProjectFileContextRef } from "@tracegraph/contracts";

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
  if (typeof window === "undefined") return "light";
  const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
  return saved === "dark" || saved === "light" ? saved : window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
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

export function hasTestOutput(slot: EvidenceSlot): boolean {
  return (slot.status === "available" || slot.status === "demo") && (slot.content !== undefined || Boolean(slot.artifactId));
}

function RunHeader({ snapshot, onToggleNavigation, navigationOpen, onReview, onOpenResources }: {
  snapshot: ReturnType<WorkbenchClient["getSnapshot"]>;
  onToggleNavigation: () => void;
  navigationOpen: boolean;
  onReview: () => void;
  onOpenResources: () => void;
}) {
  const { t } = useI18n();
  const { project, run } = snapshot;
  return <header className="app-header">
    <button aria-label={t(navigationOpen ? "Hide navigation" : "Show navigation")} aria-expanded={navigationOpen} aria-controls="workbench-navigation" className="icon-button navigation-toggle" onClick={onToggleNavigation} title={t("Toggle navigation (⌘/Ctrl+B)")} type="button"><Icon name="sidebar" size={18} /></button>
    <div className="header-project"><strong className="header-task-title">{run?.task ?? project?.name ?? t("New chat")}</strong></div>
    <div className="header-actions">
      {snapshot.dataSource === "demo" && <span className="host-chip" title={t("Preview · deterministic example data")}>{t("Preview")}</span>}
      <button className="icon-button" aria-label={t("Workspace tools")} onClick={onOpenResources} type="button"><Icon name="terminal" size={17} /></button>
      {run && <button aria-label={t("Review changes")} className="button subtle header-review" onClick={onReview} type="button"><Icon name="diff" size={14} />{t("Review")}{snapshot.changedFiles.length > 0 && <span>{snapshot.changedFiles.length}</span>}</button>}
    </div>
  </header>;
}

export function StateNotice({ status, sessionViewState, onResumeSession, onReview, onRefresh, currentStep, lastSequence, connectionMessage, indexedFiles, scanScope, readOnly = false }: { status: RunStatus; sessionViewState: "restored" | "resumed" | null; onResumeSession: () => void; onReview: () => void; onRefresh: () => void; currentStep: string; lastSequence: number; connectionMessage: string; indexedFiles: number | undefined; scanScope: string | undefined; readOnly?: boolean }) {
  const { language, t } = useI18n();
  if (status === "interrupted") return <Notice action={readOnly ? undefined : <button className="button primary" onClick={onResumeSession} type="button"><Icon name="play" size={13} />{t("Resume session")}</button>} icon="alert" title={t("Last session was interrupted")} tone="warning">{t("The durable view was recovered. No tool was rerun automatically.")}</Notice>;
  if (status === "needs_manual_review") return <Notice icon="alert" title={t("Needs manual review")} tone="warning">{t("The workspace no longer matches the Action WAL. Outlive Agent did not change files automatically.")}</Notice>;
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
  const { t, setLanguage } = useI18n();
  const snapshot = useSnapshot(client);
  const [view, setView] = useState<MainView>("chat");
  const [navigationOpen, setNavigationOpen] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tailFollowing, setTailFollowing] = useState(true);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(initialReasoningEffort);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>("general");
  const [mediaOpen, setMediaOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<"files" | "changes" | "terminal" | "preview" | "artifacts" | "tools">("changes");
  const [reviewSnapshot, setReviewSnapshot] = useState<ReturnType<WorkbenchClient["getSnapshot"]> | null>(null);
  const [reviewEventId, setReviewEventId] = useState<string | null>(null);
  const [reviewPath, setReviewPath] = useState<string | null>(null);
  const [panelLoading, setPanelLoading] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [fileDirty, setFileDirty] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [capabilities, setCapabilities] = useState<HostCapabilities | null>(null);
  const [sharedSettings, setSharedSettings] = useState<WorkbenchSettingsSnapshot | null>(null);
  const [backgroundResources, setBackgroundResources] = useState<WorkbenchResources | null>(null);
  const [notifications, setNotifications] = useState<readonly WorkbenchNotification[]>([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [modelName, setModelName] = useState<string | null>(null);
  const [modelConfiguration, setModelConfiguration] = useState<ModelConfigSnapshot | null>(null);
  const [modelLoading, setModelLoading] = useState(true);
  const [modelError, setModelError] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const setupPrompted = useRef(false);
  const [modelRevision, setModelRevision] = useState(0);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [planApprovalBusy, setPlanApprovalBusy] = useState(false);
  const [planApprovalError, setPlanApprovalError] = useState<string | null>(null);
  const [busyTodoId, setBusyTodoId] = useState<string | null>(null);
  const [todoError, setTodoError] = useState<string | null>(null);
  const [teamBusyKey, setTeamBusyKey] = useState<string | null>(null);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const draftScope = snapshot.selectedSessionId ?? (snapshot.project ? `new-project:${snapshot.project.id}` : "new-chat");
  const { draft, setText: setFollowupTask, setAttachments: setFollowupAttachments, setFileContexts: setFollowupFileContexts } = useConversationDraft(draftScope);
  const followupTask = draft.text;
  const followupAttachments = draft.attachments;
  const [fileContextOpen, setFileContextOpen] = useState(false);
  const conversationOptions = useConversationOptions({ client, scope: draftScope, sessionId: snapshot.selectedSessionId, online: snapshot.connection.state === "live" && !snapshot.replay, capabilities, refreshKey: settingsOpen });
  const [followupBusy, setFollowupBusy] = useState(false);
  const [steeringKind, setSteeringKind] = useState<Exclude<UserInputKind, "cancel">>("message");
  const [steeringBusy, setSteeringBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [steeringError, setSteeringError] = useState<string | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  const run = snapshot.run;
  const replay = snapshot.replay;
  const replayReadOnly = replay !== undefined;
  const generatedPreviewCapability = capabilityFor(capabilities, "artifacts.binary.read");
  const generatedPreviewsDisabledReason = replayReadOnly ? "Return to now to preview generated artifacts."
    : snapshot.connection.state !== "live" ? "Reconnect to preview generated artifacts."
      : !generatedPreviewCapability ? "Artifact preview availability has not been confirmed. Repair the connection to try again."
        : !capabilityReadable(capabilities, "artifacts.binary.read") ? generatedPreviewCapability.reason ?? "This feature is unavailable on this installation." : null;
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
  const reconnect = useCallback(() => client.reconnect(), [client]);

  useEffect(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    document.documentElement.style.colorScheme = theme;
    window.dispatchEvent(new CustomEvent("tracegraph:themechange", { detail: theme }));
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem(REASONING_STORAGE_KEY, reasoningEffort);
  }, [reasoningEffort]);

  useEffect(() => {
    if (run?.status === "empty" || !run) setView("chat");
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
    setApprovalError(null);
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented) return;
      if (event.key === "Escape") {
        setPaletteOpen(false);
        if (!fileDirty || window.confirm(t("Discard unsaved edits?"))) { setResourcesOpen(false); setView("chat"); }
        setDetailsOpen(false);
        setLogOpen(false);
        setMemoryOpen(false);
        setSettingsOpen(false);
        return;
      }
      if (event.ctrlKey && !event.metaKey && event.target instanceof HTMLElement && event.target.closest(".host-terminal")) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() === "b") {
        event.preventDefault();
        setNavigationOpen((open) => !open);
      } else if (event.key === "," && !replayReadOnly) {
        event.preventDefault();
        setSettingsOpen(true);
      } else if (event.key.toLowerCase() === "k" && !replayReadOnly) {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [replayReadOnly, fileDirty, t]);

  const inspectEvent = (event: TraceEvent) => {
    setSelectedId(event.id);
    setDetailsOpen(true);
  };
  const selectEvent = (event: TraceEvent) => {
    setSelectedId(event.id);
    setDetailsOpen(true);
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

  const confirmFileNavigation = () => !fileDirty || window.confirm(t("Discard unsaved edits?"));
  const chooseProject = (kind: WorkspaceKind) => { if (confirmFileNavigation()) void client.chooseProject(kind); };
  const previewState = (status: RunStatus) => {
    setView(status === "completed" || status === "ready_for_review" || status === "historical" ? "changes" : "trajectory");
    setSelectedId(status === "needs_approval" ? "evt_012" : null);
    void client.previewState(status);
  };
  const startRun = async (task: string, mode: RunMode, effort: ReasoningEffort = reasoningEffort, attachments: readonly PendingAttachment[] = [], fileContexts: readonly ProjectFileContextRef[] = []) => {
    setView("chat");
    setSelectedId(null);
    setTailFollowing(true);
    await client.startRun(task, mode, effort, attachments, { ...conversationOptions.options, mode, reasoning_effort: effort }, ...(fileContexts.length ? [fileContexts] as const : [] as const));
  };
  const startChat = async (task: string, effort: ReasoningEffort = reasoningEffort, attachments: readonly PendingAttachment[] = []) => {
    setView("chat");
    setSelectedId(null);
    setTailFollowing(true);
    await client.startChat(task, effort, attachments, { ...conversationOptions.options, reasoning_effort: effort });
  };
  const approve = async () => {
    if (!run?.approval) return;
    setApprovalError(null);
    setApprovalBusy(true);
    try {
      await client.approve(run.approval.id);
      const nextEvents = client.getSnapshot().run?.events ?? [];
      setSelectedId([...nextEvents].reverse().find((event) => event.patchRef)?.id ?? nextEvents.at(-1)?.id ?? null);
    } catch {
      setApprovalError(t("The local Host could not complete this request."));
    } finally {
      setApprovalBusy(false);
    }
  };
  const reject = async () => {
    if (!run?.approval) return;
    setApprovalError(null);
    setApprovalBusy(true);
    try {
      await client.reject(run.approval.id);
    } catch {
      setApprovalError(t("The local Host could not complete this request."));
    } finally { setApprovalBusy(false); }
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
    setView("changes"); setPanelTab("changes"); setReviewSnapshot(null); setReviewPath(null);
  };
  const reviewPendingPatch = () => {
    setSelectedId(patchEvent?.id ?? null);
    setTailFollowing(patchEvent?.id === run?.events.at(-1)?.id);
    setView("changes"); setPanelTab("changes"); setReviewSnapshot(null); setReviewPath(null);
  };
  const startFollowup = async () => {
    if (!followupTask.trim() || !modelReady || conversationOptions.busy || followupBusy || snapshot.connection.state !== "live" || replayReadOnly) return;
    setFollowupBusy(true);
    setSteeringError(null);
    try {
      if (snapshot.project) await startRun(followupTask.trim(), conversationOptions.options.mode, conversationOptions.options.reasoning_effort, followupAttachments, draft.fileContexts.map(({ path, expected_sha256 }) => ({ path, expected_sha256 })));
      else await startChat(followupTask.trim(), conversationOptions.options.reasoning_effort, followupAttachments);
      setFollowupTask("");
      setFollowupAttachments([]);
      setFollowupFileContexts([]);
    }
    catch (error) { setSteeringError(error instanceof Error ? error.message : "The local Host could not complete this request."); }
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
    if (!confirmFileNavigation()) return;
    setView("chat");
    setSelectedId(null);
    setTailFollowing(true);
    await client.openSession(sessionId);
  };
  const resumeSession = async (sessionId = snapshot.selectedSessionId) => {
    if (!sessionId || !confirmFileNavigation()) return;
    setView("chat");
    setSelectedId(null);
    setTailFollowing(true);
    await client.resumeSession(sessionId);
  };

  useEffect(() => {
    if (snapshot.dataSource !== "live") { setModelLoading(false); return; }
    if (snapshot.connection.state !== "live") { setModelLoading(false); return; }
    let current = true;
    setModelLoading(true); setModelError(null);
    void client.getModelConfig().then((value) => {
      if (!current) return;
      setModelConfiguration(value); setModelName(value.configured ? value.model : null);

    }).catch(() => { if (current) { setModelConfiguration(null); setModelName(null); setModelError("Couldn't load your model settings. Try again."); } }).finally(() => { if (current) setModelLoading(false); });
    return () => { current = false; };
  }, [client, settingsOpen, snapshot.connection.state, snapshot.dataSource, modelRevision]);
  useEffect(() => {
    if (snapshot.connection.state === "live" || snapshot.dataSource !== "live") return;
    let current = true;
    void client.getCapabilities().then((value) => { if (current) setCapabilities(value); }).catch(() => { if (current) setCapabilities(null); });
    return () => { current = false; };
  }, [client, snapshot.connection.state, snapshot.dataSource]);
  const connectModel = () => { if (conversationOptions.connections?.connections.length) { setSettingsCategory("model"); setSettingsOpen(true); } else if (modelConfiguration) setSetupOpen(true); else setModelRevision((value) => value + 1); };
  const repairConnection = async () => {
    if (client.startHost) await client.startHost();
    else await client.reconnect();
  };
  const selectedModelConnection = conversationOptions.connections?.connections.find((item) => item.connection_id === conversationOptions.options.connection_id);
  const modelReady = snapshot.dataSource !== "live" || (selectedModelConnection ? selectedModelConnection.has_key : modelConfiguration?.configured === true && modelConfiguration.has_key);
  const imageInputAvailable = selectedModelConnection?.image_input_models?.includes(conversationOptions.options.model ?? selectedModelConnection.model) === true;
  useEffect(() => {
    if (snapshot.dataSource !== "live" || snapshot.connection.state !== "live" || snapshot.run || modelLoading || !modelConfiguration || conversationOptions.loading || !capabilities || setupPrompted.current) return;
    if (conversationOptions.modelsState === "unknown" || conversationOptions.modelsState === "failed") return;
    const configured = conversationOptions.modelsState === "ready" ? conversationOptions.connections?.connections.some((connection) => connection.has_key) === true : modelConfiguration.configured && modelConfiguration.has_key;
    if (!configured) { setupPrompted.current = true; setSetupOpen(true); }
  }, [snapshot.dataSource, snapshot.connection.state, snapshot.run, modelLoading, modelConfiguration, conversationOptions.loading, conversationOptions.modelsState, conversationOptions.connections, capabilities]);


  const appliedDefaultEffort = useRef<ReasoningEffort | null>(null);
  const applySharedSettings = useCallback((next: WorkbenchSettingsSnapshot) => {
    setSharedSettings(next);
    setLanguage(next.settings.general.language);
    if (appliedDefaultEffort.current !== next.settings.model.reasoning_effort) setReasoningEffort(next.settings.model.reasoning_effort);
    appliedDefaultEffort.current = next.settings.model.reasoning_effort;
    setTheme(next.settings.appearance.theme === "system" ? window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light" : next.settings.appearance.theme);
    document.documentElement.style.setProperty("--outlive-ui-font-size", `${next.settings.appearance.ui_font_size}px`);
    document.documentElement.style.setProperty("--outlive-code-font-size", `${next.settings.appearance.code_font_size}px`);
    document.documentElement.dataset.outliveDensity = next.settings.appearance.output_density;
  }, [setLanguage]);
  useEffect(() => {
    if (snapshot.connection.state !== "live" || snapshot.dataSource !== "live") return;
    let current = true; let timer: number | undefined; const projectNotifications = createNotificationTracker();
    const read = async () => {
      try {
        const caps = await client.getCapabilities(); if (!current) return; setCapabilities(caps);
        let preferences: WorkbenchSettingsSnapshot | null = null;
        if (capabilityReadable(caps, "settings.read")) { preferences = await client.getWorkbenchSettings(); if (current) applySharedSettings(preferences); }
        if (capabilityReadable(caps, "resources.read")) {
          const next = await client.getWorkbenchResources();
          if (current) {
            const notificationProjection = projectNotifications(next.notifications ?? [], preferences?.settings.general);
            setNotifications(notificationProjection.visible);
            if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.visibilityState !== "visible") {
              for (const notification of notificationProjection.alerts) new Notification("Outlive Agent", { body: `${notification.task} · ${t(notification.status)}`, tag: notification.notification_id });
            }
            setBackgroundResources(next);
          }
        }
      } catch { /* Older Hosts remain usable; individual settings/resources expose their unavailable state. */ }
      finally { if (current) timer = window.setTimeout(() => void read(), 3_000); }
    };
    void read(); return () => { current = false; window.clearTimeout(timer); };
  }, [client, snapshot.connection.state, snapshot.dataSource, applySharedSettings]);
  useEffect(() => {
    if (sharedSettings?.settings.appearance.theme !== "system") return;
    const query = window.matchMedia?.("(prefers-color-scheme: dark)"); if (!query) return;
    const changed = () => setTheme(query.matches ? "dark" : "light"); query.addEventListener?.("change", changed); return () => query.removeEventListener?.("change", changed);
  }, [sharedSettings?.settings.appearance.theme]);

  const reviewFile = async (runId: string, path: string, patchEventId?: string) => {
    if (!confirmFileNavigation()) return;
    setPanelTab("changes"); setView("changes"); setReviewPath(path); setReviewEventId(patchEventId ?? null); setPanelError(null);
    if (runId === run?.id) { setReviewSnapshot(null); setSelectedId(patchEventId ?? null); return; }
    if (!client.inspectRun) { setPanelError(t("This Run cannot be inspected on this installation.")); return; }
    setPanelLoading(true);
    try { setReviewSnapshot(await client.inspectRun(runId)); } catch (caught) { setPanelError(caught instanceof Error ? caught.message : String(caught)); } finally { setPanelLoading(false); }
  };
  const closePanel = () => { if (fileDirty && !window.confirm(t("Discard unsaved edits?"))) return; setResourcesOpen(false); setView("chat"); };
  const panelOpen = view === "changes" || resourcesOpen;
  const review = reviewSnapshot ?? snapshot;
  const reviewEvidence = reviewSnapshot ? evidenceForSelection(reviewSnapshot, reviewSnapshot.run?.events.find((event) => event.id === reviewEventId) ?? null) : selectedEvidence;
  const projectCanExecute = canUseExecuteMode(snapshot.project);
  const activeInput = Boolean(run && ["running", "indexing", "awaiting_plan_approval", "needs_approval", "reconnecting", "interrupted", "needs_manual_review"].includes(run.status));
  const inputDisabledReason = replayReadOnly ? "Replay is read-only. Return to now to make changes." : snapshot.connection.state !== "live" || run?.status === "reconnecting" ? "Repair the connection before sending a message." : run?.status === "interrupted" ? "Resume the Run before sending guidance." : run?.status === "needs_manual_review" ? "Review this Run before sending guidance." : null;
  const composer = <Composer value={followupTask} onChange={setFollowupTask} onSubmit={() => void (activeInput ? submitSteering() : startFollowup())} {...(activeInput ? { onStop: () => void cancelRun() } : {})} active={activeInput} busy={activeInput ? steeringBusy || approvalBusy || planApprovalBusy : followupBusy || modelLoading} stopping={cancelBusy} disabledReason={inputDisabledReason} label={!run ? snapshot.project ? "Task" : "Plain chat message" : activeInput ? "Steer this run" : "New task"} submitDisabled={!activeInput && (!modelReady || conversationOptions.loading || conversationOptions.busy)} mode={conversationOptions.options.mode} onModeChange={(mode) => void conversationOptions.update({ mode })} enterBehavior={sharedSettings?.settings.general.enter_behavior ?? "enter"} fileContexts={draft.fileContexts} onFileContextsChange={setFollowupFileContexts} fileContextAvailable={Boolean(snapshot.project && !replayReadOnly && snapshot.connection.state === "live" && capabilityAvailable(capabilities, "files.context") && capabilityAvailable(capabilities, "files.list") && capabilityAvailable(capabilities, "files.read"))} {...(snapshot.project ? { onAddFileContext: () => setFileContextOpen(true) } : {})} attachments={followupAttachments} onAttachmentsChange={setFollowupAttachments} imageInputAvailable={imageInputAvailable} onConfigureImageInput={() => { setSettingsCategory("model"); setSettingsOpen(true); }} attachmentsAvailable={capabilityAvailable(capabilities, "attachments.upload")} {...(!replayReadOnly && ["media.generate", "media.diagram", "media.chart"].some((operation) => capabilityAvailable(capabilities, operation)) ? { onCreateMedia: () => setMediaOpen(true) } : {})} modelControl={<ComposerModelMenu connections={conversationOptions.connections} options={conversationOptions.options} onChange={(patch) => void conversationOptions.update(patch)} onSettings={() => { setSettingsCategory("model"); setSettingsOpen(true); }} active={activeInput} disabled={replayReadOnly || snapshot.connection.state !== "live" || conversationOptions.busy || conversationOptions.loading} />} permissionControl={<ComposerPermissionMenu options={conversationOptions.options} permission={conversationOptions.permission} grant={conversationOptions.grant} active={activeInput} disabled={replayReadOnly || snapshot.connection.state !== "live" || conversationOptions.busy || conversationOptions.loading} onChange={(patch) => void conversationOptions.update(patch)} onGrant={() => void conversationOptions.allowFull()} />} optionsDisabled={conversationOptions.busy || conversationOptions.loading} pending={run?.inputQueue.pending ?? []} error={steeringError ?? conversationOptions.error} />;
  return (
    <div className={`app outlive-workbench theme-${theme} ${view === "changes" ? "changes-mode" : ""}`}>
      <div className={`desktop-app ${navigationOpen ? "navigation-open" : "navigation-closed"}`}>
        <RunHeader navigationOpen={navigationOpen} onToggleNavigation={() => setNavigationOpen((open) => !open)} onReview={() => { if (panelOpen && panelTab === "changes") closePanel(); else if (confirmFileNavigation()) { setPanelTab("changes"); setReviewSnapshot(null); setView("changes"); } }} onOpenResources={() => { if (confirmFileNavigation()) { setPanelTab("terminal"); setResourcesOpen(true); } }} snapshot={snapshot} />
        {replay && <ReplayBanner error={replayError} onReturnToLive={returnToLive} onStep={(direction) => { setReplayError(null); void client.stepReplay(direction).catch((error: unknown) => setReplayError(error instanceof Error ? error.message : "Replay step failed")); }} replay={replay} />}
        <Sidebar onOpenResources={() => { if (confirmFileNavigation()) { setPanelTab("tools"); setResourcesOpen(true); } }} onOpenNotifications={() => setNotificationsOpen(true)} onOpenPalette={() => setPaletteOpen(true)} {...(capabilityAvailable(capabilities, "sessions.archive") ? { onArchiveSession: async (sessionId: string) => { await client.workbenchCommand({ type: "sessions.archive", command_id: commandId(), session_id: sessionId }); await client.searchSessions(""); } } : {})} archivedSessionIds={backgroundResources?.archived_session_ids ?? []} onRenameSession={(sessionId, title) => client.renameSession(sessionId, title)} onChooseProject={chooseProject} onDeleteSession={(sessionId) => client.deleteSession(sessionId)} onOpenLocal={async (access) => { if (confirmFileNavigation()) await client.openLocalProject(access); }} {...(client.openProjectFile ? { onOpenProjectFile: (projectId: string) => client.openProjectFile!(projectId) } : {})} onOpenMemory={() => setMemoryOpen(true)} onOpenSettings={() => setSettingsOpen(true)} onPreviewState={previewState} onRemoveProject={async (projectId) => { await client.removeProject(projectId); }} onResumeSession={resumeSession} onReturnHome={() => { if (confirmFileNavigation()) void client.returnHome(); }} onSearchSessions={(query) => client.searchSessions(query)} onSelectProject={(projectId) => { if (confirmFileNavigation()) void client.chooseProjectById(projectId); }} onSelectSession={openSession} readOnly={replayReadOnly} snapshot={snapshot} />
        <div className={`workspace workspace-chat ${panelOpen ? "review-open" : ""}`}>


          {!snapshot.project && !run && <NoProject composer={composer} onDraftChange={setFollowupTask} modelReady={modelReady} modelLoading={modelLoading} modelError={modelError} onConnectModel={connectModel} onOpenDiagnostics={() => { setSettingsCategory("about"); setSettingsOpen(true); }} {...(!replayReadOnly && ["media.generate", "media.diagram", "media.chart"].some((operation) => capabilityAvailable(capabilities, operation)) ? { onCreateMedia: () => setMediaOpen(true) } : {})} attachmentsAvailable={capabilityAvailable(capabilities, "attachments.upload")} modelName={modelName} enterBehavior={sharedSettings?.settings.general.enter_behavior ?? "enter"} connection={snapshot.connection} onReasoningEffortChange={setReasoningEffort} onReconnect={repairConnection} onStartChat={startChat} reasoningEffort={reasoningEffort} />}
          {snapshot.project && !run && <ProjectReady composer={composer} onDraftChange={setFollowupTask} modelReady={modelReady} modelLoading={modelLoading} modelError={modelError} onConnectModel={connectModel} onReconnect={repairConnection} onOpenDiagnostics={() => { setSettingsCategory("about"); setSettingsOpen(true); }} {...(!replayReadOnly && ["media.generate", "media.diagram", "media.chart"].some((operation) => capabilityAvailable(capabilities, operation)) ? { onCreateMedia: () => setMediaOpen(true) } : {})} attachmentsAvailable={capabilityAvailable(capabilities, "attachments.upload")} modelName={modelName} enterBehavior={sharedSettings?.settings.general.enter_behavior ?? "enter"} connection={snapshot.connection} projectName={snapshot.project.name} key={snapshot.project.id} onReasoningEffortChange={setReasoningEffort} onStart={startRun} readonly={!projectCanExecute} reasoningEffort={reasoningEffort} />}

          {run && (
            <main className="main-workbench">
              <StateNotice connectionMessage={snapshot.connection.message} currentStep={run.currentStep} indexedFiles={run.indexedFiles} lastSequence={run.lastSequence} onRefresh={() => void repairConnection().catch((error: unknown) => setSteeringError(error instanceof Error ? error.message : String(error)))} onResumeSession={() => void resumeSession()} onReview={reviewLatest} readOnly={replayReadOnly} scanScope={run.scanScope} sessionViewState={snapshot.sessionViewState} status={run.status} />
                <ChatView client={client} runId={run.id} feedbackReadable={!replayReadOnly && snapshot.connection.state === "live" && capabilityReadable(capabilities, "feedback.read")} feedbackWritable={!replayReadOnly && snapshot.connection.state === "live" && capabilityAvailable(capabilities, "feedback.write")} onReviewFile={(id, path, patchEventId) => void reviewFile(id, path, patchEventId)}
                  runDetails={<Trajectory
                  busyTodoId={busyTodoId}
                  events={run.events}
                  onResumeLive={returnToLive}
                  onSelect={inspectEvent}
                  onLoadSubagent={(subagentId) => { void client.loadSubagent(subagentId); }}
                  onCreateTeam={() => { void createTeam(); }}
                  onSteerTeamMember={steerTeamMember}
                  onCancelTeamTask={(task) => { void cancelTeamTask(task); }}
                  onTodoStateChange={(todo, state) => void updateTodo(todo, state)}
                  {...(replay === undefined ? {} : { replaySequence: replay.requestedSequence })}
                  selectedId={selectedId}
                  subagentDetailsDisabled={replayReadOnly || !capabilityReadable(capabilities, "subagent.read")}
                  subagents={run.subagents}
                  {...(run.team === undefined ? {} : { team: run.team })}
                  teamBusyKey={teamBusyKey}
                  teamControlsDisabled={replayReadOnly || teamDisabledReason !== null || !capabilityAvailable(capabilities, "team.write")}
                  teamControlsDisabledReason={replayReadOnly ? t("Replay is read-only. Return to now to make changes.") : teamDisabledReason === null ? null : t(teamDisabledReason)}
                  teamError={teamError}
                  attachmentPreviewsDisabled={replayReadOnly || !capabilityReadable(capabilities, "attachments.read")}
                  attachments={run.attachments}
                  onLoadAttachment={(attachmentId) => client.loadAttachment(attachmentId)}
                  tailFollowing={false}
                  todoError={todoError}
                  todoUpdatesDisabled={replayReadOnly || planApprovalBusy || todoDisabledReason !== null || !capabilityAvailable(capabilities, "todo.write")}
                  todoUpdatesDisabledReason={replayReadOnly ? t("Replay is read-only. Return to now to make changes.") : planApprovalBusy ? t("Todo changes are unavailable while plan approval is being submitted.") : todoDisabledReason === null ? null : t(todoDisabledReason)}
                  todos={run.todos}
                />}
                  onInspectEvent={inspectEvent}
                  currentStep={run.currentStep}
                  changedFiles={snapshot.dataSource === "demo" ? snapshot.changedFiles : run.editedFiles ?? []}
                  conversation={snapshot.conversation}
                  {...(run.generatedArtifacts ? { generatedArtifacts: run.generatedArtifacts } : {})}
                  generatedPreviewsDisabled={generatedPreviewsDisabledReason !== null}
                  {...(generatedPreviewsDisabledReason ? { generatedPreviewsDisabledReason } : {})}
                  onLoadGeneratedArtifact={(runId, artifactId) => client.loadGeneratedArtifact(runId, artifactId)}
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
              {<footer className="composer-shell">
                {run.status === "awaiting_plan_approval" && run.pendingPlan && (
                  <PlanApprovalBanner busy={planApprovalBusy} disabled={replayReadOnly || busyTodoId !== null} error={planApprovalError} eventId={run.pendingPlan.eventId} onApprove={() => void approvePlan()} todos={run.todos} />
                )}
                {run.mode === "plan" && (run.status === "running" || run.status === "indexing") && (
                  <div className="plan-mode-banner" role="status"><Icon name="shield" size={16} /><span><strong>{t("Plan mode")}</strong><small>{t("Write tools are disabled while the Agent builds an inspectable Todo plan.")}</small></span></div>
                )}
                {composer}
              </footer>}
              {run.approval && (
                <ApprovalStrip approval={run.approval} busy={approvalBusy} disabled={replayReadOnly} error={approvalError} onApprove={() => void approve()} onReject={() => void reject()} onViewDiff={reviewPendingPatch} />
              )}
            </main>
          )}


          {panelOpen && <aside className="developer-side-panel" aria-label={t(panelTab === "changes" ? "Review changes" : "Developer panel")}>
            <header><strong>{t("Workspace")}</strong><button className="icon-button" aria-label={t("Close panel")} onClick={closePanel} type="button"><Icon name="close" size={17} /></button></header>
            <nav aria-label={t("Developer panel sections")}>{(["files", "changes", "terminal", "preview", "artifacts", "tools"] as const).map((tab) => <button aria-current={panelTab === tab ? "page" : undefined} className={panelTab === tab ? "active" : ""} key={tab} onClick={() => { if (fileDirty && !window.confirm(t("Discard unsaved edits?"))) return; setPanelTab(tab); }} type="button">{t({ files: "Files", changes: "Changes", terminal: "Terminal", preview: "Preview", artifacts: "Artifacts", tools: "More" }[tab])}</button>)}</nav>
            <div className="developer-panel-body">
              {panelLoading && <p role="status">{t("Loading…")}</p>}{panelError && <p role="alert">{panelError}</p>}
              {panelTab === "files" && <ProjectFiles client={client} {...(snapshot.project ? { projectId: snapshot.project.id } : {})} {...(snapshot.selectedSessionId ? { sessionId: snapshot.selectedSessionId } : {})} capabilities={capabilities} readOnly={replayReadOnly} online={snapshot.connection.state === "live"} onDirty={setFileDirty} />}
              {panelTab === "changes" && (review.run ? <><ChangesView {...(reviewPath ? { requestedPath: reviewPath } : {})} {...(review.run.codeIntel ? { codeIntel: review.run.codeIntel } : {})} diffs={reviewEvidence.diffs} edges={reviewEvidence.graphEdges} evidence={reviewEvidence.evidence} files={reviewEvidence.changedFiles} nodes={reviewEvidence.graphNodes} onJumpToPatch={() => { if (!reviewSnapshot) { jumpToPatch(); setDetailsOpen(true); } }} patchId={reviewEvidence.patchEventId} verified={["available", "demo"].includes(reviewEvidence.evidence.test.status)} /><RollbackControls key={review.run.id} actions={review.run.appliedActions ?? []} client={client} capabilities={capabilities} status={review.run.status} readOnly={replayReadOnly || snapshot.dataSource !== "live" || Boolean(reviewSnapshot)} /></> : <p className="panel-empty">{t("No recorded changes yet.")}</p>)}
              {panelTab === "artifacts" && <><GeneratedGallery artifacts={review.run?.generatedArtifacts ?? []} disabled={generatedPreviewsDisabledReason !== null} {...(generatedPreviewsDisabledReason ? { disabledReason: generatedPreviewsDisabledReason } : {})} onLoad={(runId, artifactId) => client.loadGeneratedArtifact(runId, artifactId)} />{!review.run?.generatedArtifacts?.length && <p className="panel-empty">{t("No generated artifacts in this Run.")}</p>}</>}
              {["terminal", "preview", "tools"].includes(panelTab) && <WorkspaceResources key={panelTab} embedded initialTab={panelTab === "terminal" ? "terminal" : panelTab === "preview" ? "preview" : "runs"} client={client} onClose={closePanel} onOpenSession={openSession} snapshot={snapshot} />}
            </div>
          </aside>}

        </div>

        {notificationsOpen && <section className="notification-panel" aria-label={t("Notifications")}><header><strong>{t("Notifications")}</strong><button className="icon-button" aria-label={t("Close notifications")} onClick={() => setNotificationsOpen(false)} type="button"><Icon name="close" size={16} /></button></header>{notifications.length === 0 && <p>{t("No notifications")}</p>}{notifications.map((notification) => <button key={notification.notification_id} data-notification-id={notification.notification_id} data-event-id={notification.event_id} disabled={!notification.session_id} onClick={() => { if (notification.session_id) void openSession(notification.session_id); setNotificationsOpen(false); }} type="button">{notification.task} · {t(notification.status)}</button>)}</section>}
        {detailsOpen && run && (
          <><button aria-label={t("Close details")} className="drawer-backdrop" onClick={() => setDetailsOpen(false)} type="button" /><Inspector drawer event={displayedEvent} onClose={() => setDetailsOpen(false)} onLoadContextArchive={(artifactId) => client.loadContextArchive(run.id, artifactId)} scope={selectedEvidence} /></>
        )}
        {detailsOpen && selectedEvent && snapshot.dataSource === "live" && !replayReadOnly && <button className="button subtle inspector-replay-action" onClick={() => selectEvent(selectedEvent)} type="button">{t("Replay at event")} #{selectedEvent.sequence}</button>}
        {logOpen && view === "chat" && hasTestOutput(selectedEvidence.evidence.test) && (
          <><button aria-label={t("Close log")} className="drawer-backdrop" onClick={() => setLogOpen(false)} type="button" /><section className="bottom-drawer"><header><div><Icon name="terminal" size={15} /><strong>{t("Test output")}</strong><span>{selectedEvidence.evidence.test.artifactId ?? t("unavailable")}</span></div><IconButton icon="close" label={t("Close log")} onClick={() => setLogOpen(false)} /></header><pre>{selectedEvidence.evidence.test.content ?? selectedEvidence.evidence.test.message}</pre></section></>
        )}
      </div>
      {setupOpen && modelConfiguration && !replayReadOnly && snapshot.dataSource === "live" && <SetupFlow client={client} configuration={modelConfiguration} capabilities={capabilities} projects={snapshot.availableProjects} onConfigured={(value) => { setModelConfiguration(value); setModelName(value.configured ? value.model : null); setModelError(null); }} onClose={() => setSetupOpen(false)} onFinish={() => { setSetupOpen(false); setView("chat"); }} />}
      {fileContextOpen && snapshot.project && <ProjectFileContextPicker key={snapshot.project.id} client={client} projectId={snapshot.project.id} selected={draft.fileContexts} onChange={setFollowupFileContexts} onClose={() => setFileContextOpen(false)} online={snapshot.connection.state === "live"} readOnly={replayReadOnly} capabilities={capabilities} />}
      {snapshot.dataSource === "live" && <MediaStudio open={mediaOpen && !replayReadOnly} client={client} capabilities={capabilities} onClose={() => setMediaOpen(false)} onSettings={() => { setSettingsCategory("model"); setSettingsOpen(true); }} onCreated={() => setView("chat")} />}
      <UnifiedSettings initialCategory={settingsCategory} client={client} onClose={closeSettings} onMemory={() => { setSettingsOpen(false); setMemoryOpen(true); }} onApplied={applySharedSettings} open={settingsOpen && !replayReadOnly} />
      {paletteOpen && <CommandPalette snapshot={snapshot} onClose={() => setPaletteOpen(false)} onSearch={(query) => client.searchSessions(query)} onSession={openSession} onNewChat={async () => { if (confirmFileNavigation()) await client.returnHome(); }} onSettings={() => setSettingsOpen(true)} onMemory={() => setMemoryOpen(true)} onResources={() => setResourcesOpen(true)} onReview={reviewLatest} {...(!replayReadOnly && ["media.generate", "media.diagram", "media.chart"].some((operation) => capabilityAvailable(capabilities, operation)) ? { onCreateMedia: () => setMediaOpen(true) } : {})} />}
      {memoryOpen && !replayReadOnly && <MemoryControlPanel page online={snapshot.connection.state === "live"} readable={capabilities === null ? null : capabilityReadable(capabilities, "memory.read")} onReconnect={repairConnection} writable={capabilityAvailable(capabilities, "memory.write")} experienceWritable={capabilityAvailable(capabilities, "experience.write")}
        onClose={() => setMemoryOpen(false)}
        {...(snapshot.project?.id === undefined ? {} : { projectId: snapshot.project.id })}
        onList={() => client.listMemoryControl()}
        onCreate={(input) => client.createMemoryCandidate(input)}
        onReview={(memoryId, input) => client.reviewMemory(memoryId, input)}
        onCorrect={(memoryId, input) => client.correctMemory(memoryId, input)}
        onRevoke={(memoryId, input) => client.revokeMemory(memoryId, input)}
        onDelete={(memoryId) => client.deleteMemory(memoryId)}
        onListExperiences={() => client.listExperienceCases()}
        onReviewExperience={(caseId, input) => client.reviewExperienceCase(caseId, input)}
      />}
    </div>
  );
}

export function App({ client }: { client: WorkbenchClient }) {
  return <LanguageProvider><Workbench client={client} /></LanguageProvider>;
}
