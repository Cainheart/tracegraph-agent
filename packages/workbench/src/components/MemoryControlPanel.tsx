import { useEffect, useState, type FormEvent } from "react";
import type {
  MemoryCandidateCreateRequest,
  MemoryControlItem,
  MemoryControlListResponse,
  MemoryKindV2,
  ExperienceControlListResponse,
  ExperienceLifecycleAction,
  ExperienceLifecycleReviewResponse,
} from "@tracegraph/contracts";
import { Icon } from "./Icon";
import { IconButton } from "./Primitives";
import { useI18n } from "../i18n";
import { ExperienceControlSection } from "./ExperienceControlSection";
import { MemoryBackgroundJobs } from "./MemoryBackgroundJobs";

const kinds: readonly Exclude<MemoryKindV2, "legacy_unclassified">[] = ["preference", "fact", "decision", "procedure", "lesson", "relationship", "declared_identity"];

export function MemoryControlPanel({
  onClose,
  page = false,
  writable = true,
  experienceWritable = true,
  disabledReason, online = true, readable = true, onReconnect,
  projectId,
  onList,
  onCreate,
  onReview,
  onCorrect,
  onRevoke,
  onDelete,
  onListExperiences,
  onReviewExperience,
}: {
  onClose: () => void;
  page?: boolean;
  writable?: boolean;
  experienceWritable?: boolean;
  disabledReason?: string; online?: boolean; readable?: boolean | null; onReconnect?: () => Promise<void>;
  projectId?: string;
  onList: () => Promise<MemoryControlListResponse>;
  onCreate: (input: Omit<MemoryCandidateCreateRequest, "command_id">) => Promise<MemoryControlItem>;
  onReview: (memoryId: string, input: { expected_sequence: number; action: "review_activate" | "review_reject" }) => Promise<MemoryControlItem>;
  onCorrect: (memoryId: string, input: { expected_sequence: number; claim: string; allow_export?: boolean }) => Promise<MemoryControlItem>;
  onRevoke: (memoryId: string, input: { expected_sequence: number }) => Promise<MemoryControlItem>;
  onDelete: (memoryId: string) => Promise<{ deletedMemoryIds: readonly string[] }>;
  onListExperiences: () => Promise<ExperienceControlListResponse>;
  onReviewExperience: (caseId: string, input: { expected_sequence: number; action: ExperienceLifecycleAction }) => Promise<ExperienceLifecycleReviewResponse>;
}) {
  const { language, t: title } = useI18n();
  const zh = language === "zh-CN";
  const [snapshot, setSnapshot] = useState<MemoryControlListResponse>({ items: [], conflicts: [] });
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [tab, setTab] = useState<"memory" | "experience" | "jobs">("memory");
  const [scopeFilter, setScopeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [claim, setClaim] = useState("");
  const [kind, setKind] = useState<Exclude<MemoryKindV2, "legacy_unclassified">>("fact");
  const [normalizedKey, setNormalizedKey] = useState("");
  const [allowModelUse, setAllowModelUse] = useState(false);
  const [allowExport, setAllowExport] = useState(false);
  const [correctionDrafts, setCorrectionDrafts] = useState<Record<string, string>>({});
  const [deleteConfirmation, setDeleteConfirmation] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true); setError(null);
    if (!online || !readable) { setLoading(false); return; }
    try {
      setSnapshot(await onList()); setLoaded(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, [online, readable]);

  const runMutation = async (key: string, operation: () => Promise<unknown>): Promise<boolean> => {
    setBusy(key);
    setError(null);
    try {
      await operation();
      await refresh();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextClaim = claim.trim();
    if (!nextClaim) return;
    const input: Omit<MemoryCandidateCreateRequest, "command_id"> = {
      kind,
      claim: nextClaim,
      ...(normalizedKey.trim() ? { normalized_key: normalizedKey.trim() } : {}),
      ...(projectId === undefined ? {} : { project_id: projectId }),
      allow_model_use: allowModelUse,
      allow_export: allowExport,
      source_description: zh ? "由用户在 Memory 控制面录入" : "Entered by the user in Memory controls",
    };
    if (await runMutation("create", async () => { await onCreate(input); })) {
      setClaim("");
      setNormalizedKey("");
      setAllowModelUse(false);
      setAllowExport(false);
    }
  };
  const filteredItems = snapshot.items.filter((item) => (scopeFilter === "all" || (scopeFilter === "local" ? item.record.scope.projectId === undefined : item.record.scope.projectId === scopeFilter)) && (statusFilter === "all" || item.record.status === statusFilter) && JSON.stringify(item.record).toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  const statusLabel = (status: string) => ({
    candidate: title("Candidate"),
    active: title("Active memory"),
    disputed: title("Disputed"),
    superseded: title("Superseded"),
    revoked: title("Revoked"),
    expired: title("Expired"),
  }[status] ?? status);

  return (
    <>
      {!page && <button aria-label={title("Close Memory controls")} className="memory-control-backdrop" onClick={onClose} type="button" />}
      <section aria-label={title("Memory controls")} aria-modal={page ? undefined : true} className={`memory-control-panel ${page ? "memory-page" : ""}`} role={page ? "region" : "dialog"}>
        <header>
          <div><span className="eyebrow">{title("Long-term memory")}</span><h2>{title("Memory controls")}</h2></div>
          <IconButton icon="close" label={title("Close")} onClick={onClose} />
        </header>
        <nav className="memory-page-tabs" aria-label={title("Memory sections")}>{(["memory", "experience", "jobs"] as const).map((id) => <button aria-current={tab === id ? "page" : undefined} className={tab === id ? "active" : ""} onClick={() => setTab(id)} type="button" key={id}>{title(id === "memory" ? "Memory" : id === "experience" ? "Experience cases" : "Background consolidation")}</button>)}</nav>
        <div className="memory-control-body">
          {!online && <div className="memory-control-error" role="status"><p>{title(loaded ? "Showing the last loaded records. Reconnect to confirm current values." : "Reconnect to load your memories.")}</p>{onReconnect && <button className="button subtle" disabled={loading} onClick={() => { setLoading(true); void onReconnect().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught))).finally(() => setLoading(false)); }} type="button">{title("Repair connection")}</button>}</div>}
          {online && !readable && <p>{title(readable === null ? "Memory availability has not been confirmed. Try refreshing." : "Memory access is unavailable with the current permissions.")}</p>}
          {error && <div className="memory-control-error" role="alert">{error}{loaded && <p>{title("Showing the last loaded records. Refresh to confirm current values.")}</p>}<button className="button subtle" disabled={loading || !online} onClick={() => void refresh()} type="button">{title("Try again")}</button></div>}
          {tab === "memory" && <>{!writable && <p>{title(disabledReason ?? "Memory mutations are unavailable on this Host.")}</p>}<form className="memory-candidate-form" onSubmit={(event) => void create(event)}>
            <fieldset disabled={!online || !writable || busy !== null}><legend>{title("Add a candidate")}</legend>
            <label>{title("Claim")}
              <textarea maxLength={8_000} onChange={(event) => setClaim(event.target.value)} required value={claim} />
            </label>
            <div className="memory-form-row">
              <label>{title("Kind")}
                <select onChange={(event) => setKind(event.target.value as Exclude<MemoryKindV2, "legacy_unclassified">)} value={kind}>
                  {kinds.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label>{title("Conflict key (optional)")}
                <input maxLength={500} onChange={(event) => setNormalizedKey(event.target.value)} value={normalizedKey} />
              </label>
            </div>
            <label className="memory-checkbox"><input checked={allowModelUse} onChange={(event) => setAllowModelUse(event.target.checked)} type="checkbox" />
              {title("Allow model context use after review")}
            </label>
            <label className="memory-checkbox"><input checked={allowExport} onChange={(event) => setAllowExport(event.target.checked)} type="checkbox" />
              {title("Explicitly allow this version to be exported in a Legacy Capsule after review")}
            </label>
            <button className="button primary" disabled={busy !== null || loading} type="submit"><Icon name="spark" size={14} />{title("Save as candidate")}</button>
            <p className="memory-control-note">{title("New records always start as candidates and require explicit review before activation.")}</p>
          </fieldset></form>

          <div className="memory-filters"><label><span>{title("Scope")}</span><select value={scopeFilter} onChange={(event) => setScopeFilter(event.target.value)}><option value="all">{title("All scopes")}</option><option value="local">{title("Local private")}</option>{[...new Set(snapshot.items.map((item) => item.record.scope.projectId).filter((id): id is string => id !== undefined))].map((id) => <option key={id} value={id}>{id}</option>)}</select></label><label><span>{title("Search Memory")}</span><input aria-label={title("Search Memory")} type="search" value={filter} onChange={(event) => setFilter(event.target.value)} /></label><label><span>{title("Status")}</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">{title("All statuses")}</option>{["candidate", "active", "disputed", "superseded", "revoked", "expired"].map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}</select></label></div>
          <section className="memory-record-list">
            <div className="memory-list-heading"><h3>{title("Records")}</h3><button className="button subtle" disabled={loading || busy !== null} onClick={() => void refresh()} type="button"><Icon name="refresh" size={13} />{title("Refresh")}</button></div>
            {snapshot.conflicts.length > 0 && <section aria-label={title("Conflict groups")} className="memory-conflicts" role="status">
              <h4>{title("Explicit conflicts detected")}</h4>
              {snapshot.conflicts.map((conflict) => <div key={conflict.conflictId} className="memory-conflict">
                <code>{conflict.conflictId}</code>
                <span>{title("Key digest")}: <code>{conflict.normalizedKeyDigest}</code></span>
                <ul>{conflict.participants.map((participant) => <li key={`${participant.memoryId}:${participant.version}`}>
                  <code>{participant.memoryId} · v{participant.version}</code> — {statusLabel(participant.status)}
                </li>)}</ul>
              </div>)}
              <p>{title("Only participant identities and a digest are shown; inspect, correct, or revoke each record explicitly.")}</p>
            </section>}
            {loading ? <p className="memory-empty">{title("Loading…")}</p> : !loaded ? readable && <p className="memory-empty">{title(error ? "Your memories could not be loaded. Try again." : !online ? "Reconnect to load your memories." : "Loading…")}</p> : snapshot.items.length === 0 ? (
              <div className="memory-empty">{title("No V2 Memory records yet.")}</div>
            ) : filteredItems.map((item) => <MemoryRecordCard
              key={`${item.record.memoryId}:${item.record.version}`}
              item={item}
              busy={!online || !writable || busy === item.record.memoryId}
              confirmDelete={deleteConfirmation === item.record.memoryId}
              statusLabel={statusLabel}
              title={title}
              correctionDraft={correctionDrafts[item.record.memoryId] ?? item.record.claim}
              onCorrectionDraft={(value) => setCorrectionDrafts((prior) => ({ ...prior, [item.record.memoryId]: value }))}
              onReview={(action) => void runMutation(item.record.memoryId, () => onReview(item.record.memoryId, { expected_sequence: item.lifecycleSequence, action }))}
              onCorrect={(allowExport) => void runMutation(item.record.memoryId, () => onCorrect(item.record.memoryId, { expected_sequence: item.lifecycleSequence, claim: correctionDrafts[item.record.memoryId] ?? item.record.claim, allow_export: allowExport }))}
              onRevoke={() => void runMutation(item.record.memoryId, () => onRevoke(item.record.memoryId, { expected_sequence: item.lifecycleSequence }))}
              onRequestDelete={() => setDeleteConfirmation(item.record.memoryId)}
              onCancelDelete={() => setDeleteConfirmation(null)}
              onConfirmDelete={() => void runMutation(item.record.memoryId, () => onDelete(item.record.memoryId)).then((succeeded) => {
                if (succeeded) setDeleteConfirmation(null);
              })}
            />)}
          {!loading && snapshot.items.length > 0 && filteredItems.length === 0 && <p>{title("No Memory records match these filters")}</p>}</section>
          </>}
          {tab === "jobs" && <><button className="button subtle" disabled={loading || busy !== null} onClick={() => void refresh()} type="button">{title("Refresh")}</button><MemoryBackgroundJobs jobs={snapshot.backgroundJobs} loaded={loaded} error={error} online={online} items={snapshot.items} zh={zh} loadingHistory={snapshot.backgroundJobsLoading ?? false} /></>}
          {tab === "experience" && <ExperienceControlSection online={online} writable={online && experienceWritable} onList={onListExperiences} onReview={onReviewExperience} />}
        </div>
      </section>
    </>
  );
}

function MemoryRecordCard({
  item,
  busy,
  confirmDelete,
  statusLabel,
  title,
  correctionDraft,
  onCorrectionDraft,
  onReview,
  onCorrect,
  onRevoke,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  item: MemoryControlItem;
  busy: boolean;
  confirmDelete: boolean;
  statusLabel: (status: string) => string;
  title: (key: string) => string;
  correctionDraft: string;
  onCorrectionDraft: (value: string) => void;
  onReview: (action: "review_activate" | "review_reject") => void;
  onCorrect: (allowExport: boolean) => void;
  onRevoke: () => void;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  const record = item.record;
  const [allowCorrectionExport, setAllowCorrectionExport] = useState(false);
  return (
    <article className="memory-record-card">
      <header><span className={`memory-status memory-status-${record.status}`}>{statusLabel(record.status)}</span><code>{record.kind} · v{record.version}</code></header>
      <p className="memory-record-claim">{record.claim}</p>
      <div className="memory-record-meta">
        <span>{title("Sources")}：{record.provenance.evidenceRefs.map((source) => "source_type" in source
          ? source.description ?? `${source.source_type} · ${source.source_id}`
          : `${source.eventType} · ${source.runId}#${source.sequence}`).join("; ") || title("No source references")}</span>
        {record.provenance.createdFromEpisode !== undefined && <span>{title("Episode")}：<code>{record.provenance.createdFromEpisode}</code></span>}
        {record.lineage.derivedFrom.length > 0 && <span>{title("Compare with")}：{record.lineage.derivedFrom.map((memoryId) => <code key={memoryId}>{memoryId}</code>)}</span>}
        <span>{title("Scope")}：{record.scope.projectId ?? record.scope.workspaceId ?? title("Local private")}</span>
        <span>{title("Model use")}：{record.governance.allowModelUse ? title("Allowed after review") : title("Off")}</span>
        <span>{title("Export consent")}：{record.governance.allowExport ? title("Allowed for this version, subject to export gates") : title("Off")}</span>
        <span>{title("Feedback")}：{Object.entries(item.feedback.feedbackCounts).map(([name, count]) => `${name} ${count}`).join(" · ")}</span>
        {item.feedback.reviewRequired.length > 0 && <strong className="memory-pending-review">{title("Feedback needs review")} · {item.feedback.reviewRequired.length}</strong>}
      </div>
      {item.memoryUseRequests.length > 0 && <section className="memory-use-list"><strong>{title("MemoryUse requests")}</strong>{item.memoryUseRequests.map((request) => <div key={`${request.runId}:${request.memoryUseId}`}><span>{request.stage}</span><code>{request.runId} · {request.memoryUseId} · {request.contextManifestId}</code></div>)}</section>}
      <div className="memory-record-actions">
        {record.status === "candidate" && <>
          <button className="button primary" disabled={busy} onClick={() => onReview("review_activate")} type="button">{title("Approve")}</button>
          <button className="button subtle" disabled={busy} onClick={() => onReview("review_reject")} type="button">{title("Reject")}</button>
        </>}
        {record.status !== "revoked" && <button className="button subtle" disabled={busy} onClick={onRevoke} type="button">{title("Revoke")}</button>}
        <button className="button subtle" disabled={busy} onClick={onRequestDelete} type="button">{title("Delete")}</button>
      </div>
      {(record.status === "candidate" || record.status === "active" || record.status === "disputed") && <div className="memory-correction-row">
        <textarea aria-label={title("Corrected Memory claim")} maxLength={8_000} onChange={(event) => onCorrectionDraft(event.target.value)} value={correctionDraft} />
        <label className="memory-checkbox"><input checked={allowCorrectionExport} onChange={(event) => setAllowCorrectionExport(event.target.checked)} type="checkbox" />
          {title("Explicitly allow this corrected version to be exported after review; external copies cannot be recalled")}
        </label>
        <button className="button subtle" disabled={busy || correctionDraft.trim() === record.claim || correctionDraft.trim().length === 0} onClick={() => { onCorrect(allowCorrectionExport); setAllowCorrectionExport(false); }} type="button">{title("Create correction candidate")}</button>
      </div>}
      {confirmDelete && <div className="memory-delete-confirm" role="alertdialog" aria-label={title("Confirm Memory deletion")}>
        <span>{title("Delete the local V2 record and correction lineage payload. Audit events, V1 memories, backups, and snapshots remain. This cannot be undone.")}</span>
        <button className="button danger" disabled={busy} onClick={onConfirmDelete} type="button">{title("Confirm delete")}</button>
        <button className="button subtle" disabled={busy} onClick={onCancelDelete} type="button">{title("Cancel")}</button>
      </div>}
    </article>
  );
}
