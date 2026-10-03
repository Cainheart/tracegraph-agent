import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { HostCapabilities, WorkbenchCommandRequest, WorkbenchCommandResult, WorkbenchResources, GitStatusSnapshot, ScheduleInput, ScheduleSnapshot, TerminalSnapshot } from "@tracegraph/contracts";
import type { WorkbenchClient } from "../client";
import type { WorkbenchSnapshot } from "../model";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";
import { orderedTerminalInput } from "../terminal-input";
import { capabilityAvailable, capabilityReadable, capabilityFor, commandId, safeError } from "./UnifiedSettings";

export type ToolTab = "runs" | "git" | "terminal" | "preview" | "schedules" | "archive";
const tabs: readonly [ToolTab, string][] = [["runs", "Background tasks"], ["git", "Git and worktrees"], ["terminal", "Terminal"], ["preview", "Preview services"], ["schedules", "Schedules"], ["archive", "Archive"]];

export function WorkspaceResources({ client, snapshot, onClose, onOpenSession, embedded = false, initialTab = "runs" }: { embedded?: boolean; initialTab?: ToolTab; client: WorkbenchClient; snapshot: WorkbenchSnapshot; onClose: () => void; onOpenSession: (sessionId: string) => Promise<void> }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<ToolTab>(initialTab);
  const [resources, setResources] = useState<WorkbenchResources | null>(null);
  const [capabilities, setCapabilities] = useState<HostCapabilities | null>(null);
  const [cancelling, setCancelling] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<WorkbenchCommandResult | null>(null);
  const [git, setGit] = useState<GitStatusSnapshot | null>(null);
  const [discardReview, setDiscardReview] = useState<{ path: string; head: string; diff: string } | null>(null);
  const [previewOpen, setPreviewOpen] = useState<"panel" | "browser">("panel");
  const [nativePreviewOpen, setNativePreviewOpen] = useState(false);
  const [gitScope, setGitScope] = useState<"workspace" | "staged" | "branch">("workspace");
  const [gitBase, setGitBase] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [branch, setBranch] = useState("");
  const [worktreeName, setWorktreeName] = useState("");
  const [previewCommand, setPreviewCommand] = useState("");
  const [previewArgs, setPreviewArgs] = useState("[]");
  const [previewPort, setPreviewPort] = useState(4315);
  const [selectedPreview, setSelectedPreview] = useState<string | null>(null);
  const [selectedTerminal, setSelectedTerminal] = useState<string | null>(null);
  const [editing, setEditing] = useState<ScheduleSnapshot | null>(null);
  const [scheduleTitle, setScheduleTitle] = useState("");
  const [scheduleTask, setScheduleTask] = useState("");
  const [scheduleMode, setScheduleMode] = useState<"plan" | "execute">("plan");
  const [timingKind, setTimingKind] = useState<"once" | "interval" | "daily">("daily");
  const [timingValue, setTimingValue] = useState("09:00");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [scheduleProjectId, setScheduleProjectId] = useState(snapshot.project?.id ?? "");
  const projectId = snapshot.project?.id;
  const currentProject = useRef(projectId); currentProject.current = projectId;
  useEffect(() => { setGit(null); setDiscardReview(null); setReceipt(null); setSelectedTerminal(null); setSelectedPreview(null); setScheduleProjectId(projectId ?? ""); }, [projectId]);

  useEffect(() => {
    let current = true;
    void client.getWorkbenchSettings().then((preferences) => { if (current) { setGitScope(preferences.settings.developer.review_scope); setPreviewOpen(preferences.settings.developer.preview_open); } }).catch(() => {});
    return () => { current = false; if (client.closePreview) void client.closePreview().catch(() => {}); };
  }, [client]);

  useEffect(() => {
    let current = true;
    let timer: number | undefined;
    const read = async () => {
      try {
        const caps = await client.getCapabilities();
        if (!current) return;
        setCapabilities(caps);
        if (!capabilityReadable(caps, "resources.read")) throw new Error(capabilityFor(caps, "resources.read")?.reason ?? "Workspace resources are unavailable on this Host");
        const next = await client.getWorkbenchResources();
        if (current) { setResources(next); setReadError(null); }
      } catch (caught) { if (current) setReadError(safeError(caught)); }
      finally { if (current) { setLoading(false); timer = window.setTimeout(() => void read(), 1_000); } }
    };
    void read();
    return () => { current = false; window.clearTimeout(timer); };
  }, [client]);

  const run = async (input: WorkbenchCommandRequest) => {
    if (busy) return;
    setBusy(true); setError(null); setReceipt(null);
    try {
      const result = await client.workbenchCommand({ ...input, command_id: commandId() } as WorkbenchCommandRequest);
      setReceipt(result); if (result.git && result.git.project_id === currentProject.current) setGit(result.git); if (result.terminal) setSelectedTerminal(result.terminal.terminal_id); if (result.preview) setSelectedPreview(result.preview.preview_id);
      setResources(await client.getWorkbenchResources());
      return result;
    } catch (caught) { setError(safeError(caught)); return undefined; }
    finally { setBusy(false); }
  };
  const cancelTask = async (taskId: string) => {
    if (cancelling.includes(taskId)) return;
    setCancelling((ids) => [...ids, taskId]);
    try {
      if (taskId.startsWith("queued:")) setReceipt(await client.workbenchCommand({ type: "queue.cancel", command_id: commandId(), holder_id: taskId.slice(7) }));
      else await client.stopRun(taskId);
      setResources(await client.getWorkbenchResources());
    } catch (caught) { setError(safeError(caught)); }
    finally { setCancelling((ids) => ids.filter((id) => id !== taskId)); }
  };
  const closeResource = async (resourceId: string, input: WorkbenchCommandRequest) => {
    if (cancelling.includes(resourceId)) return;
    setCancelling((ids) => [...ids, resourceId]);
    try { setReceipt(await client.workbenchCommand(input)); setResources(await client.getWorkbenchResources()); }
    catch (caught) { setError(safeError(caught)); }
    finally { setCancelling((ids) => ids.filter((id) => id !== resourceId)); }
  };
  const available = (operation: string, needsProject = false) => !busy && capabilityAvailable(capabilities, operation) && (!needsProject || projectId !== undefined);
  const reason = (operation: string) => capabilityFor(capabilities, operation)?.reason ?? t("This Host does not advertise this capability.");
  const gitCommand = (input: WorkbenchCommandRequest) => void run(input);
  const fillSchedule = (schedule: ScheduleSnapshot) => { setEditing(schedule); setScheduleTitle(schedule.title); setScheduleTask(schedule.task); setScheduleMode(schedule.mode); setScheduleProjectId(schedule.project_id); setTimezone(schedule.timezone); setTimingKind(schedule.timing.kind); setTimingValue(schedule.timing.kind === "daily" ? schedule.timing.time : schedule.timing.kind === "interval" ? String(schedule.timing.seconds) : localDateTime(schedule.timing.at)); };
  const scheduleInput = (): ScheduleInput => ({ title: scheduleTitle, task: scheduleTask, project_id: scheduleProjectId, mode: scheduleMode, enabled: editing?.enabled ?? true, timezone, timing: timingKind === "daily" ? { kind: "daily", time: timingValue } : timingKind === "interval" ? { kind: "interval", seconds: Number(timingValue) } : { kind: "once", at: new Date(timingValue).toISOString() } });
  const activeTerminal = resources?.terminals.find((terminal) => terminal.terminal_id === selectedTerminal) ?? resources?.terminals.find((terminal) => terminal.state === "running");
  const activePreview = resources?.previews.find((preview) => preview.preview_id === selectedPreview);
  return <aside className={`workspace-resource-panel ${embedded ? "is-embedded" : ""}`}  aria-label={t("Workspace tools")}>{!embedded && <header><h2>{t("Workspace tools")}</h2><button className="icon-button" aria-label={t("Close workspace tools")} onClick={onClose} type="button"><Icon name="close" size={17} /></button></header>}{(!embedded || initialTab === "runs") && <nav aria-label={t("Workspace tool sections")}>{tabs.map(([id, label]) => <button aria-current={tab === id ? "page" : undefined} className={tab === id ? "active" : ""} onClick={() => { setTab(id); setReceipt(null); setError(null); }} key={id} type="button">{t(label)}</button>)}</nav>}<div className="workspace-resource-body">
    {loading && <p role="status">{t("Loading workspace resources…")}</p>}{readError && <p role="alert" className="resource-error">{t(readError)}</p>}{error && <p role="alert" className="resource-error">{t(error)}</p>}{receipt && <p role="status" className="resource-receipt">{t(receipt.status)} · {receipt.code} · {receipt.message}</p>}
    {tab === "runs" && <section><h3>{t("Background tasks")}</h3><p>{t("Closing a client leaves Host-owned tasks running. Open a task to inspect or stop it.")}</p>{resources?.runs.length === 0 && <p>{t("No background tasks")}</p>}{resources?.runs.map((task) => <div className="background-task-row" key={task.run_id}><button className="background-task-open" disabled={!task.session_id || busy} onClick={() => { if (task.session_id) void onOpenSession(task.session_id).catch((caught) => setError(safeError(caught))); }} type="button"><strong>{task.task}</strong><small>{task.project_id} · {task.run_id}</small></button><small>{t(task.status)}</small><button className="button subtle" disabled={cancelling.includes(task.run_id) || ["completed", "failed", "cancelled", "historical"].includes(task.status) || !capabilityAvailable(capabilities, task.run_id.startsWith("queued:") ? "queue.cancel" : "run.cancel")} onClick={() => void cancelTask(task.run_id)} type="button">{t(task.run_id.startsWith("queued:") ? "Cancel queued task" : "Stop task")}</button></div>)}</section>}
    {tab === "git" && <section><h3>{t("Git and worktrees")}</h3>{!projectId && <p>{t("Choose a project first")}</p>}<div className="resource-button-row"><button className="button subtle" disabled={!available("git.status", true)} title={reason("git.status")} onClick={() => projectId && gitCommand({ type: "git.status", project_id: projectId, command_id: commandId() })} type="button">{t("Refresh Git status")}</button><select aria-label={t("Git review scope")} value={gitScope} onChange={(event) => setGitScope(event.target.value as "workspace" | "staged" | "branch")}>{["workspace", "staged", "branch"].map((scope) => <option key={scope}>{scope}</option>)}</select>{gitScope === "branch" && <input aria-label={t("Compare base branch")} value={gitBase} onChange={(event) => setGitBase(event.target.value)} placeholder={t("Base branch")} />}<button className="button subtle" disabled={!available("git.diff", true) || (gitScope === "branch" && !gitBase.trim())} onClick={() => projectId && gitCommand({ type: "git.diff", project_id: projectId, command_id: commandId(), scope: gitScope, ...(gitBase ? { base: gitBase } : {}) })} type="button">{t("Review diff")}</button></div>
      {git && <><p>{t("Branch")}: {git.branch}</p><div className="git-file-list">{git.files.map((file) => <div key={file.path}><code>{file.index_status}{file.worktree_status} {file.path}</code><button className="button subtle" disabled={!available("git.stage", true)} onClick={() => projectId && gitCommand({ type: "git.stage", command_id: commandId(), project_id: projectId, paths: [file.path] })} type="button">{t("Stage")}</button><button className="button subtle" disabled={!available("git.unstage", true)} onClick={() => projectId && gitCommand({ type: "git.unstage", command_id: commandId(), project_id: projectId, paths: [file.path] })} type="button">{t("Unstage")}</button><button className="button subtle" disabled={!available("git.discard", true)} onClick={() => { if (projectId) void run({ type: "git.diff", command_id: commandId(), project_id: projectId, scope: "workspace", paths: [file.path] }).then((result) => { if (result && result.git && result.git.project_id === currentProject.current && result.git.head !== undefined && result.git.diff !== undefined) setDiscardReview({ path: file.path, head: result.git.head, diff: result.git.diff }); else if (result) setError(t("The Host did not return a reviewable diff and Git head. Discard is unavailable.")); }); }} type="button">{t("Discard")}</button></div>)}</div>{discardReview && <section className="git-discard-review" role="alertdialog" aria-label={t("Confirm Git discard")}><h4>{t("Discard uncommitted changes to this file?")}</h4><code>{discardReview.path}</code><small>{t("Git head")}: {discardReview.head}</small><pre className="resource-diff">{discardReview.diff || t("No differences")}</pre><p>{t("Only this reviewed file will be discarded. This cannot be undone.")}</p><button className="button danger" disabled={!available("git.discard", true)} onClick={() => { if (projectId) void run({ type: "git.discard", command_id: commandId(), project_id: projectId, paths: [discardReview.path], expected_head: discardReview.head }).then((result) => { if (result) setDiscardReview(null); }); }} type="button">{t("Confirm discard")}</button><button className="button subtle" onClick={() => setDiscardReview(null)} type="button">{t("Cancel")}</button></section>}{git.diff !== undefined && <pre className="resource-diff">{git.diff || t("No differences")}</pre>}
      <div className="resource-button-row"><input aria-label={t("Commit message")} value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder={t("Commit message")} /><button className="button primary" disabled={!available("git.commit", true) || !commitMessage.trim()} onClick={() => projectId && gitCommand({ type: "git.commit", project_id: projectId, command_id: commandId(), message: commitMessage })} type="button">{t("Commit staged changes")}</button></div>
      <div className="resource-button-row"><input aria-label={t("New branch name")} value={branch} onChange={(event) => setBranch(event.target.value)} placeholder={t("Branch name")} /><button className="button subtle" disabled={!available("git.branch.create", true) || !branch.trim()} onClick={() => projectId && gitCommand({ type: "git.branch.create", project_id: projectId, command_id: commandId(), name: branch })} type="button">{t("Create branch")}</button></div>
      <h4>{t("Worktrees")}</h4>{git.worktrees.map((worktree) => <div className="resource-button-row" key={worktree.path}><span><code>{worktree.branch}</code><small>{worktree.path}</small></span><button className="button subtle" disabled={!available("git.worktree.remove", true) || worktree.locked} onClick={() => { if (projectId && window.confirm(`${t("Remove this worktree after Host checks it is clean and idle?")} ${worktree.path}`)) gitCommand({ type: "git.worktree.remove", project_id: projectId, command_id: commandId(), worktree_path: worktree.path }); }} type="button">{t("Remove worktree")}</button></div>)}<div className="resource-button-row"><input aria-label={t("Worktree name")} value={worktreeName} onChange={(event) => setWorktreeName(event.target.value)} placeholder={t("Worktree name")} /><button className="button subtle" disabled={!available("git.worktree.create", true) || !worktreeName.trim() || !branch.trim()} onClick={() => projectId && gitCommand({ type: "git.worktree.create", project_id: projectId, command_id: commandId(), name: worktreeName, branch })} type="button">{t("Create worktree")}</button></div></>}
    </section>}
    {tab === "terminal" && <section><h3>{t("Terminal")}</h3><button className="button subtle" disabled={!available("terminal.create", true)} title={reason("terminal.create")} onClick={() => projectId && void run({ type: "terminal.create", command_id: commandId(), project_id: projectId, cols: 100, rows: 30 })} type="button">{t("New terminal")}</button><div className="resource-button-row">{resources?.terminals.map((terminal) => <button className="button subtle" aria-pressed={activeTerminal?.terminal_id === terminal.terminal_id} key={terminal.terminal_id} onClick={() => setSelectedTerminal(terminal.terminal_id)} type="button">{terminal.title} · {t(terminal.state)}</button>)}</div>{activeTerminal ? <><HostTerminal client={client} terminal={activeTerminal} writable={capabilityAvailable(capabilities, "terminal.input")} resizable={capabilityAvailable(capabilities, "terminal.resize")} onError={setError} /><button className="button subtle" disabled={!capabilityAvailable(capabilities, "terminal.close") || cancelling.includes(activeTerminal.terminal_id) || activeTerminal.state !== "running"} onClick={() => void closeResource(activeTerminal.terminal_id, { type: "terminal.close", command_id: commandId(), terminal_id: activeTerminal.terminal_id })} type="button">{t("Close terminal")}</button><small>{t(activeTerminal.state)} · {t("Exit code")}: {activeTerminal.exit_code ?? "—"}</small></> : <p>{t("No terminal selected")}</p>}</section>}
    {tab === "preview" && <section><h3>{t("Preview services")}</h3><label>{t("Executable")}<input value={previewCommand} onChange={(event) => setPreviewCommand(event.target.value)} placeholder="pnpm" /></label><label>{t("Arguments (JSON array)")}<input value={previewArgs} onChange={(event) => setPreviewArgs(event.target.value)} placeholder='["dev", "--port", "4315"]' /></label><label>{t("Port")}<input type="number" min={1024} max={65535} value={previewPort} onChange={(event) => setPreviewPort(Number(event.target.value))} /></label><div className="resource-button-row"><button className="button primary" disabled={!available("preview.start", true) || !previewCommand.trim()} onClick={() => { try { const args: unknown = JSON.parse(previewArgs); if (!Array.isArray(args) || !args.every((item) => typeof item === "string")) throw new Error("Arguments must be a JSON string array"); if (projectId) void run({ type: "preview.start", command_id: commandId(), project_id: projectId, command: previewCommand, args, port: previewPort }); } catch (caught) { setError(safeError(caught)); } }} type="button">{t("Start preview")}</button><button className="button subtle" disabled={!available("preview.register", true)} onClick={() => projectId && void run({ type: "preview.register", command_id: commandId(), project_id: projectId, port: previewPort })} type="button">{t("Connect existing service")}</button></div>{resources?.previews.map((preview) => <div className="resource-button-row" key={preview.preview_id}><button className="button subtle" onClick={() => setSelectedPreview(preview.preview_id)} type="button">{preview.url} · {t(preview.state)}</button><button className="button subtle" disabled={!capabilityAvailable(capabilities, "preview.stop") || cancelling.includes(preview.preview_id) || preview.state === "stopped"} onClick={() => void closeResource(preview.preview_id, { type: "preview.stop", command_id: commandId(), preview_id: preview.preview_id })} type="button">{t(preview.owned_process ? "Stop preview" : "Disconnect preview")}</button>{preview.message && <small>{preview.message}</small>}</div>)}{activePreview?.state === "ready" && /^http:\/\/(127\.0\.0\.1|localhost):\d+\//u.test(activePreview.url) && <>{capabilityAvailable(capabilities, "preview.open") ? <><button className="button primary" disabled={!client.openPreview} onClick={() => void client.openPreview?.(activePreview.preview_id).then(() => setNativePreviewOpen(true)).catch((error) => setError(safeError(error)))} type="button">{t("Open isolated preview")}</button>{nativePreviewOpen && <button className="button subtle" onClick={() => void client.closePreview?.().then(() => setNativePreviewOpen(false)).catch((error) => setError(safeError(error)))} type="button">{t("Close preview view")}</button>}</> : <><div className="resource-button-row"><select aria-label={t("Open preview in")} value={previewOpen} onChange={(event) => setPreviewOpen(event.target.value as "panel" | "browser")}><option value="panel">{t("Panel")}</option><option value="browser">{t("Browser")}</option></select><a className={previewOpen === "browser" ? "button primary" : "button subtle"} href={activePreview.url} rel="noreferrer" target="_blank">{t("Open in browser")}</a></div>{previewOpen === "panel" && <iframe title={t("Project preview")} src={activePreview.url} sandbox="allow-scripts allow-forms" />}</>}</>}</section>}
    {tab === "schedules" && <section><h3>{t("Schedules")}</h3><p>{t("The Host runs schedules locally. Missed or overlapping occurrences are recorded and skipped.")}</p><label>{t("Title")}<input value={scheduleTitle} onChange={(event) => setScheduleTitle(event.target.value)} /></label><label>{t("Project")}<select value={scheduleProjectId} onChange={(event) => setScheduleProjectId(event.target.value)}><option value="">{t("Choose a project")}</option>{snapshot.availableProjects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label><label>{t("Task")}<textarea rows={3} value={scheduleTask} onChange={(event) => setScheduleTask(event.target.value)} /></label><div className="resource-button-row"><label>{t("Mode")}<select value={scheduleMode} onChange={(event) => setScheduleMode(event.target.value as "plan" | "execute")}><option value="plan">{t("Plan")}</option><option value="execute">{t("Execute")}</option></select></label><label>{t("Timing")}<select value={timingKind} onChange={(event) => { const kind = event.target.value as typeof timingKind; setTimingKind(kind); setTimingValue(kind === "daily" ? "09:00" : kind === "interval" ? "3600" : ""); }}>{["daily", "interval", "once"].map((kind) => <option key={kind}>{t(kind)}</option>)}</select></label><label>{t(timingKind === "interval" ? "Interval seconds" : "Scheduled time")}<input type={timingKind === "daily" ? "time" : timingKind === "once" ? "datetime-local" : "number"} min={timingKind === "interval" ? 60 : undefined} value={timingValue} onChange={(event) => setTimingValue(event.target.value)} /></label><label>{t("Timezone")}<input value={timezone} onChange={(event) => setTimezone(event.target.value)} /></label></div><button className="button primary" disabled={!available(editing ? "schedule.update" : "schedule.create") || !scheduleProjectId || !scheduleTitle.trim() || !scheduleTask.trim() || !timingValue} onClick={() => { try { const input = scheduleInput(); void run(editing ? { type: "schedule.update", command_id: commandId(), schedule_id: editing.schedule_id, expected_revision: editing.revision, input } : { type: "schedule.create", command_id: commandId(), input }).then((result) => { if (result) { setEditing(null); setScheduleTitle(""); setScheduleTask(""); } }); } catch (caught) { setError(safeError(caught)); } }} type="button">{t(editing ? "Save schedule" : "Create schedule")}</button>{editing && <button className="button subtle" onClick={() => setEditing(null)} type="button">{t("Cancel editing")}</button>}
      {resources?.schedules.map((schedule) => <article className="schedule-row" key={schedule.schedule_id}><h4>{schedule.title}</h4><p>{schedule.task}</p><small>{schedule.timezone} · {t(schedule.last_status)} · {schedule.next_at ?? t("No next occurrence")}</small><div className="resource-button-row"><button className="button subtle" onClick={() => fillSchedule(schedule)} type="button">{t("Edit")}</button><button className="button subtle" disabled={!available("schedule.update")} onClick={() => void run({ type: "schedule.update", command_id: commandId(), schedule_id: schedule.schedule_id, expected_revision: schedule.revision, input: { title: schedule.title, task: schedule.task, project_id: schedule.project_id, mode: schedule.mode, timing: schedule.timing, timezone: schedule.timezone, enabled: !schedule.enabled } })} type="button">{t(schedule.enabled ? "Pause" : "Resume")}</button><button className="button subtle" disabled={!available("schedule.run") || schedule.running_run_id !== null} onClick={() => void run({ type: "schedule.run", command_id: commandId(), schedule_id: schedule.schedule_id })} type="button">{t("Run now")}</button><button className="button subtle" disabled={!available("schedule.history")} onClick={() => void run({ type: "schedule.history", command_id: commandId(), schedule_id: schedule.schedule_id })} type="button">{t("History")}</button><button className="button subtle" disabled={!available("schedule.delete")} onClick={() => { if (window.confirm(t("Delete this schedule? Existing Run evidence remains."))) void run({ type: "schedule.delete", command_id: commandId(), schedule_id: schedule.schedule_id }); }} type="button">{t("Delete")}</button></div></article>)}{receipt?.occurrences && <div className="schedule-history"><h4>{t("Occurrence history")}</h4>{receipt.occurrences.map((occurrence) => <p key={occurrence.occurrence_id}>{occurrence.scheduled_at} · {t(occurrence.status)} · {occurrence.run_id ?? "—"} {occurrence.message}</p>)}</div>}
    </section>}
    {tab === "archive" && <section><h3>{t("Archived sessions")}</h3>{resources?.archived_session_ids.length === 0 && <p>{t("No archived sessions")}</p>}{resources?.archived_session_ids.map((sessionId) => <div className="resource-button-row" key={sessionId}><code>{snapshot.sessions.find((session) => session.session_id === sessionId)?.title ?? sessionId}</code><button className="button subtle" disabled={!available("sessions.unarchive")} onClick={() => void run({ type: "sessions.unarchive", command_id: commandId(), session_id: sessionId }).then(() => client.searchSessions("")).catch((caught) => setError(safeError(caught)))} type="button">{t("Unarchive")}</button></div>)}</section>}
  </div></aside>;
}

function localDateTime(value: string): string {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function HostTerminal({ client, terminal, writable, resizable, onError }: { client: WorkbenchClient; terminal: TerminalSnapshot; writable: boolean; resizable: boolean; onError: (error: string) => void }) {
  const { t } = useI18n();
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<Terminal | null>(null);
  const rendered = useRef("");
  const current = useRef({ terminal, writable, resizable, onError }); current.current = { terminal, writable, resizable, onError };
  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    const open = async () => {
      const [{ Terminal: Emulator }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !container.current) return;
      const emulator = new Emulator({ fontSize: 13, convertEol: true, disableStdin: !current.current.writable || current.current.terminal.state !== "running", theme: { background: "#202020", foreground: "#eeeeee" } });
      const fit = new FitAddon(); emulator.loadAddon(fit); emulator.open(container.current); instance.current = emulator;
      const resize = () => {
        fit.fit();
        if (current.current.resizable && current.current.terminal.state === "running") void client.workbenchCommand({ type: "terminal.resize", command_id: commandId(), terminal_id: terminal.terminal_id, cols: Math.max(20, emulator.cols), rows: Math.max(5, emulator.rows) }).catch((error) => current.current.onError(safeError(error)));
      };
      let timer: number | undefined;
      const observer = new ResizeObserver(() => { window.clearTimeout(timer); timer = window.setTimeout(resize, 150); }); observer.observe(container.current);
      const writeInput = orderedTerminalInput(async (text) => { await client.workbenchCommand({ type: "terminal.input", command_id: commandId(), terminal_id: terminal.terminal_id, text }); }, () => !disposed && current.current.writable && current.current.terminal.state === "running", (error) => { if (!disposed) current.current.onError(safeError(error)); });
      const data = emulator.onData(writeInput);
      emulator.write(current.current.terminal.transcript); rendered.current = current.current.terminal.transcript;
      cleanup = () => { observer.disconnect(); window.clearTimeout(timer); data.dispose(); emulator.dispose(); instance.current = null; };
    };
    void open().catch((error) => { if (!disposed) current.current.onError(safeError(error)); });
    return () => { disposed = true; cleanup(); };
  }, [client, terminal.terminal_id]);
  useEffect(() => { const emulator = instance.current; if (!emulator) return; emulator.options.disableStdin = !writable || terminal.state !== "running"; if (!terminal.transcript.startsWith(rendered.current)) { emulator.reset(); emulator.write(terminal.transcript); } else emulator.write(terminal.transcript.slice(rendered.current.length)); rendered.current = terminal.transcript; }, [terminal.transcript, terminal.state, writable]);
  return <div className="host-terminal" ref={container} aria-label={t("Host terminal output")} />;
}
