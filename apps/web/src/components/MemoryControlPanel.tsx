import { useEffect, useState, type FormEvent } from "react";
import type {
  MemoryCandidateCreateRequest,
  MemoryControlItem,
  MemoryControlListResponse,
  MemoryKindV2,
} from "@tracegraph/contracts";
import { Icon } from "./Icon";
import { IconButton } from "./Primitives";
import { useI18n } from "../i18n";

const kinds: readonly Exclude<MemoryKindV2, "legacy_unclassified">[] = ["preference", "fact", "decision", "procedure", "lesson", "relationship", "declared_identity"];

export function MemoryControlPanel({
  onClose,
  projectId,
  onList,
  onCreate,
  onReview,
  onCorrect,
  onRevoke,
  onDelete,
}: {
  onClose: () => void;
  projectId?: string;
  onList: () => Promise<MemoryControlListResponse>;
  onCreate: (input: Omit<MemoryCandidateCreateRequest, "command_id">) => Promise<MemoryControlItem>;
  onReview: (memoryId: string, input: { expected_sequence: number; action: "review_activate" | "review_reject" }) => Promise<MemoryControlItem>;
  onCorrect: (memoryId: string, input: { expected_sequence: number; claim: string }) => Promise<MemoryControlItem>;
  onRevoke: (memoryId: string, input: { expected_sequence: number }) => Promise<MemoryControlItem>;
  onDelete: (memoryId: string) => Promise<{ deletedMemoryIds: readonly string[] }>;
}) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const [snapshot, setSnapshot] = useState<MemoryControlListResponse>({ items: [], conflicts: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claim, setClaim] = useState("");
  const [kind, setKind] = useState<Exclude<MemoryKindV2, "legacy_unclassified">>("fact");
  const [normalizedKey, setNormalizedKey] = useState("");
  const [allowModelUse, setAllowModelUse] = useState(false);
  const [correctionDrafts, setCorrectionDrafts] = useState<Record<string, string>>({});
  const [deleteConfirmation, setDeleteConfirmation] = useState<string | null>(null);

  const refresh = async () => {
    setError(null);
    try {
      setSnapshot(await onList());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

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
      source_description: zh ? "由用户在 Memory 控制面录入" : "Entered by the user in Memory controls",
    };
    if (await runMutation("create", async () => { await onCreate(input); })) {
      setClaim("");
      setNormalizedKey("");
      setAllowModelUse(false);
    }
  };

  const title = (value: string, english: string) => zh ? value : english;
  const statusLabel = (status: string) => ({
    candidate: title("待审核", "Candidate"),
    active: title("有效", "Active"),
    disputed: title("有争议", "Disputed"),
    superseded: title("已替代", "Superseded"),
    revoked: title("已撤销", "Revoked"),
    expired: title("已过期", "Expired"),
  }[status] ?? status);

  return (
    <>
      <button aria-label={title("关闭 Memory 控制面", "Close Memory controls")} className="memory-control-backdrop" onClick={onClose} type="button" />
      <section aria-label={title("Memory 控制面", "Memory controls")} aria-modal="true" className="memory-control-panel" role="dialog">
        <header>
          <div><span className="eyebrow">{title("长期记忆管理", "Long-term memory")}</span><h2>{title("Memory 控制面", "Memory controls")}</h2></div>
          <IconButton icon="close" label={title("关闭", "Close")} onClick={onClose} />
        </header>
        <div className="memory-control-body">
          {error && <div className="memory-control-error" role="alert">{error}</div>}
          <form className="memory-candidate-form" onSubmit={(event) => void create(event)}>
            <h3>{title("新增候选记忆", "Add a candidate")}</h3>
            <label>{title("内容", "Claim")}
              <textarea maxLength={8_000} onChange={(event) => setClaim(event.target.value)} required value={claim} />
            </label>
            <div className="memory-form-row">
              <label>{title("类型", "Kind")}
                <select onChange={(event) => setKind(event.target.value as Exclude<MemoryKindV2, "legacy_unclassified">)} value={kind}>
                  {kinds.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label>{title("冲突匹配 key（可选）", "Conflict key (optional)")}
                <input maxLength={500} onChange={(event) => setNormalizedKey(event.target.value)} value={normalizedKey} />
              </label>
            </div>
            <label className="memory-checkbox"><input checked={allowModelUse} onChange={(event) => setAllowModelUse(event.target.checked)} type="checkbox" />
              {title("审核通过后允许进入模型上下文", "Allow model context use after review")}
            </label>
            <button className="button primary" disabled={busy !== null || loading} type="submit"><Icon name="spark" size={14} />{title("保存为待审核候选", "Save as candidate")}</button>
            <p className="memory-control-note">{title("新记录始终先进入候选状态；模型使用还要经过显式审核。", "New records always start as candidates and require explicit review before activation.")}</p>
          </form>

          <section className="memory-record-list">
            <div className="memory-list-heading"><h3>{title("记忆记录", "Records")}</h3><button className="button subtle" disabled={loading || busy !== null} onClick={() => void refresh()} type="button"><Icon name="refresh" size={13} />{title("刷新", "Refresh")}</button></div>
            {snapshot.conflicts.length > 0 && <section aria-label={title("冲突组", "Conflict groups")} className="memory-conflicts" role="status">
              <h4>{title("发现显式冲突", "Explicit conflicts detected")}</h4>
              {snapshot.conflicts.map((conflict) => <div key={conflict.conflictId} className="memory-conflict">
                <code>{conflict.conflictId}</code>
                <span>{title("匹配 key 摘要", "Key digest")}: <code>{conflict.normalizedKeyDigest}</code></span>
                <ul>{conflict.participants.map((participant) => <li key={`${participant.memoryId}:${participant.version}`}>
                  <code>{participant.memoryId} · v{participant.version}</code> — {statusLabel(participant.status)}
                </li>)}</ul>
              </div>)}
              <p>{title("冲突只显示参与记录和摘要；内容需分别检查后更正或撤销。", "Only participant identities and a digest are shown; inspect, correct, or revoke each record explicitly.")}</p>
            </section>}
            {loading ? <p className="memory-empty">{title("正在读取…", "Loading…")}</p> : snapshot.items.length === 0 ? (
              <div className="memory-empty">{title("还没有 V2 记忆记录。", "No V2 Memory records yet.")}</div>
            ) : snapshot.items.map((item) => <MemoryRecordCard
              key={`${item.record.memoryId}:${item.record.version}`}
              item={item}
              busy={busy === item.record.memoryId}
              confirmDelete={deleteConfirmation === item.record.memoryId}
              statusLabel={statusLabel}
              title={title}
              correctionDraft={correctionDrafts[item.record.memoryId] ?? item.record.claim}
              onCorrectionDraft={(value) => setCorrectionDrafts((prior) => ({ ...prior, [item.record.memoryId]: value }))}
              onReview={(action) => void runMutation(item.record.memoryId, () => onReview(item.record.memoryId, { expected_sequence: item.lifecycleSequence, action }))}
              onCorrect={() => void runMutation(item.record.memoryId, () => onCorrect(item.record.memoryId, { expected_sequence: item.lifecycleSequence, claim: correctionDrafts[item.record.memoryId] ?? item.record.claim }))}
              onRevoke={() => void runMutation(item.record.memoryId, () => onRevoke(item.record.memoryId, { expected_sequence: item.lifecycleSequence }))}
              onRequestDelete={() => setDeleteConfirmation(item.record.memoryId)}
              onCancelDelete={() => setDeleteConfirmation(null)}
              onConfirmDelete={() => void runMutation(item.record.memoryId, () => onDelete(item.record.memoryId)).then((succeeded) => {
                if (succeeded) setDeleteConfirmation(null);
              })}
            />)}
          </section>
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
  title: (chinese: string, english: string) => string;
  correctionDraft: string;
  onCorrectionDraft: (value: string) => void;
  onReview: (action: "review_activate" | "review_reject") => void;
  onCorrect: () => void;
  onRevoke: () => void;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  const record = item.record;
  return (
    <article className="memory-record-card">
      <header><span className={`memory-status memory-status-${record.status}`}>{statusLabel(record.status)}</span><code>{record.kind} · v{record.version}</code></header>
      <p className="memory-record-claim">{record.claim}</p>
      <div className="memory-record-meta">
        <span>{title("来源", "Sources")}：{record.provenance.evidenceRefs.map((source) => "source_type" in source
          ? source.description ?? `${source.source_type} · ${source.source_id}`
          : `${source.eventType} · ${source.runId}#${source.sequence}`).join("; ") || title("无来源引用", "No source references")}</span>
        {record.provenance.createdFromEpisode !== undefined && <span>{title("Episode", "Episode")}：<code>{record.provenance.createdFromEpisode}</code></span>}
        {record.lineage.derivedFrom.length > 0 && <span>{title("建议对照", "Compare with")}：{record.lineage.derivedFrom.map((memoryId) => <code key={memoryId}>{memoryId}</code>)}</span>}
        <span>{title("范围", "Scope")}：{record.scope.projectId ?? record.scope.workspaceId ?? title("本机私有", "Local private")}</span>
        <span>{title("用途许可", "Model use")}：{record.governance.allowModelUse ? title("允许（仍需审核）", "Allowed after review") : title("关闭", "Disabled")}</span>
        <span>{title("反馈", "Feedback")}：{Object.entries(item.feedback.feedbackCounts).map(([name, count]) => `${name} ${count}`).join(" · ")}</span>
        {item.feedback.reviewRequired.length > 0 && <strong className="memory-pending-review">{title("有反馈待复核", "Feedback needs review")} · {item.feedback.reviewRequired.length}</strong>}
      </div>
      {item.memoryUseRequests.length > 0 && <section className="memory-use-list"><strong>{title("MemoryUse 请求状态", "MemoryUse requests")}</strong>{item.memoryUseRequests.map((request) => <div key={`${request.runId}:${request.memoryUseId}`}><span>{request.stage}</span><code>{request.runId} · {request.memoryUseId} · {request.contextManifestId}</code></div>)}</section>}
      <div className="memory-record-actions">
        {record.status === "candidate" && <>
          <button className="button primary" disabled={busy} onClick={() => onReview("review_activate")} type="button">{title("审核通过", "Approve")}</button>
          <button className="button subtle" disabled={busy} onClick={() => onReview("review_reject")} type="button">{title("拒绝", "Reject")}</button>
        </>}
        {record.status !== "revoked" && <button className="button subtle" disabled={busy} onClick={onRevoke} type="button">{title("撤销", "Revoke")}</button>}
        <button className="button subtle" disabled={busy} onClick={onRequestDelete} type="button">{title("删除", "Delete")}</button>
      </div>
      {(record.status === "candidate" || record.status === "active" || record.status === "disputed") && <div className="memory-correction-row">
        <textarea aria-label={title("更正后的记忆内容", "Corrected Memory claim")} maxLength={8_000} onChange={(event) => onCorrectionDraft(event.target.value)} value={correctionDraft} />
        <button className="button subtle" disabled={busy || correctionDraft.trim() === record.claim || correctionDraft.trim().length === 0} onClick={onCorrect} type="button">{title("创建更正候选", "Create correction candidate")}</button>
      </div>}
      {confirmDelete && <div className="memory-delete-confirm" role="alertdialog" aria-label={title("确认删除 Memory", "Confirm Memory deletion")}>
        <span>{title(
          "将删除本机 V2 记录及其更正链正文；审计事件、V1 记忆、备份和快照会保留。此操作不可撤销。",
          "Delete the local V2 record and correction lineage payload. Audit events, V1 memories, backups, and snapshots remain. This cannot be undone.",
        )}</span>
        <button className="button danger" disabled={busy} onClick={onConfirmDelete} type="button">{title("确认删除", "Confirm delete")}</button>
        <button className="button subtle" disabled={busy} onClick={onCancelDelete} type="button">{title("取消", "Cancel")}</button>
      </div>}
    </article>
  );
}
