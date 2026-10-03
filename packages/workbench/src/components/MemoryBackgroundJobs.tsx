import { createTranslator } from "@tracegraph/sdk/client";
import type { MemoryBackgroundJob, MemoryControlItem } from "@tracegraph/contracts";

/** A separate operational view: completion never implies candidate activation. */
export function MemoryBackgroundJobs({ loaded = true, error = null, online = true, jobs, items, zh, loadingHistory = false }: {
  loaded?: boolean; error?: string | null; online?: boolean;
  jobs: readonly MemoryBackgroundJob[] | undefined;
  items: readonly MemoryControlItem[];
  zh: boolean;
  loadingHistory?: boolean;
}) {
  const title = createTranslator(zh ? "zh-CN" : "en");
  const records = new Map(items.map(({ record }) => [record.memoryId, record]));
  const labels: Record<MemoryBackgroundJob["status"], string> = {
    waiting: title("Waiting for extractor"),
    running: title("Extracting and consolidating"),
    retry: title("Retry pending"),
    complete: title("Processed (review still required)"),
    exhausted: title("Retries exhausted"),
  };
  return <section className="memory-record-list" aria-label={title("Memory background jobs")}>
    <h3>{title("Episode extraction and cross-Run consolidation")}</h3>
    <p className="memory-control-note">{title("Shows up to 100 recent durable job states. Refresh for current results. Consolidation produces candidates or unchanged results; it never activates Memory.")}</p>
    {loadingHistory && <p role="status">{title("Restoring job history; the current list may be incomplete")}</p>}
    {!online ? <p>{title("Reconnect to refresh background jobs.")}</p> : !loaded || error ? <p>{title("Background jobs could not be loaded. Try again.")}</p> : jobs === undefined ? <p>{title("This Host does not provide job status.")}</p>
      : jobs.length === 0 ? !loadingHistory && <p>{title("No background jobs in the visible projects.")}</p>
        : jobs.map((job) => <article className="memory-record-card" key={job.runId}>
          <header><strong>{labels[job.status]}</strong><span>{title("Settled attempts")}: {job.attempts}/5</span></header>
          <div className="memory-record-meta">
            <code>{job.projectId} · {job.runId}</code>
            <span>{title("Updated")}: {job.updatedAt}</span>
            {job.nextAttemptAt !== undefined && <span>{title("Next attempt")}: {job.nextAttemptAt}</span>}
            {job.lastErrorCode !== undefined && <span role="status">{title("Error code")}: <code>{job.lastErrorCode}</code></span>}
            <span>{job.resultDetailsAvailable ? title("Candidate results") : title("Historical proposal count (legacy job has no diff details)")}: {job.candidateCount}</span>
          </div>
          {job.consolidationResults.map((result, index) => <details key={`${result.memoryId}:${index}`}>
            <summary>{result.action === "candidate" ? title("Candidate / diff") : title("Exact match, unchanged")} · {result.memoryId}</summary>
            <p>{title("Source Runs")}: {result.sourceRunIds.join(" · ")}</p>
            {result.comparedMemoryIds.filter((id) => id !== result.memoryId).map((id) => <blockquote key={id}>
              <strong>{title("Compared record")}: {id}</strong>
              <p>{records.get(id)?.claim ?? title("Content is unavailable or deleted")}</p>
            </blockquote>)}
            <strong>{result.action === "candidate" ? title("Review candidate") : title("Retained record")}</strong>
            <p>{records.get(result.memoryId)?.claim ?? title("Content is unavailable or deleted")}</p>
          </details>)}
        </article>)}
  </section>;
}
