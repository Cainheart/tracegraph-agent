import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { PersonalProfileValues } from "@tracegraph/contracts";
import type { RunStatus, WorkbenchSnapshot, WorkspaceKind } from "../model";
import { useI18n, type Language } from "../i18n";
import { Icon } from "./Icon";
import { BrandMark, SectionLabel } from "./Primitives";

const previewStates: readonly { value: RunStatus; label: string }[] = [
  { value: "empty", label: "No project" },
  { value: "ready", label: "Project ready" },
  { value: "indexing", label: "Indexing" },
  { value: "running", label: "Running" },
  { value: "needs_approval", label: "Needs approval" },
  { value: "ready_for_review", label: "Ready for review" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "interrupted", label: "Interrupted" },
  { value: "historical", label: "Historical run" },
  { value: "reconnecting", label: "Reconnecting" },
];

type ConfirmationRequest = {
  kind: "project" | "session";
  id: string;
  title: string;
  message: string;
  confirmLabel: string;
};

export function Sidebar({
  snapshot,
  onChooseProject,
  onSelectProject,
  onOpenProjectFile,
  onRemoveProject,
  onSearchSessions,
  onSelectSession,
  onDeleteSession,
  onResumeSession,
  onReturnHome,
  onOpenLocal,
  onPreviewState,
  onOpenSettings,
  onOpenMemory,
  onOpenHelp,
  onOpenGoals,
  onOpenHistory,
  onOpenResources,
  onOpenNotifications,
  onOpenPalette,
  onArchiveSession,
  archivedSessionIds = [],
  personalIdentity,
  onRenameSession,
  readOnly = false,
}: {
  snapshot: WorkbenchSnapshot;
  onChooseProject: (kind: WorkspaceKind) => void;
  onSelectProject: (projectId: string) => void;
  onRemoveProject: (projectId: string) => Promise<void>;
  onSearchSessions: (query: string) => Promise<void>;
  onSelectSession: (sessionId: string) => Promise<void>;
  onDeleteSession: (sessionId: string) => Promise<void>;
  onResumeSession: (sessionId: string) => Promise<void>;
  onReturnHome: () => void;
  onOpenLocal?: (access: "read_write" | "read_only") => Promise<void>;
  onOpenProjectFile?: (projectId: string) => Promise<void>;
  onPreviewState: (status: RunStatus) => void;
  onOpenSettings?: () => void;
  onOpenMemory?: () => void;
  onOpenHelp?: () => void;
  onOpenGoals?: () => void;
  onOpenHistory?: () => void;
  readOnly?: boolean;
  onOpenResources?: () => void;
  onOpenNotifications?: () => void;
  onOpenPalette?: () => void;
  onArchiveSession?: (sessionId: string) => Promise<void>;
  onRenameSession?: (sessionId: string, title: string) => Promise<void>;
  archivedSessionIds?: readonly string[];
  personalIdentity?: Pick<PersonalProfileValues, "display_name" | "avatar_color"> | undefined;
}) {
  const { t, language } = useI18n();
  const { project, run } = snapshot;
  const [removingProjectId, setRemovingProjectId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [sessionQuery, setSessionQuery] = useState("");
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<string>>(() => new Set(snapshot.project ? [snapshot.project.id] : []));
  const [sessionBusyId, setSessionBusyId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [openingLocal, setOpeningLocal] = useState(false);
  const [localOpenError, setLocalOpenError] = useState<string | null>(null);
  const [openingProjectFile, setOpeningProjectFile] = useState(false);
  const [openProjectFileError, setOpenProjectFileError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const [confirmationPending, setConfirmationPending] = useState(false);
  const confirmationTriggerRef = useRef<HTMLButtonElement | null>(null);
  const currentStatus = project ? (run?.status ?? "ready") : "empty";
  const localAvailable = snapshot.availableProjects.some((candidate) => candidate.workspaceKind === "readonly_local");
  const managedAvailable = snapshot.availableProjects.some((candidate) => candidate.workspaceKind === "managed_local");
  const savedName = personalIdentity?.display_name.trim();
  const accountName = savedName === "Local user" ? t("Local user") : savedName || "Outlive Agent";
  const accountInitial = personalIdentity ? Array.from(accountName)[0] ?? "O" : "O";
  const accountColors = { slate: "#64748b", blue: "#4b79b8", green: "#3c806f", amber: "#99752e", rose: "#b35c72", violet: "#8264ab" };
  const avatarStyle = personalIdentity ? { backgroundColor: accountColors[personalIdentity.avatar_color], color: "#fff" } : undefined;

  const restoreConfirmationTrigger = () => {
    const trigger = confirmationTriggerRef.current;
    window.setTimeout(() => {
      if (trigger?.isConnected) {
        trigger.focus();
        return;
      }
      document.querySelector<HTMLButtonElement>(".sidebar-new-chat")?.focus();
    }, 0);
  };

  const closeConfirmation = () => {
    if (confirmationPending) return;
    setConfirmation(null);
    restoreConfirmationTrigger();
  };

  const requestConfirmation = (request: ConfirmationRequest, trigger: HTMLButtonElement) => {
    if (confirmationPending) return;
    confirmationTriggerRef.current = trigger;
    setConfirmation(request);
  };

  const confirmPendingAction = () => {
    if (!confirmation || confirmationPending) return;
    const pending = confirmation;
    setConfirmationPending(true);
    if (pending.kind === "project") {
      setRemoveError(null);
      setRemovingProjectId(pending.id);
      void Promise.resolve().then(() => onRemoveProject(pending.id)).catch((error: unknown) => {
        setRemoveError(error instanceof Error ? error.message : String(error));
      }).finally(() => {
        setRemovingProjectId(null);
        setConfirmationPending(false);
        setConfirmation(null);
        restoreConfirmationTrigger();
      });
      return;
    }
    setSessionError(null);
    setSessionBusyId(pending.id);
    void Promise.resolve().then(() => onDeleteSession(pending.id)).catch((error: unknown) => {
      setSessionError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      setSessionBusyId(null);
      setConfirmationPending(false);
      setConfirmation(null);
      restoreConfirmationTrigger();
    });
  };

  const renderSession = (session: WorkbenchSnapshot["sessions"][number]) => {
            const selected = snapshot.selectedSessionId === session.session_id;
            const canResume = selected && (run?.status === "interrupted" || run?.status === "needs_approval");
            return <div className={`session-row ${selected ? "active" : ""}`} key={session.session_id}>
              <button
                aria-current={selected ? "page" : undefined}
                className="session-card"
                disabled={readOnly || sessionBusyId !== null}
                onClick={() => {
                  setSessionError(null);
                  setSessionBusyId(session.session_id);
                  void onSelectSession(session.session_id).catch((error: unknown) => {
                    setSessionError(error instanceof Error ? error.message : String(error));
                  }).finally(() => setSessionBusyId(null));
                }}
                type="button"
              >
                <Icon name={selected ? "activity" : "clock"} size={13} />
                <span><strong>{session.title ?? t("Untitled session")}</strong><small>{formatSessionUpdatedAt(session.updated_at, language)} · {session.run_ids.length} {t("runs")}</small></span>
              </button>
              {canResume && <button
                aria-label={`${t("Resume session")}: ${session.title ?? session.session_id}`}
                className="session-action resume"
                disabled={readOnly || sessionBusyId !== null}
                onClick={() => {
                  setSessionError(null);
                  setSessionBusyId(session.session_id);
                  void onResumeSession(session.session_id).catch((error: unknown) => {
                    setSessionError(error instanceof Error ? error.message : String(error));
                  }).finally(() => setSessionBusyId(null));
                }}
                title={t("Resume session")}
                type="button"
              ><Icon name="play" size={11} /></button>}
              {onRenameSession && <button className="session-action" aria-label={`${t("Rename session")}: ${session.title ?? session.session_id}`} disabled={readOnly || sessionBusyId !== null} onClick={() => { const title = window.prompt(t("Session title"), session.title ?? ""); if (title?.trim()) { setSessionBusyId(session.session_id); void onRenameSession(session.session_id, title.trim()).catch((caught) => setSessionError(caught instanceof Error ? caught.message : String(caught))).finally(() => setSessionBusyId(null)); } }} type="button"><Icon name="more" size={12} /></button>}
              {onArchiveSession && <button className="session-action" aria-label={`${t("Archive session")}: ${session.title ?? session.session_id}`} disabled={readOnly || sessionBusyId !== null} onClick={() => { setSessionBusyId(session.session_id); void onArchiveSession(session.session_id).catch((caught) => setSessionError(caught instanceof Error ? caught.message : String(caught))).finally(() => setSessionBusyId(null)); }} type="button"><Icon name="folder" size={12} /></button>}
              <button
                aria-label={`${t("Delete session")}: ${session.title ?? session.session_id}`}
                className="session-action delete"
                disabled={readOnly || sessionBusyId !== null}
                onClick={(event) => {
                  if (confirmationPending) return;
                  requestConfirmation({
                    kind: "session",
                    id: session.session_id,
                    title: t("Delete session"),
                    message: t("Move this session to Outlive Agent trash?"),
                    confirmLabel: t("Move to trash"),
                  }, event.currentTarget);
                }}
                title={t("Delete session")}
                type="button"
              ><Icon name="close" size={11} /></button>
            </div>;
  };


  return (
    <aside id="workbench-navigation" className="sidebar" aria-label={t("Project and run navigation")}>
      <div className="sidebar-brand"><BrandMark /><span className="alpha-label">alpha</span></div>
      <div className="sidebar-scroll">
        <nav aria-label={t("Application navigation")} className="sidebar-app-nav">
          <button
            className="sidebar-new-chat"
            disabled={readOnly}
            onClick={onReturnHome}
            type="button"
          >
            <Icon name="message" size={15} />
            <span>{t("New chat")}</span>
          </button>
          {onOpenMemory && <button
            className="sidebar-new-chat memory-control-trigger"
            disabled={readOnly || snapshot.connection.state !== "live"}
            onClick={onOpenMemory}
            type="button"
          ><Icon name="layers" size={15} /><span>{t("Memory")}</span></button>}
        </nav>
        <SectionLabel>{t("Projects")}</SectionLabel>

        {project?.location?.kind === "linked_directory" && onOpenProjectFile && (
          <div className="sidebar-local-entry compact-hide">
            <button
              className="sidebar-open-local sidebar-open-project-file"
              disabled={readOnly || openingProjectFile || snapshot.connection.state !== "live"}
              onClick={() => {
                setOpenProjectFileError(null);
                setOpeningProjectFile(true);
                void onOpenProjectFile(project.id).catch((error: unknown) => {
                  setOpenProjectFileError(error instanceof Error ? error.message : String(error));
                }).finally(() => setOpeningProjectFile(false));
              }}
              type="button"
            >
              <Icon name="file" size={15} />
              <span>{t(openingProjectFile ? "Opening…" : "Open project file")}</span>
            </button>
            {openProjectFileError && <div className="sidebar-action-error" role="alert">{openProjectFileError}</div>}
          </div>
        )}

        {onOpenLocal && (
          <div className="sidebar-local-entry compact-hide">
            <button
              className="sidebar-open-local"
              disabled={readOnly || openingLocal || snapshot.connection.state !== "live"}
              onClick={() => {
                setLocalOpenError(null);
                setOpeningLocal(true);
                void onOpenLocal("read_write").catch((error: unknown) => {
                  setLocalOpenError(error instanceof Error ? error.message : String(error));
                }).finally(() => setOpeningLocal(false));
              }}
              type="button"
            >
              <Icon name="folder" size={15} />
              <span>{t(openingLocal ? "Opening…" : "Open local folder")}</span>
            </button>
            {localOpenError && <div className="sidebar-action-error" role="alert">{localOpenError}</div>}
          </div>
        )}

        <div className="workspace-options compact-hide">
          {snapshot.availableProjects.map((candidate) => <div className="sidebar-project-group" key={candidate.id}><div className={`workspace-option-row ${project?.id === candidate.id ? "active" : ""}`}>
            <button className="workspace-option" aria-current={project?.id === candidate.id ? "page" : undefined} disabled={readOnly} onClick={() => { setExpandedProjects((prior) => new Set(prior).add(candidate.id)); onSelectProject(candidate.id); }} type="button"><Icon name={candidate.location?.kind === "linked_directory" ? "code" : "folder"} size={15} /><span><strong>{candidate.name}</strong></span></button>
            <button className="project-expand" aria-label={`${t(expandedProjects.has(candidate.id) ? "Collapse project" : "Expand project")}: ${candidate.name}`} aria-expanded={expandedProjects.has(candidate.id)} onClick={() => setExpandedProjects((prior) => { const next = new Set(prior); if (next.has(candidate.id)) next.delete(candidate.id); else next.add(candidate.id); return next; })} type="button"><Icon name="chevron" size={12} /></button>
            {(candidate.location?.kind === "linked_directory" || candidate.location?.kind === "managed_storage") && <button
              aria-label={`${t("Remove project")}: ${candidate.name}`}
              className="workspace-option-remove"
              disabled={readOnly || removingProjectId === candidate.id}
              onClick={(event) => {
                if (removingProjectId !== null || confirmationPending) return;
                const managed = candidate.location?.kind === "managed_storage";
                requestConfirmation({
                  kind: "project",
                  id: candidate.id,
                  title: t(managed ? "Delete managed project" : "Remove project registration"),
                  message: t(managed ? "Delete this managed project? Its Outlive Agent-managed files will be deleted." : "Remove this project registration? The folder and files will not be deleted."),
                  confirmLabel: t(managed ? "Delete managed project" : "Remove project"),
                }, event.currentTarget);
              }}
              title={t(candidate.location?.kind === "managed_storage" ? "Delete managed project" : "Remove project registration")}
              type="button"
            ><Icon name="close" size={12} /></button>}
          </div>{expandedProjects.has(candidate.id) && <div className="project-session-list">{snapshot.sessions.filter((session) => session.project_id === candidate.id && !archivedSessionIds.includes(session.session_id)).map(renderSession)}{!snapshot.sessions.some((session) => session.project_id === candidate.id && !archivedSessionIds.includes(session.session_id)) && <p className="no-sessions">{t("No recent conversations in this project")}</p>}</div>}</div>)}
          {snapshot.dataSource === "demo" && <>
            <button className={project?.workspaceKind === "managed_local" ? "workspace-option active" : "workspace-option"} disabled={readOnly || !managedAvailable} onClick={() => onChooseProject("managed_local")} type="button"><Icon name="folder" size={15} /><span><strong>{t("Managed project")}</strong><small>{t("Persistent · gated writes")}</small></span></button>
            <button className={project?.workspaceKind === "readonly_local" ? "workspace-option active" : "workspace-option"} disabled={readOnly || !localAvailable} onClick={() => onChooseProject("readonly_local")} type="button"><Icon name="code" size={15} /><span><strong>{t("Local repository")}</strong><small>{t("Read-only in P0")}</small></span></button>
          </>}
        </div>
        {removeError && <div className="sidebar-action-error" role="alert">{removeError}</div>}

        <div className="sidebar-separator" />
        <SectionLabel>{t("Recents")}{onOpenHistory && <button className="icon-button" aria-label={t("Search public history")} disabled={readOnly} onClick={onOpenHistory} type="button"><Icon name="search" size={13} /></button>}</SectionLabel>
        <form
          className="session-search compact-hide"
          onSubmit={(event) => {
            event.preventDefault();
            setSessionError(null);
            void onSearchSessions(sessionQuery).catch((error: unknown) => {
              setSessionError(error instanceof Error ? error.message : String(error));
            });
          }}
        >
          <Icon name="search" size={13} />
          <input
            aria-label={t("Search sessions")}
            disabled={readOnly}
            onChange={(event) => setSessionQuery(event.target.value)}
            placeholder={t("Search sessions")}
            type="search"
            value={sessionQuery}
          />
        </form>
        <div className="session-list compact-hide">
          {snapshot.sessions.filter((session) => !archivedSessionIds.includes(session.session_id)).map(renderSession)}
          {snapshot.sessions.length === 0 && <div className="no-sessions">{t(sessionQuery ? "No sessions match this search" : "No durable sessions yet")}</div>}
        </div>
        {sessionError && <div className="sidebar-action-error" role="alert">{sessionError}</div>}

      </div>

      <div className="sidebar-footer">
        {snapshot.dataSource === "demo" && <label className="preview-control compact-hide">
          <span>{t("Preview · deterministic example data")}</span>
          <select
            aria-label={t("Preview a workbench state")}
            disabled={readOnly}
            onChange={(event) => onPreviewState(event.target.value as RunStatus)}
            value={currentStatus}
          >
            {previewStates.map((state) => <option key={state.value} value={state.value}>{t(state.label)}</option>)}
          </select>
        </label>}
        {accountMenuOpen && (
          <div className="sidebar-account-menu" role="menu">
            <div className="sidebar-account-profile">
              <span className="sidebar-account-avatar" style={avatarStyle} aria-hidden="true">{accountInitial}</span>
              <span><strong title={accountName} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{accountName}</strong><small>{t("Local workspace")}</small></span>
            </div>
            {onOpenPalette && <button className="sidebar-account-item" onClick={() => { setAccountMenuOpen(false); onOpenPalette(); }} role="menuitem" type="button"><Icon name="search" size={15} />{t("Command palette")}<kbd>⌘K</kbd></button>}
            {onOpenResources && <button className="sidebar-account-item" onClick={() => { setAccountMenuOpen(false); onOpenResources(); }} role="menuitem" type="button"><Icon name="terminal" size={15} />{t("Workspace tools")}</button>}
            {onOpenNotifications && <button className="sidebar-account-item" onClick={() => { setAccountMenuOpen(false); onOpenNotifications(); }} role="menuitem" type="button"><Icon name="flag" size={15} />{t("Notifications")}</button>}
            {onOpenGoals && <button className="sidebar-account-item" onClick={() => { setAccountMenuOpen(false); onOpenGoals(); }} role="menuitem" type="button"><Icon name="route" size={15} />{t("Goals")}</button>}
            {onOpenHelp && <button className="sidebar-account-item" onClick={() => { setAccountMenuOpen(false); onOpenHelp(); }} role="menuitem" type="button"><Icon name="message" size={15} />{t("Help")}</button>}
            <button className="sidebar-account-item" onClick={() => { setAccountMenuOpen(false); onOpenSettings?.(); }} role="menuitem" type="button"><Icon name="settings" size={15} /><span>{t("Settings")}</span><kbd>⌘,</kbd></button>
          </div>
        )}
        <button aria-expanded={accountMenuOpen} aria-haspopup="menu" className={`sidebar-account-trigger ${accountMenuOpen ? "is-open" : ""}`} onClick={() => setAccountMenuOpen((open) => !open)} type="button">
          <span className="sidebar-account-avatar" style={avatarStyle} aria-hidden="true">{accountInitial}</span>
          <span className="sidebar-account-copy compact-hide"><strong title={accountName} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{accountName}</strong><small>{t("Local workspace")}</small></span>
          <Icon className="sidebar-account-chevron compact-hide" name="chevron" size={14} />
        </button>
      </div>
      {confirmation && <ConfirmationDialog confirmation={confirmation} onCancel={closeConfirmation} onConfirm={confirmPendingAction} pending={confirmationPending} />}
    </aside>
  );
}

function ConfirmationDialog({ confirmation, onCancel, onConfirm, pending }: { confirmation: ConfirmationRequest; onCancel: () => void; onConfirm: () => void; pending: boolean }) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const focusTimer = window.setTimeout(() => cancelRef.current?.focus(), 0);
    return () => window.clearTimeout(focusTimer);
  }, []);

  const trapFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!pending) onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
    ) ?? []);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="confirm-dialog-backdrop" role="presentation">
      <div
        aria-describedby="tracegraph-confirm-message"
        aria-labelledby="tracegraph-confirm-title"
        aria-modal="true"
        aria-busy={pending}
        className="confirm-dialog"
        onKeyDown={trapFocus}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="confirm-dialog-heading">
          <span className="confirm-dialog-icon"><Icon name={confirmation.kind === "session" ? "close" : "folder"} size={16} /></span>
          <div>
            <strong id="tracegraph-confirm-title">{confirmation.title}</strong>
            <p id="tracegraph-confirm-message">{confirmation.message}</p>
          </div>
        </div>
        <div className="confirm-dialog-actions">
          <button className="button subtle" disabled={pending} onClick={onCancel} ref={cancelRef} type="button">{t("Cancel")}</button>
          <button className="button danger" disabled={pending} onClick={onConfirm} type="button">{pending ? t("Working on your request") : confirmation.confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function formatSessionUpdatedAt(value: string, language: Language): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(language, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
