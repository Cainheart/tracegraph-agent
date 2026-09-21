import { useState } from "react";
import type { RunStatus, WorkbenchSnapshot, WorkspaceKind } from "../model";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";
import { SectionLabel, StatusPill } from "./Primitives";

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

export function Sidebar({
  snapshot,
  onChooseProject,
  onSelectProject,
  onRemoveProject,
  onSearchSessions,
  onSelectSession,
  onDeleteSession,
  onResumeSession,
  onReturnHome,
  onOpenLocal,
  onPreviewState,
  onOpenSettings,
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
  onPreviewState: (status: RunStatus) => void;
  onOpenSettings?: () => void;
  readOnly?: boolean;
}) {
  const { t } = useI18n();
  const { project, run } = snapshot;
  const [removingProjectId, setRemovingProjectId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [sessionQuery, setSessionQuery] = useState("");
  const [sessionBusyId, setSessionBusyId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [openingLocal, setOpeningLocal] = useState(false);
  const [localOpenError, setLocalOpenError] = useState<string | null>(null);
  const currentStatus = project ? (run?.status ?? "ready") : "empty";
  const localAvailable = snapshot.availableProjects.some((candidate) => candidate.workspaceKind === "readonly_local");
  const managedAvailable = snapshot.availableProjects.some((candidate) => candidate.workspaceKind === "managed_local");

  return (
    <aside className="sidebar" aria-label={t("Project and run navigation")}>
      <div className="sidebar-scroll">
        <nav aria-label={t("Application navigation")} className="sidebar-app-nav">
          <button
            className="sidebar-new-chat"
            disabled={readOnly || run?.status === "running" || run?.status === "indexing" || run?.status === "reconnecting"}
            onClick={onReturnHome}
            type="button"
          >
            <Icon name="message" size={15} />
            <span>{t("New chat")}</span>
          </button>
        </nav>
        <SectionLabel>{t("Project")}</SectionLabel>

        {project ? (
          <button className="project-card project-card-button" disabled={readOnly || run?.status === "running" || run?.status === "indexing" || run?.status === "reconnecting"} onClick={onReturnHome} title={t("Choose another project or start a plain chat")} type="button">
            <span className="project-icon"><Icon name="folder" size={17} /></span>
            <div className="project-card-copy compact-hide">
              <strong>{project.name}</strong>
            </div>
            <Icon name="chevron" className="project-chevron compact-hide" size={14} />
          </button>
        ) : run ? (
          <button
            className="project-card project-card-button is-empty"
            disabled={readOnly || run.status === "running" || run.status === "indexing" || run.status === "reconnecting"}
            onClick={onReturnHome}
            title={t("Choose another project or start a plain chat")}
            type="button"
          >
            <span className="project-icon"><Icon name="message" size={17} /></span>
            <div className="project-card-copy compact-hide"><strong>{t("Plain chat")}</strong><span>{t("No filesystem or tool access")}</span></div>
            <Icon name="chevron" className="project-chevron compact-hide" size={14} />
          </button>
        ) : (
          <div className="project-card is-empty">
            <span className="project-icon"><Icon name="folder" size={17} /></span>
            <div className="project-card-copy compact-hide"><strong>{t("No project")}</strong><span>{t("Select a safe workspace")}</span></div>
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
          {snapshot.availableProjects.filter((candidate) => candidate.id !== project?.id).map((candidate) => <div className="workspace-option-row" key={candidate.id}>
            <button className="workspace-option" disabled={readOnly} onClick={() => onSelectProject(candidate.id)} type="button"><Icon name={candidate.location?.kind === "linked_directory" ? "code" : "folder"} size={15} /><span><strong>{candidate.name}</strong></span></button>
            {(candidate.location?.kind === "linked_directory" || candidate.location?.kind === "managed_storage") && <button
              aria-label={`${t("Remove project")}: ${candidate.name}`}
              className="workspace-option-remove"
              disabled={readOnly || removingProjectId === candidate.id}
              onClick={() => {
                if (removingProjectId !== null) return;
                const confirmation = candidate.location?.kind === "managed_storage"
                  ? t("Delete this managed project? Its TraceGraph-managed files will be deleted.")
                  : t("Remove this project registration? The folder and files will not be deleted.");
                if (!window.confirm(confirmation)) return;
                setRemoveError(null);
                setRemovingProjectId(candidate.id);
                void onRemoveProject(candidate.id).catch((error: unknown) => {
                  setRemoveError(error instanceof Error ? error.message : String(error));
                }).finally(() => setRemovingProjectId(null));
              }}
              title={t(candidate.location?.kind === "managed_storage" ? "Delete managed project" : "Remove project registration")}
              type="button"
            ><Icon name="close" size={12} /></button>}
          </div>)}
          {snapshot.dataSource === "demo" && <>
            <button className={project?.workspaceKind === "managed_local" ? "workspace-option active" : "workspace-option"} disabled={readOnly || !managedAvailable} onClick={() => onChooseProject("managed_local")} type="button"><Icon name="folder" size={15} /><span><strong>{t("Managed project")}</strong><small>{t("Persistent · gated writes")}</small></span></button>
            <button className={project?.workspaceKind === "readonly_local" ? "workspace-option active" : "workspace-option"} disabled={readOnly || !localAvailable} onClick={() => onChooseProject("readonly_local")} type="button"><Icon name="code" size={15} /><span><strong>{t("Local repository")}</strong><small>{t("Read-only in P0")}</small></span></button>
          </>}
        </div>
        {removeError && <div className="sidebar-action-error" role="alert">{removeError}</div>}

        <div className="sidebar-separator" />
        <SectionLabel>{t("Sessions")}</SectionLabel>
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
          {snapshot.sessions.map((session) => {
            const selected = snapshot.selectedSessionId === session.session_id;
            const canResume = selected && (run?.status === "interrupted" || run?.status === "needs_approval");
            return <div className={`session-row ${selected ? "active" : ""}`} key={session.session_id}>
              <button
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
                <span><strong>{session.title ?? t("Untitled session")}</strong><small>{formatSessionUpdatedAt(session.updated_at)} · {session.run_ids.length} {t("runs")}</small></span>
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
              <button
                aria-label={`${t("Delete session")}: ${session.title ?? session.session_id}`}
                className="session-action delete"
                disabled={readOnly || sessionBusyId !== null}
                onClick={() => {
                  if (!window.confirm(t("Move this session to TraceGraph trash?"))) return;
                  setSessionError(null);
                  setSessionBusyId(session.session_id);
                  void onDeleteSession(session.session_id).catch((error: unknown) => {
                    setSessionError(error instanceof Error ? error.message : String(error));
                  }).finally(() => setSessionBusyId(null));
                }}
                title={t("Delete session")}
                type="button"
              ><Icon name="close" size={11} /></button>
            </div>;
          })}
          {snapshot.sessions.length === 0 && <div className="no-sessions">{t(sessionQuery ? "No sessions match this search" : "No durable sessions yet")}</div>}
        </div>
        {sessionError && <div className="sidebar-action-error" role="alert">{sessionError}</div>}

        <div className="sidebar-separator" />
        <SectionLabel>{t("Current run")}</SectionLabel>

        {run ? (
          <button className="run-card is-current" type="button">
            <span className={`run-indicator tone-${run.status}`}><Icon name="activity" size={15} /></span>
            <span className="run-card-copy compact-hide">
              <strong>{run.task}</strong>
              <span><StatusPill status={run.status} small /></span>
            </span>
          </button>
        ) : (
          <div className="no-run compact-hide">
            <span className="empty-ring" />
            <span>{t("No active run")}</span>
          </div>
        )}

        {run?.status === "needs_approval" && (
          <div className="needs-action compact-hide">
            <Icon name="shield" size={15} />
            <span><strong>{t("Action needed")}</strong><small>{t("Patch approval is waiting")}</small></span>
          </div>
        )}

        {(run?.status === "completed" || run?.status === "historical") && (
          <button className="previous-run compact-hide" type="button">
            <Icon name="check" size={14} />
            <span>{t("Current projection")}</span>{run.elapsed && <small>{run.elapsed}</small>}
          </button>
        )}
      </div>

      <div className="sidebar-footer">
        {snapshot.dataSource === "demo" && <label className="preview-control compact-hide">
          <span>{t("Prototype state")}</span>
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
              <span className="sidebar-account-avatar">TG</span>
              <span><strong>TraceGraph</strong><small>{t("Local workspace")}</small></span>
            </div>
            <button className="sidebar-account-item" onClick={() => { setAccountMenuOpen(false); onOpenSettings?.(); }} role="menuitem" type="button"><Icon name="settings" size={15} /><span>{t("Settings")}</span><kbd>⌘,</kbd></button>
          </div>
        )}
        <button aria-expanded={accountMenuOpen} aria-haspopup="menu" className={`sidebar-account-trigger ${accountMenuOpen ? "is-open" : ""}`} onClick={() => setAccountMenuOpen((open) => !open)} type="button">
          <span className="sidebar-account-avatar">TG</span>
          <span className="sidebar-account-copy compact-hide"><strong>TraceGraph</strong><small>{t("Local workspace")}</small></span>
          <Icon className="sidebar-account-chevron compact-hide" name="chevron" size={14} />
        </button>
      </div>
    </aside>
  );
}

function formatSessionUpdatedAt(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
